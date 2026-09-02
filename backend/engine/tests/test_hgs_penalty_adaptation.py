"""
Tests for adaptive penalty scale behaviour in HGS-modernized solver.

These are pure unit tests on the _update_adaptive_penalty_scale method
and the adaptive controls integration.  No subprocess required.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


# ---------------------------------------------------------------------------
# Minimal stub for GeneticSolver — avoids heavy problem parsing.
# We import the helpers needed and replicate the small state machine.
# ---------------------------------------------------------------------------

from solver import GeneticSolver, _clamp


def _make_minimal_problem():
    """Return a minimal ProblemInstance sufficient to construct a GeneticSolver."""
    from parser import JsonParser

    canonical = {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {"distance_metric": "haversine", "seed": 1},
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 12.97, "lng": 77.59},
                "dropoff": {"lat": 12.93, "lng": 77.62},
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 12.96, "lng": 77.63},
                "dropoff": {"lat": 12.93, "lng": 77.67},
                "time_window": {"start": "08:10", "end": "09:45"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.97, "lng": 77.59},
                "available_time": "07:45",
                "category": "normal",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }
    return JsonParser().load_from_canonical(canonical)


def _make_solver(problem=None):
    if problem is None:
        problem = _make_minimal_problem()
    return GeneticSolver(
        problem=problem,
        generations=5,
        pop_size=4,
        alns_iterations=0,
        seed=42,
    )


# ---------------------------------------------------------------------------
# Tests — _update_adaptive_penalty_scale logic
# ---------------------------------------------------------------------------

class TestAdaptivePenaltyScale:
    def setup_method(self):
        self.solver = _make_solver()
        # Defaults.
        self.solver._adaptive_penalty_scale = 1.0
        self.solver._target_feasible_ratio = 0.25
        self.solver._adaptive_penalty_scale_min = 0.5
        self.solver._adaptive_penalty_scale_max = 4.0

    def test_scale_increases_when_mostly_infeasible(self):
        initial = self.solver._adaptive_penalty_scale
        # 0.0 feasible ratio < target 0.25 → scale must increase.
        self.solver._update_adaptive_penalty_scale(0.0)
        assert self.solver._adaptive_penalty_scale > initial

    def test_scale_decreases_when_mostly_feasible(self):
        initial = self.solver._adaptive_penalty_scale
        # 0.95 feasible ratio > 0.80 → scale must decrease.
        self.solver._update_adaptive_penalty_scale(0.95)
        assert self.solver._adaptive_penalty_scale < initial

    def test_scale_unchanged_in_target_band(self):
        self.solver._adaptive_penalty_scale = 1.5
        # feasible_ratio = 0.50 is in [0.25, 0.80] → keep.
        self.solver._update_adaptive_penalty_scale(0.50)
        assert self.solver._adaptive_penalty_scale == pytest.approx(1.5, abs=1e-9)

    def test_scale_clamped_at_min(self):
        """Repeated feasible calls must not drive scale below min."""
        self.solver._adaptive_penalty_scale = 0.51
        for _ in range(50):
            self.solver._update_adaptive_penalty_scale(1.0)
        assert self.solver._adaptive_penalty_scale >= self.solver._adaptive_penalty_scale_min

    def test_scale_clamped_at_max(self):
        """Repeated infeasible calls must not drive scale above max."""
        self.solver._adaptive_penalty_scale = 3.9
        for _ in range(50):
            self.solver._update_adaptive_penalty_scale(0.0)
        assert self.solver._adaptive_penalty_scale <= self.solver._adaptive_penalty_scale_max

    def test_increase_multiplier_is_correct(self):
        """Low feasibility should multiply by 1.07 exactly (before clamping)."""
        self.solver._adaptive_penalty_scale = 1.0
        self.solver._update_adaptive_penalty_scale(0.0)
        assert self.solver._adaptive_penalty_scale == pytest.approx(1.07, abs=1e-9)

    def test_decrease_multiplier_is_correct(self):
        """High feasibility should multiply by 0.96 exactly (before clamping)."""
        self.solver._adaptive_penalty_scale = 1.0
        self.solver._update_adaptive_penalty_scale(1.0)
        assert self.solver._adaptive_penalty_scale == pytest.approx(0.96, abs=1e-9)


# ---------------------------------------------------------------------------
# Tests — adaptive controls integrate the scale
# ---------------------------------------------------------------------------

class TestAdaptiveControlsIncludesScale:
    def setup_method(self):
        self.solver = _make_solver()

    def test_penalty_factor_scales_with_adaptive_scale(self):
        self.solver._adaptive_penalty_scale = 1.0
        controls_base = self.solver._adaptive_controls(progress=0.5, stagnation_counter=0)
        pf_base = controls_base["penalty_factor"]

        self.solver._adaptive_penalty_scale = 2.0
        controls_2x = self.solver._adaptive_controls(progress=0.5, stagnation_counter=0)
        # Should be roughly 2× (exact value is clamped to [0.10, 50.0]).
        assert controls_2x["penalty_factor"] > pf_base

    def test_penalty_factor_is_positive(self):
        for scale in (0.5, 1.0, 2.0, 4.0):
            self.solver._adaptive_penalty_scale = scale
            controls = self.solver._adaptive_controls(progress=0.5, stagnation_counter=0)
            assert controls["penalty_factor"] > 0
