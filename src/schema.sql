-- HMRAS Database Schema (SQLite with foreign keys enabled)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'warden', 'student')) NOT NULL,
    status TEXT CHECK(status IN ('pending', 'active', 'inactive')) DEFAULT 'active',
    failed_attempts INTEGER DEFAULT 0,
    locked_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enrollment_no TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    gender TEXT CHECK(gender IN ('Male', 'Female')) NOT NULL,
    department TEXT NOT NULL,
    year_of_study INTEGER NOT NULL,
    mobile TEXT NOT NULL,
    guardian_contact TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hostels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT CHECK(type IN ('Boys', 'Girls')) NOT NULL,
    floors INTEGER NOT NULL DEFAULT 3,
    warden_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostel_id INTEGER NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
    room_no TEXT NOT NULL,
    floor INTEGER NOT NULL,
    room_type TEXT CHECK(room_type IN ('Single', 'Double', 'Triple', 'Quad')) NOT NULL,
    capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 6),
    UNIQUE(hostel_id, room_no)
);

CREATE TABLE IF NOT EXISTS beds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    bed_no TEXT NOT NULL,
    status TEXT CHECK(status IN ('Vacant', 'Occupied', 'Maintenance')) DEFAULT 'Vacant',
    UNIQUE(room_id, bed_no)
);

CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    bed_id INTEGER NOT NULL REFERENCES beds(id),
    start_date DATE NOT NULL DEFAULT (DATE('now')),
    end_date DATE,
    status TEXT CHECK(status IN ('Active', 'Closed')) DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS room_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    allocation_id INTEGER NOT NULL REFERENCES allocations(id),
    request_type TEXT CHECK(request_type IN ('Transfer', 'Vacate')) NOT NULL,
    reason TEXT NOT NULL,
    preferred_hostel_id INTEGER REFERENCES hostels(id),
    target_bed_id INTEGER REFERENCES beds(id),
    warden_recommendation TEXT CHECK(warden_recommendation IN ('Recommend', 'Not Recommend')),
    warden_remarks TEXT,
    status TEXT CHECK(status IN ('Pending', 'Approved', 'Rejected')) DEFAULT 'Pending',
    admin_remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    allocation_id INTEGER NOT NULL REFERENCES allocations(id),
    term TEXT NOT NULL,
    amount REAL NOT NULL,
    due_date DATE NOT NULL,
    status TEXT CHECK(status IN ('Unpaid', 'Paid', 'Overdue')) DEFAULT 'Unpaid'
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fee_id INTEGER NOT NULL REFERENCES fees(id),
    amount REAL NOT NULL,
    mode TEXT CHECK(mode IN ('Online', 'Cash', 'Bank Transfer')) NOT NULL,
    transaction_ref TEXT UNIQUE NOT NULL,
    paid_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    hostel_id INTEGER NOT NULL REFERENCES hostels(id),
    category TEXT CHECK(category IN ('Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Security', 'Other')) NOT NULL,
    description TEXT NOT NULL,
    priority TEXT CHECK(priority IN ('Low', 'Medium', 'High')) DEFAULT 'Medium',
    status TEXT CHECK(status IN ('Open', 'In Progress', 'Resolved')) DEFAULT 'Open',
    assigned_to TEXT,
    remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    hostel_id INTEGER REFERENCES hostels(id), -- NULL = all hostels
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostel_id INTEGER NOT NULL REFERENCES hostels(id),
    visitor_name TEXT NOT NULL,
    relation TEXT NOT NULL,
    id_proof TEXT NOT NULL,
    student_id INTEGER NOT NULL REFERENCES students(id),
    purpose TEXT NOT NULL,
    pass_code TEXT,
    in_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    out_time DATETIME,
    recorded_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    preferred_hostel_id INTEGER REFERENCES hostels(id),
    priority_order INTEGER NOT NULL,
    status TEXT CHECK(status IN ('Waiting', 'Offered', 'Allocated', 'Cancelled')) DEFAULT 'Waiting',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_email TEXT,
    action TEXT NOT NULL,
    details TEXT,
    student_id INTEGER REFERENCES students(id),
    hostel_id INTEGER REFERENCES hostels(id),
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 14. Password Resets (FR-06: 30-minute time-limited tokens)
CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
