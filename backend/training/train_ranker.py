"""Offline training: fit a LightGBM LambdaRank ranker and compare it with the baseline.

    python -m backend.training.train_ranker            # train, evaluate, activate if better
    python -m backend.training.train_ranker --no-activate

Each plan is one ranking group (query). Labels per candidate:
  * explicit feedback rating (0–4), latest wins
  * otherwise, for accepted plans: 2 if it was a selected session, 0 if it was eligible but not picked
"""

import argparse
import random
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select

from ..config import get_settings
from ..db import SessionLocal, init_db
from ..models import Candidate, Feedback, ModelVersion, Plan
from ..schemas import PreferredConditions
from ..services.candidates import FEATURE_NAMES
from ..services.ranker import BaselineRanker, LightGBMRanker


def ndcg_at_k(labels: list[float], scores: list[float], k: int) -> float:
    order = np.argsort(scores)[::-1][:k]
    gains = (2.0 ** np.asarray(labels)[order] - 1) / np.log2(np.arange(2, len(order) + 2))
    ideal = sorted(labels, reverse=True)[:k]
    ideal_gains = (2.0 ** np.asarray(ideal) - 1) / np.log2(np.arange(2, len(ideal) + 2))
    return float(gains.sum() / ideal_gains.sum()) if ideal_gains.sum() > 0 else 0.0


def load_groups(db) -> list[tuple[list[dict], list[float]]]:
    explicit: dict[int, int] = {}
    for fb in db.scalars(select(Feedback).order_by(Feedback.created_at)):
        explicit[fb.candidate_id] = fb.rating

    groups = []
    for plan in db.scalars(select(Plan)):
        selected = {s.candidate_id for s in plan.sessions}
        feats, labels = [], []
        for c in plan.candidates:
            if c.id in explicit:
                label = explicit[c.id]
            elif plan.status == "accepted" and (c.eligible or c.id in selected):
                label = 2 if c.id in selected else 0
            else:
                continue
            feats.append(c.features)
            labels.append(float(label))
        if len(feats) >= 2 and len(set(labels)) > 1:  # a group needs something to rank
            groups.append((feats, labels))
    return groups


def to_matrix(groups):
    X = np.array([[float(f.get(n, 0.0)) for n in FEATURE_NAMES] for feats, _ in groups for f in feats])
    y = np.array([l for _, labels in groups for l in labels])
    sizes = [len(labels) for _, labels in groups]
    return X, y, sizes


def mean_ndcg(groups, score_fn, k: int) -> float:
    return float(np.mean([ndcg_at_k(labels, score_fn(feats), k) for feats, labels in groups]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-groups", type=int, default=10)
    parser.add_argument("--k", type=int, default=3)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--no-activate", action="store_true")
    args = parser.parse_args()

    import lightgbm as lgb

    init_db()
    settings = get_settings()
    db = SessionLocal()
    try:
        groups = load_groups(db)
        if len(groups) < args.min_groups:
            print(f"Only {len(groups)} labelled plan groups (need {args.min_groups}). Collect more feedback.")
            return

        random.Random(args.seed).shuffle(groups)
        split = max(1, int(len(groups) * 0.8))
        train, valid = groups[:split], groups[split:] or groups[-1:]

        X_tr, y_tr, g_tr = to_matrix(train)
        X_va, y_va, g_va = to_matrix(valid)
        params = {
            "objective": "lambdarank",
            "metric": "ndcg",
            "eval_at": [args.k],
            "learning_rate": 0.05,
            "num_leaves": 15,
            "min_data_in_leaf": 5,
            "seed": args.seed,
            "verbose": -1,
        }
        train_set = lgb.Dataset(X_tr, y_tr, group=g_tr, feature_name=FEATURE_NAMES)
        valid_set = lgb.Dataset(X_va, y_va, group=g_va, reference=train_set)
        booster = lgb.train(
            params, train_set, num_boost_round=300, valid_sets=[valid_set],
            callbacks=[lgb.early_stopping(30, verbose=False)],
        )

        baseline = BaselineRanker()
        prefs = PreferredConditions()
        base_ndcg = mean_ndcg(valid, lambda feats: baseline.score(feats, prefs), args.k)
        lgbm_ndcg = mean_ndcg(
            valid,
            lambda feats: booster.predict(np.array([[float(f.get(n, 0.0)) for n in FEATURE_NAMES] for f in feats])),
            args.k,
        )
        print(f"NDCG@{args.k}  baseline={base_ndcg:.4f}  lgbm={lgbm_ndcg:.4f}  "
              f"(train groups={len(train)}, valid groups={len(valid)})")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = settings.model_dir / f"ranker_{stamp}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        booster.save_model(str(path))

        activate = not args.no_activate and lgbm_ndcg > base_ndcg
        if activate:
            for mv in db.scalars(select(ModelVersion).where(ModelVersion.is_active.is_(True))):
                mv.is_active = False
        version = ModelVersion(
            name=LightGBMRanker.name,
            artifact_uri=str(path),
            feature_schema=FEATURE_NAMES,
            metrics={
                f"ndcg@{args.k}": lgbm_ndcg,
                f"baseline_ndcg@{args.k}": base_ndcg,
                "train_groups": len(train),
                "valid_groups": len(valid),
                "best_iteration": int(booster.best_iteration or booster.current_iteration()),
            },
            is_active=activate,
        )
        db.add(version)
        db.commit()
        print(f"Saved model_version {version.id} → {path} ({'ACTIVE' if activate else 'inactive'})")
    finally:
        db.close()


if __name__ == "__main__":
    main()
