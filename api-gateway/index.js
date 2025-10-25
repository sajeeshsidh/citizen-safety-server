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

// --- Custom Error for Unroutable Requests ---
const UNROUTABLE_ERROR_MESSAGE = 'UNROUTABLE_REQUEST';

/**
 * Logs when a request is forwarded to a downstream service.
 */
const onProxyReq = (proxyReq, req) => {
    // req.selectedTarget is attached by our custom router for safe logging
    if (req.selectedTarget) {
        try {
            const fullTargetUrl = new URL(proxyReq.path, req.selectedTarget);
            console.log(`[Proxy] Forwarding ${req.method} for original URL ${req.originalUrl} to ${fullTargetUrl.href}`);
        } catch (e) {
            console.error(`[Proxy] Logging error in onProxyReq for path "${proxyReq.path}" and target "${req.selectedTarget}":`, e.message);
        }
    }
};

/**
 * Logs when a response is received from a downstream service.
 */
const onProxyRes = (proxyRes, req) => {
    // req.selectedTarget is attached by our custom router for safe logging
    if (req.selectedTarget) {
         try {
            const fullTargetUrl = new URL(proxyRes.req.path, req.selectedTarget);
            console.log(`[Proxy] Received response with status ${proxyRes.statusCode} from ${fullTargetUrl.href} for ${req.originalUrl}`);
        } catch (e) {
            console.error(`[Proxy] Logging error in onProxyRes for path "${proxyRes.req.path}" and target "${req.selectedTarget}":`, e.message);
        }
    }
};

/**
 * Handles errors from the proxy, such as timeouts or connection failures.
 */
const onError = (err, req, res, target) => {
    // --- Graceful 404 Handling for Unroutable Requests ---
    if (err.message === UNROUTABLE_ERROR_MESSAGE) {
        const errorMessage = `[Proxy] 404 Not Found: No route configured for ${req.method} ${req.originalUrl}`;
        console.error(errorMessage);
        if (res && !res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `API route not found for ${req.originalUrl}` }));
        }
        return; // Stop further processing for this specific error.
    }

    // Determine the target URL for logging, safely handling cases where req is undefined.
    let targetHref = 'an unknown service';
    // Safely determine the target URL for logging.
    // The `req` object might not exist for low-level connection errors.
    if (target && typeof target.href === 'string') {
        targetHref = target.href;
    } else if (req && typeof req.selectedTarget === 'string') {
        targetHref = req.selectedTarget;
    }

    // Safely log the error.

    // Defensive check: req might be undefined for connection errors.
    if (req && req.method && req.originalUrl) {
        console.error(`[Proxy] Error for ${req.method} ${req.originalUrl} to ${targetHref}:`, err.message);
    } else {
        console.error(`[Proxy] Error connecting to ${targetHref}:`, err.message);
    }

    if (res && !res.headersSent) {
        const statusCode = (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') ? 504 : 503;
        const message = statusCode === 504
            ? `Gateway Timeout: The service at ${targetHref} did not respond in time.`
            : `Service Unavailable: Could not connect to the service at ${targetHref}.`;


        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message, code: err.code }));
    }
};

// --- Dynamic Routing Configuration ---

// Define the routing map. The path is relative to the '/api' mount point.
// Order is important: more specific paths must come first.
const routeConfig = [
    { path: '/internal/analyze', target: AI_ANALYSIS_SERVICE_URL },
    { path: '/internal/find-nearby', target: LOCATION_SERVICE_URL },
    { path: '/police/locations', target: LOCATION_SERVICE_URL },
    { path: '/police/location', target: LOCATION_SERVICE_URL },
    // Must be after specific police routes
    { path: '/police', target: AUTH_SERVICE_URL },
    { path: '/citizen', target: AUTH_SERVICE_URL },
    { path: '/firefighter', target: AUTH_SERVICE_URL },
    { path: '/alerts', target: ALERTS_SERVICE_URL },
    { path: '/route', target: DIRECTIONS_SERVICE_URL },
];

// Router function to select the target and attach it to the request for logging.
const router = (req) => {
    for (const route of routeConfig) {
        // req.path is stripped of the '/api' prefix by Express
        if (req.path.startsWith(route.path)) {
            // Attach the selected target to the request object for use in event handlers.
            req.selectedTarget = route.target;
        }
    }
    // If no route matches, throw the custom error to be caught by onError.
    throw new Error(UNROUTABLE_ERROR_MESSAGE);
};

// Define path rewrite rules. These are applied to the path seen by the proxy (e.g., '/internal/analyze').
const pathRewrite = {
    '^/internal/analyze': '/analyze',
    '^/internal/find-nearby': '/find-nearby'
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
});

// --- API Gateway Proxy Routing ---

// All API requests are handled by the single proxy instance.
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