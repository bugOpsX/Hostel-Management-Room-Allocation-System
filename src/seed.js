const bcrypt = require('bcryptjs');
const db = require('./db');

async function seed() {
    console.log('Seeding HMRAS database...');

    // Clear existing tables in reverse dependency order
    const tables = [
        'audit_logs', 'password_resets', 'penalties', 'waitlist', 'visitors', 'notices', 'complaints', 'payments', 'fees',
        'room_requests', 'allocations', 'beds', 'rooms', 'hostels',
        'students', 'users'
    ];
    for (const t of tables) {
        db.prepare(`DELETE FROM ${t}`).run();
    }

    const salt = bcrypt.genSaltSync(10);
    const adminPass = bcrypt.hashSync('admin123', salt);
    const wardenPass = bcrypt.hashSync('warden123', salt);
    const studentPass = bcrypt.hashSync('student123', salt);

    // 1. Users
    const insertUser = db.prepare(`
        INSERT INTO users (email, password_hash, role, status)
        VALUES (?, ?, ?, ?)
    `);

    const admin = insertUser.run('admin@hostel.com', adminPass, 'admin', 'active');
    const wardenBoys = insertUser.run('warden.boys@hostel.com', wardenPass, 'warden', 'active');
    const wardenGirls = insertUser.run('warden.girls@hostel.com', wardenPass, 'warden', 'active');

    // 2. Hostels
    const insertHostel = db.prepare(`
        INSERT INTO hostels (name, type, floors, warden_id)
        VALUES (?, ?, ?, ?)
    `);

    const hostelBoys = insertHostel.run('Tagore Boys Hostel', 'Boys', 3, wardenBoys.lastInsertRowid);
    const hostelGirls = insertHostel.run('Sarojini Girls Hostel', 'Girls', 3, wardenGirls.lastInsertRowid);

    // 3. Rooms & Beds Generator Helper
    const insertRoom = db.prepare(`
        INSERT INTO rooms (hostel_id, room_no, floor, room_type, capacity)
        VALUES (?, ?, ?, ?, ?)
    `);
    const insertBed = db.prepare(`
        INSERT INTO beds (room_id, bed_no, status)
        VALUES (?, ?, ?)
    `);

    function createRoomsForHostel(hostelId) {
        const roomConfigs = [
            { no: '101', floor: 1, type: 'Double', cap: 2 },
            { no: '102', floor: 1, type: 'Single', cap: 1 },
            { no: '103', floor: 1, type: 'Triple', cap: 3 },
            { no: '201', floor: 2, type: 'Double', cap: 2 },
            { no: '202', floor: 2, type: 'Double', cap: 2 },
            { no: '301', floor: 3, type: 'Single', cap: 1 }
        ];

        const bedIds = {};
        for (const rc of roomConfigs) {
            const roomRes = insertRoom.run(hostelId, rc.no, rc.floor, rc.type, rc.cap);
            const roomId = roomRes.lastInsertRowid;
            const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
            for (let i = 0; i < rc.cap; i++) {
                const bedNo = `${rc.no}-${letters[i]}`;
                const bedRes = insertBed.run(roomId, bedNo, 'Vacant');
                bedIds[bedNo] = bedRes.lastInsertRowid;
            }
        }
        return bedIds;
    }

    const boysBeds = createRoomsForHostel(hostelBoys.lastInsertRowid);
    const girlsBeds = createRoomsForHostel(hostelGirls.lastInsertRowid);

    // 4. Students
    const insertStudentUser = (email, pass, status, name, roll, gender, dept, year, mobile, guardian) => {
        const u = insertUser.run(email, pass, 'student', status);
        const s = db.prepare(`
            INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(u.lastInsertRowid, roll, name, gender, dept, year, mobile, guardian);
        return { userId: u.lastInsertRowid, studentId: s.lastInsertRowid };
    };

    const sRahul = insertStudentUser(
        'rahul@student.com', studentPass, 'active',
        'Rahul Sharma', '2026CS101', 'Male', 'Computer Science', 2, '9876543210', '9876543211'
    );

    const sPriya = insertStudentUser(
        'priya@student.com', studentPass, 'active',
        'Priya Patel', '2026IT202', 'Female', 'Information Technology', 3, '9876543220', '9876543221'
    );

    const sAmit = insertStudentUser(
        'amit@student.com', studentPass, 'pending',
        'Amit Verma', '2026ME303', 'Male', 'Mechanical Engineering', 1, '9876543230', '9876543231'
    );

    // 5. Allocations (Rahul in 101-A Boys, Priya in 101-A Girls)
    const insertAlloc = db.prepare(`
        INSERT INTO allocations (student_id, bed_id, start_date, status)
        VALUES (?, ?, DATE('now'), 'Active')
    `);
    const updateBed = db.prepare(`UPDATE beds SET status = ? WHERE id = ?`);

    const allocRahul = insertAlloc.run(sRahul.studentId, boysBeds['101-A']);
    updateBed.run('Occupied', boysBeds['101-A']);

    const allocPriya = insertAlloc.run(sPriya.studentId, girlsBeds['101-A']);
    updateBed.run('Occupied', girlsBeds['101-A']);

    // 6. Fees & Payments
    const insertFee = db.prepare(`
        INSERT INTO fees (allocation_id, term, amount, due_date, status)
        VALUES (?, ?, ?, ?, ?)
    `);
    const feeRahul = insertFee.run(allocRahul.lastInsertRowid, 'Fall 2026', 25000, '2026-12-15', 'Unpaid');
    const feePriya = insertFee.run(allocPriya.lastInsertRowid, 'Fall 2026', 25000, '2026-12-15', 'Paid');

    db.prepare(`
        INSERT INTO payments (fee_id, amount, mode, transaction_ref)
        VALUES (?, ?, ?, ?)
    `).run(feePriya.lastInsertRowid, 25000, 'Online', 'TXN-HOSTEL-90812');

    // 7. Complaints
    db.prepare(`
        INSERT INTO complaints (student_id, hostel_id, category, description, priority, status, assigned_to)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        sRahul.studentId, hostelBoys.lastInsertRowid,
        'Electrical', 'Ceiling fan making clicking noise on speed 3.',
        'Medium', 'Open', null
    );

    db.prepare(`
        INSERT INTO complaints (student_id, hostel_id, category, description, priority, status, assigned_to, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sPriya.studentId, hostelGirls.lastInsertRowid,
        'Plumbing', 'Bathroom tap leaking slowly.',
        'Low', 'In Progress', 'Plumber Rajesh', 'Parts ordered, fixing tomorrow morning.'
    );

    // 8. Notices
    db.prepare(`
        INSERT INTO notices (title, body, hostel_id, created_by)
        VALUES (?, ?, ?, ?)
    `).run(
        'Hostel Gate Closing Timing Notice',
        'All residents are advised that main hostel gates will strictly close at 10:00 PM on weekdays.',
        null, admin.lastInsertRowid
    );

    db.prepare(`
        INSERT INTO notices (title, body, hostel_id, created_by)
        VALUES (?, ?, ?, ?)
    `).run(
        'Hostel WiFi Maintenance Notice',
        'WiFi router upgrades will take place this Saturday between 2 PM and 4 PM.',
        hostelBoys.lastInsertRowid, wardenBoys.lastInsertRowid
    );

    // 9. Initial Audit Log & Waitlist demo
    db.prepare(`
        INSERT INTO audit_logs (user_id, user_email, action, details)
        VALUES (?, 'admin@hostel.com', 'SYSTEM_INIT', 'Seeded initial institutional hostels, rooms, and demo users.')
    `).run(admin.lastInsertRowid);

    // Seed waitlist entry for student Amit Verma
    db.prepare(`
        INSERT INTO waitlist (student_id, preferred_hostel_id, priority_order, status)
        VALUES (?, ?, 1, 'Waiting')
    `).run(sAmit.studentId, hostelBoys.lastInsertRowid);

    // 10. Sample Penalties & Fines
    db.prepare(`
        INSERT INTO penalties (student_id, allocation_id, hostel_id, category, title, description, amount, due_date, status, imposed_by)
        VALUES (?, ?, ?, 'Lost Key / Asset Damage', 'Room Key Replacement Fee', 'Duplicate key issuance for Room 101 wardrobe lock', 250, DATE('now', '+5 days'), 'Unpaid', ?)
    `).run(sRahul.studentId, allocRahul.lastInsertRowid, hostelBoys.lastInsertRowid, wardenBoys.lastInsertRowid);

    console.log('✅ Seed completed successfully!');
    console.log('Credentials:');
    console.log(' - Admin:   admin@hostel.com / admin123');
    console.log(' - Warden:  warden.boys@hostel.com / warden123');
    console.log(' - Student: rahul@student.com / student123 (Active)');
    console.log(' - Student: amit@student.com / student123 (Pending verification)');
}

seed().catch(console.error);
