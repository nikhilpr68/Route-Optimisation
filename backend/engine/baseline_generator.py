#!/usr/bin/env python3
"""
Baseline generator for employee pickup->drop transport.

Model:
- Each employee travels individually (no ride sharing)
- Direct trip from pickup to drop
- Distance via Haversine (no external APIs)

Input CSV required columns:
- employee_id
- pickup_lat
- pickup_lng
- drop_lat
- drop_lng

Output CSV (default: baseline.csv) columns:
- employee_id
- cost
- time
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from typing import Dict, Iterable, List, Tuple


EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute great-circle distance between two lat/lon points in kilometers."""
    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    lat2_rad = math.radians(lat2)
    lon2_rad = math.radians(lon2)

    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad

    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2.0) ** 2
    )
    c = 2.0 * math.asin(math.sqrt(a))
    return EARTH_RADIUS_KM * c


def parse_employees_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(f"employees.csv not found: {path}")

    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("employees.csv has no header row.")

        required = {"employee_id", "pickup_lat", "pickup_lng", "drop_lat", "drop_lng"}
        actual = {str(name).strip() for name in reader.fieldnames}
        missing = sorted(required - actual)
        if missing:
            raise ValueError(f"employees.csv missing required columns: {', '.join(missing)}")

        rows: List[Dict[str, str]] = []
        for row in reader:
            normalized = {str(k).strip(): ("" if v is None else str(v).strip()) for k, v in row.items()}
            if not normalized.get("employee_id"):
                # Skip fully-empty/malformed lines without an employee_id.
                continue
            rows.append(normalized)
        return rows


def compute_baseline(
    employees: Iterable[Dict[str, str]],
    vehicle_speed_kmph: float,
    vehicle_cost_per_km: float,
) -> Tuple[List[Dict[str, float]], float, float, float]:
    if vehicle_speed_kmph <= 0:
        raise ValueError("vehicle_speed_kmph must be > 0.")
    if vehicle_cost_per_km < 0:
        raise ValueError("vehicle_cost_per_km must be >= 0.")

    baseline_rows: List[Dict[str, float]] = []
    total_cost = 0.0
    total_time_min = 0.0
    total_distance_km = 0.0

    for idx, row in enumerate(employees, start=2):  # header is row 1
        try:
            employee_id = str(row["employee_id"]).strip()
            pickup_lat = float(row["pickup_lat"])
            pickup_lng = float(row["pickup_lng"])
            drop_lat = float(row["drop_lat"])
            drop_lng = float(row["drop_lng"])
        except Exception as exc:
            raise ValueError(f"Invalid row at line {idx}: {row}") from exc

        distance_km = haversine_km(pickup_lat, pickup_lng, drop_lat, drop_lng)
        travel_minutes = (distance_km / vehicle_speed_kmph) * 60.0
        cost = distance_km * vehicle_cost_per_km

        baseline_rows.append(
            {
                "employee_id": employee_id,
                "cost": cost,
                "time": travel_minutes,
            }
        )

        total_distance_km += distance_km
        total_time_min += travel_minutes
        total_cost += cost

    return baseline_rows, total_cost, total_time_min, total_distance_km


def write_baseline_csv(path: Path, baseline_rows: Iterable[Dict[str, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["employee_id", "cost", "time"])
        for row in baseline_rows:
            writer.writerow(
                [
                    row["employee_id"],
                    f"{float(row['cost']):.4f}",
                    f"{float(row['time']):.4f}",
                ]
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate baseline.csv using direct individual trips.")
    parser.add_argument(
        "--employees-csv",
        default="employees.csv",
        help="Path to employees.csv (default: employees.csv)",
    )
    parser.add_argument(
        "--output-csv",
        default="baseline.csv",
        help="Path to output baseline CSV (default: baseline.csv)",
    )
    parser.add_argument(
        "--vehicle-speed-kmph",
        type=float,
        required=True,
        help="Vehicle speed in km/h.",
    )
    parser.add_argument(
        "--vehicle-cost-per-km",
        type=float,
        required=True,
        help="Vehicle cost per km.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    employees_path = Path(args.employees_csv).expanduser().resolve()
    output_path = Path(args.output_csv).expanduser().resolve()

    employees = parse_employees_csv(employees_path)
    baseline_rows, baseline_cost, baseline_time_min, total_distance_km = compute_baseline(
        employees=employees,
        vehicle_speed_kmph=float(args.vehicle_speed_kmph),
        vehicle_cost_per_km=float(args.vehicle_cost_per_km),
    )
    write_baseline_csv(output_path, baseline_rows)

    print(f"Employees Processed: {len(baseline_rows)}")
    print(f"Baseline CSV: {output_path}")
    print(f"Total Baseline Cost: {baseline_cost:.4f}")
    print(f"Total Baseline Time (min): {baseline_time_min:.4f}")
    print(f"Total Distance (km): {total_distance_km:.4f}")


if __name__ == "__main__":
    main()
