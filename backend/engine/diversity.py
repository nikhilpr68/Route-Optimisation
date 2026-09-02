import hashlib
import itertools
import json
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from models import ProblemInstance
from representation import Individual, Route


def _pickup_employee_ids(route: Route) -> List[str]:
    ids = []
    seen = set()
    for stop in route.stop_sequence:
        emp = stop.get("emp")
        if emp is None:
            continue
        if stop.get("type") == "p":
            emp_id = str(emp.id)
            if emp_id not in seen:
                ids.append(emp_id)
                seen.add(emp_id)
    # Fallback when upstream operators changed employees and not sequence.
    for emp in route.employees:
        emp_id = str(emp.id)
        if emp_id not in seen:
            ids.append(emp_id)
            seen.add(emp_id)
    return ids


def _route_signature(route: Route) -> Dict:
    sequence = []
    for stop in route.stop_sequence:
        emp = stop.get("emp")
        stop_type = stop.get("type")
        if emp is None or stop_type not in ("p", "d"):
            continue
        sequence.append(f"{stop_type}:{emp.id}")

    passengers = sorted(set(_pickup_employee_ids(route)))
    return {
        "vehicle": str(route.vehicle.id),
        "routeCount": int(len(passengers)),
        "passengerSet": passengers,
        "sequence": sequence,
    }


def structural_signature(individual: Individual) -> str:
    """
    Canonical stable signature for structural dedup.

    Includes:
    - Employee -> vehicle assignment mapping
    - Per-vehicle ordered stop sequence
    - Route count and per-route passenger set
    - Unassigned set
    """
    assignments = {}
    route_rows = []

    for route in sorted(individual.routes, key=lambda r: str(r.vehicle.id)):
        vehicle_id = str(route.vehicle.id)
        passenger_ids = _pickup_employee_ids(route)
        for emp_id in passenger_ids:
            assignments[str(emp_id)] = vehicle_id
        route_rows.append(_route_signature(route))

    unassigned = sorted(str(e.id) for e in (individual.unassigned or []))
    signature_obj = {
        "assignment": sorted((emp_id, assignments[emp_id]) for emp_id in assignments.keys()),
        "routeCount": len(route_rows),
        "routes": route_rows,
        "unassigned": unassigned,
    }
    return json.dumps(signature_obj, separators=(",", ":"), sort_keys=True)


def structural_hash(individual: Individual) -> str:
    raw = structural_signature(individual)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def deduplicate_by_structure(population: Sequence[Individual], target_size: int = None) -> List[Individual]:
    unique = {}
    for ind in sorted(population, key=lambda x: x.objective_score):
        key = structural_hash(ind)
        if key not in unique:
            ind.structural_hash = key
            unique[key] = ind

    result = list(unique.values())
    if target_size is not None:
        return result[: max(0, int(target_size))]
    return result


def assignment_vector(problem: ProblemInstance, individual: Individual) -> Tuple[int, ...]:
    vehicle_ids = sorted(str(v.id) for v in problem.vehicles)
    vehicle_to_idx = {vid: idx for idx, vid in enumerate(vehicle_ids)}

    assignments: Dict[str, int] = {}
    for route in individual.routes:
        v_idx = vehicle_to_idx.get(str(route.vehicle.id), -1)
        for emp_id in _pickup_employee_ids(route):
            assignments[str(emp_id)] = v_idx

    for emp in (individual.unassigned or []):
        assignments[str(emp.id)] = -1

    out = []
    for emp in sorted(problem.employees, key=lambda e: str(e.id)):
        out.append(assignments.get(str(emp.id), -1))
    return tuple(out)


def normalized_hamming_distance(a: Sequence[int], b: Sequence[int]) -> float:
    if not a and not b:
        return 0.0
    n = min(len(a), len(b))
    if n == 0:
        return 1.0
    mismatch = 0
    for i in range(n):
        if a[i] != b[i]:
            mismatch += 1
    if len(a) != len(b):
        mismatch += abs(len(a) - len(b))
        n = max(len(a), len(b))
    return float(mismatch) / float(max(1, n))


def route_passenger_sets(individual: Individual) -> Dict[str, set]:
    out = {}
    for route in individual.routes:
        out[str(route.vehicle.id)] = set(_pickup_employee_ids(route))
    return out


