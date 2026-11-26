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

### 2. Run All 12 Automated Verification Tests
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
| **Administrator** | `admin@hostel.com` | `admin123` | Full dashboard: Hostel & room management, student verification, waitlist queue, manual & 1-click auto room allocations, transfer/vacate approval, CSV exports, bulk upload, and audit logs. |
| **Boys Warden** | `warden.boys@hostel.com` | `warden123` | Supervises Tagore Boys Hostel: manage maintenance complaints, record transfer/vacate recommendations, and log visitors with digital passes. |
| **Girls Warden** | `warden.girls@hostel.com` | `warden123` | Supervises Sarojini Girls Hostel. |
| **Student (Active)** | `rahul@student.com` *(or `2026CS101`)* | `student123` | Allocated to Room 101-A (Boys Hostel), has pending fee to pay, printable receipt, can file complaints. |
| **Student (Pending)** | `amit@student.com` *(or `2026ME303`)* | `student123` | Demonstrates pending verification state (BR-04) and Waitlist priority queue. |

---

## 🌟 What's Included (Phase 1 + Phase 2 Features)

### 1. Modern UI Experience
* **Non-intrusive Toast Notifications**: Interactive Bootstrap toasts replacing standard browser alerts for instant, sleek feedback.
* **Modern Stat Cards**: Live occupancy progress bars, real-time counters, and micro-hover lifts.
* **Responsive Layouts**: Tested across phone, tablet, and desktop viewports.

### 2. Bulk Room Allocation Engine (FR-22, FR-23, FR-26)
* **1-Click Batch Allocation**: Automatically processes all approved unallocated students in one shot.
* **Configurable Priority Ordering (FR-23)**:
  * Earliest registration timestamp first (FIFO per standard policy).
  * Senior years first (4th Year ➔ 1st Year).
  * Freshmen first (1st Year ➔ 4th Year).
* **Automated Waitlist Fallback (FR-26)**: If all beds in matching gender hostels become full, excess students are automatically queued to the Waitlist with priority ranks.
* **Detailed Batch Report**: Shows exactly which student was assigned which room/bed in the modal report.

### 3. Automated Waitlist Priority Queue (FR-23, FR-26)
* When all beds matching a student's gender are full during automated allocation, the student is automatically added to the **Waitlist Queue** with a priority rank (`#1`, `#2`, etc.).
* Admin has a dedicated **Waitlist Queue** tab with a 1-click **"Allocate Bed"** button as soon as a bed opens.

### 3. Bulk CSV Room Upload & Institutional Reporting (Phase 2 - FR-20, FR-72 to FR-76)
* **Bulk Room CSV Import**: Admin can paste or import CSV data (`HostelName,RoomNo,Floor,RoomType,Capacity`) with real-time feedback on accepted vs. rejected rows.
* **1-Click CSV Exports**:
  * Occupancy Matrix (`occupancy_report.csv`)
  * Fee Collections & Outstanding Dues (`fees_collection_report.csv`)
  * Maintenance Complaints Breakdown (`complaints_report.csv`)

### 4. 72-Hour Automated Complaint Escalation (Phase 2 - BR-10, FR-57)
* Complaints remaining unresolved past 72 hours automatically receive the **Escalated** status with a pulsing visual alert badge on both Warden and Admin dashboards.

### 5. Digital Visitor Passes & Privacy Masking (Phase 2 - NFR-09, SRS Conclusion)
* Checked-in visitors receive a unique digital pass code (`VPASS-XXXXXX`) with an instant pass modal.
* Visitor ID proof numbers are masked in tables (e.g. `••••-••••-9876`) to satisfy privacy constraints (`NFR-09`).

### 6. Security Hardening & Immutable Audit Trail (Phase 2 - FR-05, FR-82, NFR-10)
* **Account Lockout (`FR-05`)**: 5 consecutive failed login attempts automatically lock the account for 15 minutes.
* **Audit Trail (`FR-82`)**: Append-only log tracking logins, approvals, allocations, status changes, and fee updates with timestamp and user email.
