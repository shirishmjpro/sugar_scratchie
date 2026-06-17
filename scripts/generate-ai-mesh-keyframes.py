"""
Generate mesh keyframes with AI pose anchors plus the foreground silhouette.

Usage:
  .venv/bin/python scripts/generate-ai-mesh-keyframes.py

Install:
  scripts/install-ai-mesh-deps.sh

Output:
  public/mesh/generated-ai-mesh-keyframes.json

Env knobs:
  MAX_FRAMES       process only the first N frames (debugging)
  DEBUG_OVERLAY=1  also write per-frame cage overlays to .tmp/gen_overlay
"""

import json
import math
import os
import subprocess
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage


REPO_ROOT = Path(__file__).parent.parent
INPUT_VIDEO = REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", REPO_ROOT / "public/mesh/generated-ai-mesh-keyframes.json"))
MPL_CONFIG_DIR = REPO_ROOT / ".tmp" / "matplotlib"
DEBUG_OVERLAY_DIR = REPO_ROOT / ".tmp" / "gen_overlay"

CANVAS_WIDTH = 390
CANVAS_HEIGHT = 672
SAMPLE_INTERVAL_SECONDS = float(os.environ.get("SAMPLE_INTERVAL_SECONDS", "0.25"))
FPS = 1 / SAMPLE_INTERVAL_SECONDS
FRAME_BYTES = CANVAS_WIDTH * CANVAS_HEIGHT * 4
MAX_FRAMES = int(os.environ["MAX_FRAMES"]) if os.environ.get("MAX_FRAMES") else None
DEBUG_OVERLAY = bool(os.environ.get("DEBUG_OVERLAY"))
POSE_MODEL = os.environ.get("POSE_MODEL", "rtmw-x_8xb320-270e_cocktail14-384x288")
POSE_DEVICE = os.environ.get("POSE_DEVICE")

# Body-cage rows, from the neck (v=0) down to the legs (v~1). These mirror the
# rows the prototype renderer expects in src/ScratchPrototype.tsx.
BODY_MESH_ROWS = [
    {"id": "neck", "label": "Neck", "v": 0.025},
    {"id": "shoulder", "label": "Shoulder", "v": 0.075},
    {"id": "upper-arm", "label": "Upper", "v": 0.13},
    {"id": "underarm", "label": "Under", "v": 0.19},
    {"id": "bust", "label": "Bust", "v": 0.25},
    {"id": "chest", "label": "Chest", "v": 0.31},
    {"id": "rib", "label": "Rib", "v": 0.38},
    {"id": "mid-waist", "label": "M Waist", "v": 0.45},
    {"id": "waist", "label": "Waist", "v": 0.52},
    {"id": "high-hip", "label": "H Hip", "v": 0.59},
    {"id": "hip", "label": "Hip", "v": 0.66},
    {"id": "upper-thigh", "label": "U Thigh", "v": 0.73},
    {"id": "mid-thigh", "label": "M Thigh", "v": 0.8},
    {"id": "thigh", "label": "Thigh", "v": 0.87},
    {"id": "knee", "label": "Knee", "v": 0.93},
    {"id": "leg", "label": "Leg", "v": 0.985},
]

# Fallback silhouette used only when the mask fails for a row (matches the
# prototype's STABLE_BODY_CAGE_PROFILE so behaviour degrades gracefully).
FALLBACK_PROFILE = [
    (0.0, 0.39, 0.61),
    (0.05, 0.31, 0.69),
    (0.12, 0.20, 0.80),
    (0.22, 0.18, 0.82),
    (0.34, 0.23, 0.77),
    (0.48, 0.29, 0.71),
    (0.62, 0.22, 0.78),
    (0.78, 0.27, 0.73),
    (0.92, 0.32, 0.68),
    (1.0, 0.36, 0.64),
]

