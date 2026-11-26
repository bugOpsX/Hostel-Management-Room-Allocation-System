# Hostel Management & Room Allocation System (HMRAS)

A lightweight, high-performance web platform implementing the core functionalities of the **Hostel Management & Room Allocation System (HMRAS)** specification.

Built with **Node.js, Express, SQLite (`better-sqlite3`), and clean responsive Bootstrap 5**.

---

## 🚀 Quick Start (Under 1 Minute)

### 1. Install Dependencies
```bash
npm install
```

### 2. Seed Demo Database
```bash
npm run seed
```
*(Creates initial hostels, rooms, beds, sample students, fees, notices, and demo accounts).*

### 3. Start the Server
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 4. Run Automated Business Rule Tests
```bash
npm test
```

---

## 🔑 Pre-Configured Demo Accounts

| Role | Email / Roll No | Password | Description |
| :--- | :--- | :--- | :--- |
| **Administrator** | `admin@hostel.com` | `admin123` | Full control over hostels, rooms, approvals, allocations, and fees. |
| **Boys Warden** | `warden.boys@hostel.com` | `warden123` | Supervises Tagore Boys Hostel, complaints, recommendations, and visitor log. |
| **Girls Warden** | `warden.girls@hostel.com` | `warden123` | Supervises Sarojini Girls Hostel. |
| **Student (Active)** | `rahul@student.com` (or `2026CS101`) | `student123` | Allocated to Room 101-A (Boys Hostel), has pending fee to pay, can file complaints. |
| **Student (Pending)** | `amit@student.com` (or `2026ME303`) | `student123` | Newly registered student awaiting Admin approval (BR-04). |

---

## 💡 Core Features & Business Rule Implementation

### 1. Authentication & Role-Based Access Control (RBAC)
* Student self-registration with input validation (FR-01, FR-02).
* Student accounts start as **Pending Verification** and require Administrator approval before first login (BR-04).
* Secure passwords hashed with `bcryptjs` (salt factor 10, NFR-05).
* 20-minute inactivity session expiration (NFR-08).

### 2. Hostels, Rooms & Bed Management
* Create Hostels (Boys / Girls) with floor count and assign Warden (FR-12, FR-14).
* Add Rooms with capacity 1 to 6 beds (Single, Double, Triple, Quad); individual bed records are automatically created with initial status `Vacant` (FR-16, FR-17).
* Toggle bed maintenance status (`Vacant` ⟷ `Maintenance`).

### 3. Room Allocation Engine
* **Rule BR-01**: Exactly one active allocation per student.
* **Rule BR-02**: Only vacant beds can be allocated; beds become `Occupied`.
* **Rule BR-03**: Strict gender enforcement (Male students can only be allocated to Boys hostels, Female students to Girls hostels).
* **Rule BR-05 & FR-27**: Term fee record is automatically generated upon bed allocation.
* **1-Click Auto Allocation**: Instantly matches eligible student with first vacant bed in a gender-appropriate hostel.

### 4. Room Transfer & Vacate Workflow
* Resident students can submit Transfer or Vacating requests with reasons (FR-33, FR-34).
* Warden reviews and records recommendation (`Recommend` / `Not Recommend`) with notes (FR-36).
* Administrator approves/rejects:
  * **Transfer**: Atomically frees old bed and occupies target bed in one transaction (FR-38).
  * **Vacate**: Enforces **Rule BR-06** — clearance is strictly blocked until all outstanding fees are paid. On approval, bed status is restored to `Vacant`.

### 5. Fees & Simulated Online Payments
* Students view term fees, status (`Unpaid`, `Paid`, `Overdue`), and due dates.
* Students can click **"Pay Online"** to simulate encrypted checkout (FR-47) with instant transaction receipt generation.
* Offline cash/bank payments can be recorded by Administrators (FR-48).
* Printable official fee receipt modal formatted for browser printing.

### 6. Maintenance Complaints
* Categorized issue logging: Electrical, Plumbing, Furniture, Cleaning, Internet, Security, Other (FR-51).
* Routed directly to the resident's hostel warden (FR-53).
* Warden can assign technicians, update priority (Low, Med, High), and mark status (`Open` → `In Progress` → `Resolved`) (FR-54).

### 7. Visitor Register & Visiting Hours
* Wardens log visitor entries with ID proof and purpose (FR-59).
* Visiting hours (09:00 - 19:00) validation with required override reason prompt for off-hours entries (BR-08).
* 1-Click "Record Exit" timestamping (FR-61).

### 8. Campus Notice Board
* Administrators can broadcast notices to all hostels or specific hostels (FR-64).
* Wardens can post notices to their assigned hostel.
* Real-time notices displayed on login page and role dashboards.
