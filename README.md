<p align="center">
  <h1 align="center">Route Optimization Platform</h1>
  <p align="center">
    <em>An intelligent employee pickup-drop route optimizer powered by Genetic Algorithms and ALNS</em>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white" />
  <img src="https://img.shields.io/badge/TailwindCSS-3-06B6D4?logo=tailwindcss&logoColor=white" />
</p>

<p align="center">
  <a href="https://frontend-vert-two-97.vercel.app/"><strong>Live Demo</strong></a>
</p>

---

## Table of Contents

- [What is this Project?](#what-is-this-project)
- [How it Works (Flowchart)](#how-it-works-flowchart)
- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Project File Structure](#project-file-structure)
- [Prerequisites](#prerequisites)
- [Getting Started (Run Locally)](#getting-started-run-locally)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Setup the Backend](#2-setup-the-backend)
  - [3. Setup the Python Engine](#3-setup-the-python-engine)
  - [4. Setup the Frontend](#4-setup-the-frontend)
  - [5. Run Everything Together](#5-run-everything-together)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## What is this Project?

The **Route Optimization Platform** solves the real-world problem of **employee pickup and drop-off routing** for corporate transport fleets.

### The Problem
Companies with large workforces need to transport employees between their homes and offices daily. Manually planning routes for dozens of vehicles and hundreds of employees is:
- **Time-consuming** — hours of manual planning
- **Expensive** — unoptimized routes waste fuel and time
- **Error-prone** — missed time windows, overloaded vehicles

### The Solution
This platform automates it. You upload employee locations, vehicle details, and constraints — and the optimizer generates the most efficient routes considering:

| Feature | Description |
|---|---|
| **Distance minimization** | Shortest total travel distance across all vehicles |
| **Time-window constraints** | Each employee has earliest-pickup and latest-drop times |
| **Vehicle capacity** | No vehicle exceeds its seat capacity |
| **Cost optimization** | Minimizes fuel cost based on per-km vehicle cost |
| **Multiple route types** | Supports pickup-only, drop-only, and both |
| **Employee preferences** | Premium vehicle preference, sharing preferences |
| **Visual analytics** | Interactive maps, timeline charts, route metrics |

---

## How it Works (Flowchart)

### End-to-End User Flow

```mermaid
flowchart TD
    A["User Signs Up / Logs In"] --> B["Dashboard"]
    B --> C["Upload Data File\n(Excel / CSV / PDF)"]
    C --> D["AI Parses File\n(Gemini LLM extracts\nemployees and vehicles)"]
    D --> E{"Data Valid?"}
    E -- No --> F["Validation Errors\nShown to User"]
    F --> C
    E -- Yes --> G["Configure Optimization\n(Intensity, Route Type,\nPreferences)"]
    G --> H["Start Optimization"]
    H --> I["Python Engine Runs\n(Genetic Algorithm + ALNS)"]
    I --> J["Real-time Progress\n(Polling for status updates)"]
    J --> K{"Done?"}
    K -- No --> J
    K -- Yes --> L["Results Dashboard"]
    L --> M["Interactive Map View"]
    L --> N["Metrics and Charts"]
    L --> O["Route Timeline"]
    L --> P["Share / Collaborate"]
```

### Optimization Engine Internal Flow

```mermaid
flowchart TD
    A["Receive Problem JSON\n(employees, vehicles, constraints)"] --> B["Validate Input Data"]
    B --> C["Estimate Problem Complexity\n(employees, vehicles, time-windows)"]
    C --> D["Derive Solver Config\n(population size, generations,\nALNS iterations)"]
    D --> E["Precompute Distance Matrix\n(Haversine / Google Maps API)"]
    E --> F["Generate Initial Population\n(OR-Tools seed + random)"]
    F --> G["8 Parallel Strategy Runs\n(Logic, Chaos, Sniper, Explore,\nBalance, Hybrid, Spec-A, Spec-B)"]
    G --> H["Genetic Algorithm Loop"]
    H --> I["ALNS Improvement\n(Destroy and Repair operators)"]
    I --> J["Route Pool Sharing\n(best routes shared across runs)"]
    J --> K{"Converged or\nTime Limit?"}
    K -- No --> H
    K -- Yes --> L["Select Best Solution\n(lowest cost + feasibility)"]
    L --> M["Build Route Timelines\nand Metrics"]
    M --> N["Return JSON Result"]
```

### System Architecture

```mermaid
flowchart LR
    subgraph "Client"
        A["React Frontend\n(Vite + Tailwind)"]
    end

    subgraph "Backend Server"
        B["Express.js API"]
        C["MongoDB"]
        D["Gemini AI\n(LLM Parser)"]
    end

    subgraph "Optimization Engine"
        E["Python Process\n(Genetic Algo + ALNS)"]
    end

    A <-->|"REST API\n(JSON)"| B
    B <-->|"Mongoose"| C
    B -->|"File Parsing\nPrompt"| D
    B -->|"Spawns\nChild Process"| E
    E -->|"JSON Result\nvia stdout"| B
```

---

## Tech Stack

### Frontend
| Technology | Purpose |
|---|---|
| **React 19** | UI framework |
| **Vite (Rolldown)** | Dev server and build tool |
| **Tailwind CSS 3** | Utility-first styling |
| **React Router 7** | Client-side routing |
| **Leaflet + React-Leaflet** | Interactive map rendering |
| **Google Maps API** | Directions and geocoding |
| **Recharts** | Data visualization charts |
| **Framer Motion** | Smooth animations |
| **Three.js + R3F** | 3D effects on landing page |
| **Axios** | HTTP client for API calls |
| **Lucide React** | Icon library |

### Backend
| Technology | Purpose |
|---|---|
| **Node.js 20** | Server runtime |
| **Express 5** | REST API framework |
| **MongoDB + Mongoose** | Database and ODM |
| **JWT** | Authentication tokens |
| **Multer** | File upload handling |
| **bcryptjs** | Password hashing |
| **Nodemailer** | Email sending |
| **Razorpay** | Subscription billing |
| **Google Gemini AI** | Intelligent file parsing (LLM) |
| **xlsx** | Excel file processing |
| **pdf-parse** | PDF file processing |

### Python Optimization Engine
| Technology | Purpose |
|---|---|
| **Python 3.10+** | Engine runtime |
| **Custom Genetic Algorithm** | Population-based metaheuristic solver |
| **ALNS (Adaptive Large Neighborhood Search)** | Local search improvement |
| **OR-Tools (optional)** | Seed solution generation |
| **Pandas** | Data parsing support |
| **Requests** | HTTP calls for distance APIs |

---

## Architecture Overview

The project is a **monorepo** with three main components:

```
+-------------------------------------------------------------+
|                    MONOREPO ROOT                            |
+-----------------+------------------+------------------------+
|   frontend/     |    backend/      |   backend/engine/      |
|   (React App)   |   (Node.js API)  |   (Python Solver)      |
|                 |                  |                        |
|  - Landing Page |  - REST API      |  - Genetic Algorithm   |
|  - Dashboard    |  - Auth (JWT)    |  - ALNS Operators      |
|  - Map View     |  - File Upload   |  - Multi-strategy      |
|  - Metrics      |  - LLM Parsing   |    Parallel Solver     |
|  - Timeline     |  - Project CRUD  |  - Route Pool          |
|  - Collaborate  |  - Billing       |  - Distance Matrix     |
|  - Settings     |  - WebSocket     |  - OR-Tools Hybrid     |
|  - Validator    |  - Email/OTP     |  - Convergence Control |
+-----------------+------------------+------------------------+
```

**How they connect:**
1. The **Frontend** (React) makes REST API calls to the **Backend** (Express)
2. The **Backend** stores data in **MongoDB** and handles authentication
3. When optimization is triggered, the backend **spawns a Python child process** running the engine
4. The Python engine reads the problem as JSON, runs the optimizer, and writes the result to stdout
5. The backend captures the result and stores it in MongoDB
6. The frontend polls for progress and displays results when ready

---

## Project File Structure

```
Route_Optimization/
|
+-- frontend/                          # React Web Application
|   +-- public/                        #   Static assets
|   +-- src/
|   |   +-- api/                       #   Axios API client functions
|   |   +-- assets/                    #   Images, fonts, etc.
|   |   +-- components/                #   Reusable UI components
|   |   |   +-- sidebar/               #     Navigation sidebar
|   |   |   +-- topbar/                #     Top navigation bar
|   |   |   +-- background/            #     Animated backgrounds
|   |   |   +-- user/                  #     User profile components
|   |   +-- pages/                     #   Route-level page components
|   |   |   +-- auth/                  #     Login / signup
|   |   |   +-- landing/               #     Landing page (3D hero)
|   |   |   +-- dashboard/             #     Main dashboard
|   |   |   +-- projects/              #     Project views (map, results)
|   |   |   +-- metrics/               #     Analytics and charts
|   |   |   +-- collaborate/           #     Team collaboration
|   |   |   +-- validator/             #     Data validation tool
|   |   |   +-- settings/              #     User settings
|   |   |   +-- help/                  #     Help and support
|   |   +-- utils/                     #   Utility functions
|   |   +-- App.jsx                    #   Root component with routing
|   |   +-- App.css                    #   Global app styles
|   |   +-- main.jsx                   #   React entry point
|   |   +-- config.js                  #   Frontend configuration
|   +-- .env.example                   #   Environment variable template
|   +-- package.json                   #   NPM dependencies
|   +-- vite.config.js                 #   Vite build configuration
|   +-- tailwind.config.js             #   Tailwind CSS configuration
|   +-- postcss.config.js              #   PostCSS configuration
|
+-- backend/                           # Node.js API Server
|   +-- config/
|   |   +-- db.js                      #   MongoDB connection setup
|   +-- controllers/                   #   Route handler logic
|   |   +-- authController.js          #     Signup, login, password management, Google auth
|   |   +-- projectController.js       #     Project CRUD operations
|   |   +-- projectPipelineController.js #   File parsing + optimization pipeline
|   |   +-- dashboardController.js     #     Dashboard statistics
|   |   +-- collaborateController.js   #     Team sharing and collaboration
|   |   +-- billingController.js       #     Razorpay subscription management
|   |   +-- validatorController.js     #     Standalone data validator
|   +-- middleware/
|   |   +-- authMiddleware.js          #   JWT token verification
|   |   +-- errorMiddleware.js         #   Global error handler
|   |   +-- uploadMiddleware.js        #   Multer file upload config
|   +-- models/                        #   Mongoose schemas
|   |   +-- User.js                    #     User account model
|   |   +-- Project.js                 #     Project (with run results)
|   |   +-- Team.js                    #     Team and collaboration model
|   |   +-- Vehicle.js                 #     Vehicle specifications
|   |   +-- Ride.js                    #     Individual ride records
|   +-- routes/                        #   Express route definitions
|   |   +-- authRoutes.js              #     /api/auth/*
|   |   +-- projectRoutes.js           #     /api/projects/* (umbrella)
|   |   +-- projectCrudRoutes.js       #     Project create/read/update/delete
|   |   +-- projectPipelineRoutes.js   #     File upload and optimization runs
|   |   +-- dashboardRoutes.js         #     /api/dashboard/*
|   |   +-- collaborateRoutes.js       #     /api/collaborate/*
|   |   +-- billingRoutes.js           #     /api/billing/*
|   |   +-- validatorRoutes.js         #     /api/validator/*
|   |   +-- publicProjectRoutes.js     #     /api/shared/* (no auth)
|   +-- services/                      #   Business logic services
|   |   +-- engineRunner.js            #     Spawns Python engine process
|   |   +-- llmParser.js               #     Gemini AI file parsing
|   |   +-- rgxParser.js               #     Regex-based fallback parser
|   |   +-- pythonRgxParser.js         #     Python regex parser bridge
|   |   +-- solver.js                  #     Solver orchestration
|   |   +-- baselineRunner.js          #     Baseline cost calculator
|   |   +-- artifactNormalizer.js      #     Data normalization
|   |   +-- standaloneValidator.js     #     Input data validator
|   |   +-- runValidator.js            #     Post-run result validator
|   |   +-- runRecovery.js             #     Crashed-run recovery monitor
|   |   +-- geminiClient.js            #     Gemini SDK client
|   +-- utils/                         #   Utility modules
|   |   +-- jwt.js                     #     Token sign/verify helpers
|   |   +-- mail.js                    #     Email sending via Nodemailer
|   |   +-- billing.js                 #     Razorpay helpers
|   |   +-- validators.js              #     Input validation helpers
|   |   +-- authOtpStore.js            #     Legacy OTP storage utility
|   +-- validation/                    #   JSON schema validation
|   |   +-- canonicalSchema.js         #     AJV schema for canonical format
|   |   +-- validateCanonical.js       #     Schema validator logic
|   +-- engine/                        #   Python Optimization Engine
|   |   +-- main.py                    #     Entry point — orchestrates the solver
|   |   +-- solver.py                  #     Genetic Algorithm implementation
|   |   +-- alns.py                    #     Adaptive Large Neighborhood Search
|   |   +-- operators.py               #     Destroy and repair operators
|   |   +-- neighborhoods.py           #     Neighborhood search strategies
|   |   +-- objective.py               #     Fitness / objective function
|   |   +-- initialization.py          #     Initial population generation
|   |   +-- models.py                  #     Data models (Employee, Vehicle, etc.)
|   |   +-- parser.py                  #     Problem parsing from JSON/file
|   |   +-- rgx_parser.py              #     Regex-based parser
|   |   +-- utils.py                   #     Distance, travel time calculations
|   |   +-- diversity.py               #     Solution diversity tracking
|   |   +-- route_pool.py              #     Shared route pool across runs
|   |   +-- set_partition.py           #     Set partitioning formulation
|   |   +-- hybrid_ortools.py          #     OR-Tools integration
|   |   +-- baseline_solver.py         #     Baseline greedy solver
|   |   +-- baseline_generator.py      #     Baseline solution creator
|   |   +-- finetuner.py               #     Post-optimization fine-tuning
|   |   +-- stop_controller.py         #     Early-stopping convergence logic
|   |   +-- run_progress.py            #     Progress tracking
|   |   +-- representation.py          #     Solution encoding/decoding
|   |   +-- solution_objective.py      #     Solution cost computation
|   |   +-- solution_status.py         #     Feasibility checking
|   |   +-- smoke_run.py               #     Quick validation run
|   |   +-- validate_distance.py       #     Distance sanity checks
|   |   +-- requirements.txt           #     Python dependencies
|   |   +-- tests/                     #     Unit tests
|   |       +-- test_engine_smoke.py
|   |       +-- test_early_stop.py
|   |       +-- test_reproducibility_seed.py
|   |       +-- ... (more tests)
|   +-- server.js                      #   Express app entry point
|   +-- package.json                   #   NPM dependencies
|   +-- Dockerfile                     #   Docker build for deployment
|   +-- .env.example                   #   Environment variable template
|   +-- nodemon.json                   #   Nodemon dev config
|
+-- render.yaml                        #   Render deployment config
+-- vercel.json                        #   Vercel (frontend) deployment config
+-- README.md                          #   You are here!
```

---

## Prerequisites

Before you begin, make sure you have the following installed on your machine:

| Requirement | Version | How to Check | How to Install |
|---|---|---|---|
| **Node.js** | v20+ | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | v10+ | `npm --version` | Comes with Node.js |
| **Python** | 3.10+ | `python3 --version` | [python.org](https://python.org/) |
| **pip** | latest | `pip3 --version` | Comes with Python |
| **Git** | any | `git --version` | [git-scm.com](https://git-scm.com/) |
| **MongoDB** (cloud) | — | — | [Create free Atlas cluster](https://www.mongodb.com/atlas) |

### Accounts You Will Need (Free)
- **MongoDB Atlas** — Free-tier cloud database: [mongodb.com/atlas](https://www.mongodb.com/atlas)
- **Google AI Studio** — Gemini API key: [aistudio.google.com](https://aistudio.google.com/apikey)
- **Google Cloud Console** — Maps API key + OAuth Client ID: [console.cloud.google.com](https://console.cloud.google.com/)
- **Razorpay** *(optional)* — Only needed if you want billing features: [razorpay.com](https://razorpay.com/)

---

## Getting Started (Run Locally)

### 1. Clone the Repository

```bash
git clone https://github.com/Kriti2026/Route_Optimization.git
cd Route_Optimization
```

---

### 2. Setup the Backend

```bash
# Navigate to the backend folder
cd backend

# Install Node.js dependencies
npm install
```

Now create your environment file:

```bash
# Copy the example env file
cp .env.example .env
```

Open `backend/.env` in any text editor and fill in your values:

```env
# Required — get from MongoDB Atlas dashboard
MONGO_URI=mongodb+srv://youruser:yourpassword@cluster0.xxxxx.mongodb.net/route-optimizer

# Required — any random string for signing JWT tokens
JWT_SECRET=my-super-secret-key-change-me

# Required — get from Google AI Studio
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash-lite

# Required — get from Google Cloud Console
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_MAPS_API_KEY=your-google-maps-api-key

# Local development settings (keep as-is)
NODE_ENV=development
PORT=5001
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173
PUBLIC_FRONTEND_URL=http://localhost:5173
```

> [!TIP]
> You can leave the Razorpay and Mailer settings empty for local development. Those features will simply be disabled.

---

### 3. Setup the Python Engine

The optimization engine is written in Python and lives inside `backend/engine/`.

```bash
# Make sure you are in the backend directory
cd backend

# Create a Python virtual environment (recommended)
python3 -m venv .venv

# Activate it
# On macOS / Linux:
source .venv/bin/activate
# On Windows:
# .venv\Scripts\activate

# Install Python dependencies
pip install -r engine/requirements.txt
```

This installs:
- **requests** — for distance API calls
- **pandas** — for data parsing
- **ortools** — for OR-Tools seed solutions *(optional but recommended)*

> [!NOTE]
> If `ortools` fails to install on your system, the engine has fallback logic and will still work. You will just get slightly less optimal initial solutions.

---

### 4. Setup the Frontend

```bash
# Go back to the root, then into frontend
cd ../frontend

# Install dependencies
npm install
```

Create the frontend environment file:

```bash
cp .env.example .env
```

Open `frontend/.env` and set:

```env
# Points to your local backend
VITE_API_BASE_URL=http://localhost:5001

# Google Maps key (same one from backend setup)
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key

# Google OAuth Client ID (same one from backend setup)
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

---

### 5. Run Everything Together

You need **two terminal windows** running simultaneously:

#### Terminal 1 — Start the Backend

```bash
cd backend
npm run dev
```

You should see:
```
Server running on port 5001
Allowed CORS origins: http://localhost:5173
```

#### Terminal 2 — Start the Frontend

```bash
cd frontend
npm run dev
```

You should see:
```
  VITE v7.x.x  ready in Xms

  -> Local:   http://localhost:5173/
```

**Open your browser** and go to **[http://localhost:5173](http://localhost:5173)**

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: `5001`) |
| `NODE_ENV` | No | `development` or `production` |
| `MONGO_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret key for JWT tokens |
| `GEMINI_API_KEY` | Yes | Google Gemini API key for file parsing |
| `GEMINI_MODEL` | No | Gemini model name (default: `gemini-2.5-flash-lite`) |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps API key for accurate distances |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |
| `FRONTEND_URL` | No | Frontend URL for redirects |
| `MAIL_HOST` | No | SMTP host (e.g., `smtp.gmail.com`) |
| `MAIL_PORT` | No | SMTP port (e.g., `587`) |
| `MAIL_USER` | No | SMTP email username |
| `MAIL_PASS` | No | SMTP app password |
| `RAZORPAY_KEY_ID` | No | Razorpay test/live key |
| `RAZORPAY_KEY_SECRET` | No | Razorpay secret |

### Frontend (`frontend/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend API URL (e.g., `http://localhost:5001`) |
| `VITE_API_BASE_URL_FALLBACK` | No | Fallback API URL |
| `VITE_API_USE_FALLBACK` | No | `true` to force fallback URL |
| `VITE_GOOGLE_MAPS_API_KEY` | Yes | Google Maps JavaScript API key |
| `VITE_GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |

---

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register new account |
| `POST` | `/api/auth/login` | Login with email/password |
| `POST` | `/api/auth/google` | Login with Google OAuth |
| `POST` | `/api/auth/forgot-password` | Reset password directly |
| `POST` | `/api/auth/change-password` | Change password directly |

### Projects
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects/upload` | Upload data file and create project |
| `GET` | `/api/projects/:id` | Get project details |
| `POST` | `/api/projects/:id/run` | Start optimization run |
| `GET` | `/api/projects/:id/status` | Poll run status/progress |
| `GET` | `/api/projects/:id/results` | Get optimization results |
| `DELETE` | `/api/projects/:id` | Delete a project |

### Dashboard
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Get dashboard overview stats |

### Collaboration
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/collaborate/share` | Share project with team |
| `GET` | `/api/collaborate/teams` | List user's teams |

### Billing
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/billing/subscription` | Create subscription |
| `POST` | `/api/billing/verify` | Verify payment |
| `POST` | `/api/billing/cancel` | Cancel subscription |
| `GET` | `/api/billing/status` | Get billing status |

### Health
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/` | Service info |

---

## Deployment

### Frontend on Vercel

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com) and import the repository
3. Set the **Root Directory** to `frontend`
4. Vercel auto-detects Vite — no build config changes needed
5. Add environment variables (`VITE_API_BASE_URL`, `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_CLIENT_ID`)
6. Deploy

### Backend on Railway / Render

#### Option A: Railway (recommended)
1. Create a new service on [railway.app](https://railway.app)
2. Set **Root Directory** to `backend`
3. Railway detects the `Dockerfile` and builds automatically
4. Add all env vars from `backend/.env.example`
5. Set `CORS_ORIGINS` to your Vercel frontend URL

#### Option B: Render
1. Connect your GitHub repo to [render.com](https://render.com)
2. The `render.yaml` file auto-configures the service
3. Add secret env vars (`MONGO_URI`, `JWT_SECRET`, `GEMINI_API_KEY`, etc.)

```mermaid
flowchart LR
    A["GitHub\nRepository"] --> B["Vercel\n(Frontend)"]
    A --> C["Railway / Render\n(Backend + Engine)"]
    C <--> D["MongoDB Atlas\n(Database)"]
    C <--> E["Google Gemini\n(AI Parsing)"]
    B <-->|"API Calls"| C
```

---

## Troubleshooting

### Common Issues

<details>
<summary><strong>"Cannot connect to MongoDB"</strong></summary>

- Make sure your `MONGO_URI` in `.env` is correct
- Check that your IP address is whitelisted in MongoDB Atlas:
  - Go to Atlas > Network Access > Add IP Address > "Allow Access from Anywhere" (for development)
- Verify the database user credentials match what is in the URI

</details>

<details>
<summary><strong>"CORS error" in browser console</strong></summary>

- Make sure `CORS_ORIGINS` in `backend/.env` includes `http://localhost:5173`
- Check there are no trailing slashes in the URL
- Restart the backend after changing `.env`

</details>

<details>
<summary><strong>Python engine fails / "Module not found"</strong></summary>

- Make sure you activated the virtual environment: `source backend/.venv/bin/activate`
- Re-install dependencies: `pip install -r backend/engine/requirements.txt`
- Check Python version: `python3 --version` (needs 3.10+)

</details>

<details>
<summary><strong>"Gemini API key invalid"</strong></summary>

- Get a fresh key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Make sure `GEMINI_API_KEY` is set in `backend/.env` (not `frontend/.env`)
- The key should NOT have quotes around it in the `.env` file

</details>

<details>
<summary><strong>Google Maps not showing</strong></summary>

- Verify `VITE_GOOGLE_MAPS_API_KEY` is set in `frontend/.env`
- Enable **Maps JavaScript API** and **Directions API** in Google Cloud Console
- Check billing is enabled on your Google Cloud project (Maps requires a billing account, but the free tier covers normal usage)

</details>

<details>
<summary><strong>"npm install" fails</strong></summary>

- Delete `node_modules` and `package-lock.json`, then try again:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```
- Make sure you are using Node.js v20+

</details>

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---
