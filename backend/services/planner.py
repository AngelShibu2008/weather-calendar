"""Plan pipeline: forecast → candidates → ranker → CP-SAT optimizer → explanations."""

from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    AvailabilityException,
    AvailabilityRule,
    Candidate,
    Goal,
    Location,
    Plan,
    PlannedSession,
    Preference,
    User,
)
from ..schemas import PreferredConditions, WeatherLimits
from . import candidates as cand
from . import explain, weather
from .optimizer import OptCandidate, select_sessions
from .ranker import load_active_ranker

ALTERNATIVES_PER_SESSION = 3


def load_preferences(db: Session, user: User, location: Location) -> tuple[WeatherLimits, PreferredConditions]:
    row = db.scalar(
        select(Preference).where(Preference.user_id == user.id, Preference.location_id == location.id)
    )
    if row is None:
        return WeatherLimits(), PreferredConditions()
    return WeatherLimits(**row.limits), PreferredConditions(**row.preferred)


def _normalize(scores: list[float]) -> list[float]:
    if not scores:
        return []
    lo, hi = min(scores), max(scores)
    if hi - lo < 1e-9:
        return [1.0] * len(scores)
    return [(s - lo) / (hi - lo) for s in scores]


def compatible(c: Candidate, others: list[Candidate], goal: Goal) -> bool:
    """Could `c` replace a session without clashing with the plan's other sessions?"""
    gap = goal.min_gap_minutes * 60
    for o in others:
        if c.start_epoch < o.end_epoch + gap and o.start_epoch < c.end_epoch + gap:
            return False
        if goal.separate_days and c.display["local_date"] == o.display["local_date"]:
            return False
    return True


def alternatives_for(session_candidate: Candidate, others: list[Candidate], pool: list[Candidate], goal: Goal) -> list[int]:
    ranked = sorted((c for c in pool if c.eligible), key=lambda c: -(c.score or 0))
    taken = {session_candidate.id, *(o.id for o in others)}
    alts = [c.id for c in ranked if c.id not in taken and compatible(c, others, goal)]
    return alts[:ALTERNATIVES_PER_SESSION]


def explain_plan_sessions(plan: Plan, sessions: list[PlannedSession], use_llm: bool = True) -> None:
    """use_llm=False keeps single-session edits instant (templates only)."""
    eligible_count = sum(1 for c in plan.candidates if c.eligible)
    facts = [explain.session_facts(s.candidate, eligible_count, s.locked) for s in sessions]
    for s, text in zip(sessions, explain.explain_sessions(facts, plan.goal.activity, use_llm)):
        s.explanation = text


def build_plan(
    db: Session,
    user: User,
    location: Location,
    goal: Goal,
    *,
    parent: Plan | None = None,
    status: str = "draft",
    force_refresh: bool = False,
) -> Plan:
    settings = get_settings()
    snapshot = weather.get_forecast(db, location, force_refresh=force_refresh)
    forecast = snapshot.values
    limits, preferred = load_preferences(db, user, location)
    rules = list(db.scalars(select(AvailabilityRule).where(AvailabilityRule.user_id == user.id)))
    exceptions = list(
        db.scalars(select(AvailabilityException).where(AvailabilityException.user_id == user.id))
    )
    now = datetime.now(timezone.utc)

    # 1. Candidate generator
    drafts = cand.generate(
        forecast, rules, exceptions, goal.duration_minutes, limits, preferred,
        settings.candidate_step_minutes, now,
    )

    # Locked sessions from the parent plan carry over, re-evaluated against the new forecast.
    if parent is not None:
        by_window = {(d.start_epoch, d.end_epoch): d for d in drafts}
        for s in parent.sessions:
            if not s.locked:
                continue
            old = s.candidate
            key = (old.start_epoch, old.end_epoch)
            draft = by_window.get(key) or cand.evaluate_epoch_window(
                forecast, old.start_epoch, old.end_epoch, limits, preferred, now
            )
            if draft is None:  # beyond the new forecast range: keep the old snapshot
                draft = cand.CandidateDraft(
                    old.start_epoch, old.end_epoch, dict(old.features), dict(old.display),
                    old.eligible, list(old.violations or []),
                )
            draft.forced = True
            if key not in by_window:
                drafts.append(draft)
                by_window[key] = draft

    # 2. Ranker (eligible + locked windows only)
    ranker = load_active_ranker(db)
    pool = [d for d in drafts if d.eligible or d.forced]
    scores = _normalize(ranker.score([d.features for d in pool], preferred))
    score_of = {id(d): s for d, s in zip(pool, scores)}
    rank_of = {id(d): r for r, d in enumerate(sorted(pool, key=lambda d: -score_of[id(d)]), start=1)}

    # 3. Optimizer
    opt = [
        OptCandidate(i, d.start_epoch, d.end_epoch, d.display["local_date"], score_of[id(d)], d.forced)
        for i, d in enumerate(pool)
    ]
    chosen = {id(pool[k]) for k in select_sessions(
        opt, goal.sessions_per_week, goal.separate_days, goal.min_gap_minutes,
        settings.optimizer_time_limit_seconds,
    )}

    # 4. Persist
    version = (
        db.scalar(select(func.max(Plan.version)).where(Plan.user_id == user.id, Plan.goal_id == goal.id))
        or 0
    ) + 1
    days = [date.fromisoformat(d["date"]) for d in forecast["days"]]
    plan = Plan(
        user_id=user.id,
        location_id=location.id,
        goal_id=goal.id,
        range_start=min(days),
        range_end=max(days),
        status=status,
        version=version,
        parent_plan_id=parent.id if parent else None,
        model_version_id=ranker.model_version_id,
        ranker_name=ranker.name,
        forecast_snapshot_id=snapshot.id,
    )
    db.add(plan)
    db.flush()

    rows: dict[int, Candidate] = {}
    for d in drafts:
        row = Candidate(
            plan_id=plan.id,
            start_epoch=d.start_epoch,
            end_epoch=d.end_epoch,
            features=d.features,
            display=d.display,
            eligible=d.eligible,
            violations=d.violations,
            score=score_of.get(id(d)),
            rank=rank_of.get(id(d)),
        )
        plan.candidates.append(row)
        rows[id(d)] = row
    db.flush()

    selected = sorted((rows[i] for i in chosen), key=lambda c: c.start_epoch)
    locked_windows = {(d.start_epoch, d.end_epoch) for d in drafts if d.forced}
    sessions = []
    for c in selected:
        others = [o for o in selected if o is not c]
        s = PlannedSession(
            candidate=c,
            locked=(c.start_epoch, c.end_epoch) in locked_windows,
            alternative_ids=alternatives_for(c, others, plan.candidates, goal),
        )
        plan.sessions.append(s)
        sessions.append(s)

    if len(selected) < goal.sessions_per_week:
        eligible_total = sum(1 for d in drafts if d.eligible)
        eligible_days = len({d.display["local_date"] for d in drafts if d.eligible})
        reason = (
            f"{eligible_total} of {len(drafts)} windows in the {len(days)}-day forecast "
            "fit your availability and weather limits"
        )
        if goal.separate_days:
            reason += f", spread over {eligible_days} day(s), and you asked for one session per day"
        plan.notes = (
            f"Scheduled {len(selected)} of {goal.sessions_per_week} sessions: {reason}. "
            "Refresh later in the week as the forecast extends, or widen availability/limits."
        )

    # 5. Explanations
    explain_plan_sessions(plan, sessions)
    db.commit()
    return plan


