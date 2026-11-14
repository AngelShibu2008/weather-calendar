"""fieldday backend. Run from the repo root:  uvicorn backend.main:app --reload --port 8000"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .db import init_db
from .routes import plans, setup
from .services.weather import WeatherError

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO lines include the API key in the URL
settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="fieldday API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(WeatherError)
def weather_error(_: Request, exc: WeatherError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "weather_configured": bool(settings.weatherapi_key),
        "gemini_configured": settings.gemini_enabled,
        "forecast_days": settings.weather_forecast_days,
    }


app.include_router(setup.router)
app.include_router(plans.router)
