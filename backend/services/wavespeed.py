from __future__ import annotations

import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from backend.services.grok import (
    DEFAULT_PORTRAIT_PROMPT,
    DRESS_ENHANCE_SYSTEM,
    FACE_GUIDED_PORTRAIT_PROMPT,
    FACE_SWAP_PROMPT,
    POLL_INTERVAL_S,
    POLL_TIMEOUT_S,
    PROMPT_WITH_FACE_PREFIX,
    API_MAX_RETRIES,
    API_RETRY_BASE_S,
    API_TIMEOUT_S,
    check_grok_limits,
    download_image,
    download_video,
    is_stock_portrait_prompt,
    output_video_ready,
    prepare_compatible_video,
    request_id_sidecar,
    to_data_uri,
)

IMAGE_T2I_PATH = "/x-ai/grok-imagine-image-quality/text-to-image"
IMAGE_EDIT_PATH = "/x-ai/grok-imagine-image-quality/edit"
IMAGE_FACE_SWAP_PATH = "/wavespeed-ai/image-face-swap"
SEEDREAM_T2I_PATH = "/bytedance/seedream-v5.0-lite"
SEEDREAM_EDIT_PATH = "/bytedance/seedream-v5.0-lite/edit"
WAN_SPICY_I2V_PATH = "/wavespeed-ai/wan-2.2-spicy/image-to-video"
WAN_VIDEO_EDIT_PATH = "/wavespeed-ai/wan-2.2/video-edit"
VIDEO_I2V_PATH = "/x-ai/grok-imagine-video-v1.5/image-to-video"
VIDEO_EDIT_PATH = "/x-ai/grok-imagine-video/edit-video"
POLL_PATH = "/predictions/{request_id}/result"

SEEDREAM_FACE_SWAP_PROMPT = (
    "Replace the face in Figure 1 with the face from Figure 2. "
    "Keep body, pose, outfit, background, and lighting identical."
)
SEEDREAM_FACE_GUIDED_PORTRAIT_PROMPT = (
    "Full-body portrait photo of the person from Figure 1, matching their face and identity. "
    "Casual fitted resort wear, plain white studio background, facing camera, fashion editorial."
)
SEEDREAM_PROMPT_WITH_FACE_PREFIX = (
    "Full-body portrait photo of the person from Figure 1, matching their face and identity. "
)


def api_key() -> str:
    key = os.environ.get("WAVESPEED_API_KEY")
    if not key:
        raise RuntimeError("Set WAVESPEED_API_KEY with your WaveSpeed API key.")
    return key


def api_base() -> str:
    return os.environ.get("WAVESPEED_API_BASE", "https://api.wavespeed.ai/api/v3")


def media_url(value: str | Path, default_mime: str) -> str:
    value_str = str(value)
    if value_str.startswith(("http://", "https://", "data:")):
        return value_str
    path = Path(value_str)
    if not path.exists():
        raise RuntimeError(f"File not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or default_mime
    return to_data_uri(path, mime)


def format_http_error(exc: urllib.error.HTTPError, body: str) -> str:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return f"WaveSpeed API error {exc.code}:\n{body}"
    err = data.get("error") or data.get("message")
    if isinstance(err, str):
        return f"WaveSpeed API error: {err}"
    data_err = data.get("data", {})
    if isinstance(data_err, dict):
        nested = data_err.get("error")
        if isinstance(nested, str) and nested.strip():
            return f"WaveSpeed API error: {nested}"
    return f"WaveSpeed API error {exc.code}:\n{body}"


def send(req: urllib.request.Request, *, retries: int = API_MAX_RETRIES) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            if exc.code in (408, 429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  WaveSpeed API {exc.code} on {req.full_url} "
                    f"(attempt {attempt + 1}/{retries}); retry in {wait}s ..."
                )
                time.sleep(wait)
                last_error = exc
                continue
            raise RuntimeError(format_http_error(exc, body)) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as exc:
            last_error = exc
            if attempt < retries - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  WaveSpeed network error on {req.full_url} "
                    f"(attempt {attempt + 1}/{retries}): {exc}; retry in {wait}s ..."
                )
                time.sleep(wait)
                continue
            break
    raise RuntimeError(f"Network error contacting {req.full_url}: {last_error}") from last_error


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


def unwrap_data(result: dict) -> dict:
    data = result.get("data")
    if isinstance(data, dict):
        return data
    return result


def submit_task(path: str, payload: dict, key: str, *, label: str) -> str:
    print(f"Submitting {label} to {api_base()}{path} ...")
    submit = unwrap_data(api_post(path, payload, key))
    request_id = submit.get("id") or submit.get("request_id")
    if not request_id:
        raise RuntimeError(f"No task id in WaveSpeed response:\n{json.dumps(submit, indent=2)}")
    return str(request_id)