# ── Accept / refresh ───────────────────────────────────────────────────────


def accept_plan(db: Session, plan: Plan) -> Plan:
    db.execute(
        update(Plan)
        .where(
            Plan.user_id == plan.user_id,
            Plan.goal_id == plan.goal_id,
            Plan.id != plan.id,
            Plan.status.in_(("draft", "proposed", "accepted")),
        )
        .values(status="superseded")
    )
    plan.status = "accepted"
    db.commit()
    return plan


def _window(c: Candidate, tz: ZoneInfo) -> dict[str, str]:
    return {
        "start": datetime.fromtimestamp(c.start_epoch, tz).isoformat(),
        "end": datetime.fromtimestamp(c.end_epoch, tz).isoformat(),
    }


def diff_plans(old: Plan, new: Plan) -> list[dict[str, Any]]:
    """Explain how a refreshed plan differs from its parent."""
    tz = ZoneInfo(new.location.timezone)
    new_at = {(c.start_epoch, c.end_epoch): c for c in new.candidates}
    old_sessions = sorted(old.sessions, key=lambda s: s.candidate.start_epoch)
    new_sessions = sorted(new.sessions, key=lambda s: s.candidate.start_epoch)
    key = lambda s: (s.candidate.start_epoch, s.candidate.end_epoch)  # noqa: E731
    old_keys, new_keys = {key(s) for s in old_sessions}, {key(s) for s in new_sessions}

    def why_left(s: PlannedSession) -> str:
        now_c = new_at.get(key(s))
        if now_c is None:
            return "That time has passed or is no longer in your availability."
        if not now_c.eligible:
            return "The updated forecast breaks your limits: " + "; ".join(now_c.violations) + "."
        return "A better-ranked window opened up in the updated forecast."

    changes: list[dict[str, Any]] = []
    for s in new_sessions:
        if key(s) in old_keys:
            changes.append({"type": "unchanged", "session_id": s.id, "after": _window(s.candidate, tz)})
    moved_from = [s for s in old_sessions if key(s) not in new_keys]
    moved_to = [s for s in new_sessions if key(s) not in old_keys]
    for before, after in zip(moved_from, moved_to):
        changes.append({
            "type": "moved", "session_id": after.id,
            "before": _window(before.candidate, tz), "after": _window(after.candidate, tz),
            "reason": why_left(before),
        })
    for before in moved_from[len(moved_to):]:
        changes.append({"type": "removed", "before": _window(before.candidate, tz), "reason": why_left(before)})
    for after in moved_to[len(moved_from):]:
        changes.append({"type": "added", "session_id": after.id, "after": _window(after.candidate, tz),
                        "reason": "A new window fits your goal."})
    return changes


def refresh_plan(db: Session, user: User, plan: Plan) -> Plan:
    """Fetch fresh weather and propose a new plan version (status "proposed") with a diff."""
    proposed = build_plan(
        db, user, plan.location, plan.goal, parent=plan, status="proposed", force_refresh=True
    )
    proposed.changes = diff_plans(plan, proposed)
    db.commit()
    return proposed