KEYPOINTS = {
    "nose": 0,
    "left_shoulder": 5,
    "right_shoulder": 6,
    "left_elbow": 7,
    "right_elbow": 8,
    "left_wrist": 9,
    "right_wrist": 10,
    "left_hip": 11,
    "right_hip": 12,
    "left_knee": 13,
    "right_knee": 14,
    "left_ankle": 15,
    "right_ankle": 16,
}

# v at which each landmark sits inside the cage, used to derive frame height.
LANDMARK_V = {"ankle_center": 0.985, "knee_center": 0.93, "hip_center": 0.66}

# How much of the frame width the widest body row should occupy. A value of
# 0.64 places the widest silhouette edges near u=0.18 / u=0.82, matching the
# range the renderer's curved body-wrap expects.
WIDEST_ROW_U_SPAN = 0.64
NECK_LIFT_RATIO = 0.10  # lift origin above the shoulders by this fraction of the torso
MAX_TILT = math.radians(14)  # clamp body lean so the cage never flips sideways
FRAME_SMOOTHING = 0.5  # how strongly each frame follows the new detection
EDGE_SMOOTHING = 0.55


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def normalize(vector):
    length = math.hypot(vector["x"], vector["y"]) or 1
    return {"x": vector["x"] / length, "y": vector["y"] / length}


def dot(a, b):
    return a["x"] * b["x"] + a["y"] * b["y"]


def mix(a, b, amount):
    return a * (1 - amount) + b * amount


def perpendicular_down(u_axis):
    # Rotate +90 degrees; for a near-horizontal u-axis this points downward.
    return normalize({"x": -u_axis["y"], "y": u_axis["x"]})


def fallback_frame():
    return {
        "origin": {"x": CANVAS_WIDTH / 2, "y": CANVAS_HEIGHT * 0.15},
        "uAxis": {"x": 1.0, "y": 0.0},
        "vAxis": {"x": 0.0, "y": 1.0},
        "width": 300.0,
        "height": 540.0,
    }


def fallback_edges(v):
    profile = FALLBACK_PROFILE
    if v <= profile[0][0]:
        return profile[0][1], profile[0][2]
    if v >= profile[-1][0]:
        return profile[-1][1], profile[-1][2]
    for first, second in zip(profile, profile[1:]):
        if first[0] <= v <= second[0]:
            blend = (v - first[0]) / ((second[0] - first[0]) or 1)
            return mix(first[1], second[1], blend), mix(first[2], second[2], blend)
    return profile[0][1], profile[0][2]


def local_to_world(frame, u, v):
    x = (u - 0.5) * frame["width"]
    y = v * frame["height"]
    return {
        "x": frame["origin"]["x"] + frame["uAxis"]["x"] * x + frame["vAxis"]["x"] * y,
        "y": frame["origin"]["y"] + frame["uAxis"]["y"] * x + frame["vAxis"]["y"] * y,
    }


def world_to_local(frame, point):
    relative = {"x": point["x"] - frame["origin"]["x"], "y": point["y"] - frame["origin"]["y"]}
    return {
        "u": dot(relative, frame["uAxis"]) / frame["width"] + 0.5,
        "v": dot(relative, frame["vAxis"]) / frame["height"],
    }


