"""
Generate garment images using ControlNet conditioned on poses extracted
from the foreground video keyframes.

Usage:
  python scripts/generate-controlnet-frames.py

Output:
  public/cards/controlnet-frames/   — conditioning pose images
  public/cards/controlnet-output/   — ControlNet-generated garment images

First run: pip install -r scripts/requirements-controlnet.txt
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent
KEYFRAMES_JSON = REPO_ROOT / "public/cards/generated-mesh-keyframes.json"
FOREGROUND_VIDEO = REPO_ROOT / "public/cards/Green bg sample 2 swap.mp4"
POSE_DIR = REPO_ROOT / "public/cards/controlnet-frames"
OUTPUT_DIR = REPO_ROOT / "public/cards/controlnet-output"

# ControlNet model — OpenPose conditioning (pose skeleton → garment)
CONTROLNET_ID = "lllyasviel/control_v11p_sd15_openpose"
BASE_MODEL_ID = "runwayml/stable-diffusion-v1-5"

# Generation settings
PROMPT = (
    "a woman wearing a stylish dress, fashion photography, "
    "studio lighting, clean background, high quality, detailed fabric"
)
NEGATIVE_PROMPT = (
    "blurry, low quality, extra limbs, bad anatomy, deformed, "
    "watermark, text, cropped"
)
GUIDANCE_SCALE = 7.5
NUM_INFERENCE_STEPS = 12
OUTPUT_WIDTH = 512
OUTPUT_HEIGHT = 896
SEED = 42

# How many keyframes to process (None = all 75, or set e.g. 10 for a quick test)
MAX_FRAMES = 5


# ---------------------------------------------------------------------------
# Step 1 — extract raw video frames at keyframe timestamps using ffmpeg
# ---------------------------------------------------------------------------

def extract_frames(keyframe_times: list[float]) -> list[Path]:
    POSE_DIR.mkdir(parents=True, exist_ok=True)
    frame_paths = []

    print(f"Extracting {len(keyframe_times)} frames from video...")
    for i, t in enumerate(keyframe_times):
        out_path = POSE_DIR / f"raw_{i:04d}.png"
        if out_path.exists():
            frame_paths.append(out_path)
            continue

        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-ss", str(t),
                "-i", str(FOREGROUND_VIDEO),
                "-frames:v", "1",
                "-q:v", "2",
                str(out_path),
            ],
            check=True,
        )
        frame_paths.append(out_path)

    print(f"  Done — {len(frame_paths)} frames extracted to {POSE_DIR}")
    return frame_paths


# ---------------------------------------------------------------------------
# Step 2 — run OpenPose estimation on each frame to get the conditioning image
# ---------------------------------------------------------------------------

def extract_poses(frame_paths: list[Path]) -> list[Path]:
    from controlnet_aux import OpenposeDetector
    from PIL import Image

    print("Loading OpenPose detector...")
    detector = OpenposeDetector.from_pretrained("lllyasviel/ControlNet")

    pose_paths = []
    for i, fp in enumerate(frame_paths):
        out_path = POSE_DIR / f"pose_{i:04d}.png"
        if out_path.exists():
            pose_paths.append(out_path)
            continue

        print(f"  Pose {i+1}/{len(frame_paths)}: {fp.name}")
        img = Image.open(fp).convert("RGB")
        pose_img = detector(img, detect_resolution=512, image_resolution=OUTPUT_HEIGHT)
        pose_img.save(out_path)
        pose_paths.append(out_path)

    print(f"  Done — pose images saved to {POSE_DIR}")
    return pose_paths


# ---------------------------------------------------------------------------
# Step 3 — run ControlNet generation conditioned on each pose image
# ---------------------------------------------------------------------------

def run_controlnet(pose_paths: list[Path]) -> list[Path]:
    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetPipeline, UniPCMultistepScheduler
    from PIL import Image

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16
    print(f"Using device: {device}")

    print("Loading ControlNet model (first run downloads ~1.5GB)...")
    controlnet = ControlNetModel.from_pretrained(
        CONTROLNET_ID,
        torch_dtype=dtype,
    )

    print("Loading SD 1.5 pipeline (first run downloads ~4GB)...")
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        BASE_MODEL_ID,
        controlnet=controlnet,
        torch_dtype=dtype,
        safety_checker=None,
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
    pipe = pipe.to(device)
    pipe.vae = pipe.vae.to(torch.float32)
    pipe.enable_attention_slicing()

    generator = torch.Generator(device=device).manual_seed(SEED)

    output_paths = []
    for i, pose_path in enumerate(pose_paths):
        out_path = OUTPUT_DIR / f"generated_{i:04d}.png"
        if out_path.exists():
            output_paths.append(out_path)
            print(f"  Frame {i+1}/{len(pose_paths)}: skipped (exists)")
            continue

        print(f"  Generating {i+1}/{len(pose_paths)}: {pose_path.name}")
        pose_img = Image.open(pose_path).convert("RGB").resize((OUTPUT_WIDTH, OUTPUT_HEIGHT))

        # Run UNet in float16 (fast), get raw latents
        latents = pipe(
            prompt=PROMPT,
            negative_prompt=NEGATIVE_PROMPT,
            image=pose_img,
            num_inference_steps=NUM_INFERENCE_STEPS,
            guidance_scale=GUIDANCE_SCALE,
            width=OUTPUT_WIDTH,
            height=OUTPUT_HEIGHT,
            generator=generator,
            output_type="latent",
        ).images

        # Cast latents to float32 before VAE decode to avoid MPS dtype mismatch
        with torch.no_grad():
            latents = latents.to(torch.float32) / pipe.vae.config.scaling_factor
            decoded = pipe.vae.decode(latents).sample
            decoded = (decoded / 2 + 0.5).clamp(0, 1)
            decoded = decoded.permute(0, 2, 3, 1).cpu().numpy()
            decoded = (decoded * 255).round().astype("uint8")
            Image.fromarray(decoded[0]).save(out_path)

        output_paths.append(out_path)

    print(f"  Done — {len(output_paths)} images saved to {OUTPUT_DIR}")
    return output_paths


# ---------------------------------------------------------------------------
# Step 4 — stitch generated images back into a video at the original frame rate
# ---------------------------------------------------------------------------

def stitch_video(output_paths: list[Path], keyframe_times: list[float]):
    video_out = OUTPUT_DIR / "generated_video.mp4"
    filelist = OUTPUT_DIR / "filelist.txt"

    # Build an ffmpeg concat demuxer file with per-segment durations
    lines = []
    for i, path in enumerate(output_paths):
        t_start = keyframe_times[i]
        t_end = keyframe_times[i + 1] if i + 1 < len(keyframe_times) else t_start + (1 / 16)
        duration = t_end - t_start
        lines.append(f"file '{path.resolve()}'\nduration {duration:.4f}")
    # repeat last frame to avoid ffmpeg trimming it
    lines.append(f"file '{output_paths[-1].resolve()}'")
    filelist.write_text("\n".join(lines))

    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(filelist),
            "-vf", f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(video_out),
        ],
        check=True,
    )
    print(f"\nVideo written to: {video_out}")
    return video_out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not FOREGROUND_VIDEO.exists():
        sys.exit(f"Foreground video not found: {FOREGROUND_VIDEO}")

    data = json.loads(KEYFRAMES_JSON.read_text())
    keyframes = data["keyframes"] if "keyframes" in data else data
    times = [kf["time"] for kf in keyframes]

    if MAX_FRAMES:
        # Evenly sample MAX_FRAMES across the full duration
        step = max(1, len(times) // MAX_FRAMES)
        times = times[::step][:MAX_FRAMES]

    print(f"Processing {len(times)} keyframes over {times[-1]:.1f}s\n")

    frame_paths = extract_frames(times)
    pose_paths = extract_poses(frame_paths)
    output_paths = run_controlnet(pose_paths)
    stitch_video(output_paths, times)

    print("\nDone. Drop the generated video into public/cards/ and")
    print("update BOTTOM_VIDEO_SRC in ScratchPrototype.tsx to use it.")


if __name__ == "__main__":
    main()
