
const { Expo } = require('expo-server-sdk');
const fetch = require('node-fetch');
const { connect: connectMessageQueue, subscribe } = require('../../shared/message-queue');

const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL || 'http://database-service:3008';
const expo = new Expo();

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
 * The Notifications Service is a "headless" service. It has no HTTP API.
 * Its sole purpose is to listen for messages from the queue and send push notifications.
 */
const NotificationsService = {
    async initialize() {
        console.log("Initializing Notifications Service...");
        await connectMessageQueue();

        // Subscribe to events that should trigger a push notification.
        subscribe('alert.created', this.handleAlertCreated);

        console.log('Notifications Service Initialized and subscribed to message queue.');
    },

    async handleAlertCreated(msg) {
        try {
            const { targetedOfficers, alert } = JSON.parse(msg.content.toString());

            if (!targetedOfficers || targetedOfficers.length === 0) {
                console.log(`[Notifications] No officers targeted for alert #${alert.id}. No notifications sent.`);
                return;
            }

            // 1. Get the push tokens for the targeted officers from the database service.
            const officers = await dbService.request('/police/by-badges', {
                method: 'POST',
                body: JSON.stringify({ badgeNumbers: targetedOfficers })
            });

            const pushTokens = officers
                .map(o => o.pushToken)
                .filter(token => token && Expo.isExpoPushToken(token));

            if (pushTokens.length === 0) {
                console.log(`[Notifications] No valid push tokens found for targeted officers of alert #${alert.id}.`);
                return;
            }

            // 2. Construct the notification messages.
            const messages = pushTokens.map(pushToken => ({
                to: pushToken,
                sound: 'default',
                title: '🚨 New Emergency Alert!',
                body: alert.message || 'A new voice alert has been received in your area.',
                data: { alertId: alert.id }, // Can be used to deep-link into the app
            }));

            // 3. Send the notifications.
            const chunks = expo.chunkPushNotifications(messages);
            for (const chunk of chunks) {
                await expo.sendPushNotificationsAsync(chunk);
            }

            console.log(`[Notifications] Sent ${pushTokens.length} push notifications for alert #${alert.id}.`);

        } catch (error) {
            console.error('[Notifications] Error handling alert.created event:', error);
        }
    }
};

NotificationsService.initialize();
