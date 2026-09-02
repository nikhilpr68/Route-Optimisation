from dataclasses import dataclass, field
from typing import List, Dict, Optional

DEFAULT_PRIORITY_MAX_DELAY = {
    1: 5,
    2: 10,
    3: 15,
    4: 20,
    5: 30,
}


def _read_numeric(metadata: Optional[Dict], keys: List[str]) -> Optional[float]:
    if not isinstance(metadata, dict):
        return None
    for key in keys:
        if key not in metadata:
            continue
        raw = metadata.get(key)
        try:
            if raw is None or str(raw).strip() == "":
                continue
            return float(raw)
        except Exception:
            continue
    return None

def get_max_allowed_delay(priority: int, metadata: Optional[Dict] = None) -> int:
    try:
        priority_key = int(priority)
    except Exception:
        priority_key = 3

    default_delay = DEFAULT_PRIORITY_MAX_DELAY.get(priority_key, 45)
    if not isinstance(metadata, dict):
        return default_delay

    raw_value = metadata.get(f"priority_{priority_key}_max_delay_min")
    if raw_value is None:
        return default_delay

    try:
        return max(0, int(float(raw_value)))
    except Exception:
        return default_delay

@dataclass(frozen=True)
class Location:
    lat: float
    lng: float

@dataclass(frozen=True)
class Employee:
    id: str
    priority: int
    pickup_loc: Location
    drop_loc: Location
    earliest_pickup: int
    latest_drop: int
    vehicle_pref: str
    sharing_pref: str
    original_id: str = ""
    display_id: str = ""

    @property
    def max_allowed_delay(self) -> int:
        return get_max_allowed_delay(self.priority)

@dataclass(frozen=True)
class Vehicle:
    id: str
    fuel_type: str
    capacity: int
    cost_per_km: float
    speed_kmph: float
    start_loc: Location
    avail_from: int
    category: str
    original_id: str = ""
    display_id: str = ""

@dataclass
class Baseline:
    emp_id: str
    cost: float
    time: float

@dataclass
class ProblemInstance:
    employees: List[Employee]
    vehicles: List[Vehicle]
    metadata: Dict
    baseline: Dict[str, Baseline]

    @property
    def cost_weight(self) -> float:
        value = _read_numeric(
            self.metadata,
            [
                "objective_cost_weight",
                "objectiveCostWeight",
                "cost_weight",
                "costWeight",
                "OBJECTIVE_COST_WEIGHT",
            ],
        )
        return float(value) if value is not None else 0.5

    @property
    def time_weight(self) -> float:
        value = _read_numeric(
            self.metadata,
            [
                "objective_time_weight",
                "objectiveTimeWeight",
                "time_weight",
                "timeWeight",
                "OBJECTIVE_TIME_WEIGHT",
            ],
        )
        return float(value) if value is not None else 0.5
