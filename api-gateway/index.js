const express = require('express');
const cors = require('cors');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// --- Environment Configuration ---
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3002';
const ALERTS_SERVICE_URL = process.env.ALERTS_SERVICE_URL || 'http://localhost:3003';
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3004';
const DIRECTIONS_SERVICE_URL = process.env.DIRECTIONS_SERVICE_URL || 'http://localhost:3005';
const WEBSOCKET_SERVICE_URL = process.env.WEBSOCKET_SERVICE_URL || 'ws://localhost:3006';
const AI_ANALYSIS_SERVICE_URL = process.env.AI_ANALYSIS_SERVICE_URL || 'http://localhost:3007';

const PORT = process.env.PORT || 3001;
const PROXY_TIMEOUT_MS = 120000; // 120 seconds (2 minutes) to handle cascading cold starts

// --- Initialize Express App ---
const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(cors());

// --- Health Check Endpoint ---
app.get('/', (req, res) => {
    res.send('API Gateway is running.');
});

// --- Proxy Event Handlers ---

/**
 * Handles errors from the proxy, such as timeouts or connection failures.
 */
const onError = (err, req, res, target) => {
    console.error(`[Proxy] Error for ${req.method} ${req.originalUrl} to ${target}:`, err.message);
    if (!res.headersSent) {
        const statusCode = (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') ? 504 : 503;
        const message = statusCode === 504
            ? `Gateway Timeout: The service at ${target} did not respond in time.`
            : `Service Unavailable: Could not connect to the service at ${target}.`;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message, code: err.code }));
    }
};

/**
 * Creates a configuration object for the http-proxy-middleware.
 * @param {string} target - The base URL of the target service.
 * @param {object|null} pathRewrite - Optional path rewriting rules.
 * @returns {object} The configuration object for the proxy.
 */
const createProxyOptions = (target, pathRewrite = null) => {
    // Define request/response handlers inside this function to capture `target` in a closure.
    // This is a robust way to access the target URL for logging, fixing the crash.
    const onProxyReq = (proxyReq, req) => {
        const fullTargetUrl = new URL(proxyReq.path, target);
        console.log(`[Proxy] Forwarding ${req.method} for original URL ${req.originalUrl} to ${fullTargetUrl.href}`);
    };

    const onProxyRes = (proxyRes, req) => {
        // Use the same closure pattern to safely get the target for the response log.
        const fullTargetUrl = new URL(proxyRes.req.path, target);
        console.log(`[Proxy] Received response with status ${proxyRes.statusCode} from ${fullTargetUrl.href} for ${req.originalUrl}`);
    };
    const options = {
        target,
        changeOrigin: true,
        proxyTimeout: PROXY_TIMEOUT_MS,
        on: {
            error: onError,
            proxyReq: onProxyReq,
            proxyRes: onProxyRes,
        }
    };
    if (pathRewrite) {
        options.pathRewrite = pathRewrite;
    }
    return options;
};

// --- API Gateway Proxy Routing ---
// The order is critical: more specific paths MUST be listed before general paths.

// 1. Internal APIs (not intended for direct client access)
app.use('/api/internal/analyze', createProxyMiddleware(createProxyOptions(AI_ANALYSIS_SERVICE_URL, { '^/api/internal/analyze': '/analyze' })));
app.use('/api/internal/find-nearby', createProxyMiddleware(createProxyOptions(LOCATION_SERVICE_URL, { '^/api/internal/find-nearby': '/find-nearby' })));

// 2. Location Service (Handles specific '/api/police' routes first to avoid being caught by the general auth proxy)
app.use('/api/police/locations', createProxyMiddleware(createProxyOptions(LOCATION_SERVICE_URL, { '^/api/police/locations': '/police/locations' })));
app.use('/api/police/location', createProxyMiddleware(createProxyOptions(LOCATION_SERVICE_URL, { '^/api/police/locations': '/police/locations' })));

// 3. Auth Service (Handles all general auth routes with path rewriting to decouple the service)
 // Rewrites /api/citizen/login to /citizen/login
app.use('/api/citizen', createProxyMiddleware(createProxyOptions(AUTH_SERVICE_URL, { '^/api/citizen': '/citizen' })));
app.use('/api/firefighter', createProxyMiddleware(createProxyOptions(AUTH_SERVICE_URL, { '^/api/firefighter': '/firefighter' })));
app.use('/api/police', createProxyMiddleware(createProxyOptions(AUTH_SERVICE_URL, { '^/api/police': '/police' }))); // This is safe because specific police routes are handled above.

// 4. Other Public Services
app.use('/api/alerts', createProxyMiddleware(createProxyOptions(ALERTS_SERVICE_URL, { '^/api/alerts': '/alerts' })));
app.use('/api/route', createProxyMiddleware(createProxyOptions(DIRECTIONS_SERVICE_URL, { '^/api/route': '/route' })));


// --- WebSocket Upgrade Handling ---
server.on('upgrade', (req, socket, head) => {
    console.log('[API Gateway] Attempting to upgrade WebSocket connection...');
    const wsProxy = createProxyMiddleware({
        target: WEBSOCKET_SERVICE_URL,
        ws: true,
        changeOrigin: true,
    });
    wsProxy.upgrade(req, socket, head);
});


// --- Service Health Checks ---
const checkServiceHealth = async (serviceName, url, retries = 3, delay = 3000) => {
    for (let i = 1; i <= retries; i++) {
        console.log(`[Health Check] Attempt ${i}/${retries} for ${serviceName} at ${url}...`);
        try {
            if (url.startsWith('ws')) {
                await new Promise((resolve, reject) => {
                    const ws = new WebSocket(url);
                    ws.on('open', () => { ws.close(); resolve(true); });
                    ws.on('error', (err) => { reject(err); });
                    setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
                });
                console.log(`[Health Check] ✅ ${serviceName} is running.`);
                return;
            } else {
                const response = await fetch(url, { timeout: 5000 });
                if (response.status < 500) {
                     console.log(`[Health Check] ✅ ${serviceName} is running (status: ${response.status}).`);
                     return;
                } else {
                     throw new Error(`Server responded with status ${response.status}`);
                }
            }
        } catch (error) {
            console.error(`[Health Check] Attempt ${i} failed for ${serviceName}. Reason: ${error.message}`);
            if (i < retries) {
                console.log(`[Health Check] Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`[Health Check] ❌ FINAL: ${serviceName} at ${url} is unresponsive after ${retries} attempts.`);
            }
        }
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