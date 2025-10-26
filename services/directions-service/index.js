
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const polyline = require('@mapbox/polyline');

const PORT = process.env.PORT || 3005;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_API_TIMEOUT_MS = 10000; // 10 seconds

const app = express();
app.use(cors());

if (!GOOGLE_MAPS_API_KEY) {
    console.warn("WARNING: GOOGLE_MAPS_API_KEY environment variable is not set. The Directions Service will not work.");
}

app.get('/route', async (req, res) => {
    const { origin, destination } = req.query;
    if (!origin || !destination) {
        return res.status(400).json({ message: 'Origin and destination are required.' });
    }
    if (!GOOGLE_MAPS_API_KEY) {
        return res.status(500).json({ message: 'Directions service is not configured.' });
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&key=${GOOGLE_MAPS_API_KEY}`;

    try {
        const response = await fetch(url, { timeout: GOOGLE_API_TIMEOUT_MS });
        const data = await response.json();

        if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
            console.error('Google Maps API Error:', data.error_message || data.status);
            return res.status(500).json({ message: 'Failed to fetch route from Google Maps API.' });
        }

        const encodedPolyline = data.routes[0].overview_polyline.points;
        const decodedRoute = polyline.decode(encodedPolyline).map(p => ({ lat: p[0], lng: p[1] }));

        res.json(decodedRoute);
    } catch (error) {
        console.error('Error fetching directions:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.listen(PORT, () => console.log(`Directions Service listening on port ${PORT}`));
