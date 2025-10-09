const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3001;

// --- Database Setup ---
let db;

async function setupDatabase() {
    db = await open({
        filename: './database.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS citizens (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS police (
            badgeNumber TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            designation TEXT NOT NULL,
            phoneNumber TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            citizenId TEXT NOT NULL,
            message TEXT,
            audioBase64 TEXT,
            locationLat REAL,
            locationLng REAL,
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL,
            acceptedBy TEXT
        );
    `);
    console.log('Database connected and tables ensured.');
}


// In-memory store for real-time, non-persistent data like officer locations
const officerLocations = {
    '728': { lat: 34.06, lng: -118.25 },
    '551': { lat: 34.045, lng: -118.26 },
    '912': { lat: 34.055, lng: -118.23 },
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- WebSocket Logic ---
const clients = new Set();

const broadcastData = (data) => {
    const dataString = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(dataString, (err) => {
                if (err) {
                    console.error('WebSocket send error:', err);
                    clients.delete(client);
                }
            });
        }
    });
};

const formatAlerts = (alerts) => {
    return alerts.map(alert => {
        const { locationLat, locationLng, ...rest } = alert;
        const newAlert = { ...rest };
        if (locationLat != null && locationLng != null) {
            newAlert.location = { lat: locationLat, lng: locationLng };
        }
        return newAlert;
    });
};

const broadcastAlerts = async () => {
    try {
        const alerts = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
        broadcastData({ type: 'alerts', payload: formatAlerts(alerts) });
    } catch (error) {
        console.error("Failed to fetch and broadcast alerts:", error);
    }
};

const broadcastLocations = () => {
    const locationsArray = Object.entries(officerLocations).map(([badgeNumber, location]) => ({
        badgeNumber,
        location,
    }));
    broadcastData({ type: 'locations', payload: locationsArray });
};

// Periodically broadcast locations to all clients
setInterval(broadcastLocations, 2000);

wss.on('connection', async (ws) => {
  clients.add(ws);
  console.log('Client connected. Total clients:', clients.size);

  // Send the current list of alerts and locations to the newly connected client
  try {
      const alerts = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
      ws.send(JSON.stringify({ type: 'alerts', payload: formatAlerts(alerts) }));
  } catch (error) {
      console.error("Failed to send initial alerts to new client:", error);
  }
  
  broadcastLocations(); // Send latest locations immediately on connect

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected. Total clients:', clients.size);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// --- Routes ---

app.get('/', (req, res) => {
  res.send('Citizen Safety Backend is running.');
});

// Citizen Registration
app.post('/api/citizen/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
  
  try {
      const existingUser = await db.get('SELECT * FROM citizens WHERE username = ?', [username]);
      if (existingUser) {
          return res.status(409).json({ message: 'Username already taken.' });
      }
      await db.run('INSERT INTO citizens (username, password) VALUES (?, ?)', [username, password]);
      console.log('New citizen registered:', username);
      res.status(201).json({ username });
  } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ message: 'Server error during registration.' });
  }
});

// Citizen Login
app.post('/api/citizen/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
  
  try {
      const user = await db.get('SELECT * FROM citizens WHERE username = ?', [username]);
      if (!user || user.password !== password) {
          return res.status(401).json({ message: 'Invalid username or password.' });
      }
      console.log('Citizen logged in:', user.username);
      res.status(200).json({ username: user.username });
  } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ message: 'Server error during login.' });
  }
});

// Police Registration
app.post('/api/police/register', async (req, res) => {
    const { name, designation, badgeNumber, phoneNumber } = req.body;
    if (!name || !designation || !badgeNumber || !phoneNumber) return res.status(400).json({ message: 'All fields are required.' });

    try {
        const existingOfficer = await db.get('SELECT * FROM police WHERE badgeNumber = ?', [badgeNumber]);
        if (existingOfficer) {
            return res.status(409).json({ message: 'Badge number already registered.' });
        }
        await db.run(
            'INSERT INTO police (name, designation, badgeNumber, phoneNumber) VALUES (?, ?, ?, ?)',
            [name, designation, badgeNumber, phoneNumber]
        );
        const newOfficer = { name, designation, badgeNumber, phoneNumber };
        console.log('New officer registered:', newOfficer.badgeNumber);
        res.status(201).json(newOfficer);
    } catch (err) {
        console.error('Police registration error:', err);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

// Police Login
app.post('/api/police/login', async (req, res) => {
    const { badgeNumber } = req.body;
    if (!badgeNumber) return res.status(400).json({ message: 'Badge number is required.' });

    try {
        const officer = await db.get('SELECT * FROM police WHERE badgeNumber = ?', [badgeNumber]);
        if (!officer) return res.status(404).json({ message: 'Badge number not found.' });
        
        if (!officerLocations[officer.badgeNumber]) {
            officerLocations[officer.badgeNumber] = { lat: 34.0522, lng: -118.2437 }; // Default location
        }
        console.log('Officer logged in:', officer.badgeNumber);
        res.status(200).json(officer);
    } catch (err) {
        console.error('Police login error:', err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// POST to update an officer's location
app.post('/api/police/location', (req, res) => {
    const { badgeNumber, location } = req.body;
    if (!badgeNumber || !location) return res.status(400).json({ message: 'Badge number and location are required.' });
    
    officerLocations[badgeNumber] = location;
    broadcastLocations(); 
    res.status(204).send();
});

// GET all active police locations
app.get('/api/police/locations', (req, res) => {
    const locationsArray = Object.entries(officerLocations).map(([badgeNumber, location]) => ({
        badgeNumber,
        location,
    }));
    res.status(200).json(locationsArray);
});

// --- Alert Routes ---

// GET all alerts
app.get('/api/alerts', async (req, res) => {
    try {
        const alerts = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
        res.status(200).json(formatAlerts(alerts));
    } catch (err) {
        console.error("Error fetching alerts:", err);
        res.status(500).json({ message: 'Failed to fetch alerts.' });
    }
});

// POST a new alert
app.post('/api/alerts', async (req, res) => {
  const { citizenId, message, audioBase64, location } = req.body;
  if (!citizenId) return res.status(400).json({ message: 'Citizen ID is required.' });

  try {
      const result = await db.run(
          'INSERT INTO alerts (citizenId, message, audioBase64, locationLat, locationLng, timestamp, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [citizenId, message || null, audioBase64 || null, location?.lat || null, location?.lng || null, Date.now(), 'new']
      );
      
      const newAlert = {
          id: result.lastID,
          citizenId,
          message,
          audioBase64,
          location,
          timestamp: Date.now(),
          status: 'new'
      };
      console.log('New alert created:', newAlert.id);
      broadcastAlerts();
      res.status(201).json(newAlert);
  } catch (err) {
      console.error("Error creating alert:", err);
      res.status(500).json({ message: 'Failed to create alert.' });
  }
});

// POST to accept an alert
app.post('/api/alerts/:id/accept', async (req, res) => {
    const { id } = req.params;
    const { officerId } = req.body;
    if (!officerId) return res.status(400).json({ message: 'Officer ID is required.' });

    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });

        if (alert.status !== 'new') {
            return res.status(409).json({ message: 'Alert has already been accepted or does not exist.' });
        }
        
        await db.run('UPDATE alerts SET status = ?, acceptedBy = ? WHERE id = ?', ['accepted', officerId, id]);
        
        console.log(`Alert ${id} accepted by officer ${officerId}`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert accepted' });
    } catch (err) {
        console.error(`Error accepting alert ${id}:`, err);
        res.status(500).json({ message: 'Server error while accepting alert.' });
    }
});

// POST to resolve an alert
app.post('/api/alerts/:id/resolve', async (req, res) => {
    const { id } = req.params;
    
    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });
        
        if (alert.status !== 'accepted') {
            return res.status(409).json({ message: 'Alert must be accepted to be resolved.' });
        }
        
        await db.run('UPDATE alerts SET status = ? WHERE id = ?', ['resolved', id]);

        console.log(`Alert ${id} resolved.`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert resolved' });
    } catch (err) {
        console.error(`Error resolving alert ${id}:`, err);
        res.status(500).json({ message: 'Server error while resolving alert.' });
    }
});

// POST to cancel an alert
app.post('/api/alerts/:id/cancel', async (req, res) => {
    const { id } = req.params;
    
    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [id]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });
        
        if (alert.status !== 'new' && alert.status !== 'accepted') {
            return res.status(409).json({ message: `Alert could not be canceled (it might already be resolved).` });
        }
        
        await db.run('UPDATE alerts SET status = ? WHERE id = ?', ['canceled', id]);

        console.log(`Alert ${id} canceled by citizen.`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert canceled' });
    } catch (err) {
        console.error(`Error canceling alert ${id}:`, err);
        res.status(500).json({ message: 'Server error while canceling alert.' });
    }
});

// DELETE a single alert
app.delete('/api/alerts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.run('DELETE FROM alerts WHERE id = ?', [id]);
        if (result.changes === 0) {
            return res.status(404).json({ message: 'Alert not found.' });
        }
        console.log(`Alert ${id} deleted.`);
        broadcastAlerts();
        res.status(204).send();
    } catch (err) {
        console.error(`Error deleting alert ${id}:`, err);
        res.status(500).json({ message: 'Server error while deleting alert.' });
    }
});

// --- Server Startup ---
setupDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Server with WebSocket is running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
