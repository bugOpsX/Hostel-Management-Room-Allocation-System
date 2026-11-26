const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

router.use(requireAdmin);

// 1. Dashboard Metrics (FR-68, FR-69, BR-10: 72h escalated complaints)
router.get('/dashboard', (req, res) => {
    try {
        const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students').get().count;
        const pendingStudents = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'student' AND status = 'pending'").get().count;
        
        const bedStats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'Occupied' THEN 1 ELSE 0 END) as occupied,
                SUM(CASE WHEN status = 'Vacant' THEN 1 ELSE 0 END) as vacant,
                SUM(CASE WHEN status = 'Maintenance' THEN 1 ELSE 0 END) as maintenance
            FROM beds
        `).get();

        const complaintStats = db.prepare(`
            SELECT 
                COUNT(*) as total_open,
                SUM(CASE WHEN datetime(created_at, '+72 hours') <= datetime('now') THEN 1 ELSE 0 END) as escalated
            FROM complaints 
            WHERE status != 'Resolved'
        `).get();

        const pendingRequests = db.prepare("SELECT COUNT(*) as count FROM room_requests WHERE status = 'Pending'").get().count;
        const overdueFees = db.prepare("SELECT COUNT(*) as count FROM fees WHERE status IN ('Unpaid', 'Overdue')").get().count;
        const unpaidPenalties = db.prepare("SELECT COUNT(*) as count FROM penalties WHERE status = 'Unpaid'").get().count;
        const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM waitlist WHERE status = 'Waiting'").get().count;
        const unallocatedCount = db.prepare(`
            SELECT COUNT(*) as count FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE u.status = 'active'
              AND s.id NOT IN (SELECT student_id FROM allocations WHERE status = 'Active')
        `).get().count;

        const noticesCount = db.prepare('SELECT COUNT(*) as count FROM notices').get().count;

        res.json({
            students: { total: totalStudents, pending: pendingStudents, unallocated: unallocatedCount },
            beds: {
                total: bedStats.total || 0,
                occupied: bedStats.occupied || 0,
                vacant: bedStats.vacant || 0,
                maintenance: bedStats.maintenance || 0,
                occupancyRate: bedStats.total ? Math.round((bedStats.occupied / bedStats.total) * 100) : 0
            },
            complaints: {
                open: complaintStats.total_open || 0,
                escalated: complaintStats.escalated || 0
            },
            pendingRequests,
            overdueFees,
            unpaidPenalties,
            waitlistCount,
            noticesCount,
            badges: {
                pendingStudents,
                unallocated: unallocatedCount,
                waitlist: waitlistCount,
                pendingRequests,
                overdueFees: overdueFees + unpaidPenalties,
                unpaidPenalties,
                openComplaints: complaintStats.total_open || 0,
                escalatedComplaints: complaintStats.escalated || 0,
                notices: noticesCount,
                totalAlerts: pendingStudents + pendingRequests + (complaintStats.total_open || 0) + overdueFees + unpaidPenalties
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Student Directory & Approvals
router.get('/students', (req, res) => {
    try {
        const students = db.prepare(`
            SELECT 
                s.id as student_id, s.enrollment_no, s.full_name, s.gender, s.department, s.year_of_study, s.mobile,
                u.id as user_id, u.email, u.status as account_status,
                a.id as allocation_id, a.status as allocation_status,
                b.bed_no, r.room_no, h.name as hostel_name
            FROM students s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN allocations a ON s.id = a.student_id AND a.status = 'Active'
            LEFT JOIN beds b ON a.bed_id = b.id
            LEFT JOIN rooms r ON b.room_id = r.id
            LEFT JOIN hostels h ON r.hostel_id = h.id
            ORDER BY u.created_at DESC
        `).all();
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/students/:id/approve', (req, res) => {
    try {
        const student = db.prepare('SELECT user_id, full_name, enrollment_no FROM students WHERE id = ?').get(req.params.id);
        if (!student) return res.status(404).json({ error: 'Student not found' });

        db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(student.user_id);
        logAudit(req.session.user.id, req.session.user.email, 'STUDENT_APPROVAL', `Approved account for ${student.full_name} (${student.enrollment_no}).`, student.id, null);
        res.json({ success: true, message: 'Student account approved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Student Full Details & History by ID
router.get('/students/:id/details', (req, res) => {
    try {
        const student = db.prepare(`
            SELECT 
                s.*, u.email, u.status as account_status, u.created_at as account_created_at
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE s.id = ?
        `).get(req.params.id);

        if (!student) return res.status(404).json({ error: 'Student not found' });

        const activeAllocation = db.prepare(`
            SELECT a.*, r.room_no, b.bed_no, h.name as hostel_name
            FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE a.student_id = ? AND a.status = 'Active'
        `).get(student.id);

        const allocationHistory = db.prepare(`
            SELECT a.*, r.room_no, b.bed_no, h.name as hostel_name
            FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE a.student_id = ?
            ORDER BY a.start_date DESC
        `).all(student.id);

        const fees = db.prepare('SELECT * FROM fees WHERE allocation_id IN (SELECT id FROM allocations WHERE student_id = ?) ORDER BY due_date DESC').all(student.id);
        const penalties = db.prepare('SELECT * FROM penalties WHERE student_id = ? ORDER BY created_at DESC').all(student.id);
        const complaints = db.prepare('SELECT * FROM complaints WHERE student_id = ? ORDER BY created_at DESC').all(student.id);

        res.json({
            student,
            activeAllocation,
            allocationHistory,
            fees,
            penalties,
            complaints
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Hostels & Rooms
router.get('/hostels', (req, res) => {
    try {
        const hostels = db.prepare(`
            SELECT 
                h.*,
                u.email as warden_email,
                COUNT(DISTINCT r.id) as total_rooms,
                COUNT(b.id) as total_beds,
                SUM(CASE WHEN b.status = 'Occupied' THEN 1 ELSE 0 END) as occupied_beds,
                SUM(CASE WHEN b.status = 'Vacant' THEN 1 ELSE 0 END) as vacant_beds
            FROM hostels h
            LEFT JOIN users u ON h.warden_id = u.id
            LEFT JOIN rooms r ON h.id = r.hostel_id
            LEFT JOIN beds b ON r.id = b.room_id
            GROUP BY h.id
        `).all();
        res.json(hostels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/hostels', (req, res) => {
    const { name, type, floors, warden_id } = req.body;
    if (!name || !type || !floors) {
        return res.status(400).json({ error: 'Name, type, and floor count are required' });
    }
    try {
        const resHostel = db.prepare(`
            INSERT INTO hostels (name, type, floors, warden_id)
            VALUES (?, ?, ?, ?)
        `).run(name.trim(), type, parseInt(floors, 10), warden_id || null);

        logAudit(req.session.user.id, req.session.user.email, 'HOSTEL_CREATE', `Created hostel ${name} (${type}) with ${floors} floors.`);
        res.json({ success: true, hostelId: resHostel.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/rooms', (req, res) => {
    try {
        const { hostel_id, floor, status } = req.query;
        let sql = `
            SELECT 
                r.id as room_id, r.room_no, r.floor, r.room_type, r.capacity,
                h.id as hostel_id, h.name as hostel_name, h.type as hostel_type,
                b.id as bed_id, b.bed_no, b.status as bed_status,
                s.full_name as student_name, s.enrollment_no
            FROM rooms r
            JOIN hostels h ON r.hostel_id = h.id
            LEFT JOIN beds b ON r.id = b.room_id
            LEFT JOIN allocations a ON b.id = a.bed_id AND a.status = 'Active'
            LEFT JOIN students s ON a.student_id = s.id
            WHERE 1=1
        `;
        const params = [];
        if (hostel_id) {
            sql += ' AND h.id = ?';
            params.push(hostel_id);
        }
        if (floor) {
            sql += ' AND r.floor = ?';
            params.push(floor);
        }
        if (status) {
            sql += ' AND b.status = ?';
            params.push(status);
        }
        sql += ' ORDER BY h.name, r.room_no, b.bed_no';

        const beds = db.prepare(sql).all(...params);
        res.json(beds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/rooms', (req, res) => {
    const { hostel_id, room_no, floor, room_type, capacity } = req.body;
    if (!hostel_id || !room_no || !floor || !room_type || !capacity) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    const cap = parseInt(capacity, 10);
    if (cap < 1 || cap > 6) {
        return res.status(400).json({ error: 'Capacity must be between 1 and 6 beds (BR-12).' });
    }

    try {
        const createRoomTx = db.transaction(() => {
            const roomRes = db.prepare(`
                INSERT INTO rooms (hostel_id, room_no, floor, room_type, capacity)
                VALUES (?, ?, ?, ?, ?)
            `).run(hostel_id, room_no.trim(), parseInt(floor, 10), room_type, cap);

            const roomId = roomRes.lastInsertRowid;
            const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
            for (let i = 0; i < cap; i++) {
                const bedNo = `${room_no.trim()}-${letters[i]}`;
                db.prepare(`
                    INSERT INTO beds (room_id, bed_no, status)
                    VALUES (?, ?, 'Vacant')
                `).run(roomId, bedNo);
            }
            logAudit(req.session.user.id, req.session.user.email, 'ROOM_CREATE', `Created room ${room_no} with ${cap} beds in hostel #${hostel_id}.`);
            return roomId;
        });

        createRoomTx();
        res.json({ success: true, message: `Room ${room_no} and ${cap} beds created successfully.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Bulk Room Upload via CSV (FR-20)
router.post('/rooms/bulk-csv', (req, res) => {
    const { csv_data } = req.body;
    if (!csv_data || typeof csv_data !== 'string') {
        return res.status(400).json({ error: 'CSV text data is required.' });
    }

    const lines = csv_data.trim().split('\n');
    let accepted = 0;
    const rejected = [];

    const hostels = db.prepare('SELECT id, name FROM hostels').all();
    const hostelMap = {};
    hostels.forEach(h => hostelMap[h.name.toLowerCase().trim()] = h.id);

    const insertRoom = db.prepare(`
        INSERT INTO rooms (hostel_id, room_no, floor, room_type, capacity)
        VALUES (?, ?, ?, ?, ?)
    `);
    const insertBed = db.prepare(`
        INSERT INTO beds (room_id, bed_no, status)
        VALUES (?, ?, 'Vacant')
    `);

    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();
        if (!line || (idx === 0 && line.toLowerCase().includes('hostelname'))) continue;

        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 5) {
            rejected.push({ row: idx + 1, data: line, reason: 'Expected 5 columns (HostelName,RoomNo,Floor,RoomType,Capacity)' });
            continue;
        }

        const [hName, rNo, floorStr, rType, capStr] = parts;
        const hId = hostelMap[hName.toLowerCase()];
        if (!hId) {
            rejected.push({ row: idx + 1, data: line, reason: `Hostel "${hName}" not found.` });
            continue;
        }

        const floor = parseInt(floorStr, 10);
        const cap = parseInt(capStr, 10);
        if (isNaN(cap) || cap < 1 || cap > 6) {
            rejected.push({ row: idx + 1, data: line, reason: 'Capacity must be an integer between 1 and 6 (BR-12).' });
            continue;
        }

        try {
            const bulkTx = db.transaction(() => {
                const roomRes = insertRoom.run(hId, rNo, floor || 1, rType, cap);
                const roomId = roomRes.lastInsertRowid;
                for (let i = 0; i < cap; i++) {
                    insertBed.run(roomId, `${rNo}-${letters[i]}`);
                }
            });
            bulkTx();
            accepted++;
        } catch (e) {
            rejected.push({ row: idx + 1, data: line, reason: e.message });
        }
    }

    logAudit(req.session.user.id, req.session.user.email, 'BULK_ROOM_IMPORT', `Bulk import: ${accepted} rooms created, ${rejected.length} rejected.`);

    res.json({
        success: true,
        acceptedCount: accepted,
        rejectedCount: rejected.length,
        rejectedRows: rejected
    });
});

router.post('/beds/:id/status', (req, res) => {
    const { status } = req.body;
    if (!['Vacant', 'Maintenance'].includes(status)) {
        return res.status(400).json({ error: 'Status can only be toggled between Vacant and Maintenance.' });
    }
    try {
        const bed = db.prepare('SELECT status FROM beds WHERE id = ?').get(req.params.id);
        if (!bed) return res.status(404).json({ error: 'Bed not found' });
        if (bed.status === 'Occupied') {
            return res.status(400).json({ error: 'Cannot change status of an Occupied bed.' });
        }
        db.prepare('UPDATE beds SET status = ? WHERE id = ?').run(status, req.params.id);
        logAudit(req.session.user.id, req.session.user.email, 'BED_STATUS_TOGGLE', `Bed #${req.params.id} changed to ${status}.`);
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Room Allocation Engine & Bulk Allocation (FR-21 to FR-28)
router.get('/allocations/eligible-students', (req, res) => {
    try {
        const students = db.prepare(`
            SELECT s.id, s.enrollment_no, s.full_name, s.gender, s.department, s.year_of_study, u.created_at as registered_at
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE u.status = 'active'
              AND s.id NOT IN (SELECT student_id FROM allocations WHERE status = 'Active')
            ORDER BY s.full_name
        `).all();
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/allocations/available-beds', (req, res) => {
    const { gender } = req.query;
    try {
        let sql = `
            SELECT b.id as bed_id, b.bed_no, r.room_no, r.floor, r.room_type, h.id as hostel_id, h.name as hostel_name, h.type as hostel_type
            FROM beds b
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE b.status = 'Vacant'
        `;
        const params = [];
        if (gender) {
            const expectedType = gender.toLowerCase() === 'female' ? 'Girls' : 'Boys';
            sql += ' AND h.type = ?';
            params.push(expectedType);
        }
        sql += ' ORDER BY h.name, r.room_no, b.bed_no';
        const beds = db.prepare(sql).all(...params);
        res.json(beds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manual Allocation (Single Student)
router.post('/allocations/manual', (req, res) => {
    const { student_id, bed_id, term, fee_amount } = req.body;
    if (!student_id || !bed_id) {
        return res.status(400).json({ error: 'Student and bed selection are required.' });
    }

    try {
        const allocTx = db.transaction(() => {
            const student = db.prepare(`
                SELECT s.id, s.full_name, s.enrollment_no, s.gender, u.status 
                FROM students s 
                JOIN users u ON s.user_id = u.id 
                WHERE s.id = ?
            `).get(student_id);

            if (!student || student.status !== 'active') {
                throw new Error('Student account is not approved or active (BR-04).');
            }

            const activeAlloc = db.prepare("SELECT id FROM allocations WHERE student_id = ? AND status = 'Active'").get(student_id);
            if (activeAlloc) {
                throw new Error('Student already holds an active bed allocation (BR-01).');
            }

            const bed = db.prepare(`
                SELECT b.id, b.bed_no, b.status, h.name as hostel_name, h.type as hostel_type
                FROM beds b
                JOIN rooms r ON b.room_id = r.id
                JOIN hostels h ON r.hostel_id = h.id
                WHERE b.id = ?
            `).get(bed_id);

            if (!bed) throw new Error('Selected bed does not exist.');
            if (bed.status !== 'Vacant') throw new Error(`Bed is not vacant (status: ${bed.status}) (BR-02).`);

            const expectedHostelType = student.gender === 'Female' ? 'Girls' : 'Boys';
            if (bed.hostel_type !== expectedHostelType) {
                throw new Error(`Gender mismatch: ${student.gender} student cannot be allocated to ${bed.hostel_type} hostel (BR-03).`);
            }

            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(bed_id);
            const newAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(student_id, bed_id);

            db.prepare("UPDATE waitlist SET status = 'Allocated' WHERE student_id = ? AND status = 'Waiting'").run(student_id);

            const feeTerm = term || 'Academic Term 2026-27';
            const feeCost = fee_amount ? parseFloat(fee_amount) : 25000;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const dueStr = dueDate.toISOString().split('T')[0];

            db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, ?, ?, ?, 'Unpaid')
            `).run(newAlloc.lastInsertRowid, feeTerm, feeCost, dueStr);

            logAudit(req.session.user.id, req.session.user.email, 'ROOM_ALLOCATION', `Allocated Bed ${bed.bed_no} in ${bed.hostel_name} to ${student.full_name} (${student.enrollment_no}).`, student.id, bed.hostel_id);
            return newAlloc.lastInsertRowid;
        });

        const allocId = allocTx();
        res.json({ success: true, allocationId: allocId, message: 'Room allocated successfully and term fee generated.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Auto Allocation (Single Student)
router.post('/allocations/auto', (req, res) => {
    const { student_id, term, fee_amount } = req.body;
    if (!student_id) return res.status(400).json({ error: 'Student ID is required.' });

    try {
        const student = db.prepare(`
            SELECT s.id, s.full_name, s.enrollment_no, s.gender, u.status 
            FROM students s 
            JOIN users u ON s.user_id = u.id 
            WHERE s.id = ?
        `).get(student_id);

        if (!student || student.status !== 'active') {
            return res.status(400).json({ error: 'Student account is not approved or active.' });
        }

        const activeAlloc = db.prepare("SELECT id FROM allocations WHERE student_id = ? AND status = 'Active'").get(student_id);
        if (activeAlloc) {
            return res.status(400).json({ error: 'Student already has an active allocation (BR-01).' });
        }

        const expectedHostelType = student.gender === 'Female' ? 'Girls' : 'Boys';

        const vacantBed = db.prepare(`
            SELECT b.id, b.bed_no, r.room_no, h.id as hostel_id, h.name as hostel_name
            FROM beds b
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE b.status = 'Vacant' AND h.type = ?
            ORDER BY h.id, r.room_no, b.bed_no
            LIMIT 1
        `).get(expectedHostelType);

        if (!vacantBed) {
            const nextPriority = (db.prepare('SELECT MAX(priority_order) as maxP FROM waitlist').get().maxP || 0) + 1;
            db.prepare(`
                INSERT INTO waitlist (student_id, priority_order, status)
                VALUES (?, ?, 'Waiting')
            `).run(student_id, nextPriority);

            logAudit(req.session.user.id, req.session.user.email, 'WAITLIST_ADD', `No bed vacant in ${expectedHostelType} hostels. Student ${student.full_name} added to Waitlist at position #${nextPriority} (FR-26).`, student.id, null);

            return res.status(200).json({
                waitlisted: true,
                message: `No vacant bed available in ${expectedHostelType} hostels. Student added to Waitlist at position #${nextPriority} (FR-26).`
            });
        }

        const autoTx = db.transaction(() => {
            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(vacantBed.id);
            const newAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(student_id, vacantBed.id);

            db.prepare("UPDATE waitlist SET status = 'Allocated' WHERE student_id = ? AND status = 'Waiting'").run(student_id);

            const feeTerm = term || 'Academic Term 2026-27';
            const feeCost = fee_amount ? parseFloat(fee_amount) : 25000;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const dueStr = dueDate.toISOString().split('T')[0];

            db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, ?, ?, ?, 'Unpaid')
            `).run(newAlloc.lastInsertRowid, feeTerm, feeCost, dueStr);

            logAudit(req.session.user.id, req.session.user.email, 'AUTO_ALLOCATION', `Auto-allocated Room ${vacantBed.room_no}, Bed ${vacantBed.bed_no} in ${vacantBed.hostel_name} to ${student.full_name}.`, student.id, vacantBed.hostel_id);

            return { allocId: newAlloc.lastInsertRowid, bed: vacantBed };
        });

        const result = autoTx();
        res.json({
            success: true,
            waitlisted: false,
            message: `Auto-allocated Room ${result.bed.room_no}, Bed ${result.bed.bed_no} in ${result.bed.hostel_name}.`,
            allocationId: result.allocId
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// BULK AUTO-ALLOCATION ENGINE (FR-22, FR-23, FR-26)
router.post('/allocations/bulk', (req, res) => {
    const { order_by, term, fee_amount, student_ids } = req.body;
    // order_by: 'registration' (earliest first per FR-23) | 'year_desc' (senior first) | 'year_asc' (freshmen first)

    try {
        let sql = `
            SELECT s.id, s.full_name, s.enrollment_no, s.gender, s.department, s.year_of_study, u.created_at as registered_at
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE u.status = 'active'
              AND s.id NOT IN (SELECT student_id FROM allocations WHERE status = 'Active')
        `;
        const params = [];

        if (Array.isArray(student_ids) && student_ids.length > 0) {
            const placeholders = student_ids.map(() => '?').join(',');
            sql += ` AND s.id IN (${placeholders})`;
            params.push(...student_ids);
        }

        if (order_by === 'year_desc') {
            sql += ' ORDER BY s.year_of_study DESC, u.created_at ASC';
        } else if (order_by === 'year_asc') {
            sql += ' ORDER BY s.year_of_study ASC, u.created_at ASC';
        } else {
            // Default per FR-23: registration date, earliest first
            sql += ' ORDER BY u.created_at ASC, s.id ASC';
        }

        const candidateStudents = db.prepare(sql).all(...params);

        if (candidateStudents.length === 0) {
            return res.json({
                success: true,
                totalProcessed: 0,
                allocatedCount: 0,
                waitlistedCount: 0,
                allocated: [],
                waitlisted: [],
                message: 'No unallocated approved students found to process.'
            });
        }

        const feeTerm = term || 'Academic Term 2026-27';
        const feeCost = fee_amount ? parseFloat(fee_amount) : 25000;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30);
        const dueStr = dueDate.toISOString().split('T')[0];

        const allocatedList = [];
        const waitlistedList = [];

        // Run bulk allocation inside single ACID transaction
        const bulkTx = db.transaction(() => {
            const findVacantBed = db.prepare(`
                SELECT b.id, b.bed_no, r.room_no, h.id as hostel_id, h.name as hostel_name
                FROM beds b
                JOIN rooms r ON b.room_id = r.id
                JOIN hostels h ON r.hostel_id = h.id
                WHERE b.status = 'Vacant' AND h.type = ?
                ORDER BY h.id, r.room_no, b.bed_no
                LIMIT 1
            `);

            const occupyBed = db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?");
            const insertAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `);
            const insertFee = db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, ?, ?, ?, 'Unpaid')
            `);
            const updateWaitlist = db.prepare("UPDATE waitlist SET status = 'Allocated' WHERE student_id = ? AND status = 'Waiting'");
            const insertWaitlist = db.prepare(`
                INSERT INTO waitlist (student_id, priority_order, status)
                VALUES (?, ?, 'Waiting')
            `);

            let currentMaxPriority = (db.prepare('SELECT MAX(priority_order) as maxP FROM waitlist').get().maxP || 0);

            for (const student of candidateStudents) {
                const expectedHostelType = student.gender === 'Female' ? 'Girls' : 'Boys';
                const bed = findVacantBed.get(expectedHostelType);

                if (bed) {
                    occupyBed.run(bed.id);
                    const allocRes = insertAlloc.run(student.id, bed.id);
                    insertFee.run(allocRes.lastInsertRowid, feeTerm, feeCost, dueStr);
                    updateWaitlist.run(student.id);

                    logAudit(
                        req.session.user.id,
                        req.session.user.email,
                        'ROOM_ALLOCATION',
                        `Bulk allocation assigned Bed ${bed.bed_no} in ${bed.hostel_name} (Room ${bed.room_no}) to ${student.full_name}.`,
                        student.id,
                        bed.hostel_id
                    );

                    allocatedList.push({
                        student_id: student.id,
                        student_name: student.full_name,
                        enrollment_no: student.enrollment_no,
                        gender: student.gender,
                        hostel_name: bed.hostel_name,
                        room_no: bed.room_no,
                        bed_no: bed.bed_no
                    });
                } else {
                    // Check if already on waitlist
                    const alreadyWaiting = db.prepare("SELECT id FROM waitlist WHERE student_id = ? AND status = 'Waiting'").get(student.id);
                    if (!alreadyWaiting) {
                        currentMaxPriority++;
                        insertWaitlist.run(student.id, currentMaxPriority);
                    }

                    logAudit(
                        req.session.user.id,
                        req.session.user.email,
                        'WAITLIST_ADD',
                        `Bulk engine placed student on waitlist at priority #${currentMaxPriority} (All ${expectedHostelType} hostels full).`,
                        student.id,
                        null
                    );

                    waitlistedList.push({
                        student_id: student.id,
                        student_name: student.full_name,
                        enrollment_no: student.enrollment_no,
                        gender: student.gender,
                        reason: `All ${expectedHostelType} hostel beds are fully occupied`
                    });
                }
            }

            logAudit(
                req.session.user.id,
                req.session.user.email,
                'BULK_ROOM_ALLOCATION',
                `Bulk allocation completed: ${allocatedList.length} students allocated, ${waitlistedList.length} queued to waitlist (Order: ${order_by || 'registration'}).`
            );
        });

        bulkTx();

        res.json({
            success: true,
            totalProcessed: candidateStudents.length,
            allocatedCount: allocatedList.length,
            waitlistedCount: waitlistedList.length,
            allocated: allocatedList,
            waitlisted: waitlistedList,
            message: `Bulk allocation finished: ${allocatedList.length} students successfully allocated rooms, ${waitlistedList.length} queued to waitlist.`
        });
    } catch (err) {
        console.error('Bulk allocation error:', err);
        res.status(500).json({ error: 'Bulk allocation failed: ' + err.message });
    }
});

// Waitlist Endpoints (FR-23, FR-26)
router.get('/waitlist', (req, res) => {
    try {
        const waitlist = db.prepare(`
            SELECT 
                w.*,
                s.full_name as student_name, s.enrollment_no, s.gender, s.department, s.year_of_study,
                h.name as preferred_hostel_name
            FROM waitlist w
            JOIN students s ON w.student_id = s.id
            LEFT JOIN hostels h ON w.preferred_hostel_id = h.id
            WHERE w.status = 'Waiting'
            ORDER BY w.priority_order ASC
        `).all();
        res.json(waitlist);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/waitlist/:id/allocate', (req, res) => {
    try {
        const entry = db.prepare(`
            SELECT w.*, s.gender, s.full_name, s.enrollment_no 
            FROM waitlist w 
            JOIN students s ON w.student_id = s.id 
            WHERE w.id = ?
        `).get(req.params.id);

        if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });

        const expectedType = entry.gender === 'Female' ? 'Girls' : 'Boys';
        const vacantBed = db.prepare(`
            SELECT b.id, b.bed_no, r.room_no, h.name as hostel_name
            FROM beds b
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE b.status = 'Vacant' AND h.type = ?
            ORDER BY h.id, r.room_no, b.bed_no
            LIMIT 1
        `).get(expectedType);

        if (!vacantBed) {
            return res.status(400).json({ error: `Still no vacant bed available in ${expectedType} hostels.` });
        }

        const allocTx = db.transaction(() => {
            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(vacantBed.id);
            const newAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(entry.student_id, vacantBed.id);

            db.prepare("UPDATE waitlist SET status = 'Allocated' WHERE id = ?").run(entry.id);

            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, 'Academic Term 2026-27', 25000, ?, 'Unpaid')
            `).run(newAlloc.lastInsertRowid, dueDate.toISOString().split('T')[0]);

            logAudit(req.session.user.id, req.session.user.email, 'WAITLIST_ALLOCATED', `Waitlisted student ${entry.full_name} allocated Bed ${vacantBed.bed_no} in ${vacantBed.hostel_name}.`, entry.student_id, vacantBed.hostel_id);
        });

        allocTx();
        res.json({ success: true, message: `Waitlisted student allocated Room ${vacantBed.room_no}, Bed ${vacantBed.bed_no}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/waitlist/:id', (req, res) => {
    try {
        db.prepare("UPDATE waitlist SET status = 'Cancelled' WHERE id = ?").run(req.params.id);
        res.json({ success: true, message: 'Waitlist entry removed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Transfer & Vacating Requests
router.get('/requests', (req, res) => {
    try {
        const requests = db.prepare(`
            SELECT 
                req.*,
                s.full_name as student_name, s.enrollment_no, s.gender,
                h_cur.name as current_hostel, r_cur.room_no as current_room, b_cur.bed_no as current_bed,
                h_pref.name as preferred_hostel_name,
                (SELECT status FROM fees WHERE allocation_id = req.allocation_id ORDER BY id DESC LIMIT 1) as fee_status
            FROM room_requests req
            JOIN students s ON req.student_id = s.id
            JOIN allocations a ON req.allocation_id = a.id
            JOIN beds b_cur ON a.bed_id = b_cur.id
            JOIN rooms r_cur ON b_cur.room_id = r_cur.id
            JOIN hostels h_cur ON r_cur.hostel_id = h_cur.id
            LEFT JOIN hostels h_pref ON req.preferred_hostel_id = h_pref.id
            ORDER BY req.created_at DESC
        `).all();
        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/requests/:id/action', (req, res) => {
    const { action, remarks, target_bed_id } = req.body;
    if (!['Approve', 'Reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be Approve or Reject.' });
    }

    try {
        const request = db.prepare(`
            SELECT req.*, a.bed_id as current_bed_id, s.gender, s.full_name
            FROM room_requests req
            JOIN allocations a ON req.allocation_id = a.id
            JOIN students s ON req.student_id = s.id
            WHERE req.id = ?
        `).get(req.params.id);

        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.status !== 'Pending') {
            return res.status(400).json({ error: `Request has already been ${request.status}.` });
        }

        if (action === 'Reject') {
            db.prepare("UPDATE room_requests SET status = 'Rejected', admin_remarks = ? WHERE id = ?")
                .run(remarks || 'Rejected by Administrator', req.params.id);
            logAudit(req.session.user.id, req.session.user.email, 'REQUEST_REJECT', `Rejected ${request.request_type} request for ${request.full_name}.`, request.student_id, null);
            return res.json({ success: true, message: 'Request rejected.' });
        }

        if (request.request_type === 'Vacate') {
            const unpaid = db.prepare(`
                SELECT id, amount, status FROM fees 
                WHERE allocation_id = ? AND status IN ('Unpaid', 'Overdue')
            `).get(request.allocation_id);

            if (unpaid) {
                return res.status(400).json({
                    error: `Cannot clear vacating request: Student has unpaid fee dues (Amount: ₹${unpaid.amount}, Status: ${unpaid.status}) (BR-06).`
                });
            }

            const unpaidPenalty = db.prepare(`
                SELECT id, title, amount FROM penalties 
                WHERE student_id = ? AND status = 'Unpaid'
            `).get(request.student_id);

            if (unpaidPenalty) {
                return res.status(400).json({
                    error: `Cannot clear vacating request: Student has unpaid fine/penalty dues (Penalty #${unpaidPenalty.id}: "${unpaidPenalty.title}", Amount: ₹${unpaidPenalty.amount}) (BR-06).`
                });
            }

            const vacateTx = db.transaction(() => {
                db.prepare("UPDATE allocations SET status = 'Closed', end_date = DATE('now') WHERE id = ?").run(request.allocation_id);
                db.prepare("UPDATE beds SET status = 'Vacant' WHERE id = ?").run(request.current_bed_id);
                db.prepare("UPDATE room_requests SET status = 'Approved', admin_remarks = ? WHERE id = ?")
                    .run(remarks || 'Approved and vacated.', req.params.id);

                logAudit(req.session.user.id, req.session.user.email, 'VACATE_APPROVE', `Vacated bed #${request.current_bed_id} for ${request.full_name}.`, request.student_id, null);
            });
            vacateTx();
            return res.json({ success: true, message: 'Vacating request approved. Bed released and allocation closed.' });
        }

        if (request.request_type === 'Transfer') {
            let targetBed = null;
            if (target_bed_id) {
                targetBed = db.prepare(`
                    SELECT b.id, b.status, h.type as hostel_type
                    FROM beds b
                    JOIN rooms r ON b.room_id = r.id
                    JOIN hostels h ON r.hostel_id = h.id
                    WHERE b.id = ?
                `).get(target_bed_id);
            } else {
                const expectedHostelType = request.gender === 'Female' ? 'Girls' : 'Boys';
                let bedQuery = `
                    SELECT b.id, b.status, h.type as hostel_type
                    FROM beds b
                    JOIN rooms r ON b.room_id = r.id
                    JOIN hostels h ON r.hostel_id = h.id
                    WHERE b.status = 'Vacant' AND h.type = ?
                `;
                const params = [expectedHostelType];
                if (request.preferred_hostel_id) {
                    bedQuery += ' AND h.id = ?';
                    params.push(request.preferred_hostel_id);
                }
                bedQuery += ' LIMIT 1';
                targetBed = db.prepare(bedQuery).get(...params);
            }

            if (!targetBed || targetBed.status !== 'Vacant') {
                return res.status(400).json({ error: 'No vacant bed is available for transfer (BR-07).' });
            }

            const transferTx = db.transaction(() => {
                db.prepare("UPDATE allocations SET status = 'Closed', end_date = DATE('now') WHERE id = ?").run(request.allocation_id);
                db.prepare("UPDATE beds SET status = 'Vacant' WHERE id = ?").run(request.current_bed_id);

                db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(targetBed.id);
                db.prepare(`
                    INSERT INTO allocations (student_id, bed_id, start_date, status)
                    VALUES (?, ?, DATE('now'), 'Active')
                `).run(request.student_id, targetBed.id);

                db.prepare("UPDATE room_requests SET status = 'Approved', admin_remarks = ? WHERE id = ?")
                    .run(remarks || 'Transfer approved.', req.params.id);

                logAudit(req.session.user.id, req.session.user.email, 'TRANSFER_APPROVE', `Transferred ${request.full_name} from Bed #${request.current_bed_id} to Bed #${targetBed.id}.`, request.student_id, null);
            });

            transferTx();
            return res.json({ success: true, message: 'Transfer request approved successfully. Beds swapped.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Fees & Payments
router.get('/fees', (req, res) => {
    try {
        const fees = db.prepare(`
            SELECT 
                f.*,
                s.full_name as student_name, s.enrollment_no,
                h.name as hostel_name, r.room_no, b.bed_no,
                p.mode as payment_mode, p.transaction_ref, p.paid_at
            FROM fees f
            JOIN allocations a ON f.allocation_id = a.id
            JOIN students s ON a.student_id = s.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            LEFT JOIN payments p ON f.id = p.fee_id
            ORDER BY f.id DESC
        `).all();
        res.json(fees);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/fees/:id/record-payment', (req, res) => {
    const { mode, transaction_ref, amount } = req.body;
    try {
        const fee = db.prepare(`
            SELECT f.*, a.student_id, r.hostel_id 
            FROM fees f 
            JOIN allocations a ON f.allocation_id = a.id 
            JOIN beds b ON a.bed_id = b.id 
            JOIN rooms r ON b.room_id = r.id 
            WHERE f.id = ?
        `).get(req.params.id);
        if (!fee) return res.status(404).json({ error: 'Fee record not found' });
        if (fee.status === 'Paid') return res.status(400).json({ error: 'Fee has already been paid.' });

        const payTx = db.transaction(() => {
            const payAmount = amount ? parseFloat(amount) : fee.amount;
            const ref = transaction_ref || `OFFLINE-${Date.now()}`;
            db.prepare(`
                INSERT INTO payments (fee_id, amount, mode, transaction_ref)
                VALUES (?, ?, ?, ?)
            `).run(fee.id, payAmount, mode || 'Cash', ref);

            db.prepare("UPDATE fees SET status = 'Paid' WHERE id = ?").run(fee.id);
            logAudit(req.session.user.id, req.session.user.email, 'FEE_PAYMENT_RECORD', `Recorded payment of ₹${payAmount} (${mode || 'Cash'}) for Fee #${fee.id}.`, fee.student_id, fee.hostel_id);
        });

        payTx();
        res.json({ success: true, message: 'Payment recorded successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6b. Penalties & Fines Management
router.get('/penalties', (req, res) => {
    try {
        const penalties = db.prepare(`
            SELECT 
                p.*,
                s.full_name as student_name, s.enrollment_no, s.gender,
                h.name as hostel_name, r.room_no, b.bed_no,
                u.email as imposed_by_email,
                w.email as waived_by_email
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            LEFT JOIN allocations a ON p.allocation_id = a.id
            LEFT JOIN beds b ON a.bed_id = b.id
            LEFT JOIN rooms r ON b.room_id = r.id
            LEFT JOIN hostels h ON COALESCE(p.hostel_id, r.hostel_id) = h.id
            LEFT JOIN users u ON p.imposed_by = u.id
            LEFT JOIN users w ON p.waived_by = w.id
            ORDER BY p.id DESC
        `).all();
        res.json(penalties);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties', (req, res) => {
    const { student_id, category, title, description, amount, due_date } = req.body;
    if (!student_id || !category || !title || !amount || !due_date) {
        return res.status(400).json({ error: 'Student, category, title, amount, and due date are required.' });
    }

    try {
        const student = db.prepare('SELECT id, full_name, enrollment_no FROM students WHERE id = ?').get(student_id);
        if (!student) return res.status(404).json({ error: 'Student not found' });

        const activeAlloc = db.prepare(`
            SELECT a.id, r.hostel_id 
            FROM allocations a 
            JOIN beds b ON a.bed_id = b.id 
            JOIN rooms r ON b.room_id = r.id 
            WHERE a.student_id = ? AND a.status = 'Active'
        `).get(student_id);

        const ins = db.prepare(`
            INSERT INTO penalties (student_id, allocation_id, hostel_id, category, title, description, amount, due_date, status, imposed_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?)
        `).run(
            student_id,
            activeAlloc ? activeAlloc.id : null,
            activeAlloc ? activeAlloc.hostel_id : null,
            category,
            title.trim(),
            (description || '').trim(),
            parseFloat(amount),
            due_date,
            req.session.user.id
        );

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'PENALTY_LEVIED',
            `Admin levied ₹${amount} penalty (${category}: ${title.trim()}) on ${student.full_name} (${student.enrollment_no}).`,
            student_id,
            activeAlloc ? activeAlloc.hostel_id : null
        );

        res.json({ success: true, penaltyId: ins.lastInsertRowid, message: `Penalty of ₹${amount} successfully levied on ${student.full_name}.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties/:id/record-payment', (req, res) => {
    const { amount, mode, transaction_ref } = req.body;
    try {
        const penalty = db.prepare(`
            SELECT p.*, s.full_name, s.enrollment_no
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            WHERE p.id = ?
        `).get(req.params.id);

        if (!penalty) return res.status(404).json({ error: 'Penalty record not found' });
        if (penalty.status === 'Paid') return res.status(400).json({ error: 'Penalty has already been paid.' });
        if (penalty.status === 'Waived') return res.status(400).json({ error: 'Penalty has been waived.' });

        const payAmount = amount ? parseFloat(amount) : penalty.amount;
        const ref = transaction_ref || `OFFLINE-PEN-${Date.now()}`;

        db.prepare(`
            UPDATE penalties 
            SET status = 'Paid', paid_at = CURRENT_TIMESTAMP, payment_mode = ?, transaction_ref = ?
            WHERE id = ?
        `).run(mode || 'Cash', ref, penalty.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'PENALTY_PAID_RECORD',
            `Admin recorded ₹${payAmount} payment (${mode || 'Cash'}) for Penalty #${penalty.id} (${penalty.title}) for ${penalty.full_name}.`,
            penalty.student_id,
            penalty.hostel_id
        );

        res.json({ success: true, message: 'Penalty payment recorded successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties/:id/waive', (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Reason for waiving fine is mandatory.' });
    }

    try {
        const penalty = db.prepare(`
            SELECT p.*, s.full_name 
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            WHERE p.id = ?
        `).get(req.params.id);

        if (!penalty) return res.status(404).json({ error: 'Penalty record not found' });
        if (penalty.status !== 'Unpaid') return res.status(400).json({ error: `Cannot waive: Penalty is already ${penalty.status}.` });

        db.prepare(`
            UPDATE penalties 
            SET status = 'Waived', waived_by = ?, waive_reason = ?
            WHERE id = ?
        `).run(req.session.user.id, reason.trim(), penalty.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'PENALTY_WAIVED',
            `Penalty #${penalty.id} (₹${penalty.amount}, ${penalty.title}) for ${penalty.full_name} waived. Reason: "${reason.trim()}".`,
            penalty.student_id,
            penalty.hostel_id
        );

        res.json({ success: true, message: 'Penalty waived successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Audit Logs Endpoint
router.get('/audit-logs', (req, res) => {
    try {
        const { q, category } = req.query;
        let sql = 'SELECT * FROM audit_logs';
        const params = [];
        const conditions = [];

        if (category && category !== 'ALL') {
            conditions.push('action LIKE ?');
            params.push(`${category}%`);
        }
        if (q && q.trim()) {
            conditions.push('(action LIKE ? OR details LIKE ? OR user_email LIKE ?)');
            const term = `%${q.trim()}%`;
            params.push(term, term, term);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY created_at DESC LIMIT 250';

        const logs = db.prepare(sql).all(...params);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. Institutional Report Exports (CSV)
router.get('/reports/export-csv', (req, res) => {
    const { type } = req.query;
    try {
        if (type === 'occupancy') {
            const data = db.prepare(`
                SELECT h.name as Hostel, r.floor as Floor, r.room_no as Room, r.room_type as Type, b.bed_no as Bed, b.status as Status, s.full_name as Student
                FROM beds b
                JOIN rooms r ON b.room_id = r.id
                JOIN hostels h ON r.hostel_id = h.id
                LEFT JOIN allocations a ON b.id = a.bed_id AND a.status = 'Active'
                LEFT JOIN students s ON a.student_id = s.id
                ORDER BY h.name, r.floor, r.room_no, b.bed_no
            `).all();

            let csv = 'Hostel,Floor,Room,Type,Bed,Status,Student\n';
            data.forEach(d => {
                csv += `"${d.Hostel}",${d.Floor},"${d.Room}","${d.Type}","${d.Bed}","${d.Status}","${d.Student || ''}"\n`;
            });
            res.header('Content-Type', 'text/csv');
            res.attachment('occupancy_report.csv');
            return res.send(csv);
        }

        if (type === 'fees') {
            const data = db.prepare(`
                SELECT f.id as FeeID, s.enrollment_no as RollNo, s.full_name as Student, h.name as Hostel, f.term as Term, f.amount as Amount, f.due_date as DueDate, f.status as Status, p.transaction_ref as TxnRef
                FROM fees f
                JOIN allocations a ON f.allocation_id = a.id
                JOIN students s ON a.student_id = s.id
                JOIN beds b ON a.bed_id = b.id
                JOIN rooms r ON b.room_id = r.id
                JOIN hostels h ON r.hostel_id = h.id
                LEFT JOIN payments p ON f.id = p.fee_id
                ORDER BY f.id DESC
            `).all();

            let csv = 'FeeID,RollNo,Student,Hostel,Term,Amount,DueDate,Status,TxnRef\n';
            data.forEach(d => {
                csv += `${d.FeeID},"${d.RollNo}","${d.Student}","${d.Hostel}","${d.Term}",${d.Amount},"${d.DueDate}","${d.Status}","${d.TxnRef || ''}"\n`;
            });
            res.header('Content-Type', 'text/csv');
            res.attachment('fees_collection_report.csv');
            return res.send(csv);
        }

        if (type === 'complaints') {
            const data = db.prepare(`
                SELECT c.id as ID, c.created_at as Date, s.full_name as Student, h.name as Hostel, c.category as Category, c.priority as Priority, c.status as Status, c.assigned_to as Assigned, c.remarks as Remarks
                FROM complaints c
                JOIN students s ON c.student_id = s.id
                JOIN hostels h ON c.hostel_id = h.id
                ORDER BY c.created_at DESC
            `).all();

            let csv = 'ID,Date,Student,Hostel,Category,Priority,Status,Assigned,Remarks\n';
            data.forEach(d => {
                csv += `${d.ID},"${d.Date}","${d.Student}","${d.Hostel}","${d.Category}","${d.Priority}","${d.Status}","${d.Assigned || ''}","${(d.Remarks || '').replace(/"/g, '""')}"\n`;
            });
            res.header('Content-Type', 'text/csv');
            res.attachment('complaints_report.csv');
            return res.send(csv);
        }

        res.status(400).json({ error: 'Invalid report type' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. Wardens list
router.get('/wardens', (req, res) => {
    try {
        const wardens = db.prepare("SELECT id, email FROM users WHERE role = 'warden' AND status = 'active'").all();
        res.json(wardens);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. Manual Trigger for Cron Maintenance Tasks (FR-43, BR-10)
const { runDailyMaintenanceTasks } = require('../utils/cron');
router.post('/maintenance/run-cron', (req, res) => {
    try {
        const results = runDailyMaintenanceTasks();
        res.json({
            success: true,
            message: `Maintenance daemon completed: ${results.overdueCount} fees moved to Overdue (FR-43), ${results.escalatedCount} complaints escalated to High (BR-10).`,
            details: results
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