def run(command, args, encoding=None):
    result = subprocess.run([command, *args], check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{command} failed:\n{result.stderr.decode(errors='replace')}")
    if encoding:
        return result.stdout.decode(encoding)
    return result.stdout


def get_duration():
    output = run(
        "ffprobe",
        [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(INPUT_VIDEO),
        ],
        encoding="utf8",
    )
    return float(output.strip())


def load_video_frames():
    raw_video = run(
        "ffmpeg",
        [
            "-v",
            "error",
            "-i",
            str(INPUT_VIDEO),
            "-vf",
            (
                f"fps={FPS},"
                f"scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,"
                f"pad={CANVAS_WIDTH}:{CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x00ff00,"
                "format=rgba"
            ),
            "-f",
            "rawvideo",
            "pipe:1",
        ],
    )
    frame_count = len(raw_video) // FRAME_BYTES
    if MAX_FRAMES:
        frame_count = min(frame_count, MAX_FRAMES)

    for frame_index in range(frame_count):
        start = frame_index * FRAME_BYTES
        frame = np.frombuffer(raw_video[start : start + FRAME_BYTES], dtype=np.uint8)
        yield frame_index, frame.reshape((CANVAS_HEIGHT, CANVAS_WIDTH, 4)).copy()


def chroma_key_mask(rgba):
    red = rgba[:, :, 0].astype(np.int16)
    green = rgba[:, :, 1].astype(np.int16)
    blue = rgba[:, :, 2].astype(np.int16)
    alpha = rgba[:, :, 3].astype(np.int16)
    green_dominance = green - np.maximum(red, blue)
    keyed_alpha = alpha.copy()
    keyed_alpha[(green > 130) & (green_dominance > 38)] = np.maximum(0, 255 - green_dominance * 6)[
        (green > 130) & (green_dominance > 38)
    ]
    return keyed_alpha > 72


def clean_silhouette(rgba):
    """Chroma-key foreground, hole-filled and reduced to its largest blob.

    The green screen makes the foreground a reliable body silhouette; cleaning
    it removes green spill speckle and the dark gaps inside the glowing garment
    so per-row edge scans stay on the true body outline.
    """
    mask = chroma_key_mask(rgba)
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=1)
    filled = ndimage.binary_fill_holes(mask)
    labels, count = ndimage.label(filled)
    if count == 0:
        return filled
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(counts.argmax())


def silhouette_span(mask, y, center_x, band):
    """Left/right edge of the silhouette blob nearest ``center_x`` at row ``y``."""
    top = max(0, int(round(y - band)))
    bottom = min(CANVAS_HEIGHT - 1, int(round(y + band)))
    strip = mask[top : bottom + 1, :]
    if strip.shape[0] == 0:
        return None
    hits = strip.sum(axis=0)
    threshold = max(1, round(strip.shape[0] * 0.34))
    columns = np.where(hits >= threshold)[0]
    if len(columns) < 4:
        return None

    spans = []
    start = previous = columns[0]
    for column in columns[1:]:
        if column - previous > 6:
            spans.append((start, previous))
            start = column
        previous = column
    spans.append((start, previous))
    spans = [(left, right) for left, right in spans if right - left >= 3]
    if not spans:
        return None

    inside = [span for span in spans if span[0] - 5 <= center_x <= span[1] + 5]
    if inside:
        left, right = max(inside, key=lambda span: span[1] - span[0])
    else:
        left, right = min(spans, key=lambda span: abs((span[0] + span[1]) / 2 - center_x))
    return float(left), float(right)


def keypoint(instance, name, min_score=0.15):
    keypoints = instance.get("keypoints")
    if keypoints is None:
        return None
    scores = instance.get("keypoint_scores")
    index = KEYPOINTS[name]
    if index >= len(keypoints):
        return None
    if scores is not None and index < len(scores) and scores[index] < min_score:
        return None

    point = keypoints[index]
    if point is None or len(point) < 2:
        return None

    return {"x": float(point[0]), "y": float(point[1])}


def midpoint(*points):
    valid = [point for point in points if point is not None]
    if not valid:
        return None
    return {
        "x": sum(point["x"] for point in valid) / len(valid),
        "y": sum(point["y"] for point in valid) / len(valid),
    }


def choose_pose(instances):
    if not instances:
        return None

    def score(instance):
        left_shoulder = keypoint(instance, "left_shoulder")
        right_shoulder = keypoint(instance, "right_shoulder")
        shoulder_center = midpoint(left_shoulder, right_shoulder)
        hip_center = midpoint(keypoint(instance, "left_hip"), keypoint(instance, "right_hip"))
        center_penalty = 0 if not shoulder_center else abs(shoulder_center["x"] - CANVAS_WIDTH / 2) * 0.02
        torso_bonus = 3 if shoulder_center and hip_center else 0
        scores = instance.get("keypoint_scores") or []
        score_sum = float(sum(scores)) if scores else 0.0
        score_mean = score_sum / max(len(scores), 1)
        return score_mean * 20 + torso_bonus - center_penalty

    return max(instances, key=score)


