const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { connect: connectMessageQueue, publish } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3004;
const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL || 'http://database-service:3008';
const SEARCH_RADIUS_KM = 5;

const app = express();
app.use(cors());
app.use(express.json());

const dbService = {
    async request(path, options = {}) {
        const response = await fetch(`${DATABASE_SERVICE_URL}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        if (response.status === 204) return null;
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || `Database service error: ${response.status}`);
        return data;
    },
};

/**
 * Calculates the distance between two lat/lng points in kilometers.
 */
function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Finds all responders of a specific category within a radius of a location.
 */
async function findNearbyResponders(location, category) {
    let responders = [];

    // Fetch responders data from the database service
    if (category === 'Law & Order') {
        responders = await dbService.request('/police');
    } else if (category === 'Fire & Rescue') {
        responders = await dbService.request('/firefighters');
    } else {
        responders = await dbService.request('/police');
    }

    const nearbyResponderIds = [];
    for (const responder of responders) {
        const distance = getHaversineDistance(
            location.lat, location.lng,
            responder.locationLat, responder.locationLng
        );
        if (distance <= SEARCH_RADIUS_KM) {
            // Use the correct primary key for each responder type
            nearbyResponderIds.push(responder.badgeNumber || responder.unitNumber);
        }
    }
    return nearbyResponderIds;
}

const LocationService = {
    async initialize() {
        await connectMessageQueue();

        // Public API for clients
        app.post('/police/location', this.updateLocation);
        app.get('/police/locations', this.getLocations);
        app.post('/firefighter/location', this.updateFirefighterLocation);

        // Internal API for service-to-service communication
        app.post('/find-nearby', async (req, res) => {
            const { location, category } = req.body;
            if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
                return res.status(400).json({ message: 'A valid location object is required.' });
            }
            try {
                const responderIds = await findNearbyResponders(location, category || 'Law & Order');
                res.status(200).json({ responderIds });
            } catch (error) {
                console.error('Internal find-nearby error:', error);
                res.status(500).json({ message: 'Failed to query for nearby responders.' });
            }
        });

        app.listen(PORT, () => console.log(`Location Service listening on port ${PORT}`));
    },

    async updateLocation(req, res) {
        const { badgeNumber, location } = req.body;
        if (!badgeNumber || !location) {
            return res.status(400).json({ message: 'Badge number and location are required.' });
        }
        try {
            await dbService.request(`/police/${badgeNumber}/location`, { method: 'PUT', body: JSON.stringify({ location }) });
            publish('location.broadcast', JSON.stringify({ message: 'Locations updated' }));
            res.status(204).send();
        } catch (error) {
            console.error('Error updating location:', error);
            res.status(500).json({ message: 'Failed to update location.' });
        }
    },

    async getLocations(req, res) {
        try {
            const officers = await dbService.request('/police');
            const locations = officers.map(o => ({
                badgeNumber: o.badgeNumber,
                location: { lat: o.locationLat, lng: o.locationLng },
            }));
            res.json(locations);
        } catch (error) {
            console.error('Error fetching locations:', error);
            res.status(500).json({ message: 'Failed to retrieve locations.' });
        }
    },

    async updateFirefighterLocation(req, res) {
        const { unitNumber, location } = req.body;
        if (!unitNumber || !location) {
            return res.status(400).json({ message: 'Unit number and location are required.' });
        }
        try {
            await dbService.request(`/firefighters/${unitNumber}/location`, { method: 'PUT', body: JSON.stringify({ location }) });
            publish('location.broadcast', JSON.stringify({ message: 'Locations updated' }));
            res.status(204).send();
        } catch (error) {
            console.error('Error updating firefighter location:', error);
            res.status(500).json({ message: 'Failed to update location.' });
        }
    }
};

LocationService.initialize();
