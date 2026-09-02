from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class TunableParam:
    name: str
    kind: str  # "i" int, "r" real, "c" categorical
    domain: Tuple[object, ...]
    help: str = ""
    condition: Optional[str] = None  # irace condition expression (optional)

    def irace_row(self) -> str:
        """Render a single irace parameters-file row.

        We encode each parameter as a repeatable `--param KEY=<value>` argument,
        so the switch becomes `--param KEY=`.
        """
        switch = f"--param {self.name}="
        if self.kind == "c":
            values = "(" + ",".join(str(v) for v in self.domain) + ")"
            row = f'{self.name} "{switch}" c {values}'
        elif self.kind == "i":
            lo, hi = self.domain
            row = f'{self.name} "{switch}" i ({int(lo)},{int(hi)})'
        elif self.kind == "r":
            lo, hi = self.domain
            row = f'{self.name} "{switch}" r ({float(lo)},{float(hi)})'
        else:
            raise ValueError(f"unknown kind: {self.kind}")

        if self.condition:
            row += f" | {self.condition}"
        return row


def tunable_parameters() -> List[TunableParam]:
    """Allowlisted tunables for automatic configuration.

    Non-negotiable rule: do not allow parameters that can change objective or
    feasibility semantics. This list focuses on search budgets and intensification
    controls, not weights/constraint relaxations.
    """
    return [
        # Hybrid budgeting / exact-ish layers
        TunableParam("SET_PARTITION_TIME_LIMIT_SEC", "r", (0.0, 20.0), "Restricted-master/set-partition time budget."),
        TunableParam("SET_PARTITION_ITERATIONS", "i", (1, 8), "Restricted-master iterations."),
        TunableParam("SET_PARTITION_NO_IMPROVE_ITERS", "i", (1, 4), "Early stop for restricted-master iterations."),
        TunableParam("COLUMN_GENERATION_ENABLED", "c", ("true", "false"), "Enable restricted-master LP loop."),
        TunableParam("COLUMN_GENERATION_MAX_ITERS", "i", (1, 6), "Max CG iterations.", condition="COLUMN_GENERATION_ENABLED == 'true'"),
        TunableParam("COLUMN_GENERATION_LP_TIME_LIMIT_SEC", "r", (0.05, 2.0), "LP solve budget per CG iter.", condition="COLUMN_GENERATION_ENABLED == 'true'"),
        TunableParam("PRICING_DUAL_STABILIZATION_ALPHA", "r", (0.0, 1.0), "Dual smoothing alpha.", condition="COLUMN_GENERATION_ENABLED == 'true'"),
        # Pricing small-exact scope (still restricted)
        TunableParam("PRICING_EXACT_SMALL_ENABLED", "c", ("true", "false"), "Enable exact-small pricing subroutine."),
        TunableParam("PRICING_EXACT_SMALL_MAX_EMPLOYEES", "i", (4, 10), "Exact-small pricing candidate set size.", condition="PRICING_EXACT_SMALL_ENABLED == 'true'"),
        TunableParam("PRICING_EXACT_SMALL_MAX_COLUMNS_PER_VEHICLE", "i", (1, 12), "Column cap per vehicle.", condition="PRICING_EXACT_SMALL_ENABLED == 'true'"),
        TunableParam("PRICING_EXACT_SMALL_TIME_LIMIT_SEC", "r", (0.05, 2.0), "Pricing time cap.", condition="PRICING_EXACT_SMALL_ENABLED == 'true'"),
        # Exact-LNS intensification
        TunableParam("EXACT_LNS_ENABLED", "c", ("true", "false"), "Enable exact-LNS layer."),
        TunableParam("EXACT_LNS_ATTEMPTS", "i", (0, 4), "Max exact-LNS attempts per run.", condition="EXACT_LNS_ENABLED == 'true'"),
        TunableParam("EXACT_LNS_TIME_LIMIT_SEC", "r", (0.2, 6.0), "Per-attempt time budget.", condition="EXACT_LNS_ENABLED == 'true'"),
        TunableParam("EXACT_LNS_FRAGMENT_ROUTES", "i", (1, 4), "Number of vehicle routes in fragment.", condition="EXACT_LNS_ENABLED == 'true'"),
        TunableParam("EXACT_LNS_MAX_FRAGMENT_EMPLOYEES", "i", (8, 28), "Max employees in fragment.", condition="EXACT_LNS_ENABLED == 'true'"),
        TunableParam("EXACT_LNS_STRATEGY", "c", ("auto", "worst_cost", "worst_delay", "worst_penalty", "random_routes", "dual_hot", "unstable"), "Fragment selection strategy.", condition="EXACT_LNS_ENABLED == 'true'"),
        # Route pool controls (master quality vs runtime)
        TunableParam("ROUTE_POOL_MAX_ROUTES", "i", (200, 1400), "Route pool size cap."),
        TunableParam("ROUTE_POOL_TARGETED_VARIANTS", "i", (0, 10), "Targeted pool augmentation intensity."),
        TunableParam("ROUTE_POOL_ITER_TOPK_ROUTES", "i", (0, 6), "Top-k routes harvested per seed individual."),
        TunableParam("ROUTE_POOL_PRUNING_MODE", "c", ("heuristic", "safe"), "Pool pruning mode."),
        # GA/HGS controls that should not change semantics
        TunableParam("OFFSPRING_EDUCATION_ENABLED", "c", ("true", "false"), "Enable offspring education."),
        TunableParam("OFFSPRING_EDUCATION_MAX_MOVES", "i", (1, 6), "Moves per education pass.", condition="OFFSPRING_EDUCATION_ENABLED == 'true'"),
        TunableParam("BIASED_PARENT_SELECTION", "c", ("true", "false"), "Enable biased-fitness parent selection."),
        TunableParam("TARGET_FEASIBLE_RATIO", "r", (0.10, 0.55), "Adaptive penalty target feasible ratio."),
        TunableParam("HGS_SUBPOPULATION_ENABLED", "c", ("true", "false"), "Enable two-subpopulation survivor selection."),
        TunableParam("HGS_SUBPOPULATION_INFEASIBLE_FRACTION", "r", (0.0, 0.60), "Infeasible bucket fraction.", condition="HGS_SUBPOPULATION_ENABLED == 'true'"),
        TunableParam("LAMBDA_DIVERSITY", "r", (0.0, 1.5), "Initial diversity pressure."),
        TunableParam("STAGNATION_LIMIT_GEN", "i", (4, 30), "Restart trigger generations."),
        TunableParam("RESTART_FRACTION", "r", (0.10, 0.50), "Fraction replaced on restart."),
    ]


def allowlisted_param_names() -> List[str]:
    return [p.name for p in tunable_parameters()]


def validate_overrides_allowlisted(overrides: Dict[str, object]) -> None:
    allowed = set(allowlisted_param_names())
    for k in (overrides or {}).keys():
        if str(k) not in allowed:
            raise ValueError(f"Parameter not allowlisted for tuning: {k}")


def irace_parameters_text() -> str:
    lines = []
    lines.append("# irace parameters file (auto-generated)")
    lines.append("# Each parameter is passed as: --param KEY=<value>")
    for p in tunable_parameters():
        lines.append(p.irace_row())
    return "\n".join(lines) + "\n"

