# Pipeline Execution Guide — TestCase TC01

## Overview

This document describes the end-to-end pipeline that takes a raw Excel file (`TestCase_TC01.xlsx`), parses it using a Gemini LLM, feeds it into the Python genetic algorithm engine, and produces optimized route results.

**Pipeline run on:** 2026-02-11 18:43:37  
**Total time:** ~86 seconds  
**Result:** ✅ Completed — Cost ₹721.29, Savings 77.5%

---

## Architecture

```
TestCase_TC01.xlsx
       │
       ▼
┌──────────────┐     POST /api/projects/:id/ingest
│  Upload API  │     (multipart/form-data)
└──────┬───────┘
       │
       ▼
┌──────────────┐     POST /api/projects/:id/parse-and-run
│  LLM Parser  │     Gemini 2.5 Flash Lite
│  (llmParser) │     Extracts canonical JSON from xlsx
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Validation  │     canonicalSchema.js (AJV)
│              │     Validates employees, vehicles, baseline
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Python Engine│     main.py → JsonParser → GeneticSolver
│  (solver.py) │     8 parallel strategies, 300 generations
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Results    │     GET /api/projects/:id/results
│   (JSON)     │     metrics, rides, unassigned
└──────────────┘
```

---

## Step-by-Step Execution

### Prerequisites

1. **MongoDB** running locally on `localhost:27017`
2. **Backend server** running: `cd backend && node server.js` (port 5001)
3. **Environment variables** in `backend/.env`:
   - `GEMINI_API_KEY` — for LLM parsing
   - `OSRM_BASE_URL` (optional) — OSRM server URL (default: `https://router.project-osrm.org`)
   - `OSRM_PROFILE` (optional) — routing profile (default: `driving`)
4. **Python 3** with dependencies: `pandas`, `requests`

---

### Step 1: Login

```bash
curl -s -X POST http://localhost:5001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"secret123"}'
```

**Response:**
```json
{
  "_id": "698b70ba10e345861a14f68c",
  "name": "Test",
  "email": "test@example.com",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

Save the `token` for subsequent requests.

---

### Step 2: Create Project

```bash
curl -s -X POST http://localhost:5001/api/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Pipeline Run TC01"}'
```

**Response:** Returns a project object with `_id`. Save as `$PROJECT_ID`.

---

### Step 3: Upload XLSX

```bash
curl -s -X POST http://localhost:5001/api/projects/$PROJECT_ID/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@/Users/akhilesh/Downloads/TestCase_TC01.xlsx"
```

**Response:**
```json
{"success": true, "artifactsCount": 1}
```

**What happens internally:**
- The xlsx file is stored in `backend/uploads/`
- It's registered as an `inputArtifact` on the project document in MongoDB

---

### Step 4: Parse & Run (the main step)

```bash
curl -s -X POST http://localhost:5001/api/projects/$PROJECT_ID/parse-and-run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN"
```

This is a **synchronous** call that does two major things:

#### 4a. LLM Parsing (`llmParser.js`)
- Reads the uploaded xlsx using `xlsx` library, converts each sheet to CSV text
- Sends the text to **Gemini 2.5 Flash Lite** with a structured prompt
- Gemini returns a canonical JSON with employees, vehicles, baseline, metadata
- Schema validation via `canonicalSchema.js` (AJV)

**LLM output (canonical JSON) for TC01:**
- **8 employees** (EMP001-EMP008) with lat/lng, time windows, priorities
- **3 vehicles** (V01-V03) with capacity, cost/km, speed, start location
- **8 baseline entries** with individual costs and times
- **Confidence: 1.0**, no missing fields, no warnings

#### 4b. Python Engine (`engineRunner.js` → `main.py`)
- Node spawns `python3 main.py` as a child process
- Canonical JSON is piped via stdin
- `JsonParser` converts to `ProblemInstance` (models.py)
- `precompute_distance_matrix()` — fetches road distances from OSRM (default)
- **8 parallel solver runs**, each with a different strategy:
  - Logic, Chaos, Sniper, Explore, Balance, Hybrid, Spec-A, Spec-B
- Each uses a genetic algorithm: 70 population × 300 generations
- Simulated annealing acceptance for mutations
- Fine-tuning pass after GA completes
- Best solution selected by `objective_score`
- JSON result written to stdout

**Time: ~86 seconds** (LLM ~5s, Engine ~80s)

---

### Step 5: Fetch Results

```bash
curl -s http://localhost:5001/api/projects/$PROJECT_ID/results \
  -H "Authorization: Bearer $TOKEN"
