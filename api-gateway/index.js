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

// --- Reverse Proxy Middleware Instances ---
const authProxy = createProxyMiddleware({ 
    target: AUTH_SERVICE_URL, 
    changeOrigin: true,
    onProxyReq: logProvider('AuthService', AUTH_SERVICE_URL)
});
const alertsProxy = createProxyMiddleware({ 
    target: ALERTS_SERVICE_URL, 
    changeOrigin: true,
    onProxyReq: logProvider('AlertsService', ALERTS_SERVICE_URL)
});
const locationProxy = createProxyMiddleware({ 
    target: LOCATION_SERVICE_URL, 
    changeOrigin: true,
    onProxyReq: logProvider('LocationService', LOCATION_SERVICE_URL)
});
const directionsProxy = createProxyMiddleware({ 
    target: DIRECTIONS_SERVICE_URL, 
    changeOrigin: true,
    onProxyReq: logProvider('DirectionsService', DIRECTIONS_SERVICE_URL)
});
const aiProxy = createProxyMiddleware({ 
    target: AI_ANALYSIS_SERVICE_URL, 
    changeOrigin: true,
    onProxyReq: logProvider('AIService', AI_ANALYSIS_SERVICE_URL)
});


// --- Routing Order ---
// The order is critical: more specific paths MUST be listed before general paths.

// 1. Location Service (Handles the most specific '/api/police/*' routes)
app.use('/api/police/locations', locationProxy);
app.use('/api/police/location', locationProxy);

// 2. Auth Service (Handles all other auth-related routes)
app.use('/api/citizen', authProxy);
app.use('/api/police', authProxy); // This is now safe because specific police routes were handled above
app.use('/api/firefighter', authProxy);

// 3. Other Services
app.use('/api/alerts', alertsProxy);
app.use('/api/route', directionsProxy);
app.use('/api/internal/analyze', aiProxy);

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