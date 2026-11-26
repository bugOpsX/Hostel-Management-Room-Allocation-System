const db = require('../db');

function logAudit(userId, userEmail, action, details) {
    try {
        db.prepare(`
            INSERT INTO audit_logs (user_id, user_email, action, details)
            VALUES (?, ?, ?, ?)
        `).run(userId || null, userEmail || 'System', action, typeof details === 'object' ? JSON.stringify(details) : details);
    } catch (err) {
        console.error('Audit logging error:', err);
    }
}

module.exports = { logAudit };
