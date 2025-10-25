const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

// This module exports a singleton database connection, used exclusively by the Database Service.
let db;

/**
 * Initializes the database connection, creates tables if they don't exist,
 * and performs necessary schema migrations.
 * @returns {Promise<Database>} A promise that resolves with the database instance.
 */
async function setupDatabase() {
    // If the database is already initialized, return the existing instance.
    if (db) return db;

    // The database file will live in the root `server` directory.
    // __dirname is `services/database-service`, so we go up two levels.
    const dbPath = path.join(__dirname, '..', '..', 'database.db');

    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // --- Step 1: Schema Definition ---
    // Create tables with the latest schema if they don't exist.
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
            targetedOfficers TEXT,
            geohash TEXT
        );
    `);

    // --- Step 2: Schema Migrations ---
    // Run ALTER TABLE statements to add any missing columns to existing tables.
    // This ensures backward compatibility with older database files.
    const alertsInfo = await db.all("PRAGMA table_info(alerts)");
    const alertsColumnNames = alertsInfo.map(col => col.name);

    if (!alertsColumnNames.includes('locationLat')) await db.exec('ALTER TABLE alerts ADD COLUMN locationLat REAL');
    if (!alertsColumnNames.includes('locationLng')) await db.exec('ALTER TABLE alerts ADD COLUMN locationLng REAL');
    if (!alertsColumnNames.includes('searchRadius')) await db.exec('ALTER TABLE alerts ADD COLUMN searchRadius INTEGER');
    if (!alertsColumnNames.includes('timeoutTimestamp')) await db.exec('ALTER TABLE alerts ADD COLUMN timeoutTimestamp INTEGER');
    if (!alertsColumnNames.includes('targetedOfficers')) await db.exec('ALTER TABLE alerts ADD COLUMN targetedOfficers TEXT');
    if (!alertsColumnNames.includes('category')) await db.exec('ALTER TABLE alerts ADD COLUMN category TEXT');
    if (!alertsColumnNames.includes('geohash')) await db.exec('ALTER TABLE alerts ADD COLUMN geohash TEXT');


    const policeInfo = await db.all("PRAGMA table_info(police)");
    const policeColumnNames = policeInfo.map(col => col.name);
    if (!policeColumnNames.includes('pushToken')) await db.exec('ALTER TABLE police ADD COLUMN pushToken TEXT');
    if (!policeColumnNames.includes('locationLat')) await db.exec('ALTER TABLE police ADD COLUMN locationLat REAL');
    if (!policeColumnNames.includes('locationLng')) await db.exec('ALTER TABLE police ADD COLUMN locationLng REAL');
    if (!policeColumnNames.includes('department')) await db.exec("ALTER TABLE police ADD COLUMN department TEXT DEFAULT 'Law & Order'");

    // --- Step 3: Create Indexes ---
    // These are run last to ensure the columns they depend on have been created by the steps above.
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
        CREATE INDEX IF NOT EXISTS idx_alerts_geohash ON alerts(geohash);
    `);

    console.log(`Database connected at ${dbPath} and tables ensured.`);
    return db;
}

/**
 * A getter function to access the database instance from other modules.
 * @returns {Database} The initialized database instance.
 */
const getDb = () => db;

module.exports = { setupDatabase, getDb };