def poll_task(request_id: str, key: str, *, label: str) -> list[str]:
    print(f"WaveSpeed task {request_id} — polling ...")
    started = time.time()
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            raise RuntimeError(f"Timed out waiting for WaveSpeed {label}.")
        result = unwrap_data(api_get(POLL_PATH.format(request_id=request_id), key))
        status = result.get("status")
        if status == "completed":
            outputs = result.get("outputs")
            if not isinstance(outputs, list) or not outputs:
                raise RuntimeError(
                    f"WaveSpeed {label} completed but no outputs:\n{json.dumps(result, indent=2)}"
                )
            urls = [entry for entry in outputs if isinstance(entry, str) and entry.strip()]
            if not urls:
                raise RuntimeError(
                    f"WaveSpeed {label} completed but outputs were empty:\n{json.dumps(result, indent=2)}"
                )
            return urls
        if status in ("failed", "expired", "cancelled"):
            err = result.get("error")
            if isinstance(err, str) and err.strip():
                raise RuntimeError(f"WaveSpeed {label} failed: {err}")
            raise RuntimeError(f"WaveSpeed {label} {status}:\n{json.dumps(result, indent=2)}")
        print(f"  status={status} ...")
        time.sleep(POLL_INTERVAL_S)


def run_image_task(path: str, payload: dict, out: Path, *, label: str, force: bool = False) -> None:
    key = api_key()
    if force:
        out.unlink(missing_ok=True)
    elif out.exists() and out.stat().st_size > 0:
        print(f"Using existing {label}: {out.name}")
        return
    request_id = submit_task(path, payload, key, label=label)
    urls = poll_task(request_id, key, label=label)
    download_image(urls[0], out)


def submit_video_job(
    *,
    path: str,
    payload: dict,
    out: Path,
    label: str,
) -> str:
    key = api_key()
    sidecar = request_id_sidecar(out)
    if output_video_ready(out):
        sidecar.unlink(missing_ok=True)
        return ""

    if sidecar.exists():
        request_id = sidecar.read_text(encoding="utf-8").strip()
        if request_id:
            print(f"Resuming WaveSpeed {label} for task id: {request_id}")
            return request_id

    request_id = submit_task(path, payload, key, label=label)
    sidecar.write_text(request_id, encoding="utf-8")
    return request_id


def finish_video_job(request_id: str, out: Path, *, label: str) -> None:
    if not request_id:
        return
    key = api_key()
    urls = poll_task(request_id, key, label=label)
    download_video(urls[0], out)
    request_id_sidecar(out).unlink(missing_ok=True)


def aspect_ratio_to_seedream_size(aspect_ratio: str) -> str:
    mapping = {
        "9:16": "1440*2560",
        "16:9": "2560*1440",
        "1:1": "2048*2048",
        "3:4": "1536*2048",
        "4:3": "2048*1536",
    }
    return mapping.get(aspect_ratio.strip(), "1440*2560")


