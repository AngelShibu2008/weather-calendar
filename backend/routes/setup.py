"""User flow steps 1–4: user, location, availability, goal, weather limits & preferences."""

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import delete, select

from ..deps import DB, CurrentUser, owned, valid_timezone
from ..models import AvailabilityException, AvailabilityRule, Goal, Location, Preference
from ..schemas import (
    AvailabilityExceptionIn,
    AvailabilityExceptionOut,
    AvailabilityOut,
    AvailabilityRuleIn,
    AvailabilityRuleOut,
    GoalIn,
    GoalOut,
    LocationCreate,
    LocationOut,
    PreferencesIn,
    PreferencesOut,
    UserOut,
    UserUpdate,
)
from ..services import weather

router = APIRouter(prefix="/api")


# ── User ───────────────────────────────────────────────────────────────────


@router.get("/me", response_model=UserOut)
def get_me(user: CurrentUser):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(body: UserUpdate, user: CurrentUser, db: DB):
    if body.timezone is not None:
        if not valid_timezone(body.timezone):
            raise HTTPException(422, "Unknown timezone")
        user.timezone = body.timezone
    if body.email is not None:
        user.email = body.email
    db.commit()
    return user


# ── Locations ──────────────────────────────────────────────────────────────


@router.get("/locations/search")
def search_locations(user: CurrentUser, q: str = Query(min_length=2, max_length=100)):
    return weather.search_locations(q)


@router.post("/locations", response_model=LocationOut, status_code=201)
def create_location(body: LocationCreate, user: CurrentUser, db: DB):
    query = f"id:{body.weatherapi_id}" if body.weatherapi_id is not None else body.query.strip()
    forecast = weather.fetch_forecast(query)  # also gives us the timezone
    loc = forecast["location"]
    location = Location(
        user_id=user.id,
        name=loc["name"],
        region=loc.get("region"),
        country=loc.get("country"),
        lat=loc["lat"],
        lon=loc["lon"],
        timezone=loc["tz_id"],
        provider=weather.PROVIDER,
        provider_ref=query,
    )
    db.add(location)
    db.flush()
    weather.store_snapshot(db, location, forecast)  # warm the cache
    db.commit()
    return location


@router.get("/locations", response_model=list[LocationOut])
def list_locations(user: CurrentUser, db: DB):
    return db.scalars(select(Location).where(Location.user_id == user.id).order_by(Location.id)).all()


@router.get("/locations/{location_id}/forecast")
def location_forecast(location_id: int, user: CurrentUser, db: DB, refresh: bool = False):
    location = owned(db.get(Location, location_id), user, "Location")
    snapshot = weather.get_forecast(db, location, force_refresh=refresh)
    return {"snapshot_id": snapshot.id, "retrieved_at": snapshot.retrieved_at, **snapshot.values}


# ── Weather limits & preferences ───────────────────────────────────────────


@router.get("/locations/{location_id}/preferences", response_model=PreferencesOut)
def get_preferences(location_id: int, user: CurrentUser, db: DB):
    owned(db.get(Location, location_id), user, "Location")
    row = db.scalar(
        select(Preference).where(Preference.user_id == user.id, Preference.location_id == location_id)
    )
    if row is None:
        return PreferencesOut(location_id=location_id)
    return PreferencesOut(location_id=location_id, limits=row.limits, preferred=row.preferred)


@router.put("/locations/{location_id}/preferences", response_model=PreferencesOut)
def put_preferences(location_id: int, body: PreferencesIn, user: CurrentUser, db: DB):
    owned(db.get(Location, location_id), user, "Location")
    row = db.scalar(
        select(Preference).where(Preference.user_id == user.id, Preference.location_id == location_id)
    )
    if row is None:
        row = Preference(user_id=user.id, location_id=location_id)
        db.add(row)
    row.limits = body.limits.model_dump()
    row.preferred = body.preferred.model_dump()
    db.commit()
    return PreferencesOut(location_id=location_id, **body.model_dump())


# ── Availability ───────────────────────────────────────────────────────────


@router.get("/availability", response_model=AvailabilityOut)
def get_availability(user: CurrentUser, db: DB):
    rules = db.scalars(
        select(AvailabilityRule).where(AvailabilityRule.user_id == user.id)
        .order_by(AvailabilityRule.weekday, AvailabilityRule.start_local)
    ).all()
    exceptions = db.scalars(
        select(AvailabilityException).where(AvailabilityException.user_id == user.id)
        .order_by(AvailabilityException.date, AvailabilityException.start_local)
    ).all()
    return {"rules": rules, "exceptions": exceptions}


@router.put("/availability/rules", response_model=list[AvailabilityRuleOut])
def replace_rules(body: list[AvailabilityRuleIn], user: CurrentUser, db: DB):
    """Replace the whole weekly template (simplest for a week-grid editor)."""
    db.execute(delete(AvailabilityRule).where(AvailabilityRule.user_id == user.id))
    rows = [AvailabilityRule(user_id=user.id, **r.model_dump()) for r in body]
    db.add_all(rows)
    db.commit()
    return rows


@router.post("/availability/exceptions", response_model=AvailabilityExceptionOut, status_code=201)
def add_exception(body: AvailabilityExceptionIn, user: CurrentUser, db: DB):
    row = AvailabilityException(user_id=user.id, **body.model_dump())
    db.add(row)
    db.commit()
    return row


@router.put("/availability/exceptions/{exception_id}", response_model=AvailabilityExceptionOut)
def update_exception(exception_id: int, body: AvailabilityExceptionIn, user: CurrentUser, db: DB):
    row = owned(db.get(AvailabilityException, exception_id), user, "Exception")
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    db.commit()
    return row


@router.delete("/availability/exceptions/{exception_id}", status_code=204)
def delete_exception(exception_id: int, user: CurrentUser, db: DB):
    row = owned(db.get(AvailabilityException, exception_id), user, "Exception")
    db.delete(row)
    db.commit()


# ── Goals ──────────────────────────────────────────────────────────────────


@router.get("/goals", response_model=list[GoalOut])
def list_goals(user: CurrentUser, db: DB):
    return db.scalars(
        select(Goal).where(Goal.user_id == user.id, Goal.active.is_(True)).order_by(Goal.id)
    ).all()


@router.post("/goals", response_model=GoalOut, status_code=201)
def create_goal(body: GoalIn, user: CurrentUser, db: DB):
    goal = Goal(user_id=user.id, **body.model_dump())
    db.add(goal)
    db.commit()
    return goal


@router.put("/goals/{goal_id}", response_model=GoalOut)
def update_goal(goal_id: int, body: GoalIn, user: CurrentUser, db: DB):
    goal = owned(db.get(Goal, goal_id), user, "Goal")
    for field, value in body.model_dump().items():
        setattr(goal, field, value)
    db.commit()
    return goal


@router.delete("/goals/{goal_id}", status_code=204)
def archive_goal(goal_id: int, user: CurrentUser, db: DB):
    goal = owned(db.get(Goal, goal_id), user, "Goal")
    goal.active = False  # plans reference goals, so archive instead of deleting
    db.commit()
