#!/usr/bin/env python3
"""
Grok (x.ai) video dress edit.

Pick a video + a text prompt; Grok's video-edit endpoint returns a new video
that keeps the original framing/motion/scene and changes what the prompt asks
for (e.g. the dress). Output duration, resolution and aspect ratio match the
input automatically.

  XAI_API_KEY=sk-... python scripts/grok-dress-edit.py \
      --video public/cards/girl_1/foreground.mp4 \
      --prompt "Replace only her dress with a long red satin gown. Keep the
                person, face, pose, hair, lighting and background exactly the
                same." \
      --out .tmp/girl_1_red.mp4

Notes / honest limitations:
- The edit endpoint is prompt-driven video-to-video. It is NOT a masked edit, so
  non-dress pixels are re-synthesized and may drift slightly (face/lighting/bg).
  Prompt it to "keep everything else the same" to minimise that.
- Grok limits: duration <= ~8.7s, resolution <= 720p. This script NEVER converts
  or downscales — it uploads the original file untouched and simply REJECTS clips
  that exceed the limits.
- The exact request schema for /v1/videos/edits is not fully published; the two
  uncertain bits (input-video field name, model id) are constants below. If the
  API rejects the request, the printed error tells you which to adjust.

Requires: ffmpeg + ffprobe on PATH. No third-party Python deps (stdlib only).
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --- API config -------------------------------------------------------------
API_BASE = os.environ.get("XAI_API_BASE", "https://api.x.ai")
EDITS_PATH = "/v1/videos/edits"
POLL_PATH = "/v1/videos/{request_id}"
CHAT_PATH = "/v1/chat/completions"
# Chat model used by --enhance to rewrite the edit prompt. Override if your
# account uses a different id (e.g. grok-3, grok-4-latest).
DEFAULT_CHAT_MODEL = os.environ.get("XAI_CHAT_MODEL", "grok-4")
# Model id for video edits. Keep this separate from image/video generation
# because some generation models are rejected by /v1/videos/edits.
DEFAULT_MODEL = os.environ.get("XAI_VIDEO_EDIT_MODEL", "grok-imagine-video")
# JSON field that carries the input video for /v1/videos/edits. Image endpoints
# use image:{url}; we mirror that as video:{url}. Override with --video-field.
DEFAULT_VIDEO_FIELD = os.environ.get("XAI_VIDEO_FIELD", "video")

# --- Grok limits ------------------------------------------------------------
MAX_DURATION_S = 8.7
MAX_SHORT_SIDE = 720  # "720p" cap; we bound the shorter side, preserving aspect
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 600
MAX_INLINE_MB = 18  # base64 data-URI sanity cap


def run(cmd):
    result = subprocess.run(cmd, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def probe(path):
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name:format=duration",
        "-of", "json", str(path),
    ])
    info = json.loads(out)
    stream = info["streams"][0]
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "codec": stream.get("codec_name", "?"),
        "duration": float(info["format"]["duration"]),
    }


def compatible_size(width: int, height: int) -> tuple[int, int]:
    short_side = min(width, height)
    if short_side <= MAX_SHORT_SIDE:
        return width, height
    scale = MAX_SHORT_SIDE / short_side
    next_width = max(2, round(width * scale / 2) * 2)
    next_height = max(2, round(height * scale / 2) * 2)
    return next_width, next_height


def prepare_compatible_video(src: Path) -> Path:
    meta = probe(src)
    next_width, next_height = compatible_size(meta["width"], meta["height"])
    if (next_width, next_height) == (meta["width"], meta["height"]):
        return src

    out = src.parent / f"{src.stem}-grok-compatible.mp4"
    print(
        "Preparing Grok-compatible copy: "
        f"{meta['width']}x{meta['height']} -> {next_width}x{next_height}"
    )
    run([
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-map",
        "0:v:0",
        "-vf",
        f"scale={next_width}:{next_height}",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(out),
    ])
    return out


def check_grok_limits(src: Path) -> None:
    """Reject the clip if it exceeds Grok's edit limits."""
    meta = probe(src)
    print(f"Input: {meta['width']}x{meta['height']} {meta['codec']} {meta['duration']:.2f}s")

    problems = []
    if meta["duration"] > MAX_DURATION_S:
        problems.append(f"duration {meta['duration']:.2f}s > {MAX_DURATION_S}s")
    if min(meta["width"], meta["height"]) > MAX_SHORT_SIDE:
        problems.append(f"resolution {meta['width']}x{meta['height']} exceeds {MAX_SHORT_SIDE}p")
    if problems:
        sys.exit(
            "Incompatible with Grok (not uploading): "
            + "; ".join(problems)
            + ". Provide a clip within the limits."
        )


def to_data_uri(path: Path) -> str:
    raw = path.read_bytes()
    mb = len(raw) / 1e6
    if mb > MAX_INLINE_MB:
        sys.exit(
            f"Encoded video is {mb:.1f} MB (> {MAX_INLINE_MB} MB inline cap). "
            f"Host it and pass an https URL via --video instead."
        )
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:video/mp4;base64,{b64}"


