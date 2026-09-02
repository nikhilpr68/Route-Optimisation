# Engine Algorithm Flow Report (Detailed)

Date: 2026-02-23  
Scope: End-to-end algorithmic flow of the optimization engine in `backend/engine`, from API invocation to final JSON response.

## 1. Purpose and Reading Guide

This report documents the exact execution flow of the route optimization engine and explains each algorithmic stage at function-level detail.

Primary goals:
1. Explain how the engine receives and normalizes input.
2. Explain how the hybrid solver (GA + ALNS + exact set partition) works internally.
3. Explain how feasibility, penalties, stopping, and final output are computed.
4. Make each step traceable to concrete files/functions.

Key entry files:
1. `backend/controllers/projectPipelineController.js`
2. `backend/services/engineRunner.js`
3. `backend/engine/main.py`
4. `backend/engine/solver.py`

---

## 2. Top-Level Execution Chain

### 2.1 Backend API to Python engine

1. Controller triggers engine run:
   - `runPythonEngine(project.parsedInput, { args: ['--intensity', optimizationIntensity] })`
   - References:
     - `backend/controllers/projectPipelineController.js:213`
     - `backend/controllers/projectPipelineController.js:400`

2. Node service starts Python process:
   - `runPythonEngine()` spawns `python3 backend/engine/main.py`
   - Canonical JSON is written to stdin.
   - stdout is parsed back to JSON with robust fallback scanning.
   - References:
     - `backend/services/engineRunner.js:91`
     - `backend/services/engineRunner.js:4`

3. Python returns one JSON payload:
   - Contains final best solution plus run-level diagnostics (`solverRuns`, `objectiveTrend`, `solverConfig`, distance mode).

### 2.2 Engine entrypoint

`main()` in `backend/engine/main.py:747` is the orchestration function.

High-level sequence in `main()`:
1. Parse CLI args.
2. Load problem from stdin JSON or testcase CSV.
3. Configure distance backend and precompute matrix.
4. Apply metadata/CLI overrides.
5. Perform fast infeasibility pre-check for impossible delay cases.
6. Derive run counts, population, generations from complexity + intensity.
7. Run multiple solver runs in parallel.
8. Pick global best solution across runs.
9. Serialize to API JSON payload.

---

## 3. Input and Internal Data Model

### 3.1 Input loaders

Two modes:
1. API mode: stdin canonical JSON -> `JsonParser.load_from_canonical()`
   - `backend/engine/parser.py:199`
2. Local testcase mode: CSV files -> `FileParser.load_data()`
   - `backend/engine/parser.py:66`

`load_problem()` chooses mode by checking stdin availability:
- `backend/engine/main.py:674`

### 3.2 Core domain objects

1. `Employee`
   - Fields include time window, pickup/drop coordinates, preferences.
   - `backend/engine/models.py:37`
2. `Vehicle`
   - Fields include capacity, speed, cost/km, availability, category.
   - `backend/engine/models.py:52`
3. `ProblemInstance`
   - Holds employees, vehicles, metadata, baseline.
   - Objective weights are metadata-driven:
     - `objective_cost_weight` default `0.5`
     - `objective_time_weight` default `0.5`
   - `backend/engine/models.py:69`
4. `Route`
   - Vehicle route with stop sequence and computed metrics.
   - `backend/engine/representation.py:8`
5. `Individual`
   - One complete candidate solution: one route per vehicle + unassigned list.
   - `backend/engine/representation.py:32`

### 3.3 Priority-based delay policy

`get_max_allowed_delay(priority, metadata)` determines max permissible lateness per priority:
- Defaults:
  - priority 1 -> 15 min
  - priority 2 -> 30 min
  - priority 3/4/5 -> 45 min
- Metadata override key format: `priority_{k}_max_delay_min`
- `backend/engine/models.py:12`

---

## 4. Distance Backend and Matrix Warmup

### 4.1 Metric selection

`configure_distance_metric()` selects backend:
1. `osrm` (road distance) by default.
2. `haversine` fallback if unavailable and strict-road not required.

References:
1. `backend/engine/utils.py:211`
2. `backend/engine/main.py:747` distance setup block.

### 4.2 Distance retrieval behavior

`get_distance(loc1, loc2)` behavior:
1. Try in-memory/persisted cache first.
2. If road mode:
   - query backend (`OSRM`).
   - cache result.
   - if strict road required and lookup fails -> raise runtime error.
3. Else fallback to haversine.

Reference: `backend/engine/utils.py:304`.

