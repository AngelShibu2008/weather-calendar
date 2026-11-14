"""Settings loaded from environment variables and backend/.env."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Weather: WeatherAPI.com
    weatherapi_key: str = ""
    weatherapi_base_url: str = "https://api.weatherapi.com/v1"
    weather_forecast_days: int = Field(3, ge=1, le=14)
    weather_cache_ttl_seconds: int = Field(3600, ge=0)
    weather_timeout_seconds: float = 10.0

    # Gemini: explanations (optional)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_timeout_seconds: float = 20.0

    # App
    database_url: str = f"sqlite:///{BACKEND_DIR / 'fieldday.db'}"
    cors_origins: str = "http://localhost:8443,http://localhost:5173"
    cors_origin_regex: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"  # any local dev port
    candidate_step_minutes: int = Field(30, ge=5)
    optimizer_time_limit_seconds: float = 5.0
    model_dir: Path = BACKEND_DIR / "model_artifacts"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def gemini_enabled(self) -> bool:
        return bool(self.gemini_api_key.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