def generate_portrait_image_seedream(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    size = aspect_ratio_to_seedream_size(aspect_ratio)
    if face_image:
        user_customized = bool(prompt.strip()) and not is_stock_portrait_prompt(prompt)
        final_prompt = (
            f"{SEEDREAM_PROMPT_WITH_FACE_PREFIX}{text}"
            if user_customized
            else SEEDREAM_FACE_GUIDED_PORTRAIT_PROMPT
        )
        payload = {
            "prompt": final_prompt,
            "images": [media_url(face_image, "image/png")],
            "size": size,
            "output_format": "png",
            "enable_base64_output": False,
            "enable_sync_mode": False,
        }
        run_image_task(SEEDREAM_EDIT_PATH, payload, out, label="seedream portrait edit")
    else:
        payload = {
            "prompt": text,
            "size": size,
            "output_format": "png",
            "enable_base64_output": False,
            "enable_sync_mode": False,
        }
        run_image_task(SEEDREAM_T2I_PATH, payload, out, label="seedream portrait generation")
    return out


def generate_portrait_image(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    if face_image:
        user_customized = bool(prompt.strip()) and not is_stock_portrait_prompt(prompt)
        final_prompt = (
            f"{PROMPT_WITH_FACE_PREFIX}{text}" if user_customized else FACE_GUIDED_PORTRAIT_PROMPT
        )
        payload = {
            "prompt": final_prompt,
            "image": media_url(face_image, "image/png"),
            "aspect_ratio": aspect_ratio,
            "resolution": "1k",
            "num_images": 1,
            "output_format": "png",
        }
        run_image_task(IMAGE_EDIT_PATH, payload, out, label="portrait edit")
    else:
        payload = {
            "prompt": text,
            "aspect_ratio": aspect_ratio,
            "resolution": "1k",
            "num_images": 1,
            "output_format": "png",
        }
        run_image_task(IMAGE_T2I_PATH, payload, out, label="portrait generation")
    return out


def swap_face_on_image_seedream(
    *,
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    final_prompt = prompt.strip() if prompt and prompt.strip() else SEEDREAM_FACE_SWAP_PROMPT
    payload = {
        "prompt": final_prompt,
        "images": [
            media_url(base_image, "image/png"),
            media_url(face_image, "image/png"),
        ],
        "size": aspect_ratio_to_seedream_size(aspect_ratio),
        "output_format": "png",
        "enable_base64_output": False,
        "enable_sync_mode": False,
    }
    run_image_task(SEEDREAM_EDIT_PATH, payload, out, label="seedream face swap")
    return out


def swap_face_on_image(
    *,
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    del prompt, aspect_ratio
    payload = {
        "image": media_url(base_image, "image/png"),
        "face_image": media_url(face_image, "image/png"),
        "output_format": "png",
    }
    run_image_task(IMAGE_FACE_SWAP_PATH, payload, out, label="face swap")
    return out


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
    del model, image_field, endpoint
    payload = {
        "prompt": prompt,
        "image": media_url(image, "image/png"),
        "resolution": resolution or "720p",
        "duration": 6,
    }
    request_id = submit_video_job(
        path=VIDEO_I2V_PATH,
        payload=payload,
        out=out,
        label="image-to-video",
    )
    finish_video_job(request_id, out, label="image-to-video")


def image_to_video_wan_spicy(
    *,
    image: str | Path,
    prompt: str,
    out: Path,
    resolution: str = "720p",
    duration: int = 5,
) -> None:
    res = resolution if resolution in ("480p", "720p") else "720p"
    dur = 8 if duration == 8 else 5
    payload = {
        "prompt": prompt,
        "image": media_url(image, "image/png"),
        "resolution": res,
        "duration": dur,
        "seed": -1,
    }
    request_id = submit_video_job(
        path=WAN_SPICY_I2V_PATH,
        payload=payload,
        out=out,
        label="wan-2.2-spicy image-to-video",
    )
    finish_video_job(request_id, out, label="wan-2.2-spicy image-to-video")


def edit_video_wan22(
    *,
    video: str | Path,
    prompt: str,
    out: Path,
    resolution: str = "720p",
    reference_image: str | Path | None = None,
) -> None:
    video_str = str(video)
    if video_str.startswith(("http://", "https://", "data:")):
        video_url = video_str
    else:
        src = Path(video_str)
        if not src.exists():
            raise RuntimeError(f"Video not found: {src}")
        src = prepare_compatible_video(src)
        check_grok_limits(src)
        video_url = media_url(src, "video/mp4")

    final_prompt = prompt.strip()
    reference_str = str(reference_image).strip() if reference_image is not None else ""
    if reference_str:
        print("WAN 2.2 video edit: describe the outfit in the prompt (reference image is not sent).")

    res = resolution if resolution in ("480p", "720p") else "720p"
    payload = {
        "prompt": final_prompt,
        "video": video_url,
        "resolution": res,
        "seed": -1,
    }
    request_id = submit_video_job(
        path=WAN_VIDEO_EDIT_PATH,
        payload=payload,
        out=out,
        label="wan-2.2 video edit",
    )
    finish_video_job(request_id, out, label="wan-2.2 video edit")


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
    enhance_system: str = DRESS_ENHANCE_SYSTEM,
    reference_image: str | Path | None = None,
    reference_field: str = "image",
) -> None:
    del model, video_field, enhance, enhance_system, reference_field
    if enhance:
        print("WaveSpeed provider: skipping prompt enhancement (x.ai chat not available).")
    reference_str = str(reference_image).strip() if reference_image is not None else ""
    if reference_str:
        print(
            "WaveSpeed provider: dress reference image is ignored — "
            "describe the outfit in the dress prompt."
        )

    video_str = str(video)
    if video_str.startswith(("http://", "https://", "data:")):
        video_url = video_str
        print(f"Using remote video URL: {video_str}")
    else:
        src = Path(video_str)
        if not src.exists():
            raise RuntimeError(f"Video not found: {src}")
        if prepare_compatible:
            src = prepare_compatible_video(src)
        check_grok_limits(src)
        video_url = media_url(src, "video/mp4")
        print("Encoded video inline for WaveSpeed.")

    payload = {
        "prompt": prompt,
        "video": video_url,
        "resolution": resolution or "720p",
    }
    request_id = submit_video_job(
        path=VIDEO_EDIT_PATH,
        payload=payload,
        out=out,
        label="video edit",
    )
    finish_video_job(request_id, out, label="video edit")
