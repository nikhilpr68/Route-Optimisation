# VELORA — User Manual

**Driven By Possibility**

*A comprehensive guide to using the Velora Route Optimization Platform*

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
   - 2.1 [Creating an Account](#21-creating-an-account)
   - 2.2 [Logging In](#22-logging-in)
   - 2.3 [Google Sign-In](#23-google-sign-in)
   - 2.4 [Password Recovery](#24-password-recovery)
3. [Dashboard (Home)](#3-dashboard-home)
   - 3.1 [Uploading a Dataset](#31-uploading-a-dataset)
   - 3.2 [Optimization Settings](#32-optimization-settings)
   - 3.3 [Running the Solver](#33-running-the-solver)
   - 3.4 [Managing Projects](#34-managing-projects)
4. [Project Workflow](#4-project-workflow)
   - 4.1 [Parse](#41-parse)
   - 4.2 [Data Overview](#42-data-overview)
   - 4.3 [Map View](#43-map-view)
   - 4.4 [Ride Assignment](#44-ride-assignment)
   - 4.5 [Constraints & Violations](#45-constraints--violations)
   - 4.6 [Cost Breakdown](#46-cost-breakdown)
   - 4.7 [Compare Runs](#47-compare-runs)
   - 4.8 [Exports](#48-exports)
5. [Sharing Projects](#5-sharing-projects)
6. [Validator](#6-validator)
7. [Metrics Dashboard](#7-metrics-dashboard)
8. [Collaboration & Teams](#8-collaboration--teams)
   - 8.1 [Creating a Team](#81-creating-a-team)
   - 8.2 [Joining a Team](#82-joining-a-team)
   - 8.3 [Managing Members](#83-managing-members)
   - 8.4 [Sharing Projects with Teams](#84-sharing-projects-with-teams)
   - 8.5 [Assignments](#85-assignments)
   - 8.6 [Team Chat](#86-team-chat)
9. [Settings & Profile](#9-settings--profile)
   - 9.1 [Profile Management](#91-profile-management)
   - 9.2 [Changing Your Password](#92-changing-your-password)
10. [Billing & Subscription](#10-billing--subscription)
    - 10.1 [Free vs Premium Plan](#101-free-vs-premium-plan)
    - 10.2 [Upgrading to Premium](#102-upgrading-to-premium)
    - 10.3 [Canceling a Subscription](#103-canceling-a-subscription)
11. [Help & Support](#11-help--support)
12. [Data Format Reference](#12-data-format-reference)
    - 12.1 [Employee Data](#121-employee-data)
    - 12.2 [Vehicle Data](#122-vehicle-data)
13. [Keyboard Shortcuts](#13-keyboard-shortcuts)
14. [Troubleshooting & FAQ](#14-troubleshooting--faq)

---

## 1. Introduction

Velora is a route optimization platform built for corporate mobility. It takes employee commute data — pickup locations, drop-off locations, time windows, and vehicle fleets — and computes optimized vehicle routes that minimize cost, distance, and time while respecting all constraints.

**What Velora does:**
- Parses employee and vehicle data from CSV/Excel files
- Computes optimized pickup/drop-off routes using an advanced solver (genetic algorithm + ALNS)
- Visualizes routes on an interactive map with timeline playback
- Calculates cost savings compared to a baseline (unoptimized) assignment
- Validates solution feasibility (capacity, time windows, preferences)
- Enables sharing results with stakeholders via public links
- Supports team collaboration with assignments and messaging

---

## 2. Getting Started

### 2.1 Creating an Account

1. Navigate to the Velora landing page.
2. Click **Sign In** in the top-right corner.
3. On the login screen, click **Sign Up** to switch to the registration form.
4. Fill in:
   - **Name** — your full name
   - **Email** — a valid email address
   - **Password** — must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character
5. Click **Sign Up**.
6. Your account is created and you are automatically logged in.

### 2.2 Logging In

1. On the login screen, enter your **Email** and **Password**.
2. Click **Sign In**.
3. You will be redirected to the Dashboard.

### 2.3 Google Sign-In

1. On the login screen, click the **Google** sign-in button.
2. Authenticate with your Google account.
3. If this is your first time, an account is automatically created using your Google profile.

### 2.4 Password Recovery

1. On the login screen, click **Forgot Password?**.
2. Enter the email address associated with your account.
3. Enter your new password and confirm it.
4. Click **Reset Password** to confirm.

---

## 3. Dashboard (Home)

The Dashboard is your central hub for creating, managing, and launching optimization runs.

### 3.1 Uploading a Dataset

The main area of the Dashboard features a drag-and-drop upload zone.

1. **Drag and drop** your dataset file onto the area labeled **"Drop your dataset here"**, or click to browse files.
2. Supported file formats: **CSV** (`.csv`), **Excel** (`.xls`, `.xlsx`).
3. Your file should contain employee data (pickup/drop-off locations, time windows) and optionally vehicle data. See [Data Format Reference](#12-data-format-reference) for details.

Once uploaded, the file is automatically parsed using Velora's intelligent parser, which detects columns, normalizes data, and extracts employees, vehicles, and constraints.

### 3.2 Optimization Settings

Before running the solver, configure these settings using the dropdowns at the top of the Dashboard:

| Setting | Options | Description |
|---------|---------|-------------|
| **Intensity** | Low, **Medium** (default), High | Controls solver effort. Higher intensity uses more computation time for better results. |
| **Distance** | **Map (Road)** (default), Haversine | **Map (Road)** uses real road distances via OSRM. **Haversine** uses straight-line geographic distance (faster but less accurate). |
| **Preferences** | **Enforce All** (default), Break Sharing, Break Vehicle, Break Both | Controls how strictly employee preferences are respected. "Enforce All" respects all sharing and vehicle preferences. "Break Sharing/Vehicle/Both" allows the solver to relax those constraints for a potentially better solution. |

You can also set a **Schedule Run** date using the calendar date picker.

### 3.3 Running the Solver

1. After uploading your file and configuring settings, click **"Run Solver"**.
2. A new project is created and the optimization engine begins processing.
3. The run appears in your **Recent Runs** list with a **Processing** status.
4. A progress indicator shows real-time progress (updates every 800ms).
5. When complete, the status changes to **Completed** (or **Failed** / **Infeasible** if issues occur).
6. Click on the project to view results.

**Run duration:**
- Free tier: ~2 minutes (single run, smaller population)
- Premium tier: up to 20 minutes (multiple parallel runs, larger population, better results)

### 3.4 Managing Projects

Your **Recent Runs** section lists all your projects. You can:

- **Filter by status**: All, Pending, Processing, Ongoing, Completed, Failed, Upcoming
- **Filter by date**: Use the calendar picker, then click **Clear** to reset
- **Toggle visibility**: Use **Hide Projects** / **Show Projects**
- **Right-click** (or use the context menu) on any project for:
  - **Edit Name** — rename the project
  - **Delete Run** — permanently delete the project
  - **Select Multiple** — enter multi-select mode
  - **Delete Selected Runs** — bulk delete selected projects

---

## 4. Project Workflow

After a run completes, click on the project to enter the **Project Workflow** view. This view has multiple sections accessible via navigation tabs:

### 4.1 Parse

**"Parse testcase inputs for this run"**

Displays the raw parsing results from your uploaded data:
- Parsing status and confidence score
- Warnings and assumptions made during parsing
- Missing or ambiguous fields detected
- The model used for parsing (Python RGX parser)

### 4.2 Data Overview

**"Inspect parsed entities, counts, and quality checks"**

Shows the structured data extracted from your upload:
- **Employees table**: Employee IDs, pickup/drop-off coordinates, time windows, sharing preferences, vehicle preferences, priority levels
- **Vehicles table**: Vehicle IDs, type (2-wheeler, 4-wheeler, Van), fuel type, capacity, cost per km, speed, start location
- **Baseline metrics**: The unoptimized baseline cost and time (what it would cost without optimization)

### 4.3 Map View

**"Visualize routes, stops, and assignments on the map"**

An interactive Google Maps visualization showing all optimized routes:

- **Timeline Playback**: A timeline slider at the bottom lets you scrub through the execution. Use the play/pause button to animate route progression.
- **Playback Speed**: Adjustable from 0.25x to 2x speed.
- **Filters**: Toggle visibility of individual vehicles or employees.
- **Layers**: Show/hide employee markers, route lines, vehicle positions.
- **Fullscreen**: Press **F** to toggle fullscreen mode.
- **Seek**: Use **Left/Right Arrow** keys to jump forward/backward by 1 minute.
- **Route Colors**: Each vehicle route is shown in a distinct color.

### 4.4 Ride Assignment

**"Track employee-to-vehicle assignments, timings, and route distance details"**

Detailed breakdown of each ride (vehicle route):
- Which employees are assigned to each vehicle
- Stop-by-stop sequence: stop type (pickup/dropoff), employee ID, location, arrival time, departure time, distance from previous stop
- Per-ride metrics: total distance (km), total time (minutes), cost
- Google Maps links to view each route externally

### 4.5 Constraints & Violations

**"Track violated constraints, feasibility diagnostics, and run validation"**

Shows the solution's constraint compliance:

- **Solution Feasibility** card: overall status — Feasible (green), Partial (yellow), Infeasible (red), or Not Run
- **Validation Checks** table: pass/fail/warning for each check type
- **Violation Types**:
  - Capacity Violations — vehicle exceeded seating capacity
  - Time Window Violations — pickup/dropoff outside allowed time
  - Premium Vehicle Violations — premium constraints not met
  - Sharing Preference Violations — ride-sharing preferences broken
  - Precedence Violations — dropoff before pickup
  - Empty Route Violations — vehicle assigned with no passengers

Click **"Run Validation"** to trigger a fresh background validation check. Results appear once processing completes.

### 4.6 Cost Breakdown

**"Analyze cost components across routes and resources"**

Detailed cost analysis with expandable KPI cards:
- **Total Objective Score** — the solver's combined optimization metric
- **Operational Cost** — total monetary cost across all routes
- **Total Time** — sum of all route durations
- **Delay Time** — total delay minutes across all employees
- **Per-vehicle cost stacks** — breakdown by vehicle
- **Delay analysis** — which employees have delays and why
- **Savings comparison** — cost before (baseline) vs after (optimized), with percentage savings

### 4.7 Compare Runs

**"Compare objective metrics with previous runs"**

If you have run the solver multiple times on the same project, this panel shows a side-by-side comparison:
- Objective score, cost, distance, time for each run
- Delta (improvement/regression) between runs
- Helps identify the best configuration

### 4.8 Exports

**"Export outputs, reports, and run artifacts"**

Download your results in machine-readable formats:

- **Solution Export (JSON)** — contains:
  - Employee-vehicle assignments
  - Ride groups with pickup/drop order
  - Capacity details per ride
  - Solution feasibility status

- **Validation Report (JSON)** — contains:
  - Parse status checks
  - Employee/vehicle counts
  - Diagnostic errors and warnings
  - Capacity violation summary
  - Assignment coverage percentage

---

## 5. Sharing Projects

Share your optimization results with external stakeholders who don't need a Velora account.

1. Open any completed project.
2. Click the **"Share"** button in the top-right corner.
3. A unique public link is generated and automatically copied to your clipboard.
4. Anyone with the link can view the project in **read-only** mode — all 7 workflow sections are accessible (Map View, Data Overview, Ride Assignment, etc.).
5. No login is required to view shared projects.

**To revoke sharing:**
- Go to the project and disable sharing (the link will stop working).

---

## 6. Validator

The Validator is a standalone tool for comparing your solution against Velora's engine output.

**Access**: Click **Validator** in the sidebar.

### How to Use

1. **Upload Testcase**: Click the testcase upload area and select your input file.
   - Accepted formats: `.json`, `.txt`, `.csv`, `.xlsx`, `.xls`
   - This should contain the problem definition (employees, vehicles, constraints).

2. **Upload Testcase Result**: Click the result upload area and select the solver output file.
   - Accepted formats: `.json`, `.txt`
   - This is the solution to validate.

3. **Configure Validation Options**:
   - **"Compare uploaded result with our engine output"** — check this box to also run Velora's solver on the same testcase for comparison.
   - **"Our engine intensity"** — select Low, Medium (default), or High (only available when comparison is enabled).

4. Click **"Run Validation"**.

5. **Results** display summary cards:
   - Employees count
   - Vehicles count
   - Objective score
   - Cost (currency format)
   - Total Time (minutes)
   - Delay (minutes)
   - Detailed ride ledger table with per-ride analysis

---

## 7. Metrics Dashboard

**Access**: Click **Metrics** in the sidebar.

The Metrics Dashboard provides a high-level analytics view across all your projects:

**KPI Cards:**
- **Total Savings** — aggregate cost savings ($ and %) across all completed projects
- **Total Rides Optimized** — number of rides generated, with feasibility percentage
- **Avg. Time Saved** — average time saved per ride in minutes

**Charts:**
- **Distance Reduction Donut** — visual percentage of distance saved
- **Cost Before/After Bars** — baseline cost vs optimized cost comparison
- **Time Savings Area Chart** — time savings trend
- **Top Projects by Rides** — ranking of projects by number of rides, with delta percentage
- **Success Rate Progress Bar** — overall optimization success rate

---

## 8. Collaboration & Teams

The Collaboration feature lets you work with teams — share projects, assign routes to drivers, and communicate within the platform.

**Access**: Click **Collaborate** in the sidebar.

### 8.1 Creating a Team

1. Click **"Create Team"**.
2. Enter a **Team name** (required).
3. Optionally add a **team description**.
4. Click **"Create Team"**.
5. A unique **join code** (6 uppercase letters/numbers) is generated — share this with others so they can join.

### 8.2 Joining a Team

1. Click **"Join Team"**.
2. Enter the **team code** provided by the team admin.
3. Click **"Join Team"**.
4. You now appear in the team's member list.

> **Note**: Joining a team does not affect your own teams or assignments. You can belong to multiple teams simultaneously.

### 8.3 Managing Members

Team admins can manage members:

- **View members**: Click the **Members** badge to see the full member list.
- **Add members**: Search for users by email or name, then add them to the team.
- **Update roles**: Change a member's team role (**Admin** / **Member**) or assignment role (**Employee** / **Driver** / **Both** / **Unassigned**).
- **Remove members**: Remove a member from the team.

### 8.4 Sharing Projects with Teams

1. In the team panel, find the **Shared Projects** section.
2. Use the **"Select project to share"** dropdown to choose a completed project.
3. Click **"Share Project"**.
4. The project appears in the shared list with details: name, status, shared date, shared by, and project creation date.

All team members can view shared projects.

### 8.5 Assignments

Assignments link a specific route from a project to a driver and date:

1. **Create Assignment**: Select a project, vehicle/route, driver, and date.
2. The assignment captures a snapshot of the route — stops, timings, distances, and employee list.
3. Each employee on the route is tracked with their pickup and dropoff times.
4. **Delete Assignment**: Admins can remove assignments that are no longer needed.

### 8.6 Team Chat

A simple messaging system for team coordination:

- Type your message in the input field at the bottom of the team panel (placeholder: *"Write to the team..."*).
- Messages display with sender name and timestamp.
- Use for route updates, shift reminders, or driver handoff details.
- The team panel auto-refreshes every 20 seconds to show new messages.

---

## 9. Settings & Profile

**Access**: Click **Settings** in the sidebar, or click your profile icon and select Settings.

### 9.1 Profile Management

- **Name**: Update your display name.
- **Email**: Update your email address.
- **Profile Image**: Upload a profile photo (PNG, JPEG, WEBP, or GIF; max 5MB). An image cropping tool lets you adjust the image before saving.
- Click **Save** to apply changes, **Reset** to revert, or **Remove Image** to delete your photo.

### 9.2 Changing Your Password

1. Enter your **Current Password**.
2. Enter your **New Password** (must meet the same strength requirements: 8+ characters, uppercase, lowercase, number, special character).
3. Enter **Confirm Password** to verify.
4. Click **"Update Password"** to complete the password change.

---

## 10. Billing & Subscription

### 10.1 Free vs Premium Plan

| Feature | Free | Premium |
|---------|------|---------|
| Max employees per run | ~100 | Unlimited |
| Solver runs | 1 parallel run | Multiple parallel runs |
| Population size | 14 | 26 |
| Generations | 36 | 120 |
| Distance metric | Haversine only | OSRM (real road distances) |
| Max run time | ~2 minutes | ~20 minutes |
| Compute tier | Standard | Enhanced |

### 10.2 Upgrading to Premium

1. Navigate to **Settings** or click the upgrade prompt.
2. Click **"Upgrade to Premium"**.
3. A Razorpay payment modal opens.
4. Complete the payment using your preferred method.
5. Your account is upgraded to **Premium** immediately.
6. The subscription auto-renews at each billing cycle.

### 10.3 Canceling a Subscription

1. Go to **Settings** > **Billing**.
2. Click **"Cancel Subscription"**.
3. Your premium features remain active until the end of the current billing period.
4. After that, your account reverts to the Free plan.

---

## 11. Help & Support

**Access**: Click **Help & Support** in the sidebar.

Browse 9 help categories:
- Help with a run
- Account
- Usage
- Accessibility
- Grievance Redressal
- Guides
- Shuttle
- Cancellation Policy
- Map Issues

Each category contains FAQ-style articles. Use the **search bar** at the top to search across all topics.



---

## 12. Data Format Reference

### 12.1 Employee Data

Your CSV/Excel file should contain one row per employee with the following columns (column names are auto-detected and flexible):

| Field | Description | Example |
|-------|-------------|---------|
| Employee ID | Unique identifier | EMP001 |
| Pickup Latitude | Latitude of pickup location | 12.9716 |
| Pickup Longitude | Longitude of pickup location | 77.5946 |
| Dropoff Latitude | Latitude of drop-off location | 12.9352 |
| Dropoff Longitude | Longitude of drop-off location | 77.6245 |
| Pickup Address | Human-readable pickup address *(optional)* | "123 MG Road, Bangalore" |
| Dropoff Address | Human-readable drop-off address *(optional)* | "456 Brigade Rd, Bangalore" |
| Earliest Pickup | Earliest allowed pickup time (HH:MM) | 08:00 |
| Latest Dropoff | Latest allowed drop-off time (HH:MM) | 09:30 |
| Priority | Priority level 1–5 (1 = highest) *(optional)* | 3 |
| Sharing Preference | Willing to share ride? *(optional)* | Yes / No |
| Vehicle Preference | Preferred vehicle type *(optional)* | 4-wheeler |

### 12.2 Vehicle Data

Vehicle data can be in the same file (separate sheet) or a separate file:

| Field | Description | Example |
|-------|-------------|---------|
| Vehicle ID | Unique identifier | VEH001 |
| Mode / Type | Vehicle type | 2-wheeler, 4-wheeler, Van |
| Fuel Type | Fuel category | Petrol, Diesel, Electric |
| Capacity | Max passenger seats | 4 |
| Cost Per Km | Operating cost per kilometer | 12.5 |
| Start Latitude | Depot/start latitude | 12.9716 |
| Start Longitude | Depot/start longitude | 77.5946 |
| Avg Speed (km/h) | Average travel speed *(optional)* | 30 |
| Available Time | Vehicle available from (HH:MM) *(optional)* | 07:00 |

> **Tip**: The parser is intelligent and adapts to various column naming conventions. Common variations like "emp_id", "employee_id", "lat", "latitude", "pickup_lat" are all recognized automatically.

---

## 13. Keyboard Shortcuts

These shortcuts are available in the **Map View**:

| Key | Action |
|-----|--------|
| **← Left Arrow** | Seek backward 1 minute |
| **→ Right Arrow** | Seek forward 1 minute |
| **F** | Toggle fullscreen mode |
| **Space** | Play / Pause timeline *(when map is focused)* |

---

## 14. Troubleshooting & FAQ

### "Python was not found" error during parsing
This occurs on Windows when the Python executable is not in the system PATH. Ensure Python is installed and accessible. The platform automatically uses `python` on Windows and `python3` on macOS/Linux.

### Run stuck at "Processing"
If a run stays in Processing status for longer than expected, the system automatically recovers stale runs and marks them as Failed. You can then retry the run. Processing times vary:
- Free tier: ~2 minutes
- Premium tier: up to 20 minutes

### "Infeasible" result
This means the solver could not find a valid solution that satisfies all constraints. Try:
- Relaxing preferences (set Preferences to "Break Sharing" or "Break Both")
- Checking time windows — ensure they are not too tight
- Verifying vehicle capacity is sufficient

### Parse confidence is low
Low confidence means the parser had difficulty interpreting your data. Check that:
- Column names are recognizable (e.g., "latitude" not "col_3")
- Coordinates are valid numbers (not swapped lat/lng)
- Time windows are in HH:MM format
- There are no excessive blank rows or merged cells

### Shared link not working
Ensure sharing is still enabled on the project. Shared links can be revoked by the project owner, which disables access immediately.

### File upload rejected
Supported formats are CSV (`.csv`), Excel (`.xls`, `.xlsx`). Maximum file size is 50MB. Ensure the file is not corrupted or password-protected.

### Map not loading
Verify that your browser allows location services and that no ad-blockers are interfering with Google Maps. Try refreshing the page or clearing browser cache.

---

*Velora — Optimize Every Commute*

