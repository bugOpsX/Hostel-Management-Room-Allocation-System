# HMRAS Production Deployment Guide

This guide details the production deployment, security hardening, monitoring, and backup procedures for the **Hostel Management & Resource Allocation System (HMRAS)**.

---

## 🏗️ Architecture Overview

- **Runtime**: Node.js (v20+ or v22 LTS recommended)
- **Framework**: Express 5
- **Database**: SQLite 3 with `better-sqlite3` in **WAL (Write-Ahead Logging)** mode
- **Process Manager**: Docker / PM2 / Systemd
- **Reverse Proxy**: Nginx (with SSL/TLS termination)
- **Security**: Helmet CSP, Rate Limiting, HTTP-only SameSite sessions, Non-root containers

---

## 🚀 Option 1: Docker & Docker Compose (Recommended)

Docker provides an isolated, reproducible container environment with zero manual dependency compilation.

### 1. Configure Environment
Create `.env` based on [.env.example](file:///media/bugopsx/A/WORKSHOP/hostel-management/.env.example):
```bash
cp .env.example .env
```
Generate a strong 64-character secret and update `.env`:
```bash
openssl rand -hex 32
```
Edit `.env`:
```ini
NODE_ENV=production
PORT=3000
SESSION_SECRET=YOUR_GENERATED_64_CHAR_SECRET
DB_PATH=/app/data/hostel.db
BACKUP_DIR=/app/backups
COOKIE_SECURE=true
```

### 2. Build and Run Container
```bash
docker compose up -d --build
```

### 3. Verify Deployment
```bash
docker compose ps
docker compose logs -f
curl http://localhost:3000/api/health
```

### 4. Seed Initial Accounts in Docker (First Time Only)
```bash
docker compose exec hmras-app npm run seed
```

---

## ⚡ Option 2: Bare Metal / VPS Deployment with PM2 & Systemd

For hosting directly on an Ubuntu/Debian/CentOS server or VM.

### 1. Prerequisites
```bash
# Node.js 20 or 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# Global PM2 process manager
sudo npm install -g pm2
```

### 2. Install Project Dependencies
```bash
cd /var/www/hostel-management
npm ci --omit=dev
```

### 3. Configure Production Environment
```bash
cp .env.example .env
nano .env # Set SESSION_SECRET, PORT, and COOKIE_SECURE
```

### 4. Seed Database
```bash
npm run seed
```

### 5. Launch with PM2
```bash
# Start via PM2 ecosystem configuration
pm2 start ecosystem.config.js --env production

# Persist PM2 across server reboots
pm2 save
pm2 startup
```

### 6. Alternative: Run as a Systemd Service
Copy the provided unit template to `/etc/systemd/system/`:
```bash
sudo cp deploy/hmras.service /etc/systemd/system/hmras.service
sudo systemctl daemon-reload
sudo systemctl enable hmras
sudo systemctl start hmras
sudo systemctl status hmras
```

---

## 🔒 Option 3: Nginx Reverse Proxy with HTTPS (SSL)

Place the template configuration into Nginx:
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/hmras.conf
sudo ln -s /etc/nginx/sites-available/hmras.conf /etc/nginx/sites-enabled/
```
Edit server domain names in `/etc/nginx/sites-available/hmras.conf`:
```nginx
server_name hostel.youruniversity.edu;
```

Install free SSL certificates via Certbot / Let's Encrypt:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d hostel.youruniversity.edu
sudo nginx -t && sudo systemctl reload nginx
```

---

## 💾 Automated Database Backups & Recovery

HMRAS uses SQLite's non-blocking online backup API (`better-sqlite3` `.backup()`), allowing snapshots to be captured without locking readers or writers.

### 1. Trigger Manual Backup
```bash
npm run backup
```
Backups are archived into `./backups/hostel-backup-YYYY-MM-DD-HHmmss.db`. The utility automatically enforces a retention policy, pruning files older than the 10 most recent snapshots.

### 2. Schedule Daily Automated Backup via Cron
Open root crontab:
```bash
sudo crontab -e
```
Add daily backup at 03:00 AM:
```cron
0 3 * * * cd /var/www/hostel-management && /usr/bin/npm run backup >> /var/log/hmras-backup.log 2>&1
```

### 3. Restore from Backup
To restore from any snapshot:
1. Stop the application:
   ```bash
   pm2 stop hmras-hostel-system # or docker compose stop
   ```
2. Replace `hostel.db` with the target backup:
   ```bash
   cp backups/hostel-backup-2026-11-26T13-55-31-546Z.db hostel.db
   rm -f hostel.db-wal hostel.db-shm
   ```
3. Restart the application:
   ```bash
   pm2 start hmras-hostel-system # or docker compose start
   ```

---

## 🛡️ Production Security Checklist

| Check | Implemented Safeguard |
| :--- | :--- |
| **Brute-Force Protection** | Rate limiting (`express-rate-limit`) on login & password reset routes (30 requests / 15 mins). |
| **Account Lockout (FR-05)** | Automatic 15-minute account lock after 5 consecutive failed credentials. |
| **Inactivity Expiration (FR-07)** | 20-minute idle session destruction with `SameSite=lax` and `HttpOnly`. |
| **Security Headers** | Helmet with Content-Security-Policy, anti-clickjacking, and MIME sniffing protection. |
| **Data Integrity** | Foreign key constraints enforced (`PRAGMA foreign_keys = ON`), WAL journal mode (`PRAGMA journal_mode = WAL`), and zero build-step asset delivery. |
| **Health Monitoring** | Automated `/api/health` monitoring endpoint for uptime checks. |
| **Audit Compliance (FR-82)** | Immutable append-only `audit_logs` tracking every allocation, fee payment, visitor check-in, and penalty waiver. |

---

## 🩺 Monitoring & Health Checks

Query the health status anytime:
```bash
curl -i http://localhost:3000/api/health
```
Expected output:
```json
{
  "status": "ok",
  "service": "HMRAS - Hostel Management System",
  "uptime": 3600,
  "timestamp": "2026-11-26T14:00:00.000Z",
  "environment": "production"
}
```
If the database connection encounters an error, the response returns HTTP status `503 Service Unavailable`.
