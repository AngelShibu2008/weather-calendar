"""Ranker: order eligible windows by predicted preference.

Baseline first (hand-weighted penalties). A LightGBM LambdaRank model trained offline
(backend/training/train_ranker.py) replaces it once a ModelVersion is marked active.
"""

import logging
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ModelVersion
from ..schemas import PreferredConditions
from .candidates import FEATURE_NAMES

log = logging.getLogger(__name__)


class BaselineRanker:
    name = "baseline"
    model_version_id: int | None = None

    def score(self, features: list[dict[str, float]], preferred: PreferredConditions) -> list[float]:
        w_temp, w_rain = preferred.temp_weight, preferred.rain_weight
        w_wind, w_time = preferred.wind_weight, preferred.time_weight
        total = (w_temp + w_rain + w_wind + w_time) or 1.0
        scores = []
        for f in features:
            temp_pen = min(f["ideal_temp_distance_c"] / 10.0, 1.0)
            rain_pen = max(f["rain_chance_max"], f["snow_chance_max"]) / 100.0
            wind_pen = min(f["wind_kph_max"] / 40.0, 1.0)
            time_pen = 0.0 if not f["has_time_preference"] else 1.0 - f["in_preferred_time"]
            penalty = w_temp * temp_pen + w_rain * rain_pen + w_wind * wind_pen + w_time * time_pen
            scores.append(1.0 - penalty / total)
        return scores


class LightGBMRanker:
    name = "lgbm-lambdarank"

    def __init__(self, version: ModelVersion):
        import lightgbm as lgb

        self.model_version_id = version.id
        self.feature_schema: list[str] = list(version.feature_schema)
        self.booster = lgb.Booster(model_file=str(version.artifact_uri))

    def score(self, features: list[dict[str, float]], preferred: PreferredConditions) -> list[float]:
        import numpy as np

        if not features:
            return []
        matrix = np.array(
            [[float(f.get(name, 0.0)) for name in self.feature_schema] for f in features]
        )
        return [float(s) for s in self.booster.predict(matrix)]


_cache: dict[int, LightGBMRanker] = {}


def load_active_ranker(db: Session) -> Any:
    version = db.scalar(
        select(ModelVersion)
        .where(ModelVersion.is_active.is_(True), ModelVersion.name == LightGBMRanker.name)
        .order_by(ModelVersion.created_at.desc())
        .limit(1)
    )
    if version is None or not version.artifact_uri:
        return BaselineRanker()
    if set(version.feature_schema) - set(FEATURE_NAMES):
        log.warning("Model %s uses unknown features; using baseline", version.id)
        return BaselineRanker()
    if version.id not in _cache:
        try:
            if not Path(version.artifact_uri).exists():
                raise FileNotFoundError(version.artifact_uri)
            _cache[version.id] = LightGBMRanker(version)
        except Exception:  # missing file, lightgbm not installed, corrupt model…
            log.exception("Could not load ranker %s; using baseline", version.id)
            return BaselineRanker()
    return _cache[version.id]
