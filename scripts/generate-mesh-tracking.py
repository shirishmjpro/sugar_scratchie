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
from scipy.spatial import cKDTree
from scipy.signal import savgol_filter
from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

REPO_ROOT = Path(__file__).parent.parent
INPUT_VIDEO = Path(os.environ.get("INPUT_VIDEO", REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"))
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
# Which point tracker drives the mesh. "cotracker" (CoTracker3, default),
# "bootstapir" (DeepMind BootsTAPIR, vendored offline), or "blend" (run both and
# keep the more confident tracker per point per frame).
TRACKER = os.environ.get("TRACKER", "cotracker").lower()
# Chroma-key thresholds (background green detection). Lower CHROMA_GREEN_MIN for
# clips whose green screen is dark/uneven.
CHROMA_GREEN_MIN = int(os.environ.get("CHROMA_GREEN_MIN", "130"))
CHROMA_DOMINANCE_MIN = int(os.environ.get("CHROMA_DOMINANCE_MIN", "38"))
# When set, run BOTH trackers on the same seed points, write side-by-side driver
# overlays (cotracker_drv*.png / bootstapir_drv*.png) and a metrics table, then
# exit without writing a mesh. Use this to decide cotracker vs bootstapir.
COMPARE_TRACKERS = os.environ.get("COMPARE_TRACKERS", "0") != "0"
# Temporal smoothing of each track. "savgol" (Savitzky-Golay) de-jitters while
# preserving real velocity; "gaussian" is the old low-pass (blurs fast motion).
SMOOTH_METHOD = os.environ.get("SMOOTH_METHOD", "savgol")
# Gaussian sigma (frames) when SMOOTH_METHOD=gaussian, or when savgol falls back
# on very short clips. 0 disables smoothing entirely.
SMOOTH_SIGMA = float(os.environ.get("SMOOTH_SIGMA", "1.2"))
# Savitzky-Golay window (odd, in frames) and polynomial order.
SAVGOL_WINDOW = int(os.environ.get("SAVGOL_WINDOW", "9"))
SAVGOL_POLY = int(os.environ.get("SAVGOL_POLY", "2"))
# Driver pruning before the field blend: drop CoTracker drivers whose worst
# per-frame jump exceeds median + K*MAD (runaway points), or whose mean
# visibility is below the floor. Keeps lone bad tracks from poisoning the field.
PRUNE_SPEED_MAD_K = float(os.environ.get("PRUNE_SPEED_MAD_K", "6.0"))
PRUNE_MIN_MEAN_VIS = float(os.environ.get("PRUNE_MIN_MEAN_VIS", "0.15"))
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
# In full-canvas mode the field is visible everywhere and the *static* garment
# mask (added by add-garment-mask.py / the dashboard Mask Editor) is the scratch
# gate. Re-restricting per-frame visibility to garment-only here makes vis sparse
# and silently overrides the editable mask, so it's opt-in (off by default).
GARMENT_VIS_REFINE = os.environ.get("GARMENT_VIS_REFINE", "0") != "0"
FIELD_NEIGHBORS = int(os.environ.get("FIELD_NEIGHBORS", "8"))
FIELD_POWER = float(os.environ.get("FIELD_POWER", "2.0"))
# Extra CoTracker drivers sampled from the performer mask. These are separate
# from the regular mesh grid and help thin/fast regions like hands and sleeves
# influence the full-screen deformation field.
EXTRA_DRIVER_POINTS = int(os.environ.get("EXTRA_DRIVER_POINTS", "320"))
EXTRA_DRIVER_MIN_DISTANCE = float(os.environ.get("EXTRA_DRIVER_MIN_DISTANCE", "5"))
EXTRA_DRIVER_STRIDE = int(os.environ.get("EXTRA_DRIVER_STRIDE", "3"))
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
# Where the trackable body silhouette comes from. "chroma" (default) assumes a
# green-screen clip and keys it out. "person" derives the silhouette from the
# SegFormer parse (every non-background class) so clips shot on a real, non-green
# background still seed tracking ONLY on the performer (not the static scenery),
# which is what keeps scratches glued to moving arms/legs.
SILHOUETTE_SOURCE = os.environ.get("SILHOUETTE_SOURCE", "chroma").lower()


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
    """Sample the clip at FPS into CANVAS_WIDTH x CANVAS_HEIGHT RGBA frames using
    a center-crop COVER fit (scale up to fill, crop the overflow), matching the
    renderer's cover-fit so tracked coords are canvas pixels directly. No green
    padding is added, so every frame is real footage edge-to-edge."""
    raw = run("ffmpeg", [
        "-v", "error", "-i", str(INPUT_VIDEO), "-vf",
        (f"fps={FPS},"
         f"scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}:force_original_aspect_ratio=increase,"
         f"crop={CANVAS_WIDTH}:{CANVAS_HEIGHT},"
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
    # CHROMA_GREEN_MIN gates how dark a green still counts as background; lower it
    # for clips with shadowed/uneven green (otherwise the silhouette leaks into
    # the dark background and seeds land off-body).
    sel = (green > CHROMA_GREEN_MIN) & (dominance > CHROMA_DOMINANCE_MIN)
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


def person_silhouette(rgb):
    """Full performer silhouette from the SegFormer parse: every non-background
    class (skin, hair, clothes, limbs). Used for non-green-screen clips so the
    static scenery is excluded from the trackable region."""
    return _largest_blob(_segment(rgb) != 0)


# How far to grow the head/hair mask before subtracting it. Long hair draping
# over a shoulder/arm otherwise deletes the garment beneath it, leaving that
# limb unseeded and untrackable. Keep this small.
HEAD_DILATE = int(os.environ.get("HEAD_DILATE", "1"))


def build_trackable_mask(rgba):
    """Region we seed tracking on: the body silhouette MINUS the head, but with
    garment pixels added back so clothing draped or flanked by hair is never
    deleted. Keeps the arms/sleeves (which clothes parsing labels inconsistently)
    and only removes bare face/hair, so the lattice covers the whole garment
    including hair-occluded shoulders/arms."""
    rgb = rgba[:, :, :3]
    silhouette = person_silhouette(rgb) if SILHOUETTE_SOURCE == "person" else clean_silhouette(rgba)
    seg = _segment(rgb)
    garment = np.isin(seg, list(GARMENT_CLASSES))
    # Only subtract head/hair where it is NOT garment, and dilate gently so the
    # mask doesn't bleed into the adjacent arm.
    head = np.isin(seg, list(HEAD_CLASSES)) & ~garment
    if HEAD_DILATE > 0:
        head = ndimage.binary_dilation(head, iterations=HEAD_DILATE)
    trackable = (silhouette & ~head) | (garment & ~head)
    return _largest_blob(trackable)


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


def sample_extra_driver_points(mask, base_seeds):
    """Add dense performer driver points, biased toward thin/edge regions.

    The regular grid is good for the torso but can miss hands because erosion and
    coarse spacing remove narrow areas. These extra seeds are only CoTracker
    drivers; they do not change the renderer's output topology.
    """
    if EXTRA_DRIVER_POINTS <= 0:
        return np.empty((0, 2), dtype=np.float32)

    candidate_mask = ndimage.binary_erosion(mask, iterations=1)
    if not candidate_mask.any():
        candidate_mask = mask

    ys, xs = np.where(candidate_mask)
    if len(xs) == 0 or len(base_seeds) == 0:
        return np.empty((0, 2), dtype=np.float32)

    keep = ((xs + ys) % max(1, EXTRA_DRIVER_STRIDE)) == 0
    candidates = np.stack([xs[keep], ys[keep]], axis=1).astype(np.float32)
    if len(candidates) == 0:
        return np.empty((0, 2), dtype=np.float32)

    base_tree = cKDTree(base_seeds)
    distance_to_base, _ = base_tree.query(candidates, k=1)
    thickness = ndimage.distance_transform_edt(candidate_mask)[
        candidates[:, 1].astype(int),
        candidates[:, 0].astype(int),
    ]

    # Prefer points not already covered by the coarse grid and points near thin
    # silhouette regions. This usually lifts hands/sleeves first.
    edge_bonus = 18.0 / np.maximum(thickness, 1.0)
    score = distance_to_base + edge_bonus
    order = np.argsort(-score)

    selected = []
    selected_tree = None
    for index in order:
        point = candidates[index]
        if distance_to_base[index] < EXTRA_DRIVER_MIN_DISTANCE:
            continue
        if selected_tree is not None:
            distance_to_selected, _ = selected_tree.query(point, k=1)
            if distance_to_selected < EXTRA_DRIVER_MIN_DISTANCE:
                continue
        selected.append(point)
        if len(selected) >= EXTRA_DRIVER_POINTS:
            break
        selected_tree = cKDTree(np.array(selected, dtype=np.float32))

    if not selected:
        return np.empty((0, 2), dtype=np.float32)
    return np.array(selected, dtype=np.float32)


def weighted_median(values, weights):
    """Per-row weighted median of `values` (V,K) with `weights` (V,K). Returns
    (V,). Far more robust to a single bad neighbor than a weighted mean. Rows
    whose weights sum to ~0 return their plain median (caller handles fallback)."""
    order = np.argsort(values, axis=1)
    vs = np.take_along_axis(values, order, axis=1)
    ws = np.take_along_axis(weights, order, axis=1)
    cum = np.cumsum(ws, axis=1)
    half = 0.5 * cum[:, -1:]
    # first sorted index where the cumulative weight reaches the half-mass
    idx = np.argmax(cum >= np.maximum(half, 1e-12), axis=1)
    return vs[np.arange(values.shape[0]), idx]


def extend_motion_to_canvas_field(target_seeds, driver_seeds, driver_tracks, driver_vis):
    """Move full-canvas vertices using nearby performer-track displacement.

    `driver_tracks` are real CoTracker outputs seeded on the performer. Each
    target vertex takes the distance-and-visibility weighted MEDIAN of its
    nearest drivers' displacement, so one runaway driver can't drag the vertex.
    If all nearby drivers are invisible for a frame, it falls back to the static
    distance-weighted median to avoid holes/flicker in the full-screen field.
    """
    if len(driver_seeds) == 0:
        raise SystemExit("No performer seeds available to drive full-screen field.")

    neighbor_count = max(1, min(FIELD_NEIGHBORS, len(driver_seeds)))
    distances = np.linalg.norm(target_seeds[:, None, :] - driver_seeds[None, :, :], axis=2)
    nearest = np.argpartition(distances, neighbor_count - 1, axis=1)[:, :neighbor_count]
    nearest_distances = np.take_along_axis(distances, nearest, axis=1)
    base_weights = 1.0 / np.maximum(nearest_distances, 1.0) ** FIELD_POWER

    driver_displacements = driver_tracks - driver_seeds[None, :, :]
    T = driver_tracks.shape[0]
    tracks = np.empty((T, len(target_seeds), 2), dtype=np.float32)

    for t in range(T):
        frame_displacements = driver_displacements[t, nearest, :]
        confidence = driver_vis[t, nearest].astype(np.float32)
        weights = base_weights * confidence
        use_fallback = weights.sum(axis=1) <= 1e-6

        dx = weighted_median(frame_displacements[:, :, 0], weights)
        dy = weighted_median(frame_displacements[:, :, 1], weights)
        fx = weighted_median(frame_displacements[:, :, 0], base_weights)
        fy = weighted_median(frame_displacements[:, :, 1], base_weights)
        dx[use_fallback] = fx[use_fallback]
        dy[use_fallback] = fy[use_fallback]
        tracks[t] = target_seeds + np.stack([dx, dy], axis=1)

    # The output field is intentionally visible everywhere. Driver visibility
    # has already been consumed as weighting confidence above.
    vis = np.ones((T, len(target_seeds)), dtype=np.uint8)
    return tracks, vis


def smooth_tracks(tracks, sigma):
    """De-jitter each vertex trajectory over time. Savitzky-Golay (default)
    removes jitter while preserving real velocity; Gaussian is the old low-pass
    that also blurs genuine fast motion."""
    if sigma <= 0:
        return tracks
    T = tracks.shape[0]
    if SMOOTH_METHOD == "savgol":
        window = min(SAVGOL_WINDOW, T if T % 2 else T - 1)
        if window >= SAVGOL_POLY + 2 and window >= 3:
            return savgol_filter(tracks, window, SAVGOL_POLY, axis=0, mode="nearest").astype(np.float32)
        print(f"  clip too short for savgol (T={T}); falling back to gaussian")
    smoothed = tracks.copy()
    smoothed[:, :, 0] = ndimage.gaussian_filter1d(tracks[:, :, 0], sigma, axis=0, mode="nearest")
    smoothed[:, :, 1] = ndimage.gaussian_filter1d(tracks[:, :, 1], sigma, axis=0, mode="nearest")
    return smoothed


def prune_drivers(tracks, vis):
    """Drop drivers (the M axis) that are unreliable before they feed the field:
    runaway points (worst per-frame jump far above the robust norm) and points
    that are visible for too little of the clip. Returns a boolean keep mask."""
    if tracks.shape[0] < 2:
        return np.ones(tracks.shape[1], bool)
    disp = np.diff(tracks, axis=0)
    worst_jump = np.hypot(disp[:, :, 0], disp[:, :, 1]).max(axis=0)
    med = float(np.median(worst_jump))
    mad = float(np.median(np.abs(worst_jump - med))) + 1e-6
    speed_ok = worst_jump <= med + PRUNE_SPEED_MAD_K * 1.4826 * mad
    vis_ok = vis.mean(axis=0) >= PRUNE_MIN_MEAN_VIS
    return speed_ok & vis_ok


def temporal_jitter(tracks, vis=None):
    """Mean per-vertex frame-to-frame acceleration (px/frame^2) — a scalar that
    quantifies residual jitter so runs can be compared without eyeballing."""
    if tracks.shape[0] < 3:
        return 0.0
    acc = np.diff(tracks, n=2, axis=0)
    mag = np.hypot(acc[:, :, 0], acc[:, :, 1])
    if vis is not None:
        weight = (vis[1:-1] > 0)
        if weight.sum() == 0:
            return 0.0
        return float(mag[weight].mean())
    return float(mag.mean())


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


def write_overlay(frames, tracks, vis, step=10, prefix="trk"):
    DEBUG_OVERLAY_DIR.mkdir(parents=True, exist_ok=True)
    T = frames.shape[0]
    for t in range(0, T, step):
        img = Image.fromarray(frames[t], mode="RGBA").convert("RGB")
        draw = ImageDraw.Draw(img)
        for n in range(tracks.shape[1]):
            x, y = tracks[t, n]
            color = (0, 220, 255) if vis[t, n] else (255, 60, 60)
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=color)
        img.save(DEBUG_OVERLAY_DIR / f"{prefix}{t:04d}.png")


def track_cotracker(frames, queries):
    """CoTracker3 offline, bidirectional. Returns tracks (T,M,2) and a
    continuous confidence (T,M) in [0,1] (the model's visibility probability)."""
    print("Loading CoTracker3 (offline) ...")
    model = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline")
    model = model.to(DEVICE).eval()
    rgb = frames[:, :, :, :3].astype(np.float32)
    video = torch.from_numpy(rgb).permute(0, 3, 1, 2)[None].to(DEVICE)  # 1,T,3,H,W
    q = torch.from_numpy(queries)[None].to(DEVICE)  # 1,M,3
    print(f"Tracking {len(queries)} points across {frames.shape[0]} frames (CoTracker, bidirectional) ...")
    with torch.no_grad():
        tracks, conf = model(video, queries=q, backward_tracking=True)
    tracks = tracks[0].cpu().numpy()
    conf = conf[0].cpu().numpy().astype(np.float32)
    return tracks, conf


def track_bootstapir_backend(frames, queries):
    """BootsTAPIR via the vendored torch port. Same return contract as
    track_cotracker: tracks (T,M,2) and continuous confidence (T,M)."""
    sys.path.insert(0, str(Path(__file__).parent))
    from bootstapir_tracker import track_bootstapir
    print(f"Tracking {len(queries)} points across {frames.shape[0]} frames (BootsTAPIR) ...")
    tracks, _vis, conf = track_bootstapir(frames[:, :, :, :3].copy(), queries, device=DEVICE)
    return tracks, conf


def run_tracker(name, frames, queries):
    """Dispatch to a single tracker, returning (tracks, conf) with conf in [0,1].
    'blend' runs both and keeps the more confident tracker per point per frame."""
    if name == "cotracker":
        return track_cotracker(frames, queries)
    if name == "bootstapir":
        return track_bootstapir_backend(frames, queries)
    if name == "blend":
        ta, ca = track_cotracker(frames, queries)
        tb, cb = track_bootstapir_backend(frames, queries)
        pick_b = (cb > ca)[:, :, None]  # T,M,1 — choose BootsTAPIR where it's surer
        tracks = np.where(pick_b, tb, ta).astype(np.float32)
        conf = np.maximum(ca, cb)
        print(f"Blended trackers: BootsTAPIR chosen for {float(pick_b.mean()) * 100:.1f}% of point-frames")
        return tracks, conf
    raise SystemExit(f"Unknown TRACKER={name!r} (use cotracker|bootstapir|blend)")


def compare_trackers(frames, queries, base_count, ref_idx):
    """Run CoTracker and BootsTAPIR on the same seeds, write side-by-side driver
    overlays, and print a hand/arm-survival / jitter / drift table. Extra drivers
    (columns >= base_count) are the thin hand/sleeve/edge seeds, so their
    survival is the headline 'do the hands stay tracked' number."""
    extra = slice(base_count, queries.shape[0])

    def metrics(tracks, conf):
        vis = (conf > 0.5).astype(np.uint8)
        drift = np.hypot(*(tracks[-1] - tracks[0]).T)  # per-point end-to-start px
        return {
            "vis_all": float(vis.mean()),
            "vis_hand": float(vis[:, extra].mean()) if extra.start < queries.shape[0] else float("nan"),
            "jitter": temporal_jitter(tracks, vis),
            "drift_mean": float(drift.mean()),
            "drift_p95": float(np.percentile(drift, 95)),
        }

    results = {}
    for name, fn in (("cotracker", track_cotracker), ("bootstapir", track_bootstapir_backend)):
        tracks, conf = fn(frames, queries)
        results[name] = (tracks, conf, metrics(tracks, conf))
        write_overlay(frames, tracks, (conf > 0.5).astype(np.uint8), prefix=f"{name}_drv")

    print("\n=== Tracker comparison (same seed points, raw / pre-smoothing) ===")
    cols = ["vis_all", "vis_hand", "jitter", "drift_mean", "drift_p95"]
    labels = {
        "vis_all": "survival all", "vis_hand": "survival hand/arm",
        "jitter": "jitter px/f^2", "drift_mean": "drift mean px", "drift_p95": "drift p95 px",
    }
    higher_better = {"vis_all", "vis_hand"}
    print(f"{'metric':20s}{'cotracker':>14s}{'bootstapir':>14s}{'winner':>14s}")
    for c in cols:
        cv, bv = results["cotracker"][2][c], results["bootstapir"][2][c]
        if c in higher_better:
            win = "bootstapir" if bv > cv else "cotracker"
        else:
            win = "bootstapir" if bv < cv else "cotracker"
        print(f"{labels[c]:20s}{cv:>14.3f}{bv:>14.3f}{win:>14s}")
    print(f"\nOverlays written to {DEBUG_OVERLAY_DIR} (cotracker_drv*.png, bootstapir_drv*.png)")


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
    base_driver_seeds = driver_seeds[valid_idx]
    extra_driver_seeds = sample_extra_driver_points(trackable, base_driver_seeds)
    query_seeds = np.concatenate([base_driver_seeds, extra_driver_seeds], axis=0)
    base_driver_count = len(base_driver_seeds)
    ref_col = np.full((len(query_seeds), 1), float(ref_idx), np.float32)
    queries = np.concatenate([ref_col, query_seeds], axis=1)
    print(
        f"Seeded {base_driver_count}/{total} grid cells on body "
        f"plus {len(extra_driver_seeds)} extra hand/edge drivers"
    )

    if COMPARE_TRACKERS:
        compare_trackers(frames, queries, base_driver_count, ref_idx)
        return

    print(f"Running tracker={TRACKER} on device={DEVICE} ...", flush=True)
    tracks_v, conf_v = run_tracker(TRACKER, frames, queries)
    vis_v = (conf_v > 0.5).astype(np.uint8)  # T,M
    print(f"Tracked with {TRACKER}: {tracks_v.shape}, mean visibility {vis_v.mean():.2f}")

    tracks_v = smooth_tracks(tracks_v, SMOOTH_SIGMA)
    tracks_v, mean_drift = close_loop(tracks_v, LOOP_CLOSE)
    if LOOP_CLOSE > 0:
        print(f"Loop closure: distributed {mean_drift:.1f}px mean end-to-start drift")

    if PER_FRAME_MASK:
        print("Building per-frame garment masks to refine driver visibility ...")
        masks = [build_garment_mask(frames[t, :, :, :3]) for t in range(T)]
        vis_v = visibility_from_masks(tracks_v, masks, vis_v)
        print(f"Refined driver mean visibility {vis_v.mean():.2f}")

    if VIS_CLOSE > 1 or VIS_OPEN > 1:
        before = int(np.abs(np.diff(vis_v.astype(np.int16), axis=0)).sum())
        vis_v = stabilize_visibility(vis_v, VIS_CLOSE, VIS_OPEN)
        after = int(np.abs(np.diff(vis_v.astype(np.int16), axis=0)).sum())
        print(f"Driver visibility stabilized: {before} -> {after} transitions")

    if FULL_SCREEN_FIELD:
        keep = prune_drivers(tracks_v, vis_v)
        dropped = int((~keep).sum())
        print(f"Driver pruning: kept {int(keep.sum())}/{len(keep)} drivers ({dropped} dropped)")
        d_seeds = query_seeds[keep]
        d_tracks = tracks_v[:, keep, :]
        d_vis = vis_v[:, keep]
        uv, seeds = seed_canvas_grid()
        tracks, vis = extend_motion_to_canvas_field(seeds, d_seeds, d_tracks, d_vis)
        print(
            f"Extended performer motion to full-canvas field "
            f"({GRID_COLS}x{GRID_ROWS}, {FIELD_NEIGHBORS} neighbors, power={FIELD_POWER:g})"
        )
        if GARMENT_VIS_REFINE:
            print("Refining full-canvas visibility to garment-only ...")
            garment_masks = [build_garment_mask(frames[t, :, :, :3]) for t in range(T)]
            for t in range(T):
                for i in range(tracks.shape[1]):
                    x = int(round(tracks[t, i, 0]))
                    y = int(round(tracks[t, i, 1]))
                    if 0 <= x < CANVAS_WIDTH and 0 <= y < CANVAS_HEIGHT and garment_masks[t][y, x]:
                        vis[t, i] = 1
                    else:
                        vis[t, i] = 0
            print(f"Garment visibility mean {vis.mean():.2f}")
        else:
            # Keep the field fully visible; the static garment mask is the gate.
            print("Full-canvas visibility kept at 1 (static garment mask is the scratch gate)")
    else:
        # Scatter tracked (valid) cells back into the regular driver grid.
        # Invalid cells (off-body in the reference frame) stay at their seed
        # position with vis=0, which the renderer skips.
        uv, seeds = driver_uv, driver_seeds
        tracks = np.tile(seeds[None], (T, 1, 1)).astype(np.float32)  # T,total,2
        vis = np.zeros((T, total), dtype=np.uint8)
        tracks[:, valid_idx, :] = tracks_v[:, :base_driver_count, :]
        vis[:, valid_idx] = vis_v[:, :base_driver_count]

    print(
        f"Temporal jitter (mean accel): drivers={temporal_jitter(tracks_v, vis_v):.3f} "
        f"px/f^2, output field={temporal_jitter(tracks, vis):.3f} px/f^2"
    )

    if DEBUG_OVERLAY:
        write_overlay(frames, tracks, vis)
        write_overlay(frames, tracks_v, vis_v, prefix="drv")
        print(f"Wrote tracked overlays to {DEBUG_OVERLAY_DIR} (trk*=output field, drv*=driver points)")

    out_frames = []
    for t in range(T):
        out_frames.append({
            "t": round(t / FPS, 3),
            "verts": [[round(float(x), 1), round(float(y), 1)] for x, y in tracks[t]],
            "vis": [int(v) for v in vis[t]],
        })

    garment_ref = None
    if FULL_SCREEN_FIELD:
        ref_garment = build_garment_mask(frames[ref_idx, :, :, :3])
        garment_ref = []
        for x, y in seeds:
            xi = int(round(float(x)))
            yi = int(round(float(y)))
            on_garment = (
                0 <= xi < CANVAS_WIDTH
                and 0 <= yi < CANVAS_HEIGHT
                and bool(ref_garment[yi, xi])
            )
            garment_ref.append(int(on_garment))
        print(f"Reference garment vertices {sum(garment_ref)}/{len(garment_ref)}")

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    # Compact (no indentation) — this ships to the browser, so keep it small.
    payload = {
        "source": str(INPUT_VIDEO.relative_to(REPO_ROOT)) if INPUT_VIDEO.is_relative_to(REPO_ROOT) else str(INPUT_VIDEO),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": f"{TRACKER}-full-field-v9" if FULL_SCREEN_FIELD else f"{TRACKER}-grid-v5",
        "tracker": TRACKER,
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "fps": FPS,
        "durationSeconds": round(duration, 3),
        "refFrame": int(ref_idx),
        "smoothMethod": SMOOTH_METHOD,
        "smoothSigma": SMOOTH_SIGMA,
        "savgolWindow": SAVGOL_WINDOW if SMOOTH_METHOD == "savgol" else None,
        "savgolPoly": SAVGOL_POLY if SMOOTH_METHOD == "savgol" else None,
        "pruneSpeedMadK": PRUNE_SPEED_MAD_K if FULL_SCREEN_FIELD else None,
        "pruneMinMeanVis": PRUNE_MIN_MEAN_VIS if FULL_SCREEN_FIELD else None,
        "loopClose": LOOP_CLOSE,
        "perFrameMask": PER_FRAME_MASK,
        "visClose": VIS_CLOSE,
        "visOpen": VIS_OPEN,
        "fullScreenField": FULL_SCREEN_FIELD,
        "fieldNeighbors": FIELD_NEIGHBORS if FULL_SCREEN_FIELD else None,
        "fieldPower": FIELD_POWER if FULL_SCREEN_FIELD else None,
        "driverSeedCount": int(len(query_seeds)),
        "baseDriverSeedCount": int(base_driver_count),
        "extraDriverSeedCount": int(len(extra_driver_seeds)),
        "extraDriverMinDistance": EXTRA_DRIVER_MIN_DISTANCE,
        "extraDriverStride": EXTRA_DRIVER_STRIDE,
        "mesh": {"cols": GRID_COLS, "rows": GRID_ROWS},
        "uv": [[round(float(u), 4), round(float(v), 4)] for u, v in uv],
        "frames": out_frames,
    }
    if garment_ref is not None:
        payload["garment"] = garment_ref
    OUTPUT_JSON.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    size_mb = OUTPUT_JSON.stat().st_size / 1e6
    print(f"Wrote {T} mesh frames to {OUTPUT_JSON} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
