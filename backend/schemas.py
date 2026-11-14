"""Request/response bodies and the preference models stored as JSON."""

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field, model_validator

HHMM = r"^(([01]\d|2[0-3]):[0-5]\d|24:00)$"
TimeOfDay = Literal["morning", "midday", "afternoon", "evening"]


def hhmm_to_minutes(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


# ── Weather limits (hard) and preferred conditions (soft) ───────────────────


class WeatherLimits(BaseModel):
    """A window that breaks any of these is ineligible."""

    max_rain_chance: int = Field(40, ge=0, le=100)
    max_snow_chance: int = Field(20, ge=0, le=100)
    max_wind_kph: float = Field(30, ge=0)
    min_feelslike_c: float = 0
    max_feelslike_c: float = 32
    require_daylight: bool = True


class PreferredConditions(BaseModel):
    """Soft preferences used by the baseline ranker."""

    ideal_temp_min_c: float = 10
    ideal_temp_max_c: float = 20
    preferred_times: list[TimeOfDay] = []
    temp_weight: float = Field(1.0, ge=0)
    rain_weight: float = Field(1.0, ge=0)
    wind_weight: float = Field(0.5, ge=0)
    time_weight: float = Field(0.75, ge=0)


class PreferencesIn(BaseModel):
    limits: WeatherLimits = WeatherLimits()
    preferred: PreferredConditions = PreferredConditions()


class PreferencesOut(PreferencesIn):
    location_id: int


# ── Users / locations ──────────────────────────────────────────────────────


class UserOut(BaseModel):
    id: int
    auth_subject: str
    email: str | None
    timezone: str


class UserUpdate(BaseModel):
    email: str | None = None
    timezone: str | None = None


class LocationCreate(BaseModel):
    """Pass `weatherapi_id` from /api/locations/search, or any WeatherAPI query (city, "lat,lon")."""

    weatherapi_id: int | None = None
    query: str | None = None

    @model_validator(mode="after")
    def _one_of(self):
        if self.weatherapi_id is None and not (self.query and self.query.strip()):
            raise ValueError("Provide weatherapi_id or query")
        return self


class LocationOut(BaseModel):
    id: int
    name: str
    region: str | None
    country: str | None
    lat: float
    lon: float
    timezone: str


# ── Availability / goals ───────────────────────────────────────────────────


class _Interval(BaseModel):
    start_local: str = Field(pattern=HHMM)
    end_local: str = Field(pattern=HHMM)

    @model_validator(mode="after")
    def _ordered(self):
        if hhmm_to_minutes(self.end_local) <= hhmm_to_minutes(self.start_local):
            raise ValueError("end_local must be after start_local")
        return self


class AvailabilityRuleIn(_Interval):
    weekday: int = Field(ge=0, le=6, description="0 = Monday")


class AvailabilityRuleOut(AvailabilityRuleIn):
    id: int


class AvailabilityExceptionIn(_Interval):
    date: dt.date
    kind: Literal["available", "blocked"]
    note: str | None = None


class AvailabilityExceptionOut(AvailabilityExceptionIn):
    id: int


class AvailabilityOut(BaseModel):
    rules: list[AvailabilityRuleOut]
    exceptions: list[AvailabilityExceptionOut]


class GoalIn(BaseModel):
    activity: str = "run"
    duration_minutes: int = Field(ge=5, le=600)
    sessions_per_week: int = Field(ge=1, le=21)
    separate_days: bool = True
    min_gap_minutes: int = Field(0, ge=0)


class GoalOut(GoalIn):
    id: int
    active: bool


# ── Plans ──────────────────────────────────────────────────────────────────


class GeneratePlanIn(BaseModel):
    location_id: int
    goal_id: int
    refresh_weather: bool = False


class SessionUpdate(BaseModel):
    candidate_id: int | None = Field(None, description="Swap to another candidate in the plan")
    locked: bool | None = None


class FeedbackIn(BaseModel):
    candidate_id: int
    rating: int = Field(ge=0, le=4)
    reason: str | None = Field(None, max_length=1000)