### 4.3 Precompute phase

`precompute_distance_matrix(all_locations)`:
1. Deduplicates coordinates.
2. If OSRM, fetches table batches (`/table/v1/{profile}`).
3. Writes pairwise distances into cache.
4. Persists cache to disk.

References:
1. `backend/engine/utils.py:333`
2. `backend/engine/utils.py:355` (OSRM batching helper)

---

## 5. Pre-Solve Normalization and Configuration

### 5.1 CLI/metadata override merge

`main.py` merges runtime controls into metadata:
1. Route pool knobs.
2. Set partition time limit.
3. OR-Tools seed assignment knobs.
4. Stop-control knobs (time, checkpointing, early stop).

Reference: `backend/engine/main.py:747` (argument processing block).

### 5.2 Fast infeasibility pre-check

`_detect_delay_impossible_employee_ids()`:
1. For each employee and each vehicle, estimates direct pickup+drop completion.
2. If no vehicle can satisfy latest-drop + allowed-delay bound, employee is marked forced unassigned.
3. Writes merged set into metadata key `FORCED_UNASSIGNED_IDS`.

Reference: `backend/engine/main.py:619`.

### 5.3 Dynamic solver sizing

`_derive_solver_config()` computes:
1. `runs`
2. `pop_size`
3. `generations`
4. `generation_scale`

Inputs:
1. Problem complexity estimate:
   - employee count, vehicle count, employees/vehicle ratio
   - average time-window width
   - hard-constraint ratio (premium + single-share)
2. Intensity multipliers (`low`, `medium`, `high`)
3. Optional metadata overrides

Reference: `backend/engine/main.py:155`.

---

## 6. Parallel Multi-Run Strategy

### 6.1 Strategy set

Each run uses one strategy profile cycling over:
1. Logic
2. Chaos
3. Sniper
4. Explore
5. Balance
6. Hybrid
7. Spec-A
8. Spec-B

Reference: `backend/engine/main.py` strategy constant block.

### 6.2 Seed management

Per-run seed:
`run_seed = base_seed + run_id * 10007`

Reference: `backend/engine/main.py:45`.

### 6.3 Executor choice

1. stdin/API mode uses `ThreadPoolExecutor` to prevent stdout contamination.
2. testcase mode prefers `ProcessPoolExecutor`, falls back to threads if unavailable.

Reference: `backend/engine/main.py:747` run-with-executor block.

---

## 7. GeneticSolver Architecture

`GeneticSolver` is created in `backend/engine/solver.py:31`.

Main components instantiated:
1. `PopulationInitializer`
2. `GeneticOperators`
3. `ObjectiveEvaluator`
4. `SelectionEngine`
5. `NeighborhoodSearch`
6. `ALNSEngine`
7. `FineTuner`
8. Route-pool archive state

### 7.1 Metadata-driven runtime controls

Important controls (with clamp/default logic):
1. Hybrid:
   - `ROUTE_POOL_ENABLED`
   - `ROUTE_POOL_MAX_ROUTES`
   - `ROUTE_POOL_ARCHIVE_LIMIT`
   - `ROUTE_POOL_TARGETED_VARIANTS`
   - `SET_PARTITION_TIME_LIMIT_SEC`
   - `SET_PARTITION_ITERATIONS`
   - `SET_PARTITION_NO_IMPROVE_ITERS`
2. OR-Tools assignment seed:
   - `ORTOOLS_SEED_ASSIGNMENT_ENABLED`
   - `ORTOOLS_ASSIGN_TIME_LIMIT_SEC`
3. Stop controller:
   - `TIME_LIMIT_SEC` or `MAX_RUN_SECONDS`
   - `MIN_RUNTIME_SEC`
   - `CHECKPOINT_EVERY_SEC`
   - `EPS_REL`
   - `STALL_CHECKPOINTS`
   - `DIVERSITY_MIN`
   - `BURST_SEC`
   - `MIP_PROBE_TIME_SEC`
   - `MIP_GAP_TOL`
4. Stability:
   - `EARLY_STOP_ENABLED`
   - `ELITE_SIZE`
   - `RESTART_FRACTION`
   - `STAGNATION_LIMIT_GEN`
   - `MIN_DIVERSITY_TARGET`
   - `SIGNIFICANT_IMPROVEMENT_ABS`
   - `SIGNIFICANT_IMPROVEMENT_REL`
   - `LAMBDA_DIVERSITY` + bounds

Reference: constructor in `backend/engine/solver.py:31`.

