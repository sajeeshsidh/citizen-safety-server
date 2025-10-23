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

// --- Error logging ---
const proxyErrorHandler = (err, req, res, target) => {
    console.error(`[API Gateway] Failed to connect to ${target} for ${req.originalUrl}:`, err.code);
    res.status(503).json({
        message: `Service Unavailable: Could not reach the back-end service at ${target}`,
        code: err.code
    });
};

// Add a simple logging middleware to see all incoming API requests
app.use('/api', (req, res, next) => {
    console.log(`[API Gateway] Received request: ${req.method} ${req.originalUrl}`);
    next();
});

// --- Proxy Options ---
const createProxyOptions = (targetUrl, providerName, pathRewriteMap = {}) => ({
    target: targetUrl,
    changeOrigin: true,
    pathRewrite: pathRewriteMap,
    onProxyReq: logProvider(providerName, targetUrl),
    // --- New Error Handler ---
    onError: (err, req, res) => proxyErrorHandler(err, req, res, targetUrl),
    // Add debug logging to catch internal proxy errors
    logLevel: 'debug'
});

// Define the options for each proxy once to avoid duplicating code.
const authProxyOptions = createProxyOptions(
    AUTH_SERVICE_URL,
    'AuthService',
    {}
);
const alertsProxyOptions = createProxyOptions(
    ALERTS_SERVICE_URL,
    'AlertsService',
    {}
);
const locationProxyOptions = createProxyOptions(
    LOCATION_SERVICE_URL,
    'LocationService',
    {}
);
const directionsProxyOptions = createProxyOptions(
    DIRECTIONS_SERVICE_URL,
    'DirectionsService',
    {}
);
const aiProxyOptions = createProxyOptions(
    AI_ANALYSIS_SERVICE_URL,
    'AIService',
    {}
);

// --- Routing Order ---
// The order is critical: more specific paths MUST be listed before general paths.
// **Crucially, we create a NEW proxy instance for each route.**

// 1. Location Service (Handles the most specific '/api/police' routes)
app.use('/api/police/locations', createProxyMiddleware(locationProxyOptions));
app.use('/api/police/location', createProxyMiddleware(locationProxyOptions));

// 2. Auth Service (Handles all other auth-related routes)
app.use('/api/citizen', createProxyMiddleware(authProxyOptions));
app.use('/api/police', createProxyMiddleware(authProxyOptions)); // Safe because specific police routes were handled above
app.use('/api/firefighter', createProxyMiddleware(authProxyOptions));

// 3. Other Services
app.use('/api/alerts', createProxyMiddleware(alertsProxyOptions));
app.use('/api/route', createProxyMiddleware(directionsProxyOptions));
app.use('/api/internal/analyze', createProxyMiddleware(aiProxyOptions));

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

// --- Service Health Checks ---
const checkServiceHealth = async (serviceName, url) => {
    try {
        if (url.startsWith('ws')) {
            // For WebSocket services
            return new Promise((resolve) => {
                const ws = new WebSocket(url);
                ws.on('open', () => {
                    console.log(`[Health Check] ✅ ${serviceName} is running at ${url}`);
                    ws.close();
                    resolve(true);
                });
                ws.on('error', (err) => {
                    console.error(`[Health Check] ❌ ${serviceName} is down. Error: ${err.message}`);
                    resolve(false);
                });
            });
        } else {
            // For HTTP services, a fetch to the root is sufficient.
            // A 404 response still means the service is up and running.
            const response = await fetch(url);
            if (response.status < 500) {
                 console.log(`[Health Check] ✅ ${serviceName} is running at ${url} (status: ${response.status})`);
            } else {
                 console.error(`[Health Check] ❌ ${serviceName} at ${url} responded with server error ${response.status}`);
            }
        }
    } catch (error) {
        console.error(`[Health Check] ❌ ${serviceName} is down at ${url}. Error: ${error.message}`);
    }
};

const checkAllServices = async () => {
    console.log('[Health Check] --- Starting microservice health checks ---');
    await Promise.all([
        checkServiceHealth('Auth Service', AUTH_SERVICE_URL),
        checkServiceHealth('Alerts Service', ALERTS_SERVICE_URL),
        checkServiceHealth('Location Service', LOCATION_SERVICE_URL),
        checkServiceHealth('Directions Service', DIRECTIONS_SERVICE_URL),
        checkServiceHealth('AI Analysis Service', AI_ANALYSIS_SERVICE_URL),
        checkServiceHealth('WebSocket Service', WEBSOCKET_SERVICE_URL)
    ]);
    console.log('[Health Check] --- Health checks complete ---');
};


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`API Gateway is listening on port ${PORT}`);
    console.log(`Proxying AUTH requests to: ${AUTH_SERVICE_URL}`);
    console.log(`Proxying ALERTS requests to: ${ALERTS_SERVICE_URL}`);
    console.log(`Proxying LOCATION requests to: ${LOCATION_SERVICE_URL}`);
    console.log(`Proxying DIRECTIONS requests to: ${DIRECTIONS_SERVICE_URL}`);
    console.log(`Proxying AI requests to: ${AI_ANALYSIS_SERVICE_URL}`);
    console.log(`Proxying WebSocket connections to: ${WEBSOCKET_SERVICE_URL}`);

    // Run health checks on startup
    checkAllServices();
});