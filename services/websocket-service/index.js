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

        // Subscribe to all alert events with a wildcard for geohash.
        subscribe('alert.created.*', (msg) => this.routeAlertToSubscribers(msg, 'alert_created'));
        subscribe('alert.updated.*', (msg) => this.routeAlertToSubscribers(msg, 'alert_updated'));
        subscribe('alert.deleted.*', (msg) => this.routeAlertToSubscribers(msg, 'alert_deleted'));

        // Keep location broadcast for now as it's global for officers
        subscribe('location.broadcast', () => this.broadcastLocations());

        server.listen(PORT, () => console.log(`WebSocket Service listening on port ${PORT}`));
        console.log("WebSocket Service Initialized and subscribed to message queue.");
    },

    handleConnection(ws) {
        console.log('[WS] Client connected.');
        clientMetadata.set(ws, { topics: new Set() }); // Initialize with empty subscriptions

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                const metadata = clientMetadata.get(ws);
                if (!metadata) return;

                switch(data.type) {
                    case 'auth':
                        console.log(`[WS] Auth message received for user: ${data.payload.mobile}`);
                        metadata.role = data.payload.role;
                        metadata.mobile = data.payload.mobile;
                        break;
                    case 'subscribe':
                        data.payload.topics.forEach(topic => metadata.topics.add(topic));
                        console.log(`[WS] Client subscribed to: ${data.payload.topics.join(', ')}`);
                        WebSocketService.sendInitialAlerts(ws, data.payload.topics);
                        break;
                    case 'unsubscribe':
                         data.payload.topics.forEach(topic => metadata.topics.delete(topic));
                        console.log(`[WS] Client unsubscribed from: ${data.payload.topics.join(', ')}`);
                        break;
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

    async sendInitialAlerts(ws, topics) {
        if (!topics || topics.length === 0) return;

        const geohashes = topics.map(topic => topic.replace('geo:', ''));
        try {
            const alerts = await dbService.request('/alerts/by-geohashes', {
                method: 'POST',
                body: JSON.stringify({ geohashes })
            });
            // FIX: Always send an initial_alerts message, even if the payload is empty.
            // This initializes the client's state correctly and prevents race conditions.
            // The previous logic failed to send a message if 'alerts' was null or empty.
            ws.send(JSON.stringify({ type: 'initial_alerts', payload: alerts || [] }));
            if (alerts && alerts.length > 0) {
                 console.log(`[WS] Sent ${alerts.length} initial alerts to newly subscribed client.`);
            } else {
                 console.log(`[WS] Sent 0 initial alerts to newly subscribed client.`);
            }
        } catch(e) {
            console.error('[WS] Failed to fetch initial alerts for subscriber:', e);
        }
    },

    routeAlertToSubscribers(msg, messageType) {
        try {
            const routingKey = msg.fields.routingKey;
            const geohash = routingKey.split('.').pop();
            const topic = `geo:${geohash}`;
            const alertPayload = JSON.parse(msg.content.toString());

            const message = JSON.stringify({ type: messageType, payload: alertPayload });
            let clientSentCount = 0;

            for (const client of wss.clients) {
                const metadata = clientMetadata.get(client);
                if (client.readyState === 1 && metadata?.topics.has(topic)) {
                    client.send(message);
                    clientSentCount++;
                }
            }
            if(clientSentCount > 0) {
                console.log(`[WS] Routed ${messageType} for alert #${alertPayload.id} to ${clientSentCount} clients subscribed to ${topic}.`);
            }
        } catch(e) {
            console.error(`[WS] Error routing message of type ${messageType}:`, e);
        }
    },

    // This is a global broadcast and not geo-targeted, which is fine for officer locations for now.
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