---

## 8. Run Lifecycle (`GeneticSolver.solve`)

Entry: `backend/engine/solver.py:172`.

### 8.1 StopController setup

A `StopController` is created to manage time and confidence-based stopping:
1. Checkpointed progress snapshots (`best`, `diversity`, `hash`).
2. Stagnation detection by relative improvement threshold.
3. Late stop only if min runtime reached and diversity also low.

References:
1. `backend/engine/stop_controller.py:22`
2. `backend/engine/stop_controller.py:74`
3. `backend/engine/stop_controller.py:118`

### 8.2 Assignment seed

`_prepare_assignment_seed()` optionally runs OR-Tools CP-SAT assignment:
1. Build employee->vehicle coarse assignment.
2. Use this as initializer hint.
3. Fallback to deterministic greedy if CP-SAT not available/fails.

References:
1. `backend/engine/solver.py:1341`
2. `backend/engine/hybrid_ortools.py:16`
3. `backend/engine/hybrid_ortools.py:42`
4. `backend/engine/hybrid_ortools.py:146`

### 8.3 Initial population generation

`PopulationInitializer.generate_population()` builds mixed seeds:
1. Regret-based constructive seeds.
2. Greedy seeds.
3. Randomized seeds.
4. Optional assignment-seeded individuals.

Reference: `backend/engine/initialization.py:26`.

Each individual is evaluated with low strictness at start.

### 8.4 Generation loop core

For each generation:

1. Check time-limit hard stop.

2. Compute adaptive controls:
   - mutation rate
   - ruin fraction
   - max victims
   - penalty factor
   - strictness
   - ALNS iterations and top-k ratio
   - based on progress + stagnation
   - Reference: `backend/engine/solver.py:658`

3. Re-evaluate population under current control regime.

4. Elite preservation:
   - Unique by structural hash.
   - Reference: `solver.py` `_select_elites`.

5. Archive top candidates for later route-pool use.

6. Parent selection:
   - tournament selection.
   - Reference: `backend/engine/operators.py` `SelectionEngine`.

7. Crossover:
   - vehicle partition crossover.
   - duplicate passenger prevention across child routes.
   - Reference: `backend/engine/operators.py:364`.

8. Mutation via ruin-and-recreate:
   - `destroy_mode` chosen by weighted policy.
   - `repair_mode` chosen by weighted policy.
   - `ruin_and_recreate()` applies destruction then reinsertion.
   - Reference: `backend/engine/operators.py:169`.

9. Metropolis acceptance:
   - If mutated child better, accept.
   - Else accept with probability `exp(-delta/temp)`.
   - Temperature decreases with generation progress.

10. ALNS refinement on top fraction:
   - Improve best part of candidate pool.
   - Adaptive operator weights updated by observed rewards.
   - Reference: `backend/engine/alns.py:99`.

11. Survivor selection:
   - Structural dedup first.
   - Optional diversity-aware effective score:
     - normalized objective + `lambda_div * similarity_penalty`.
   - Reference: `backend/engine/operators.py:47`.

12. Population refill if under-sized:
   - inject fresh randomized constructive seeds.

13. Best update and stagnation tracking:
   - Improvement threshold:
     - `max(SIGNIFICANT_IMPROVEMENT_ABS, |current_best| * SIGNIFICANT_IMPROVEMENT_REL)`
   - If no improvement, increment stagnation counter.

14. Restart if stagnated:
   - preserve elites, replace fraction with fresh seeds.
   - Reference: `solver.py` `_restart_population`.

15. Diversity injection:
   - if diversity ratio below target and not too late in run.

16. Update diversity pressure:
   - `lambda_diversity` shrinks on improvement, grows when diversity low.

17. Record checkpoint progress in stop controller.

18. Early-stop logic extension:
   - Escape burst if stagnant and burst not attempted.
   - MIP probe if stagnant and route-pool enabled.
   - Confident stagnation stop when low diversity + post-burst + min runtime.

### 8.5 Escape burst

`_run_escape_burst()`:
1. Uses high-exploration settings.
2. Applies repeated ruin/recreate variants within time budget.
3. Keeps improving variants and merges them back.
4. Deduplicates by structural hash.

Reference: `backend/engine/solver.py:794`.

### 8.6 MIP probe during stagnation

`_run_mip_probe()`:
1. Build small route pool from diverse top individuals.
2. Solve set partition with short time limit.
3. If returns high-quality feasible solution, it can replace incumbent.
4. If status optimal or gap below tolerance, stop early.

