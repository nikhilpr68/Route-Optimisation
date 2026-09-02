from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _make_problem(employee_count=120, vehicle_count=44, seed=2002, extra_meta=None):
    from benchmarks.case_factory import make_clustered_canonical_case
    from parser import JsonParser
    from utils import configure_distance_metric

    canonical = make_clustered_canonical_case(
        f"decomp_case_{employee_count}e_{vehicle_count}v",
        seed=int(seed),
        employee_count=int(employee_count),
        vehicle_count=int(vehicle_count),
    )
    if extra_meta:
        canonical["metadata"] = dict(canonical.get("metadata") or {})
        canonical["metadata"].update(extra_meta)
    problem = JsonParser().load_from_canonical(canonical)
    configure_distance_metric("haversine")
    return problem


class TestDecompositionActivation:
    def test_explicit_enable_activates(self):
        from decomposition import should_activate

        problem = _make_problem(employee_count=60, vehicle_count=20, extra_meta={"DECOMPOSITION_ENABLED": "true"})
        active, info = should_activate(problem, dict(problem.metadata or {}))
        assert active is True
        assert info["reason"] == "explicit_enabled"

    def test_below_thresholds_does_not_auto_activate(self):
        from decomposition import should_activate

        problem = _make_problem(employee_count=60, vehicle_count=20, extra_meta={"DECOMPOSITION_ENABLED": "false"})
        active, info = should_activate(problem, dict(problem.metadata or {}))
        assert active is False
        assert info["reason"] in ("explicit_disabled", "below_thresholds")


class TestClustering:
    def test_clusters_partition_all_employees_disjoint(self):
        from decomposition import cluster_employee_ids

        problem = _make_problem(employee_count=90, vehicle_count=30, seed=123, extra_meta={"DECOMPOSITION_ENABLED": "true"})
        clusters, meta = cluster_employee_ids(
            problem,
            seed=123,
            max_clusters=6,
            min_cluster_size=10,
            geo_weight=1.0,
            time_weight=0.25,
        )
        assert meta["k"] == len(clusters)
        all_ids = [eid for c in clusters for eid in c]
        assert len(all_ids) == len(set(all_ids))
        assert set(all_ids) == {str(e.id) for e in problem.employees}


class TestDecompositionSolve:
    def test_decomposition_solve_emits_metadata_and_feasible(self):
        from decomposition import solve_with_decomposition
        from solution_status import is_solution_feasible

        problem = _make_problem(
            employee_count=120,
            vehicle_count=44,
            seed=2002,
            extra_meta={
                "DECOMPOSITION_ENABLED": "true",
                "TIME_LIMIT_SEC": 6.0,
                "ROUTE_POOL_ENABLED": "false",
                "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
                "SET_PARTITION_TIME_LIMIT_SEC": 0.6,
            },
        )
        sol, meta = solve_with_decomposition(
            problem=problem,
            run_id=1,
            seed=7,
            time_limit_sec=6.0,
            pop_size=24,
            generations=12,
            alns_iterations=0,
            route_pool_pruning_mode="safe",
        )
        assert isinstance(meta, dict)
        assert meta.get("enabled") is True
        assert "clusters" in meta
        assert "merge" in meta
        assert "budgets" in meta
        assert getattr(sol, "metadata", {}).get("decompositionMode") == "spatiotemporal_clusters"
        assert is_solution_feasible(sol) is True
