"""
Augment existing tracked-mesh JSON files with a static per-vertex `garment`
mask, so the app can restrict scratching to clothing only.

Why static (per-vertex) and not per-frame: scratch holes live in mesh-UV space,
and the garment occupies a stable UV region across the clip (that is the whole
point of UV tracking). A single per-vertex garment flag is therefore correct and
flicker-free, unlike a raw per-frame SegFormer mask (which shimmers on turning /
translucent fabric).

How: reuse the generator's frame loader + SegFormer clothes parser. For each
vertex, sample its ALREADY-TRACKED canvas position against the per-frame garment
mask over a stride-sampled set of frames, then majority-vote membership. No point
re-tracking happens here, so this is cheap relative to a full mesh regeneration.

Usage:
  .venv/bin/python scripts/add-garment-mask.py                 # all meshes in public/mesh
  .venv/bin/python scripts/add-garment-mask.py girl_1.json     # specific file(s)

Env knobs:
  DEVICE              torch device (default cpu)
  GARMENT_THRESHOLD   fraction of sampled frames a vertex must be on clothes to
                      count as garment (default 0.30). Lower = more inclusive, so
                      garment edges that only intermittently sit on clothing (as
                      the body turns) are still scratchable.
  GARMENT_DILATE      pixels to grow each per-frame garment mask before sampling
                      (default 2).
  GARMENT_GRID_DILATE cells to grow the final per-vertex mask on the cols x rows
                      lattice (default 1), so the whole garment + a small margin
                      is covered and the scratchable region has no holes.
  EXTRA_GARMENT_CLASSES  comma-separated SegFormer class ids to also treat as
                      scratchable, on top of the generator's clothing classes
                      (only used when MASK_SOURCE=garment). Default "12,13,14,15"
                      (legs + arms).
  MASK_SOURCE         "body" (default) builds the scratchable mask from the full
                      chroma-key silhouette MINUS the head/hair/face — so the
                      whole figure (arms, legs, sleeves) is scratchable but not
                      the background or face. "garment" uses only the SegFormer
                      clothing (+ extra) classes, which can miss arms/sleeves on
                      stylized clips.
  SAMPLE_FRAMES       max number of frames to segment per clip (default 60)
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

REPO_ROOT = Path(__file__).parent.parent
MESH_DIR = REPO_ROOT / "public" / "mesh"

GARMENT_THRESHOLD = float(os.environ.get("GARMENT_THRESHOLD", "0.30"))
GARMENT_DILATE = int(os.environ.get("GARMENT_DILATE", "2"))
GARMENT_GRID_DILATE = int(os.environ.get("GARMENT_GRID_DILATE", "1"))
SAMPLE_FRAMES = int(os.environ.get("SAMPLE_FRAMES", "60"))
# When set, OR the freshly computed mask with the mesh's existing `garment` array
# instead of replacing it. Lets you grow coverage without discarding hand edits.
UNION_EXISTING = os.environ.get("UNION_EXISTING", "0") != "0"

# Load the generator module to reuse load_frames / build_garment_mask / segment.
_gen_path = Path(__file__).parent / "generate-mesh-tracking.py"
_spec = importlib.util.spec_from_file_location("mesh_gen", _gen_path)
gen = importlib.util.module_from_spec(_spec)
# Segmentation runs fine on CPU; MPS may be unavailable in some shells.
os.environ.setdefault("DEVICE", "cpu")
_spec.loader.exec_module(gen)
gen.DEVICE = os.environ.get("DEVICE", "cpu")

# Extend the scratchable classes so sleeves/arms/legs of the outfit count, not
# just the torso garment. build_garment_mask reads gen.GARMENT_CLASSES at call
# time, so overriding it here (this process only) is enough.
_extra_raw = os.environ.get("EXTRA_GARMENT_CLASSES", "12,13,14,15")
_extra_classes = {int(tok) for tok in _extra_raw.split(",") if tok.strip() != ""}
if _extra_classes:
    gen.GARMENT_CLASSES = set(gen.GARMENT_CLASSES) | _extra_classes

MASK_SOURCE = os.environ.get("MASK_SOURCE", "body").lower()
print(f"Mask source: {MASK_SOURCE} (clothing classes {sorted(gen.GARMENT_CLASSES)})")


def scratchable_mask(rgba):
    """Per-frame scratchable region. 'body' = full chroma-key silhouette minus
    head (robust: always includes arms/legs); 'garment' = SegFormer clothing
    classes only."""
    if MASK_SOURCE == "body":
        return gen.build_trackable_mask(rgba)
    return gen.build_garment_mask(rgba[:, :, :3])


def augment(mesh_path: Path) -> None:
    data = json.loads(mesh_path.read_text())
    source = data.get("source")
    if not source:
        print(f"[skip] {mesh_path.name}: no source video field")
        return

    video = REPO_ROOT / source
    if not video.exists():
        print(f"[skip] {mesh_path.name}: source video missing ({video})")
        return

    cols = int(data["mesh"]["cols"])
    rows = int(data["mesh"]["rows"])
    n_verts = cols * rows
    mesh_frames = data["frames"]

    # Match the generator's sampling so tracked coords map to canvas pixels.
    gen.INPUT_VIDEO = video
    gen.FPS = float(data.get("fps", gen.FPS))
    gen.MAX_FRAMES = None
    frames = gen.load_frames()

    total = min(len(frames), len(mesh_frames))
    if total == 0:
        print(f"[skip] {mesh_path.name}: no frames")
        return

    stride = max(1, total // max(1, SAMPLE_FRAMES))
    sampled = list(range(0, total, stride))

    on_garment = np.zeros(n_verts, dtype=np.int32)
    counted = 0
    struct = np.ones((3, 3), bool)
    print(f"[{mesh_path.name}] segmenting {len(sampled)} of {total} frames (stride {stride}) ...")
    for t in sampled:
        mask = scratchable_mask(frames[t])
        if GARMENT_DILATE > 0:
            mask = ndimage.binary_dilation(mask, structure=struct, iterations=GARMENT_DILATE)
        verts = mesh_frames[t]["verts"]
        for i in range(n_verts):
            x = int(round(verts[i][0]))
            y = int(round(verts[i][1]))
            if 0 <= x < gen.CANVAS_WIDTH and 0 <= y < gen.CANVAS_HEIGHT and mask[y, x]:
                on_garment[i] += 1
        counted += 1

    fraction = on_garment / max(1, counted)
    garment = (fraction >= GARMENT_THRESHOLD).astype(bool)
    # Grow the mask on the lattice so the full garment (plus a one-cell margin)
    # is scratchable and there are no interior holes from per-frame seg dropouts.
    if GARMENT_GRID_DILATE > 0:
        grid = garment.reshape(rows, cols)
        grid = ndimage.binary_dilation(grid, iterations=GARMENT_GRID_DILATE)
        garment = grid.reshape(-1)
    garment = garment.astype(int)
    if UNION_EXISTING:
        prev = data.get("garment")
        if isinstance(prev, list) and len(prev) == n_verts:
            prev_arr = np.array([1 if v else 0 for v in prev], dtype=int)
            added = int(((garment == 1) & (prev_arr == 0)).sum())
            garment = np.maximum(garment, prev_arr)
            print(f"[{mesh_path.name}] union with existing mask (+{added} new cells)")
    data["garment"] = [int(v) for v in garment]
    data["garmentThreshold"] = GARMENT_THRESHOLD
    data["garmentGridDilate"] = GARMENT_GRID_DILATE

    mesh_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(
        f"[{mesh_path.name}] garment vertices {int(garment.sum())}/{n_verts} "
        f"({garment.mean() * 100:.1f}%) -> written"
    )


def main() -> None:
    args = sys.argv[1:]
    if args:
        targets = [MESH_DIR / name for name in args]
    else:
        targets = sorted(MESH_DIR.glob("*.json"))
        targets = [p for p in targets if p.name != "index.json"]

    for mesh_path in targets:
        if not mesh_path.exists():
            print(f"[skip] {mesh_path} not found")
            continue
        augment(mesh_path)


if __name__ == "__main__":
    main()