Reference: `backend/engine/solver.py:884`.

---

## 9. Objective Evaluation: Microscopic Route Simulation

`ObjectiveEvaluator` is in `backend/engine/objective.py:20`.

### 9.1 Evaluation stages

`evaluate(individual, penalty_factor, phase_progress, enforce_hard)`:
1. Compute strictness from phase/progress.
2. Evaluate each route dynamically.
3. Add individual-level consistency penalties.
4. Add unassigned penalty.
5. Attach complete penalty and violation breakdown onto individual.

Reference: `backend/engine/objective.py:29`.

### 9.2 Route base simulation

`_simulate_route_base(route)` performs event simulation:
1. Determine effective start using just-in-time logic based on first stop.
2. Iterate stop sequence.
3. For each movement:
   - accumulate distance/time.
   - apply turnaround buffer when becoming active from idle.
4. Pickup event:
   - enforce earliest pickup waiting.
   - check premium mismatch.
   - increase load.
5. Drop event:
   - precedence check (drop before pickup is hard violation).
   - compute delay.
   - split delay into soft lateness (up to max allowed) and hard excess (beyond max allowed).
   - update employee delay map.
6. Capacity and sharing excess tracking while route progresses.

Reference: `backend/engine/objective.py:174`.

### 9.3 Penalty application

`_apply_penalties()` applies weighted penalty terms:
1. Consistency penalty.
2. Precedence penalty.
3. Soft lateness penalty.
4. Capacity excess penalty.
5. Sharing excess penalty.
6. Premium mismatch penalty.
7. Infeasible-route penalty if hard violation present or soft violations become hard under high strictness/enforce_hard.

Reference: `backend/engine/objective.py:341`.

Penalty constants:
1. Unassigned: `1,000,000`
2. Infeasible route: `250,000`
3. Precedence: `2,000,000`
4. Consistency: `900,000`
5. Premium mismatch: `35,000`
6. Late per minute: `400`
7. Capacity per unit: `140,000`
8. Sharing per unit: `55,000`

(See constants at top of `objective.py`.)

### 9.4 Consistency checks

Route consistency:
1. invalid stop types or missing employee objects
2. pickup/drop count mismatches
3. drop-before-pickup
4. employee list vs sequence mismatch

Reference: `backend/engine/objective.py:447`.

Individual consistency:
1. same employee assigned to multiple routes
2. employee simultaneously assigned and unassigned

Reference: `backend/engine/objective.py:487`.

---

## 10. Genetic Operators and Local Mechanics

### 10.1 Selection engine

`SelectionEngine`:
1. Parent selection by tournament.
2. Survivor elimination with optional diversity-aware score.

Reference: `backend/engine/operators.py:19`.

### 10.2 Destroy operators

`_apply_ruin()` chooses one of:
1. random destroy
2. worst destroy (high marginal-cost passengers)
3. related destroy (spatial/time-window related)
4. route destroy (remove whole routes)

Reference: `backend/engine/operators.py:444`.

### 10.3 Repair operators

`repair_employees()`:
1. Handles forced-unassigned first.
2. Inserts pending employees by:
   - regret-k (`regret2`/`regret3`), or
   - greedy best insertion.

Reference: `backend/engine/operators.py:212`.

### 10.4 Insertion validity engine

`_find_best_insertion_for_route()`:
1. Tries all pickup/drop insertion positions preserving pickup-before-drop order.
2. Uses delta distance estimate to prune expensive candidates.
3. Calls `_check_sequence_validity_and_cost()` for feasibility/cost.

References:
1. `backend/engine/operators.py:660`
2. `backend/engine/operators.py:716`

`_check_sequence_validity_and_cost()` performs route-level strict feasibility checks:
1. invalid stop rejection
2. forced-unassigned rejection
3. precedence enforcement
4. lateness > max allowed rejection
5. capacity/sharing/premium checks
6. if `allow_soft=True` and strictness low, some violations convert into soft penalties instead of immediate rejection

### 10.5 Feasibility repair passes

1. `repair_to_feasible()` rebuilds routes with strict insertion.
2. `force_reassign_unassigned()` makes deterministic strict reassignment attempts.

References:
1. `backend/engine/operators.py:333`
2. `backend/engine/operators.py:278`

---

## 11. ALNS Detailed Behavior

`ALNSEngine` in `backend/engine/alns.py:62`.

