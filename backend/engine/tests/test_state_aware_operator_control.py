import random
import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from alns import ALNSEngine
from models import Employee, Location, ProblemInstance, Vehicle
from neighborhoods import NeighborhoodSearch
from objective import ObjectiveEvaluator
from operator_control import ContextualUCBConfig, ContextualUCBSelector, SearchContext, context_key
from operators import GeneticOperators
from representation import Individual, Route
from utils import configure_distance_metric


def _tiny_problem(meta=None) -> ProblemInstance:
    meta = dict(meta or {})
    meta.setdefault("distance_metric", "haversine")
    employees = []
    for i in range(4):
        employees.append(
            Employee(
                id=f"E{i+1}",
                priority=2,
                pickup_loc=Location(12.9716 + i * 0.001, 77.5946 + i * 0.001),
                drop_loc=Location(12.9611 + i * 0.001, 77.6387 + i * 0.001),
                earliest_pickup=8 * 60,
                latest_drop=9 * 60,
                vehicle_pref="normal",
                sharing_pref="any",
            )
        )
    vehicles = [
        Vehicle(
            id="V1",
            fuel_type="petrol",
            capacity=2,
            cost_per_km=10.0,
            speed_kmph=25.0,
            start_loc=Location(12.9700, 77.5900),
            avail_from=7 * 60 + 45,
            category="normal",
        ),
        Vehicle(
            id="V2",
            fuel_type="diesel",
            capacity=2,
            cost_per_km=12.0,
            speed_kmph=18.0,
            start_loc=Location(12.9300, 77.5600),
            avail_from=7 * 60 + 15,
            category="normal",
        ),
    ]
    return ProblemInstance(employees=employees, vehicles=vehicles, metadata=meta, baseline={})


def _seed_individual(problem: ProblemInstance) -> Individual:
    e = problem.employees
    r1 = Route(
        vehicle=problem.vehicles[0],
        stop_sequence=[
            {"type": "p", "emp": e[0]},
            {"type": "p", "emp": e[1]},
            {"type": "d", "emp": e[0]},
            {"type": "d", "emp": e[1]},
        ],
    )
    r2 = Route(
        vehicle=problem.vehicles[1],
        stop_sequence=[
            {"type": "p", "emp": e[2]},
            {"type": "p", "emp": e[3]},
            {"type": "d", "emp": e[2]},
            {"type": "d", "emp": e[3]},
        ],
    )
    return Individual(routes=[r1, r2], unassigned=[])


def test_context_feature_bucketing():
    ctx = SearchContext(
        phase_progress=0.0,
        strictness=0.1,
        current_feasible=False,
        unassigned_frac=0.10,
        stagnation_best_steps=30,
        stagnation_current_steps=9,
        ruin_fraction=0.30,
        max_victims=5,
    )
    ck = context_key(ctx)
    assert ck.phase == "early"
    assert ck.feasible == "infeasible"
    assert ck.unassigned == "many"
    assert ck.stagnation == "stuck"
    assert ck.ruin == "large"


def test_deterministic_fallback_mode():
    selector = ContextualUCBSelector(
        "destroy",
        arms=["a", "b"],
        config=ContextualUCBConfig(explore_c=0.0, ucb_scale=1.0, epsilon=0.0),
    )
    ctx = SearchContext(
        phase_progress=0.6,
        strictness=0.6,
        current_feasible=True,
        unassigned_frac=0.0,
        stagnation_best_steps=0,
        stagnation_current_steps=0,
        ruin_fraction=0.2,
        max_victims=2,
    )
    selector.update(ctx, arm="a", reward=5.0, delta=-1.0, accepted=True, improved_current=True, improved_best=False, failed=False)
    selector.update(ctx, arm="b", reward=0.3, delta=0.0, accepted=False, improved_current=False, improved_best=False, failed=False)

    rng = random.Random(1337)
    assert selector.choose(ctx, arms=["a", "b"], base_weights={"a": 1.0, "b": 1.0}, rng=rng, deterministic=True) == "a"
    assert selector.choose(ctx, arms=["a", "b"], base_weights={"a": 1.0, "b": 1.0}, rng=rng, deterministic=True) == "a"


def test_operator_selection_wiring_and_metrics_emission():
    configure_distance_metric("haversine")
    problem = _tiny_problem(
        meta={
            "STATE_AWARE_OPERATOR_CONTROL_ENABLED": True,
            "STATE_AWARE_OPERATOR_CONTROL_DETERMINISTIC": True,
            "distance_metric": "haversine",
        }
    )
    rng = random.Random(7)
    ops = GeneticOperators(problem, rng=rng)
    evaluator = ObjectiveEvaluator(problem)
    neighborhoods = NeighborhoodSearch(problem, operators=ops, evaluator=evaluator, rng=rng)
    engine = ALNSEngine(problem, operators=ops, evaluator=evaluator, neighborhoods=neighborhoods, rng=rng)

    ind = _seed_individual(problem)
    evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.6, enforce_hard=False)
    improved, stats = engine.improve(
        ind,
        iterations=3,
        penalty_factor=1.0,
        phase_progress=0.6,
        ruin_fraction=0.2,
        max_victims=2,
        max_runtime_sec=0.5,
    )

    assert isinstance(improved, Individual)
    assert "operator_control" in stats
    oc = stats["operator_control"]
    assert oc["enabled"] is True
    assert "destroy" in oc and "repair" in oc and "neighborhood" in oc
    assert "byPhase" in oc["destroy"]
    assert "diversity" in oc["destroy"]
    assert "deadArms" in oc["repair"]

    # NeighborhoodSearch emits per-neighborhood attempt/hit metrics into metadata when invoked.
    ctx = SearchContext(
        phase_progress=0.6,
        strictness=0.6,
        current_feasible=True,
        unassigned_frac=0.0,
        stagnation_best_steps=0,
        stagnation_current_steps=0,
        ruin_fraction=0.2,
        max_victims=2,
    )
    educated = neighborhoods.improve(
        ind,
        max_moves=1,
        penalty_factor=1.0,
        phase_progress=0.6,
        operator_control=engine.operator_control.neighborhood,
        search_context=ctx,
        deterministic=True,
    )
    assert isinstance(getattr(educated, "metadata", None), dict)
    assert "neighborhoodMetrics" in educated.metadata
