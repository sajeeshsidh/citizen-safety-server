const express = require('express');
const cors = require('cors');
const { getDb, setupDatabase } = require('./database');

const PORT = process.env.PORT || 3008;
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for alert audio data

const DatabaseService = {
    // --- Helper for formatting alerts before sending them out ---
    _formatAlert(alert) {
        if (!alert) return null;
        const newAlert = { ...alert };
        if (newAlert.targetedOfficers) {
            try { newAlert.targetedOfficers = JSON.parse(newAlert.targetedOfficers); } catch (e) { newAlert.targetedOfficers = []; console.log("JSON Parse error", e); }
        }
        if (newAlert.locationLat && newAlert.locationLng) {
            newAlert.location = { lat: newAlert.locationLat, lng: newAlert.locationLng };
        }
        delete newAlert.locationLat;
        delete newAlert.locationLng;
        return newAlert;
    },

    async initialize() {
        await setupDatabase();
        const db = getDb();

        app.get('/', (req, res) => res.send('Database Service is running.'));

        // --- ALERTS API ---

        app.get('/alerts', async (req, res) => {
            const alertsRaw = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
            res.json(alertsRaw.map(this._formatAlert));
        });

        app.get('/alerts/:id', async (req, res) => {
            const alertRaw = await db.get('SELECT * FROM alerts WHERE id = ?', req.params.id);
            res.json(this._formatAlert(alertRaw));
        });

        app.post('/alerts/by-geohashes', async (req, res) => {
            const { geohashes } = req.body;
            if (!geohashes || geohashes.length === 0) return res.json([]);
            const placeholders = geohashes.map(() => '?').join(',');
            // Only retrieve active alerts for initial load
            const alertsRaw = await db.all(`SELECT * FROM alerts WHERE geohash IN (${placeholders}) AND status IN ('new', 'accepted') ORDER BY timestamp DESC`, geohashes);
            res.json(alertsRaw.map(this._formatAlert));
        });

        app.post('/alerts/find-and-update-timeouts', async (req, res) => {
            const now = Date.now();
            const timedOutAlertsRaw = await db.all('SELECT * FROM alerts WHERE status = ? AND timeoutTimestamp <= ?', ['new', now]);
            if (timedOutAlertsRaw.length > 0) {
                const ids = timedOutAlertsRaw.map(a => a.id);
                const placeholders = ids.map(() => '?').join(',');
                await db.run(`UPDATE alerts SET status = 'timed_out' WHERE id IN (${placeholders})`, ids);
                res.json({ updatedCount: ids.length, timedOutAlerts: timedOutAlertsRaw.map(this._formatAlert) });
            } else {
                res.json({ updatedCount: 0, timedOutAlerts: [] });
            }
        });

        app.post('/alerts', async (req, res) => {
            const { citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, timeoutTimestamp, geohash } = req.body;
            const result = await db.run(
                'INSERT INTO alerts (citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, timeoutTimestamp, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, timeoutTimestamp, geohash]
            );
            const newAlertRaw = await db.get('SELECT * FROM alerts WHERE id = ?', result.lastID);
            res.status(201).json(this._formatAlert(newAlertRaw));
        });

        app.put('/alerts/:id', async (req, res) => {
            const { id } = req.params;
            const fields = req.body;
            const setClauses = Object.keys(fields).map(key => `${key} = ?`).join(', ');
            const values = Object.values(fields);
            await db.run(`UPDATE alerts SET ${setClauses} WHERE id = ?`, [...values, id]);
            const updatedAlertRaw = await db.get('SELECT * FROM alerts WHERE id = ?', id);
            res.json(this._formatAlert(updatedAlertRaw));
        });

        app.delete('/alerts/:id', async (req, res) => {
            await db.run('DELETE FROM alerts WHERE id = ?', req.params.id);
            res.status(204).send();
        });

        // --- CITIZENS API ---
        app.post('/citizens/register', async (req, res) => {
            try {
                const { username, password } = req.body;
                await db.run('INSERT INTO citizens (username, password) VALUES (?, ?)', username, password);
                res.status(201).json({ username });
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ message: 'Username already exists.' });
                res.status(500).json({ message: 'Registration failed.' });
            }
        });

        app.post('/citizens/login', async (req, res) => {
            const { username, password } = req.body;
            const user = await db.get('SELECT * FROM citizens WHERE username = ? AND password = ?', username, password);
            if (user) res.json({ username: user.username });
            else res.status(401).json({ message: 'Invalid username or password.' });
        });

        // --- POLICE API ---
        app.get('/police', async (req, res) => {
            const officers = await db.all('SELECT * FROM police WHERE locationLat IS NOT NULL');
            res.json(officers);
        });

        app.post('/police/by-badges', async (req, res) => {
            const { badgeNumbers } = req.body;
            if (!badgeNumbers || badgeNumbers.length === 0) return res.json([]);
            const placeholders = badgeNumbers.map(() => '?').join(',');
            const officers = await db.all(`SELECT * FROM police WHERE badgeNumber IN (${placeholders})`, badgeNumbers);
            res.json(officers);
        });

        app.post('/police/register', async (req, res) => {
            try {
                const { name, designation, badgeNumber, phoneNumber, department } = req.body;
                await db.run('INSERT INTO police (name, designation, badgeNumber, phoneNumber, department) VALUES (?, ?, ?, ?, ?)', name, designation, badgeNumber, phoneNumber, department || 'Law & Order');
                res.status(201).json(req.body);
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ message: 'Badge number already registered.' });
                res.status(500).json({ message: 'Police registration failed.' });
            }
        });

        app.post('/police/login', async (req, res) => {
            const { badgeNumber } = req.body;
            const officer = await db.get('SELECT * FROM police WHERE badgeNumber = ?', badgeNumber);
            if (officer) res.json(officer);
            else res.status(401).json({ message: 'Invalid badge number.' });
        });

        app.put('/police/:badgeNumber/pushtoken', async (req, res) => {
            const { badgeNumber } = req.params;
            const { token } = req.body;
            await db.run('UPDATE police SET pushToken = ? WHERE badgeNumber = ?', token, badgeNumber);
            res.status(204).send();
        });

        app.put('/police/:badgeNumber/location', async (req, res) => {
            const { badgeNumber } = req.params;
            const { location } = req.body;
            await db.run('UPDATE police SET locationLat = ?, locationLng = ? WHERE badgeNumber = ?', location.lat, location.lng, badgeNumber);
            res.status(204).send();
        });

        // --- FIREFIGHTERS API ---
        app.get('/firefighters', async (req, res) => {
            const firefighters = await db.all('SELECT * FROM firefighters WHERE locationLat IS NOT NULL');
            res.json(firefighters);
        });

        app.post('/firefighters/by-units', async (req, res) => {
            const { unitNumbers } = req.body;
            if (!unitNumbers || unitNumbers.length === 0) {
                return res.json([]);
            }
            const placeholders = unitNumbers.map(() => '?').join(',');
            const firefighters = await db.all(`SELECT * FROM firefighters WHERE unitNumber IN (${placeholders})`, unitNumbers);
            res.json(firefighters);
        });

        app.post('/firefighters/login', async (req, res) => {
            const { unitNumber } = req.body;
            let firefighter = await db.get('SELECT * FROM firefighters WHERE unitNumber = ?', unitNumber);
            if (!firefighter) {
                await db.run('INSERT INTO firefighters (unitNumber, department) VALUES (?, ?)', unitNumber, 'Fire & Rescue');
                firefighter = await db.get('SELECT * FROM firefighters WHERE unitNumber = ?', unitNumber);
            }
            res.json(firefighter);
        });

        app.put('/firefighters/:unitNumber/pushtoken', async (req, res) => {
            const { unitNumber } = req.params;
            const { token } = req.body;
            await db.run('UPDATE firefighters SET pushToken = ? WHERE unitNumber = ?', token, unitNumber);
            res.status(204).send();
        });

        app.put('/firefighters/:unitNumber/location', async (req, res) => {
            const { unitNumber } = req.params;
            const { location } = req.body;
            await db.run('UPDATE firefighters SET locationLat = ?, locationLng = ? WHERE unitNumber = ?', location.lat, location.lng, unitNumber);
            res.status(204).send();
        });

        app.listen(PORT, () => console.log(`Database Service listening on port ${PORT}`));
    }
};

DatabaseService.initialize();
