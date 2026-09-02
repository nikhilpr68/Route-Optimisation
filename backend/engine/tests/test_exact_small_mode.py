import copy
import itertools
import json
import subprocess
import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"
VALIDATION_SCRIPT = ENGINE_DIR / "validate_exact_small.py"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from exact_small import ExactSmallLimits, evaluate_individual_final, solve_exact_small
from exact_small_cases import get_exact_small_validation_cases
from parser import JsonParser
from representation import Individual, Route


def _extract_last_json(text: str):
    decoder = json.JSONDecoder()
    idx = 0
    last_obj = None
    while idx < len(text):
        try:
            obj, end = decoder.raw_decode(text, idx)
            if isinstance(obj, dict):
                last_obj = obj
            idx = end
            continue
        except json.JSONDecodeError:
            idx += 1
    if last_obj is None:
        raise AssertionError("No JSON object found in engine output")
    return last_obj


def _run_engine(args, stdin_payload):
    proc = subprocess.run(
        [sys.executable, str(ENGINE_MAIN), *args],
        cwd=str(ENGINE_DIR),
        input=json.dumps(stdin_payload),
        text=True,
        capture_output=True,
        timeout=180,
        check=True,
    )
    stdout_only = (proc.stdout or "").strip()
    if stdout_only:
        try:
            return _extract_last_json(stdout_only)
        except AssertionError:
            pass
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return _extract_last_json(combined)


def _tiny_problem():
    canonical = copy.deepcopy(get_exact_small_validation_cases()[0]["canonical"])
    return JsonParser().load_from_canonical(canonical), canonical


def _bruteforce_best_objective(problem):
    employees = list(problem.employees)
    vehicle = problem.vehicles[0]
    best = float("inf")

    for assign_mask in range(1 << len(employees)):
        assigned = [employees[idx] for idx in range(len(employees)) if assign_mask & (1 << idx)]
        unassigned = [employees[idx] for idx in range(len(employees)) if not (assign_mask & (1 << idx))]
        if not assigned:
            individual = Individual(routes=[Route(vehicle=vehicle, employees=[], stop_sequence=[])], unassigned=unassigned)
            best = min(best, evaluate_individual_final(problem, individual))
            continue

        stop_rows = []
        for emp in assigned:
            stop_rows.append(("p", emp))
            stop_rows.append(("d", emp))

        for perm in itertools.permutations(stop_rows):
            seen = set()
            valid = True
            for stop_type, emp in perm:
                if stop_type == "p":
                    seen.add(str(emp.id))
                elif str(emp.id) not in seen:
                    valid = False
                    break
            if not valid:
                continue
            route = Route(
                vehicle=vehicle,
                employees=[],
                stop_sequence=[{"type": stop_type, "emp": emp} for stop_type, emp in perm],
            )
            individual = Individual(routes=[route], unassigned=unassigned)
            score = evaluate_individual_final(problem, individual)
            if score < best:
                best = float(score)
    return float(best)


def test_exact_small_mode_returns_global_optimum_on_tiny_case():
    problem, canonical = _tiny_problem()
    brute_force_best = _bruteforce_best_objective(problem)

    direct = solve_exact_small(problem, limits=ExactSmallLimits(max_employees=5, max_vehicles=3))
    assert direct.status == "optimal"
    assert direct.individual is not None
    assert abs(float(direct.individual.objective_score) - brute_force_best) <= 1e-6

    payload = _run_engine(
        [
            "--exact-small-mode",
            "true",
            "--exact-small-max-employees",
            "5",
            "--exact-small-max-vehicles",
            "3",
            "--seed",
            "4242",
        ],
        stdin_payload=canonical,
    )
    assert payload["exactness_status"] == "globally_optimal"
    assert payload["lower_bound"] == payload["objectiveScore"]
    assert abs(float(payload["objectiveScore"]) - brute_force_best) <= 1e-6


def test_exact_small_and_shared_final_evaluation_agree_for_identical_solution():
    problem, _ = _tiny_problem()
    result = solve_exact_small(problem, limits=ExactSmallLimits(max_employees=5, max_vehicles=3))
    assert result.individual is not None

    candidate = copy.deepcopy(result.individual)
    rescored = evaluate_individual_final(problem, candidate)
    assert abs(float(rescored) - float(result.individual.objective_score)) <= 1e-6


def test_exact_small_mode_rejects_oversize_instances_cleanly():
    _, canonical = _tiny_problem()
    canonical = copy.deepcopy(canonical)
    canonical["employees"].extend(
        [
            copy.deepcopy(canonical["employees"][0]) | {"id": "E3"},
            copy.deepcopy(canonical["employees"][0]) | {"id": "E4"},
            copy.deepcopy(canonical["employees"][0]) | {"id": "E5"},
            copy.deepcopy(canonical["employees"][0]) | {"id": "E6"},
        ]
    )
    payload = _run_engine(
        [
            "--exact-small-mode",
            "true",
            "--exact-small-max-employees",
            "5",
            "--exact-small-max-vehicles",
            "3",
        ],
        stdin_payload=canonical,
    )
    assert payload["status"] == "error"
    assert payload["exactSmallMode"] is True
    assert payload["exactSmallStatus"] == "rejected"
    assert "supports at most 5 employees" in payload["error"]
    # Even in error paths, expose the bound/status fields so downstream callers
    # don't have to special-case exact-small rejection.
    for key in (
        "incumbent_objective",
        "lower_bound",
        "optimality_gap_absolute",
        "optimality_gap_percent",
        "exactness_status",
        "proof_mode_enabled",
        "route_pool_size_considered",
        "unsafe_pruning_enabled",
        "distance_backend_requested",
        "distance_backend_used",
        "fallback_occurred",
        "stop_reason",
        "bound_scope",
    ):
        assert key in payload


def test_validation_script_output_is_stable():
    proc = subprocess.run(
        [sys.executable, str(VALIDATION_SCRIPT)],
        cwd=str(ENGINE_DIR),
        text=True,
        capture_output=True,
        timeout=240,
        check=True,
    )
    summary = json.loads(proc.stdout)
    assert summary["case_count"] == 3
    assert [row["case"] for row in summary["rows"]] == [
        "shared_pair_single_vehicle",
        "premium_split_two_vehicles",
        "tight_window_three_employee",
    ]
    assert isinstance(summary["heuristic_miss_count"], int)
    assert isinstance(summary["miss_patterns_ranked"], list)
