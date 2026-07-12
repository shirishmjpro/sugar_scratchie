from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Literal

from backend.services.grok import probe_video

CompressPreset = Literal["mobile", "hd", "master"]

# Prototype canvas is 390×672 — every delivery encode must match this aspect.
DELIVERY_ASPECT_W = 390
DELIVERY_ASPECT_H = 672

DEFAULT_CRF = 23
DEFAULT_WEBM_CRF = 32
DEFAULT_PRESET: CompressPreset = "mobile"

PRESET_SPECS: dict[CompressPreset, dict] = {
    "mobile": {
        "label": "Mobile delivery",
        "description": "390×672 (exact prototype canvas) · CRF 23 — default for scratching.",
        "width": 390,
        "crf": 23,
        "webm_crf": 32,
    },
    "hd": {
        "label": "HD delivery",
        "description": "540×930 (same 390∶672 crop) · CRF 20 — sharper on desktop.",
        "width": 540,
        "crf": 20,
        "webm_crf": 30,
    },
    "master": {
        "label": "Master archive",
        "description": "720×1240 (same 390∶672 crop) · CRF 18 — keep quality for re-edits.",
        "width": 720,
        "crf": 18,
        "webm_crf": 28,
    },
}


def normalize_compress_preset(value: str | None) -> CompressPreset:
    if value in PRESET_SPECS:
        return value  # type: ignore[return-value]
    return DEFAULT_PRESET


def delivery_size(preset: CompressPreset) -> tuple[int, int]:
    """Return even (width, height) for the delivery canvas at the prototype aspect."""
    preset = normalize_compress_preset(preset)
    width = int(PRESET_SPECS[preset]["width"])
    height = int(round(width * DELIVERY_ASPECT_H / DELIVERY_ASPECT_W))
    # yuv420 requires even dimensions
    width -= width % 2
    height -= height % 2
    return width, height


def cover_crop_filter(width: int, height: int) -> str:
    """Scale to cover the target frame, then center-crop — no letterboxing."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={width}:{height}"
    )


def run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr or result.stdout}")


def format_size(path: Path) -> str:
    size = path.stat().st_size
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def file_size_bytes(path: Path) -> int:
    return path.stat().st_size if path.is_file() else 0


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def log_video(label: str, path: Path) -> None:
    meta = probe_video(path)
    print(
        f"{label}: {path} "
        f"({meta['width']}x{meta['height']}, {meta.get('codec', '?')}, {format_size(path)})"
    )


def backup_video(src: Path, backup_dir: Path | str = ".video-backups") -> Path | None:
    if not src.is_file():
        return None
    root = Path(backup_dir)
    root.mkdir(parents=True, exist_ok=True)
    backup = root / f"{src.parent.name}_{src.name}"
    if backup.resolve() == src.resolve():
        backup = root / f"{src.stem}-{src.parent.name}{src.suffix}"
    shutil.copy2(src, backup)
    print(f"Backed up {src} -> {backup}")
    return backup


def align_clip_to_reference(reference: Path, clip: Path, out: Path) -> Path:
    """Trim and scale a clip to match the shared motion reference timing + pixel size."""
    ref = probe_video(reference)
    clip_meta = probe_video(clip)
    out.parent.mkdir(parents=True, exist_ok=True)
    duration = min(float(ref["duration"]), float(clip_meta["duration"]))
    print(
        f"Aligning {clip.name} to motion reference "
        f"({ref['width']}x{ref['height']} {duration:.2f}s)"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(clip),
            "-t",
            f"{duration:.3f}",
            "-vf",
            f"scale={ref['width']}:{ref['height']}:force_original_aspect_ratio=decrease,"
            f"pad={ref['width']}:{ref['height']}:(ow-iw)/2:(oh-ih)/2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(out),
        ]
    )
    log_video("Aligned", out)
    return out


def target_width_for_preset(preset: CompressPreset, source_width: int | None = None) -> int:
    del source_width
    return delivery_size(preset)[0]


def compress_video(
    src: Path,
    dst: Path,
    *,
    width: int | None = None,
    height: int | None = None,
    crf: int = DEFAULT_CRF,
    preset: CompressPreset | None = None,
) -> Path:
    """Encode to a fixed prototype-aspect frame with cover-crop (no letterbox)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    before = probe_video(src)
    if preset is not None:
        preset = normalize_compress_preset(preset)
        spec = PRESET_SPECS[preset]
        width, height = delivery_size(preset)
        crf = int(spec["crf"])
    else:
        if width is None:
            width = DELIVERY_ASPECT_W
        if height is None:
            height = int(round(width * DELIVERY_ASPECT_H / DELIVERY_ASPECT_W))
            height -= height % 2
            width -= width % 2
    assert width is not None and height is not None
    print(
        f"Compressing {src.name}: {before['width']}x{before['height']} "
        f"({format_size(src)}) -> {width}x{height} cover-crop H.264 CRF {crf}"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-vf",
            cover_crop_filter(width, height),
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level:v",
            "4.0",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            str(crf),
            "-preset",
            "slow",
            "-movflags",
            "+faststart",
            "-an",
            str(dst),
        ]
    )
    after = probe_video(dst)
    if int(after["width"]) != width or int(after["height"]) != height:
        raise RuntimeError(
            f"Delivery encode produced {after['width']}x{after['height']}, "
            f"expected {width}x{height}"
        )
    log_video("Compressed", dst)
    return dst


