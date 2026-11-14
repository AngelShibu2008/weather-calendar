"""User flow steps 5–8: generate, review, accept/edit, refresh; plus feedback."""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from ..deps import DB, CurrentUser, owned
from ..models import Candidate, Feedback, Goal, Location, Plan, PlannedSession
from ..schemas import FeedbackIn, GeneratePlanIn, SessionUpdate
from ..services import planner

router = APIRouter(prefix="/api")


# ── Serialization ──────────────────────────────────────────────────────────


def candidate_out(c: Candidate, tz: ZoneInfo) -> dict[str, Any]:
    f = c.features
    return {
        "id": c.id,
        "start": datetime.fromtimestamp(c.start_epoch, tz).isoformat(),
        "end": datetime.fromtimestamp(c.end_epoch, tz).isoformat(),
        "eligible": c.eligible,
        "violations": c.violations or [],
        "score": c.score,
        "rank": c.rank,
        "weather": {
            "condition_text": c.display.get("condition_text"),
            "condition_icon": c.display.get("condition_icon"),
            "temp_c": f["temp_mean_c"],
            "feelslike_c": f["feelslike_mean_c"],
            "chance_of_rain": f["rain_chance_max"],
            "chance_of_snow": f["snow_chance_max"],
            "wind_kph": f["wind_kph_max"],
        },
    }


def plan_out(plan: Plan, include_candidates: bool = False, include_forecast: bool = True) -> dict[str, Any]:
    tz = ZoneInfo(plan.location.timezone)
    by_id = {c.id: c for c in plan.candidates}
    sessions = sorted(plan.sessions, key=lambda s: s.candidate.start_epoch)
    out: dict[str, Any] = {
        "id": plan.id,
        "status": plan.status,
        "version": plan.version,
        "parent_plan_id": plan.parent_plan_id,
        "location": {"id": plan.location.id, "name": plan.location.name, "timezone": plan.location.timezone},
        "goal": {
            "id": plan.goal.id,
            "activity": plan.goal.activity,
            "duration_minutes": plan.goal.duration_minutes,
            "sessions_per_week": plan.goal.sessions_per_week,
        },
        "range": {"start": plan.range_start.isoformat(), "end": plan.range_end.isoformat()},
        "ranker": {"name": plan.ranker_name, "model_version_id": plan.model_version_id},
        "notes": plan.notes,
        "changes": plan.changes,
        "created_at": plan.created_at,
        "forecast_retrieved_at": plan.snapshot.retrieved_at,
        "sessions": [
            {
                **candidate_out(s.candidate, tz),
                "id": s.id,
                "candidate_id": s.candidate_id,
                "locked": s.locked,
                "explanation": s.explanation,
                "alternatives": [candidate_out(by_id[a], tz) for a in s.alternative_ids if a in by_id],
            }
            for s in sessions
        ],
        "stats": {
            "candidates": len(plan.candidates),
            "eligible": sum(1 for c in plan.candidates if c.eligible),
        },
    }
    if include_candidates:
        out["candidates"] = [candidate_out(c, tz) for c in plan.candidates]
    if include_forecast:
        out["forecast"] = plan.snapshot.values["days"]
    return out


def _plan(db, plan_id: int, user) -> Plan:
    return owned(db.get(Plan, plan_id), user, "Plan")


# ── Plans ──────────────────────────────────────────────────────────────────


@router.post("/plans/generate", status_code=201)
def generate_plan(body: GeneratePlanIn, user: CurrentUser, db: DB):
    location = owned(db.get(Location, body.location_id), user, "Location")
    goal = owned(db.get(Goal, body.goal_id), user, "Goal")
    plan = planner.build_plan(db, user, location, goal, force_refresh=body.refresh_weather)
    return plan_out(plan)


@router.get("/plans")
def list_plans(user: CurrentUser, db: DB, status: str | None = None):
    query = select(Plan).where(Plan.user_id == user.id).order_by(Plan.created_at.desc()).limit(50)
    if status:
        query = query.where(Plan.status == status)
    return [plan_out(p, include_forecast=False) for p in db.scalars(query)]


@router.get("/plans/{plan_id}")
def get_plan(plan_id: int, user: CurrentUser, db: DB, include_candidates: bool = False):
    return plan_out(_plan(db, plan_id, user), include_candidates=include_candidates)


@router.post("/plans/{plan_id}/accept")
def accept_plan(plan_id: int, user: CurrentUser, db: DB):
    plan = _plan(db, plan_id, user)
    if plan.status == "superseded":
        raise HTTPException(409, "This plan was superseded by a newer version")
    return plan_out(planner.accept_plan(db, plan))


@router.post("/plans/{plan_id}/refresh", status_code=201)
def refresh_plan(plan_id: int, user: CurrentUser, db: DB):
    """Re-fetch weather and return a *proposed* new version with `changes`. Accept it to apply."""
    plan = _plan(db, plan_id, user)
    if plan.status == "superseded":
        raise HTTPException(409, "Refresh the latest version of this plan instead")
    return plan_out(planner.refresh_plan(db, user, plan))


@router.patch("/sessions/{session_id}")
def update_session(session_id: int, body: SessionUpdate, user: CurrentUser, db: DB):
    """Swap a session to another candidate window and/or lock it so refreshes keep it."""
    session = db.get(PlannedSession, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    plan = _plan(db, session.plan_id, user)
    if plan.status == "superseded":
        raise HTTPException(409, "This plan was superseded by a newer version")

    if body.candidate_id is not None and body.candidate_id != session.candidate_id:
        new = db.get(Candidate, body.candidate_id)
        if new is None or new.plan_id != plan.id:
            raise HTTPException(404, "Candidate not found in this plan")
        others = [s.candidate for s in plan.sessions if s.id != session.id]
        if not planner.compatible(new, others, plan.goal):
            raise HTTPException(409, "That window clashes with another session in this plan")
        session.candidate = new
        others_all = [s.candidate for s in plan.sessions]
        for s in plan.sessions:
            rest = [c for c in others_all if c is not s.candidate]
            s.alternative_ids = planner.alternatives_for(s.candidate, rest, plan.candidates, plan.goal)
    if body.locked is not None:
        session.locked = body.locked
    planner.explain_plan_sessions(plan, [session], use_llm=False)
    db.commit()
    return plan_out(plan, include_forecast=False)


# ── Feedback ───────────────────────────────────────────────────────────────


@router.post("/feedback", status_code=201)
def add_feedback(body: FeedbackIn, user: CurrentUser, db: DB):
    candidate = db.get(Candidate, body.candidate_id)
    if candidate is None:
        raise HTTPException(404, "Candidate not found")
    _plan(db, candidate.plan_id, user)
    row = Feedback(user_id=user.id, **body.model_dump())
    db.add(row)
    db.commit()
    return {"id": row.id, "candidate_id": row.candidate_id, "rating": row.rating}