`improve()` process (`backend/engine/alns.py:99`):
1. Start from current individual and evaluate.
2. For each ALNS step:
   - choose destroy operator by roulette over `destroy_weights`
   - choose repair operator by roulette over `repair_weights`
   - destroy and repair candidate
   - optional neighborhood improvement when strictness high
   - evaluate candidate
   - accept if better, otherwise probabilistic acceptance by temperature
3. Assign reward based on result:
   - improved best: highest reward
   - improved current: high reward
   - accepted non-improving: moderate reward
   - infeasible or failed operations reduce reward
4. Update operator weights by reaction factor.
5. Normalize weights periodically.

Outputs:
1. best improved individual
2. operator usage/acceptance/improvement stats

---

## 12. Neighborhood Search and Finetuning

### 12.1 Neighborhood moves

`NeighborhoodSearch.improve()` tries several move classes:
1. inter-route relocate
2. inter-route swap
3. intra-route pair reinsert
4. small-route adjacent reorder

References:
1. `backend/engine/neighborhoods.py:26`
2. `backend/engine/neighborhoods.py:69`
3. `backend/engine/neighborhoods.py:127`
4. `backend/engine/neighborhoods.py:221`
5. `backend/engine/neighborhoods.py:274`

### 12.2 FineTuner stage

`FineTuner.tune()` runs near the end of solve:
1. Repeated neighborhood improvements.
2. Attempts dismantling expensive routes and reinserting passengers into cheaper alternatives.
3. Stops on no improvement or time limit.
4. Final hard evaluation.

References:
1. `backend/engine/finetuner.py:28`
2. `backend/engine/finetuner.py:73`

---

## 13. Route Pool and Exact Selection

### 13.1 Why route pool exists

GA can discover good route fragments but not always best global combination.  
Route pool collects many candidate routes and then solves a global selection problem.

### 13.2 Pool representation

`PooledRoute` stores:
1. route ID and vehicle
2. passenger set and stop sequence signature
3. objective and penalty components
4. feasibility flags/violations
5. source metadata (run/generation)

Reference: `backend/engine/route_pool.py:15`.

### 13.3 Dedup and dominance logic

`RoutePoolManager`:
1. canonical signature by passenger set + ordered stop signature
2. keep only best route per dedup key
3. dominance pruning within same passenger set
4. capacity pruning with fairness across passenger-set size and vehicle category

References:
1. `backend/engine/route_pool.py:57`
2. `backend/engine/route_pool.py:128`
3. `backend/engine/route_pool.py:294`
4. `backend/engine/route_pool.py:322`

### 13.4 Iterated set partition in solver

`_run_route_pool_selection()` in `solver.py`:
1. seed manager from best solution + diverse candidates + archives
2. loop for configured partition iterations:
   - solve set partition
   - evaluate result
   - track best exact feasible
   - target hard/uncovered/delayed employees
   - augment route pool by targeted perturbations
3. stop on no improvement limit or no new routes
4. return exact best and diagnostics

Reference: `backend/engine/solver.py:953`.

### 13.5 Set partition solver internals

Entry: `solve_set_partition()` in `backend/engine/set_partition.py:33`.

Backend path:
1. OR-Tools MIP if available:
   - strict exact cover first
   - relaxed cover fallback with uncovered binary variables
   - constraints:
     - each employee covered exactly once (or uncovered in relaxed mode)
     - each vehicle selects at most one route
   - objective:
     - minimize sum(route objective scores)
     - plus large uncovered penalty in relaxed mode
   - Reference: `backend/engine/set_partition.py:86`

2. If MIP unavailable/fails:
   - deterministic DFS search exact cover with timeout
   - if needed, greedy relaxed cover fallback
   - References:
     - `backend/engine/set_partition.py:249`
     - `backend/engine/set_partition.py:410`

3. Build resulting `Individual` from selected route IDs and run strict evaluation:
   - `backend/engine/set_partition.py:445`

---

## 14. Stop Logic and Termination Semantics

### 14.1 Hard stop

Immediate stop when run time crosses configured limit (`time_limit_sec`).

### 14.2 Confidence stop

Stop can occur early if all are true:
1. minimum runtime passed
2. checkpointed stagnation detected
3. diversity below threshold
4. escape burst already attempted

Reference: `backend/engine/stop_controller.py:118`.

### 14.3 MIP-based stop

If MIP probe during stagnation returns:
1. status `optimal`, or
2. relative gap <= configured tolerance

run terminates early with `mip_optimal` or `mip_gap`.

Reference: `backend/engine/solver.py:884`.

