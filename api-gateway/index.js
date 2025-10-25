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
 * Logs when a request is forwarded to a downstream service.
 */
const onProxyReq = (proxyReq, req) => {
    // Construct the target from the proxy request object itself, which is more reliable
    // than trying to access internal properties of the http-proxy agent.
    const targetUrl = new URL(proxyReq.path, proxyReq.agent.options.target);
    console.log(`[Proxy] Forwarding ${req.method} for original URL ${req.originalUrl} to ${targetUrl}`);
};

/**
 * Logs when a response is received from a downstream service.
 */
const onProxyRes = (proxyRes, req) => {
    // The `proxyRes` is an `http.IncomingMessage`, and its `req` property
    // is the `http.ClientRequest` (our `proxyReq`). We can use this to get the target.
    const target = new URL(proxyRes.req.path, `${proxyRes.req.protocol}//${proxyRes.req.host}`);
    console.log(`[Proxy] Received response with status ${proxyRes.statusCode} from ${target} for ${req.originalUrl}`);
};

/**
 * Handles errors from the proxy, such as timeouts or connection failures.
 */
const onError = (err, req, res, target) => {
    const targetHref = target ? target.href : 'an unknown service';
    console.error(`[Proxy] Error for ${req.method} ${req.originalUrl} to ${target}:`, err.message);
    if (!res.headersSent) {
        const statusCode = (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') ? 504 : 503;
        const message = statusCode === 504
            ? `Gateway Timeout: The service at ${targetHref} did not respond in time.`
            : `Service Unavailable: Could not connect to the service at ${targetHref}.`;


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
// --- Dynamic Routing Configuration ---

// Define the routing map. Order is important: more specific paths must come first.
const routeConfig = [
    { path: '/api/internal/analyze', target: AI_ANALYSIS_SERVICE_URL },
    { path: '/api/internal/find-nearby', target: LOCATION_SERVICE_URL },
    { path: '/api/police/locations', target: LOCATION_SERVICE_URL },
    { path: '/api/police/location', target: LOCATION_SERVICE_URL },
    // Must be after specific police routes
    { path: '/api/police', target: AUTH_SERVICE_URL },
    { path: '/api/citizen', target: AUTH_SERVICE_URL },
    { path: '/api/firefighter', target: AUTH_SERVICE_URL },
    { path: '/api/alerts', target: ALERTS_SERVICE_URL },
    { path: '/api/route', target: DIRECTIONS_SERVICE_URL },
];

// Router function to select the target based on the request path.
const router = (req) => {
    for (const route of routeConfig) {
        if (req.path.startsWith(route.path)) {
            return route.target;
        }
    }
    return null; // Should not happen if routes are configured correctly
};

// Define path rewrite rules. More specific rules must come first.
const pathRewrite = {
    '^/api/internal/analyze': '/analyze',
    '^/api/internal/find-nearby': '/find-nearby',
    '^/api': '' // General rule to strip '/api' prefix for all other services
};

// --- Single API Gateway Proxy ---
const apiProxy = createProxyMiddleware({
    router,
    changeOrigin: true,
    proxyTimeout: PROXY_TIMEOUT_MS,
    pathRewrite,
    on: {
        error: onError,
        proxyReq: onProxyReq,
        proxyRes: onProxyRes,
    }
};

// --- API Gateway Proxy Routing ---

app.use('/api', apiProxy);


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