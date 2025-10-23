const express = require('express');
const cors = require('cors');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- Configuration ---
// These URLs point to the independent microservices.
// In a real deployment (like on Render), these would be internal service addresses.

const PORT = process.env.PORT || 3001;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3002';
const ALERTS_SERVICE_URL = process.env.ALERTS_SERVICE_URL || 'http://localhost:3003';
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3004';
const DIRECTIONS_SERVICE_URL = process.env.DIRECTIONS_SERVICE_URL || 'http://localhost:3005';
const WEBSOCKET_SERVICE_URL = process.env.WEBSOCKET_SERVICE_URL || 'ws://localhost:3006';
const AI_ANALYSIS_SERVICE_URL = process.env.AI_ANALYSIS_SERVICE_URL || 'http://localhost:3007';


// --- Express App & Server Setup ---
const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(cors());

// --- Health Check Endpoint ---
app.get('/', (req, res) => {
    res.send('API Gateway is running.');
});

// --- Diagnostic Logging ---
const logProvider = (providerName, target) => {
    return (proxyReq, req, res) => {
        console.log(`[API Gateway] Proxying request ${req.method} ${req.originalUrl} to ${providerName} at ${target}`);
    };
};

console.log("--- API Gateway Configuration ---");
console.log(`Auth Service -> ${AUTH_SERVICE_URL}`);
console.log(`Alerts Service -> ${ALERTS_SERVICE_URL}`);
console.log(`Location Service -> ${LOCATION_SERVICE_URL}`);
console.log(`Directions Service -> ${DIRECTIONS_SERVICE_URL}`);
console.log(`WebSocket Service -> ${WEBSOCKET_SERVICE_URL}`);
console.log(`AI Analysis Service -> ${AI_ANALYSIS_SERVICE_URL}`);
console.log("---------------------------------");

// Add a simple logging middleware to see all incoming API requests
app.use('/api', (req, res, next) => {
    console.log(`[API Gateway] Received request: ${req.method} ${req.originalUrl}`);
    next();
});

// --- Reverse Proxy Routing ---
// The order of these routes is crucial. More specific routes must come before general ones.

// 1. Location Service Routes (most specific)
app.use('/api/police/locations', createProxyMiddleware({
    target: LOCATION_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('LocationService', LOCATION_SERVICE_URL)
}));
app.use('/api/police/location', createProxyMiddleware({
    target: LOCATION_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('LocationService', LOCATION_SERVICE_URL)
}));

// 2. Auth Service Routes
app.use('/api/citizen', createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('AuthService', AUTH_SERVICE_URL)
}));
app.use('/api/police', createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('AuthService', AUTH_SERVICE_URL)
}));
app.use('/api/firefighter', createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('AuthService', AUTH_SERVICE_URL)
}));

// 3. Alerts Service Routes
app.use('/api/alerts', createProxyMiddleware({
    target: ALERTS_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('AlertsService', ALERTS_SERVICE_URL)
}));

// 4. Directions Service Routes
app.use('/api/route', createProxyMiddleware({
    target: DIRECTIONS_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('DirectionsService', DIRECTIONS_SERVICE_URL)
}));

// 5. AI Service (Internal)
app.use('/api/internal/analyze', createProxyMiddleware({
    target: AI_ANALYSIS_SERVICE_URL,
    changeOrigin: true,
    onProxyReq: logProvider('AIService', AI_ANALYSIS_SERVICE_URL)
}));

// --- WebSocket Proxying ---
server.on('upgrade', (req, socket, head) => {
    console.log('[API Gateway] Attempting to upgrade WebSocket connection...');
    const wsProxy = createProxyMiddleware({
        target: WEBSOCKET_SERVICE_URL,
        ws: true,
        changeOrigin: true,
        logLevel: 'debug' // More verbose logging for websockets
    });
    wsProxy.upgrade(req, socket, head);
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`API Gateway is listening on port ${PORT}`);
});