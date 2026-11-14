"""Optimizer: pick a compatible set of sessions with OR-Tools CP-SAT.

Constraints: no two sessions overlap (plus the goal's minimum gap), at most one session per
day when `separate_days`, at most `target` sessions, locked sessions always included.
Objective: as many sessions as possible (up to target), then the highest total score.
"""

import logging
from collections import defaultdict
from dataclasses import dataclass

from ortools.sat.python import cp_model

log = logging.getLogger(__name__)


@dataclass
class OptCandidate:
    key: int
    start_epoch: int
    end_epoch: int
    day: str  # local date, for the separate-day rule
    score: float  # normalized 0..1
    forced: bool = False


def select_sessions(
    candidates: list[OptCandidate],
    target: int,
    separate_days: bool,
    min_gap_minutes: int = 0,
    time_limit_seconds: float = 5.0,
) -> list[int]:
    forced = [c.key for c in candidates if c.forced]
    if not candidates:
        return []

    model = cp_model.CpModel()
    origin = min(c.start_epoch for c in candidates)
    x = {c.key: model.new_bool_var(f"x{c.key}") for c in candidates}

    intervals = []
    for c in candidates:
        start = (c.start_epoch - origin) // 60
        size = (c.end_epoch - c.start_epoch) // 60 + min_gap_minutes
        intervals.append(model.new_optional_fixed_size_interval_var(start, size, x[c.key], f"i{c.key}"))
        if c.forced:
            model.add(x[c.key] == 1)
    model.add_no_overlap(intervals)

    if separate_days:
        by_day: dict[str, list[OptCandidate]] = defaultdict(list)
        for c in candidates:
            by_day[c.day].append(c)
        for group in by_day.values():
            cap = max(1, sum(c.forced for c in group))
            model.add(sum(x[c.key] for c in group) <= cap)

    model.add(sum(x.values()) <= max(target, len(forced)))

    count_weight = 1000 * (max(target, len(forced)) + 1)
    model.maximize(
        sum(count_weight * v for v in x.values())
        + sum(int(round(c.score * 1000)) * x[c.key] for c in candidates)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.num_workers = 4
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log.warning("CP-SAT returned %s; keeping locked sessions only", solver.status_name(status))
        return forced
    return [c.key for c in candidates if solver.value(x[c.key])]
