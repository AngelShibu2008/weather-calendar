"""Database tables (one class per table in the database design)."""

import datetime as dt
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime) -> datetime:
    """SQLite drops tzinfo; every stored datetime is UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    auth_subject: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Location(Base):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    region: Mapped[str | None] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(255))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    timezone: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32), default="weatherapi")
    provider_ref: Mapped[str] = mapped_column(String(64))  # query string, e.g. "id:2801268"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Preference(Base):
    __tablename__ = "preferences"
    __table_args__ = (UniqueConstraint("user_id", "location_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    limits: Mapped[dict[str, Any]] = mapped_column(JSON)  # hard limits -> WeatherLimits
    preferred: Mapped[dict[str, Any]] = mapped_column(JSON)  # soft -> PreferredConditions
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class AvailabilityRule(Base):
    __tablename__ = "availability_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)  # 0 = Monday … 6 = Sunday
    start_local: Mapped[str] = mapped_column(String(5))  # "HH:MM"
    end_local: Mapped[str] = mapped_column(String(5))


class AvailabilityException(Base):
    __tablename__ = "availability_exceptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[dt.date] = mapped_column(Date, index=True)
    start_local: Mapped[str] = mapped_column(String(5))
    end_local: Mapped[str] = mapped_column(String(5))
    kind: Mapped[str] = mapped_column(String(16))  # "available" | "blocked"
    note: Mapped[str | None] = mapped_column(String(255))


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    activity: Mapped[str] = mapped_column(String(64), default="run")
    duration_minutes: Mapped[int] = mapped_column(Integer)
    sessions_per_week: Mapped[int] = mapped_column(Integer)
    separate_days: Mapped[bool] = mapped_column(Boolean, default=True)
    min_gap_minutes: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ForecastSnapshot(Base):
    __tablename__ = "forecast_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="weatherapi")
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"), index=True)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    forecast_days: Mapped[int] = mapped_column(Integer)
    values: Mapped[dict[str, Any]] = mapped_column(JSON)  # normalized, see services/weather.py


class ModelVersion(Base):
    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))  # "baseline" | "lgbm-lambdarank"
    artifact_uri: Mapped[str | None] = mapped_column(String(512))
    feature_schema: Mapped[list[str]] = mapped_column(JSON)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    goal_id: Mapped[int] = mapped_column(ForeignKey("goals.id"))
    range_start: Mapped[dt.date] = mapped_column(Date)
    range_end: Mapped[dt.date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    # draft -> accepted -> superseded; refresh creates a "proposed" child plan
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_plan_id: Mapped[int | None] = mapped_column(ForeignKey("plans.id"))
    model_version_id: Mapped[int | None] = mapped_column(ForeignKey("model_versions.id"))
    ranker_name: Mapped[str] = mapped_column(String(64), default="baseline")
    forecast_snapshot_id: Mapped[int] = mapped_column(ForeignKey("forecast_snapshots.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    changes: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)  # diff vs parent
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    location: Mapped[Location] = relationship()
    goal: Mapped[Goal] = relationship()
    snapshot: Mapped[ForecastSnapshot] = relationship()
    candidates: Mapped[list["Candidate"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan", order_by="Candidate.start_epoch"
    )
    sessions: Mapped[list["PlannedSession"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan"
    )


class Candidate(Base):
    __tablename__ = "candidates"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    start_epoch: Mapped[int] = mapped_column(Integer)
    end_epoch: Mapped[int] = mapped_column(Integer)
    features: Mapped[dict[str, float]] = mapped_column(JSON)  # feature snapshot for the ranker
    display: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # condition text/icon
    eligible: Mapped[bool] = mapped_column(Boolean)
    violations: Mapped[list[str]] = mapped_column(JSON, default=list)
    score: Mapped[float | None] = mapped_column(Float)  # normalized 0..1 within the plan
    rank: Mapped[int | None] = mapped_column(Integer)

    plan: Mapped[Plan] = relationship(back_populates="candidates")


class PlannedSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"))
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    explanation: Mapped[str | None] = mapped_column(Text)
    alternative_ids: Mapped[list[int]] = mapped_column(JSON, default=list)

    plan: Mapped[Plan] = relationship(back_populates="sessions")
    candidate: Mapped[Candidate] = relationship()


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"), index=True)
    rating: Mapped[int] = mapped_column(Integer)  # 0 (bad) … 4 (great)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