def pose_anchor(instance):
    left_shoulder = keypoint(instance, "left_shoulder")
    right_shoulder = keypoint(instance, "right_shoulder")
    return {
        "left_shoulder": left_shoulder,
        "right_shoulder": right_shoulder,
        "shoulder_center": midpoint(left_shoulder, right_shoulder),
        "hip_center": midpoint(keypoint(instance, "left_hip"), keypoint(instance, "right_hip")),
        "knee_center": midpoint(keypoint(instance, "left_knee"), keypoint(instance, "right_knee")),
        "ankle_center": midpoint(keypoint(instance, "left_ankle"), keypoint(instance, "right_ankle")),
    }


def estimate_frame(anchor, mask, previous_frame):
    """Build an orthonormal body box from the pose, scaled by the silhouette."""
    base = previous_frame or fallback_frame()
    shoulder_center = anchor["shoulder_center"]
    hip_center = anchor["hip_center"]
    if not shoulder_center:
        return base

    left_shoulder = anchor["left_shoulder"]
    right_shoulder = anchor["right_shoulder"]
    if left_shoulder and right_shoulder:
        raw = normalize({"x": left_shoulder["x"] - right_shoulder["x"], "y": left_shoulder["y"] - right_shoulder["y"]})
        angle = clamp(math.atan2(raw["y"], raw["x"]), -MAX_TILT, MAX_TILT)
        u_axis = {"x": math.cos(angle), "y": math.sin(angle)}
    else:
        u_axis = base["uAxis"]
    v_axis = perpendicular_down(u_axis)

    torso = math.hypot(hip_center["x"] - shoulder_center["x"], hip_center["y"] - shoulder_center["y"]) if hip_center else 150.0
    neck_lift = max(12.0, torso * NECK_LIFT_RATIO)
    origin = {
        "x": shoulder_center["x"] - v_axis["x"] * neck_lift,
        "y": shoulder_center["y"] - v_axis["y"] * neck_lift,
    }

    bottom = anchor["ankle_center"] or anchor["knee_center"] or hip_center
    bottom_v = (
        LANDMARK_V["ankle_center"]
        if anchor["ankle_center"]
        else LANDMARK_V["knee_center"]
        if anchor["knee_center"]
        else LANDMARK_V["hip_center"]
    )
    if bottom:
        projection = (bottom["x"] - origin["x"]) * v_axis["x"] + (bottom["y"] - origin["y"]) * v_axis["y"]
        height = projection / bottom_v
    else:
        height = base["height"]

    widths = []
    if shoulder_center and hip_center:
        for fraction in (0.15, 0.35, 0.55, 0.75, 0.95):
            sample_y = shoulder_center["y"] + (hip_center["y"] - shoulder_center["y"]) * fraction
            span = silhouette_span(mask, sample_y, shoulder_center["x"], 6)
            if span:
                widths.append(span[1] - span[0])
    body_width = float(np.percentile(widths, 75)) if widths else base["width"] * WIDEST_ROW_U_SPAN
    width = body_width / WIDEST_ROW_U_SPAN

    detected = {
        "origin": origin,
        "uAxis": u_axis,
        "vAxis": v_axis,
        "width": clamp(width, 220.0, 470.0),
        "height": clamp(height, 360.0, 760.0),
    }

    if not previous_frame:
        return detected

    blended_u = normalize(
        {
            "x": mix(previous_frame["uAxis"]["x"], detected["uAxis"]["x"], FRAME_SMOOTHING),
            "y": mix(previous_frame["uAxis"]["y"], detected["uAxis"]["y"], FRAME_SMOOTHING),
        }
    )
    return {
        "origin": {
            "x": mix(previous_frame["origin"]["x"], detected["origin"]["x"], FRAME_SMOOTHING),
            "y": mix(previous_frame["origin"]["y"], detected["origin"]["y"], FRAME_SMOOTHING),
        },
        "uAxis": blended_u,
        "vAxis": perpendicular_down(blended_u),
        "width": mix(previous_frame["width"], detected["width"], FRAME_SMOOTHING),
        "height": mix(previous_frame["height"], detected["height"], FRAME_SMOOTHING),
    }


