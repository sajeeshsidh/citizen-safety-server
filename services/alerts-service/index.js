const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { connect: connectMessageQueue, publish } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3003;
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://location-service:3004';
const AI_ANALYSIS_SERVICE_URL = process.env.AI_ANALYSIS_SERVICE_URL || 'http://ai-analysis-service:3007';
const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL || 'http://database-service:3008';
const INTER_SERVICE_TIMEOUT_MS = 110000; // 110 seconds timeout for calls to other services

const app = express();
app.use(cors());
// Increased limit to handle base64 audio strings
app.use(express.json({ limit: '10mb' }));

/**
 * A helper object for making standardized requests to the internal Database Service.
 */
const dbService = {
    async request(path, options = {}) {
        const response = await fetch(`${DATABASE_SERVICE_URL}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        if (response.status === 204) return null; // Handle No Content responses
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || `Database service error: ${response.status}`);
        }
        return data;
    },
};

const AlertsService = {
    timeoutProcessorInterval: null,

    async initialize() {
        await connectMessageQueue();

        app.get('/', (req, res) => res.send('Alerts Service is running.'));
        app.post('/alerts', this.createAlert);
        app.get('/alerts', this.getAlerts);
        app.post('/alerts/:id/accept', this.acceptAlert);
        app.post('/alerts/:id/resolve', this.resolveAlert);
        app.post('/alerts/:id/cancel', this.cancelAlert);
        app.delete('/alerts/:id', this.deleteAlert);

        app.listen(PORT, () => console.log(`Alerts Service listening on port ${PORT}`));

        // Start the background process to handle alert timeouts.
        this.timeoutProcessorInterval = setInterval(this.processTimeouts.bind(this), 5000); // Check every 5 seconds
        console.log('[Alerts] Started background timeout processor.');
    },

    async processTimeouts() {
        try {
            // Offload the timeout check logic to the database service
            const { updatedCount, ids } = await dbService.request('/alerts/find-and-update-timeouts', { method: 'POST' });

            if (updatedCount > 0) {
                console.log(`[Alerts] Found ${updatedCount} timed-out alerts: ${ids.join(', ')}.`);
                // Notify all clients of the change so their UIs update.
                publish('alert.broadcast', JSON.stringify({ message: `${updatedCount} alerts timed out.` }));
            }
        } catch (error) {
            console.error('[Alerts] Error in timeout processor:', error);
        }
    },

    async getAlerts(req, res) {
        try {
            const alerts = await dbService.request('/alerts');
            res.json(alerts);
        } catch (error) {
            console.error('Error fetching alerts:', error);
            res.status(500).json({ message: 'Failed to retrieve alerts.' });
        }
    },

    async createAlert(req, res) {
        const { citizenId, message, audioBase64, location } = req.body;
        if (!citizenId || !location) {
            return res.status(400).json({ message: 'Citizen ID and location are required.' });
        }

        const timestamp = Date.now();
        let preliminaryAlert;

        try {
            // Step 1: Immediately create a preliminary record via the database service.
            const newAlertData = {
                citizenId, message, audioBase64,
                locationLat: location.lat, locationLng: location.lng,
                timestamp, status: 'new',
                timeoutTimestamp: timestamp + (60 * 1000), // 60 second timeout
            };
            preliminaryAlert = await dbService.request('/alerts', { method: 'POST', body: JSON.stringify(newAlertData) });

            // Step 2: Send the immediate response to the client.
            res.status(201).json(preliminaryAlert);

        } catch (dbError) {
            console.error('Error creating preliminary alert:', dbError);
            return res.status(500).json({ message: 'Failed to create alert.' });
        }

        // Step 3: Perform heavy lifting in the background after responding.
        try {
            const alertId = preliminaryAlert.id;

            // 3a. AI Analysis
            let category = 'Law & Order'; // Default category
            try {
                const aiResponse = await fetch(`${AI_ANALYSIS_SERVICE_URL}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, audioBase64 }), timeout: INTER_SERVICE_TIMEOUT_MS });
                if (aiResponse.ok) {
                    const aiResult = await aiResponse.json();
                    category = aiResult.category;
                    console.log(`[Alerts] AI analysis for alert #${alertId} result: ${category}`);
                } else {
                    console.warn(`[Alerts] AI analysis for alert #${alertId} failed with status ${aiResponse.status}, using default category.`);
                }
            } catch (aiError) {
                console.error(`[Alerts] Error calling AI service for alert #${alertId}:`, aiError);
            }

            // 3b. Find Nearby Responders
            let targetedOfficers = [];
            try {
                const locationResponse = await fetch(`${LOCATION_SERVICE_URL}/find-nearby`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, category }), timeout: INTER_SERVICE_TIMEOUT_MS });
                if (locationResponse.ok) targetedOfficers = (await locationResponse.json()).responderIds || [];
                else console.warn(`[Alerts] Location service call for alert #${alertId} failed with status ${locationResponse.status}.`);
            } catch (locationError) {
                console.error(`[Alerts] Error calling Location service for alert #${alertId}:`, locationError);
            }

            // 3c. Update the alert record with the new info via the database service.
            const fullAlert = await dbService.request(`/alerts/${alertId}`, { method: 'PUT', body: JSON.stringify({ category, targetedOfficers: JSON.stringify(targetedOfficers) }) });

            // 3d. Publish events to the message queue.
            if (fullAlert) {
                publish('alert.created', JSON.stringify({ targetedOfficers, alert: fullAlert }));
                publish('alert.broadcast', JSON.stringify({ message: 'New alert created and processed' }));
                console.log(`[Alerts] Background processing for alert #${alertId} complete.`);
            }

        } catch (backgroundError) {
            console.error(`[Alerts] Critical error during background processing for alert #${preliminaryAlert.id}:`, backgroundError);
        }
    },

    async acceptAlert(req, res) {
        const { id } = req.params;
        const { officerId } = req.body;
        if (!officerId) {
            return res.status(400).json({ message: 'Officer ID is required.' });
        }
        await AlertsService._updateAlertStatus(res, id, 'accepted', { acceptedBy: officerId });
    },

    async resolveAlert(req, res) {
        await AlertsService._updateAlertStatus(res, req.params.id, 'resolved');
    },

    async cancelAlert(req, res) {
        await AlertsService._updateAlertStatus(res, req.params.id, 'canceled');
    },

    async deleteAlert(req, res) {
        try {
            await dbService.request(`/alerts/${req.params.id}`, { method: 'DELETE' });
            publish('alert.broadcast', JSON.stringify({ message: 'Alert deleted' }));
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting alert:', error);
            res.status(500).json({ message: 'Failed to delete alert.' });
        }
    },

    async _updateAlertStatus(res, alertId, newStatus, extraData = {}) {
        try {
            const fieldsToUpdate = { status: newStatus, ...extraData };
            const updatedAlert = await dbService.request(`/alerts/${alertId}`, { method: 'PUT', body: JSON.stringify(fieldsToUpdate) });

            if (!updatedAlert) {
                return res.status(404).json({ message: 'Alert not found.' });
            }

            publish('alert.broadcast', JSON.stringify({ message: `Alert ${alertId} status updated to ${newStatus}` }));
            res.json(updatedAlert);
        } catch (error) {
            console.error(`Error updating alert to ${newStatus}:`, error);
            res.status(500).json({ message: 'Failed to update alert status.' });
        }
    },
};

AlertsService.initialize();