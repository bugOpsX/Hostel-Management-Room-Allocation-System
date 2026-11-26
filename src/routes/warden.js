const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireWarden } = require('../middleware/auth');

router.use(requireWarden);

// Helper to get warden's assigned hostel
function getWardenHostel(userId) {
    return db.prepare('SELECT * FROM hostels WHERE warden_id = ?').get(userId);
}

// 1. Warden Dashboard
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

        const openComplaints = db.prepare(`
            SELECT COUNT(*) as count FROM complaints 
            WHERE hostel_id = ? AND status != 'Resolved'
        `).get(hostel.id).count;

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

        res.json({
            assigned: true,
            hostel,
            bedStats,
            openComplaints,
            pendingRequests,
            activeVisitors
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Complaints Management (FR-54)
router.get('/complaints', (req, res) => {
    try {
        const hostel = getWardenHostel(req.session.user.id);
        if (!hostel) return res.json([]);

        const complaints = db.prepare(`
            SELECT 
                c.*,
                s.full_name as student_name, s.enrollment_no, s.mobile,
                r.room_no, b.bed_no
            FROM complaints c
            JOIN students s ON c.student_id = s.id
            LEFT JOIN allocations a ON s.id = a.student_id AND a.status = 'Active'
            LEFT JOIN beds b ON a.bed_id = b.id
            LEFT JOIN rooms r ON b.room_id = r.id
            WHERE c.hostel_id = ?
            ORDER BY 
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
            SELECT req.id FROM room_requests req
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

        res.json({ success: true, message: 'Recommendation submitted for Administrator review.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Visitor Entry and Exit (FR-59 to FR-63)
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

        res.json(visitors);
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

        // Verify student has active allocation in this hostel
        const studentAlloc = db.prepare(`
            SELECT a.id FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE a.student_id = ? AND a.status = 'Active' AND r.hostel_id = ?
        `).get(student_id, hostel.id);

        if (!studentAlloc) {
            return res.status(400).json({ error: 'Student does not have an active room allocation in this hostel.' });
        }

        // Check visiting hours (09:00 to 19:00) per BR-08
        const currentHour = new Date().getHours();
        if ((currentHour < 9 || currentHour >= 19) && !override_reason) {
            return res.status(400).json({
                error: 'Current time is outside visiting hours (09:00 - 19:00). An override reason is required (BR-08).'
            });
        }

        db.prepare(`
            INSERT INTO visitors (hostel_id, visitor_name, relation, id_proof, student_id, purpose, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hostel.id, visitor_name.trim(), relation.trim(), id_proof.trim(), student_id, purpose.trim(), req.session.user.id);

        res.json({ success: true, message: 'Visitor entry recorded.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/visitors/:id/out', (req, res) => {
    try {
        db.prepare("UPDATE visitors SET out_time = CURRENT_TIMESTAMP WHERE id = ? AND out_time IS NULL").run(req.params.id);
        res.json({ success: true, message: 'Visitor exit recorded.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