def estimate_edges(frame, mask, anchor, previous_points):
    previous_by_id = {point["id"]: point for point in previous_points} if previous_points else {}

    left_shoulder = anchor.get("left_shoulder")
    right_shoulder = anchor.get("right_shoulder")
    shoulder_left_u = world_to_local(frame, left_shoulder)["u"] if left_shoulder else None
    shoulder_right_u = world_to_local(frame, right_shoulder)["u"] if right_shoulder else None

    band = max(4.0, frame["height"] * 0.018)
    center_x = local_to_world(frame, 0.5, 0.4)["x"]
    left_points = []
    right_points = []
    tracked = 0

    for row in BODY_MESH_ROWS:
        row_center = local_to_world(frame, 0.5, row["v"])
        previous_left = previous_by_id.get(f"left-{row['id']}")
        previous_right = previous_by_id.get(f"right-{row['id']}")
        if previous_left and previous_right:
            left_world = local_to_world(frame, previous_left["u"], row["v"])
            right_world = local_to_world(frame, previous_right["u"], row["v"])
            center_x = (left_world["x"] + right_world["x"]) / 2

        span = silhouette_span(mask, row_center["y"], center_x, band)
        if span:
            left_u = world_to_local(frame, {"x": span[0], "y": row_center["y"]})["u"]
            right_u = world_to_local(frame, {"x": span[1], "y": row_center["y"]})["u"]
            center_x = (span[0] + span[1]) / 2
            tracked += 1
        else:
            left_u, right_u = fallback_edges(row["v"])

        # Hair drapes over the shoulders, so cap the top rows to the shoulder
        # keypoints to keep the cage on the body instead of the hair.
        if row["v"] <= 0.105 and shoulder_left_u is not None and shoulder_right_u is not None:
            inner = min(shoulder_left_u, shoulder_right_u)
            outer = max(shoulder_left_u, shoulder_right_u)
            left_u = max(left_u, inner - 0.04)
            right_u = min(right_u, outer + 0.04)

        left_u = clamp(left_u, -0.2, 0.45)
        right_u = clamp(right_u, 0.55, 1.2)
        if previous_left:
            left_u = mix(previous_left["u"], left_u, EDGE_SMOOTHING)
        if previous_right:
            right_u = mix(previous_right["u"], right_u, EDGE_SMOOTHING)

        left_points.append({"id": f"left-{row['id']}", "label": f"L {row['label']}", "u": left_u, "v": row["v"]})
        right_points.append({"id": f"right-{row['id']}", "label": f"R {row['label']}", "u": right_u, "v": row["v"]})

    points = [*left_points, *reversed(right_points)]
    if tracked < 3 and previous_points:
        return previous_points
    return points


def round_frame(frame):
    return {
        "origin": {"x": round(frame["origin"]["x"], 3), "y": round(frame["origin"]["y"], 3)},
        "uAxis": {"x": round(frame["uAxis"]["x"], 6), "y": round(frame["uAxis"]["y"], 6)},
        "vAxis": {"x": round(frame["vAxis"]["x"], 6), "y": round(frame["vAxis"]["y"], 6)},
        "width": round(frame["width"], 3),
        "height": round(frame["height"], 3),
    }


def round_points(points):
    return [{"id": point["id"], "label": point["label"], "u": round(point["u"], 4), "v": round(point["v"], 4)} for point in points]


