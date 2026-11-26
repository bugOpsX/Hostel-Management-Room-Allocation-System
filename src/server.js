const express = require('express');
const session = require('express-session');
const path = require('path');

// Ensure db is loaded
require('./db');
const { startCronDaemon } = require('./utils/cron');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const wardenRoutes = require('./routes/warden');
const studentRoutes = require('./routes/student');
const noticeRoutes = require('./routes/notices');

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup (FR-07, NFR-08: 20 minutes inactivity expiration)
app.use(session({
    secret: process.env.SESSION_SECRET || 'hmras-secret-key-2026-safe',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 20 * 60 * 1000, // 20 minutes
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/warden', wardenRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/notices', noticeRoutes);

// Static files (Clean Bootstrap UI)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Fallback route for SPA/client routing
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'Internal Server Error: ' + err.message });
});

if (require.main === module) {
    // Start background maintenance cron daemon (FR-43, BR-10)
    startCronDaemon();

    app.listen(PORT, () => {
        console.log(`🚀 HMRAS Server running at http://localhost:${PORT}`);
        console.log(`Ready for evaluation and production use.`);
    });
}

module.exports = app;
