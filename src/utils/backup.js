/**
 * Automated Hot Backup Utility for HMRAS
 * Uses SQLite's online backup API to take non-blocking, zero-downtime snapshots.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function createBackup(backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups')) {
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `hostel-backup-${timestamp}.db`;
    const backupFilePath = path.join(backupDir, backupFileName);

    console.log(`[Backup] Initiating safe hot backup to ${backupFilePath}...`);
    await db.backup(backupFilePath);

    const stats = fs.statSync(backupFilePath);
    console.log(`[Backup] ✅ Backup successfully created: ${backupFileName} (${(stats.size / 1024).toFixed(1)} KB)`);

    // Retention policy: keep the 10 most recent backups
    const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('hostel-backup-') && f.endsWith('.db'))
        .sort()
        .reverse();

    if (files.length > 10) {
        for (const oldFile of files.slice(10)) {
            fs.unlinkSync(path.join(backupDir, oldFile));
            console.log(`[Backup] Pruned old backup archive: ${oldFile}`);
        }
    }

    return { filePath: backupFilePath, fileName: backupFileName, sizeBytes: stats.size };
}

if (require.main === module) {
    createBackup()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[Backup Error]:', err);
            process.exit(1);
        });
}

module.exports = { createBackup };
