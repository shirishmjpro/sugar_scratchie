#!/usr/bin/env python3
"""
Image-to-card pipeline: Grok background (loop/boomerang bikini), foreground dress-up,
compress, create card, and generate mesh.

Mirrors the dashboard **Video Flow** tab.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.services.video_flow import video_flow  # noqa: E402

DEFAULT_BACKGROUND_PROMPT = (
    "Animate this portrait into a seamless looping boomerang video. She wears a bikini, "
    "gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, "
    "no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. "
    "Keep the exact same framing and subject size as the input image in every frame. "
    "Keep her face, identity, hair, and skin tone identical in every frame — same undertone, "
    "same lightness, no tan/pale flicker, no color grading shifts on skin. "
    "Perfect loop, warm beach lighting."
)
DEFAULT_DRESS_PROMPT = (
    "Replace her entire bikini with a fitted emerald satin dress (top and bottom). "
    "Keep the exact same beach background, scenery, lighting, camera, framing, subject "
    "scale, and motion frame-for-frame — only change the outfit. Keep her face, identity, "
    "hair, and skin tone identical in every frame (same undertone and lightness — no "
    "tan/pale flicker). No zoom or camera move."
)


def resolve_image(value: str) -> str:
    if value.startswith(("http://", "https://")):
        return value
    path = Path(value)
    resolved = (REPO_ROOT / path).resolve() if not path.is_absolute() else path.resolve()
    if not resolved.is_file():
        sys.exit(f"Image not found: {resolved}")
    return str(resolved)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the image-to-card video flow.")
    parser.add_argument("--image", required=True, help="Source image path or https URL")
    parser.add_argument("--background-motion-prompt", default=DEFAULT_BACKGROUND_PROMPT)
    parser.add_argument("--dress-prompt", default=DEFAULT_DRESS_PROMPT)
    parser.add_argument("--card-id", required=True, help="New card id (e.g. julia_1)")
    parser.add_argument("--card-label", required=True, help="Display label for the card")
    parser.add_argument("--resolution", default="720p")
    parser.add_argument("--model", default="grok-imagine-video-1.5")
    parser.add_argument("--tracker", default="bootstapir", choices=["bootstapir", "cotracker", "blend"])
    parser.add_argument("--no-webm", action="store_true", help="Skip WebM sidecar generation")
    parser.add_argument("--image-field", default="image")
    parser.add_argument("--video-field", default="video")
    parser.add_argument("--endpoint", default="/v1/videos/generations")
    args = parser.parse_args()

    video_flow(
        image=resolve_image(args.image),
        background_motion_prompt=args.background_motion_prompt,
        foreground_motion_prompt="",
        dress_prompt=args.dress_prompt,
        card_id=args.card_id,
        card_label=args.card_label,
        model=args.model,
        resolution=args.resolution,
        image_field=args.image_field,
        endpoint=args.endpoint,
        video_field=args.video_field,
        enhance_dress_prompt=True,
        tracker=args.tracker,
        write_webm=not args.no_webm,
    )


if __name__ == "__main__":
    os.chdir(REPO_ROOT)
    main()
