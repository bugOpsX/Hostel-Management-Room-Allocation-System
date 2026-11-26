const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'hostel.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable Foreign Keys, WAL Mode, and concurrency pragmas for production
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

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
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS penalties (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            allocation_id INTEGER REFERENCES allocations(id),
            hostel_id INTEGER REFERENCES hostels(id),
            category TEXT CHECK(category IN ('Property Damage', 'Disciplinary', 'Late Return/Curfew', 'Lost Key Replacement', 'Unauthorized Guest', 'Sanitation/Mess Fine', 'Special Amenity', 'Other')) NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            amount REAL NOT NULL,
            due_date DATE NOT NULL,
            status TEXT CHECK(status IN ('Unpaid', 'Paid', 'Waived')) DEFAULT 'Unpaid',
            imposed_by INTEGER NOT NULL REFERENCES users(id),
            waived_by INTEGER REFERENCES users(id),
            waive_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            paid_at DATETIME,
            payment_mode TEXT,
            transaction_ref TEXT
        );
    `);
} catch (e) {}

module.exports = db;