```

---

## Results — TC01

### Metrics

| Metric | Value |
|--------|-------|
| **Total System Cost** | ₹721.29 |
| **Total Time** | 177.7 min |
| **Baseline Cost** | ₹3,200.00 |
| **Baseline Time** | 425.0 min |
| **Savings** | ₹2,478.71 **(77.5%)** |
| **Null Fields** | None ✅ |

### Route Assignments

#### Ride 1 — Vehicle V01 (Premium, cap=3, ₹10/km)
| Field | Value |
|-------|-------|
| Employees | EMP001, EMP006, EMP002, EMP004, EMP007, EMP008 |
| Cost | ₹572.55 |
| Time | 159.5 min |
| Path Stops | 12 (6 pickups + 6 dropoffs) |
| Feasible | ✅ Yes |

#### Ride 2 — Vehicle V02 (Normal, cap=4, ₹14/km)
| Field | Value |
|-------|-------|
| Employees | EMP005, EMP003 |
| Cost | ₹148.74 |
| Time | 18.2 min |
| Path Stops | 4 (2 pickups + 2 dropoffs) |
| Feasible | ✅ Yes |

**Unassigned Employees:** None  
**Vehicle V03:** Not used by optimizer (all employees fit in V01+V02)

### Distance Calculation
- **Method:** OSRM (OpenStreetMap road distances)
- **Config:** `OSRM_BASE_URL` and `OSRM_PROFILE` from `engine/.env`
- **Fallback:** Haversine (straight-line) if OSRM unavailable

### Objective Function
```
score = (cost_weight × route_cost) + (time_weight × route_time) + penalties
```
- `cost_weight = 0.5`, `time_weight = 0.5` (from metadata defaults)
- `route_cost = total_distance_km × vehicle.cost_per_km`
- Penalties for: capacity violations, sharing preferences, late drops, unassigned employees

### Convergence / Early Stop
The solver now uses relaxed convergence-based stopping so it does not consume all
planned generations after objective plateaus, but it still guarantees a minimum
generation floor before early stop is considered.

Key metadata knobs (optional):

- `EARLY_STOP_ENABLED` (`true`/`false`, default `true`)
- `MIN_EARLY_STOP_GENERATIONS` (default `20`)
- effective early-stop floor is also raised to at least `(employee_count * 2) * 3.5`
- effective minimum runtime is also raised to at least `employee_count * 2.5` seconds
- `STAGNATION_GRACE_GENERATIONS` (default `10`)
- `BEST_RUN_GRACE_GENERATIONS` (default `24`)
- `CROSS_RUN_TARGET_REL_GAP` (default `0.015`)
- `CROSS_RUN_TARGET_ABS_GAP` (default `0.5`)
- `MAX_RUN_SECONDS` (hard wall-clock cap per solver run, default `60`)
- `EARLY_STOP_MIN_GENERATIONS` (default ~40% of planned generations)
- `EARLY_STOP_PATIENCE_GEN` (no-significant-improvement generations before stop)
- `STAGNATION_LIMIT_GEN` (restart trigger when no significant progress)
- `SIGNIFICANT_IMPROVEMENT_ABS`, `SIGNIFICANT_IMPROVEMENT_REL`
- `EARLY_STOP_MIN_DELTA_ABS`, `EARLY_STOP_MIN_DELTA_REL`
- `EARLY_STOP_REQUIRE_HASH_STABLE` (default `true`, stricter convergence)
- `EARLY_STOP_POTENTIAL_MULTIPLIER` (micro-improvement sensitivity factor)

Run summaries now include:

- `generationsPlanned`
- `generationsExecuted`
- `terminatedEarly`
- `terminationReason`

---

## How to Re-Run

### Option A: Smoke Validation Script
```bash
cd backend/engine
python3 smoke_run.py
```
Located at: `backend/engine/smoke_run.py`  
This script runs the engine twice with a fixed seed and writes reproducibility
summary to `backend/engine/run_results/smoke_summary.json`.

### Option B: Direct Engine (CSV, no LLM)
```bash
cd backend/engine
python3 main.py --testcase testcase1
```
This uses CSV fixtures in `backend/engine/testcase1/` (skips LLM parsing).

### Option C: Manual curl commands
Follow Steps 1-5 above with your own `$TOKEN` and `$PROJECT_ID`.

### Option D: Engine from stdin canonical JSON (same mode as backend)
```bash
cd backend/engine
python3 main.py --seed 4242 < /tmp/canonical_input.json
```

---

## Key Files

| File | Purpose |
|------|---------|
| `backend/server.js` | Express server, port 5001 |
| `backend/controllers/projectPipelineController.js` | Orchestrates parse-and-run |
| `backend/services/llmParser.js` | Gemini LLM canonical extraction |
| `backend/services/engineRunner.js` | Spawns Python engine |
| `backend/validation/canonicalSchema.js` | JSON schema for canonical format |
| `backend/engine/main.py` | Python entry point |
| `backend/engine/parser.py` | FileParser (CSV) + JsonParser (LLM JSON) |
| `backend/engine/solver.py` | Genetic algorithm orchestration |
| `backend/engine/objective.py` | Objective function + constraint evaluation |
| `backend/engine/utils.py` | Distance calculation (OSRM / Haversine) |
| `backend/engine/models.py` | Data models (Employee, Vehicle, Baseline) |

---

## Solver Runtime & Convergence Controls

The engine now uses a unified stop controller (`stop_controller.py`) with:

- hard wall time (`TIME_LIMIT_SEC`, default `25`)
- minimum runtime (`MIN_RUNTIME_SEC`, default `4`)
- checkpoint stagnation (`CHECKPOINT_EVERY_SEC`, `EPS_REL`, `STALL_CHECKPOINTS`)
- early stop is blocked until `MIN_EARLY_STOP_GENERATIONS`
- early stop is also blocked until the employee-scaled generation floor is reached
- stagnation stop is blocked until the employee-scaled runtime floor is reached
- hard time limit is also gated by the effective minimum generation floor, so a run
  will not stop on time alone before it reaches that floor
- a stagnant run is not stopped while it is still materially behind the best
  objective already found by another run
- the current best run gets additional grace before it can stop
- confidence-based stop (`stagnation_confident`)
- optional MIP probe stop (`mip_optimal` / `mip_gap`)
- one escape burst before confident stagnation stop

`solverMetadata` now includes:

- `stopReason`
- `runtimeSec`
- `bestHistory`
- `diversityHistory`
- `configSnapshot`
- `alnsOperatorStats`

---

## Run Commands

### Heuristic only

```bash
cd backend/engine
python3 main.py \
  --intensity medium \
  --runs 1 \
  --seed 4242 \
  --route-pool-enabled false \
  --ortools-seed-assignment-enabled false \
  --time-limit-sec 25 \
  --min-runtime-sec 4
```

### Heuristic + exact layer (route pool + set partition)

```bash
cd backend/engine
python3 main.py \
  --intensity medium \
  --runs 1 \
  --seed 4242 \
  --route-pool-enabled true \
  --set-partition-time-limit-sec 12 \
  --time-limit-sec 25 \
  --min-runtime-sec 4
```

### CP-SAT assignment seeding enabled

```bash
cd backend/engine
python3 main.py \
  --intensity medium \
  --runs 1 \
  --seed 4242 \
  --ortools-seed-assignment-enabled true \
  --ortools-assign-time-limit-sec 8 \
  --time-limit-sec 25
```

### Run tests

```bash
cd backend/engine
pytest -q tests
```

### Run benchmarks

```bash
cd backend/engine
python3 benchmarks/benchmark_runner.py --seeds 101,202,303
```

Outputs:

- `backend/engine/benchmarks/results.json`
- `backend/engine/benchmarks/summary.md`
