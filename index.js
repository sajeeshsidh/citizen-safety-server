const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3001;

// In-memory "database"
let citizens = [];
let police = [];
const officerLocations = {
    '728': { lat: 34.06, lng: -118.25 },
    '551': { lat: 34.045, lng: -118.26 },
    '912': { lat: 34.055, lng: -118.23 },
};
let alerts = [];
let nextAlertId = 1;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- WebSocket Logic ---
const clients = new Set();

const getSortedAlerts = () => [...alerts].sort((a, b) => b.timestamp - a.timestamp);

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

const broadcastAlerts = () => {
    broadcastData({ type: 'alerts', payload: getSortedAlerts() });
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

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Client connected. Total clients:', clients.size);

  // Send the current list of alerts and locations to the newly connected client
  ws.send(JSON.stringify({ type: 'alerts', payload: getSortedAlerts() }));
  broadcastLocations(); // Send latest locations immediately on connect

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected. Total clients:', clients.size);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});


// --- Helper Functions ---
const findCitizen = (username) => citizens.find(c => c.username === username);
const findPoliceByBadge = (badgeNumber) => police.find(p => p.badgeNumber === badgeNumber);

// --- Routes ---

app.get('/', (req, res) => {
  res.send('Citizen Safety Backend is running.');
});

// Citizen Registration
app.post('/api/citizen/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
  if (findCitizen(username)) return res.status(409).json({ message: 'Username already taken.' });
  
  const newUser = { username, password };
  citizens.push(newUser);
  console.log('New citizen registered:', newUser.username);
  res.status(201).json({ username: newUser.username });
});

// Citizen Login
app.post('/api/citizen/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
  
  const user = findCitizen(username);
  if (!user || user.password !== password) return res.status(401).json({ message: 'Invalid username or password.' });
  
  console.log('Citizen logged in:', user.username);
  res.status(200).json({ username: user.username });
});

// Police Registration
app.post('/api/police/register', (req, res) => {
    const { name, designation, badgeNumber, phoneNumber } = req.body;
    if (!name || !designation || !badgeNumber || !phoneNumber) return res.status(400).json({ message: 'All fields are required.' });
    if (findPoliceByBadge(badgeNumber)) return res.status(409).json({ message: 'Badge number already registered.' });

    const newOfficer = { name, designation, badgeNumber, phoneNumber };
    police.push(newOfficer);
    console.log('New officer registered:', newOfficer.badgeNumber);
    res.status(201).json(newOfficer);
});

// Police Login
app.post('/api/police/login', (req, res) => {
    const { badgeNumber } = req.body;
    if (!badgeNumber) return res.status(400).json({ message: 'Badge number is required.' });

    const officer = findPoliceByBadge(badgeNumber);
    if (!officer) return res.status(404).json({ message: 'Badge number not found.' });
    
    if (!officerLocations[officer.badgeNumber]) {
        officerLocations[officer.badgeNumber] = { lat: 34.0522, lng: -118.2437 };
    }
    console.log('Officer logged in:', officer.badgeNumber);
    res.status(200).json(officer);
});

// POST to update an officer's location
app.post('/api/police/location', (req, res) => {
    const { badgeNumber, location } = req.body;
    if (!badgeNumber || !location) return res.status(400).json({ message: 'Badge number and location are required.' });
    
    officerLocations[badgeNumber] = location;
    // Don't wait for the interval, broadcast the update immediately for responsiveness
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

// GET all alerts (still useful for citizens or initial load)
app.get('/api/alerts', (req, res) => {
  res.status(200).json(getSortedAlerts());
});

// POST a new alert
app.post('/api/alerts', (req, res) => {
  const { citizenId, message, audioBase64, location } = req.body;
  if (!citizenId) return res.status(400).json({ message: 'Citizen ID is required.' });

  const newAlert = {
    id: (nextAlertId++).toString(),
    citizenId,
    message,
    audioBase64,
    location,
    timestamp: Date.now(),
    status: 'new',
  };
  alerts.push(newAlert);
  console.log('New alert created:', newAlert.id);
  
  broadcastAlerts(); // Broadcast the update
  
  res.status(201).json(newAlert);
});

// POST to accept an alert
app.post('/api/alerts/:id/accept', (req, res) => {
    const { id } = req.params;
    const { officerId } = req.body;
    if (!officerId) return res.status(400).json({ message: 'Officer ID is required.' });

    const alert = alerts.find(a => a.id === id);
    if (!alert) return res.status(404).json({ message: 'Alert not found.' });
    if (alert.status !== 'new') return res.status(409).json({ message: 'Alert has already been accepted.' });

    alert.status = 'accepted';
    alert.acceptedBy = officerId;
    console.log(`Alert ${id} accepted by officer ${officerId}`);

    broadcastAlerts(); // Broadcast the update

    res.status(200).json(alert);
});

// POST to resolve an alert
app.post('/api/alerts/:id/resolve', (req, res) => {
    const { id } = req.params;
    const alert = alerts.find(a => a.id === id);
    if (!alert) return res.status(404).json({ message: 'Alert not found.' });
    if (alert.status !== 'accepted') return res.status(409).json({ message: 'Alert must be accepted to be resolved.' });

    alert.status = 'resolved';
    console.log(`Alert ${id} resolved.`);

    broadcastAlerts(); // Broadcast the update

    res.status(200).json(alert);
});

// POST to cancel an alert
app.post('/api/alerts/:id/cancel', (req, res) => {
    const { id } = req.params;
    const alert = alerts.find(a => a.id === id);
    if (!alert) return res.status(404).json({ message: 'Alert not found.' });
    if (alert.status === 'resolved' || alert.status === 'canceled') {
        return res.status(409).json({ message: `Alert has already been ${alert.status}.` });
    }

    alert.status = 'canceled';
    console.log(`Alert ${id} canceled by citizen.`);

    broadcastAlerts(); // Broadcast the update

    res.status(200).json(alert);
});

// DELETE a single alert
app.delete('/api/alerts/:id', (req, res) => {
    const { id } = req.params;
    const alertIndex = alerts.findIndex(a => a.id === id);
    if (alertIndex === -1) {
        return res.status(404).json({ message: 'Alert not found.' });
    }

    alerts.splice(alertIndex, 1);
    console.log(`Alert ${id} deleted.`);

    broadcastAlerts(); // Broadcast the update
    res.status(204).send(); // No Content
});

// DELETE multiple alerts based on scope
app.delete('/api/alerts', (req, res) => {
    const { scope, citizenId } = req.query;

    if (scope === 'resolved') {
        const originalLength = alerts.length;
        alerts = alerts.filter(a => a.status !== 'resolved');
        const numDeleted = originalLength - alerts.length;
        console.log(`Cleared ${numDeleted} resolved alerts.`);
    } else if (citizenId) {
        const originalLength = alerts.length;
        alerts = alerts.filter(a => a.citizenId !== citizenId);
        const numDeleted = originalLength - alerts.length;
        console.log(`Cleared ${numDeleted} alerts for citizen ${citizenId}.`);
    } else {
        return res.status(400).json({ message: 'A valid scope (resolved) or citizenId is required.' });
    }

    broadcastAlerts();
    res.status(204).send();
});

server.listen(PORT, () => {
  console.log(`Server with WebSocket is running on http://localhost:${PORT}`);
});