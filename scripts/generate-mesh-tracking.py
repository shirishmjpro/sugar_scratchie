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

REPO_ROOT = Path(__file__).parent.parent
INPUT_VIDEO = REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", REPO_ROOT / "public/mesh/tracked-mesh.json"))
DEBUG_OVERLAY_DIR = REPO_ROOT / ".tmp" / "track_overlay"

CANVAS_WIDTH = 390
CANVAS_HEIGHT = 672
FRAME_BYTES = CANVAS_WIDTH * CANVAS_HEIGHT * 4
FPS = float(os.environ.get("FPS", "10"))
MAX_FRAMES = int(os.environ["MAX_FRAMES"]) if os.environ.get("MAX_FRAMES") else None
GRID_COLS = int(os.environ.get("GRID_COLS", "12"))
GRID_ROWS = int(os.environ.get("GRID_ROWS", "18"))
DEVICE = os.environ.get("DEVICE", "mps")
DEBUG_OVERLAY = bool(os.environ.get("DEBUG_OVERLAY"))


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


def row_span(mask, y):
    """Left/right x of the silhouette at integer row y, or None."""
    row = mask[y]
    xs = np.where(row)[0]
    if len(xs) < 3:
        return None
    return float(xs.min()), float(xs.max())


def seed_grid(mask):
    """Place a GRID_COLS x GRID_ROWS lattice onto the body in frame 0. Each row
    is spread across that row's silhouette span, so every vertex starts on the
    garment and the UV grid is regular. Returns (queries Nx3 [t,x,y], uv Nx2)."""
    ys = np.where(mask.any(axis=1))[0]
    if len(ys) == 0:
        raise SystemExit("Frame 0 silhouette is empty; cannot seed grid.")
    top, bottom = int(ys.min()), int(ys.max())

    # The garment starts at the shoulders, not the top of the head. Find the
    # shoulder line as the first row (scanning down) where the silhouette widens
    # to half its max width, so the grid skips the head/hair.
    widths = mask.sum(axis=1).astype(float)
    max_width = widths[top:bottom + 1].max()
    shoulder_y = top
    for y in range(top, bottom + 1):
        if widths[y] >= 0.5 * max_width:
            shoulder_y = y
            break

    # inset vertically so top/bottom rows sit just inside the garment
    top_inset = shoulder_y + (bottom - shoulder_y) * 0.01
    bottom_inset = bottom - (bottom - shoulder_y) * 0.02

    queries, uv = [], []
    for j in range(GRID_ROWS):
        v = j / (GRID_ROWS - 1)
        y = top_inset + (bottom_inset - top_inset) * v
        span = row_span(mask, int(round(y)))
        if span is None:
            # fall back to nearest spanned row
            for dy in range(1, 40):
                span = row_span(mask, int(round(y)) - dy) or row_span(mask, int(round(y)) + dy)
                if span:
                    break
        if span is None:
            continue
        left, right = span
        inset = (right - left) * 0.04
        left, right = left + inset, right - inset
        for i in range(GRID_COLS):
            u = i / (GRID_COLS - 1)
            x = left + (right - left) * u
            queries.append([0.0, x, y])
            uv.append([u, v])
    return np.array(queries, dtype=np.float32), np.array(uv, dtype=np.float32)


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

    mask0 = clean_silhouette(frames[0])
    queries, uv = seed_grid(mask0)
    print(f"Seeded {len(queries)} grid points ({GRID_COLS}x{GRID_ROWS} lattice)")

    print("Loading CoTracker3 (offline) ...")
    model = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline")
    model = model.to(DEVICE).eval()

    # video: B,T,3,H,W ; rgb only
    rgb = frames[:, :, :, :3].astype(np.float32)
    video = torch.from_numpy(rgb).permute(0, 3, 1, 2)[None].to(DEVICE)  # 1,T,3,H,W
    q = torch.from_numpy(queries)[None].to(DEVICE)  # 1,N,3

    print(f"Tracking {len(queries)} points across {T} frames on {DEVICE} ...")
    with torch.no_grad():
        tracks, vis = model(video, queries=q)
    tracks = tracks[0].cpu().numpy()  # T,N,2
    vis = (vis[0].cpu().numpy() > 0.5).astype(np.uint8)  # T,N
    print(f"Tracked: tracks {tracks.shape}, mean visibility {vis.mean():.2f}")

    if DEBUG_OVERLAY:
        write_overlay(frames, tracks, vis)
        print(f"Wrote tracked overlays to {DEBUG_OVERLAY_DIR}")

    out_frames = []
    for t in range(T):
        out_frames.append({
            "t": round(t / FPS, 3),
            "verts": [[round(float(x), 2), round(float(y), 2)] for x, y in tracks[t]],
            "vis": [int(v) for v in vis[t]],
        })

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps({
        "source": "public/cards/Green bg sample 2 swap.mp4",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": "cotracker3-grid-v1",
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "fps": FPS,
        "durationSeconds": round(duration, 3),
        "mesh": {"cols": GRID_COLS, "rows": GRID_ROWS},
        "uv": [[round(float(u), 4), round(float(v), 4)] for u, v in uv],
        "frames": out_frames,
    }, indent=2) + "\n")
    print(f"Wrote {T} mesh frames to {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
