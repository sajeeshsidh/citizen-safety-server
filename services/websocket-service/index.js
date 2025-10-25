const http = require('http');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const { connect: connectMessageQueue, subscribe } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3006;
const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL || 'http://database-service:3008';

const server = http.createServer();
const wss = new WebSocketServer({ server });

// In-memory mapping of a WebSocket connection to the authenticated user's details.
const clientMetadata = new Map();

const dbService = {
    async request(path, options = {}) {
        const response = await fetch(`${DATABASE_SERVICE_URL}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        if (response.status === 204) return null;
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || `Database service error: ${response.status}`);
        return data;
    },
};

const WebSocketService = {
    async initialize() {
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
        try {
            const allAlerts = await dbService.request('/alerts');
            console.log(`[WS] Broadcasting alerts to ${wss.clients.size} clients.`);
            const message = JSON.stringify({ type: 'alerts', payload: allAlerts });
            for (const client of wss.clients) {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(message);
                }
            }
        } catch (error) {
            console.error('[WS] Failed to fetch and broadcast alerts:', error);
        }
    },

    async broadcastLocations() {
        try {
            const officers = await dbService.request('/police');
            const locations = officers.map(o => ({
                badgeNumber: o.badgeNumber,
                location: { lat: o.locationLat, lng: o.locationLng },
            }));

            console.log(`[WS] Broadcasting locations to police clients.`);
            const message = JSON.stringify({ type: 'locations', payload: locations });
            for (const client of wss.clients) {
                const metadata = clientMetadata.get(client);
                if (client.readyState === 1 && metadata && metadata.role === 'police') {
                    client.send(message);
                }
            }
        } catch (error) {
            console.error('[WS] Failed to fetch and broadcast locations:', error);
        }
    },
};

WebSocketService.initialize();
