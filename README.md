# 🚀 Engineering Team Task Tracker & Live 2-Way Sync Engine

An automated, synchronized task management dashboard and integration bridge between **Google Sheets** (`Team Task Sheet`) and **Atlassian Jira**.

---

## 🌟 Key Features

1. **Dual Status Tracking**:
   - **Jira Status**: Synced directly from Jira issues (`In Progress`, `In Review`, `Escalated to L2`, `Escalated to L3`, etc.).
   - **Internal Status (Editable via UI)**: Interactive inline dropdown on each ticket row (`In Progress`, `Dev Done`, `BE Done / FE ToDo`, `BE Done (Verify)`, `In Review`, `POC`, `Discuss First`, `Backlog`). Changing this in the UI instantly updates Google Sheets and color-codes the cell!
2. **Interactive Ticket Links**:
   - Ticket IDs are styled as high-visibility clickable badges with an external link indicator (`↗`).
   - Clicking opens the ticket in Jira in a new tab/window (`target="_blank" rel="noopener noreferrer"`).
3. **⚡ Sync All from Jira**:
   - One-click bulk sync button in the header.
   - Fetches updated titles, live Jira status, and due dates from Jira for all tickets across all team tabs, writing them directly to Google Sheets and updating the dashboard.
4. **Strict Due Date Policy**:
   - Due dates are strictly pulled from Jira ticket `duedate`. If not set in Jira, it defaults to `"Not set"`.
5. **Internal Assignee & Live Reassignment**:
   - Change ticket assignees directly on the dashboard via dropdown.
   - Automatically relocates the ticket row to the new member's Google Sheet tab, re-indexes rows, and updates private IMPORTRANGE views.
6. **Shared Assignee & Custom Scope Labels**:
   - Assign tickets across multiple team members with distinct role labels (e.g., `Krishna (BE)` and `Chetna (FE)`).
   - Syncs into both members' Google Sheet tabs with `[Shared: MEMBER (ROLE) + ...]` tags.
7. **✅ Close Ticket & Move to CLOSED Sheet**:
   - Every active ticket has a dedicated **`✅` Close Ticket** action button directly before the delete icon (`🗑️`).
   - When clicked (or when changing Internal Status to *Closed*), the ticket row is safely relocated from the team member's sheet into the **`CLOSED`** archive sheet in Google Sheets, re-numbering remaining tasks.
   - Tickets inside the **`CLOSED`** section feature a **`🔄` Reopen** action to restore the ticket back to any team member.
8. **📁 CLOSED Status Section (Non-Person Sheet)**:
   - The **`CLOSED`** sheet is designated strictly as a status point / archive section.
   - It is filtered out from all person assignment dropdowns (Quick Add form, inline reassign dropdown, shared roles modal, and duplicate resolver).
9. **🗑️ Delete from Google Sheet**:
   - If a wrong ticket was imported from Jira or added by mistake, click the `🗑️` button in the Action column.
   - Confirms deletion, removes the row from Google Sheets, re-numbers remaining rows, and updates linked sheets instantly.
10. **100% Google Sheets Driven**:
   - Dynamically discovers all team tabs (`ARUSH`, `CHETNA`, `KRISHNA`, `MANISH`, `RAHUL`, `SONU`, etc.) and status tabs (`CLOSED`). Zero hardcoded fallback data.
11. **Quick Add & Color Formatting**:
   - Enter ticket number and assignee; it auto-fills Jira details, writes to Google Sheets, and formats status cells with custom background and text colors.
12. **🛡️ Duplicate Entry Prevention & Conflict Resolution**:
   - Real-time client-side warning banner: typing an already-assigned ticket immediately warns who owns it and shows one-click actions (`Reassign`, `Make Shared Task`, `View Tab`).
   - Adding to the same assignee updates the existing row in place rather than creating duplicates.
   - Backend safety: attempts to add an already-assigned ticket to someone else return HTTP 409 and prompt a modal dialog to cleanly reassign or convert into a shared task.
