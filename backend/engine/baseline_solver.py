#!/usr/bin/env python3
"""
Compute pessimistic baseline metrics from canonical testcase JSON.

Input (stdin): canonical JSON with employees/vehicles/metadata.
Output (stdout): JSON payload with per-employee baseline and totals.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

EARTH_RADIUS_KM = 6371.0
DEFAULT_SPEED_KMPH = 25.0
DEFAULT_COST_PER_KM = 0.0
COST_MULTIPLIER = 2.0


def to_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    lat1_rad = math.radians(lat1)
    lng1_rad = math.radians(lng1)
    lat2_rad = math.radians(lat2)
    lng2_rad = math.radians(lng2)

    dlat = lat2_rad - lat1_rad
    dlng = lng2_rad - lng1_rad

    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlng / 2.0) ** 2
    )
    c = 2.0 * math.asin(math.sqrt(a))
    return EARTH_RADIUS_KM * c


def is_valid_coord(lat: Optional[float], lng: Optional[float]) -> bool:
    return (
        lat is not None
        and lng is not None
        and -90 <= lat <= 90
        and -180 <= lng <= 180
    )


def extract_coord(node: Any) -> Optional[Tuple[float, float]]:
    if not isinstance(node, dict):
        return None
    lat = to_float(node.get("lat"))
    lng = to_float(node.get("lng"))
    if not is_valid_coord(lat, lng):
        return None
    return (float(lat), float(lng))


def _first_valid(values: Iterable[Any], predicate) -> Optional[float]:
    for raw in values:
        num = to_float(raw)
        if num is None:
            continue
        if predicate(num):
            return num
    return None


def resolve_default_speed_and_cost(canonical: Dict[str, Any]) -> Tuple[float, float, str, str]:
    metadata = canonical.get("metadata") if isinstance(canonical.get("metadata"), dict) else {}
    vehicles = canonical.get("vehicles") if isinstance(canonical.get("vehicles"), list) else []

    speed_meta_keys = [
        "baseline_vehicle_speed_kmph",
        "baseline_speed_kmph",
        "vehicle_speed_kmph",
        "avg_speed_kmph",
    ]
    speed_from_meta = _first_valid(
        [metadata.get(k) for k in speed_meta_keys],
        lambda x: x > 0,
    )
    if speed_from_meta is not None:
        speed_source = "metadata"
        speed_kmph = speed_from_meta
    else:
        vehicle_speeds = [
            to_float(v.get("avg_speed_kmph"))
            for v in vehicles
            if isinstance(v, dict)
        ]
        valid_speeds = [x for x in vehicle_speeds if x is not None and x > 0]
        if valid_speeds:
            speed_source = "vehicles_average"
            speed_kmph = sum(valid_speeds) / float(len(valid_speeds))
        else:
            speed_source = "default"
            speed_kmph = DEFAULT_SPEED_KMPH

    cost_meta_keys = [
        "baseline_vehicle_cost_per_km",
        "baseline_cost_per_km",
        "vehicle_cost_per_km",
        "cost_per_km",
    ]
    cost_from_meta = _first_valid(
        [metadata.get(k) for k in cost_meta_keys],
        lambda x: x >= 0,
    )
    if cost_from_meta is not None:
        cost_source = "metadata"
        cost_per_km = cost_from_meta
    else:
        vehicle_costs = [
            to_float(v.get("cost_per_km"))
            for v in vehicles
            if isinstance(v, dict)
        ]
        valid_costs = [x for x in vehicle_costs if x is not None and x >= 0]
        if valid_costs:
            cost_source = "vehicles_average"
            cost_per_km = sum(valid_costs) / float(len(valid_costs))
        else:
            cost_source = "default"
            cost_per_km = DEFAULT_COST_PER_KM

    if speed_kmph <= 0:
        speed_kmph = DEFAULT_SPEED_KMPH
        speed_source = "default"
    if cost_per_km < 0:
        cost_per_km = DEFAULT_COST_PER_KM
        cost_source = "default"

    return speed_kmph, cost_per_km, speed_source, cost_source


def _fallback_base_coord(canonical: Dict[str, Any], employees: List[Dict[str, Any]]) -> Optional[Tuple[float, float]]:
    depot = extract_coord(canonical.get("depot"))
    if depot:
        return depot
    for emp in employees:
        pickup = extract_coord(emp.get("pickup"))
        if pickup:
            return pickup
    return None


def select_highest_cost_vehicle(canonical: Dict[str, Any], employees: List[Dict[str, Any]]) -> Dict[str, Any]:
    vehicles = canonical.get("vehicles") if isinstance(canonical.get("vehicles"), list) else []
    default_speed, default_cost, speed_source, cost_source = resolve_default_speed_and_cost(canonical)
    fallback_base = _fallback_base_coord(canonical, employees)
    fleet_speeds: List[float] = []

    candidates = []
    for idx, vehicle in enumerate(vehicles):
        if not isinstance(vehicle, dict):
            continue
        cost = to_float(vehicle.get("cost_per_km"))
        speed = to_float(vehicle.get("avg_speed_kmph"))
        if cost is None or cost < 0:
            continue
        if speed is None or speed <= 0:
            speed = default_speed
        if speed is not None and speed > 0:
            fleet_speeds.append(float(speed))
        base = extract_coord(vehicle.get("start_location")) or fallback_base
        candidates.append(
            {
                "idx": idx,
                "vehicle": vehicle,
                "cost_per_km": float(cost),
                "speed_kmph": float(speed),
                "base_coord": base,
            }
        )

    if candidates:
        # Highest cost first; if tie, prefer slower speed for pessimistic time.
        selected = max(candidates, key=lambda c: (c["cost_per_km"], -c["speed_kmph"]))
        vehicle_id = str(selected["vehicle"].get("id") or f"VEH{selected['idx'] + 1}")
        lowest_speed = min(fleet_speeds) if fleet_speeds else float(default_speed)
        half_lowest_speed = max(0.1, float(lowest_speed) * 0.5)
        return {
            "vehicle_id": vehicle_id,
            "cost_per_km": float(selected["cost_per_km"]),
            "speed_kmph": float(half_lowest_speed),
            "base_coord": selected["base_coord"],
            "cost_source": "highest_cost_vehicle",
            "speed_source": "half_fleet_min_speed",
        }

    return {
        "vehicle_id": "fallback",
        "cost_per_km": float(default_cost),
        "speed_kmph": float(default_speed),
        "base_coord": fallback_base,
        "cost_source": cost_source,
        "speed_source": speed_source,
    }


def compute_baseline(canonical: Dict[str, Any]) -> Dict[str, Any]:
    employees = canonical.get("employees") if isinstance(canonical.get("employees"), list) else []
    selected_vehicle = select_highest_cost_vehicle(canonical, employees)
    speed_kmph = float(selected_vehicle["speed_kmph"])
    cost_per_km = float(selected_vehicle["cost_per_km"])
    base_coord = selected_vehicle.get("base_coord")
    speed_source = str(selected_vehicle.get("speed_source") or "fallback")
    cost_source = str(selected_vehicle.get("cost_source") or "fallback")

    baseline: Dict[str, Dict[str, float]] = {}
    warnings: List[str] = []
    total_cost = 0.0
    total_time = 0.0
    total_distance = 0.0
    computed_count = 0

    for idx, emp in enumerate(employees):
        if not isinstance(emp, dict):
            continue
        emp_id = str(emp.get("id") or f"EMP{idx + 1:03d}").strip()
        if not emp_id:
            emp_id = f"EMP{idx + 1:03d}"
        pickup = emp.get("pickup") if isinstance(emp.get("pickup"), dict) else {}
        dropoff = emp.get("dropoff") if isinstance(emp.get("dropoff"), dict) else {}

        pickup_lat = to_float(pickup.get("lat"))
        pickup_lng = to_float(pickup.get("lng"))
        drop_lat = to_float(dropoff.get("lat"))
        drop_lng = to_float(dropoff.get("lng"))

        if None in (pickup_lat, pickup_lng, drop_lat, drop_lng):
            baseline[emp_id] = {"cost": 0.0, "time": 0.0}
            warnings.append(f"{emp_id}: missing pickup/dropoff coordinates; baseline set to zero")
            continue

        if (
            pickup_lat < -90 or pickup_lat > 90
            or drop_lat < -90 or drop_lat > 90
            or pickup_lng < -180 or pickup_lng > 180
            or drop_lng < -180 or drop_lng > 180
        ):
            baseline[emp_id] = {"cost": 0.0, "time": 0.0}
            warnings.append(f"{emp_id}: coordinates out of range; baseline set to zero")
            continue

        pickup = (float(pickup_lat), float(pickup_lng))
        drop = (float(drop_lat), float(drop_lng))
        if base_coord and is_valid_coord(base_coord[0], base_coord[1]):
            base = (float(base_coord[0]), float(base_coord[1]))
        else:
            base = pickup

        # Pessimistic baseline policy:
        # Highest-cost vehicle serves one passenger per cycle:
        # base -> pickup -> dropoff -> base
        distance_km = (
            haversine_km(base[0], base[1], pickup[0], pickup[1])
            + haversine_km(pickup[0], pickup[1], drop[0], drop[1])
            + haversine_km(drop[0], drop[1], base[0], base[1])
        )
        travel_min = (distance_km / speed_kmph) * 60.0
        cost = distance_km * cost_per_km * COST_MULTIPLIER

        baseline[emp_id] = {
            "cost": float(cost),
            "time": float(travel_min),
        }
        total_cost += float(cost)
        total_time += float(travel_min)
        total_distance += float(distance_km)
        computed_count += 1

    status = "success" if computed_count == len(employees) else ("partial" if computed_count > 0 else "failed")
    return {
        "status": status,
        "baseline": baseline,
        "totals": {
            "baselineCost": float(total_cost),
            "baselineTimeMinutes": float(total_time),
            "totalDistanceKm": float(total_distance),
            "employeeCount": int(len(employees)),
            "computedCount": int(computed_count),
        },
        "parameters": {
            "vehicle_speed_kmph": float(speed_kmph),
            "vehicle_cost_per_km": float(cost_per_km),
            "cost_multiplier": float(COST_MULTIPLIER),
            "vehicle_id": str(selected_vehicle.get("vehicle_id") or "fallback"),
            "baseline_mode": "pessimistic_single_passenger_return_cycle",
            "speed_source": speed_source,
            "cost_source": cost_source,
        },
        "warnings": warnings,
    }


def main() -> None:
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    raw = (raw or "").strip()

    if not raw:
        print(json.dumps({"status": "failed", "error": "Empty stdin payload"}, ensure_ascii=False))
        return

    try:
        canonical = json.loads(raw)
    except Exception as exc:
        print(
            json.dumps(
                {"status": "failed", "error": f"Invalid JSON payload: {exc}"},
                ensure_ascii=False,
            )
        )
        return

    if not isinstance(canonical, dict):
        print(json.dumps({"status": "failed", "error": "Expected canonical object payload"}, ensure_ascii=False))
        return

    result = compute_baseline(canonical)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
