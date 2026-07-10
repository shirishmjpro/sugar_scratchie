"""Auto-detect the scratchable garment mask for a tracked mesh JSON.

Wraps `scripts/add-garment-mask.py` with dashboard-safe defaults: clothing (+
arms/legs) segmentation, modest dilation, and a coverage cap so full-canvas
fields cannot accidentally mark the entire lattice.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "add-garment-mask.py"

# Dashboard / pipeline defaults — more inclusive than a tight hand paint, but
# never "fill the whole screen" (that happens if MASK_SOURCE=body + heavy dilate
# on a near-fullframe silhouette).
AUTO_MASK_SOURCE = "garment"
AUTO_THRESHOLD = 0.22
AUTO_PIXEL_DILATE = 3
AUTO_GRID_DILATE = 2
AUTO_SAMPLE_FRAMES = 60
AUTO_MAX_COVERAGE = 0.72


def _load_augment_module():
    spec = importlib.util.spec_from_file_location("backend_add_garment_mask", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load garment mask script: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _coverage(garment: list[int]) -> float:
    if not garment:
        return 0.0
    return sum(1 for flag in garment if flag) / len(garment)


def _shrink_to_cap(data: dict[str, Any], max_coverage: float) -> None:
    """If auto-detect covered too much, erode on the lattice until under the cap."""
    garment = data.get("garment")
    mesh = data.get("mesh") or {}
    cols = int(mesh.get("cols") or 0)
    rows = int(mesh.get("rows") or 0)
    if not isinstance(garment, list) or cols <= 0 or rows <= 0:
        return
    if _coverage(garment) <= max_coverage:
        return

    import numpy as np

    grid = np.array([1 if flag else 0 for flag in garment], dtype=bool).reshape(rows, cols)
    print(
        f"Auto mask coverage {_coverage(garment) * 100:.1f}% exceeds "
        f"{max_coverage * 100:.0f}% — eroding to cap",
        flush=True,
    )
    while float(grid.mean()) > max_coverage and grid.any():
        grid = ndimage.binary_erosion(grid, iterations=1)
    data["garment"] = [1 if flag else 0 for flag in grid.reshape(-1).tolist()]
    data["garmentAutoCapped"] = True


def generate_garment_mask(
    mesh_path: Path,
    *,
    mask_source: str = AUTO_MASK_SOURCE,
    threshold: float = AUTO_THRESHOLD,
    pixel_dilate: int = AUTO_PIXEL_DILATE,
    grid_dilate: int = AUTO_GRID_DILATE,
    sample_frames: int = AUTO_SAMPLE_FRAMES,
    max_coverage: float = AUTO_MAX_COVERAGE,
    union_existing: bool = False,
) -> dict[str, Any]:
    """Write an automatic `garment` array into `mesh_path` and return a summary."""
    if not mesh_path.exists():
        raise FileNotFoundError(f"Mesh not found: {mesh_path}")

    data = json.loads(mesh_path.read_text(encoding="utf-8"))
    source = data.get("source")
    video = ROOT / source if isinstance(source, str) else None
    if video is None or not video.exists():
        # Prefer published card / work-dir dressed clip when JSON source drifted.
        # shine_3.json -> shine_3; candidates like shine_3.bootstapir.json -> shine_3
        stem = mesh_path.stem
        for suffix in (".bootstapir", ".cotracker", ".blend"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        fallbacks = [
            ROOT / "public" / "cards" / stem / "foreground.mp4",
            ROOT / ".tmp" / "video-flow" / stem / "foreground-dressed.mp4",
            ROOT / ".tmp" / "video-flow" / stem / "foreground-aligned-for-compress.mp4",
        ]
        video = next((path for path in fallbacks if path.exists()), None)
        if video is None:
            raise FileNotFoundError(
                f"Foreground video missing for {mesh_path.name} "
                f"(expected {source!r} or public/cards/{stem}/foreground.mp4). "
                "Re-run the Create card step first."
            )
        data["source"] = str(video.relative_to(ROOT))
        mesh_path.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"Updated mesh source to {data['source']}", flush=True)

    previous = {
        "MASK_SOURCE": os.environ.get("MASK_SOURCE"),
        "GARMENT_THRESHOLD": os.environ.get("GARMENT_THRESHOLD"),
        "GARMENT_DILATE": os.environ.get("GARMENT_DILATE"),
        "GARMENT_GRID_DILATE": os.environ.get("GARMENT_GRID_DILATE"),
        "SAMPLE_FRAMES": os.environ.get("SAMPLE_FRAMES"),
        "UNION_EXISTING": os.environ.get("UNION_EXISTING"),
        "DEVICE": os.environ.get("DEVICE"),
        "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
        "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
    }
    os.environ["MASK_SOURCE"] = mask_source
    os.environ["GARMENT_THRESHOLD"] = str(threshold)
    os.environ["GARMENT_DILATE"] = str(pixel_dilate)
    os.environ["GARMENT_GRID_DILATE"] = str(grid_dilate)
    os.environ["SAMPLE_FRAMES"] = str(sample_frames)
    os.environ["UNION_EXISTING"] = "1" if union_existing else "0"
    os.environ.setdefault("DEVICE", "cpu")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    try:
        # Re-load so module-level constants pick up our env.
        module = _load_augment_module()
        module.MASK_SOURCE = mask_source.lower()
        module.GARMENT_THRESHOLD = float(threshold)
        module.GARMENT_DILATE = int(pixel_dilate)
        module.GARMENT_GRID_DILATE = int(grid_dilate)
        module.SAMPLE_FRAMES = int(sample_frames)
        module.UNION_EXISTING = bool(union_existing)
        print(
            f"Auto garment mask: source={mask_source} threshold={threshold} "
            f"dilate={pixel_dilate} grid={grid_dilate} union={union_existing}",
            flush=True,
        )
        before = module.GARMENT_THRESHOLD
        module.augment(mesh_path)
        # augment() can silently skip — confirm garment was written as auto.
        refreshed = json.loads(mesh_path.read_text(encoding="utf-8"))
        if not isinstance(refreshed.get("garment"), list):
            raise RuntimeError(f"Auto mask did not write a garment array (threshold={before})")
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    data = json.loads(mesh_path.read_text(encoding="utf-8"))
    _shrink_to_cap(data, max_coverage)
    data["garmentSource"] = "auto-detect"
    mesh_path.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")

    garment = data.get("garment") or []
    total = len(garment)
    on = int(sum(1 for flag in garment if flag))
    print(f"Auto garment mask done: {on}/{total} ({(on / total * 100) if total else 0:.1f}%)", flush=True)
    return {
        "file": mesh_path.name,
        "sum": on,
        "total": total,
        "coverage": (on / total) if total else 0.0,
        "source": "auto-detect",
        "capped": bool(data.get("garmentAutoCapped")),
    }
