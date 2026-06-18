"""
Generate a deforming garment mesh by tracking a grid of points across the
foreground clip with CoTracker3 (dense point tracking).

Unlike generate-ai-mesh-keyframes.py (pose box + per-row silhouette width),
this measures where each patch of the garment actually moves frame-to-frame,
so scratches/symbols stored in mesh-UV ride the real fabric.

Usage:
  PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python scripts/generate-mesh-tracking.py

Env knobs:
  FPS            frames per second to sample/track (default 10)
  MAX_FRAMES     cap number of tracked frames (debugging)
  GRID_COLS      mesh columns (default 12)
  GRID_ROWS      mesh rows (default 18)
  DEVICE         torch device (default mps)
  DEBUG_OVERLAY=1  write tracked-point overlays to .tmp/track_overlay

Output:
  public/mesh/tracked-mesh.json
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw
from scipy import ndimage
from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

REPO_ROOT = Path(__file__).parent.parent
INPUT_VIDEO = REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", REPO_ROOT / "public/mesh/tracked-mesh.json"))
DEBUG_OVERLAY_DIR = REPO_ROOT / ".tmp" / "track_overlay"

CANVAS_WIDTH = 390
CANVAS_HEIGHT = 672
FRAME_BYTES = CANVAS_WIDTH * CANVAS_HEIGHT * 4
FPS = float(os.environ.get("FPS", "20"))
MAX_FRAMES = int(os.environ["MAX_FRAMES"]) if os.environ.get("MAX_FRAMES") else None
GRID_COLS = int(os.environ.get("GRID_COLS", "24"))
GRID_ROWS = int(os.environ.get("GRID_ROWS", "36"))
DEVICE = os.environ.get("DEVICE", "mps")
DEBUG_OVERLAY = bool(os.environ.get("DEBUG_OVERLAY"))
# Temporal low-pass (in frames) to de-jitter each track. 0 disables.
SMOOTH_SIGMA = float(os.environ.get("SMOOTH_SIGMA", "1.2"))
# Distribute end-to-start drift so a looping clip closes seamlessly. 0 disables.
LOOP_CLOSE = float(os.environ.get("LOOP_CLOSE", "1"))
# Per-frame garment mask refines visibility (drops points that leave the dress
# or get occluded by an arm). Off by default: clothes parsing is unreliable on
# translucent/turning fabric and was dropping valid arm/side tracks.
PER_FRAME_MASK = os.environ.get("PER_FRAME_MASK", "0") != "0"
# Temporal visibility stabilization (frames): close short dropouts that make
# scratched holes flicker; open away isolated single-frame blips.
VIS_CLOSE = int(os.environ.get("VIS_CLOSE", "7"))
VIS_OPEN = int(os.environ.get("VIS_OPEN", "3"))
# When enabled, output a full-canvas deformation field. CoTracker still only
# tracks real performer/body points; off-body vertices inherit nearby performer
# displacement so the mesh covers the full screen without pretending the green
# background has trackable features.
FULL_SCREEN_FIELD = os.environ.get("FULL_SCREEN_FIELD", "1") != "0"
FIELD_NEIGHBORS = int(os.environ.get("FIELD_NEIGHBORS", "8"))
FIELD_POWER = float(os.environ.get("FIELD_POWER", "2.0"))
# Frame to seed the grid from. "auto" picks the most frontal frame (max body
# area) so sides that rotate into view later are captured; or set an index.
REF_FRAME = os.environ.get("REF_FRAME", "auto")
# Optional: seed from the tracked frame that best matches this reference image
# (e.g. a hand-picked full-front frame). Overrides REF_FRAME when set.
REF_IMAGE = os.environ.get("REF_IMAGE")

# Clothes-parsing model + the class ids that count as scratchable garment.
# Excludes Hair(2), Face(11), Left-arm(14), Right-arm(15), legs/skin, so the
# mesh border follows the dress instead of the body silhouette (no hands/head).
SEG_MODEL = os.environ.get("SEG_MODEL", "mattmdjaga/segformer_b2_clothes")
GARMENT_CLASSES = {4, 5, 6, 7, 8, 17}  # Upper-clothes, Skirt, Pants, Dress, Belt, Scarf
HEAD_CLASSES = {1, 2, 3, 11}  # Hat, Hair, Sunglasses, Face


def run(command, args):
    result = subprocess.run([command, *args], check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{command} failed:\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def get_duration():
    out = run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                          "-of", "default=noprint_wrappers=1:nokey=1", str(INPUT_VIDEO)])
    return float(out.decode("utf8").strip())


def load_frames():
    """Sample the clip at FPS into letterboxed CANVAS_WIDTH x CANVAS_HEIGHT RGBA
    frames, matching the renderer's contain-fit so tracked coords are canvas
    pixels directly. Green pad never produces garment points."""
    raw = run("ffmpeg", [
        "-v", "error", "-i", str(INPUT_VIDEO), "-vf",
        (f"fps={FPS},"
         f"scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,"
         f"pad={CANVAS_WIDTH}:{CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x00ff00,"
         "format=rgba"),
        "-f", "rawvideo", "pipe:1",
    ])
    count = len(raw) // FRAME_BYTES
    if MAX_FRAMES:
        count = min(count, MAX_FRAMES)
    frames = np.frombuffer(raw[: count * FRAME_BYTES], dtype=np.uint8)
    return frames.reshape((count, CANVAS_HEIGHT, CANVAS_WIDTH, 4)).copy()


def chroma_key_mask(rgba):
    red = rgba[:, :, 0].astype(np.int16)
    green = rgba[:, :, 1].astype(np.int16)
    blue = rgba[:, :, 2].astype(np.int16)
    alpha = rgba[:, :, 3].astype(np.int16)
    dominance = green - np.maximum(red, blue)
    keyed = alpha.copy()
    sel = (green > 130) & (dominance > 38)
    keyed[sel] = np.maximum(0, 255 - dominance * 6)[sel]
    return keyed > 72


def clean_silhouette(rgba):
    mask = chroma_key_mask(rgba)
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=1)
    filled = ndimage.binary_fill_holes(mask)
    labels, count = ndimage.label(filled)
    if count == 0:
        return filled
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(counts.argmax())


_seg_cache = {}


def _segment(rgb):
    if "model" not in _seg_cache:
        _seg_cache["proc"] = SegformerImageProcessor.from_pretrained(SEG_MODEL)
        _seg_cache["model"] = AutoModelForSemanticSegmentation.from_pretrained(SEG_MODEL).to(DEVICE).eval()
    proc, model = _seg_cache["proc"], _seg_cache["model"]
    image = Image.fromarray(rgb, mode="RGB")
    inputs = proc(images=image, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        logits = model(**inputs).logits
    upsampled = torch.nn.functional.interpolate(
        logits, size=(CANVAS_HEIGHT, CANVAS_WIDTH), mode="bilinear", align_corners=False
    )
    return upsampled.argmax(1)[0].cpu().numpy()


def _largest_blob(mask):
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=1)
    mask = ndimage.binary_fill_holes(mask)
    labels, count = ndimage.label(mask)
    if count == 0:
        return mask
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(counts.argmax())


def build_garment_mask(rgb):
    """Per-frame garment mask (Upper-clothes/Dress/...), cleaned to largest blob."""
    return _largest_blob(np.isin(_segment(rgb), list(GARMENT_CLASSES)))


def build_trackable_mask(rgba):
    """Region we seed tracking on: the body silhouette MINUS the head. Keeps the
    arms/sleeves (which clothes parsing labels inconsistently) and only removes
    hair/face, so the lattice covers the whole garment including arms."""
    silhouette = clean_silhouette(rgba)
    head = np.isin(_segment(rgba[:, :, :3]), list(HEAD_CLASSES))
    head = ndimage.binary_dilation(head, iterations=3)
    return _largest_blob(silhouette & ~head)


def row_span(mask, y):
    """Left/right x of the silhouette at integer row y, or None."""
    row = mask[y]
    xs = np.where(row)[0]
    if len(xs) < 3:
        return None
    return float(xs.min()), float(xs.max())


def pick_reference_frame(frames, samples=20):
    """Pick the frame with the largest trackable (body-minus-head) area — the
    most frontal pose, where both sides and the hands are most visible."""
    if REF_IMAGE:
        ref = np.asarray(Image.open(REF_IMAGE).convert("RGB").resize((CANVAS_WIDTH, CANVAS_HEIGHT)), np.float32)
        diffs = [float(np.abs(frames[i, :, :, :3].astype(np.float32) - ref).mean()) for i in range(len(frames))]
        best = int(np.argmin(diffs))
        print(f"REF_IMAGE matched tracked frame {best} (mean abs diff {diffs[best]:.1f})")
        return best
    if REF_FRAME != "auto":
        return max(0, min(len(frames) - 1, int(REF_FRAME)))
    T = len(frames)
    step = max(1, T // samples)
    best_idx, best_area = 0, -1
    for i in range(0, T, step):
        area = int(build_trackable_mask(frames[i]).sum())
        if area > best_area:
            best_idx, best_area = i, area
    return best_idx


def seed_grid(mask):
    """Lay a full GRID_COLS x GRID_ROWS lattice over the mask's bounding box and
    keep every cell, marking which ones start on the body. Area-filling (not
    per-row spans) so thin parts like arms get their own vertices.

    Returns full-grid arrays so the renderer keeps a regular topology:
      uv     (N,2) regular grid coords
      seeds  (N,2) seed pixel positions (used for invalid cells too)
      valid  (N,)  bool: did this cell start on the body
    where N = GRID_COLS * GRID_ROWS.
    """
    ys, xs = np.where(mask)
    if len(xs) == 0:
        raise SystemExit("Frame 0 trackable mask is empty; cannot seed grid.")
    bx0, bx1, by0, by1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    # erode so seeds sit just inside the body, off the noisy silhouette edge
    inside = ndimage.binary_erosion(mask, iterations=3)

    uv, seeds, valid = [], [], []
    for j in range(GRID_ROWS):
        v = j / (GRID_ROWS - 1)
        y = by0 + (by1 - by0) * v
        for i in range(GRID_COLS):
            u = i / (GRID_COLS - 1)
            x = bx0 + (bx1 - bx0) * u
            yi, xi = int(round(y)), int(round(x))
            ok = 0 <= yi < CANVAS_HEIGHT and 0 <= xi < CANVAS_WIDTH and bool(inside[yi, xi])
            uv.append([u, v])
            seeds.append([x, y])
            valid.append(ok)
    return (
        np.array(uv, dtype=np.float32),
        np.array(seeds, dtype=np.float32),
        np.array(valid, dtype=bool),
    )


def seed_canvas_grid():
    """Lay a regular GRID_COLS x GRID_ROWS lattice over the full render canvas."""
    uv, seeds = [], []
    for j in range(GRID_ROWS):
        v = j / (GRID_ROWS - 1)
        y = (CANVAS_HEIGHT - 1) * v
        for i in range(GRID_COLS):
            u = i / (GRID_COLS - 1)
            x = (CANVAS_WIDTH - 1) * u
            uv.append([u, v])
            seeds.append([x, y])
    return np.array(uv, dtype=np.float32), np.array(seeds, dtype=np.float32)


def extend_motion_to_canvas_field(target_seeds, driver_seeds, driver_tracks, driver_vis):
    """Move full-canvas vertices using nearby performer-track displacement.

    `driver_tracks` are real CoTracker outputs seeded on the performer. Each
    target vertex blends the displacement of its nearest driver vertices, with
    per-frame CoTracker visibility acting as confidence. If all nearby drivers
    are invisible for a frame, it falls back to the static nearest-neighbor
    weights to avoid holes/flicker in the full-screen field.
    """
    if len(driver_seeds) == 0:
        raise SystemExit("No performer seeds available to drive full-screen field.")

    neighbor_count = max(1, min(FIELD_NEIGHBORS, len(driver_seeds)))
    distances = np.linalg.norm(target_seeds[:, None, :] - driver_seeds[None, :, :], axis=2)
    nearest = np.argpartition(distances, neighbor_count - 1, axis=1)[:, :neighbor_count]
    nearest_distances = np.take_along_axis(distances, nearest, axis=1)
    base_weights = 1.0 / np.maximum(nearest_distances, 1.0) ** FIELD_POWER
    base_denominator = base_weights.sum(axis=1, keepdims=True)

    driver_displacements = driver_tracks - driver_seeds[None, :, :]
    T = driver_tracks.shape[0]
    tracks = np.empty((T, len(target_seeds), 2), dtype=np.float32)

    for t in range(T):
        frame_displacements = driver_displacements[t, nearest, :]
        confidence = driver_vis[t, nearest].astype(np.float32)
        weights = base_weights * confidence
        denominator = weights.sum(axis=1, keepdims=True)

        fallback_delta = (frame_displacements * base_weights[:, :, None]).sum(axis=1) / base_denominator
        weighted_delta = np.divide(
            (frame_displacements * weights[:, :, None]).sum(axis=1),
            np.maximum(denominator, 1e-6),
        )
        use_fallback = denominator[:, 0] <= 1e-6
        weighted_delta[use_fallback] = fallback_delta[use_fallback]
        tracks[t] = target_seeds + weighted_delta

    # The output field is intentionally visible everywhere. Driver visibility
    # has already been consumed as weighting confidence above.
    vis = np.ones((T, len(target_seeds)), dtype=np.uint8)
    return tracks, vis


def smooth_tracks(tracks, sigma):
    """Gaussian low-pass each vertex trajectory over time to remove jitter."""
    if sigma <= 0:
        return tracks
    smoothed = tracks.copy()
    smoothed[:, :, 0] = ndimage.gaussian_filter1d(tracks[:, :, 0], sigma, axis=0, mode="nearest")
    smoothed[:, :, 1] = ndimage.gaussian_filter1d(tracks[:, :, 1], sigma, axis=0, mode="nearest")
    return smoothed


def close_loop(tracks, strength):
    """Linearly distribute the end-to-start residual so the last frame returns
    to the seed positions, removing accumulated drift over a looping clip."""
    if strength <= 0 or len(tracks) < 3:
        return tracks, 0.0
    residual = tracks[-1] - tracks[0]
    mean_drift = float(np.hypot(residual[:, 0], residual[:, 1]).mean())
    T = len(tracks)
    ramp = (np.arange(T) / (T - 1))[:, None, None]
    return tracks - ramp * residual[None] * strength, mean_drift


def stabilize_visibility(vis, close_len, open_len):
    """Temporally close short visibility gaps (brief CoTracker dropouts that make
    scratched holes flicker back to foreground) and open away isolated 1-frame
    blips. Genuine long occlusions (> close_len frames) are preserved."""
    b = vis.astype(bool)
    if close_len > 1:
        b = ndimage.binary_closing(b, structure=np.ones((close_len, 1), bool))
    if open_len > 1:
        b = ndimage.binary_opening(b, structure=np.ones((open_len, 1), bool))
    return b.astype(np.uint8)


def visibility_from_masks(tracks, masks, base_vis, tolerance=4):
    """A vertex stays visible only if it also lands on the garment mask that
    frame (within `tolerance` px), dropping points that slide onto skin/bg or
    are occluded by a crossing arm."""
    refined = base_vis.copy()
    struct = np.ones((tolerance * 2 + 1, tolerance * 2 + 1), bool)
    for t, mask in enumerate(masks):
        dilated = ndimage.binary_dilation(mask, structure=struct)
        for n in range(tracks.shape[1]):
            x = int(round(tracks[t, n, 0]))
            y = int(round(tracks[t, n, 1]))
            on = 0 <= y < CANVAS_HEIGHT and 0 <= x < CANVAS_WIDTH and bool(dilated[y, x])
            if not on:
                refined[t, n] = 0
    return refined


def write_overlay(frames, tracks, vis, step=10):
    DEBUG_OVERLAY_DIR.mkdir(parents=True, exist_ok=True)
    T = frames.shape[0]
    for t in range(0, T, step):
        img = Image.fromarray(frames[t], mode="RGBA").convert("RGB")
        draw = ImageDraw.Draw(img)
        for n in range(tracks.shape[1]):
            x, y = tracks[t, n]
            color = (0, 220, 255) if vis[t, n] else (255, 60, 60)
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=color)
        img.save(DEBUG_OVERLAY_DIR / f"trk{t:04d}.png")


def main():
    if not INPUT_VIDEO.exists():
        sys.exit(f"Foreground video not found: {INPUT_VIDEO}")

    duration = get_duration()
    print(f"Loading frames at {FPS} fps ...")
    frames = load_frames()
    T = frames.shape[0]
    print(f"Loaded {T} frames ({CANVAS_WIDTH}x{CANVAS_HEIGHT})")

    # Seed from the most frontal frame (max body area), not frame 0, so a side
    # that rotates into view later is still captured. Track bidirectionally so
    # those seeds reach frames before the reference too.
    ref_idx = pick_reference_frame(frames)
    print(f"Reference frame for seeding: {ref_idx} (t={ref_idx / FPS:.2f}s)")
    trackable = build_trackable_mask(frames[ref_idx])
    driver_uv, driver_seeds, valid = seed_grid(trackable)
    total = len(driver_uv)
    valid_idx = np.where(valid)[0]
    ref_col = np.full((len(valid_idx), 1), float(ref_idx), np.float32)
    queries = np.concatenate([ref_col, driver_seeds[valid_idx]], axis=1)
    print(f"Seeded {len(valid_idx)}/{total} grid cells on body ({GRID_COLS}x{GRID_ROWS} driver lattice)")

    print("Loading CoTracker3 (offline) ...")
    model = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline")
    model = model.to(DEVICE).eval()

    # video: B,T,3,H,W ; rgb only
    rgb = frames[:, :, :, :3].astype(np.float32)
    video = torch.from_numpy(rgb).permute(0, 3, 1, 2)[None].to(DEVICE)  # 1,T,3,H,W
    q = torch.from_numpy(queries)[None].to(DEVICE)  # 1,M,3

    print(f"Tracking {len(queries)} points across {T} frames on {DEVICE} (bidirectional) ...")
    with torch.no_grad():
        tracks_v, vis_v = model(video, queries=q, backward_tracking=True)
    tracks_v = tracks_v[0].cpu().numpy()  # T,M,2
    vis_v = (vis_v[0].cpu().numpy() > 0.5).astype(np.uint8)  # T,M
    print(f"Tracked: {tracks_v.shape}, mean CoTracker visibility {vis_v.mean():.2f}")

    tracks_v = smooth_tracks(tracks_v, SMOOTH_SIGMA)
    tracks_v, mean_drift = close_loop(tracks_v, LOOP_CLOSE)
    if LOOP_CLOSE > 0:
        print(f"Loop closure: distributed {mean_drift:.1f}px mean end-to-start drift")

    if PER_FRAME_MASK:
        print("Building per-frame garment masks to refine driver visibility ...")
        driver_tracks = np.tile(driver_seeds[None], (T, 1, 1)).astype(np.float32)
        driver_vis = np.zeros((T, total), dtype=np.uint8)
        driver_tracks[:, valid_idx, :] = tracks_v
        driver_vis[:, valid_idx] = vis_v
        masks = [build_garment_mask(frames[t, :, :, :3]) for t in range(T)]
        driver_vis = visibility_from_masks(driver_tracks, masks, driver_vis)
        vis_v = driver_vis[:, valid_idx]
        print(f"Refined driver mean visibility {vis_v.mean():.2f}")

    if VIS_CLOSE > 1 or VIS_OPEN > 1:
        before = int(np.abs(np.diff(vis_v.astype(np.int16), axis=0)).sum())
        vis_v = stabilize_visibility(vis_v, VIS_CLOSE, VIS_OPEN)
        after = int(np.abs(np.diff(vis_v.astype(np.int16), axis=0)).sum())
        print(f"Driver visibility stabilized: {before} -> {after} transitions")

    if FULL_SCREEN_FIELD:
        uv, seeds = seed_canvas_grid()
        tracks, vis = extend_motion_to_canvas_field(seeds, driver_seeds[valid_idx], tracks_v, vis_v)
        print(
            f"Extended performer motion to full-canvas field "
            f"({GRID_COLS}x{GRID_ROWS}, {FIELD_NEIGHBORS} neighbors, power={FIELD_POWER:g})"
        )
    else:
        # Scatter tracked (valid) cells back into the regular driver grid.
        # Invalid cells (off-body in the reference frame) stay at their seed
        # position with vis=0, which the renderer skips.
        uv, seeds = driver_uv, driver_seeds
        tracks = np.tile(seeds[None], (T, 1, 1)).astype(np.float32)  # T,total,2
        vis = np.zeros((T, total), dtype=np.uint8)
        tracks[:, valid_idx, :] = tracks_v
        vis[:, valid_idx] = vis_v

    if DEBUG_OVERLAY:
        write_overlay(frames, tracks, vis)
        print(f"Wrote tracked overlays to {DEBUG_OVERLAY_DIR}")

    out_frames = []
    for t in range(T):
        out_frames.append({
            "t": round(t / FPS, 3),
            "verts": [[round(float(x), 1), round(float(y), 1)] for x, y in tracks[t]],
            "vis": [int(v) for v in vis[t]],
        })

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    # Compact (no indentation) — this ships to the browser, so keep it small.
    OUTPUT_JSON.write_text(json.dumps({
        "source": "public/cards/Green bg sample 2 swap.mp4",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": "cotracker3-full-field-v6" if FULL_SCREEN_FIELD else "cotracker3-grid-v5",
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "fps": FPS,
        "durationSeconds": round(duration, 3),
        "refFrame": int(ref_idx),
        "smoothSigma": SMOOTH_SIGMA,
        "loopClose": LOOP_CLOSE,
        "perFrameMask": PER_FRAME_MASK,
        "visClose": VIS_CLOSE,
        "visOpen": VIS_OPEN,
        "fullScreenField": FULL_SCREEN_FIELD,
        "fieldNeighbors": FIELD_NEIGHBORS if FULL_SCREEN_FIELD else None,
        "fieldPower": FIELD_POWER if FULL_SCREEN_FIELD else None,
        "driverSeedCount": int(len(valid_idx)),
        "mesh": {"cols": GRID_COLS, "rows": GRID_ROWS},
        "uv": [[round(float(u), 4), round(float(v), 4)] for u, v in uv],
        "frames": out_frames,
    }, separators=(",", ":")) + "\n")
    size_mb = OUTPUT_JSON.stat().st_size / 1e6
    print(f"Wrote {T} mesh frames to {OUTPUT_JSON} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
