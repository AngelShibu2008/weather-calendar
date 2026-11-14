"""Candidate generator: activity windows that fit availability, with a weather feature snapshot.

Every window inside availability (and daylight, if required) becomes a candidate. Windows that
break a hard weather limit are kept but marked ineligible, so the UI can explain "why not then".
"""

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from ..schemas import PreferredConditions, WeatherLimits, hhmm_to_minutes

# Order matters: this is the feature schema the learned ranker is trained on.
FEATURE_NAMES: list[str] = [
    "temp_mean_c",
    "feelslike_mean_c",
    "feelslike_min_c",
    "feelslike_max_c",
    "rain_chance_max",
    "snow_chance_max",
    "wind_kph_max",
    "start_hour_local",
    "weekday",
    "days_ahead",
    "minutes_after_sunrise",
    "minutes_before_sunset",
    "ideal_temp_distance_c",
    "in_preferred_time",
    "has_time_preference",
    "duration_minutes",
]

TIME_BUCKETS: dict[str, tuple[int, int]] = {
    "morning": (5 * 60, 11 * 60),
    "midday": (11 * 60, 14 * 60),
    "afternoon": (14 * 60, 17 * 60),
    "evening": (17 * 60, 21 * 60),
}

Interval = tuple[int, int]  # minutes since local midnight


class _IntervalRow(Protocol):
    start_local: str
    end_local: str


@dataclass
class CandidateDraft:
    start_epoch: int
    end_epoch: int
    features: dict[str, float]
    display: dict[str, Any]
    eligible: bool
    violations: list[str] = field(default_factory=list)
    forced: bool = False  # locked by the user; always kept


# ── Interval helpers ───────────────────────────────────────────────────────


def _merge(intervals: list[Interval]) -> list[Interval]:
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _subtract(intervals: list[Interval], cut: Interval) -> list[Interval]:
    out: list[Interval] = []
    for start, end in intervals:
        if cut[1] <= start or cut[0] >= end:
            out.append((start, end))
            continue
        if start < cut[0]:
            out.append((start, cut[0]))
        if cut[1] < end:
            out.append((cut[1], end))
    return out


def _span(row: _IntervalRow) -> Interval:
    return hhmm_to_minutes(row.start_local), hhmm_to_minutes(row.end_local)


def daily_availability(day: date, rules: list[Any], exceptions: list[Any]) -> list[Interval]:
    base = [_span(r) for r in rules if r.weekday == day.weekday()]
    base += [_span(e) for e in exceptions if e.date == day and e.kind == "available"]
    intervals = _merge(base)
    for e in exceptions:
        if e.date == day and e.kind == "blocked":
            intervals = _subtract(intervals, _span(e))
    return intervals


def _astro_minutes(value: str) -> int | None:
    """WeatherAPI gives "06:45 AM"; polar days give "No sunrise" etc."""
    try:
        parsed = datetime.strptime(value.strip(), "%I:%M %p")
    except (ValueError, AttributeError):
        return None
    return parsed.hour * 60 + parsed.minute


def _in_buckets(minute_of_day: int, buckets: list[str]) -> bool:
    return any(TIME_BUCKETS[b][0] <= minute_of_day < TIME_BUCKETS[b][1] for b in buckets)


# ── Window evaluation ──────────────────────────────────────────────────────


