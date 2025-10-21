
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { getDb, setupDatabase } = require('../../shared/database');
const { connect: connectMessageQueue, publish } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3003;
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3004';

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

        app.get('/api/alerts', this.getAlerts);
        app.post('/api/alerts', this.createAlert);
        app.post('/api/alerts/:id/accept', this.acceptAlert);
        app.post('/api/alerts/:id/resolve', this.resolveAlert);
        app.post('/api/alerts/:id/cancel', this.cancelAlert);
        app.delete('/api/alerts/:id', this.deleteAlert);

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
        try {
            // 1. Find nearby officers via an HTTP call to the Location Service.
            const response = await fetch(`${LOCATION_SERVICE_URL}/api/internal/find-nearby`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ location }),
            });
            const { officerIds: targetedOfficers } = response.ok ? await response.json() : { officerIds: [] };

            // 2. Save the new alert to the database.
            const db = getDb();
            const timestamp = Date.now();
            const newAlertData = {
                citizenId, message, audioBase64,
                locationLat: location.lat, locationLng: location.lng,
                timestamp, status: 'new',
                targetedOfficers: JSON.stringify(targetedOfficers),
                timeoutTimestamp: timestamp + (30 * 1000), // 30 second timeout
            };
            const result = await db.run(
                'INSERT INTO alerts (citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, targetedOfficers, timeoutTimestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    newAlertData.citizenId, newAlertData.message, newAlertData.audioBase64,
                    newAlertData.locationLat, newAlertData.locationLng, newAlertData.timestamp,
                    newAlertData.status, newAlertData.targetedOfficers, newAlertData.timeoutTimestamp
                ]
            );
            const createdAlert = { id: result.lastID, ...newAlertData };

            // 3. Publish events to the message queue.
            publish('alert.created', JSON.stringify({ targetedOfficers, alert: createdAlert }));
            publish('alert.broadcast', JSON.stringify({ message: 'New alert created' }));
            res.status(201).json(AlertsService._formatAlert(createdAlert));
        } catch (error) {
            console.error('Error creating alert:', error);
            res.status(500).json({ message: 'Failed to create alert.' });
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
                console.error("Error in parsing JSON response for targetOfficers", e);
                newAlert.targetedOfficers = [];
            }
        }
        if (newAlert.locationLat && newAlert.locationLng) {
            newAlert.location = { lat: newAlert.locationLat, lng: newAlert.locationLng };
        }
        return newAlert;
    },

    _formatAlerts(alerts) {
        return alerts.map(this._formatAlert);
    }
};

AlertsService.initialize();
