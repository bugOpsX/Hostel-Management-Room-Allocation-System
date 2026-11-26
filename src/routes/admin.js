const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// 1. Dashboard Metrics (FR-68)
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

        const openComplaints = db.prepare("SELECT COUNT(*) as count FROM complaints WHERE status != 'Resolved'").get().count;
        const pendingRequests = db.prepare("SELECT COUNT(*) as count FROM room_requests WHERE status = 'Pending'").get().count;
        const overdueFees = db.prepare("SELECT COUNT(*) as count FROM fees WHERE status IN ('Unpaid', 'Overdue')").get().count;

        res.json({
            students: { total: totalStudents, pending: pendingStudents },
            beds: {
                total: bedStats.total || 0,
                occupied: bedStats.occupied || 0,
                vacant: bedStats.vacant || 0,
                maintenance: bedStats.maintenance || 0,
                occupancyRate: bedStats.total ? Math.round((bedStats.occupied / bedStats.total) * 100) : 0
            },
            openComplaints,
            pendingRequests,
            overdueFees
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Student Directory & Approvals (FR-03, FR-11)
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
        const student = db.prepare('SELECT user_id FROM students WHERE id = ?').get(req.params.id);
        if (!student) return res.status(404).json({ error: 'Student not found' });

        db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(student.user_id);
        res.json({ success: true, message: 'Student account approved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Hostels & Rooms Management (FR-12 to FR-20)
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
        return res.status(400).json({ error: 'Capacity must be between 1 and 6 beds.' });
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
            return roomId;
        });

        createRoomTx();
        res.json({ success: true, message: `Room ${room_no} and ${cap} beds created successfully.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Room Allocation Engine (FR-21 to FR-28)
// Eligible students: active user account, no active allocation (BR-01, BR-04)
router.get('/allocations/eligible-students', (req, res) => {
    try {
        const students = db.prepare(`
            SELECT s.id, s.enrollment_no, s.full_name, s.gender, s.department, s.year_of_study
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

// Available beds (Vacant)
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

// Manual Allocation (FR-21)
router.post('/allocations/manual', (req, res) => {
    const { student_id, bed_id, term, fee_amount } = req.body;
    if (!student_id || !bed_id) {
        return res.status(400).json({ error: 'Student and bed selection are required.' });
    }

    try {
        const allocTx = db.transaction(() => {
            // Check student eligibility (BR-01, BR-04)
            const student = db.prepare(`
                SELECT s.id, s.gender, u.status 
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

            // Check bed eligibility (BR-02, BR-03)
            const bed = db.prepare(`
                SELECT b.id, b.status, h.type as hostel_type
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

            // Perform atomic allocation
            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(bed_id);
            const newAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(student_id, bed_id);

            // Generate Fee automatically (BR-05, FR-27, FR-41)
            const feeTerm = term || 'Academic Term 2026-27';
            const feeCost = fee_amount ? parseFloat(fee_amount) : 25000;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const dueStr = dueDate.toISOString().split('T')[0];

            db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, ?, ?, ?, 'Unpaid')
            `).run(newAlloc.lastInsertRowid, feeTerm, feeCost, dueStr);

            return newAlloc.lastInsertRowid;
        });

        const allocId = allocTx();
        res.json({ success: true, allocationId: allocId, message: 'Room allocated successfully and term fee generated.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Auto Allocation (FR-22)
router.post('/allocations/auto', (req, res) => {
    const { student_id, term, fee_amount } = req.body;
    if (!student_id) return res.status(400).json({ error: 'Student ID is required.' });

    try {
        const student = db.prepare(`
            SELECT s.id, s.gender, u.status 
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

        // Find first vacant bed in matching hostel
        const vacantBed = db.prepare(`
            SELECT b.id, b.bed_no, r.room_no, h.name as hostel_name
            FROM beds b
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE b.status = 'Vacant' AND h.type = ?
            ORDER BY h.id, r.room_no, b.bed_no
            LIMIT 1
        `).get(expectedHostelType);

        if (!vacantBed) {
            return res.status(404).json({ error: `No vacant bed available in ${expectedHostelType} hostels.` });
        }

        // Run atomic allocation
        const autoTx = db.transaction(() => {
            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(vacantBed.id);
            const newAlloc = db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(student_id, vacantBed.id);

            const feeTerm = term || 'Academic Term 2026-27';
            const feeCost = fee_amount ? parseFloat(fee_amount) : 25000;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const dueStr = dueDate.toISOString().split('T')[0];

            db.prepare(`
                INSERT INTO fees (allocation_id, term, amount, due_date, status)
                VALUES (?, ?, ?, ?, 'Unpaid')
            `).run(newAlloc.lastInsertRowid, feeTerm, feeCost, dueStr);

            return { allocId: newAlloc.lastInsertRowid, bed: vacantBed };
        });

        const result = autoTx();
        res.json({
            success: true,
            message: `Auto-allocated Room ${result.bed.room_no}, Bed ${result.bed.bed_no} in ${result.bed.hostel_name}.`,
            allocationId: result.allocId
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Transfer & Vacating Requests (FR-37, FR-38, FR-39)
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
    const { action, remarks, target_bed_id } = req.body; // action: 'Approve' | 'Reject'
    if (!['Approve', 'Reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be Approve or Reject.' });
    }

    try {
        const request = db.prepare(`
            SELECT req.*, a.bed_id as current_bed_id, s.gender
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
            return res.json({ success: true, message: 'Request rejected.' });
        }

        // Action is 'Approve'
        if (request.request_type === 'Vacate') {
            // Check unpaid fees (BR-06)
            const unpaid = db.prepare(`
                SELECT id, amount, status FROM fees 
                WHERE allocation_id = ? AND status IN ('Unpaid', 'Overdue')
            `).get(request.allocation_id);

            if (unpaid) {
                return res.status(400).json({
                    error: `Cannot clear vacating request: Student has unpaid fee dues (Amount: ₹${unpaid.amount}, Status: ${unpaid.status}) (BR-06).`
                });
            }

            // Execute atomic vacate (FR-39)
            const vacateTx = db.transaction(() => {
                db.prepare("UPDATE allocations SET status = 'Closed', end_date = DATE('now') WHERE id = ?").run(request.allocation_id);
                db.prepare("UPDATE beds SET status = 'Vacant' WHERE id = ?").run(request.current_bed_id);
                db.prepare("UPDATE room_requests SET status = 'Approved', admin_remarks = ? WHERE id = ?")
                    .run(remarks || 'Approved and vacated.', req.params.id);
            });
            vacateTx();
            return res.json({ success: true, message: 'Vacating request approved. Bed released and allocation closed.' });
        }

        if (request.request_type === 'Transfer') {
            // Must have a vacant target bed
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
                // Find automatic vacant bed in preferred hostel or matching hostel
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

            // Atomic transfer (FR-38)
            const transferTx = db.transaction(() => {
                // Close old allocation and free old bed
                db.prepare("UPDATE allocations SET status = 'Closed', end_date = DATE('now') WHERE id = ?").run(request.allocation_id);
                db.prepare("UPDATE beds SET status = 'Vacant' WHERE id = ?").run(request.current_bed_id);

                // Create new allocation and occupy new bed
                db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(targetBed.id);
                db.prepare(`
                    INSERT INTO allocations (student_id, bed_id, start_date, status)
                    VALUES (?, ?, DATE('now'), 'Active')
                `).run(request.student_id, targetBed.id);

                db.prepare("UPDATE room_requests SET status = 'Approved', admin_remarks = ? WHERE id = ?")
                    .run(remarks || 'Transfer approved.', req.params.id);
            });

            transferTx();
            return res.json({ success: true, message: 'Transfer request approved successfully. Beds swapped.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Fees & Payments (FR-40 to FR-50)
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
        const fee = db.prepare('SELECT * FROM fees WHERE id = ?').get(req.params.id);
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
        });

        payTx();
        res.json({ success: true, message: 'Payment recorded successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Wardens list (for assigning to hostels)
router.get('/wardens', (req, res) => {
    try {
        const wardens = db.prepare("SELECT id, email FROM users WHERE role = 'warden' AND status = 'active'").all();
        res.json(wardens);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
