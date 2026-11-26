const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/notices - Fetch unexpired/recent notices
router.get('/', (req, res) => {
    try {
        const notices = db.prepare(`
            SELECT n.*, u.email as author_email, h.name as hostel_name
            FROM notices n
            JOIN users u ON n.created_by = u.id
            LEFT JOIN hostels h ON n.hostel_id = h.id
            ORDER BY n.created_at DESC
            LIMIT 20
        `).all();
        res.json(notices);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/notices - Admin or Warden (FR-64)
router.post('/', requireAuth, (req, res) => {
    const { title, body, hostel_id } = req.body;
    const user = req.session.user;

    if (!['admin', 'warden'].includes(user.role)) {
        return res.status(403).json({ error: 'Only Administrators and Wardens can post notices.' });
    }
    if (!title || !body) {
        return res.status(400).json({ error: 'Title and body are required.' });
    }

    try {
        let targetHostel = hostel_id ? parseInt(hostel_id, 10) : null;
        if (user.role === 'warden') {
            const assignedHostel = db.prepare('SELECT id FROM hostels WHERE warden_id = ?').get(user.id);
            if (!assignedHostel) {
                return res.status(400).json({ error: 'You do not have a hostel assigned to post notices for.' });
            }
            targetHostel = assignedHostel.id; // Warden restricted to own hostel (FR-64)
        }

        db.prepare(`
            INSERT INTO notices (title, body, hostel_id, created_by)
            VALUES (?, ?, ?, ?)
        `).run(title.trim(), body.trim(), targetHostel, user.id);

        res.json({ success: true, message: 'Notice published successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/notices/:id
router.delete('/:id', requireAuth, (req, res) => {
    const user = req.session.user;
    if (!['admin', 'warden'].includes(user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
        if (!notice) return res.status(404).json({ error: 'Notice not found' });

        if (user.role !== 'admin' && notice.created_by !== user.id) {
            return res.status(403).json({ error: 'You can only delete your own notices' });
        }

        db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'Notice deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
