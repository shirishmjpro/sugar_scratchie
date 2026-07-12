"""
BootsTAPIR (DeepMind TAP) point tracker, wrapped to match the CoTracker call
used by generate-mesh-tracking.py. Offline / fully local: the torch model code
is vendored under scripts/vendor/tapnet_torch and the checkpoint is cached at
~/.cache/tapnet/bootstapir_checkpoint_v2.pt (downloaded on first use).

Public API:
    tracks, vis, conf = track_bootstapir(frames_rgb, queries, device="mps")

  frames_rgb : (T, H, W, 3) uint8 canvas frames (same as CoTracker input)
  queries    : (M, 3) float32 as (ref_frame_index, x, y) in canvas pixels
               — identical layout to the CoTracker queries, so the same seed
               points drive both trackers.
  returns
  tracks     : (T, M, 2) float32 canvas-pixel positions
  vis        : (T, M) uint8 visibility (1 = visible & confident)
  conf       : (T, M) float32 continuous confidence in [0,1], usable for
               per-point blending against another tracker.

TAPIR works at a fixed square resolution; we resize the canvas into it, scale
the queries in, and scale the predicted tracks back out so coordinates stay in
canvas pixels — directly comparable to CoTracker output.
"""

import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

_VENDOR = Path(__file__).parent / "vendor"
if str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))
from tapnet_torch import tapir_model  # noqa: E402

CHECKPOINT = Path(
    os.environ.get(
        "BOOTSTAPIR_CHECKPOINT",
        Path.home() / ".cache" / "tapnet" / "bootstapir_checkpoint_v2.pt",
    )
)
CHECKPOINT_URL = "https://storage.googleapis.com/dm-tapnet/bootstap/bootstapir_checkpoint_v2.pt"
# Square resolution TAPIR runs at. 256 matches the public demo; raising it
# improves localization at the cost of memory/time.
INFER_RES = int(os.environ.get("BOOTSTAPIR_RES", "256"))
# Visibility threshold on (1-occlusion_prob) * (1-uncertainty_prob).
VIS_THRESHOLD = float(os.environ.get("BOOTSTAPIR_VIS_THRESHOLD", "0.5"))
# Process the queries in chunks to bound peak memory on MPS.
QUERY_CHUNK = int(os.environ.get("BOOTSTAPIR_QUERY_CHUNK", "256"))

_model_cache = {}


def _ensure_checkpoint():
    if CHECKPOINT.exists():
        return
    import urllib.request

    CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading BootsTAPIR checkpoint to {CHECKPOINT} ...")
    urllib.request.urlretrieve(CHECKPOINT_URL, CHECKPOINT)


def _load_model(device):
    if "model" in _model_cache:
        return _model_cache["model"]
    _ensure_checkpoint()
    model = tapir_model.TAPIR(
        pyramid_level=1,
        extra_convs=True,
        use_casual_conv=False,
        softmax_temperature=10.0,
    )
    state = torch.load(CHECKPOINT, map_location="cpu")
    model.load_state_dict(state)
    model = model.to(device).eval()
    _model_cache["model"] = model
    return model


def _preprocess(frames_rgb, device):
    """(T,H,W,3) uint8 -> (1,T,R,R,3) float in [-1,1] at INFER_RES, plus the
    (sx, sy) scale factors from canvas pixels into INFER_RES pixels."""
    T, H, W, _ = frames_rgb.shape
    video = torch.from_numpy(frames_rgb).to(device).float().permute(0, 3, 1, 2)  # T,3,H,W
    video = F.interpolate(video, size=(INFER_RES, INFER_RES), mode="bilinear", align_corners=False)
    video = video / 255.0 * 2.0 - 1.0
    video = video.permute(0, 2, 3, 1)[None]  # 1,T,R,R,3
    return video, (INFER_RES / W, INFER_RES / H)


def track_bootstapir(frames_rgb, queries, device="mps"):
    model = _load_model(device)
    T = frames_rgb.shape[0]
    M = queries.shape[0]
    video, (sx, sy) = _preprocess(frames_rgb, device)
    chunk_count = max(1, (M + QUERY_CHUNK - 1) // QUERY_CHUNK)
    print(
        f"BootsTAPIR: {M} points x {T} frames on {device} "
        f"({chunk_count} chunk{'s' if chunk_count != 1 else ''}, res={INFER_RES}) ...",
        flush=True,
    )

    # CoTracker queries are (t, x, y) in canvas px; TAPIR wants (t, y, x) in
    # inference px.
    q = np.asarray(queries, dtype=np.float32)
    qp = np.stack([q[:, 0], q[:, 2] * sy, q[:, 1] * sx], axis=1)  # (M, 3) = t,y,x
    qp_t = torch.from_numpy(qp).to(device)

    tracks_out = np.empty((T, M, 2), dtype=np.float32)
    vis_out = np.empty((T, M), dtype=np.uint8)
    conf_out = np.empty((T, M), dtype=np.float32)

    for chunk_idx, start in enumerate(range(0, M, QUERY_CHUNK), start=1):
        end = min(start + QUERY_CHUNK, M)
        print(
            f"BootsTAPIR chunk {chunk_idx}/{chunk_count}: "
            f"points {start + 1}-{end} of {M} ...",
            flush=True,
        )
        with torch.no_grad():
            out = model(video, qp_t[start:end][None], query_chunk_size=64)
        tracks = out["tracks"][0]  # (m, T, 2) as (x, y) in INFER_RES px
        occ = out["occlusion"][0]  # (m, T)
        dist = out["expected_dist"][0]  # (m, T)
        conf = (1 - torch.sigmoid(occ)) * (1 - torch.sigmoid(dist))

        tracks = tracks.cpu().numpy()
        tracks[..., 0] /= sx  # back to canvas px
        tracks[..., 1] /= sy
        conf = conf.cpu().numpy()
        tracks_out[:, start:end, :] = tracks.transpose(1, 0, 2)  # T,m,2
        conf_out[:, start:end] = conf.T  # T,m
        vis_out[:, start:end] = (conf > VIS_THRESHOLD).astype(np.uint8).T
        print(f"BootsTAPIR chunk {chunk_idx}/{chunk_count} done.", flush=True)

    return tracks_out, vis_out, conf_out
