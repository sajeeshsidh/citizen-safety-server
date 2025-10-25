const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3002;
const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL || 'http://database-service:3008';
const app = express();
app.use(cors());
app.use(express.json());

const dbService = {
    async request(path, options = {}) {
        const response = await fetch(`${DATABASE_SERVICE_URL}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        // A 204 response has no body to parse, so return null.
        if (response.status === 204) return null;

        const data = await response.json();
        if (!response.ok) {
            // Forward the error message from the database service.
            throw new Error(data.message || `Database service error: ${response.status}`);
        }
        return data;
    },
};

const AuthService = {
    async initialize() {
        app.get('/', (req, res) => res.send('Auth Service is running.'));

        app.post('/citizen/register', this.registerCitizen);
        app.post('/citizen/login', this.loginCitizen);
        app.post('/police/register', this.registerPolice);
        app.post('/police/login', this.loginPolice);
        app.post('/police/pushtoken', this.updatePushToken);
        app.post('/firefighter/login', this.loginOrRegisterFirefighter);

        app.listen(PORT, () => {
            console.log(`Auth Service listening on port ${PORT}`);
            // --- Diagnostic Route Logging ---
            console.log('--- Registered Auth Service Routes ---');
            const listEndpoints = (router, basePath) => {
                router.stack.forEach((layer) => {
                    if (layer.route) { // Layer is a route handler
                        const path = layer.route.path;
                        const methods = Object.keys(layer.route.methods).filter(m => m !== '_all').join(', ').toUpperCase();
                        if (methods) {
                            console.log(`Route registered: ${methods} ${basePath}${path === '/' ? '' : path}`);
                        }
                    } else if (layer.name === 'router') { // Layer is a sub-router
                        const newBasePath = layer.regexp.source
                            .replace('^\\', '')
                            .replace('\\/?(?=\\/|$)', '')
                            .replace(/\\(.)/g, '$1');
                        listEndpoints(layer.handle, `${basePath}${newBasePath}`);
                    }
                });
            };

            listEndpoints(app._router, '');
            console.log('------------------------------------');
        });
    },

    async registerCitizen(req, res) {
        try {
            const user = await dbService.request('/citizens/register', { method: 'POST', body: JSON.stringify(req.body) });
            res.status(201).json(user);
        } catch (error) {
            // Assuming 409 for constraint violation from dbService
            res.status(409).json({ message: error.message });
        }
    },

    async loginCitizen(req, res) {
        try {
            const user = await dbService.request('/citizens/login', { method: 'POST', body: JSON.stringify(req.body) });
            res.json(user);
        } catch (error) {
            // Assuming 401 for login failure from dbService
            res.status(401).json({ message: error.message });
        }
    },

    async registerPolice(req, res) {
        try {
            const officer = await dbService.request('/police/register', { method: 'POST', body: JSON.stringify(req.body) });
            res.status(201).json(officer);
        } catch (error) {
            res.status(409).json({ message: error.message });
        }
    },

    async loginPolice(req, res) {
        try {
            const officer = await dbService.request('/police/login', { method: 'POST', body: JSON.stringify(req.body) });
            res.json(officer);
        } catch (error) {
            res.status(401).json({ message: error.message });
        }
    },

    async loginOrRegisterFirefighter(req, res) {
        try {
            const firefighter = await dbService.request('/firefighters/login', { method: 'POST', body: JSON.stringify(req.body) });
            res.json(firefighter);
        } catch (error) {
            console.error('Error in loginOrRegisterFirefighter:', error);
            res.status(500).json({ message: 'Login/Registration failed.' });
        }
    },

    async updatePushToken(req, res) {
        try {
            const { badgeNumber, token } = req.body;
            if (!badgeNumber || !token) {
                return res.status(400).json({ message: 'Badge number and token are required.' });
            }
            await dbService.request(`/police/${badgeNumber}/pushtoken`, { method: 'PUT', body: JSON.stringify({ token }) });
            res.status(204).send();
        } catch (error) {
            console.error('Error updating push token:', error);
            res.status(500).json({ message: 'Failed to update push token.' });
        }
    }
};

AuthService.initialize();