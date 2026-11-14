"""Explanations for selected sessions.

Templates always work. When GEMINI_API_KEY is set, Gemini rewrites the same facts into a
friendlier sentence; any Gemini failure falls back to the templates.
"""

import json
import logging
from datetime import datetime
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)


def session_facts(candidate: Any, eligible_count: int, locked: bool) -> dict[str, Any]:
    f, d = candidate.features, candidate.display
    start = datetime.fromisoformat(d["start_local"])
    end = datetime.fromisoformat(d["end_local"])
    return {
        "when": f"{start:%a %b %-d}, {start:%-I:%M %p}–{end:%-I:%M %p}",
        "condition": d.get("condition_text"),
        "temp_c": round(f["temp_mean_c"]),
        "feels_like_c": round(f["feelslike_mean_c"]),
        "rain_chance_pct": int(f["rain_chance_max"]),
        "snow_chance_pct": int(f["snow_chance_max"]),
        "wind_kph": round(f["wind_kph_max"]),
        "rank": candidate.rank,
        "eligible_windows": eligible_count,
        "in_preferred_time": bool(f["in_preferred_time"]),
        "locked_by_user": locked,
        "limit_violations": list(candidate.violations or []),
    }


def template_explanation(facts: dict[str, Any]) -> str:
    weather = (
        f"{facts['condition']}, {facts['temp_c']}°C (feels {facts['feels_like_c']}°C), "
        f"{facts['rain_chance_pct']}% rain, wind {facts['wind_kph']} kph"
    )
    if facts["locked_by_user"]:
        note = "Kept because you locked it."
        if facts["limit_violations"]:
            note += " Heads up: " + "; ".join(facts["limit_violations"]) + "."
        return f"{weather}. {note}"
    parts = [f"{weather}."]
    if facts["rank"]:
        parts.append(f"Ranked #{facts['rank']} of {facts['eligible_windows']} windows that fit your limits")
    if facts["in_preferred_time"]:
        parts[-1] += " and falls in your preferred time of day"
    return " ".join(parts) + "."


def gemini_json(prompt: str, response_schema: dict[str, Any]) -> Any | None:
    """Call Gemini generateContent with a JSON response schema. None on any failure."""
    settings = get_settings()
    if not settings.gemini_enabled:
        return None
    url = f"{settings.gemini_base_url}/models/{settings.gemini_model}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        },
    }
    try:
        resp = httpx.post(
            url,
            json=body,
            headers={"x-goog-api-key": settings.gemini_api_key},
            timeout=settings.gemini_timeout_seconds,
        )
        resp.raise_for_status()
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except httpx.HTTPStatusError as exc:
        try:
            detail = exc.response.json().get("error", {}).get("message", "")
        except ValueError:
            detail = ""
        log.warning("Gemini returned %s: %s; using templates", exc.response.status_code, detail[:300])
        return None
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        log.warning("Gemini call failed (%s); using templates", type(exc).__name__)
        return None


def explain_sessions(facts: list[dict[str, Any]], activity: str, use_llm: bool = True) -> list[str]:
    templates = [template_explanation(f) for f in facts]
    if not facts or not use_llm:
        return templates
    prompt = (
        f"You write short explanations for a planner that schedules outdoor {activity} sessions "
        "around the weather. For each session below, write one or two sentences (max 35 words) "
        "saying why this time was picked. Use only the facts given and do not invent weather. "
        "If locked_by_user is true, say the user locked it and mention any limit_violations. "
        "Return a JSON array of strings, one per session, in the same order.\n\n"
        + json.dumps(facts, ensure_ascii=False)
    )
    result = gemini_json(prompt, {"type": "ARRAY", "items": {"type": "STRING"}})
    if isinstance(result, list) and len(result) == len(facts) and all(isinstance(s, str) for s in result):
        return [s.strip() or t for s, t in zip(result, templates)]
    return templates