ENHANCE_SYSTEM = (
    "You rewrite a short clothing-change instruction into a single precise prompt "
    "for a video EDIT model. Rules: (1) The ONLY change allowed is the dress/outfit "
    "described. Describe it vividly (fabric, color, cut, length, fit). (2) Then "
    "explicitly command the model to keep EVERYTHING else identical: the same "
    "person, face, identity, hair, skin, body, pose, hands, motion, camera, "
    "framing, background, lighting, shadows and colors. (3) Do NOT add scenery, "
    "style, mood, camera moves, effects or details that are not in the input. "
    "(4) Output ONLY the rewritten prompt, one paragraph, no preamble or quotes."
)


def enhance_prompt(prompt, key, model):
    """Rewrite the edit instruction via a Grok chat model into a tighter,
    preservation-focused prompt. Returns the rewritten text (falls back to the
    original on any unexpected response)."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": ENHANCE_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
    }
    result = api_post(CHAT_PATH, payload, key)
    try:
        text = result["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        print("Enhance: unexpected chat response, using original prompt.")
        return prompt
    return text or prompt


def api_post(path, payload, key):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    return _send(req)


def api_get(path, key):
    req = urllib.request.Request(
        API_BASE + path,
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    return _send(req)


def _send(req):
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        sys.exit(f"API error {exc.code} on {req.full_url}:\n{body}")
    except urllib.error.URLError as exc:
        sys.exit(f"Network error contacting {req.full_url}: {exc}")


def main():
    parser = argparse.ArgumentParser(description="Grok video dress edit (video + prompt).")
    parser.add_argument("--video", required=True, help="Local mp4 path or https URL of the source video")
    parser.add_argument("--prompt", required=True, help="Edit instruction, e.g. the new dress")
    parser.add_argument("--out", default=".tmp/grok-edit.mp4", help="Where to save the edited video")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Override the video model id")
    parser.add_argument("--video-field", default=DEFAULT_VIDEO_FIELD, help="Request body field for the input video")
    parser.add_argument("--enhance", action="store_true",
                        help="Rewrite the prompt via a Grok chat model for tighter, preservation-focused edits")
    parser.add_argument("--enhance-model", default=DEFAULT_CHAT_MODEL, help="Chat model id used by --enhance")
    parser.add_argument("--resolution", default="720p",
                        help="Output resolution: 720p (max detail), 480p, auto, or '' to omit the field")
    parser.add_argument("--prepare-compatible", action="store_true",
                        help="Downscale a local input copy when needed so Grok accepts the edit upload")
    args = parser.parse_args()

    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        sys.exit("Set XAI_API_KEY (or GROK_API_KEY) with your x.ai key.")

    is_url = args.video.startswith("http://") or args.video.startswith("https://")
    if is_url:
        video_value = {"url": args.video}
        print(f"Using remote video URL: {args.video}")
    else:
        src = Path(args.video)
        if not src.exists():
            sys.exit(f"Video not found: {src}")
        if args.prepare_compatible:
            src = prepare_compatible_video(src)
        check_grok_limits(src)
        video_value = {"url": to_data_uri(src)}
        print("Encoded video inline (base64 data URI).")

    prompt = args.prompt
    if args.enhance:
        print(f"Enhancing prompt via {args.enhance_model} ...")
        prompt = enhance_prompt(args.prompt, key, args.enhance_model)
        print(f"Enhanced prompt:\n  {prompt}\n")

    payload = {"model": args.model, "prompt": prompt, args.video_field: video_value}
    if args.resolution:
        payload["resolution"] = args.resolution
    print(f"Submitting edit to {API_BASE}{EDITS_PATH} (model={args.model}, resolution={args.resolution or 'default'}) ...")
    submit = api_post(EDITS_PATH, payload, key)
    request_id = submit.get("request_id") or submit.get("id")
    if not request_id:
        sys.exit(f"No request_id in response:\n{json.dumps(submit, indent=2)}")
    print(f"Request id: {request_id} — polling ...")

    started = time.time()
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            sys.exit("Timed out waiting for the edit to finish.")
        result = api_get(POLL_PATH.format(request_id=request_id), key)
        status = result.get("status")
        if status == "done":
            url = (result.get("video") or {}).get("url")
            if not url:
                sys.exit(f"Done but no video url:\n{json.dumps(result, indent=2)}")
            break
        if status in ("failed", "expired"):
            sys.exit(f"Edit {status}:\n{json.dumps(result, indent=2)}")
        print(f"  status={status} ...")
        time.sleep(POLL_INTERVAL_S)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading result -> {out}")
    urllib.request.urlretrieve(url, out)
    print(f"Done: {out}  ({probe(out)['width']}x{probe(out)['height']} {probe(out)['duration']:.2f}s)")


if __name__ == "__main__":
    main()