13. **🔄 Person-Specific Sheets 2-Way Sync & Zero-Crash Architecture**:
   - **No More Blankouts**: Removed brittle `=IMPORTRANGE()` array formulas that previously crashed with `#REF!` whenever team members edited Columns F or G.
   - **Editable F & G**: Team members can freely update **Internal Status** (Col F) and **Action / Notes** (Col G) directly in their private Google Sheets.
   - **Restricted Columns (A:E, H)**: Ticket ID, Link, Title, Jira Status, and Due Date remain canonical from Master/Jira and are auto-restored if modified in individual sheets.
   - **Continuous 2-Way Sync**: The Node.js sync server continuously scans individual sheets every 25s (and on dashboard actions), syncing edits to the Master Sheet and vice versa.
14. **✨ Dynamic Internal Status Dropdowns & Auto-Learning Custom Statuses**:
   - **Native Dropdown Validation**: Individual sheets feature native Google Sheets dropdown chips (`strict: false`), allowing quick status picking or typing custom text.
   - **Auto-Registration**: Any new custom internal status typed in a personal Google Sheet or added on the dashboard is automatically registered in the system and pushed into the dropdown options across all sheets and web UI.
15. **⚡ PULSE Project Sheet 2-Way Sync & Native Format Preservation**:
   - **Custom 7-Column Schema**: Automatically synchronizes Chetna's specialized project sheet `PULSE` (`Ticket Number`, `Title`, `Status`, `Assignee`, `Type`, `Link`, `Remarks`) with the Master Google Sheet and Web Dashboard.
   - **Dedicated Dashboard View**: Interactive `⚡ PULSE` navigation tab featuring color-coded statuses (`Todo`, `In Progress`, `Done`), clickable multi-key Jira badges (e.g. `PULSE-1019,SES-867`), bug/task indicator pills, member tags, and direct links to Jira and Google Sheets.
   - **Filtered Non-Person Tab**: Designated as a project sheet, keeping person assignment dropdowns clean.
   - **Automated Sync Engine**: Continuously syncs updates every 25 seconds and supports on-demand sync via `⚡ Sync PULSE`.
16. **🎯 Universal Sorting & Multi-Status Filtering (Dashboard Only)**:
   - **Single & Multi-Status Filters**: Quick status pills (`All`, `🟢 In Progress`, `🟡 In Review`, `🔵 To Do`, `✅ Done / Closed`, `🟣 POC`, `🔴 Discuss`) allow showing only specific statuses or multi-selecting multiple statuses simultaneously.
   - **Detailed Granular Dropdown**: Checkbox menu to select any specific exact statuses (`To Pick Up`, `Dev Done`, `BE Done`, `BE InReview`, `Discuss First`, etc.) with "Select All" and "Clear".
   - **Status Lifecycle & Custom Sorting**: Dedicated sort dropdown featuring user-requested priority order (`⭐ Done ➔ In Review ➔ In Progress ➔ To Do`), standard workflow lifecycle (`⚡ In Progress ➔ In Review ➔ To Do ➔ Done`), `📅 Due Date (Urgent / Earliest first)`, `🏷️ Ticket ID (A-Z / Z-A)`, `🔤 Task Title (A-Z)`, `👤 Assignee (A-Z)`, and `🎯 Status (A-Z)`.
   - **Interactive Sortable Table Headers**: Clicking table column headers toggles ascending/descending sorting (`▲`/`▼`/`↕`) on any column across all tables.
   - **All Sheets Supported**: Applies universally to `All Overview`, individual member tabs (`ARUSH`, `CHETNA`, `KRISHNA`, `MANISH`, `RAHUL`, `SONU`), archive `CLOSED`, and project `PULSE`.
   - **Client-Side Safe**: 100% dashboard-only in-memory sorting & filtering with active count badges and instant `✕ Reset`. Google Sheets row structures remain unaffected.

