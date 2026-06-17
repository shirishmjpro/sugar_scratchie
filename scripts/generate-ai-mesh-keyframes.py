"""
Generate mesh keyframes with AI pose anchors plus the foreground mask.

Usage:
  .venv311/bin/python scripts/generate-ai-mesh-keyframes.py

Install:
  scripts/install-ai-mesh-deps.sh

Output:
  public/mesh/generated-ai-mesh-keyframes.json
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
from PIL import Image


REPO_ROOT = Path(__file__).parent.parent
INPUT_VIDEO = REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", REPO_ROOT / "public/mesh/generated-ai-mesh-keyframes.json"))
MPL_CONFIG_DIR = REPO_ROOT / ".tmp" / "matplotlib"

CANVAS_WIDTH = 390
CANVAS_HEIGHT = 672
SAMPLE_INTERVAL_SECONDS = float(os.environ.get("SAMPLE_INTERVAL_SECONDS", "0.25"))
FPS = 1 / SAMPLE_INTERVAL_SECONDS
FRAME_BYTES = CANVAS_WIDTH * CANVAS_HEIGHT * 4
MAX_FRAMES = int(os.environ["MAX_FRAMES"]) if os.environ.get("MAX_FRAMES") else None
POSE_MODEL = os.environ.get("POSE_MODEL", "rtmw-x_8xb320-270e_cocktail14-384x288")
POSE_DEVICE = os.environ.get("POSE_DEVICE")

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


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def normalize(vector):
    length = math.hypot(vector["x"], vector["y"]) or 1
    return {"x": vector["x"] / length, "y": vector["y"] / length}


def dot(a, b):
    return a["x"] * b["x"] + a["y"] * b["y"]


def mix(a, b, amount):
    return a * (1 - amount) + b * amount


def fallback_frame():
    return {
        "origin": {"x": 210, "y": 236},
        "uAxis": normalize({"x": 1, "y": 0.02}),
        "vAxis": normalize({"x": -0.05, "y": 1}),
        "width": 220,
        "height": 410,
    }


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
            f"fps={FPS},scale={CANVAS_WIDTH}:{CANVAS_HEIGHT},format=rgba",
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


def garment_mask(rgba):
    red = rgba[:, :, 0].astype(np.int16)
    green = rgba[:, :, 1].astype(np.int16)
    blue = rgba[:, :, 2].astype(np.int16)
    foreground = chroma_key_mask(rgba)

    is_likely_skin = (red > 145) & (green > 86) & (green < 178) & (blue < 145) & ((red - blue) > 26)
    is_bright_garment = (red > 118) & (green > 118) & (blue > 118)
    is_cool_garment = (blue > 118) & (green > 86) & (blue >= red - 8)
    return foreground & ~is_likely_skin & (is_bright_garment | is_cool_garment)


def mask_bounds(mask):
    ys, xs = np.where(mask)
    if len(xs) < 420:
        return None
    return {
        "left": float(xs.min()),
        "right": float(xs.max()),
        "top": float(ys.min()),
        "bottom": float(ys.max()),
        "centerX": float(xs.mean()),
    }


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


def estimate_frame_from_pose(instance, bounds, previous_frame):
    base = previous_frame or fallback_frame()
    left_shoulder = keypoint(instance, "left_shoulder")
    right_shoulder = keypoint(instance, "right_shoulder")
    left_hip = keypoint(instance, "left_hip")
    right_hip = keypoint(instance, "right_hip")
    left_knee = keypoint(instance, "left_knee")
    right_knee = keypoint(instance, "right_knee")

    shoulder_center = midpoint(left_shoulder, right_shoulder)
    hip_center = midpoint(left_hip, right_hip)
    knee_center = midpoint(left_knee, right_knee)
    torso_center = midpoint(shoulder_center, hip_center) or shoulder_center or hip_center

    if left_shoulder and right_shoulder:
        raw_u_axis = normalize({"x": left_shoulder["x"] - right_shoulder["x"], "y": left_shoulder["y"] - right_shoulder["y"]})
        u_axis = normalize({"x": mix(base["uAxis"]["x"], raw_u_axis["x"], 0.35), "y": mix(base["uAxis"]["y"], raw_u_axis["y"], 0.35)})
    else:
        u_axis = base["uAxis"]

    if shoulder_center and (knee_center or hip_center):
        lower_center = knee_center or hip_center
        raw_v_axis = normalize({"x": lower_center["x"] - shoulder_center["x"], "y": lower_center["y"] - shoulder_center["y"]})
        v_axis = normalize({"x": mix(base["vAxis"]["x"], raw_v_axis["x"], 0.45), "y": mix(base["vAxis"]["y"], raw_v_axis["y"], 0.45)})
    else:
        v_axis = base["vAxis"]

    origin_x = torso_center["x"] if torso_center else base["origin"]["x"]
    if bounds:
        origin_x = mix(origin_x, bounds["centerX"], 0.35)

    origin_y = (shoulder_center["y"] - 10) if shoulder_center else (bounds["top"] - 8 if bounds else base["origin"]["y"])
    if bounds:
        origin_y = mix(origin_y, bounds["top"] - 8, 0.3)

    shoulder_width = abs(left_shoulder["x"] - right_shoulder["x"]) if left_shoulder and right_shoulder else base["width"] * 0.45
    mask_width = (bounds["right"] - bounds["left"]) if bounds else base["width"]
    width = max(shoulder_width * 2.55, mask_width * 0.96)

    if bounds:
        height = bounds["bottom"] - origin_y + 18
    elif knee_center and shoulder_center:
        height = (knee_center["y"] - shoulder_center["y"]) * 1.28
    else:
        height = base["height"]

    detected = {
        "origin": {"x": clamp(origin_x, 120, 270), "y": clamp(origin_y, 198, 260)},
        "uAxis": u_axis,
        "vAxis": v_axis,
        "width": clamp(width, 240, 370),
        "height": clamp(height, 420, 560),
    }

    if not previous_frame:
        return detected

    return {
        "origin": {
            "x": mix(previous_frame["origin"]["x"], detected["origin"]["x"], 0.34),
            "y": mix(previous_frame["origin"]["y"], detected["origin"]["y"], 0.3),
        },
        "uAxis": normalize(
            {
                "x": mix(previous_frame["uAxis"]["x"], detected["uAxis"]["x"], 0.22),
                "y": mix(previous_frame["uAxis"]["y"], detected["uAxis"]["y"], 0.22),
            }
        ),
        "vAxis": normalize(
            {
                "x": mix(previous_frame["vAxis"]["x"], detected["vAxis"]["x"], 0.22),
                "y": mix(previous_frame["vAxis"]["y"], detected["vAxis"]["y"], 0.22),
            }
        ),
        "width": mix(previous_frame["width"], detected["width"], 0.34),
        "height": mix(previous_frame["height"], detected["height"], 0.3),
    }


def bounds_at_row(mask, y, expected_center_x, band):
    min_y = max(0, int(y - band))
    max_y = min(CANVAS_HEIGHT - 1, int(y + band))
    row_band = mask[min_y : max_y + 1, :]
    hits = row_band.sum(axis=0)
    threshold = max(2, round(row_band.shape[0] * 0.16))
    columns = np.where(hits >= threshold)[0]
    if len(columns) < 6:
        return None

    spans = []
    start = columns[0]
    previous = columns[0]
    for column in columns[1:]:
        if column - previous > 4:
            spans.append((start, previous))
            start = column
        previous = column
    spans.append((start, previous))

    spans = [(left, right) for left, right in spans if right - left >= 5]
    if not spans:
        return None

    def span_score(span):
        left, right = span
        center = (left + right) / 2
        width = right - left
        too_wide_penalty = max(0, width - 210) * 1.9
        return width * 4 - abs(center - expected_center_x) * 5 - too_wide_penalty

    left, right = max(spans, key=span_score)
    samples = columns[(columns >= left) & (columns <= right)]
    if len(samples) < 6:
        return None
    trim = 0.08 if right - left > 96 else 0.04
    return {"left": float(np.quantile(samples, trim)), "right": float(np.quantile(samples, 1 - trim))}


def estimate_points(frame, mask, previous_points):
    left_points = []
    right_points = []
    previous_by_id = {point["id"]: point for point in previous_points} if previous_points else {}
    expected_center_x = local_to_world(frame, 0.5, BODY_MESH_ROWS[0]["v"])["x"]
    tracked_rows = 0

    for row in BODY_MESH_ROWS:
        row_center = local_to_world(frame, 0.5, row["v"])
        previous_left = previous_by_id.get(f"left-{row['id']}")
        previous_right = previous_by_id.get(f"right-{row['id']}")
        if previous_left and previous_right:
            left_world = local_to_world(frame, previous_left["u"], row["v"])
            right_world = local_to_world(frame, previous_right["u"], row["v"])
            expected_center_x = (left_world["x"] + right_world["x"]) / 2

        bounds = bounds_at_row(mask, row_center["y"], expected_center_x, 9 if row["v"] < 0.2 else 12)
        if not bounds:
            fallback_left = 0.08 + abs(row["v"] - 0.45) * 0.18
            fallback_right = 0.92 - abs(row["v"] - 0.45) * 0.18
            left_points.append({"id": f"left-{row['id']}", "label": f"L {row['label']}", "u": fallback_left, "v": row["v"]})
            right_points.append({"id": f"right-{row['id']}", "label": f"R {row['label']}", "u": fallback_right, "v": row["v"]})
            continue

        edge_padding = 0.006 if row["v"] < 0.24 else 0.012
        left_local = world_to_local(frame, {"x": bounds["left"], "y": row_center["y"]})
        right_local = world_to_local(frame, {"x": bounds["right"], "y": row_center["y"]})
        expected_center_x = (bounds["left"] + bounds["right"]) / 2
        left_points.append(
            {
                "id": f"left-{row['id']}",
                "label": f"L {row['label']}",
                "u": clamp(left_local["u"] + edge_padding, -0.25, 0.42),
                "v": row["v"],
            }
        )
        right_points.append(
            {
                "id": f"right-{row['id']}",
                "label": f"R {row['label']}",
                "u": clamp(right_local["u"] - edge_padding, 0.58, 1.25),
                "v": row["v"],
            }
        )
        tracked_rows += 1

    points = stabilize_top_points([*left_points, *reversed(right_points)])
    if tracked_rows < 3:
        return previous_points or points
    if not previous_points or len(previous_points) != len(points):
        return points

    smoothed = []
    for point in points:
        previous = previous_by_id.get(point["id"])
        if not previous:
            smoothed.append(point)
            continue
        smoothed.append({**point, "u": mix(previous["u"], point["u"], 0.42), "v": mix(previous["v"], point["v"], 0.28)})
    return smoothed


def stabilize_top_points(points):
    by_id = {point["id"]: point for point in points}
    left_neck = by_id.get("left-neck")
    right_neck = by_id.get("right-neck")
    left_shoulder = by_id.get("left-shoulder")
    right_shoulder = by_id.get("right-shoulder")

    if left_neck and left_shoulder:
        left_neck["u"] = min(left_neck["u"], left_shoulder["u"] + 0.04)
    if right_neck and right_shoulder:
        right_neck["u"] = max(right_neck["u"], right_shoulder["u"] - 0.04)

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
        foreground = chroma_key_mask(rgba)
        garment = garment_mask(rgba)
        bounds = mask_bounds(garment) or mask_bounds(foreground)

        if pose:
            ai_pose_hits += 1
            frame = estimate_frame_from_pose(pose, bounds, previous_frame)
        else:
            frame = previous_frame or fallback_frame()

        points = estimate_points(frame, garment, previous_points)
        keyframes.append({"time": time, "frame": round_frame(frame), "points": round_points(points)})
        previous_frame = frame
        previous_points = points

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(
        json.dumps(
            {
                "source": "public/cards/Green bg sample 2 swap.mp4",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "generator": "ai-rtmw-garment-mask-v2",
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
