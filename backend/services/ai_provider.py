from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from backend.services import grok, wavespeed

AiProvider = Literal["xai", "wavespeed"]
SourceImageModel = Literal["grok-imagine", "seedream-v5-lite"]
BackgroundVideoModel = Literal["grok-imagine", "wan-2.2-spicy"]
DressVideoModel = Literal["grok-imagine", "wan-2.2-video-edit"]
SourceImageRoute = Literal["xai", "wavespeed", "seedream-v5-lite"]


def normalize_provider(provider: str | None) -> AiProvider:
    if provider in ("wavespeed", "seedream-v5-lite"):
        return "wavespeed"
    return "xai"


def normalize_source_image_model(
    image_model: str | None,
    *,
    provider: str | None = None,
) -> SourceImageModel:
    if image_model in ("seedream-v5-lite", "seedream-v5.0-lite") or provider in (
        "seedream-v5-lite",
        "seedream-v5.0-lite",
    ):
        return "seedream-v5-lite"
    return "grok-imagine"


def normalize_background_video_model(model: str | None) -> BackgroundVideoModel:
    if model in ("wan-2.2-spicy", "wan-2.2-spicy/image-to-video"):
        return "wan-2.2-spicy"
    return "grok-imagine"


def normalize_dress_video_model(model: str | None) -> DressVideoModel:
    if model in ("wan-2.2-video-edit", "wan-2.2/video-edit"):
        return "wan-2.2-video-edit"
    return "grok-imagine"


def source_image_route(provider: AiProvider, image_model: SourceImageModel) -> SourceImageRoute:
    if provider == "xai":
        return "xai"
    if image_model == "seedream-v5-lite":
        return "seedream-v5-lite"
    return "wavespeed"


def xai_key_available() -> bool:
    return bool(os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"))


def is_moderation_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(
        term in msg
        for term in (
            "content moderation",
            "potentially sensitive",
            "flagged as potentially sensitive",
            "flagged",
        )
    )


def _with_xai_fallback(label: str, route: SourceImageRoute, action):
    if route != "wavespeed":
        return action(grok)
    try:
        return action(wavespeed)
    except RuntimeError as exc:
        if is_moderation_error(exc) and xai_key_available():
            print(f"WaveSpeed {label} blocked by moderation — retrying via x.ai ...")
            try:
                return action(grok)
            except RuntimeError as grok_exc:
                if is_moderation_error(grok_exc):
                    raise RuntimeError(
                        f"Both WaveSpeed and x.ai blocked this {label} (content moderation). "
                        "Use a neutral, fully-clothed studio portrait prompt, or upload a source image instead."
                    ) from grok_exc
                raise
        raise


def generate_portrait_image(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.generate_portrait_image_seedream(
            prompt=prompt,
            out=out,
            face_image=face_image,
            aspect_ratio=aspect_ratio,
        )
    return _with_xai_fallback(
        "portrait generation",
        route,
        lambda module: module.generate_portrait_image(
            prompt=prompt,
            out=out,
            face_image=face_image,
            aspect_ratio=aspect_ratio,
        ),
    )


def swap_face_on_image(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.swap_face_on_image_seedream(
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
        )
    return _with_xai_fallback(
        "face swap",
        route,
        lambda module: module.swap_face_on_image(
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
        ),
    )


def image_to_video(
    *,
    provider: AiProvider,
    image: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    background_video_model: BackgroundVideoModel = "grok-imagine",
    enhance_motion_prompt: bool = True,
) -> None:
    final_prompt = grok.normalize_background_motion_prompt(prompt)
    if enhance_motion_prompt and xai_key_available():
        print(f"Enhancing motion prompt via {grok.chat_model()} ...")
        final_prompt = grok.enhance_prompt(
            final_prompt,
            grok.api_key(),
            system=grok.MOTION_ENHANCE_SYSTEM,
        )
        print(f"Enhanced motion prompt:\n  {final_prompt}\n")
    elif enhance_motion_prompt and not xai_key_available():
        print("Motion prompt enhancement skipped — XAI_API_KEY not set; using locked-camera prompt as written.")

    if background_video_model == "wan-2.2-spicy":
        wavespeed.image_to_video_wan_spicy(
            image=image,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
        )
        return
    # Already enhanced above when possible; avoid a second chat pass in grok.image_to_video.
    grok.image_to_video(
        image=image,
        prompt=final_prompt,
        out=out,
        model=model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
        enhance=False,
    )


def edit_video(
    *,
    provider: AiProvider,
    video: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    video_field: str,
    enhance: bool,
    prepare_compatible: bool,
    enhance_system: str = grok.DRESS_ENHANCE_SYSTEM,
    reference_image: str | Path | None = None,
    reference_field: str = "image",
    dress_video_model: DressVideoModel = "grok-imagine",
) -> None:
    if dress_video_model == "wan-2.2-video-edit":
        final_prompt = prompt
        reference_str = str(reference_image).strip() if reference_image is not None else ""
        if (enhance or reference_str) and xai_key_available():
            key = grok.api_key()
            if reference_str:
                print(f"Captioning dress reference image via {grok.vision_model()} ...")
                caption = grok.describe_outfit(reference_str, key)
                if caption:
                    print(f"Reference outfit caption:\n  {caption}\n")
                    final_prompt = (
                        f"{final_prompt.rstrip()}\n\n"
                        f"Outfit from the reference image — match shape, color, and emissive "
                        f"glow/shine intensity exactly: {caption}"
                    )
            if enhance:
                print(f"Enhancing dress prompt via {grok.chat_model()} (for WAN edit) ...")
                final_prompt = grok.enhance_prompt(final_prompt, key, system=enhance_system)
                print(f"Enhanced dress prompt:\n  {final_prompt}\n")
        elif enhance and not xai_key_available():
            print("Dress prompt enhancement skipped — XAI_API_KEY not set; using prompt as written.")
        wavespeed.edit_video_wan22(
            video=video,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
            reference_image=None,
        )
        return
    grok.edit_video(
        video=video,
        prompt=prompt,
        out=out,
        model=model,
        resolution=resolution,
        video_field=video_field,
        enhance=enhance,
        prepare_compatible=prepare_compatible,
        enhance_system=enhance_system,
        reference_image=reference_image,
        reference_field=reference_field,
    )
