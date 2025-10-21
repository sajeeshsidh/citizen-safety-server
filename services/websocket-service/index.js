
const http = require('http');
const { WebSocketServer } = require('ws');
const { getDb, setupDatabase } = require('../../shared/database');
const { connect: connectMessageQueue, subscribe } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3006;

const server = http.createServer();
const wss = new WebSocketServer({ server });

// In-memory mapping of a WebSocket connection to the authenticated user's details.
const clientMetadata = new Map();

const WebSocketService = {
    async initialize() {
        await setupDatabase();
        await connectMessageQueue();

        wss.on('connection', this.handleConnection);

        // Subscribe to broadcast events from other services.
        subscribe('alert.broadcast', () => this.broadcastAlerts());
        subscribe('location.broadcast', () => this.broadcastLocations());

        server.listen(PORT, () => console.log(`WebSocket Service listening on port ${PORT}`));
        console.log("WebSocket Service Initialized and subscribed to message queue.");
    },

    handleConnection(ws) {
        console.log('[WS] Client connected.');

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'auth') {
                    console.log(`[WS] Auth message received for user: ${data.payload.mobile}`);
                    // Associate the user's details with their connection.
                    clientMetadata.set(ws, { role: data.payload.role, mobile: data.payload.mobile });
                    // Send the initial data set upon successful authentication.
                    WebSocketService.broadcastAlerts();
                }
            } catch (error) {
                console.error('[WS] Error parsing message:', error);
            }
        });

        ws.on('close', () => {
            console.log('[WS] Client disconnected.');
            clientMetadata.delete(ws);
        });
    },

    async broadcastAlerts() {
        const db = getDb();
        const allAlertsRaw = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
        const allAlerts = allAlertsRaw.map(this._formatAlert);

        console.log(`[WS] Broadcasting alerts to ${wss.clients.size} clients.`);

        for (const client of wss.clients) {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(JSON.stringify({ type: 'alerts', payload: allAlerts }));
            }
        }
    },

    async broadcastLocations() {
        const db = getDb();
        const officers = await db.all('SELECT badgeNumber, locationLat, locationLng FROM police WHERE locationLat IS NOT NULL');
        const locations = officers.map(o => ({
            badgeNumber: o.badgeNumber,
            location: { lat: o.locationLat, lng: o.locationLng },
        }));

        console.log(`[WS] Broadcasting locations to police clients.`);

        for (const client of wss.clients) {
            const metadata = clientMetadata.get(client);
            if (client.readyState === 1 && metadata && metadata.role === 'police') {
                client.send(JSON.stringify({ type: 'locations', payload: locations }));
            }
        }
    },

    // Helper to parse targetedOfficers from JSON string
    _formatAlert(alert) {
        if (alert.targetedOfficers) {
            try {
                alert.targetedOfficers = JSON.parse(alert.targetedOfficers);
            } catch (e) {
                console.error("Error in parsing JSON response for targetOfficers", e);
                alert.targetedOfficers = [];
            }
        }
        if (alert.locationLat && alert.locationLng) {
            alert.location = { lat: alert.locationLat, lng: alert.locationLng };
        }
        return alert;
    }
};

WebSocketService.initialize();
