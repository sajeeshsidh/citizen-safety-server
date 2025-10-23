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

console.log("--- API Gateway Configuration ---");
console.log(`Auth Service -> ${AUTH_SERVICE_URL}`);
console.log(`Alerts Service -> ${ALERTS_SERVICE_URL}`);
console.log(`Location Service -> ${LOCATION_SERVICE_URL}`);
console.log(`Directions Service -> ${DIRECTIONS_SERVICE_URL}`);
console.log(`WebSocket Service -> ${WEBSOCKET_SERVICE_URL}`);
console.log(`AI Analysis Service -> ${AI_ANALYSIS_SERVICE_URL}`);
console.log("---------------------------------");


// --- Reverse Proxy Routing ---
// The order of these routes is crucial. More specific routes must come before general ones.

// 1. Location Service Routes (very specific)
app.use('/api/police/locations', createProxyMiddleware({ target: LOCATION_SERVICE_URL, changeOrigin: true }));
app.use('/api/police/location', createProxyMiddleware({ target: LOCATION_SERVICE_URL, changeOrigin: true }));

// 2. Auth Service Routes (all other citizen, police, firefighter routes)
app.use('/api/citizen', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }));
app.use('/api/police', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true })); // Catches /register, /login, /pushtoken
app.use('/api/firefighter', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }));

// 3. Alerts Service Routes
app.use('/api/alerts', createProxyMiddleware({ target: ALERTS_SERVICE_URL, changeOrigin: true }));

// 4. Directions Service Routes
app.use('/api/route', createProxyMiddleware({ target: DIRECTIONS_SERVICE_URL, changeOrigin: true }));

// 5. AI Service (Internal) - While not directly called from the client, routing it can be useful for testing.
app.use('/api/internal/analyze', createProxyMiddleware({ target: AI_ANALYSIS_SERVICE_URL, changeOrigin: true }));


// --- WebSocket Proxying ---
// This special handler listens for the initial HTTP 'upgrade' request that starts a WebSocket connection.
server.on('upgrade', (req, socket, head) => {
  console.log('Proxying WebSocket upgrade request...');
  // Create a proxy specifically for WebSocket connections.
  const wsProxy = createProxyMiddleware({
    target: WEBSOCKET_SERVICE_URL,
    ws: true, // Enable WebSocket proxying
    changeOrigin: true
  });
  // Manually call the upgrade method from the proxy middleware.
  wsProxy.upgrade(req, socket, head);
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`API Gateway is listening on port ${PORT}`);
});