def evaluate_window(
    day: dict[str, Any],
    start_epoch: int,
    end_epoch: int,
    tz: ZoneInfo,
    today: date,
    limits: WeatherLimits,
    preferred: PreferredConditions,
) -> CandidateDraft | None:
    """Build features + hard-limit check for one window. None if the forecast doesn't cover it."""
    hours = [
        h
        for h in day["hours"]
        if h["time_epoch"] < end_epoch and h["time_epoch"] + 3600 > start_epoch
    ]
    if not hours:
        return None

    start_local = datetime.fromtimestamp(start_epoch, tz)
    end_local = datetime.fromtimestamp(end_epoch, tz)
    start_min = start_local.hour * 60 + start_local.minute
    end_min = start_min + (end_epoch - start_epoch) // 60
    sunrise = _astro_minutes(day["sunrise"])
    sunset = _astro_minutes(day["sunset"])

    temps = [h["temp_c"] for h in hours]
    feels = [h["feelslike_c"] for h in hours]
    temp_mean = sum(temps) / len(temps)
    feels_mean = sum(feels) / len(feels)
    if feels_mean < preferred.ideal_temp_min_c:
        ideal_distance = preferred.ideal_temp_min_c - feels_mean
    elif feels_mean > preferred.ideal_temp_max_c:
        ideal_distance = feels_mean - preferred.ideal_temp_max_c
    else:
        ideal_distance = 0.0

    features: dict[str, float] = {
        "temp_mean_c": round(temp_mean, 2),
        "feelslike_mean_c": round(feels_mean, 2),
        "feelslike_min_c": min(feels),
        "feelslike_max_c": max(feels),
        "rain_chance_max": max(h["chance_of_rain"] for h in hours),
        "snow_chance_max": max(h["chance_of_snow"] for h in hours),
        "wind_kph_max": max(h["wind_kph"] for h in hours),
        "start_hour_local": round(start_min / 60, 2),
        "weekday": start_local.weekday(),
        "days_ahead": (start_local.date() - today).days,
        "minutes_after_sunrise": start_min - sunrise if sunrise is not None else -1,
        "minutes_before_sunset": sunset - end_min if sunset is not None else -1,
        "ideal_temp_distance_c": round(ideal_distance, 2),
        "in_preferred_time": float(_in_buckets(start_min, preferred.preferred_times)),
        "has_time_preference": float(bool(preferred.preferred_times)),
        "duration_minutes": (end_epoch - start_epoch) / 60,
    }

    violations: list[str] = []
    if features["rain_chance_max"] > limits.max_rain_chance:
        violations.append(f"rain chance {features['rain_chance_max']:.0f}% > {limits.max_rain_chance}%")
    if features["snow_chance_max"] > limits.max_snow_chance:
        violations.append(f"snow chance {features['snow_chance_max']:.0f}% > {limits.max_snow_chance}%")
    if features["wind_kph_max"] > limits.max_wind_kph:
        violations.append(f"wind {features['wind_kph_max']:.0f} kph > {limits.max_wind_kph:.0f} kph")
    if features["feelslike_min_c"] < limits.min_feelslike_c:
        violations.append(f"feels like {features['feelslike_min_c']:.0f}°C < {limits.min_feelslike_c:.0f}°C")
    if features["feelslike_max_c"] > limits.max_feelslike_c:
        violations.append(f"feels like {features['feelslike_max_c']:.0f}°C > {limits.max_feelslike_c:.0f}°C")
    if limits.require_daylight and sunrise is not None and sunset is not None:
        if start_min < sunrise or end_min > sunset:
            violations.append("outside daylight")

    first = hours[0]
    display = {
        "local_date": start_local.date().isoformat(),
        "start_local": start_local.isoformat(),
        "end_local": end_local.isoformat(),
        "condition_text": first["condition_text"],
        "condition_icon": first["condition_icon"],
        "hours": [h["time_epoch"] for h in hours],
    }
    return CandidateDraft(
        start_epoch=start_epoch,
        end_epoch=end_epoch,
        features=features,
        display=display,
        eligible=not violations,
        violations=violations,
    )


def evaluate_epoch_window(
    forecast: dict[str, Any],
    start_epoch: int,
    end_epoch: int,
    limits: WeatherLimits,
    preferred: PreferredConditions,
    now: datetime,
) -> CandidateDraft | None:
    """Evaluate an arbitrary window (used for locked sessions carried into a refreshed plan)."""
    tz = ZoneInfo(forecast["location"]["tz_id"])
    local_day = datetime.fromtimestamp(start_epoch, tz).date().isoformat()
    for day in forecast["days"]:
        if day["date"] == local_day:
            return evaluate_window(
                day, start_epoch, end_epoch, tz, now.astimezone(tz).date(), limits, preferred
            )
    return None


def generate(
    forecast: dict[str, Any],
    rules: list[Any],
    exceptions: list[Any],
    duration_minutes: int,
    limits: WeatherLimits,
    preferred: PreferredConditions,
    step_minutes: int,
    now: datetime,
) -> list[CandidateDraft]:
    tz = ZoneInfo(forecast["location"]["tz_id"])
    today = now.astimezone(tz).date()
    now_epoch = int(now.timestamp())
    drafts: list[CandidateDraft] = []

    for day in forecast["days"]:
        day_date = date.fromisoformat(day["date"])
        intervals = daily_availability(day_date, rules, exceptions)
        sunrise, sunset = _astro_minutes(day["sunrise"]), _astro_minutes(day["sunset"])
        if limits.require_daylight and sunrise is not None and sunset is not None:
            intervals = [(max(s, sunrise), min(e, sunset)) for s, e in intervals]

        midnight = datetime.combine(day_date, time(0), tzinfo=tz)
        for start_min, end_min in intervals:
            minute = -(-start_min // step_minutes) * step_minutes  # snap up to the step grid
            while minute + duration_minutes <= end_min:
                start = midnight + timedelta(minutes=minute)
                start_epoch = int(start.timestamp())
                end_epoch = start_epoch + duration_minutes * 60
                if start_epoch >= now_epoch:
                    draft = evaluate_window(day, start_epoch, end_epoch, tz, today, limits, preferred)
                    if draft:
                        drafts.append(draft)
                minute += step_minutes
    return drafts
