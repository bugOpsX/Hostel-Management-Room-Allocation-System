const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireWarden } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

router.use(requireWarden);

function getWardenHostel(userId) {
    return db.prepare('SELECT * FROM hostels WHERE warden_id = ?').get(userId);
}

// 1. Warden Dashboard (FR-69)
router.get('/dashboard', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) {
            return res.json({ assigned: false, message: 'No hostel currently assigned to you.' });
        }

        const bedStats = db.prepare(`
            SELECT 
                COUNT(b.id) as total_beds,
                SUM(CASE WHEN b.status = 'Occupied' THEN 1 ELSE 0 END) as occupied,
                SUM(CASE WHEN b.status = 'Vacant' THEN 1 ELSE 0 END) as vacant,
                SUM(CASE WHEN b.status = 'Maintenance' THEN 1 ELSE 0 END) as maintenance
            FROM beds b
            JOIN rooms r ON b.room_id = r.id
            WHERE r.hostel_id = ?
        `).get(hostel.id);

        const complaintStats = db.prepare(`
            SELECT 
                COUNT(*) as total_open,
                SUM(CASE WHEN datetime(created_at, '+72 hours') <= datetime('now') THEN 1 ELSE 0 END) as escalated
            FROM complaints 
            WHERE hostel_id = ? AND status != 'Resolved'
        `).get(hostel.id);

        const pendingRequests = db.prepare(`
            SELECT COUNT(*) as count FROM room_requests req
            JOIN allocations a ON req.allocation_id = a.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE r.hostel_id = ? AND req.status = 'Pending'
        `).get(hostel.id).count;

        const activeVisitors = db.prepare(`
            SELECT COUNT(*) as count FROM visitors 
            WHERE hostel_id = ? AND out_time IS NULL
        `).get(hostel.id).count;

        const noticesCount = db.prepare(`
            SELECT COUNT(*) as count FROM notices
            WHERE hostel_id IS NULL OR hostel_id = ?
        `).get(hostel.id).count;

        const unpaidPenalties = db.prepare(`
            SELECT COUNT(*) as count FROM penalties
            WHERE hostel_id = ? AND status = 'Unpaid'
        `).get(hostel.id).count;

        res.json({
            assigned: true,
            hostel,
            bedStats,
            complaints: {
                open: complaintStats.total_open || 0,
                escalated: complaintStats.escalated || 0
            },
            pendingRequests,
            activeVisitors,
            noticesCount,
            unpaidPenalties,
            badges: {
                openComplaints: complaintStats.total_open || 0,
                escalatedComplaints: complaintStats.escalated || 0,
                pendingRequests,
                activeVisitors,
                noticesCount,
                unpaidPenalties,
                totalAlerts: (complaintStats.total_open || 0) + pendingRequests + activeVisitors + unpaidPenalties
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Complaints Management (FR-54, BR-10)
router.get('/complaints', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const complaints = db.prepare(`
            SELECT 
                c.*,
                CASE WHEN c.status != 'Resolved' AND datetime(c.created_at, '+72 hours') <= datetime('now') THEN 1 ELSE 0 END as is_escalated,
                s.full_name as student_name, s.enrollment_no, s.mobile,
                r.room_no, b.bed_no
            FROM complaints c
            JOIN students s ON c.student_id = s.id
            LEFT JOIN allocations a ON s.id = a.student_id AND a.status = 'Active'
            LEFT JOIN beds b ON a.bed_id = b.id
            LEFT JOIN rooms r ON b.room_id = r.id
            WHERE c.hostel_id = ?
            ORDER BY 
                is_escalated DESC,
                CASE c.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
                c.created_at DESC
        `).all(hostel.id);

        res.json(complaints);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/complaints/:id/update', (req, res) => {
    const { priority, status, assigned_to, remarks } = req.body;
    try {
        const hostel = getWardenHostel(req.session.user.id);
        const complaint = db.prepare('SELECT * FROM complaints WHERE id = ? AND hostel_id = ?').get(req.params.id, hostel.id);
        if (!complaint) return res.status(404).json({ error: 'Complaint not found for your hostel' });

        const resolvedAt = status === 'Resolved' ? new Date().toISOString() : null;

        db.prepare(`
            UPDATE complaints 
            SET priority = COALESCE(?, priority),
                status = COALESCE(?, status),
                assigned_to = COALESCE(?, assigned_to),
                remarks = COALESCE(?, remarks),
                resolved_at = COALESCE(?, resolved_at)
            WHERE id = ?
        `).run(priority, status, assigned_to, remarks, resolvedAt, req.params.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'COMPLAINT_UPDATE',
            `Warden updated Complaint #${req.params.id}: Status=${status}, Priority=${priority}, Assigned=${assigned_to || 'None'}.`,
            complaint.student_id,
            hostel.id
        );

        res.json({ success: true, message: 'Complaint updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Transfer/Vacate Recommendations (FR-36)
router.get('/requests', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const requests = db.prepare(`
            SELECT 
                req.*,
                s.full_name as student_name, s.enrollment_no,
                r.room_no, b.bed_no
            FROM room_requests req
            JOIN students s ON req.student_id = s.id
            JOIN allocations a ON req.allocation_id = a.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE r.hostel_id = ?
            ORDER BY req.created_at DESC
        `).all(hostel.id);

        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/requests/:id/recommend', (req, res) => {
    const { recommendation, remarks } = req.body;
    if (!['Recommend', 'Not Recommend'].includes(recommendation)) {
        return res.status(400).json({ error: 'Recommendation must be Recommend or Not Recommend' });
    }
    try {
        const hostel = getWardenHostel(req.session.user.id);
        const reqItem = db.prepare(`
            SELECT req.id, req.student_id FROM room_requests req
            JOIN allocations a ON req.allocation_id = a.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE req.id = ? AND r.hostel_id = ?
        `).get(req.params.id, hostel.id);

        if (!reqItem) return res.status(404).json({ error: 'Request not found in your hostel' });

        db.prepare(`
            UPDATE room_requests 
            SET warden_recommendation = ?, warden_remarks = ?
            WHERE id = ?
        `).run(recommendation, remarks || '', req.params.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'WARDEN_RECOMMENDATION',
            `Warden set "${recommendation}" for Request #${req.params.id} (Notes: ${remarks || 'None'}).`,
            reqItem.student_id,
            hostel.id
        );

        res.json({ success: true, message: 'Recommendation submitted for Administrator review.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Visitor Entry and Exit with Masked ID & Digital Pass Code (FR-59 to FR-63, NFR-09)
router.get('/visitors', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const visitors = db.prepare(`
            SELECT 
                v.*,
                s.full_name as student_name, s.enrollment_no
            FROM visitors v
            JOIN students s ON v.student_id = s.id
            WHERE v.hostel_id = ?
            ORDER BY v.in_time DESC
        `).all(hostel.id);

        const maskedVisitors = visitors.map(v => {
            const idLen = v.id_proof.length;
            const masked = idLen > 4 ? '••••-••••-' + v.id_proof.slice(-4) : v.id_proof;
            return { ...v, id_proof_masked: masked };
        });

        res.json(maskedVisitors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/warden/residents (FR-61: Active residents allocated to warden's hostel)
router.get('/residents', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const residents = db.prepare(`
            SELECT 
                s.id as student_id, s.full_name, s.enrollment_no, s.department, s.mobile, s.gender, s.year_of_study,
                r.room_no, r.floor, b.bed_no, a.id as allocation_id, a.start_date
            FROM allocations a
            JOIN students s ON a.student_id = s.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE r.hostel_id = ? AND a.status = 'Active'
            ORDER BY r.room_no, b.bed_no, s.full_name
        `).all(hostel.id);

        res.json(residents);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Resident Full Profile for Warden
router.get('/residents/:id/profile', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.status(400).json({ error: 'No hostel assigned' });

        const student = db.prepare(`
            SELECT 
                s.*, u.email,
                r.room_no, r.floor, b.bed_no, a.id as allocation_id, a.start_date
            FROM allocations a
            JOIN students s ON a.student_id = s.id
            JOIN users u ON s.user_id = u.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE s.id = ? AND r.hostel_id = ? AND a.status = 'Active'
        `).get(req.params.id, hostel.id);

        if (!student) return res.status(404).json({ error: 'Resident not found in your hostel' });

        const complaints = db.prepare(`
            SELECT * FROM complaints 
            WHERE student_id = ? AND hostel_id = ? 
            ORDER BY created_at DESC
        `).all(student.id, hostel.id);

        const visitors = db.prepare(`
            SELECT * FROM visitors 
            WHERE student_id = ? AND hostel_id = ? 
            ORDER BY in_time DESC
        `).all(student.id, hostel.id);

        const penalties = db.prepare(`
            SELECT * FROM penalties 
            WHERE student_id = ? AND hostel_id = ? 
            ORDER BY created_at DESC
        `).all(student.id, hostel.id);

        res.json({
            resident: student,
            complaints,
            visitors,
            penalties
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/visitors/in', (req, res) => {
    const { visitor_name, relation, id_proof, student_id, purpose, override_reason } = req.body;
    if (!visitor_name || !relation || !id_proof || !student_id || !purpose) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.status(400).json({ error: 'No hostel assigned' });

        const studentAlloc = db.prepare(`
            SELECT a.id FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE a.student_id = ? AND a.status = 'Active' AND r.hostel_id = ?
        `).get(student_id, hostel.id);

        if (!studentAlloc) {
            return res.status(400).json({ error: 'Student does not have an active room allocation in this hostel.' });
        }

        const currentHour = new Date().getHours();
        if ((currentHour < 9 || currentHour >= 19) && !override_reason) {
            return res.status(400).json({
                error: 'Current time is outside visiting hours (09:00 - 19:00). An override reason is required (BR-08).'
            });
        }

        const passCode = `VPASS-${Math.floor(100000 + Math.random() * 900000)}`;

        const ins = db.prepare(`
            INSERT INTO visitors (hostel_id, visitor_name, relation, id_proof, student_id, purpose, pass_code, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(hostel.id, visitor_name.trim(), relation.trim(), id_proof.trim(), student_id, purpose.trim(), passCode, req.session.user.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'VISITOR_ENTRY',
            `Visitor ${visitor_name} checked in (Pass: ${passCode}) to visit Student #${student_id}.`,
            student_id,
            hostel.id
        );

        res.json({
            success: true,
            visitorId: ins.lastInsertRowid,
            passCode,
            message: 'Visitor entry recorded successfully.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/visitors/:id/out', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        const vis = db.prepare("SELECT * FROM visitors WHERE id = ?").get(req.params.id);
        db.prepare("UPDATE visitors SET out_time = CURRENT_TIMESTAMP WHERE id = ? AND out_time IS NULL").run(req.params.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'VISITOR_EXIT',
            `Visitor ${vis ? vis.visitor_name : '#' + req.params.id} checked out.`,
            vis ? vis.student_id : null,
            hostel ? hostel.id : null
        );
        res.json({ success: true, message: 'Visitor exit recorded.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Hostel Specific Activity Logs
router.get('/activity-logs', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const { q, category } = req.query;
        let sql = 'SELECT * FROM audit_logs WHERE (hostel_id = ? OR user_id = ?)';
        const params = [hostel.id, req.session.user.id];

        if (category && category !== 'ALL') {
            sql += ' AND action LIKE ?';
            params.push(`${category}%`);
        }
        if (q && q.trim()) {
            sql += ' AND (action LIKE ? OR details LIKE ? OR user_email LIKE ?)';
            const term = `%${q.trim()}%`;
            params.push(term, term, term);
        }

        sql += ' ORDER BY created_at DESC LIMIT 150';

        const logs = db.prepare(sql).all(...params);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Warden Penalties & Fines Management
router.get('/penalties', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const penalties = db.prepare(`
            SELECT 
                p.*,
                s.full_name as student_name, s.enrollment_no, s.mobile,
                r.room_no, b.bed_no,
                u.email as imposed_by_email,
                w.email as waived_by_email
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            LEFT JOIN allocations a ON p.allocation_id = a.id
            LEFT JOIN beds b ON a.bed_id = b.id
            LEFT JOIN rooms r ON b.room_id = r.id
            LEFT JOIN users u ON p.imposed_by = u.id
            LEFT JOIN users w ON p.waived_by = w.id
            WHERE p.hostel_id = ? OR r.hostel_id = ?
            ORDER BY p.id DESC
        `).all(hostel.id, hostel.id);

        res.json(penalties);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties', (req, res) => {
    const { student_id, category, title, description, amount, due_date } = req.body;
    if (!student_id || !category || !title || !amount || !due_date) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.status(400).json({ error: 'No hostel assigned.' });

        const resident = db.prepare(`
            SELECT s.id, s.full_name, s.enrollment_no, a.id as allocation_id
            FROM students s
            JOIN allocations a ON s.id = a.student_id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE s.id = ? AND r.hostel_id = ? AND a.status = 'Active'
        `).get(student_id, hostel.id);

        if (!resident) {
            return res.status(400).json({ error: 'Selected student does not have an active bed in this hostel.' });
        }

        const ins = db.prepare(`
            INSERT INTO penalties (student_id, allocation_id, hostel_id, category, title, description, amount, due_date, status, imposed_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?)
        `).run(
            student_id,
            resident.allocation_id,
            hostel.id,
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
            `Warden levied ₹${amount} penalty (${category}: ${title.trim()}) on ${resident.full_name} (${resident.enrollment_no}).`,
            student_id,
            hostel.id
        );

        res.json({ success: true, penaltyId: ins.lastInsertRowid, message: `Penalty of ₹${amount} successfully applied to ${resident.full_name}.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties/:id/record-payment', (req, res) => {
    const { amount, mode, transaction_ref } = req.body;
    try {
        const hostel = getWardenHostel(req.session.user.id);
        const penalty = db.prepare(`
            SELECT p.*, s.full_name
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            WHERE p.id = ? AND p.hostel_id = ?
        `).get(req.params.id, hostel.id);

        if (!penalty) return res.status(404).json({ error: 'Penalty record not found in this hostel.' });
        if (penalty.status === 'Paid') return res.status(400).json({ error: 'Penalty has already been paid.' });
        if (penalty.status === 'Waived') return res.status(400).json({ error: 'Penalty has been waived.' });

        const payAmount = amount ? parseFloat(amount) : penalty.amount;
        const ref = transaction_ref || `OFFLINE-WARDEN-${Date.now()}`;

        db.prepare(`
            UPDATE penalties 
            SET status = 'Paid', paid_at = CURRENT_TIMESTAMP, payment_mode = ?, transaction_ref = ?
            WHERE id = ?
        `).run(mode || 'Cash', ref, penalty.id);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'PENALTY_PAID_RECORD',
            `Warden recorded ₹${payAmount} payment (${mode || 'Cash'}) for Penalty #${penalty.id} for ${penalty.full_name}.`,
            penalty.student_id,
            hostel.id
        );

        res.json({ success: true, message: 'Penalty payment recorded successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/penalties/:id/waive', (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Reason for waiving is mandatory.' });
    }

    try {
        const hostel = getWardenHostel(req.session.user.id);
        const penalty = db.prepare(`
            SELECT p.*, s.full_name 
            FROM penalties p
            JOIN students s ON p.student_id = s.id
            WHERE p.id = ? AND p.hostel_id = ?
        `).get(req.params.id, hostel.id);

        if (!penalty) return res.status(404).json({ error: 'Penalty record not found in this hostel.' });
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
            `Warden waived Penalty #${penalty.id} (₹${penalty.amount}, ${penalty.title}) for ${penalty.full_name}. Reason: "${reason.trim()}".`,
            penalty.student_id,
            hostel.id
        );

        res.json({ success: true, message: 'Penalty waived successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
