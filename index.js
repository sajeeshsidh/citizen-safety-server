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

/**
 * Calculates the distance between two lat/lng coordinates in kilometers.
 * @param {{lat: number, lng: number}} coords1 - The first coordinate.
 * @param {{lat: number, lng: number}} coords2 - The second coordinate.
 * @returns {number} The distance in kilometers.
 */
function haversineDistance(coords1, coords2) {
    function toRad(x) {
        return x * Math.PI / 180;
    }

    const lat1 = coords1.lat;
    const lon1 = coords1.lng;
    const lat2 = coords2.lat;
    const lon2 = coords2.lng;

    const R = 6371; // Earth's radius in km

    const x1 = lat2 - lat1;
    const dLat = toRad(x1);
    const x2 = lon2 - lon1;
    const dLon = toRad(x2);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c;
}


async function setupDatabase() {
    db = await open({
        filename: './database.db',
        driver: sqlite3.Database
    });

    // The CREATE TABLE statement is kept with all columns for new database setups.
    // The migration logic below will handle existing databases.
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
            acceptedBy TEXT,
            searchRadius INTEGER,
            timeoutTimestamp INTEGER,
            targetedOfficers TEXT
        );
    `);

    // --- Simple Migration: Add missing columns if they don't exist ---
    // This makes the app resilient to schema changes on existing databases.
    const alertsInfo = await db.all("PRAGMA table_info(alerts)");
    const columnNames = alertsInfo.map(col => col.name);

    if (!columnNames.includes('locationLat')) {
        console.log('Migrating database: Adding locationLat column to alerts table.');
        await db.exec('ALTER TABLE alerts ADD COLUMN locationLat REAL');
    }
    if (!columnNames.includes('locationLng')) {
        console.log('Migrating database: Adding locationLng column to alerts table.');
        await db.exec('ALTER TABLE alerts ADD COLUMN locationLng REAL');
    }
    if (!columnNames.includes('searchRadius')) {
        console.log('Migrating database: Adding searchRadius column to alerts table.');
        await db.exec('ALTER TABLE alerts ADD COLUMN searchRadius INTEGER');
    }
    if (!columnNames.includes('timeoutTimestamp')) {
        console.log('Migrating database: Adding timeoutTimestamp column to alerts table.');
        await db.exec('ALTER TABLE alerts ADD COLUMN timeoutTimestamp INTEGER');
    }
    if (!columnNames.includes('targetedOfficers')) {
        console.log('Migrating database: Adding targetedOfficers column to alerts table.');
        await db.exec('ALTER TABLE alerts ADD COLUMN targetedOfficers TEXT');
    }

    console.log('Database connected and tables ensured.');
}


// In-memory store for real-time, non-persistent data
const officerLocations = {
    '728': { lat: 34.06, lng: -118.25 },
    '551': { lat: 34.045, lng: -118.26 },
    '912': { lat: 34.055, lng: -118.23 },
};
const alertTimers = new Map();


app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- WebSocket Logic ---
const clients = new Set();
const clientMetadata = new Map(); // Stores metadata for each client (e.g., role, badgeNumber)

const formatAlerts = (alerts) => {
    return alerts.map(alert => {
        const { locationLat, locationLng, targetedOfficers, ...rest } = alert;
        const newAlert = { ...rest };
        if (locationLat != null && locationLng != null) {
            newAlert.location = { lat: locationLat, lng: locationLng };
        }
        try {
            // Safely parse the targetedOfficers JSON string
            newAlert.targetedOfficers = targetedOfficers ? JSON.parse(targetedOfficers) : [];
        } catch (e) {
            console.error(`Error parsing targetedOfficers for alert ${alert.id}:`, e);
            newAlert.targetedOfficers = [];
        }
        return newAlert;
    });
};

const broadcastAlerts = async () => {
    try {
        const allAlerts = await db.all('SELECT * FROM alerts ORDER BY timestamp DESC');
        const formattedAlerts = formatAlerts(allAlerts);

        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                const metadata = clientMetadata.get(client);
                if (!metadata) {
                    return; // Skip unauthenticated clients
                }

                let alertsToSend = [];
                if (metadata.role === 'police') {
                    const badgeNumber = metadata.mobile;
                    
                    alertsToSend = formattedAlerts.filter(alert => 
                        // Active alerts: new ones targeted to them, or ones they've accepted
                        (alert.status === 'new' && alert.targetedOfficers?.includes(badgeNumber)) ||
                        (alert.status === 'accepted' && alert.acceptedBy === badgeNumber) ||
                        // Historical alerts are visible to all officers
                        ['resolved', 'canceled', 'timed_out'].includes(alert.status)
                    );
                } else if (metadata.role === 'citizen') {
                    // For citizens, send all alerts. The frontend will filter.
                    // This ensures they get updates on their own alerts.
                    alertsToSend = formattedAlerts;
                }
                
                // Always send the current list of relevant alerts.
                // An empty list is valid data (e.g., for police with no assigned alerts).
                client.send(JSON.stringify({ type: 'alerts', payload: alertsToSend }), (err) => {
                    if (err) {
                        console.error('WebSocket send error:', err);
                        clients.delete(client);
                        clientMetadata.delete(client);
                    }
                });
            }
        });
    } catch (error) {
        console.error("Failed to fetch and broadcast alerts:", error);
    }
};

const broadcastLocations = () => {
    const locationsArray = Object.entries(officerLocations).map(([badgeNumber, location]) => ({
        badgeNumber,
        location,
    }));
     const dataString = JSON.stringify({ type: 'locations', payload: locationsArray });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(dataString);
        }
    });
};

// Periodically broadcast locations to all clients
setInterval(broadcastLocations, 2000);

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Client connected. Total clients:', clients.size);

  // Send initial location data to the new client
  broadcastLocations();

  ws.on('message', async (message) => {
      try {
          const parsedMessage = JSON.parse(message);
          if (parsedMessage.type === 'auth' && parsedMessage.payload) {
              console.log(`Authenticating client for user:`, parsedMessage.payload);
              clientMetadata.set(ws, parsedMessage.payload);
              // The initial alert list is now fetched via HTTP on the client-side
              // to prevent race conditions. The WebSocket is only for real-time updates.
          }
      } catch (e) {
          console.error('Failed to process message:', e);
      }
  });

  ws.on('close', () => {
    clients.delete(ws);
    clientMetadata.delete(ws); // Clean up metadata
    console.log('Client disconnected. Total clients:', clients.size);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
    clientMetadata.delete(ws);
  });
});

const clearAlertTimers = (alertId) => {
    const timers = alertTimers.get(alertId);
    if (timers) {
        clearTimeout(timers.escalationTimer);
        clearTimeout(timers.timeoutTimer);
        alertTimers.delete(alertId);
        console.log(`Cleared timers for alert ${alertId}`);
    }
};

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
      const timestamp = Date.now();
      const TIMEOUT_DURATION = 60 * 1000;
      const timeoutTimestamp = timestamp + TIMEOUT_DURATION;
      const TIMEOUT_ESCALATE = 30 * 1000;
      
      // Perform initial 5km search for officers
      let targetedOfficers = [];
      if (location) {
          targetedOfficers = Object.entries(officerLocations)
              .filter(([badgeNumber, officerLocation]) => {
                  const distance = haversineDistance(location, officerLocation);
                  return distance <= 5; // Initial 5km radius
              })
              .map(([badgeNumber]) => badgeNumber);
      }
      console.log(`Alert created. Targeting ${targetedOfficers.length} officers within 5km.`);

      const result = await db.run(
          'INSERT INTO alerts (citizenId, message, audioBase64, locationLat, locationLng, timestamp, status, searchRadius, timeoutTimestamp, targetedOfficers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [citizenId, message || null, audioBase64 || null, location?.lat || null, location?.lng || null, timestamp, 'new', 5, timeoutTimestamp, JSON.stringify(targetedOfficers)]
      );
      
      const newAlertId = result.lastID;
      const newAlert = {
          id: newAlertId,
          citizenId,
          message,
          audioBase64,
          location,
          timestamp,
          status: 'new',
          searchRadius: 5,
          timeoutTimestamp: timeoutTimestamp,
          targetedOfficers: targetedOfficers,
      };

      // Set timers for escalation and timeout
      const escalationTimer = setTimeout(async () => {
        const currentAlert = await db.get('SELECT status, locationLat, locationLng FROM alerts WHERE id = ?', [newAlertId]);
        if (currentAlert && currentAlert.status === 'new') {
            console.log(`Escalating search for alert ${newAlertId}`);
            
            let escalatedTargetedOfficers = [];
            if (currentAlert.locationLat && currentAlert.locationLng) {
                const alertLocation = { lat: currentAlert.locationLat, lng: currentAlert.locationLng };
                escalatedTargetedOfficers = Object.entries(officerLocations)
                    .filter(([badgeNumber, officerLocation]) => {
                        const distance = haversineDistance(alertLocation, officerLocation);
                        return distance <= 10; // New 10km radius
                    })
                    .map(([badgeNumber]) => badgeNumber);
            }
            console.log(`Escalated search targeting ${escalatedTargetedOfficers.length} officers within 10km.`);

            await db.run('UPDATE alerts SET searchRadius = ?, targetedOfficers = ? WHERE id = ?', [10, JSON.stringify(escalatedTargetedOfficers), newAlertId]);
            broadcastAlerts();
        }
      }, TIMEOUT_ESCALATE);

      const timeoutTimer = setTimeout(async () => {
        const currentAlert = await db.get('SELECT status FROM alerts WHERE id = ?', [newAlertId]);
        if (currentAlert && currentAlert.status === 'new') {
            console.log(`Timing out alert ${newAlertId}`);
            await db.run('UPDATE alerts SET status = ? WHERE id = ?', ['timed_out', newAlertId]);
            broadcastAlerts();
        }
        alertTimers.delete(newAlertId);
      }, TIMEOUT_DURATION);

      alertTimers.set(newAlertId, { escalationTimer, timeoutTimer });

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
    const alertId = parseInt(req.params.id, 10);
    const { officerId } = req.body;
    if (!officerId) return res.status(400).json({ message: 'Officer ID is required.' });

    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [alertId]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });

        if (alert.status !== 'new') {
            return res.status(409).json({ message: 'Alert has already been accepted or does not exist.' });
        }
        
        await db.run('UPDATE alerts SET status = ?, acceptedBy = ? WHERE id = ?', ['accepted', officerId, alertId]);
        clearAlertTimers(alertId);
        
        console.log(`Alert ${alertId} accepted by officer ${officerId}`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert accepted' });
    } catch (err) {
        console.error(`Error accepting alert ${alertId}:`, err);
        res.status(500).json({ message: 'Server error while accepting alert.' });
    }
});

// POST to resolve an alert
app.post('/api/alerts/:id/resolve', async (req, res) => {
    const alertId = parseInt(req.params.id, 10);
    
    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [alertId]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });
        
        if (alert.status !== 'accepted') {
            return res.status(409).json({ message: 'Alert must be accepted to be resolved.' });
        }
        
        await db.run('UPDATE alerts SET status = ? WHERE id = ?', ['resolved', alertId]);

        console.log(`Alert ${alertId} resolved.`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert resolved' });
    } catch (err) {
        console.error(`Error resolving alert ${alertId}:`, err);
        res.status(500).json({ message: 'Server error while resolving alert.' });
    }
});

// POST to cancel an alert
app.post('/api/alerts/:id/cancel', async (req, res) => {
    const alertId = parseInt(req.params.id, 10);
    
    try {
        const alert = await db.get('SELECT * FROM alerts WHERE id = ?', [alertId]);
        if (!alert) return res.status(404).json({ message: 'Alert not found.' });
        
        if (alert.status !== 'new' && alert.status !== 'accepted') {
            return res.status(409).json({ message: `Alert could not be canceled (it might already be resolved).` });
        }
        
        await db.run('UPDATE alerts SET status = ? WHERE id = ?', ['canceled', alertId]);
        clearAlertTimers(alertId);

        console.log(`Alert ${alertId} canceled by citizen.`);
        broadcastAlerts();
        res.status(200).json({ message: 'Alert canceled' });
    } catch (err) {
        console.error(`Error canceling alert ${alertId}:`, err);
        res.status(500).json({ message: 'Server error while canceling alert.' });
    }
});

// DELETE a single alert
app.delete('/api/alerts/:id', async (req, res) => {
    const alertId = parseInt(req.params.id, 10);
    try {
        const result = await db.run('DELETE FROM alerts WHERE id = ?', [alertId]);
        if (result.changes === 0) {
            return res.status(404).json({ message: 'Alert not found.' });
        }
        clearAlertTimers(alertId);
        console.log(`Alert ${alertId} deleted.`);
        broadcastAlerts();
        res.status(204).send();
    } catch (err) {
        console.error(`Error deleting alert ${alertId}:`, err);
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