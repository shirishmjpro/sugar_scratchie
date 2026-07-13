#!/usr/bin/env python3
"""Create transparent bikini/clothes layers for the photo scratch prototype."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from scipy import ndimage
from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

ROOT = Path(__file__).resolve().parents[1]
MODEL_NAME = "mattmdjaga/segformer_b2_clothes"


def largest_blob(mask: np.ndarray) -> np.ndarray:
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=2)
    mask = ndimage.binary_fill_holes(mask)
    labels, count = ndimage.label(mask)
    if count == 0:
        return mask
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    return labels == int(sizes.argmax())


def person_alpha(
    image: Image.Image,
    processor: SegformerImageProcessor,
    model: AutoModelForSemanticSegmentation,
    device: torch.device,
) -> Image.Image:
    rgb = np.asarray(image.convert("RGB"))
    inputs = processor(images=image, return_tensors="pt").to(device)
    with torch.no_grad():
        logits = model(**inputs).logits
    labels = torch.nn.functional.interpolate(
        logits,
        size=(image.height, image.width),
        mode="bilinear",
        align_corners=False,
    ).argmax(1)[0].cpu().numpy()

    # The clothes parser labels the complete performer (hair, skin, limbs,
    # bikini/clothes) as non-zero and the room as background class zero.
    mask = largest_blob(labels != 0)
    mask = ndimage.binary_dilation(mask, iterations=2)
    alpha = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    return alpha.filter(ImageFilter.GaussianBlur(radius=1.25))


def cutout(
    source: Path,
    destination: Path,
    processor: SegformerImageProcessor,
    model: AutoModelForSemanticSegmentation,
    device: torch.device,
) -> None:
    image = Image.open(source).convert("RGB")
    rgba = image.convert("RGBA")
    rgba.putalpha(person_alpha(image, processor, model, device))
    destination.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(destination, optimize=True)
    print(f"Wrote {destination.relative_to(ROOT)} ({rgba.width}x{rgba.height}, RGBA)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--bikini",
        type=Path,
        default=ROOT / "public/photo-scratch/background.jpg",
    )
    parser.add_argument(
        "--clothes",
        type=Path,
        default=ROOT / "public/photo-scratch/foreground.png",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "public/photo-scratch",
    )
    args = parser.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    processor = SegformerImageProcessor.from_pretrained(MODEL_NAME)
    model = AutoModelForSemanticSegmentation.from_pretrained(MODEL_NAME).to(device).eval()

    cutout(args.bikini, args.output_dir / "bikini.png", processor, model, device)
    cutout(args.clothes, args.output_dir / "clothes.png", processor, model, device)


if __name__ == "__main__":
    main()
