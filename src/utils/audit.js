const db = require('../db');

function logAudit(userId, userEmail, action, details, studentId = null, hostelId = null) {
    try {
        db.prepare(`
            INSERT INTO audit_logs (user_id, user_email, action, details, student_id, hostel_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            userId || null,
            userEmail || 'System',
            action,
            typeof details === 'object' ? JSON.stringify(details) : details,
            studentId || null,
            hostelId || null
        );
    } catch (err) {
        console.error('Audit logging error:', err);
    }
}

module.exports = { logAudit };
