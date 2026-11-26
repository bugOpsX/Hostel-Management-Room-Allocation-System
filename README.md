# Hostel Management & Room Allocation System (HMRAS)

A lightweight, high-performance web platform implementing the complete core and advanced requirements of the **Hostel Management & Room Allocation System (HMRAS)** specification (Phases 1 & 2).

Built with **Node.js, Express, SQLite (`better-sqlite3`), and clean responsive Bootstrap 5**.

---

## 🚀 Quick Start

### 1. Start the Server
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 2. Run All 18 Automated Verification Tests
```bash
npm test
```

### 3. Reset to Clean Seed Data Anytime
```bash
npm run seed
```

---

## 🔑 Pre-Configured Demo Accounts (1-Click on Sign-In Page)

| Role | Email / Roll No | Password | Description |
| :--- | :--- | :--- | :--- |
| **Administrator** | `admin@hostel.com` | `admin123` | Full dashboard: Hostel & room management, student verification, waitlist queue, manual, auto & bulk room allocations, transfer/vacate approval, CSV exports, bulk upload, audit logs, and maintenance daemon. |
| **Boys Warden** | `warden.boys@hostel.com` | `warden123` | Supervises Tagore Boys Hostel: manage maintenance complaints, record transfer/vacate recommendations, and log visitors with digital QR passes. |
| **Girls Warden** | `warden.girls@hostel.com` | `warden123` | Supervises Sarojini Girls Hostel. |
| **Student (Active)** | `rahul@student.com` *(or `2026CS101`)* | `student123` | Allocated to Room 101-A (Boys Hostel), has pending fee to pay, printable receipt, can file complaints & track personal activity timeline. |
| **Student (Pending)** | `amit@student.com` *(or `2026ME303`)* | `student123` | Demonstrates pending verification state (BR-04) and Waitlist priority queue. |

---

## 🌟 What's Included (Phase 1, Phase 2 & Tier A Features)

### 1. Modern UI & Real-Time Notification Badges
* **Notification Badges Everywhere**: Real-time counter pills on top navigation alert bells and every management tab (Fees, Complaints, Requests, Notices, Visitors, and Activity Logs).
* **Non-intrusive Toast Notifications**: Sleek Bootstrap toasts for instant feedback.
* **Modern Stat Cards**: Live occupancy progress bars, real-time counters, and micro-hover lifts.

### 2. Password Reset Workflow (FR-06)
* Self-service **"Forgot Password"** modal on sign-in page accepting email or student enrollment number.
* Issues cryptographically secure, 30-minute time-limited reset tokens per SRS specification.
* Password complexity enforcement (minimum 8 characters, alphanumeric).

### 3. Background Maintenance Cron Daemon (FR-43, BR-10, FR-57)
* Automatically runs in the background on server boot and hourly.
* **Auto-Overdue Fee Transitions (FR-43)**: Automatically flips unpaid fees past their due date to `Overdue`.
* **72-Hour Complaint Escalation (BR-10)**: Automatically elevates complaints unresolved past 72 hours to `High` priority.
* Admin dashboard includes a **"Run Cron Daemon"** button for on-demand inspection.

### 4. Digital Visitor Pass with Dynamic QR Code (FR-61 / SRS Section 4)
* Generates an instant digital gate pass with a scannable QR code encoded with visit details and visiting hours (`09:00 - 19:00` per `BR-08`).
* Wardens can re-open and print QR passes for any visitor directly from the register.
* Visitor ID proofs are masked (`••••-1234` per `NFR-09`).

### 5. Bulk Room Allocation Engine (FR-22, FR-23, FR-26)
* **1-Click Batch Allocation**: Automatically processes all approved unallocated students in one shot.
* **Configurable Priority Ordering (FR-23)**: Earliest registration (FIFO), Senior years first, or Freshmen first.
* **Automated Waitlist Fallback (FR-26)**: Excess students automatically queued with priority ranks when gender-matching hostels reach full capacity.

### 6. Role-Scoped Activity Logging & Audit Trail (FR-82, NFR-10)
* **Admin**: System-wide filterable audit trail across all events.
* **Warden**: Hostel-scoped incident and activity feed.
* **Student**: Personal chronological activity and allocation timeline.

### 7. Bulk CSV Room Upload & Institutional Reporting (FR-20, FR-72 to FR-76)
* **Bulk Room CSV Import**: Paste or upload room data with validation reports.
* **1-Click CSV Exports**: Occupancy Matrix, Fee Collections, and Maintenance Complaints.

### 8. Security Hardening (FR-05)
* 5 consecutive failed login attempts automatically trigger a 15-minute account lockout.
