import json
import subprocess
import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parent
ENGINE_MAIN = ENGINE_DIR / "main.py"
OUT_DIR = ENGINE_DIR / "run_results"


def sample_canonical():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 4242,
        },
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 12.9716, "lng": 77.5946},
                "dropoff": {"lat": 12.9352, "lng": 77.6245},
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 12.9611, "lng": 77.6387},
                "dropoff": {"lat": 12.9304, "lng": 77.6784},
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
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }


def extract_last_json(text):
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
        raise RuntimeError("Could not parse JSON output from engine")
    return last_obj


def run_engine(seed):
    cmd = [
        sys.executable,
        str(ENGINE_MAIN),
        "--intensity",
        "low",
        "--runs",
        "2",
        "--max-workers",
        "1",
        "--seed",
        str(seed),
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(ENGINE_DIR),
        input=json.dumps(sample_canonical()),
        text=True,
        capture_output=True,
        timeout=180,
        check=True,
    )
    return extract_last_json((proc.stdout or "") + "\n" + (proc.stderr or ""))


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    first = run_engine(4242)
    second = run_engine(4242)

    summary = {
        "run1Objective": first.get("objectiveScore"),
        "run2Objective": second.get("objectiveScore"),
        "run1Hash": first.get("structuralHash"),
        "run2Hash": second.get("structuralHash"),
        "objectiveEqual": first.get("objectiveScore") == second.get("objectiveScore"),
        "hashEqual": first.get("structuralHash") == second.get("structuralHash"),
    }

    out_file = OUT_DIR / "smoke_summary.json"
    out_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))

    if not summary["objectiveEqual"] or not summary["hashEqual"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