### 14.4 Final termination metadata

`run_meta` stores:
1. planned vs executed generations
2. termination reason
3. runtime
4. restart count
5. assignment seed summary
6. route pool stats
7. set partition stats
8. stop controller snapshots

Reference: bottom of `backend/engine/solver.py` `solve()`.

---

## 15. Final Serialization and API Payload

### 15.1 Route timeline reconstruction

`build_route_timeline(route)`:
1. Re-simulates stop-by-stop timeline.
2. Builds:
   - path rows with arrival/departure/load/onboard info
   - compressed state timeline (`travel`, `occupied`, `idle`)
3. Includes consistency verification (monotonic arrival, drop-after-pickup checks).

Reference: `backend/engine/main.py:249`.

### 15.2 Solution export

`solution_to_json(problem, best_solution)`:
1. Converts non-empty routes to `rides`.
2. Adds per-route metrics/violations/penalties.
3. Computes aggregate metrics:
   - total cost
   - total time
   - total distance
   - baseline savings
4. Adds global fields:
   - unassigned
   - objective score
   - structural hash
   - penalty breakdown
   - solver metadata

Reference: `backend/engine/main.py:403`.

### 15.3 Multi-run diagnostics

For each run:
1. summarize feasibility, objective, cost, duration, stop reason, restart count.
2. sort by objective and run order.
3. build objective trend across run IDs.

Reference: `backend/engine/main.py:563`.

---

## 16. Determinism and Reproducibility Notes

Determinism sources:
1. explicit global seeding in solver (`random` and `numpy` if present)
2. per-run deterministic seed offset
3. single-thread settings in OR-Tools MIP and CP-SAT assignment components
4. deterministic sorts/tie-breaks in many selection points

Potential non-determinism contributors:
1. floating-point sensitivity in distance/backoff cases
2. different dependency versions/runtime environments
3. OSRM service variability if not using fully frozen cached distances

---

## 17. Practical Debug Checklist

When output quality is poor, inspect in this order:
1. Input sanity:
   - employee windows
   - vehicle capacities and categories
   - missing coordinates
2. Distance backend mode and fallback status.
3. Forced unassigned pre-check output.
4. Run-level stop reasons:
   - time-limited vs stagnation vs mip stop
5. Penalty breakdown:
   - capacity/sharing/premium/lateness spikes
6. Route-pool stats:
   - pool size
   - feasible fraction
   - set partition status/gap
7. Diversity metrics and restart behavior.

Primary diagnostics locations:
1. run metadata attached in `best_solution.metadata`
2. response fields `solverRuns`, `solverConfig`, `distance`, `objectiveTrend`

---

## 18. Compact Step-by-Step Sequence (Single Run)

1. Create stop controller.
2. Build optional assignment seed.
3. Generate initial population.
4. Evaluate initial population.
5. For each generation:
   1. compute adaptive controls
   2. evaluate population
   3. pick elites
   4. select parents
   5. crossover
   6. mutate via ruin+recreate
   7. accept/reject mutation by SA criterion
   8. ALNS improve top candidates
   9. diversity-aware survivor selection
   10. refill with fresh seeds
   11. update best/stagnation/diversity controls
   12. checkpoint stop controller
   13. optional escape burst / MIP probe
6. Finetune and neighborhood intensification.
7. Run hard feasibility repairs and max-delay enforcement.
8. Fallback to best feasible in population if incumbent infeasible.
9. Run route-pool iterated set partition.
10. Keep best feasible between heuristic and exact outcomes.
11. Emit run metadata and structural hash.

---

## 19. File Index

1. Orchestration:
   - `backend/engine/main.py`
2. Solver loop:
   - `backend/engine/solver.py`
3. Objective and feasibility:
   - `backend/engine/objective.py`
4. Operators and selection:
   - `backend/engine/operators.py`
5. ALNS:
   - `backend/engine/alns.py`
6. Neighborhood local search:
   - `backend/engine/neighborhoods.py`
7. Finetuning:
   - `backend/engine/finetuner.py`
8. Route pool:
   - `backend/engine/route_pool.py`
9. Set partition:
   - `backend/engine/set_partition.py`
10. Stop logic:
   - `backend/engine/stop_controller.py`
11. Input parsing:
   - `backend/engine/parser.py`
12. Distance subsystem:
   - `backend/engine/utils.py`
13. Engine process bridge:
   - `backend/services/engineRunner.js`
14. API trigger:
   - `backend/controllers/projectPipelineController.js`

