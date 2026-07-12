from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SYMBOL_POINT_COUNT = 12


def _load_mesh(mesh_path: Path) -> dict[str, Any]:
    if not mesh_path.exists():
        raise FileNotFoundError(f"Mesh not found: {mesh_path}")
    try:
        data = json.loads(mesh_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid mesh JSON: {mesh_path}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Mesh JSON must be an object: {mesh_path}")
    return data


def _write_mesh(mesh_path: Path, data: dict[str, Any]) -> None:
    mesh_path.parent.mkdir(parents=True, exist_ok=True)
    mesh_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _normalize_points(raw: list[Any]) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            u = float(entry["u"])
            v = float(entry["v"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= u <= 1 and 0 <= v <= 1):
            continue
        points.append({"u": u, "v": v})
    return points


def read_symbol_points(mesh_path: Path) -> list[dict[str, float]]:
    data = _load_mesh(mesh_path)
    raw = data.get("symbolPoints")
    if not isinstance(raw, list):
        return []
    return _normalize_points(raw)


def symbol_points_complete(mesh_path: Path) -> bool:
    return len(read_symbol_points(mesh_path)) == SYMBOL_POINT_COUNT


def write_symbol_points(mesh_path: Path, points: list[dict[str, float]]) -> None:
    normalized = _normalize_points(points)
    if len(normalized) != SYMBOL_POINT_COUNT:
        raise ValueError(f"Expected {SYMBOL_POINT_COUNT} symbol points, got {len(normalized)}")
    data = _load_mesh(mesh_path)
    data["symbolPoints"] = normalized
    _write_mesh(mesh_path, data)


def clear_symbol_points(mesh_path: Path) -> None:
    if not mesh_path.exists():
        return
    data = _load_mesh(mesh_path)
    if "symbolPoints" not in data:
        return
    del data["symbolPoints"]
    _write_mesh(mesh_path, data)
