# -*- coding: utf-8 -*-
"""Himawari v15 在线 scorer：用 west-b70 生产模型重排西部候选。

接入约定：
- 输入：process-himawari-fire 产出的 fire dict 列表
- 西部（lon < west_lon_max）：模型打分，按 budget 截断 TopK
- 非西部：保留物理规则分
- 中文路径模型用 model_str 加载，避免 booster.save/load 路径问题
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except Exception:  # noqa: BLE001
    lgb = None

STAR_SUBLON = 140.7
DEFAULT_GRID_DEG = 0.05
DEFAULT_TEMP_LAGS = (-6, -3, -2, -1, 1, 2, 3)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_production_bundle(model_path: Path, model_card_path: Path | None = None) -> dict[str, Any]:
    if lgb is None:
        raise RuntimeError("缺少 lightgbm，无法加载 v15 在线模型")
    if not model_path.exists():
        raise FileNotFoundError(f"生产模型不存在: {model_path}")
    booster = lgb.Booster(model_str=model_path.read_text(encoding="utf-8"))
    feature_columns = list(booster.feature_name() or [])
    card: dict[str, Any] = {}
    if model_card_path and model_card_path.exists():
        card = json.loads(model_card_path.read_text(encoding="utf-8"))
        if not feature_columns:
            feature_columns = list(card.get("featureColumns") or [])
    return {
        "booster": booster,
        "featureColumns": feature_columns,
        "card": card,
        "modelPath": str(model_path),
    }


def _daynight_label(raw: Any, lon: float, acq_time: str) -> str:
    text = str(raw or "").strip().upper()
    if text in {"N", "NIGHT"}:
        return "night"
    if text in {"D", "DAY"}:
        return "day"
    if text in {"T", "TWILIGHT"}:
        return "twilight"
    try:
        ts = pd.Timestamp(acq_time)
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        solar_hour = (ts.hour + ts.minute / 60.0 + float(lon) / 15.0) % 24.0
        if 6.0 <= solar_hour < 18.0:
            return "day"
        if (5.0 <= solar_hour < 6.0) or (18.0 <= solar_hour < 19.0):
            return "twilight"
        return "night"
    except Exception:  # noqa: BLE001
        return "night"


def _region_of(lon: float, lat: float) -> str:
    # 与训练侧粗分区保持一致的近似
    if lon < 105.0:
        return "west"
    if lon < 115.0:
        return "central"
    return "east"


def fires_to_candidate_frame(fires: list[dict[str, Any]]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for idx, fire in enumerate(fires):
        lon = float(fire.get("lon") or fire.get("center_lon") or 0.0)
        lat = float(fire.get("lat") or fire.get("center_lat") or 0.0)
        acq = str(fire.get("acqTimeUtc") or fire.get("utc") or "")
        bt07 = float(fire.get("btTir") if fire.get("btTir") is not None else fire.get("max_bt07_k") or 0.0)
        t713 = float(fire.get("btDif") if fire.get("btDif") is not None else fire.get("max_t713_k") or 0.0)
        area = float(fire.get("area_pixels") or fire.get("pixelCount") or 1.0)
        scene_id = str(fire.get("sceneId") or "")
        # scene_slot: YYYYMMDDHHMM
        slot = ""
        try:
            ts = pd.Timestamp(acq)
            if ts.tzinfo is None:
                ts = ts.tz_localize("UTC")
            slot = ts.strftime("%Y%m%d%H%M")
        except Exception:  # noqa: BLE001
            slot = scene_id[-12:] if len(scene_id) >= 12 else scene_id
        rows.append(
            {
                "fire_index": idx,
                "candidate_id": f"online-{idx}",
                "utc": acq,
                "scene_slot": slot,
                "center_lon": lon,
                "center_lat": lat,
                "peak_lon": lon,
                "peak_lat": lat,
                "bbox_lon_min": lon,
                "bbox_lon_max": lon,
                "bbox_lat_min": lat,
                "bbox_lat_max": lat,
                "area_pixels": max(area, 1.0),
                "max_bt07_k": bt07,
                "max_t713_k": t713,
                "daynight": _daynight_label(fire.get("daynight"), lon, acq),
                "region": _region_of(lon, lat),
                "physics_score": float(fire.get("score") or 0.0),
            }
        )
    return pd.DataFrame(rows)


def build_base_features(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    out = frame.copy()
    out["utc"] = pd.to_datetime(out["utc"], utc=True, errors="coerce")
    month = out["utc"].dt.month.fillna(1).astype(float)
    hour = out["utc"].dt.hour.fillna(0).astype(float)
    minute = out["utc"].dt.minute.fillna(0).astype(float)
    out["month_sin"] = np.sin(2 * np.pi * month / 12.0)
    out["month_cos"] = np.cos(2 * np.pi * month / 12.0)
    hour_local = (hour + minute / 60.0 + out["center_lon"].astype(float) / 15.0) % 24.0
    out["hour_sin"] = np.sin(2 * np.pi * hour_local / 24.0)
    out["hour_cos"] = np.cos(2 * np.pi * hour_local / 24.0)

    lat = out["center_lat"].to_numpy(dtype=np.float64)
    lon = out["center_lon"].to_numpy(dtype=np.float64)
    phi = np.radians(lat)
    cos_d = np.sin(phi) * np.sin(0.0) + np.cos(phi) * np.cos(0.0) * np.cos(np.radians(lon - STAR_SUBLON))
    out["distance_star_km"] = 6371.0088 * np.arccos(np.clip(cos_d, -1.0, 1.0))
    out["lon_span_deg"] = (out["bbox_lon_max"] - out["bbox_lon_min"]).astype(float)
    out["lat_span_deg"] = (out["bbox_lat_max"] - out["bbox_lat_min"]).astype(float)
    peak_lat = out["peak_lat"].to_numpy(dtype=np.float64)
    peak_lon = out["peak_lon"].to_numpy(dtype=np.float64)
    cos_peak = (
        np.sin(phi) * np.sin(np.radians(peak_lat))
        + np.cos(phi) * np.cos(np.radians(peak_lat)) * np.cos(np.radians(lon - peak_lon))
    )
    out["peak_offset_km"] = 6371.0088 * np.arccos(np.clip(cos_peak, -1.0, 1.0))
    out["bt07_level"] = out["max_bt07_k"].astype(float)
    out["bt07_sq"] = out["max_bt07_k"].astype(float) ** 2
    out["t713_strength"] = out["max_t713_k"].astype(float).clip(lower=0.0)
    out["bt07_x_t713"] = out["max_bt07_k"].astype(float) * out["max_t713_k"].astype(float)
    out["aspect_ratio"] = out["lon_span_deg"] / out["lat_span_deg"].clip(lower=1e-6)
    out["area_sq"] = out["area_pixels"].astype(float) ** 2
    out["peak_offset_ratio"] = out["peak_offset_km"] / (out["area_pixels"].astype(float).clip(lower=1) * 2.0)
    for value in ("day", "twilight", "night"):
        out[f"dn_{value}"] = (out["daynight"] == value).astype(np.float32)
    for value in ("east", "central", "west"):
        out[f"region_{value}"] = (out["region"] == value).astype(np.float32)
    feature_columns = [
        "max_bt07_k", "max_t713_k", "area_pixels", "lon_span_deg", "lat_span_deg",
        "peak_offset_km", "distance_star_km", "month_sin", "month_cos",
        "hour_sin", "hour_cos", "center_lon", "center_lat",
        "bt07_level", "bt07_sq", "t713_strength", "bt07_x_t713",
        "aspect_ratio", "area_sq", "peak_offset_ratio",
        "dn_day", "dn_twilight", "dn_night",
        "region_east", "region_central", "region_west",
    ]
    return out, feature_columns


def _urban_industrial_suppress(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """中东部城市/工业热源抑制掩码（与训练侧一致）。"""
    return (
        ((lon >= 114.0) & (lon <= 120.5) & (lat >= 36.0) & (lat <= 41.5))
        | ((lon >= 118.0) & (lon <= 122.5) & (lat >= 29.5) & (lat <= 33.0))
        | ((lon >= 112.5) & (lon <= 115.5) & (lat >= 22.0) & (lat <= 24.5))
        | ((lon >= 103.5) & (lon <= 107.5) & (lat >= 28.5) & (lat <= 32.0))
        | ((lon >= 112.0) & (lon <= 115.0) & (lat >= 27.5) & (lat <= 31.0))
    ).astype(np.float32)


def add_mideast_special_features(df: pd.DataFrame) -> pd.DataFrame:
    """中东部专模的额外特征：urban_industrial_suppress / east_day_risk。

    与训练侧 add_scene_rank_features（mideast phaseb）定义一致，供中东部模型使用。
    """
    out = df.copy()
    if "center_lon" not in out.columns or "center_lat" not in out.columns:
        return out
    lon = out["center_lon"].to_numpy(dtype=float)
    lat = out["center_lat"].to_numpy(dtype=float)
    out["urban_industrial_suppress"] = _urban_industrial_suppress(lon, lat)
    east_flag = out["region_east"].to_numpy(dtype=np.float32) if "region_east" in out.columns else (lon >= 115.0).astype(np.float32)
    day_flag = out["dn_day"].to_numpy(dtype=np.float32) if "dn_day" in out.columns else np.zeros(len(out), dtype=np.float32)
    out["east_day_risk"] = (east_flag * day_flag * out["urban_industrial_suppress"].to_numpy(dtype=np.float32)).astype(np.float32)
    for c in ("urban_industrial_suppress", "east_day_risk"):
        out[c] = out[c].replace([np.inf, -np.inf], np.nan).fillna(0.0).astype(np.float32)
    return out


def add_scene_rank_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "scene_slot" not in out.columns or len(out) == 0:
        return out
    g = out.groupby("scene_slot", sort=False)
    out["bt07_to_scene_max"] = out["max_bt07_k"] / g["max_bt07_k"].transform("max").clip(lower=1e-3)
    out["bt07_minus_scene_mean"] = out["max_bt07_k"] - g["max_bt07_k"].transform("mean")
    out["bt07_scene_rank_pct"] = g["max_bt07_k"].rank(method="average", pct=True)
    out["t713_to_scene_max"] = out["max_t713_k"] / g["max_t713_k"].transform("max").clip(lower=1e-3)
    out["t713_scene_rank_pct"] = g["max_t713_k"].rank(method="average", pct=True)
    out["area_scene_rank_pct"] = g["area_pixels"].rank(method="average", pct=True)
    out["scene_candidate_count_log"] = np.log1p(g["candidate_id"].transform("count").astype(np.float32))
    out["scene_peak_x_t713"] = out["bt07_to_scene_max"] * out["t713_to_scene_max"]
    out["thermal_rank_fuse"] = (0.7 * out["bt07_scene_rank_pct"] + 0.3 * out["t713_scene_rank_pct"]).astype(np.float32)
    lon = out["center_lon"].to_numpy(dtype=float)
    lat = out["center_lat"].to_numpy(dtype=float)
    out["desert_suppress"] = (
        ((lon > 76.8) & (lon < 88.5) & (lat > 36.0) & (lat < 42.5))
        | ((lon > 99.0) & (lon < 105.0) & (lat > 37.0) & (lat < 42.0))
    ).astype(np.float32)
    out["urban_industrial_suppress"] = _urban_industrial_suppress(lon, lat)
    east_flag = out["region_east"].to_numpy(dtype=np.float32) if "region_east" in out.columns else (lon >= 115.0).astype(np.float32)
    day_flag = out["dn_day"].to_numpy(dtype=np.float32) if "dn_day" in out.columns else np.zeros(len(out), dtype=np.float32)
    out["east_day_risk"] = (east_flag * day_flag * out["urban_industrial_suppress"].to_numpy(dtype=np.float32)).astype(np.float32)
    for c in [
        "bt07_to_scene_max", "bt07_minus_scene_mean", "bt07_scene_rank_pct",
        "t713_to_scene_max", "t713_scene_rank_pct", "area_scene_rank_pct",
        "scene_candidate_count_log", "scene_peak_x_t713", "thermal_rank_fuse", "desert_suppress",
        "urban_industrial_suppress", "east_day_risk",
    ]:
        out[c] = out[c].replace([np.inf, -np.inf], np.nan).fillna(0.0).astype(np.float32)
    return out


def _slot_ord_from_scene_slot(scene_slot: pd.Series) -> np.ndarray:
    ts = pd.to_datetime(scene_slot.astype(str), format="%Y%m%d%H%M", errors="coerce")
    base = pd.Timestamp("2000-01-01")
    minutes = (ts - base).dt.total_seconds() / 60.0
    vals = np.asarray(minutes / 10.0, dtype=np.float64)
    return np.where(np.isfinite(vals), vals, -1).astype(np.int32)


def update_online_temporal_state(
    state_path: Path,
    frame: pd.DataFrame,
    grid_deg: float = DEFAULT_GRID_DEG,
    keep_slots: int = 400,
) -> pd.DataFrame:
    """把当前场景聚合进滚动网格时序缓存，返回最新 grid_agg。"""
    if len(frame) == 0:
        if state_path.exists():
            return pd.read_parquet(state_path)
        return pd.DataFrame(columns=["glon", "glat", "slot_ord", "max_bt07_k", "max_t713_k", "n_cand", "max_area"])

    cur = frame.copy()
    cur["glon"] = np.floor(cur["center_lon"].to_numpy(dtype=np.float64) / grid_deg).astype(np.int32)
    cur["glat"] = np.floor(cur["center_lat"].to_numpy(dtype=np.float64) / grid_deg).astype(np.int32)
    cur["slot_ord"] = _slot_ord_from_scene_slot(cur["scene_slot"])
    agg = (
        cur.groupby(["glon", "glat", "slot_ord"], sort=False)
        .agg(
            max_bt07_k=("max_bt07_k", "max"),
            max_t713_k=("max_t713_k", "max"),
            n_cand=("candidate_id", "count"),
            max_area=("area_pixels", "max"),
        )
        .reset_index()
    )
    if state_path.exists():
        try:
            old = pd.read_parquet(state_path)
            all_df = pd.concat([old, agg], ignore_index=True)
        except Exception:  # noqa: BLE001
            all_df = agg
    else:
        all_df = agg
    all_df = (
        all_df.groupby(["glon", "glat", "slot_ord"], sort=False)
        .agg(
            max_bt07_k=("max_bt07_k", "max"),
            max_t713_k=("max_t713_k", "max"),
            n_cand=("n_cand", "sum"),
            max_area=("max_area", "max"),
        )
        .reset_index()
    )
    # 只保留最近 keep_slots 个时次，控体积
    if all_df["slot_ord"].nunique() > keep_slots:
        keep = set(sorted(all_df["slot_ord"].unique())[-keep_slots:])
        all_df = all_df[all_df["slot_ord"].isin(keep)].copy()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    all_df.to_parquet(state_path, index=False)
    return all_df


def add_grid_temporal_features(
    df: pd.DataFrame,
    grid_agg: pd.DataFrame,
    grid_deg: float = DEFAULT_GRID_DEG,
    lags: tuple[int, ...] = DEFAULT_TEMP_LAGS,
) -> pd.DataFrame:
    out = df.copy()
    if grid_agg is None or len(grid_agg) == 0 or "center_lon" not in out.columns:
        return out
    out["glon"] = np.floor(out["center_lon"].to_numpy(dtype=np.float64) / grid_deg).astype(np.int32)
    out["glat"] = np.floor(out["center_lat"].to_numpy(dtype=np.float64) / grid_deg).astype(np.int32)
    out["slot_ord"] = _slot_ord_from_scene_slot(out["scene_slot"])
    gbase = grid_agg[["glon", "glat", "slot_ord", "max_bt07_k", "max_t713_k", "n_cand", "max_area"]].copy()
    persist_cols: list[str] = []
    past_bt: list[str] = []
    for lag in lags:
        tag = f"m{-lag}" if lag < 0 else f"p{lag}"
        right = gbase.rename(
            columns={
                "max_bt07_k": f"temp_bt07_{tag}",
                "max_t713_k": f"temp_t713_{tag}",
                "n_cand": f"temp_n_{tag}",
                "max_area": f"temp_area_{tag}",
            }
        ).copy()
        right["slot_ord"] = right["slot_ord"] - int(lag)
        use_cols = ["glon", "glat", "slot_ord", f"temp_bt07_{tag}", f"temp_t713_{tag}", f"temp_n_{tag}", f"temp_area_{tag}"]
        out = out.merge(right[use_cols], on=["glon", "glat", "slot_ord"], how="left")
        for c in (f"temp_bt07_{tag}", f"temp_t713_{tag}", f"temp_n_{tag}", f"temp_area_{tag}"):
            out[c] = out[c].fillna(0.0).astype(np.float32)
        flag = f"temp_hit_{tag}"
        out[flag] = (out[f"temp_n_{tag}"] > 0).astype(np.float32)
        persist_cols.append(flag)
        if lag < 0:
            past_bt.append(f"temp_bt07_{tag}")
        if lag == -1:
            out["temp_bt07_delta_m1"] = (out["max_bt07_k"].astype(np.float32) - out[f"temp_bt07_{tag}"]).astype(np.float32)
            out["temp_t713_delta_m1"] = (out["max_t713_k"].astype(np.float32) - out[f"temp_t713_{tag}"]).astype(np.float32)
    out["temp_persist_3"] = out[[c for c in persist_cols if c.endswith(("_m1", "_m2", "_m3"))]].sum(axis=1).astype(np.float32)
    out["temp_persist_all"] = out[persist_cols].sum(axis=1).astype(np.float32)
    if past_bt:
        out["temp_bt07_past_max"] = out[past_bt].max(axis=1).astype(np.float32)
        out["temp_bt07_vs_past_max"] = (
            out["max_bt07_k"].astype(np.float32) / out["temp_bt07_past_max"].clip(lower=1e-3)
        ).astype(np.float32)
    out["temp_hot_persist"] = (
        out["temp_persist_3"] * np.log1p(out["max_bt07_k"].clip(lower=0)) * np.log1p(out["max_t713_k"].clip(lower=0))
    ).astype(np.float32)
    # 3x3 邻域上一时次
    neigh_bt = []
    neigh_n = []
    for dlon in (-1, 0, 1):
        for dlat in (-1, 0, 1):
            right = gbase.rename(columns={"max_bt07_k": "nb_bt07", "n_cand": "nb_n"}).copy()
            right["glon"] = right["glon"] - dlon
            right["glat"] = right["glat"] - dlat
            right["slot_ord"] = right["slot_ord"] + 1
            tmp = out[["glon", "glat", "slot_ord"]].merge(
                right[["glon", "glat", "slot_ord", "nb_bt07", "nb_n"]],
                on=["glon", "glat", "slot_ord"],
                how="left",
            )
            neigh_bt.append(tmp["nb_bt07"].fillna(0.0).to_numpy(dtype=np.float32))
            neigh_n.append(tmp["nb_n"].fillna(0.0).to_numpy(dtype=np.float32))
    out["temp_nb_bt07_m1"] = np.maximum.reduce(neigh_bt)
    out["temp_nb_n_m1"] = np.maximum.reduce(neigh_n)
    out["temp_nb_hit_m1"] = (out["temp_nb_n_m1"] > 0).astype(np.float32)
    out = out.drop(columns=["glon", "glat", "slot_ord"], errors="ignore")
    return out


def classify_model_confidence(prob: float, high: float = 0.65, medium: float = 0.35) -> str:
    if prob >= high:
        return "high"
    if prob >= medium:
        return "medium"
    return "low"


def apply_v15_west_scorer(
    fires: list[dict[str, Any]],
    config: dict[str, Any],
    project_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """对火点列表应用西部 v15 模型；返回新列表与摘要。"""
    scorer_cfg = dict(config.get("v15Scorer") or {})
    if not bool(scorer_cfg.get("enabled", True)):
        return fires, {"enabled": False, "message": "v15Scorer disabled"}

    model_path = project_root / str(scorer_cfg.get("modelPath", "models/himawari-fire-recognition-production/candidate_classifier.txt"))
    card_path = project_root / str(scorer_cfg.get("modelCardPath", "models/himawari-fire-recognition-production/model-card.json"))
    temporal_path = project_root / str(
        scorer_cfg.get("temporalStatePath", "data-store/algorithm-state/himawari-v15-online-grid-temporal.parquet")
    )
    west_lon_max = float(scorer_cfg.get("westLonMax", 105.0))
    west_budget = int(scorer_cfg.get("westBudget", 50))
    apply_non_west = bool(scorer_cfg.get("applyToNonWest", False))
    score_scale = float(scorer_cfg.get("scoreScale", 10.0))
    conf_high = float(scorer_cfg.get("confidenceHighProb", 0.65))
    conf_medium = float(scorer_cfg.get("confidenceMediumProb", 0.35))
    rescue_min_probability = float(scorer_cfg.get("rescueMinProbability", conf_medium))
    grid_deg = float(scorer_cfg.get("gridDeg", DEFAULT_GRID_DEG))
    keep_slots = int(scorer_cfg.get("temporalKeepSlots", 400))

    # 中东部专模（PhaseB）：lon>=west_lon_max 走该模型而非物理规则
    mideast_cfg_path = scorer_cfg.get("mideastModelPath")
    mideast_card_path = scorer_cfg.get("mideastModelCardPath")
    mideast_budget = int(scorer_cfg.get("mideastBudget", west_budget))
    mideast_enabled = bool(scorer_cfg.get("mideastEnabled", False)) and bool(mideast_cfg_path)
    mideast_bundle: dict[str, Any] | None = None
    mideast_feature_columns: list[str] = []
    if mideast_enabled:
        me_path = project_root / str(mideast_cfg_path)
        me_card = project_root / str(mideast_card_path) if mideast_card_path else None
        if me_path.exists():
            try:
                mideast_bundle = load_production_bundle(me_path, me_card if (me_card and me_card.exists()) else None)
                mideast_feature_columns = list(mideast_bundle.get("featureColumns") or [])
            except Exception as exc:  # noqa: BLE001
                mideast_enabled = False
                mideast_bundle = None
                print(f"[v15Scorer] mideast model load failed, fallback physics-rule: {exc}")

    if not fires:
        return fires, {"enabled": True, "scoredCount": 0, "westCount": 0, "keptWest": 0,
                       "mideastEnabled": mideast_enabled}

    bundle = load_production_bundle(model_path, card_path if card_path.exists() else None)
    booster = bundle["booster"]
    feature_columns = list(bundle["featureColumns"] or [])

    frame = fires_to_candidate_frame(fires)
    frame, _ = build_base_features(frame)
    frame = add_scene_rank_features(frame)
    grid_agg = update_online_temporal_state(temporal_path, frame, grid_deg=grid_deg, keep_slots=keep_slots)
    frame = add_grid_temporal_features(frame, grid_agg, grid_deg=grid_deg)
    # 中东部专模依赖 urban_industrial_suppress / east_day_risk（add_scene_rank_features 已构建）

    for col in feature_columns:
        if col not in frame.columns:
            frame[col] = 0.0
        frame[col] = pd.to_numeric(frame[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)

    probs = booster.predict(frame[feature_columns].to_numpy(dtype=np.float32))
    frame["model_prob"] = np.asarray(probs, dtype=np.float64)

    # 中东部模型打分（若启用）
    if mideast_enabled and mideast_bundle is not None:
        me_booster = mideast_bundle["booster"]
        for col in mideast_feature_columns:
            if col not in frame.columns:
                frame[col] = 0.0
            frame[col] = pd.to_numeric(frame[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
        me_probs = me_booster.predict(frame[mideast_feature_columns].to_numpy(dtype=np.float32))
        frame["mideast_prob"] = np.asarray(me_probs, dtype=np.float64)
    else:
        frame["mideast_prob"] = np.nan

    out_fires: list[dict[str, Any]] = []
    west_idx = []
    mideast_idx = []
    for i, fire in enumerate(fires):
        row = frame.iloc[i]
        lon = float(row["center_lon"])
        is_west = lon < west_lon_max
        is_mideast = (not is_west) and mideast_enabled and mideast_bundle is not None
        item = dict(fire)
        diagnostics = dict(item.get("diagnostics") or {})
        diagnostics["physicsScore"] = float(item.get("score") or 0.0)
        diagnostics["v15Scorer"] = "west-b70-production"
        diagnostics["v15ModelPath"] = bundle["modelPath"]
        diagnostics["regionForScorer"] = "west" if is_west else ("mideast" if is_mideast else "non-west")

        if is_west:
            prob = float(row["model_prob"])
            diagnostics["v15ModelProb"] = round(prob, 6)
            item["score"] = round(prob * score_scale, 4)
            item["confidence"] = classify_model_confidence(prob, conf_high, conf_medium)
            diagnostics["scoreSource"] = "v15-west-b70"
            west_idx.append(len(out_fires))
        elif is_mideast:
            prob = float(row["mideast_prob"])
            diagnostics["v15ModelProb"] = round(prob, 6)
            diagnostics["v15Scorer"] = "mideast-phaseb-production"
            diagnostics["v15ModelPath"] = mideast_bundle["modelPath"]
            item["score"] = round(prob * score_scale, 4)
            item["confidence"] = classify_model_confidence(prob, conf_high, conf_medium)
            diagnostics["scoreSource"] = "v15-mideast-phaseb"
            mideast_idx.append(len(out_fires))
        elif apply_non_west:
            prob = float(row["model_prob"])
            diagnostics["v15ModelProb"] = round(prob, 6)
            item["score"] = round(prob * score_scale, 4)
            item["confidence"] = classify_model_confidence(prob, conf_high, conf_medium)
            diagnostics["scoreSource"] = "v15-west-b70"
        else:
            diagnostics["scoreSource"] = "physics-rule"
        item["diagnostics"] = diagnostics
        # 官方确认火点永不因 budget 丢弃
        item["_keep_forced"] = bool(diagnostics.get("officialConfirmed"))
        item["_drop_rescue"] = bool(
            diagnostics.get("candidateTier") == "model-rescue"
            and not item["_keep_forced"]
            and float(diagnostics.get("v15ModelProb") or 0.0) < rescue_min_probability
        )
        out_fires.append(item)

    def _apply_budget(idx_list: list[int], budget: int) -> tuple[int, int]:
        """对指定索引列表做 TopK budget 截断；返回 (kept, dropped)。"""
        if budget <= 0 or len(idx_list) <= budget:
            return len(idx_list), 0
        ranked = sorted(
            idx_list,
            key=lambda j: (
                1 if out_fires[j].get("_keep_forced") else 0,
                float(out_fires[j].get("score") or 0.0),
            ),
            reverse=True,
        )
        keep_set = set(ranked[:budget])
        for j in idx_list:
            if out_fires[j].get("_keep_forced"):
                keep_set.add(j)
        return len(keep_set), len(idx_list) - len(keep_set)

    eligible_west_idx = [index for index in west_idx if not out_fires[index].get("_drop_rescue")]
    eligible_mideast_idx = [index for index in mideast_idx if not out_fires[index].get("_drop_rescue")]
    kept_west = len(eligible_west_idx)
    dropped_west = 0
    kept_mideast = len(eligible_mideast_idx)
    dropped_mideast = 0
    if west_budget > 0 and len(eligible_west_idx) > west_budget:
        kept_west, dropped_west = _apply_budget(eligible_west_idx, west_budget)
    if mideast_enabled and mideast_budget > 0 and len(eligible_mideast_idx) > mideast_budget:
        kept_mideast, dropped_mideast = _apply_budget(eligible_mideast_idx, mideast_budget)

    # 合并保留集：西部 keep + 中东部 keep + 非西部非中东部（物理规则，全保留）
    west_keep: set[int] = set()
    if west_budget > 0 and len(eligible_west_idx) > west_budget:
        ranked = sorted(
            eligible_west_idx,
            key=lambda j: (1 if out_fires[j].get("_keep_forced") else 0, float(out_fires[j].get("score") or 0.0)),
            reverse=True,
        )
        west_keep = set(ranked[:west_budget])
        for j in west_idx:
            if out_fires[j].get("_keep_forced"):
                west_keep.add(j)
    else:
        west_keep = set(eligible_west_idx)

    mideast_keep: set[int] = set()
    if mideast_enabled:
        if mideast_budget > 0 and len(eligible_mideast_idx) > mideast_budget:
            ranked = sorted(
                eligible_mideast_idx,
                key=lambda j: (1 if out_fires[j].get("_keep_forced") else 0, float(out_fires[j].get("score") or 0.0)),
                reverse=True,
            )
            mideast_keep = set(ranked[:mideast_budget])
            for j in mideast_idx:
                if out_fires[j].get("_keep_forced"):
                    mideast_keep.add(j)
        else:
            mideast_keep = set(eligible_mideast_idx)

    rescue_dropped_by_probability = sum(1 for item in out_fires if item.get("_drop_rescue"))
    new_list: list[dict[str, Any]] = []
    for j, item in enumerate(out_fires):
        lon = float(item.get("lon") or 0.0)
        is_west = lon < west_lon_max
        is_mideast_item = (not is_west) and mideast_enabled
        if is_west and j not in west_keep:
            continue
        if is_mideast_item and j not in mideast_keep:
            continue
        if item.get("_drop_rescue"):
            continue
        new_list.append(item)
    out_fires = new_list
    kept_west = sum(1 for f in out_fires if float(f.get("lon") or 0.0) < west_lon_max)
    kept_mideast = sum(1 for f in out_fires if float(f.get("lon") or 0.0) >= west_lon_max) if mideast_enabled else 0
    rescue_input_count = sum(
        1 for item in fires
        if (item.get("diagnostics") or {}).get("candidateTier") == "model-rescue"
    )

    for item in out_fires:
        item.pop("_keep_forced", None)
        item.pop("_drop_rescue", None)

    # 最终按分数排序，稳定输出
    out_fires = sorted(
        out_fires,
        key=lambda f: (float(f.get("score") or 0.0), float(f.get("lat") or 0.0), float(f.get("lon") or 0.0)),
        reverse=True,
    )

    summary = {
        "enabled": True,
        "generatedAt": _utc_now_iso(),
        "modelPath": bundle["modelPath"],
        "modelCard": {
            "sourceExperiment": (bundle.get("card") or {}).get("sourceExperiment"),
            "fold": (bundle.get("card") or {}).get("fold"),
            "seed": (bundle.get("card") or {}).get("seed"),
            "eventRecallAtBudget50": (bundle.get("card") or {}).get("eventRecallAtBudget50"),
        },
        "mideastEnabled": mideast_enabled,
        "mideastModelPath": (mideast_bundle or {}).get("modelPath") if mideast_enabled else None,
        "mideastModelCard": {
            "sourceExperiment": (mideast_bundle or {}).get("card", {}).get("sourceExperiment") if mideast_enabled else None,
            "fold": (mideast_bundle or {}).get("card", {}).get("fold") if mideast_enabled else None,
            "seed": (mideast_bundle or {}).get("card", {}).get("seed") if mideast_enabled else None,
            "eventRecallAtBudget50": (mideast_bundle or {}).get("card", {}).get("eventRecallAtBudget50") if mideast_enabled else None,
        } if mideast_enabled else None,
        "featureCount": len(feature_columns),
        "mideastFeatureCount": len(mideast_feature_columns) if mideast_enabled else 0,
        "inputCount": len(fires),
        "outputCount": len(out_fires),
        "westInputCount": int((frame["center_lon"] < west_lon_max).sum()),
        "westKeptCount": kept_west,
        "westDroppedByBudget": dropped_west,
        "westBudget": west_budget,
        "mideastInputCount": int((frame["center_lon"] >= west_lon_max).sum()) if mideast_enabled else 0,
        "mideastKeptCount": kept_mideast,
        "mideastDroppedByBudget": dropped_mideast,
        "mideastBudget": mideast_budget if mideast_enabled else 0,
        "modelRescueInputCount": rescue_input_count,
        "modelRescueDroppedByProbability": rescue_dropped_by_probability,
        "rescueMinProbability": rescue_min_probability,
        "westLonMax": west_lon_max,
        "scoreScale": score_scale,
        "temporalStatePath": str(temporal_path),
        "temporalRows": int(len(grid_agg)),
    }
    return out_fires, summary
