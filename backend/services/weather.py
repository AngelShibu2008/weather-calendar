"""WeatherAPI.com client plus a forecast cache backed by forecast_snapshots.

Only the fields the planner needs are kept (see `normalize_forecast`).
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ForecastSnapshot, Location, as_utc

log = logging.getLogger(__name__)
PROVIDER = "weatherapi"


class WeatherError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _get(path: str, params: dict[str, Any]) -> Any:
    settings = get_settings()
    if not settings.weatherapi_key:
        raise WeatherError("WEATHERAPI_KEY is not set. Add it to backend/.env.", 503)
    try:
        resp = httpx.get(
            f"{settings.weatherapi_base_url}/{path}",
            params={"key": settings.weatherapi_key, **params},
            timeout=settings.weather_timeout_seconds,
        )
    except httpx.HTTPError as exc:
        # Don't include the exception text: it can contain the request URL (and the key).
        raise WeatherError(f"Weather provider unreachable ({type(exc).__name__})") from None
    try:
        data = resp.json()
    except ValueError:
        raise WeatherError(f"Weather provider returned non-JSON ({resp.status_code})") from None
    if resp.status_code != 200 or (isinstance(data, dict) and "error" in data):
        message = data.get("error", {}).get("message") if isinstance(data, dict) else None
        status = 400 if resp.status_code == 400 else 502
        raise WeatherError(f"Weather provider error: {message or resp.status_code}", status)
    return data


def search_locations(query: str) -> list[dict[str, Any]]:
    """GET /v1/search.json"""
    results = _get("search.json", {"q": query})
    return [
        {
            "weatherapi_id": r.get("id"),
            "name": r.get("name"),
            "region": r.get("region"),
            "country": r.get("country"),
            "lat": r.get("lat"),
            "lon": r.get("lon"),
        }
        for r in results
    ]


def _icon_url(icon: str | None) -> str | None:
    if icon and icon.startswith("//"):
        return "https:" + icon
    return icon


def normalize_forecast(raw: dict[str, Any]) -> dict[str, Any]:
    loc = raw["location"]
    days = []
    for day in raw["forecast"]["forecastday"]:
        days.append(
            {
                "date": day["date"],
                "sunrise": day["astro"]["sunrise"],
                "sunset": day["astro"]["sunset"],
                "hours": [
                    {
                        "time_epoch": int(h["time_epoch"]),
                        "time": h.get("time"),
                        "temp_c": float(h["temp_c"]),
                        "feelslike_c": float(h["feelslike_c"]),
                        "chance_of_rain": int(h.get("chance_of_rain") or 0),
                        "chance_of_snow": int(h.get("chance_of_snow") or 0),
                        "wind_kph": float(h["wind_kph"]),
                        "condition_text": h["condition"]["text"],
                        "condition_icon": _icon_url(h["condition"].get("icon")),
                    }
                    for h in day["hour"]
                ],
            }
        )
    return {
        "location": {
            "name": loc.get("name"),
            "region": loc.get("region"),
            "country": loc.get("country"),
            "lat": loc.get("lat"),
            "lon": loc.get("lon"),
            "tz_id": loc["tz_id"],
        },
        "days": days,
    }


def fetch_forecast(query: str, days: int | None = None) -> dict[str, Any]:
    """GET /v1/forecast.json, normalized."""
    days = days or get_settings().weather_forecast_days
    raw = _get("forecast.json", {"q": query, "days": days, "aqi": "no", "alerts": "no"})
    return normalize_forecast(raw)


def store_snapshot(db: Session, location: Location, values: dict[str, Any]) -> ForecastSnapshot:
    snapshot = ForecastSnapshot(
        provider=PROVIDER,
        location_id=location.id,
        forecast_days=len(values["days"]),
        values=values,
    )
    db.add(snapshot)
    db.flush()
    return snapshot


def get_forecast(db: Session, location: Location, force_refresh: bool = False) -> ForecastSnapshot:
    """Return the latest snapshot if it is younger than WEATHER_CACHE_TTL_SECONDS, else fetch."""
    settings = get_settings()
    latest = db.scalar(
        select(ForecastSnapshot)
        .where(
            ForecastSnapshot.location_id == location.id,
            ForecastSnapshot.provider == PROVIDER,
            ForecastSnapshot.forecast_days == settings.weather_forecast_days,
        )
        .order_by(ForecastSnapshot.retrieved_at.desc())
        .limit(1)
    )
    ttl = timedelta(seconds=settings.weather_cache_ttl_seconds)
    if latest and not force_refresh and datetime.now(timezone.utc) - as_utc(latest.retrieved_at) < ttl:
        return latest

    log.info("Fetching forecast for location %s", location.id)
    values = fetch_forecast(location.provider_ref, settings.weather_forecast_days)
    snapshot = store_snapshot(db, location, values)
    db.commit()
    return snapshot
