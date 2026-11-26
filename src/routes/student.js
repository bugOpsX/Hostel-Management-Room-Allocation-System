const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireStudent } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

router.use(requireStudent);

function getStudent(userId) {
    return db.prepare('SELECT * FROM students WHERE user_id = ?').get(userId);
}

// 1. Student Dashboard (FR-08, FR-71)
router.get('/dashboard', (req, res) => {
    try {
        const student = getStudent(req.session.user.id);
        if (!student) return res.status(404).json({ error: 'Student record not found' });

        const allocation = db.prepare(`
            SELECT 
                a.id as allocation_id, a.start_date, a.status as allocation_status,
                b.id as bed_id, b.bed_no,
                r.id as room_id, r.room_no, r.floor, r.room_type,
                h.id as hostel_id, h.name as hostel_name, h.type as hostel_type
            FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            WHERE a.student_id = ? AND a.status = 'Active'
        `).get(student.id);

        const fees = db.prepare(`
            SELECT 
                f.*,
                p.mode as payment_mode, p.transaction_ref, p.paid_at
            FROM fees f
            JOIN allocations a ON f.allocation_id = a.id
            LEFT JOIN payments p ON f.id = p.fee_id
            WHERE a.student_id = ?
            ORDER BY f.id DESC
        `).all(student.id);

        const complaints = db.prepare(`
            SELECT * FROM complaints 
            WHERE student_id = ?
            ORDER BY created_at DESC
        `).all(student.id);

        const requests = db.prepare(`
            SELECT 
                req.*,
                h.name as preferred_hostel_name
            FROM room_requests req
            LEFT JOIN hostels h ON req.preferred_hostel_id = h.id
            WHERE req.student_id = ?
            ORDER BY req.created_at DESC
        `).all(student.id);

        const notices = db.prepare(`
            SELECT n.*, u.email as author_email
            FROM notices n
            JOIN users u ON n.created_by = u.id
            WHERE n.hostel_id IS NULL OR n.hostel_id = ?
            ORDER BY n.created_at DESC
            LIMIT 10
        `).all(allocation ? allocation.hostel_id : -1);

        // Activity timeline logs specific to this student
        const activityLogs = db.prepare(`
            SELECT * FROM audit_logs 
            WHERE student_id = ? OR user_id = ?
            ORDER BY created_at DESC
            LIMIT 30
        `).all(student.id, req.session.user.id);

        // Compute unread/pending badge counts
        const unpaidFeeCount = fees.filter(f => f.status !== 'Paid').length;
        const openComplaintCount = complaints.filter(c => c.status !== 'Resolved').length;
        const pendingRequestCount = requests.filter(r => r.status === 'Pending').length;

        res.json({
            profile: student,
            allocation: allocation || null,
            fees,
            complaints,
            requests,
            notices,
            activityLogs,
            badges: {
                unpaidFees: unpaidFeeCount,
                openComplaints: openComplaintCount,
                pendingRequests: pendingRequestCount,
                noticesCount: notices.length,
                totalAlerts: unpaidFeeCount + openComplaintCount + (allocation ? 0 : 1)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Submit Transfer or Vacate Request (FR-33, FR-34, FR-35)
router.post('/requests', (req, res) => {
    const { request_type, reason, preferred_hostel_id } = req.body;
    if (!['Transfer', 'Vacate'].includes(request_type)) {
        return res.status(400).json({ error: 'Request type must be Transfer or Vacate.' });
    }
    if (!reason || reason.trim().length < 5) {
        return res.status(400).json({ error: 'Please provide a valid reason.' });
    }

    try {
        const student = getStudent(req.session.user.id);
        const allocation = db.prepare(`
            SELECT a.id, r.hostel_id 
            FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE a.student_id = ? AND a.status = 'Active'
        `).get(student.id);

        if (!allocation) {
            return res.status(400).json({ error: 'You do not have an active room allocation to request changes for.' });
        }

        const pending = db.prepare("SELECT id FROM room_requests WHERE student_id = ? AND status = 'Pending'").get(student.id);
        if (pending) {
            return res.status(400).json({ error: 'You already have a pending request awaiting review (FR-35).' });
        }

        const ins = db.prepare(`
            INSERT INTO room_requests (student_id, allocation_id, request_type, reason, preferred_hostel_id)
            VALUES (?, ?, ?, ?, ?)
        `).run(student.id, allocation.id, request_type, reason.trim(), preferred_hostel_id || null);

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'ROOM_REQUEST_SUBMITTED',
            `Student submitted ${request_type} request (#${ins.lastInsertRowid}): "${reason.trim()}"`,
            student.id,
            allocation.hostel_id
        );

        res.json({ success: true, message: `${request_type} request submitted successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Submit Complaint (FR-51, FR-52, FR-53)
router.post('/complaints', (req, res) => {
    const { category, description, priority } = req.body;
    const validCategories = ['Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Security', 'Other'];
    if (!validCategories.includes(category)) {
        return res.status(400).json({ error: 'Invalid complaint category.' });
    }
    if (!description || description.trim().length < 10) {
        return res.status(400).json({ error: 'Description must be at least 10 characters long (FR-51).' });
    }

    try {
        const student = getStudent(req.session.user.id);
        const alloc = db.prepare(`
            SELECT r.hostel_id 
            FROM allocations a
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE a.student_id = ? AND a.status = 'Active'
        `).get(student.id);

        if (!alloc) {
            return res.status(400).json({ error: 'Only residents with active room allocations can submit complaints (FR-53).' });
        }

        const compRes = db.prepare(`
            INSERT INTO complaints (student_id, hostel_id, category, description, priority, status)
            VALUES (?, ?, ?, ?, ?, 'Open')
        `).run(student.id, alloc.hostel_id, category, description.trim(), priority || 'Medium');

        logAudit(
            req.session.user.id,
            req.session.user.email,
            'COMPLAINT_FILED',
            `Registered maintenance complaint #${compRes.lastInsertRowid} (${category}) with priority ${priority || 'Medium'}.`,
            student.id,
            alloc.hostel_id
        );

        res.json({
            success: true,
            complaintId: compRes.lastInsertRowid,
            message: `Complaint #${compRes.lastInsertRowid} registered successfully (Status: Open).`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Pay Fee Online (FR-47)
router.post('/fees/:id/pay', (req, res) => {
    try {
        const student = getStudent(req.session.user.id);
        const fee = db.prepare(`
            SELECT f.*, r.hostel_id FROM fees f
            JOIN allocations a ON f.allocation_id = a.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE f.id = ? AND a.student_id = ?
        `).get(req.params.id, student.id);

        if (!fee) return res.status(404).json({ error: 'Fee record not found.' });
        if (fee.status === 'Paid') return res.status(400).json({ error: 'Fee has already been paid.' });

        const txnRef = `PAY-ONLINE-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;

        const payTx = db.transaction(() => {
            db.prepare(`
                INSERT INTO payments (fee_id, amount, mode, transaction_ref)
                VALUES (?, ?, 'Online', ?)
            `).run(fee.id, fee.amount, txnRef);

            db.prepare("UPDATE fees SET status = 'Paid' WHERE id = ?").run(fee.id);

            logAudit(
                req.session.user.id,
                req.session.user.email,
                'FEE_PAYMENT',
                `Paid ₹${fee.amount} online for Fee #${fee.id} (${fee.term}) via gateway (Txn: ${txnRef}).`,
                student.id,
                fee.hostel_id
            );
        });

        payTx();
        res.json({
            success: true,
            transactionRef: txnRef,
            amount: fee.amount,
            message: `Payment of ₹${fee.amount} completed successfully.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
