# fieldday backend

A Python FastAPI service that builds weather-aware running schedules. The pipeline is: forecast → candidate windows → ranker → CP-SAT optimizer → explanations.

## Environment variables and API keys

The backend reads its settings from `backend/.env`. That file is git-ignored. `backend/.env.example` is the template you commit.

```bash
cp backend/.env.example backend/.env   # then fill in the keys
```

### Weather (WeatherAPI.com), required

| Variable | Default | Purpose |
|---|---|---|
| `WEATHERAPI_KEY` | — | API key from your [weatherapi.com](https://www.weatherapi.com/) dashboard |
| `WEATHER_FORECAST_DAYS` | `3` | Days of hourly forecast to plan over (the free plan allows up to 3) |
| `WEATHER_CACHE_TTL_SECONDS` | `3600` | How long a stored forecast snapshot is reused before a new fetch |
| `WEATHERAPI_BASE_URL` | `https://api.weatherapi.com/v1` | |
| `WEATHER_TIMEOUT_SECONDS` | `10` | |

The backend calls two endpoints: `GET /v1/search.json` (location search) and `GET /v1/forecast.json` (forecasts).

### Gemini, optional

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(blank)* | Key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | |
| `GEMINI_TIMEOUT_SECONDS` | `20` | |

Gemini only rewrites session explanations into friendlier sentences, using the facts the planner computed. If the key is blank or a call fails, the backend falls back to template explanations, so the app works without Gemini. `GET /api/health` reports which keys are configured.

### App

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | SQLite at `backend/fieldday.db` | Any SQLAlchemy URL, for example Postgres |
| `CORS_ORIGINS` | `http://localhost:8443,http://localhost:5173` | Frontend origins that may call the API |
| `CANDIDATE_STEP_MINUTES` | `30` | Spacing between candidate start times |
| `OPTIMIZER_TIME_LIMIT_SECONDS` | `5` | CP-SAT time budget |

> Keys are only used server-side and are never sent to the browser. The `httpx` logger is set to WARNING because its INFO lines contain request URLs, and the WeatherAPI key is part of those URLs.

## Run

Use **Python 3.10–3.12**. OR-Tools doesn't publish builds for newer versions yet; on Python 3.15, `pip install` fails with `No matching distribution found for ortools`.

```bash
python3 --version   # check first; if it's too new, use e.g. /opt/anaconda3/bin/python3 or `conda create -n fieldday python=3.12`
python3 -m venv backend/.venv && source backend/.venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000     # run from the repo root (or: uvicorn app:app)
```

Interactive API docs are at http://localhost:8000/docs. The tables are created on startup.

**Auth (development placeholder):** send an `X-User-Id` header with any stable string; the user is created on first request. You can also send `X-User-Timezone`. Replace `deps.current_user` with real token verification before deploying.

## Connecting the frontend

The React app calls the backend through [src/api.ts](../src/api.ts). It uses `VITE_API_URL`, which defaults to `http://localhost:8000`. To change it, copy the root `.env.example` to `.env.local` and restart Vite. CORS allows `CORS_ORIGINS`, plus any `localhost` or `127.0.0.1` port through `CORS_ORIGIN_REGEX`. If the preview runs on another host, add that origin to `CORS_ORIGINS`.

| Screen | Backend calls |
|---|---|
| Sign in / sign up | The email becomes `X-User-Id` (dev auth); `GET /api/me` |
| Today | Location search (first run), forecast, accepted plan, generate / refresh |
| Plan | Running goal (`PUT /api/goals/{id}`), commitments are blocked `availability_exceptions` |
| Review | Plan sessions, explanations, alternative times (swap), lock, feedback, accept |
| Weather | `GET /api/locations/{id}/forecast` |
| You | Locations, weather limits & preferences, planning hours (weekly rules), gap between runs |

## API by user-flow step

| Step | Endpoint |
|---|---|
| 1. Search for and select a location | `GET /api/locations/search?q=` → `POST /api/locations {weatherapi_id}` |
| 2. Set availability | `PUT /api/availability/rules` (weekly template), `POST/DELETE /api/availability/exceptions` |
| 3. Running goal | `POST /api/goals {duration_minutes, sessions_per_week, separate_days}` |
| 4. Weather limits and preferences | `PUT /api/locations/{id}/preferences {limits, preferred}` |
| 5. Generate a schedule | `POST /api/plans/generate {location_id, goal_id}` |
| 6. Review forecasts, explanations, alternatives | `GET /api/plans/{id}` (`?include_candidates=true` for every window); `GET /api/locations/{id}/forecast` |
| 7. Accept or edit | `POST /api/plans/{id}/accept`, `PATCH /api/sessions/{id} {candidate_id?, locked?}` |
| 8. Refresh weather and review changes | `POST /api/plans/{id}/refresh` returns a **proposed** new version with `changes`; accept it to apply |
| Feedback (training data) | `POST /api/feedback {candidate_id, rating 0–4, reason}` |

## System design

| Component | File | Notes |
|---|---|---|
| Weather client and cache | `services/weather.py` | Extracts only the fields the planner needs. Each fetch is stored in `forecast_snapshots`, which also serves as the cache |
| Candidate generator | `services/candidates.py` | Builds windows inside availability and daylight, with a feature snapshot for each. Windows that break a limit are kept but marked `eligible=false`, with `violations` listing why |
| Ranker | `services/ranker.py` | The baseline ranker uses weighted penalties. When a `model_versions` row is active, a LightGBM LambdaRank model is used instead |
| Optimizer | `services/optimizer.py` | OR-Tools CP-SAT with these constraints: no overlap (plus the minimum gap), separate days, at most N sessions, locked sessions kept |
| Explanations | `services/explain.py` | Templates, rewritten by Gemini when a key is set |
| Orchestration, refresh diff | `services/planner.py` | |
| Database (all 12 tables) | `models.py` | users, locations, preferences, availability_rules, availability_exceptions, goals, forecast_snapshots, plans, candidates, sessions, feedback, model_versions |

### Offline training

```bash
python -m backend.training.train_ranker   # --min-groups 10 --k 3 --no-activate
```

Each plan becomes one ranking group. Labels come from explicit feedback ratings; for accepted plans, a selected session counts as 2 and an unpicked eligible window as 0. The script trains a LambdaRank model and compares its NDCG@k on held-out plans with the baseline's. It saves the model to `model_artifacts/` and records it in `model_versions`. The new model is activated only if it beats the baseline.
