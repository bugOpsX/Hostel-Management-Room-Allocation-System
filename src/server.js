require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');

// Ensure db is loaded
const db = require('./db');
const { startCronDaemon, stopCronDaemon } = require('./utils/cron');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const wardenRoutes = require('./routes/warden');
const studentRoutes = require('./routes/student');
const noticeRoutes = require('./routes/notices');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Reverse proxy support (for Nginx, Docker, Cloudflare)
app.set('trust proxy', 1);

// Security Headers (Helmet with customized CSP for Bootstrap & CDNs)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// Gzip/Deflate compression for fast static asset and JSON delivery
app.use(compression());

// Body parsers with payload size guard
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Rate Limiting (Protects authentication routes from brute force / credential stuffing)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // 30 attempts per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1200, // 1200 requests per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again shortly.' }
});

// Session setup (FR-07, NFR-08: 20 minutes inactivity expiration)
if (isProduction && !process.env.SESSION_SECRET) {
    console.warn('⚠️ WARNING: SESSION_SECRET is not set in production! Please define SESSION_SECRET in your .env file.');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'hmras-secret-key-2026-safe',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 20 * 60 * 1000, // 20 minutes
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction && process.env.COOKIE_SECURE !== 'false'
    }
}));

// Apply Rate Limits
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api', apiLimiter);

// Health Check & Uptime Monitoring Endpoint (for Docker/K8s/Load Balancers)
app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({
            status: 'ok',
            service: 'HMRAS - Hostel Management System',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (err) {
        res.status(503).json({ status: 'unhealthy', error: err.message });
    }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/warden', wardenRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/notices', noticeRoutes);

// Static files (Bootstrap 5 Frontend)
app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: isProduction ? '1h' : '0'
}));

// Fallback route for SPA/client routing
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global Error Handler (Sanitizes error details in production to prevent information leakage)
app.use((err, req, res, next) => {
    console.error('[Unhandled Server Error]:', err);
    const errorResponse = isProduction 
        ? { error: 'Internal Server Error. Please contact support.' }
        : { error: 'Internal Server Error: ' + err.message };
    res.status(500).json(errorResponse);
});

let server = null;
let cronTimer = null;

if (require.main === module) {
    // Start background maintenance cron daemon (FR-43, BR-10)
    cronTimer = startCronDaemon();

    server = app.listen(PORT, () => {
        console.log(`🚀 HMRAS Server running at http://localhost:${PORT}`);
        console.log(`🔒 Mode: ${process.env.NODE_ENV || 'development'} | Trust Proxy: enabled | WAL Concurrency: enabled`);
    });

    // Graceful Shutdown on termination signals
    function gracefulShutdown(signal) {
        console.log(`\n[Process] Received ${signal}. Initiating graceful shutdown...`);
        stopCronDaemon(cronTimer);

        if (server) {
            server.close(() => {
                console.log('[Process] HTTP server closed.');
                try {
                    db.pragma('wal_checkpoint(TRUNCATE)');
                    db.close();
                    console.log('[Process] SQLite database flushed and closed cleanly.');
                } catch (e) {
                    console.error('[Process] Error closing database:', e.message);
                }
                process.exit(0);
            });

            // Force termination if connections hang
            setTimeout(() => {
                console.error('[Process] Forcefully terminating after shutdown timeout.');
                process.exit(1);
            }, 6000).unref();
        } else {
            process.exit(0);
        }
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = app;
