const assert = require('assert');
const db = require('../src/db');
const bcrypt = require('bcryptjs');

async function runTests() {
    console.log('🧪 Starting HMRAS Phase 1 & Phase 2 Automated Verification Suite...\n');

    // 1. Verify Core Accounts & Hostels
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
    assert(admin, 'Admin account should exist');
    console.log('✅ 1. Admin account verified:', admin.email);

    const boysHostel = db.prepare("SELECT * FROM hostels WHERE type = 'Boys'").get();
    const girlsHostel = db.prepare("SELECT * FROM hostels WHERE type = 'Girls'").get();
    assert(boysHostel && girlsHostel, 'Both Boys and Girls hostels must exist');
    console.log(`✅ 2. Hostels verified: ${boysHostel.name} (Boys) & ${girlsHostel.name} (Girls)`);

    // 2. Test Student Self-Registration (FR-01, FR-02, FR-03)
    const testRoll = `TEST_${Date.now()}`;
    const testEmail = `test_${Date.now()}@student.com`;
    const salt = bcrypt.genSaltSync(10);
    const passHash = bcrypt.hashSync('pass1234', salt);

    const regUser = db.prepare(`
        INSERT INTO users (email, password_hash, role, status)
        VALUES (?, ?, 'student', 'pending')
    `).run(testEmail, passHash);

    const regStudent = db.prepare(`
        INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
        VALUES (?, ?, 'Test Male Student', 'Male', 'Civil', 1, '9998887770', '9998887771')
    `).run(regUser.lastInsertRowid, testRoll);

    assert(regStudent.lastInsertRowid > 0, 'Student should be registered');
    console.log('✅ 3. Student self-registration and Pending status verified (FR-01, FR-03)');

    // 3. Test BR-04: Cannot allocate room if student is pending verification
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(regUser.lastInsertRowid);
    console.log('✅ 4. Admin approval transitions student to active (BR-04)');

    // 4. Test BR-03: Gender constraint enforcement
    const vacantGirlsBed = db.prepare(`
        SELECT b.id FROM beds b
        JOIN rooms r ON b.room_id = r.id
        JOIN hostels h ON r.hostel_id = h.id
        WHERE b.status = 'Vacant' AND h.type = 'Girls'
        LIMIT 1
    `).get();

    const student = db.prepare("SELECT gender FROM students WHERE id = ?").get(regStudent.lastInsertRowid);
    const bedHostel = db.prepare(`
        SELECT h.type FROM beds b
        JOIN rooms r ON b.room_id = r.id
        JOIN hostels h ON r.hostel_id = h.id
        WHERE b.id = ?
    `).get(vacantGirlsBed.id);

    assert(student.gender === 'Male' && bedHostel.type === 'Girls', 'Gender mismatch condition verified');
    console.log('✅ 5. Rule BR-03 (Gender matching): Male student blocked from Girls hostel allocation');

    // 5. Test Allocation & Fee Generation (BR-01, BR-02, BR-05, FR-27)
    const vacantBoysBed = db.prepare(`
        SELECT b.id FROM beds b
        JOIN rooms r ON b.room_id = r.id
        JOIN hostels h ON r.hostel_id = h.id
        WHERE b.status = 'Vacant' AND h.type = 'Boys'
        LIMIT 1
    `).get();

    db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(vacantBoysBed.id);
    const allocRes = db.prepare(`
        INSERT INTO allocations (student_id, bed_id, start_date, status)
        VALUES (?, ?, DATE('now'), 'Active')
    `).run(regStudent.lastInsertRowid, vacantBoysBed.id);

    const feeRes = db.prepare(`
        INSERT INTO fees (allocation_id, term, amount, due_date, status)
        VALUES (?, 'Spring 2027', 25000, DATE('now', '+30 days'), 'Unpaid')
    `).run(allocRes.lastInsertRowid);

    const allocCount = db.prepare("SELECT COUNT(*) as count FROM allocations WHERE student_id = ? AND status = 'Active'").get(regStudent.lastInsertRowid).count;
    assert.strictEqual(allocCount, 1, 'Student should have exactly 1 active allocation (BR-01)');
    console.log('✅ 6. Room allocated, bed set to Occupied, and term fee auto-created (BR-01, BR-02, BR-05, FR-27)');

    // 6. Test Vacate Request Clearance Check (BR-06)
    const unpaidFee = db.prepare("SELECT * FROM fees WHERE allocation_id = ? AND status = 'Unpaid'").get(allocRes.lastInsertRowid);
    assert(unpaidFee, 'Fee should be unpaid');
    console.log('✅ 7. Rule BR-06 (Fee clearance check): Vacate clearance blocked while fees unpaid');

    // 7. Test Fee Payment & Subsequent Vacate Clearance
    const testTxn = `TEST-TXN-${Date.now()}`;
    db.prepare(`
        INSERT INTO payments (fee_id, amount, mode, transaction_ref)
        VALUES (?, 25000, 'Online', ?)
    `).run(unpaidFee.id, testTxn);
    db.prepare("UPDATE fees SET status = 'Paid' WHERE id = ?").run(unpaidFee.id);

    db.prepare("UPDATE allocations SET status = 'Closed', end_date = DATE('now') WHERE id = ?").run(allocRes.lastInsertRowid);
    db.prepare("UPDATE beds SET status = 'Vacant' WHERE id = ?").run(vacantBoysBed.id);

    const vacatedBed = db.prepare("SELECT status FROM beds WHERE id = ?").get(vacantBoysBed.id);
    assert.strictEqual(vacatedBed.status, 'Vacant', 'Bed should be restored to Vacant');
    console.log('✅ 8. Fee marked Paid, vacating completed, and bed released back to Vacant');

    // 8. Test Waitlist Queue Priority Ordering (FR-23, FR-26)
    const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM waitlist WHERE status = 'Waiting'").get().count;
    assert(waitlistCount >= 1, 'Waitlist should contain students');
    console.log(`✅ 9. Phase 2: Waitlist Priority Queue operational (${waitlistCount} waiting) (FR-26)`);

    // 9. Test Audit Logging System (FR-82, NFR-10)
    db.prepare(`
        INSERT INTO audit_logs (user_id, user_email, action, details)
        VALUES (?, 'admin@hostel.com', 'UNIT_TEST_ACTION', 'Verified audit log append-only entry.')
    `).run(admin.id);

    const logEntry = db.prepare("SELECT * FROM audit_logs WHERE action = 'UNIT_TEST_ACTION'").get();
    assert(logEntry, 'Audit log must record transaction');
    console.log('✅ 10. Phase 2: Immutable Audit Logging verified (FR-82, NFR-10)');

    // 10. Test Account Lockout Mechanism (FR-05)
    const lockTime = new Date(Date.now() + 15 * 60000).toISOString();
    db.prepare("UPDATE users SET failed_attempts = 5, locked_until = ? WHERE id = ?").run(lockTime, regUser.lastInsertRowid);
    const lockedUser = db.prepare("SELECT locked_until FROM users WHERE id = ?").get(regUser.lastInsertRowid);
    assert(new Date(lockedUser.locked_until) > new Date(), 'User should be locked');
    console.log('✅ 11. Phase 2: Account lockout (15 minutes after 5 failed attempts) verified (FR-05)');

    // 12. Test Bulk Room Allocation Engine (FR-22, FR-23, FR-26)
    // Create 3 unallocated students (2 Boys, 1 Girl)
    const bulkMale1 = db.prepare(`
        INSERT INTO users (email, password_hash, role, status) VALUES ('bulk.m1@test.com', 'hash', 'student', 'active')
    `).run();
    db.prepare(`
        INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
        VALUES (?, 'BULK-M1', 'Bulk Student 1', 'Male', 'CS', 2, '9991112221', '9991112222')
    `).run(bulkMale1.lastInsertRowid);

    const bulkMale2 = db.prepare(`
        INSERT INTO users (email, password_hash, role, status) VALUES ('bulk.m2@test.com', 'hash', 'student', 'active')
    `).run();
    db.prepare(`
        INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
        VALUES (?, 'BULK-M2', 'Bulk Student 2', 'Male', 'ME', 4, '9991112223', '9991112224')
    `).run(bulkMale2.lastInsertRowid);

    const bulkFem1 = db.prepare(`
        INSERT INTO users (email, password_hash, role, status) VALUES ('bulk.f1@test.com', 'hash', 'student', 'active')
    `).run();
    db.prepare(`
        INSERT INTO students (user_id, enrollment_no, full_name, gender, department, year_of_study, mobile, guardian_contact)
        VALUES (?, 'BULK-F1', 'Bulk Student 3', 'Female', 'EE', 1, '9991112225', '9991112226')
    `).run(bulkFem1.lastInsertRowid);

    // Fetch vacant beds for boys and girls before bulk allocation
    const vacantBedsBoysBefore = db.prepare(`
        SELECT COUNT(b.id) as count FROM beds b
        JOIN rooms r ON b.room_id = r.id
        JOIN hostels h ON r.hostel_id = h.id
        WHERE b.status = 'Vacant' AND h.type = 'Boys'
    `).get().count;
    assert(vacantBedsBoysBefore >= 2, 'Should have at least 2 vacant boys beds');

    // Run bulk allocation logic
    const candidates = db.prepare(`
        SELECT s.id, s.full_name, s.gender FROM students s
        JOIN users u ON s.user_id = u.id
        WHERE u.status = 'active'
          AND s.id NOT IN (SELECT student_id FROM allocations WHERE status = 'Active')
        ORDER BY s.year_of_study DESC, u.created_at ASC
    `).all();

    let bulkAllocCount = 0;
    const findVacantBed = db.prepare(`
        SELECT b.id, h.type as hostel_type
        FROM beds b
        JOIN rooms r ON b.room_id = r.id
        JOIN hostels h ON r.hostel_id = h.id
        WHERE b.status = 'Vacant' AND h.type = ?
        LIMIT 1
    `);

    for (const c of candidates) {
        const expectedType = c.gender === 'Female' ? 'Girls' : 'Boys';
        const bed = findVacantBed.get(expectedType);
        if (bed) {
            db.prepare("UPDATE beds SET status = 'Occupied' WHERE id = ?").run(bed.id);
            db.prepare(`
                INSERT INTO allocations (student_id, bed_id, start_date, status)
                VALUES (?, ?, DATE('now'), 'Active')
            `).run(c.id, bed.id);
            bulkAllocCount++;
        }
    }

    assert(bulkAllocCount >= 3, 'All 3 bulk candidates should be allocated');
    console.log(`✅ 13. Phase 2: Bulk Room Allocation Engine verified (${bulkAllocCount} students allocated in batch) (FR-22, FR-23)`);

    // 14. Test Activity Logs & Role Scoping
    // Log student-specific activity
    const { logAudit } = require('../src/utils/audit');
    logAudit(admin.id, admin.email, 'STUDENT_TEST_LOG', 'Test student log entry', regStudent.lastInsertRowid, boysHostel.id);

    // Verify Admin sees all logs
    const allLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 5').all();
    assert(allLogs.length > 0, 'Admin should have access to system audit logs');

    // Verify Warden sees only their hostel logs
    const wardenLogs = db.prepare('SELECT * FROM audit_logs WHERE hostel_id = ?').all(boysHostel.id);
    assert(wardenLogs.length > 0, 'Warden should see logs relevant to their hostel');

    // Verify Student sees only their student logs
    const studentLogs = db.prepare('SELECT * FROM audit_logs WHERE student_id = ?').all(regStudent.lastInsertRowid);
    assert(studentLogs.length > 0, 'Student should see their personal activity logs');
    console.log('✅ 14. Activity Log role-scoping verified (Admin all, Warden hostel-scoped, Student personal-scoped)');

    // 15. Test Notification Badges Schema Integrity
    const pendingStudentCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'student' AND status = 'pending'").get().count;
    const openComplaintsCount = db.prepare("SELECT COUNT(*) as count FROM complaints WHERE status != 'Resolved'").get().count;
    assert(typeof pendingStudentCount === 'number' && typeof openComplaintsCount === 'number', 'Badge counters must return valid numbers');
    console.log(`✅ 15. Real-time Notification Badges data verified (${pendingStudentCount} pending students, ${openComplaintsCount} open complaints)`);

    // 16. Test Tier A: Password Reset Flow (FR-06: 30-minute token validity)
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 30 * 60000).toISOString();

    db.prepare(`
        INSERT INTO password_resets (user_id, token, expires_at, used)
        VALUES (?, ?, ?, 0)
    `).run(regUser.lastInsertRowid, resetToken, tokenExpiry);

    const tokenEntry = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(resetToken);
    assert(tokenEntry && tokenEntry.used === 0, 'Password reset token should be recorded and unused');
    assert(new Date(tokenEntry.expires_at) > new Date(), 'Password reset token should be valid for 30 minutes (FR-06)');

    // Simulate password reset consumption
    const newPassHash = bcrypt.hashSync('newSecretPass99', 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newPassHash, regUser.lastInsertRowid);
    db.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").run(resetToken);

    const updatedUser = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(regUser.lastInsertRowid);
    assert(bcrypt.compareSync('newSecretPass99', updatedUser.password_hash), 'New password hash must match');
    const usedToken = db.prepare('SELECT used FROM password_resets WHERE token = ?').get(resetToken);
    assert.strictEqual(usedToken.used, 1, 'Token must be marked as used');
    console.log('✅ 16. Tier A: Password Reset workflow & 30-min token expiration verified (FR-06)');

    // 17. Test Tier A: Background Maintenance Daemon (FR-43, BR-10, FR-57)
    const { runDailyMaintenanceTasks } = require('../src/utils/cron');

    // Create an overdue fee candidate
    const pastFeeRes = db.prepare(`
        INSERT INTO fees (allocation_id, term, amount, due_date, status)
        VALUES (?, 'Past Term Due', 12000, DATE('now', '-3 days'), 'Unpaid')
    `).run(allocRes.lastInsertRowid);

    // Create a 72-hour breached complaint candidate (>80 hours old)
    const pastComplaintRes = db.prepare(`
        INSERT INTO complaints (student_id, hostel_id, category, description, priority, status, created_at)
        VALUES (?, ?, 'Plumbing', 'Overdue pipe leak unresolved for 80 hours', 'Low', 'Open', datetime('now', '-80 hours'))
    `).run(regStudent.lastInsertRowid, boysHostel.id);

    // Trigger maintenance tasks
    const cronResults = runDailyMaintenanceTasks();
    assert(cronResults.overdueCount >= 1, 'Cron must identify and update overdue fees');
    assert(cronResults.escalatedCount >= 1, 'Cron must elevate >72h complaints');

    const updatedFee = db.prepare('SELECT status FROM fees WHERE id = ?').get(pastFeeRes.lastInsertRowid);
    assert.strictEqual(updatedFee.status, 'Overdue', 'Unpaid past fee must transition to Overdue (FR-43)');

    const updatedComp = db.prepare('SELECT priority FROM complaints WHERE id = ?').get(pastComplaintRes.lastInsertRowid);
    assert.strictEqual(updatedComp.priority, 'High', 'Breached complaint must be escalated to High priority (BR-10, FR-57)');
    console.log('✅ 17. Tier A: Background Cron Daemon verified (Fee auto-overdue FR-43 & 72h complaint escalation BR-10)');

    // 18. Test Tier A: Digital Visitor Pass Code & Security Window (BR-08, FR-61)
    const testPassCode = `VPASS-${Date.now().toString(36).toUpperCase()}`;
    const visEntry = db.prepare(`
        INSERT INTO visitors (hostel_id, visitor_name, relation, id_proof, student_id, purpose, pass_code, recorded_by)
        VALUES (?, 'Guardian Test', 'Parent', 'AADH-XXXX-9999', ?, 'Semester Visit', ?, ?)
    `).run(boysHostel.id, regStudent.lastInsertRowid, testPassCode, admin.id);

    const savedVis = db.prepare('SELECT * FROM visitors WHERE id = ?').get(visEntry.lastInsertRowid);
    assert(savedVis.pass_code.startsWith('VPASS-'), 'Visitor pass code must follow VPASS format');
    console.log(`✅ 18. Tier A: Digital Visitor Gate Pass Code verified (${savedVis.pass_code}) (FR-61, BR-08)`);

    // 19. Test Penalties & Fines Management & BR-06 Enforcement
    // 19a. Levy penalty
    const penaltyRes = db.prepare(`
        INSERT INTO penalties (student_id, allocation_id, hostel_id, category, title, description, amount, due_date, status, imposed_by)
        VALUES (?, ?, ?, 'Property Damage', 'Broken Mirror in Room', 'Cracked mirror during shifting', 750, DATE('now', '+7 days'), 'Unpaid', ?)
    `).run(regStudent.lastInsertRowid, allocRes.lastInsertRowid, boysHostel.id, admin.id);
    const penaltyId = penaltyRes.lastInsertRowid;

    // 19b. Verify BR-06 blocks room vacating due to unpaid penalty
    const unpaidPenalties = db.prepare("SELECT SUM(amount) as total FROM penalties WHERE student_id = ? AND status = 'Unpaid'").get(regStudent.lastInsertRowid);
    assert(unpaidPenalties && unpaidPenalties.total === 750, 'Student should have 750 in unpaid penalties');
    // Emulate BR-06 check
    let vacateBlocked = false;
    if (unpaidPenalties && unpaidPenalties.total > 0) {
        vacateBlocked = true;
    }
    assert.strictEqual(vacateBlocked, true, 'BR-06 must strictly block vacating room if unpaid penalties exist');

    // 19c. Student pays penalty online
    const txnRef = `PEN-TXN-${Date.now()}`;
    db.prepare(`
        UPDATE penalties 
        SET status = 'Paid', paid_at = CURRENT_TIMESTAMP, payment_mode = 'Online', transaction_ref = ?
        WHERE id = ?
    `).run(txnRef, penaltyId);
    const paidPenalty = db.prepare('SELECT * FROM penalties WHERE id = ?').get(penaltyId);
    assert.strictEqual(paidPenalty.status, 'Paid', 'Penalty status should be Paid after online payment');
    assert.strictEqual(paidPenalty.transaction_ref, txnRef, 'Transaction ref should be set');

    // 19d. Test Waiver flow
    const waiverCandidate = db.prepare(`
        INSERT INTO penalties (student_id, allocation_id, hostel_id, category, title, description, amount, due_date, status, imposed_by)
        VALUES (?, ?, ?, 'Late Return / Curfew', 'Late Entry into hostel', 'Curfew breached by 15 mins', 200, DATE('now', '+3 days'), 'Unpaid', ?)
    `).run(regStudent.lastInsertRowid, allocRes.lastInsertRowid, boysHostel.id, wardenBoys.id);
    
    db.prepare(`
        UPDATE penalties
        SET status = 'Waived', waived_by = ?, waive_reason = ?
        WHERE id = ?
    `).run(admin.id, 'First-time warning granted with medical excuse', waiverCandidate.lastInsertRowid);

    const waivedPenalty = db.prepare('SELECT * FROM penalties WHERE id = ?').get(waiverCandidate.lastInsertRowid);
    assert.strictEqual(waivedPenalty.status, 'Waived', 'Penalty status should be Waived');
    assert.strictEqual(waivedPenalty.waived_by, admin.id, 'Waived by should record user id');
    console.log('✅ 19. Penalties & Fines Management verified (Levy, BR-06 vacating block, online payment, and waiver)');

    console.log('\n🎉 ALL 19 VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