def average_route_jaccard_distance(a: Individual, b: Individual) -> float:
    a_sets = route_passenger_sets(a)
    b_sets = route_passenger_sets(b)
    keys = sorted(set(a_sets.keys()) | set(b_sets.keys()))
    if not keys:
        return 0.0

    total = 0.0
    for key in keys:
        left = a_sets.get(key, set())
        right = b_sets.get(key, set())
        union = left | right
        if not union:
            continue
        inter = left & right
        total += 1.0 - (len(inter) / float(len(union)))
    return total / float(max(1, len(keys)))


def _pairwise(iterable: Iterable):
    items = list(iterable)
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            yield items[i], items[j]


def population_diversity(population: Sequence[Individual], problem: ProblemInstance) -> Dict[str, float]:
    pop = list(population or [])
    if not pop:
        return {
            "unique_structures": 0,
            "unique_ratio": 0.0,
            "avg_assignment_distance": 0.0,
            "avg_route_jaccard_distance": 0.0,
        }

    hashes = [structural_hash(ind) for ind in pop]
    unique_structures = len(set(hashes))

    vectors = [assignment_vector(problem, ind) for ind in pop]

    assignment_dist = []
    route_dist = []
    for (ind_a, vec_a), (ind_b, vec_b) in _pairwise(zip(pop, vectors)):
        assignment_dist.append(normalized_hamming_distance(vec_a, vec_b))
        route_dist.append(average_route_jaccard_distance(ind_a, ind_b))

    return {
        "unique_structures": int(unique_structures),
        "unique_ratio": float(unique_structures / max(1, len(pop))),
        "avg_assignment_distance": float(sum(assignment_dist) / max(1, len(assignment_dist))),
        "avg_route_jaccard_distance": float(sum(route_dist) / max(1, len(route_dist))),
    }


# ---------------------------------------------------------------------------
# HGS-aligned helpers: per-individual diversity contribution + biased fitness
# ---------------------------------------------------------------------------

def individual_diversity_contribution(
    candidate: Individual,
    reference_population: Sequence[Individual],
    problem: "ProblemInstance",
    n_closest: int = 5,
) -> float:
    """
    Compute the diversity contribution of a single candidate individual
    relative to a reference population.

    Defined as the average Hamming distance to the *n_closest* neighbours in
    the reference_population (using assignment vectors).  Higher value ↔ the
    individual is more structurally unique, which HGS treats as a diversity
    bonus.

    Returns 0.0 when the reference population is empty or all individuals are
    identical.
    """
    pop = [ind for ind in reference_population if ind is not candidate]
    if not pop:
        return 0.0

    vec_c = assignment_vector(problem, candidate)
    distances: List[float] = []
    for ind in pop:
        vec_i = assignment_vector(problem, ind)
        distances.append(normalized_hamming_distance(vec_c, vec_i))

    distances.sort()
    k = min(n_closest, len(distances))
    return float(sum(distances[:k]) / k)


def biased_fitness_scores(
    population: Sequence[Individual],
    problem: "ProblemInstance",
    lambda_div: float = 1.0,
    n_closest: int = 5,
) -> List[float]:
    """
    HGS biased fitness for each individual in *population*.

    biased_fitness = rank_by_objective + lambda_div * (N - rank_by_diversity)

    where:
      - rank_by_objective  : 1-indexed rank sorted ascending by objective_score.
      - rank_by_diversity  : 1-indexed rank sorted ascending by
        individual_diversity_contribution (more unique → lower rank → lower BF).
      - N                  : population size.

    Lower biased_fitness is *better*.  When lambda_div = 0 this collapses to
    pure objective ranking.  A higher lambda_div emphasises diversity.

    Returns a list of floats parallel to *population*.
    """
    pop = list(population)
    n = len(pop)
    if n == 0:
        return []

    # Objective rank (ascending objectives → lower rank is better)
    obj_order = sorted(range(n), key=lambda i: pop[i].objective_score)
    obj_rank = [0] * n
    for rank, idx in enumerate(obj_order, start=1):
        obj_rank[idx] = rank

    # Diversity contribution for each individual
    div_scores = [
        individual_diversity_contribution(pop[i], pop, problem, n_closest=n_closest)
        for i in range(n)
    ]

    # Diversity rank (higher contribution → lower rank, diversity bonus)
    div_order = sorted(range(n), key=lambda i: div_scores[i], reverse=True)
    div_rank = [0] * n
    for rank, idx in enumerate(div_order, start=1):
        div_rank[idx] = rank

    biased = [
        float(obj_rank[i]) + float(lambda_div) * float(n - div_rank[i])
        for i in range(n)
    ]
    return biased
