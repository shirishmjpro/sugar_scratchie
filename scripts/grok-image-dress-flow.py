#!/usr/bin/env python3
"""
Generate a video from a still image, then edit that generated video into a
different dress/outfit.

This intentionally mirrors scripts/grok-dress-edit.py and keeps the exact xAI
image-to-video request shape configurable because the video API schema may vary
by account/model.
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


API_BASE = os.environ.get("XAI_API_BASE", "https://api.x.ai")
IMAGE_TO_VIDEO_PATH = os.environ.get("XAI_IMAGE_TO_VIDEO_PATH", "/v1/videos/generations")
POLL_PATH = "/v1/videos/{request_id}"
DEFAULT_VIDEO_MODEL = os.environ.get("XAI_VIDEO_MODEL", "grok-imagine-video-1.5")
DEFAULT_IMAGE_FIELD = os.environ.get("XAI_IMAGE_FIELD", "image")
DEFAULT_VIDEO_FIELD = os.environ.get("XAI_VIDEO_FIELD", "video")
MAX_INLINE_MB = 18
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 600


def run(cmd):
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr or result.stdout}")
    return result.stdout


def probe(path):
    out = run([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name:format=duration",
        "-of",
        "json",
        str(path),
    ])
    info = json.loads(out)
    stream = info["streams"][0]
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "codec": stream.get("codec_name", "?"),
        "duration": float(info["format"]["duration"]),
    }


def to_data_uri(path, mime):
    raw = path.read_bytes()
    mb = len(raw) / 1e6
    if mb > MAX_INLINE_MB:
        sys.exit(
            f"Encoded input is {mb:.1f} MB (> {MAX_INLINE_MB} MB inline cap). "
            "Host it and pass an https URL instead."
        )
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def media_value(value, mime):
    if value.startswith("http://") or value.startswith("https://"):
        return {"url": value}
    path = Path(value)
    if not path.exists():
        sys.exit(f"File not found: {path}")
    return {"url": to_data_uri(path, mime)}


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


def poll_video(request_id, key):
    print(f"Request id: {request_id} — polling ...")
    started = time.time()
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            sys.exit("Timed out waiting for video generation.")
        result = api_get(POLL_PATH.format(request_id=request_id), key)
        status = result.get("status")
        if status == "done":
            url = (result.get("video") or {}).get("url")
            if not url:
                sys.exit(f"Done but no video url:\n{json.dumps(result, indent=2)}")
            return url
        if status in ("failed", "expired"):
            sys.exit(f"Generation {status}:\n{json.dumps(result, indent=2)}")
        print(f"  status={status} ...")
        time.sleep(POLL_INTERVAL_S)


def download(url, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading -> {out}")
    urllib.request.urlretrieve(url, out)
    meta = probe(out)
    print(f"Saved {out} ({meta['width']}x{meta['height']} {meta['duration']:.2f}s)")


def main():
    parser = argparse.ArgumentParser(description="Image -> video -> dress edit flow.")
    parser.add_argument("--image", required=True, help="Local image path or https URL")
    parser.add_argument("--motion-prompt", required=True, help="Prompt for animating the still image")
    parser.add_argument("--dress-prompt", required=True, help="Prompt for the dress/outfit edit")
    parser.add_argument("--base-video-out", default=".tmp/image-video-base.mp4")
    parser.add_argument("--out", default=".tmp/image-dress-video.mp4")
    parser.add_argument("--model", default=DEFAULT_VIDEO_MODEL)
    parser.add_argument("--resolution", default="720p")
    parser.add_argument("--image-field", default=DEFAULT_IMAGE_FIELD)
    parser.add_argument("--video-field", default=DEFAULT_VIDEO_FIELD)
    parser.add_argument("--endpoint", default=IMAGE_TO_VIDEO_PATH)
    parser.add_argument("--enhance-dress-prompt", action="store_true")
    args = parser.parse_args()

    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        sys.exit("Set XAI_API_KEY (or GROK_API_KEY) with your x.ai key.")

    payload = {
        "model": args.model,
        "prompt": args.motion_prompt,
        args.image_field: media_value(args.image, "image/png"),
    }
    if args.resolution:
        payload["resolution"] = args.resolution

    print(f"Submitting image-to-video to {API_BASE}{args.endpoint} (model={args.model}) ...")
    submit = api_post(args.endpoint, payload, key)
    request_id = submit.get("request_id") or submit.get("id")
    if not request_id:
        sys.exit(f"No request_id in response:\n{json.dumps(submit, indent=2)}")
    video_url = poll_video(request_id, key)

    base_video = Path(args.base_video_out)
    download(video_url, base_video)

    edit_cmd = [
        sys.executable,
        "scripts/grok-dress-edit.py",
        "--video",
        str(base_video),
        "--prompt",
        args.dress_prompt,
        "--out",
        args.out,
        "--model",
        args.model,
        "--video-field",
        args.video_field,
        "--resolution",
        args.resolution,
    ]
    if args.enhance_dress_prompt:
        edit_cmd.append("--enhance")
    print("Starting dress edit on generated video ...")
    subprocess.run(edit_cmd, check=True)
    print(f"Flow complete: {args.out}")


if __name__ == "__main__":
    main()
