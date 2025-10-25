
const express = require('express');
const cors = require('cors');
const { getDb, setupDatabase } = require('../../shared/database');

const PORT = process.env.PORT || 3002;
const app = express();
app.use(cors());
app.use(express.json());

const AuthService = {
    async initialize() {
        await setupDatabase();
        // --- Citizen Routes ---
        const citizenRouter = express.Router();
        citizenRouter.post('/register', this.registerCitizen);
        citizenRouter.post('/login', this.loginCitizen);
        app.use('/citizen', citizenRouter);
        
        // --- Police Routes ---
        const policeRouter = express.Router();
        policeRouter.post('/register', this.registerPolice);
        policeRouter.post('/login', this.loginPolice);
        policeRouter.post('/pushtoken', this.updatePushToken);
        app.use('/police', policeRouter);

        // --- Firefighter Routes ---
        const firefighterRouter = express.Router();
        firefighterRouter.post('/login', this.loginOrRegisterFirefighter);
        app.use('/firefighter', firefighterRouter);
        
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
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required.' });
        }
        try {
            const db = getDb();
            await db.run('INSERT INTO citizens (username, password) VALUES (?, ?)', username, password);
            res.status(201).json({ username });
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ message: 'Username already exists.' });
            }
            console.error('Error registering citizen:', error);
            res.status(500).json({ message: 'Registration failed.' });
        }
    },

    async loginCitizen(req, res) {
        const { username, password } = req.body;
        try {
            const db = getDb();
            const user = await db.get('SELECT * FROM citizens WHERE username = ? AND password = ?', username, password);
            if (user) {
                res.json({ username: user.username });
            } else {
                res.status(401).json({ message: 'Invalid username or password.' });
            }
        } catch (error) {
            console.error('Error logging in citizen:', error);
            res.status(500).json({ message: 'Login failed.' });
        }
    },

    async registerPolice(req, res) {
        const { name, designation, badgeNumber, phoneNumber, department } = req.body;
        if (!name || !designation || !badgeNumber || !phoneNumber) {
            return res.status(400).json({ message: 'All fields are required for police registration.' });
        }
        try {
            const db = getDb();
            await db.run(
                'INSERT INTO police (name, designation, badgeNumber, phoneNumber, department) VALUES (?, ?, ?, ?, ?)',
                name, designation, badgeNumber, phoneNumber, department || 'Law & Order'
            );
            res.status(201).json({ name, designation, badgeNumber, phoneNumber });
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ message: 'Badge number already registered.' });
            }
            console.error('Error registering police:', error);
            res.status(500).json({ message: 'Police registration failed.' });
        }
    },

    async loginPolice(req, res) {
        const { badgeNumber } = req.body;
        try {
            const db = getDb();
            const officer = await db.get('SELECT * FROM police WHERE badgeNumber = ?', badgeNumber);
            if (officer) {
                res.json(officer);
            } else {
                res.status(401).json({ message: 'Invalid badge number.' });
            }
        } catch (error) {
            console.error('Error logging in police:', error);
            res.status(500).json({ message: 'Police login failed.' });
        }
    },

    async loginOrRegisterFirefighter(req, res) {
        console.log('[Auth Service] Hit the /firefighter/login route handler.');
        const { unitNumber } = req.body;
        if (!unitNumber) {
            return res.status(400).json({ message: 'Unit number is required.' });
        }
        try {
            const db = getDb();
            let firefighter = await db.get('SELECT * FROM firefighters WHERE unitNumber = ?', unitNumber);
            if (!firefighter) {
                // Auto-register if not found for demo purposes
                await db.run('INSERT INTO firefighters (unitNumber, department) VALUES (?, ?)', unitNumber, 'Fire & Rescue');
                firefighter = await db.get('SELECT * FROM firefighters WHERE unitNumber = ?', unitNumber);
            }
            res.json(firefighter);
        } catch (error) {
            console.error('Error logging in/registering firefighter:', error);
            res.status(500).json({ message: 'Firefighter login failed.' });
        }
    },

    async updatePushToken(req, res) {
        const { badgeNumber, token } = req.body;
        if (!badgeNumber || !token) {
            return res.status(400).json({ message: 'Badge number and token are required.' });
        }
        try {
            const db = getDb();
            await db.run('UPDATE police SET pushToken = ? WHERE badgeNumber = ?', token, badgeNumber);
            res.status(204).send();
        } catch (error) {
            console.error('Error updating push token:', error);
            res.status(500).json({ message: 'Failed to update push token.' });
        }
    }
};

AuthService.initialize();