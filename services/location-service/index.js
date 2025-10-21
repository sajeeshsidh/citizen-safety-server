
const express = require('express');
const cors = require('cors');
const { getDb, setupDatabase } = require('../../shared/database');
const { connect: connectMessageQueue, publish } = require('../../shared/message-queue');

const PORT = process.env.PORT || 3004;
const SEARCH_RADIUS_KM = 5;

const app = express();
app.use(cors());
app.use(express.json());

// --- Geospatial Helper Functions ---

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
 * Finds all police officers within a predefined radius of a location.
 * @param {{ lat: number, lng: number }} location - The center point of the search.
 * @returns {Promise<string[]>} A promise that resolves with an array of officer badge numbers.
 */
async function findNearbyOfficersFunction(location) {
    const db = getDb();
    const allOfficers = await db.all('SELECT badgeNumber, locationLat, locationLng FROM police WHERE locationLat IS NOT NULL');
    const nearbyOfficerIds = [];
    for (const officer of allOfficers) {
        const distance = getHaversineDistance(
            location.lat, location.lng,
            officer.locationLat, officer.locationLng
        );
        if (distance <= SEARCH_RADIUS_KM) {
            nearbyOfficerIds.push(officer.badgeNumber);
        }
    }
    return nearbyOfficerIds;
}

const LocationService = {
    async initialize() {
        await setupDatabase();
        await connectMessageQueue();

        // Public API for clients
        app.post('/api/police/location', this.updateLocation);
        app.get('/api/police/locations', this.getLocations);

        // Internal API for service-to-service communication
        app.post('/api/internal/find-nearby', async (req, res) => {
            const { location } = req.body;
            if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
                return res.status(400).json({ message: 'A valid location object is required.' });
            }
            try {
                const officerIds = await findNearbyOfficersFunction(location);
                res.status(200).json({ officerIds });
            } catch (error) {
                console.error('Internal find-nearby error:', error);
                res.status(500).json({ message: 'Failed to query for nearby officers.' });
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
            const db = getDb();
            await db.run(
                'UPDATE police SET locationLat = ?, locationLng = ? WHERE badgeNumber = ?',
                location.lat, location.lng, badgeNumber
            );
            // Publish an event to notify other services (like WebSocket) of the update.
            publish('location.broadcast', JSON.stringify({ message: 'Locations updated' }));
            res.status(204).send();
        } catch (error) {
            console.error('Error updating location:', error);
            res.status(500).json({ message: 'Failed to update location.' });
        }
    },

    async getLocations(req, res) {
        try {
            const db = getDb();
            const officers = await db.all('SELECT badgeNumber, locationLat, locationLng FROM police WHERE locationLat IS NOT NULL');
            const locations = officers.map(o => ({
                badgeNumber: o.badgeNumber,
                location: { lat: o.locationLat, lng: o.locationLng },
            }));
            res.json(locations);
        } catch (error) {
            console.error('Error fetching locations:', error);
            res.status(500).json({ message: 'Failed to retrieve locations.' });
        }
    }
};

LocationService.initialize();
