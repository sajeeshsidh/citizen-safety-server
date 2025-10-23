
const express = require('express');
const cors = require('cors');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- Environment Configuration ---
// These URLs point to the independent microservices. In a real deployment (e.g., Docker, Kubernetes),
// these would be internal service names. For Render/local, they point to the running service's address.
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3002';
const ALERTS_SERVICE_URL = process.env.ALERTS_SERVICE_URL || 'http://localhost:3003';
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3004';
const DIRECTIONS_SERVICE_URL = process.env.DIRECTIONS_SERVICE_URL || 'http://localhost:3005';
const WEBSOCKET_SERVICE_URL = process.env.WEBSOCKET_SERVICE_URL || 'ws://localhost:3006';
const AI_ANALYSIS_SERVICE_URL = process.env.AI_ANALYSIS_SERVICE_URL || 'http://localhost:3007';

const PORT = process.env.PORT || 3001;

// --- Initialize Express App ---
const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(cors());

// --- Health Check Endpoint ---
app.get('/', (req, res) => {
    res.send('API Gateway is running.');
});

// --- API Gateway Proxy Routing ---
// The gateway forwards requests to the appropriate microservice.
app.use('/api/citizen', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
app.use('/api/police', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
app.use('/api/firefighter', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
app.use('/api/alerts', createProxyMiddleware({ target: ALERTS_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
app.use('/api/route', createProxyMiddleware({ target: DIRECTIONS_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
// Internal services are also routed
app.use('/api/internal/analyze', createProxyMiddleware({ target: AI_ANALYSIS_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api/internal': '/api/internal' } }));
app.use('/api/internal/find-nearby', createProxyMiddleware({ target: LOCATION_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api/internal': '/api/internal' } }));

// The location service has both public and internal endpoints that can be proxied.
app.use('/api/police/locations', createProxyMiddleware({ target: LOCATION_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));
app.use('/api/police/location', createProxyMiddleware({ target: LOCATION_SERVICE_URL, changeOrigin: true, pathRewrite: { '^/api': '/api' } }));

// --- WebSocket Upgrade Handling ---
// The initial WebSocket connection is an HTTP "Upgrade" request, which the gateway must handle.
// It then proxies the ongoing connection to the independent WebSocket service.
server.on('upgrade', (req, socket, head) => {
    console.log('Proxying WebSocket upgrade request...');
    const proxy = createProxyMiddleware({
        target: WEBSOCKET_SERVICE_URL,
        ws: true,
        changeOrigin: true
    });
    proxy.upgrade(req, socket, head);
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`API Gateway is listening on port ${PORT}`);
    console.log(`Proxying AUTH requests to: ${AUTH_SERVICE_URL}`);
    console.log(`Proxying ALERTS requests to: ${ALERTS_SERVICE_URL}`);
    console.log(`Proxying LOCATION requests to: ${LOCATION_SERVICE_URL}`);
    console.log(`Proxying DIRECTIONS requests to: ${DIRECTIONS_SERVICE_URL}`);
    console.log(`Proxying AI requests to: ${AI_ANALYSIS_SERVICE_URL}`);
    console.log(`Proxying WebSocket connections to: ${WEBSOCKET_SERVICE_URL}`);
});