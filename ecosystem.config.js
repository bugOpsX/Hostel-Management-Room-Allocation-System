/**
 * PM2 Production Ecosystem Configuration for HMRAS
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save
 *   pm2 startup
 */
module.exports = {
  apps: [{
    name: 'hmras-hostel-system',
    script: 'src/server.js',
    instances: 1, // Single instance recommended for SQLite WAL mode concurrency
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '450M',
    time: true,
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      COOKIE_SECURE: 'true'
    }
  }]
};
