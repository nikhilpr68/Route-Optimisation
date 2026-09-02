"""
Tests for HGS diversity module additions:
  - individual_diversity_contribution()
  - biased_fitness_scores()
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from diversity import (
    biased_fitness_scores,
    individual_diversity_contribution,
    population_diversity,
)
from representation import Individual, Route


# ---------------------------------------------------------------------------
# Minimal fixtures — no I/O, no real problem instance needed for unit tests.
# ---------------------------------------------------------------------------

class _FakeVehicle:
    def __init__(self, vid="V1"):
        self.id = vid
        self.capacity = 4
        self.speed_kmph = 30.0
        self.cost_per_km = 10.0
        self.avail_from = 480.0
        self.start_loc = (12.97, 77.59)
        self.category = "normal"


class _FakeEmployee:
    def __init__(self, eid, pickup=(12.97, 77.59), drop=(12.94, 77.62)):
        self.id = eid
        self.pickup_loc = pickup
        self.drop_loc = drop
        self.earliest_pickup = 480.0
        self.latest_drop = 570.0
        self.priority = "High"
        self.vehicle_pref = "normal"
        self.sharing_pref = "double"


class _FakeProblem:
    def __init__(self, n_employees=4, n_vehicles=2):
        self.employees = [_FakeEmployee(f"E{i}") for i in range(n_employees)]
        self.vehicles = [_FakeVehicle(f"V{j}") for j in range(n_vehicles)]
        self.baseline = {}
        self.metadata = {}


def _make_individual(vehicle_assignments: dict, problem: _FakeProblem) -> Individual:
    """Create an Individual where vehicle_assignments maps vid -> [eid, ...]."""
    emp_by_id = {str(e.id): e for e in problem.employees}
    veh_by_id = {str(v.id): v for v in problem.vehicles}
    routes = []
    assigned_ids = set()
    for vid, eids in vehicle_assignments.items():
        v = veh_by_id[vid]
        emps = [emp_by_id[str(eid)] for eid in eids if str(eid) in emp_by_id]
        route = Route(vehicle=v, employees=emps, stop_sequence=[
            s
            for emp in emps
            for s in ({"type": "p", "emp": emp}, {"type": "d", "emp": emp})
        ])
        routes.append(route)
        assigned_ids.update(str(e.id) for e in emps)
    unassigned = [e for e in problem.employees if str(e.id) not in assigned_ids]
    ind = Individual(routes=routes, unassigned=unassigned, objective_score=len(unassigned) * 100.0)
    return ind


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestIndividualDiversityContribution:
    def setup_method(self):
        self.problem = _FakeProblem(n_employees=4, n_vehicles=2)

    def test_empty_reference_population_returns_zero(self):
        ind = _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
        result = individual_diversity_contribution(ind, [], self.problem)
        assert result == 0.0

    def test_all_identical_individuals_return_zero_contribution(self):
        ind = _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
        # Build N identical copies (same assignment vector).
        population = [ind] + [
            _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
            for _ in range(4)
        ]
        contrib = individual_diversity_contribution(ind, population, self.problem)
        assert contrib == pytest.approx(0.0, abs=1e-9)

    def test_maximally_different_individual_has_high_contribution(self):
        # ind_a: all employees in V0; ind_b: all employees in V1 — maximally different assignment.
        ind_a = _make_individual({"V0": ["E0", "E1", "E2", "E3"], "V1": []}, self.problem)
        ind_b = _make_individual({"V0": [], "V1": ["E0", "E1", "E2", "E3"]}, self.problem)
        contrib = individual_diversity_contribution(ind_a, [ind_b], self.problem)
        assert contrib > 0.5

    def test_self_excluded_from_reference(self):
        ind = _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
        same = _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
        # If we pass ind itself in the reference, it should be excluded (identity check).
        contrib1 = individual_diversity_contribution(ind, [ind, same], self.problem)
        contrib2 = individual_diversity_contribution(ind, [same], self.problem)
        assert contrib1 == pytest.approx(contrib2, abs=1e-9)

    def test_contribution_is_non_negative(self):
        pop = [
            _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem),
            _make_individual({"V0": ["E2", "E3"], "V1": ["E0", "E1"]}, self.problem),
            _make_individual({"V0": ["E0", "E2"], "V1": ["E1", "E3"]}, self.problem),
        ]
        for ind in pop:
            c = individual_diversity_contribution(ind, pop, self.problem)
            assert c >= 0.0


class TestBiasedFitnessScores:
    def setup_method(self):
        self.problem = _FakeProblem(n_employees=4, n_vehicles=2)

    def test_empty_population_returns_empty(self):
        result = biased_fitness_scores([], self.problem, lambda_div=1.0)
        assert result == []

    def test_output_length_matches_population(self):
        pop = [
            _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem),
            _make_individual({"V0": ["E2", "E3"], "V1": ["E0", "E1"]}, self.problem),
            _make_individual({"V0": ["E0", "E2"], "V1": ["E1", "E3"]}, self.problem),
        ]
        bf = biased_fitness_scores(pop, self.problem, lambda_div=1.0)
        assert len(bf) == len(pop)

    def test_all_scores_are_finite(self):
        pop = [
            _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem),
            _make_individual({"V0": ["E2", "E3"], "V1": ["E0", "E1"]}, self.problem),
        ]
        bf = biased_fitness_scores(pop, self.problem, lambda_div=1.0)
        for score in bf:
            assert isinstance(score, float)
            assert score != float("inf")
            assert score != float("-inf")
            assert score == score  # not NaN

    def test_zero_lambda_collapses_to_objective_rank(self):
        """With lambda_div=0, biased_fitness = rank_by_objective (the diversity
        term vanishes).  The best individual by objective should have the lowest
        biased fitness score."""
        pop = [
            _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem),
            _make_individual({"V0": ["E2", "E3"], "V1": ["E0", "E1"]}, self.problem),
        ]
        # Force known objective scores.
        pop[0].objective_score = 10.0
        pop[1].objective_score = 20.0
        bf = biased_fitness_scores(pop, self.problem, lambda_div=0.0)
        # With lambda=0: biased = obj_rank. pop[0] has rank 1, pop[1] has rank 2.
        assert bf[0] < bf[1]

    def test_single_individual_population(self):
        ind = _make_individual({"V0": ["E0", "E1"], "V1": ["E2", "E3"]}, self.problem)
        bf = biased_fitness_scores([ind], self.problem, lambda_div=1.0)
        assert len(bf) == 1
        assert isinstance(bf[0], float)
