const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'hostel.db');
const db = new Database(dbPath);

// Enable Foreign Keys and WAL Mode for high performance & integrity
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Initialize schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
db.exec(schema);

// Lightweight migration checks for Phase 2 columns if upgrading an existing db
try {
    db.exec('ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0;');
} catch (e) {}
try {
    db.exec('ALTER TABLE users ADD COLUMN locked_until DATETIME;');
} catch (e) {}
try {
    db.exec('ALTER TABLE visitors ADD COLUMN pass_code TEXT;');
} catch (e) {}
try {
    db.exec('ALTER TABLE audit_logs ADD COLUMN student_id INTEGER;');
} catch (e) {}
try {
    db.exec('ALTER TABLE audit_logs ADD COLUMN hostel_id INTEGER;');
} catch (e) {}
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
} catch (e) {}

module.exports = db;
