from __future__ import annotations

import random
from typing import Dict, List, Tuple


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":", 1)
    return int(h) * 60 + int(m)


def make_clustered_canonical_case(
    name: str,
    seed: int,
    employee_count: int,
    vehicle_count: int,
    cluster_count: int = 4,
    city_center: Tuple[float, float] = (12.9716, 77.5946),
) -> Dict:
    """Deterministic synthetic case with clustered pickups and a shared drop.

    This produces repeatable medium/large instances without depending on OSRM or
    external datasets.
    """
    rng = random.Random(int(seed))
    lat0, lng0 = float(city_center[0]), float(city_center[1])

    clusters: List[Tuple[float, float]] = []
    for _ in range(max(1, int(cluster_count))):
        clusters.append(
            (
                lat0 + rng.uniform(-0.04, 0.04),
                lng0 + rng.uniform(-0.05, 0.05),
            )
        )

    drop_lat = lat0 - 0.03
    drop_lng = lng0 + 0.04

    employees = []
    for i in range(1, int(employee_count) + 1):
        c_lat, c_lng = clusters[(i - 1) % len(clusters)]
        p_lat = c_lat + rng.uniform(-0.01, 0.01)
        p_lng = c_lng + rng.uniform(-0.01, 0.01)
        priority = "Medium"
        if i % 11 == 0:
            priority = "High"
        elif i % 7 == 0:
            priority = "Low"

        window_start = _minutes("08:00") + (i % 6) * 3
        window_end = _minutes("09:30") + (i % 8) * 4
        employees.append(
            {
                "id": f"E{i}",
                "priority": priority,
                "pickup": {"lat": p_lat, "lng": p_lng},
                "dropoff": {"lat": drop_lat, "lng": drop_lng},
                "time_window": {"start": f"{window_start//60:02d}:{window_start%60:02d}", "end": f"{window_end//60:02d}:{window_end%60:02d}"},
                "vehicle_preference": ("premium" if (i % 17 == 0) else "normal"),
                "sharing_preference": ("single" if (i % 13 == 0) else "double"),
            }
        )

    vehicles = []
    for j in range(1, int(vehicle_count) + 1):
        vehicles.append(
            {
                "id": f"V{j}",
                "fuel_type": ("electric" if (j % 9 == 0) else "petrol"),
                "capacity": (3 if (j % 5 == 0) else 2),
                "cost_per_km": (13 if (j % 4 == 0) else 11),
                "avg_speed_kmph": (26 if (j % 3 == 0) else 24),
                "start_location": {"lat": lat0 + rng.uniform(-0.01, 0.01), "lng": lng0 + rng.uniform(-0.01, 0.01)},
                "available_time": "07:45",
                "category": ("premium" if (j % 8 == 0) else "normal"),
            }
        )

    baseline = {f"E{i}": {"cost": 200.0, "time": 40.0} for i in range(1, int(employee_count) + 1)}

    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "name": str(name),
            "distance_metric": "haversine",
            "seed": int(seed),
        },
        "employees": employees,
        "vehicles": vehicles,
        "baseline": baseline,
    }

