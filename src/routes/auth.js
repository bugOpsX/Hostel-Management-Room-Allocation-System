const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

// POST /api/auth/register (Student self-registration per FR-01, FR-02, FR-03)
router.post('/register', (req, res) => {
    const {
        enrollment_no, full_name, email, password,
        gender, department, year_of_study, mobile, guardian_contact
    } = req.body;

    if (!enrollment_no || !full_name || !email || !password || !gender || !department || !year_of_study || !mobile || !guardian_contact) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and digits.' });
    }

    if (!/^\d{10}$/.test(mobile.trim())) {
        return res.status(400).json({ error: 'Mobile number must be a valid 10-digit number.' });
    }

    try {
        // Check uniqueness of email and enrollment_no
        const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
        if (existingUser) {
            return res.status(400).json({ error: 'An account with this email address already exists.' });
        }

        const existingStudent = db.prepare('SELECT id FROM students WHERE enrollment_no = ?').get(enrollment_no.trim());
        if (existingStudent) {
            return res.status(400).json({ error: 'An account with this enrollment number already exists.' });
        }

        const password_hash = bcrypt.hashSync(password, 10);

        // Atomic transaction: create user + student profile
        const registerTx = db.transaction(() => {
            const userRes = db.prepare(`
                INSERT INTO users (email, password_hash, role, status)
                VALUES (?, ?, 'student', 'pending')
            `).run(email.trim().toLowerCase(), password_hash);

            const userId = userRes.lastInsertRowid;

            db.prepare(`
                INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId, enrollment_no.trim(), full_name.trim(), gender,
                department.trim(), parseInt(year_of_study, 10), mobile.trim(), guardian_contact.trim()
            );

            return userId;
        });

        registerTx();

        res.json({
            success: true,
            message: 'Registration successful! Your account is pending verification by an Administrator.'
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed: ' + err.message });
    }
});

// POST /api/auth/login (FR-04)
router.post('/login', (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({ error: 'Identifier (email or enrollment number) and password are required.' });
    }

    try {
        // Look up by email first, or by student enrollment number
        let user = db.prepare('SELECT * FROM users WHERE email = ?').get(identifier.trim().toLowerCase());

        if (!user) {
            const student = db.prepare('SELECT user_id FROM students WHERE enrollment_no = ?').get(identifier.trim());
            if (student) {
                user = db.prepare('SELECT * FROM users WHERE id = ?').get(student.user_id);
            }
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const match = bcrypt.compareSync(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Your account is pending verification by an Administrator.' });
        }

        if (user.status === 'inactive') {
            return res.status(403).json({ error: 'Your account has been deactivated. Please contact hostel office.' });
        }

        let studentInfo = null;
        let hostelInfo = null;

        if (user.role === 'student') {
            studentInfo = db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id);
        } else if (user.role === 'warden') {
            hostelInfo = db.prepare('SELECT * FROM hostels WHERE warden_id = ?').get(user.id);
        }

        // Store session
        req.session.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            student: studentInfo,
            hostel: hostelInfo
        };

        res.json({
            success: true,
            user: req.session.user,
            redirect: user.role === 'admin' ? '/admin.html' : (user.role === 'warden' ? '/warden.html' : '/student.html')
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed: ' + err.message });
    }
});

// POST /api/auth/logout (FR-07)
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Could not log out' });
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ authenticated: false });
    }
    // Refresh student/hostel data dynamically
    const user = db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').get(req.session.user.id);
    let student = null;
    let hostel = null;
    if (user.role === 'student') {
        student = db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id);
    } else if (user.role === 'warden') {
        hostel = db.prepare('SELECT * FROM hostels WHERE warden_id = ?').get(user.id);
    }

    req.session.user = { ...user, student, hostel };
    res.json({ authenticated: true, user: req.session.user });
});

module.exports = router;
