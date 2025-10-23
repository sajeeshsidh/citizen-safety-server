
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
        app.post('/api/citizen/register', this.registerCitizen);
        app.post('/api/citizen/login', this.loginCitizen);
        app.post('/api/police/register', this.registerPolice);
        app.post('/api/police/login', this.loginPolice);
        app.post('/api/police/pushtoken', this.updatePushToken);
        app.post('/api/firefighter/login', this.loginOrRegisterFirefighter);
        
        app.listen(PORT, () => {
            console.log(`Auth Service listening on port ${PORT}`);
            // --- Diagnostic Route Logging ---
            console.log('--- Registered Auth Service Routes ---');
            app._router.stack.forEach((middleware) => {
                if (middleware.route) { // routes registered directly on the app
                    const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
                    console.log(`Route registered: ${methods} ${middleware.route.path}`);
                }
            });
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