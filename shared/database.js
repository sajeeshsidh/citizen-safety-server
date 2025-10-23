
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// This module exports a singleton database connection.
let db;

/**
 * Initializes the database connection, creates tables if they don't exist,
 * and performs necessary schema migrations.
 * @returns {Promise<Database>} A promise that resolves with the database instance.
 */
async function setupDatabase() {
    // If the database is already initialized, return the existing instance.
    if (db) return db;

    db = await open({
        filename: './database.db',
        driver: sqlite3.Database
    });

    // --- Schema Definition and Migration ---
    // This ensures that the necessary tables and columns exist every time the server starts.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS citizens (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS police (
            badgeNumber TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            designation TEXT NOT NULL,
            phoneNumber TEXT NOT NULL,
            pushToken TEXT,
            locationLat REAL,
            locationLng REAL,
            department TEXT DEFAULT 'Law & Order'
        );
        CREATE TABLE IF NOT EXISTS firefighters (
            unitNumber TEXT PRIMARY KEY,
            pushToken TEXT,
            locationLat REAL,
            locationLng REAL,
            department TEXT DEFAULT 'Fire & Rescue'
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
            category TEXT,
            acceptedBy TEXT,
            searchRadius INTEGER,
            timeoutTimestamp INTEGER,
            targetedOfficers TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    `);

    // --- Schema Migrations for existing tables ---
    const alertsInfo = await db.all("PRAGMA table_info(alerts)");
    const alertsColumnNames = alertsInfo.map(col => col.name);

    if (!alertsColumnNames.includes('locationLat')) await db.exec('ALTER TABLE alerts ADD COLUMN locationLat REAL');
    if (!alertsColumnNames.includes('locationLng')) await db.exec('ALTER TABLE alerts ADD COLUMN locationLng REAL');
    if (!alertsColumnNames.includes('searchRadius')) await db.exec('ALTER TABLE alerts ADD COLUMN searchRadius INTEGER');
    if (!alertsColumnNames.includes('timeoutTimestamp')) await db.exec('ALTER TABLE alerts ADD COLUMN timeoutTimestamp INTEGER');
    if (!alertsColumnNames.includes('targetedOfficers')) await db.exec('ALTER TABLE alerts ADD COLUMN targetedOfficers TEXT');
    if (!alertsColumnNames.includes('category')) await db.exec('ALTER TABLE alerts ADD COLUMN category TEXT');


    const policeInfo = await db.all("PRAGMA table_info(police)");
    const policeColumnNames = policeInfo.map(col => col.name);
    if (!policeColumnNames.includes('pushToken')) await db.exec('ALTER TABLE police ADD COLUMN pushToken TEXT');
    if (!policeColumnNames.includes('locationLat')) await db.exec('ALTER TABLE police ADD COLUMN locationLat REAL');
    if (!policeColumnNames.includes('locationLng')) await db.exec('ALTER TABLE police ADD COLUMN locationLng REAL');
    if (!policeColumnNames.includes('department')) await db.exec("ALTER TABLE police ADD COLUMN department TEXT DEFAULT 'Law & Order'");


    console.log('Database connected and tables ensured.');
    return db;
}

/**
 * A getter function to access the database instance from other modules.
 * @returns {Database} The initialized database instance.
 */
const getDb = () => db;

module.exports = { setupDatabase, getDb };
