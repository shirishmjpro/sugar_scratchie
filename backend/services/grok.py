from __future__ import annotations

import base64
import json
import mimetypes
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


EDITS_PATH = "/v1/videos/edits"
POLL_PATH = "/v1/videos/{request_id}"
CHAT_PATH = "/v1/chat/completions"

MAX_DURATION_S = 8.7
MAX_SHORT_SIDE = 720
MAX_INLINE_MB = 18
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 600

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


def api_key() -> str:
    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        raise RuntimeError("Set XAI_API_KEY (or GROK_API_KEY) with your x.ai key.")
    return key


def api_base() -> str:
    return os.environ.get("XAI_API_BASE", "https://api.x.ai")


def chat_model() -> str:
    return os.environ.get("XAI_CHAT_MODEL", "grok-4")


def run_media_command(cmd: list[str]) -> bytes:
    result = subprocess.run(cmd, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def probe_video(path: Path) -> dict[str, int | float | str]:
    out = run_media_command(
        [
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
        ]
    )
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
    meta = probe_video(src)
    next_width, next_height = compatible_size(int(meta["width"]), int(meta["height"]))
    if (next_width, next_height) == (meta["width"], meta["height"]):
        return src

    out = src.parent / f"{src.stem}-grok-compatible.mp4"
    print(
        "Preparing Grok-compatible copy: "
        f"{meta['width']}x{meta['height']} -> {next_width}x{next_height}"
    )
    run_media_command(
        [
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
        ]
    )
    return out


def check_grok_limits(src: Path) -> None:
    meta = probe_video(src)
    print(f"Input: {meta['width']}x{meta['height']} {meta['codec']} {meta['duration']:.2f}s")

    problems = []
    if float(meta["duration"]) > MAX_DURATION_S:
        problems.append(f"duration {meta['duration']:.2f}s > {MAX_DURATION_S}s")
    if min(int(meta["width"]), int(meta["height"])) > MAX_SHORT_SIDE:
        problems.append(f"resolution {meta['width']}x{meta['height']} exceeds {MAX_SHORT_SIDE}p")
    if problems:
        raise RuntimeError(
            "Incompatible with Grok (not uploading): "
            + "; ".join(problems)
            + ". Provide a clip within the limits."
        )


def to_data_uri(path: Path, mime: str) -> str:
    raw = path.read_bytes()
    mb = len(raw) / 1e6
    if mb > MAX_INLINE_MB:
        raise RuntimeError(
            f"Encoded input is {mb:.1f} MB (> {MAX_INLINE_MB} MB inline cap). "
            "Host it and pass an https URL instead."
        )
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def media_value(value: str | Path, default_mime: str) -> dict[str, str]:
    value_str = str(value)
    if value_str.startswith(("http://", "https://")):
        return {"url": value_str}
    path = Path(value_str)
    if not path.exists():
        raise RuntimeError(f"File not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or default_mime
    return {"url": to_data_uri(path, mime)}


def api_post(path: str, payload: dict, key: str) -> dict:
    req = urllib.request.Request(
        api_base() + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    return send(req)


def api_get(path: str, key: str) -> dict:
    req = urllib.request.Request(
        api_base() + path,
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    return send(req)


def send(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"API error {exc.code} on {req.full_url}:\n{body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error contacting {req.full_url}: {exc}") from exc


def enhance_prompt(prompt: str, key: str, model: str | None = None) -> str:
    model = model or chat_model()
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


def poll_video(request_id: str, key: str, *, label: str = "video generation") -> str:
    print(f"Request id: {request_id} - polling ...")
    started = time.time()
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            raise RuntimeError(f"Timed out waiting for {label}.")
        result = api_get(POLL_PATH.format(request_id=request_id), key)
        status = result.get("status")
        if status == "done":
            url = (result.get("video") or {}).get("url")
            if not url:
                raise RuntimeError(f"Done but no video url:\n{json.dumps(result, indent=2)}")
            return url
        if status in ("failed", "expired"):
            raise RuntimeError(f"{label.title()} {status}:\n{json.dumps(result, indent=2)}")
        print(f"  status={status} ...")
        time.sleep(POLL_INTERVAL_S)


def download_video(url: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading -> {out}")
    urllib.request.urlretrieve(url, out)
    meta = probe_video(out)
    print(f"Saved {out} ({meta['width']}x{meta['height']} {meta['duration']:.2f}s)")


def edit_video(
    *,
    video: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    video_field: str,
    enhance: bool,
    prepare_compatible: bool,
) -> None:
    key = api_key()
    video_str = str(video)
    if video_str.startswith(("http://", "https://")):
        video_value = {"url": video_str}
        print(f"Using remote video URL: {video_str}")
    else:
        src = Path(video_str)
        if not src.exists():
            raise RuntimeError(f"Video not found: {src}")
        if prepare_compatible:
            src = prepare_compatible_video(src)
        check_grok_limits(src)
        video_value = {"url": to_data_uri(src, "video/mp4")}
        print("Encoded video inline (base64 data URI).")

    final_prompt = prompt
    if enhance:
        print(f"Enhancing prompt via {chat_model()} ...")
        final_prompt = enhance_prompt(prompt, key)
        print(f"Enhanced prompt:\n  {final_prompt}\n")

    payload = {"model": model, "prompt": final_prompt, video_field: video_value}
    if resolution:
        payload["resolution"] = resolution
    print(f"Submitting edit to {api_base()}{EDITS_PATH} (model={model}, resolution={resolution or 'default'}) ...")
    submit = api_post(EDITS_PATH, payload, key)
    request_id = submit.get("request_id") or submit.get("id")
    if not request_id:
        raise RuntimeError(f"No request_id in response:\n{json.dumps(submit, indent=2)}")
    video_url = poll_video(request_id, key, label="edit")
    download_video(video_url, out)


def image_to_video(
    *,
    image: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
) -> None:
    key = api_key()
    payload = {
        "model": model,
        "prompt": prompt,
        image_field: media_value(image, "image/png"),
    }
    if resolution:
        payload["resolution"] = resolution

    print(f"Submitting image-to-video to {api_base()}{endpoint} (model={model}) ...")
    submit = api_post(endpoint, payload, key)
    request_id = submit.get("request_id") or submit.get("id")
    if not request_id:
        raise RuntimeError(f"No request_id in response:\n{json.dumps(submit, indent=2)}")
    video_url = poll_video(request_id, key, label="video generation")
    download_video(video_url, out)


def image_dress_flow(
    *,
    image: str | Path,
    motion_prompt: str,
    dress_prompt: str,
    base_video_out: Path,
    out: Path,
    enhance_dress_prompt: bool,
    model: str,
    resolution: str,
    image_field: str,
    video_field: str,
    endpoint: str,
) -> None:
    image_to_video(
        image=image,
        prompt=motion_prompt,
        out=base_video_out,
        model=model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
    )
    print("Starting dress edit on generated video ...")
    edit_video(
        video=base_video_out,
        prompt=dress_prompt,
        out=out,
        model=model,
        resolution=resolution,
        video_field=video_field,
        enhance=enhance_dress_prompt,
        prepare_compatible=True,
    )
    print(f"Flow complete: {out}")
