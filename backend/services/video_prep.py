from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from backend.services.grok import probe_video

DEFAULT_WIDTH = 540
DEFAULT_CRF = 23
DEFAULT_WEBM_CRF = 32


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
    """Trim and scale a clip to match the shared motion reference timing."""
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


def compress_video(
    src: Path,
    dst: Path,
    *,
    width: int = DEFAULT_WIDTH,
    crf: int = DEFAULT_CRF,
) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    before = probe_video(src)
    print(
        f"Compressing {src.name}: {before['width']}x{before['height']} "
        f"({format_size(src)}) -> {width}px wide H.264"
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
            f"scale={width}:-2:flags=lanczos",
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
    log_video("Compressed", dst)
    return dst


def compress_video_webm(
    src: Path,
    dst: Path,
    *,
    crf: int = DEFAULT_WEBM_CRF,
) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing WebM sidecar: {dst.name}")
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
            "-an",
            str(dst),
        ]
    )
    log_video("WebM", dst)
    return dst
