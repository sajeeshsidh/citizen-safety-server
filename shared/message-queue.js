const amqp = require('amqplib');

// Connection URL for the RabbitMQ server.
//
// IMPORTANT: Replace this placeholder with the actual "AMQP URL"
// from your CloudAMQP instance dashboard.
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqps://user:password@hostname.rmq.cloudamqp.com/vhost';
const EXCHANGE_NAME = 'services_exchange';
const EXCHANGE_TYPE = 'topic';

let connection = null;
let channel = null;

/**
 * Connects to the RabbitMQ server.
 * During initial startup, it will throw an error on failure to stop the deploy.
 * If the connection is lost later, it will attempt to reconnect automatically.
 */
async function connect() {
    // Prevent re-running if already connected.
    if (channel) return;

    try {
        console.log(`Connecting to RabbitMQ at ${new URL(RABBITMQ_URL).hostname}...`);
        connection = await amqp.connect(RABBITMQ_URL);
        channel = await connection.createChannel();

        await channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: false });
        console.log('RabbitMQ connected and exchange asserted.');

        // Set up listeners for connection errors or closure to handle automatic reconnection.
        connection.on('error', (err) => {
            console.error('RabbitMQ connection error:', err.message);
        });

        connection.on('close', () => {
            console.error('RabbitMQ connection closed. Attempting to reconnect...');
            // Reset state and retry connection after a delay.
            channel = null;
            connection = null;
            setTimeout(connect, 5000); // Simple retry logic
        });

    } catch (err) {
        console.error('Failed to connect to RabbitMQ during startup:', err.message);
        // Re-throw the error to ensure the application startup fails, which is the correct
        // behavior for a failed deployment.
        throw err;
    }
}

/**
 * Publishes a message to the exchange with a specific routing key.
 * @param {string} routingKey - The key to route the message (e.g., 'alert.created').
 * @param {string} message - The message payload, typically a JSON string.
 */
function publish(routingKey, message) {
    if (!channel) {
        console.error('Cannot publish. RabbitMQ channel is not available.');
        return;
    }
    channel.publish(EXCHANGE_NAME, routingKey, Buffer.from(message));
    console.log(`[MQ] > Sent ${routingKey}`);
}

/**
 * Subscribes a callback to a specific routing key.
 * @param {string} routingKey - The routing key to listen for (e.g., 'alert.*').
 * @param {Function} callback - The function to execute with the message content.
 */
async function subscribe(routingKey, callback) {
    if (!channel) {
        // This is now a critical failure because connect() should have been awaited successfully.
        console.error(`[MQ] FATAL: Cannot subscribe to ${routingKey}. Channel is not available. Check startup order.`);
        return;
    }

    // Create an anonymous, exclusive queue that will be deleted when the connection closes.
    const q = await channel.assertQueue('', { exclusive: true });

    // Bind the queue to the exchange with the specified routing key.
    console.log(`[MQ] Binding queue to exchange with key: ${routingKey}`);
    channel.bindQueue(q.queue, EXCHANGE_NAME, routingKey);

    // Start consuming messages from the queue.
    channel.consume(q.queue, (msg) => {
        if (msg.content) {
            console.log(`[MQ] < Received ${msg.fields.routingKey}`);
            callback(msg);
        }
    }, { noAck: true }); // noAck: true means messages are removed from the queue as soon as they are delivered.
}

module.exports = {
    connect,
    publish,
    subscribe,
};