def compress_video_webm(
    src: Path,
    dst: Path,
    *,
    crf: int = DEFAULT_WEBM_CRF,
    preset: CompressPreset | None = None,
) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if preset is not None:
        crf = int(PRESET_SPECS[normalize_compress_preset(preset)]["webm_crf"])
    # Source is already at delivery size; re-encode only.
    print(f"Writing WebM sidecar: {dst.name} (VP9 CRF {crf})")
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            str(crf),
            "-row-mt",
            "1",
            "-an",
            str(dst),
        ]
    )
    log_video("WebM", dst)
    return dst


def _clip_report(path: Path, *, role: str) -> dict:
    if not path.is_file():
        return {"role": role, "path": str(path), "exists": False}
    meta = probe_video(path)
    return {
        "role": role,
        "path": str(path),
        "exists": True,
        "width": int(meta["width"]),
        "height": int(meta["height"]),
        "duration": round(float(meta["duration"]), 3),
        "codec": str(meta.get("codec") or ""),
        "bytes": file_size_bytes(path),
        "size": format_size(path),
        "aspect": round(int(meta["width"]) / max(1, int(meta["height"])), 4),
    }


def finalize_card_videos(
    *,
    background_src: Path,
    foreground_src: Path,
    background_dst: Path,
    foreground_dst: Path,
    motion_reference: Path,
    work_dir: Path,
    backup_dir: Path,
    preset: CompressPreset = DEFAULT_PRESET,
    write_webm: bool = True,
    report_path: Path | None = None,
) -> dict:
    """Align FG to BG, cover-crop both to a fixed prototype-aspect canvas, optional WebM."""
    preset = normalize_compress_preset(preset)
    spec = PRESET_SPECS[preset]
    target_w, target_h = delivery_size(preset)
    work_dir.mkdir(parents=True, exist_ok=True)

    before = {
        "background": _clip_report(background_dst, role="background"),
        "foreground": _clip_report(foreground_dst, role="foreground"),
    }

    # Prefer work-dir motion/source clips; fall back to published card videos when
    # the work dir was cleaned up (common after remake / recovery).
    motion_ref = (
        motion_reference
        if motion_reference.is_file()
        else background_src
        if background_src.is_file()
        else background_dst
    )
    fg_source = foreground_src if foreground_src.is_file() else foreground_dst
    bg_meta = probe_video(motion_ref)
    fg_meta = probe_video(fg_source)
    card_bg_meta = probe_video(background_dst)
    card_fg_meta = probe_video(foreground_dst)
    duration_delta = abs(float(card_bg_meta["duration"]) - float(card_fg_meta["duration"]))
    print(
        "Finalize sync check: "
        f"motion_ref={bg_meta['duration']:.2f}s "
        f"fg_source={fg_meta['duration']:.2f}s "
        f"card_bg={card_bg_meta['duration']:.2f}s "
        f"card_fg={card_fg_meta['duration']:.2f}s "
        f"delta={duration_delta:.3f}s"
    )
    if duration_delta > 0.08:
        print(
            f"Warning: card background/foreground durations differ by {duration_delta:.3f}s — "
            "aligning foreground to the motion reference."
        )

    aligned_fg = work_dir / "foreground-aligned-for-compress.mp4"
    align_clip_to_reference(
        motion_ref,
        foreground_dst,
        aligned_fg,
    )

    bg_tmp = work_dir / "compress-bg-tmp.mp4"
    fg_tmp = work_dir / "compress-fg-tmp.mp4"
    print(
        f"Delivery preset: {preset} ({spec['label']}) — "
        f"{target_w}x{target_h} cover-crop (390∶672), CRF {spec['crf']}"
        + (", WebM sidecars on" if write_webm else ", WebM off")
    )

    # Encode BG first from the card file, then FG from the aligned twin so both
    # share the same pixel grid before the identical cover-crop.
    compress_video(background_dst, bg_tmp, preset=preset)
    compress_video(aligned_fg, fg_tmp, preset=preset)
    backup_video(background_dst, backup_dir)
    backup_video(foreground_dst, backup_dir)
    shutil.move(str(bg_tmp), str(background_dst))
    shutil.move(str(fg_tmp), str(foreground_dst))

    webm_paths: list[str] = []
    if write_webm:
        bg_webm = background_dst.with_suffix(".webm")
        fg_webm = foreground_dst.with_suffix(".webm")
        compress_video_webm(background_dst, bg_webm, preset=preset)
        compress_video_webm(foreground_dst, fg_webm, preset=preset)
        webm_paths = [str(bg_webm), str(fg_webm)]

    after = {
        "background": _clip_report(background_dst, role="background"),
        "foreground": _clip_report(foreground_dst, role="foreground"),
    }
    if write_webm:
        after["background_webm"] = _clip_report(
            background_dst.with_suffix(".webm"), role="background_webm"
        )
        after["foreground_webm"] = _clip_report(
            foreground_dst.with_suffix(".webm"), role="foreground_webm"
        )

    before_bytes = sum(int(entry.get("bytes") or 0) for entry in before.values())
    after_bytes = sum(
        int(entry.get("bytes") or 0)
        for key, entry in after.items()
        if key in ("background", "foreground")
    )
    ratio = (after_bytes / before_bytes) if before_bytes else 1.0
    aspect_ok = (
        after["background"].get("width") == target_w
        and after["background"].get("height") == target_h
        and after["foreground"].get("width") == target_w
        and after["foreground"].get("height") == target_h
    )
    report = {
        "preset": preset,
        "preset_label": spec["label"],
        "write_webm": write_webm,
        "target_width": target_w,
        "target_height": target_h,
        "aspect": f"{DELIVERY_ASPECT_W}:{DELIVERY_ASPECT_H}",
        "fit": "cover-crop",
        "crf": int(spec["crf"]),
        "duration_delta_before": round(duration_delta, 3),
        "aspect_ok": aspect_ok,
        "before": before,
        "after": after,
        "before_bytes": before_bytes,
        "after_bytes": after_bytes,
        "size_ratio": round(ratio, 3),
        "saved_bytes": max(0, before_bytes - after_bytes),
        "saved": _format_bytes(max(0, before_bytes - after_bytes)),
        "webm_paths": webm_paths,
        "backups": [
            str(backup_dir / f"{background_dst.parent.name}_{background_dst.name}"),
            str(backup_dir / f"{foreground_dst.parent.name}_{foreground_dst.name}"),
        ],
    }
    print(
        f"Finalize complete: {target_w}x{target_h} H.264 cover-crop — "
        f"{format_size(background_dst)} + {format_size(foreground_dst)} "
        f"(was {_format_bytes(before_bytes)}, saved {report['saved']}, ratio {ratio:.0%})"
    )
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote compress report: {report_path}")
    return report