def write_debug_overlay(frame_index, rgba, frame, points):
    DEBUG_OVERLAY_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.fromarray(rgba, mode="RGBA").convert("RGB")
    draw = ImageDraw.Draw(image)

    quad = [local_to_world(frame, u, v) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1))]
    draw.polygon([(p["x"], p["y"]) for p in quad], outline=(255, 235, 0))
    origin = frame["origin"]
    draw.ellipse([origin["x"] - 3, origin["y"] - 3, origin["x"] + 3, origin["y"] + 3], fill=(255, 235, 0))

    cage = [local_to_world(frame, point["u"], point["v"]) for point in points]
    draw.line([(p["x"], p["y"]) for p in cage] + [(cage[0]["x"], cage[0]["y"])], fill=(255, 40, 40), width=2)
    for point in cage:
        draw.ellipse([point["x"] - 2, point["y"] - 2, point["x"] + 2, point["y"] + 2], fill=(0, 200, 255))

    image.save(DEBUG_OVERLAY_DIR / f"ov{frame_index:03d}.png")


def prepare_mmpose_runtime():
    os.environ.setdefault("MPLCONFIGDIR", str(MPL_CONFIG_DIR))
    MPL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    repo_root = str(REPO_ROOT)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    # MMPose imports EDPose unconditionally, which pulls in optional mmcv ops
    # not needed for RTMW inference on this project.
    if "mmpose.models.heads.transformer_heads" not in sys.modules:
        stub = types.ModuleType("mmpose.models.heads.transformer_heads")
        stub.EDPoseHead = object
        sys.modules["mmpose.models.heads.transformer_heads"] = stub


def build_pose_inferencer():
    prepare_mmpose_runtime()

    try:
        from mmpose.apis import MMPoseInferencer
    except ImportError as error:
        raise SystemExit(
            "MMPose is required for the AI mesh generator. "
            "Install dependencies with: .venv/bin/pip install -r scripts/requirements-ai-mesh.txt"
        ) from error

    print(f"Loading RTMW pose model: {POSE_MODEL}")
    return MMPoseInferencer(
        pose2d=POSE_MODEL,
        det_model="whole_image",
        device=POSE_DEVICE,
    )


def detect_pose(inferencer, rgb_frame):
    result = next(inferencer(rgb_frame, return_vis=False))
    predictions = result.get("predictions") or []
    if not predictions:
        return None
    instances = predictions[0] if isinstance(predictions[0], list) else predictions
    return choose_pose(instances)


def main():
    if not INPUT_VIDEO.exists():
        sys.exit(f"Foreground video not found: {INPUT_VIDEO}")

    duration = get_duration()
    inferencer = build_pose_inferencer()

    keyframes = []
    previous_frame = None
    previous_points = None
    ai_pose_hits = 0

    for frame_index, rgba in load_video_frames():
        time = round(frame_index * SAMPLE_INTERVAL_SECONDS, 2)
        print(f"Frame {frame_index + 1}: {time:.2f}s")

        rgb = np.array(Image.fromarray(rgba, mode="RGBA").convert("RGB"))
        pose = detect_pose(inferencer, rgb)
        silhouette = clean_silhouette(rgba)

        if pose:
            ai_pose_hits += 1
            anchor = pose_anchor(pose)
            frame = estimate_frame(anchor, silhouette, previous_frame)
        else:
            anchor = {"left_shoulder": None, "right_shoulder": None}
            frame = previous_frame or fallback_frame()

        points = estimate_edges(frame, silhouette, anchor, previous_points)
        keyframes.append({"time": time, "frame": round_frame(frame), "points": round_points(points)})
        if DEBUG_OVERLAY:
            write_debug_overlay(frame_index, rgba, frame, points)
        previous_frame = frame
        previous_points = points

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(
        json.dumps(
            {
                "source": "public/cards/Green bg sample 2 swap.mp4",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "generator": "ai-rtmw-silhouette-cage-v4",
                "poseModel": POSE_MODEL,
                "sampleIntervalSeconds": SAMPLE_INTERVAL_SECONDS,
                "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
                "durationSeconds": round(duration, 3),
                "aiPoseFrames": ai_pose_hits,
                "keyframes": keyframes,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Generated {len(keyframes)} AI mesh keyframes at {OUTPUT_JSON}")
    print(f"AI pose detected in {ai_pose_hits}/{len(keyframes)} frames")


if __name__ == "__main__":
    main()
