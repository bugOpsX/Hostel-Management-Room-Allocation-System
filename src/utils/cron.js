const db = require('../db');
const { logAudit } = require('./audit');

/**
 * Executes automated background maintenance tasks:
 * 1. Auto-transitions unpaid fees past due_date to 'Overdue' (FR-43).
 * 2. Auto-escalates unresolved complaints older than 72 hours to 'High' priority (BR-10, FR-57).
 */
function runDailyMaintenanceTasks() {
    let overdueCount = 0;
    let escalatedCount = 0;

    try {
        // 1. Fee Auto-Overdue Transition (FR-43)
        const overdueFees = db.prepare(`
            SELECT f.id, f.amount, f.due_date, a.student_id, r.hostel_id
            FROM fees f
            JOIN allocations a ON f.allocation_id = a.id
            JOIN beds b ON a.bed_id = b.id
            JOIN rooms r ON b.room_id = r.id
            WHERE f.status = 'Unpaid' AND date(f.due_date) < date('now')
        `).all();

        if (overdueFees.length > 0) {
            const overdueTx = db.transaction(() => {
                const updateStmt = db.prepare("UPDATE fees SET status = 'Overdue' WHERE id = ?");
                for (const f of overdueFees) {
                    updateStmt.run(f.id);
                    logAudit(
                        null,
                        'SYSTEM_DAEMON',
                        'FEE_OVERDUE_AUTO',
                        `Fee invoice #${f.id} (₹${f.amount}, Due: ${f.due_date}) automatically marked Overdue (FR-43).`,
                        f.student_id,
                        f.hostel_id
                    );
                }
            });
            overdueTx();
            overdueCount = overdueFees.length;
            console.log(`[Cron Daemon] Transitioned ${overdueCount} fee invoices to Overdue (FR-43).`);
        }

        // 2. 72-Hour Complaint SLA Escalation (BR-10, FR-57)
        const escalatedComplaints = db.prepare(`
            SELECT c.id, c.category, c.student_id, c.hostel_id
            FROM complaints c
            WHERE c.status != 'Resolved' 
              AND c.priority != 'High'
              AND datetime(c.created_at, '+72 hours') <= datetime('now')
        `).all();

        if (escalatedComplaints.length > 0) {
            const escTx = db.transaction(() => {
                const updateComp = db.prepare("UPDATE complaints SET priority = 'High' WHERE id = ?");
                for (const c of escalatedComplaints) {
                    updateComp.run(c.id);
                    logAudit(
                        null,
                        'SYSTEM_DAEMON',
                        'COMPLAINT_ESCALATED',
                        `Complaint #${c.id} (${c.category}) automatically elevated to High priority after exceeding 72h SLA (BR-10, FR-57).`,
                        c.student_id,
                        c.hostel_id
                    );
                }
            });
            escTx();
            escalatedCount = escalatedComplaints.length;
            console.log(`[Cron Daemon] Escalated ${escalatedCount} complaints to High priority (BR-10).`);
        }
    } catch (err) {
        console.error('[Cron Daemon Error]:', err.message);
    }

    return { overdueCount, escalatedCount };
}

/**
 * Starts background timer daemon.
 * @param {number} intervalMs - Frequency in ms (defaults to 1 hour).
 */
function startCronDaemon(intervalMs = 60 * 60 * 1000) {
    // Initial run on server start
    runDailyMaintenanceTasks();

    const timer = setInterval(runDailyMaintenanceTasks, intervalMs);
    // Unref allows Node process to terminate if only timer is left (ideal for tests)
    if (timer.unref) timer.unref();

    return timer;
}

function stopCronDaemon(timer) {
    if (timer) {
        clearInterval(timer);
        console.log('[Cron Daemon] Background maintenance daemon stopped.');
    }
}

module.exports = {
    runDailyMaintenanceTasks,
    startCronDaemon,
    stopCronDaemon
};
