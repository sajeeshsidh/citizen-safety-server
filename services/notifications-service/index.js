
const { Expo } = require('expo-server-sdk');
const { getDb, setupDatabase } = require('../../shared/database');
const { connect: connectMessageQueue, subscribe } = require('../../shared/message-queue');

const expo = new Expo();

/**
 * The Notifications Service is a "headless" service. It has no HTTP API.
 * Its sole purpose is to listen for messages from the queue and send push notifications.
 */
const NotificationsService = {
    async initialize() {
        console.log("Initializing Notifications Service...");
        await setupDatabase();
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

            // 1. Get the push tokens for the targeted officers from the database.
            const db = getDb();
            const placeholders = targetedOfficers.map(() => '?').join(',');
            const officers = await db.all(`SELECT pushToken FROM police WHERE badgeNumber IN (${placeholders})`, targetedOfficers);

            const pushTokens = officers
                .map(o => o.pushToken)
                .filter(token => Expo.isExpoPushToken(token));

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