17. **🔐 Login & Role-Based Access Control (RBAC)**:
    - **Visibility for Everyone**: All team members and admin can view all tabs: `All Overview`, `CLOSED`, `PULSE`, and all team member tabs (`ARUSH`, `CHETNA`, `KRISHNA`, `MANISH`, `RAHUL`, `SONU`).
    - **Member Write Protection**: Team members can only update Internal Status and Action/Notes on tasks assigned to their name. Tasks belonging to colleagues display in read-only mode with a security lock indicator (`🔒`).
    - **Self-Scoped Ticket Creation**: Team members can add tickets via the Quick Add form, locked strictly to their own name and synced to Google Sheets.
    - **Admin Superuser**: Admin has full rights to add, edit, reassign, or delete any task across all tabs.
18. **🔑 Composio Key Onboarding & UI Authentication**:
    - Users provide their personal Composio API key (`ck_...`) directly in the UI onboarding screen.
    - Features live key verification and fallback to shared workspace keys.
    - Persists per user in `localStorage` and transmits via `x-composio-key` header to backend APIs.
19. **⚡ Vercel Deployment (Mumbai Region `bom1`)**:
    - Serverless-ready architecture compatible with Vercel Free Hobby plan.
    - Pre-configured `vercel.json` targeting Mumbai region (`bom1`).

---

## 👥 Preset Team Accounts & Credentials

| Username | Role | Password | Allowed Sheets / Scope |
| :--- | :--- | :--- | :--- |
| **`admin`** | 👑 ADMIN | `admin@enveu2026` | Full Access (All Sheets & Actions) |
| **`chetna`** | 👤 MEMBER | `chetna@enveu2026` | View All, Edit/Add in `CHETNA` & `PULSE` |
| **`krishna`** | 👤 MEMBER | `krishna@enveu2026` | View All, Edit/Add in `KRISHNA` |
| **`arush`** | 👤 MEMBER | `arush@enveu2026` | View All, Edit/Add in `ARUSH` |
| **`manish`** | 👤 MEMBER | `manish@enveu2026` | View All, Edit/Add in `MANISH` |
| **`rahul`** | 👤 MEMBER | `rahul@enveu2026` | View All, Edit/Add in `RAHUL` |
| **`sonu`** | 👤 MEMBER | `sonu@enveu2026` | View All, Edit/Add in `SONU` |

*Quick-fill chips are available on the login screen for convenient 1-click credential loading.*

---

## 📁 Project Structure

```
d:\v2\team-task-sync\
├── sync_server.js       # Node.js sync server (port 3100) handling Jira, Sheets & RBAC
├── index.html           # Main dashboard UI with Login, Composio Setup & RBAC
├── team_task_sheet.html # Secondary UI mirror
├── vercel.json          # Vercel configuration (Mumbai `bom1` region)
├── api/
│   └── index.js         # Vercel serverless function entrypoint
├── package.json         # Project metadata
├── start.bat            # 1-click Windows launcher
└── sheet_tabs/          # Local TSV backups
```

---

## 🚀 How to Start Locally

### Option 1: Double-click `start.bat`
Double-click `start.bat` in `d:\v2\team-task-sync\`. It will start the server on port 3100 and automatically open `http://localhost:3100` in your browser.

### Option 2: Command Line
```powershell
cd d:\v2\team-task-sync
npm start
```
Then open:
👉 **`http://localhost:3100`**

---

## 🌐 Deploy to Vercel (Mumbai Region - Free Hobby Plan)

1. **Install Vercel CLI** (if not installed):
   ```bash
   npm i -g vercel
   ```
2. **Deploy from project directory**:
   ```bash
   cd d:\v2\team-task-sync
   vercel
   ```
3. Set your production deployment:
   ```bash
   vercel --prod
   ```
4. **Environment Variables**:
   In your Vercel Project Dashboard (Settings ➔ Environment Variables), optionally add:
   - `COMPOSIO_API_KEY`: Default fallback workspace Composio key.
   - `SPREADSHEET_ID`: Master Google Sheet ID (`1mMe1z7_fZRKjAcd_uMGUsY15SFfRcBPUKfttcYDa9FY`).

Your project is already configured with `"regions": ["bom1"]` in `vercel.json` for low latency in India.
#   T e a m - p l a n n e r  
 