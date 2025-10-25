const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { getDb, setupDatabase } = require('../../shared/database');
const { connect: connectMessageQueue, publish } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3003;
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://location-service:3004';
const AI_ANALYSIS_SERVICE_URL = process.env.AI_ANALYSIS_SERVICE_URL || 'http://ai-analysis-service:3007';
const INTER_SERVICE_TIMEOUT_MS = 110000; // 110 seconds timeout for calls to other services

const app = express();
app.use(cors());
// Increased limit to handle base64 audio strings
app.use(express.json({ limit: '10mb' }));

/**
 * The Alerts Service orchestrates the entire lifecycle of an alert, from creation to resolution.
 * It is a standalone server that communicates with other services over the network.
 */
const AlertsService = {
    async initialize() {
        await setupDatabase();
        await connectMessageQueue();

        app.get('/', (req, res) => res.send('Alerts Service is running.'));
        app.post('/alerts', this.createAlert);
        app.get('/alerts', this.getAlerts);
        app.post('/alerts/:id/accept', this.acceptAlert);
        app.post('/alerts/:id/resolve', this.resolveAlert);
        app.post('/alerts/:id/cancel', this.cancelAlert);
        app.delete('/alerts/:id', this.deleteAlert);

        app.listen(PORT, () => console.log(`Alerts Service listening on port ${PORT}`));
    },

    async getAlerts(req, res) {
        try {
            const db = getDb();
            const alertsRaw = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
            const alerts = AlertsService._formatAlerts(alertsRaw);
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

        const db = getDb();
        const timestamp = Date.now();
        let preliminaryAlert;

        try {
            // Step 1: Immediately create a preliminary record in the database.
            const newAlertData = {
                citizenId, message, audioBase64,
                locationLat: location.lat, locationLng: location.lng,
                timestamp, status: 'new',
                timeoutTimestamp: timestamp + (30 * 1000), // 30 second timeout
            };
            const result = await db.run(
                'INSERT INTO alerts (citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, timeoutTimestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [newAlertData.citizenId, newAlertData.message, newAlertData.audioBase64, newAlertData.locationLat, newAlertData.locationLng, newAlertData.timestamp, newAlertData.status, newAlertData.timeoutTimestamp]
            );
            preliminaryAlert = { id: result.lastID, ...newAlertData };

            // Step 2: Send the immediate response to the client.
            res.status(201).json(AlertsService._formatAlert(preliminaryAlert));

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
                const aiResponse = await fetch(`${AI_ANALYSIS_SERVICE_URL}/analyze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message, audioBase64 }),
                    timeout: INTER_SERVICE_TIMEOUT_MS,
                });
                if (aiResponse.ok) {
                    const aiResult = await aiResponse.json();
                    category = aiResult.category;
                    console.log(`[Alerts] AI analysis for alert #${alertId} result: ${category}`);
                } else {
                    console.warn(`[Alerts] AI analysis for alert #${alertId} failed with status ${aiResponse.status}, using default category.`);
                }
            } catch (aiError) {
                console.error(`[Alerts] Error calling AI service for alert #${alertId}, using default category:`, aiError);
            }

            // 3b. Find Nearby Responders
            let targetedOfficers = [];
            try {
                const locationResponse = await fetch(`${LOCATION_SERVICE_URL}/find-nearby`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ location, category }),
                    timeout: INTER_SERVICE_TIMEOUT_MS,
                });
                if (locationResponse.ok) {
                    const locationResult = await locationResponse.json();
                    targetedOfficers = locationResult.responderIds || [];
                } else {
                    console.warn(`[Alerts] Location service call for alert #${alertId} failed with status ${locationResponse.status}.`);
                }
            } catch (locationError) {
                console.error(`[Alerts] Error calling Location service for alert #${alertId}:`, locationError);
            }
            
            // 3c. Update the alert record with the new info
            await db.run(
                'UPDATE alerts SET category = ?, targetedOfficers = ? WHERE id = ?',
                [category, JSON.stringify(targetedOfficers), alertId]
            );
            
            // 3d. Publish events to the message queue.
            const fullAlert = await db.get('SELECT * from alerts WHERE id = ?', alertId);
            if(fullAlert){
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
            const db = getDb();
            await db.run('DELETE FROM alerts WHERE id = ?', req.params.id);
            publish('alert.broadcast', JSON.stringify({ message: 'Alert deleted' }));
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting alert:', error);
            res.status(500).json({ message: 'Failed to delete alert.' });
        }
    },

    async _updateAlertStatus(res, alertId, newStatus, extraData = {}) {
        try {
            const db = getDb();
            const fieldsToUpdate = { status: newStatus, ...extraData };
            const setClauses = Object.keys(fieldsToUpdate).map(key => `${key} = ?`).join(', ');
            const values = Object.values(fieldsToUpdate);

            await db.run(`UPDATE alerts SET ${setClauses} WHERE id = ?`, [...values, alertId]);
            const updatedAlertRaw = await db.get('SELECT * FROM alerts WHERE id = ?', alertId);

            if (!updatedAlertRaw) {
                return res.status(404).json({ message: 'Alert not found.' });
            }

            const updatedAlert = AlertsService._formatAlert(updatedAlertRaw);
            publish('alert.broadcast', JSON.stringify({ message: `Alert ${alertId} status updated to ${newStatus}` }));
            res.json(updatedAlert);
        } catch (error) {
            console.error(`Error updating alert to ${newStatus}:`, error);
            res.status(500).json({ message: 'Failed to update alert status.' });
        }
    },

    _formatAlert(alert) {
        if (!alert) return null;
        const newAlert = { ...alert };
        if (newAlert.targetedOfficers) {
            try {
                newAlert.targetedOfficers = JSON.parse(newAlert.targetedOfficers);
            } catch (e) {
                console.error('JSON parsing failed for targetOfficers', e);
                newAlert.targetedOfficers = [];
            }
        }
        if (newAlert.locationLat && newAlert.locationLng) {
            newAlert.location = { lat: newAlert.locationLat, lng: newAlert.locationLng };
        }
        delete newAlert.locationLat;
        delete newAlert.locationLng;
        return newAlert;
    },

    _formatAlerts(alerts) {
        return alerts.map(alert => this._formatAlert(alert));
    }
};

AlertsService.initialize();