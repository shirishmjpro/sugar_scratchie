from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Literal

from fastapi import HTTPException

from backend.cards import CreateCardRequest, UpdateCardRequest, card_paths, create_card, update_card
from backend.services.ai_provider import (
    edit_video,
    generate_portrait_image,
    image_to_video,
    normalize_background_video_model,
    normalize_dress_video_model,
    normalize_provider,
    normalize_source_image_model,
    swap_face_on_image,
)
from backend.services.grok import (
    DRESS_ENHANCE_SYSTEM,
    DEFAULT_PORTRAIT_PROMPT,
    is_stock_portrait_prompt,
    normalize_background_motion_prompt,
    output_video_ready,
    probe_video,
    request_id_sidecar,
)
from backend.services.garment_mask import generate_garment_mask
from backend.services.mesh_symbols import (
    clear_symbol_points,
    read_symbol_points,
    symbol_points_complete,
)
from backend.services.mesh_tracking import generate_mesh
from backend.services.mesh_tune import build_mesh_tracking_env, mesh_tune_from_dict
from backend.services.video_prep import (
    align_clip_to_reference,
    finalize_card_videos,
    normalize_compress_preset,
)

ROOT = Path(__file__).resolve().parents[2]
CARDS_DIR = ROOT / "public" / "cards"
MESH_DIR = ROOT / "public" / "mesh"
WORK_DIR = ROOT / ".tmp" / "video-flow"

VideoFlowStep = Literal["background", "dress", "card", "mesh", "symbols", "compress"]
MeshTracker = Literal["bootstapir", "cotracker", "blend"]
MeshTrackerChoice = Literal["bootstapir", "cotracker", "blend", "all"]

MESH_TRACKERS: tuple[MeshTracker, MeshTracker, MeshTracker] = (
    "bootstapir",
    "cotracker",
    "blend",
)

# Bikini background first (master motion), dress edit from it, then publish + track, compress last.
STEP_ORDER: list[VideoFlowStep] = [
    "background",
    "dress",
    "card",
    "mesh",
    "symbols",
    "compress",
]

STEP_DEPS: dict[VideoFlowStep, list[VideoFlowStep]] = {
    "background": [],
    "dress": ["background"],
    "card": ["background", "dress"],
    "mesh": ["card"],
    "symbols": ["mesh"],
    "compress": ["symbols"],
}

REVIEW_STEPS = frozenset({"background", "dress"})

STEP_LABELS: dict[VideoFlowStep, str] = {
    "background": "Background bikini (image to video)",
    "dress": "Foreground dress-up (video edit)",
    "card": "Create card",
    "mesh": "Generate mesh",
    "symbols": "Place symbol points",
    "compress": "Finalize delivery videos",
}


def work_dir(card_id: str) -> Path:
    work = WORK_DIR / card_id
    work.mkdir(parents=True, exist_ok=True)
    return work


def mesh_candidate_path(work: Path, tracker: MeshTracker) -> Path:
    return work / f"mesh-{tracker}.json"


def read_mesh_tracker(mesh_path: Path) -> MeshTracker | None:
    if not mesh_path.exists():
        return None
    try:
        data = json.loads(mesh_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    tracker = data.get("tracker")
    if tracker in MESH_TRACKERS:
        return tracker
    return None


def ensure_active_mesh_snapshotted(work: Path, card_id: str) -> MeshTracker | None:
    """Copy the published mesh into work/mesh-<tracker>.json so it can be compared."""
    canonical = MESH_DIR / f"{card_id}.json"
    if not canonical.exists():
        return None
    tracker = read_mesh_tracker(canonical)
    if tracker not in MESH_TRACKERS:
        return None
    dest = mesh_candidate_path(work, tracker)
    if not dest.exists():
        shutil.copy2(canonical, dest)
    return tracker


def mesh_candidates_ready(work: Path) -> bool:
    return all(mesh_candidate_path(work, tracker).exists() for tracker in MESH_TRACKERS)


def publish_mesh_choice(work: Path, card_id: str, tracker: MeshTracker) -> Path:
    src = mesh_candidate_path(work, tracker)
    if not src.exists():
        raise RuntimeError(f"Mesh candidate '{tracker}' not found — regenerate the mesh step.")
    dst = MESH_DIR / f"{card_id}.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"Published mesh: {tracker} -> {dst.name}")
    return dst


def mesh_artifact_paths(work: Path, card_id: str) -> list[str]:
    candidates = [
        str(mesh_candidate_path(work, tracker).relative_to(ROOT))
        for tracker in MESH_TRACKERS
        if mesh_candidate_path(work, tracker).exists()
    ]
    if candidates:
        return candidates
    mesh_out = MESH_DIR / f"{card_id}.json"
    if mesh_out.exists():
        return [str(mesh_out.relative_to(ROOT))]
    return []


def mesh_compare_entries(work: Path, card_id: str) -> list[dict[str, str | bool]]:
    ensure_active_mesh_snapshotted(work, card_id)
    active = read_mesh_tracker(MESH_DIR / f"{card_id}.json")
    entries: list[dict[str, str | bool]] = []
    for tracker in MESH_TRACKERS:
        candidate = mesh_candidate_path(work, tracker)
        if not candidate.exists():
            continue
        entries.append(
            {
                "path": str(candidate.relative_to(ROOT)),
                "tracker": tracker,
                "active": tracker == active,
            }
        )
    return entries


def state_path(work: Path) -> Path:
    return work / "state.json"


def default_state() -> dict:
    return {"approved": []}


def read_state(work: Path) -> dict:
    path = state_path(work)
    if not path.exists():
        return default_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default_state()
    approved = data.get("approved")
    if not isinstance(approved, list):
        return default_state()
    return normalize_state({"approved": [step for step in approved if step in STEP_ORDER]})


def normalize_state(state: dict) -> dict:
    """Drop stale approvals from older pipeline versions or skipped dependencies."""
    approved: list[VideoFlowStep] = []
    for step in STEP_ORDER:
        if step not in state["approved"]:
            continue
        if all(dep in approved for dep in STEP_DEPS[step]):
            approved.append(step)
    if approved != state["approved"]:
        state = {"approved": approved}
    return state


def write_state(work: Path, state: dict) -> None:
    state = normalize_state(state)
    state_path(work).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def video_file_present(path: Path) -> bool:
    """Fast existence check — no ffprobe. Used for list endpoints."""
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _work_background_clip(work: Path) -> Path | None:
    """Prefer the canonical raw clip; fall back to the Grok-compatible resize."""
    raw = work / "background-raw.mp4"
    if raw.exists():
        return raw
    compat = work / "background-raw-grok-compatible.mp4"
    return compat if compat.exists() else None


def artifact_paths(
    work: Path,
    card_id: str,
    state: dict | None = None,
    *,
    probe_videos: bool = True,
) -> dict[VideoFlowStep, list[str]]:
    mesh_out = MESH_DIR / f"{card_id}.json"
    card_bg = CARDS_DIR / card_id / "background.mp4"
    card_fg = CARDS_DIR / card_id / "foreground.mp4"
    approved = state["approved"] if state else []
    background_clip = _work_background_clip(work)
    foreground_dressed = work / "foreground-dressed.mp4"
    compress_report = work / "compress-report.json"
    video_ok = output_video_ready if probe_videos else video_file_present
    # Prefer work-dir clips; fall back to published card videos so previews still
    # show after cleanup / remake / recovery.
    background_preview = ""
    if background_clip and video_ok(background_clip):
        background_preview = str(background_clip.relative_to(ROOT))
    elif video_ok(card_bg) and "background" in approved:
        background_preview = str(card_bg.relative_to(ROOT))

    dress_preview = ""
    if video_ok(foreground_dressed) and "background" in approved:
        dress_preview = str(foreground_dressed.relative_to(ROOT))
    elif video_ok(card_fg) and "dress" in approved:
        dress_preview = str(card_fg.relative_to(ROOT))
    return {
        "background": [background_preview],
        "dress": [dress_preview],
        "card": [
            str(card_bg.relative_to(ROOT)) if video_ok(card_bg) else "",
            str(card_fg.relative_to(ROOT)) if video_ok(card_fg) else "",
        ],
        "mesh": mesh_artifact_paths(work, card_id),
        "symbols": [
            str(mesh_out.relative_to(ROOT))
            if mesh_out.exists() and symbol_points_complete(mesh_out)
            else ""
        ],
        "compress": [
            str(card_bg.relative_to(ROOT)) if video_ok(card_bg) else "",
            str(card_fg.relative_to(ROOT)) if video_ok(card_fg) else "",
            str(compress_report.relative_to(ROOT)) if compress_report.exists() else "",
        ],
    }


def preview_paths(
    work: Path,
    card_id: str,
    state: dict | None = None,
    *,
    probe_videos: bool = True,
) -> dict[VideoFlowStep, list[str]]:
    artifacts = artifact_paths(work, card_id, state, probe_videos=probe_videos)
    return {step: [path for path in paths if path] for step, paths in artifacts.items()}


def step_artifact_ready(
    work: Path,
    card_id: str,
    step: VideoFlowStep,
    state: dict | None = None,
    *,
    probe_videos: bool = True,
) -> bool:
    if step == "mesh":
        if mesh_candidates_ready(work):
            return True
        mesh_out = MESH_DIR / f"{card_id}.json"
        return mesh_out.exists()
    if step == "symbols":
        mesh_out = MESH_DIR / f"{card_id}.json"
        return mesh_out.exists() and symbol_points_complete(mesh_out)
    if step == "compress":
        # Delivery videos must be playable; the JSON report is metadata only.
        card_bg = CARDS_DIR / card_id / "background.mp4"
        card_fg = CARDS_DIR / card_id / "foreground.mp4"
        report = work / "compress-report.json"
        video_ok = output_video_ready if probe_videos else video_file_present
        return video_ok(card_bg) and video_ok(card_fg) and report.exists()
    paths = preview_paths(work, card_id, state, probe_videos=probe_videos)[step]
    if not paths:
        return False
    for rel in paths:
        path = ROOT / rel
        if step in ("background", "dress", "card"):
            video_ok = output_video_ready if probe_videos else video_file_present
            if not video_ok(path):
                return False
        elif not path.exists():
            return False
    return True


def step_unlocked(state: dict, step: VideoFlowStep) -> bool:
    return all(dep in state["approved"] for dep in STEP_DEPS[step])


def validate_step_enqueue(
    card_id: str,
    step: VideoFlowStep,
    *,
    force: bool = False,
    image: str | Path | None = None,
) -> None:
    """Reject out-of-order step runs before a job is queued."""
    work = work_dir(card_id)
    state = read_state(work)
    prev = STEP_DEPS[step]
    if prev and not step_unlocked(state, step):
        missing = next(dep for dep in prev if dep not in state["approved"])
        raise RuntimeError(
            f"Approve the {STEP_LABELS[missing]} result before running this step."
        )
    if step in state["approved"] and not force:
        return
    stale_source_image = (
        step == "background"
        and image
        and _source_image_newer_than_background(work, _paths(work), image)
    )
    if (
        step_artifact_ready(work, card_id, step, state)
        and not force
        and step in REVIEW_STEPS
        and not stale_source_image
    ):
        raise RuntimeError(
            "Result already exists — approve or reject it in the dashboard before re-running."
        )
    if (
        step == "mesh"
        and mesh_candidates_ready(work)
        and not force
        and step not in state["approved"]
    ):
        raise RuntimeError("Pick a mesh tracker in the dashboard before re-running this step.")


def previous_step(step: VideoFlowStep) -> VideoFlowStep | None:
    index = STEP_ORDER.index(step)
    return STEP_ORDER[index - 1] if index > 0 else None


def downstream_steps(step: VideoFlowStep) -> list[VideoFlowStep]:
    affected = {step}
    changed = True
    while changed:
        changed = False
        for candidate in STEP_ORDER:
            if candidate in affected:
                continue
            if any(dep in affected for dep in STEP_DEPS[candidate]):
                affected.add(candidate)
                changed = True
    return [entry for entry in STEP_ORDER if entry in affected]


def clear_step_outputs(work: Path, card_id: str, step: VideoFlowStep) -> None:
    paths = _paths(work)
    files_by_step: dict[VideoFlowStep, list[Path]] = {
        "background": [paths["background_raw"]],
        "dress": [paths["foreground_dressed"]],
        "compress": [
            work / "foreground-aligned-for-compress.mp4",
            work / "compress-bg-tmp.mp4",
            work / "compress-fg-tmp.mp4",
            work / "compress-report.json",
        ],
        "card": [],
        "mesh": [],
        "symbols": [],
    }
    for rel_path in files_by_step.get(step, []):
        rel_path.unlink(missing_ok=True)
        request_id_sidecar(rel_path).unlink(missing_ok=True)

    if step == "card":
        card_dir = CARDS_DIR / card_id
        if card_dir.exists():
            for child in card_dir.iterdir():
                child.unlink(missing_ok=True)
            card_dir.rmdir()

    if step == "mesh":
        for tracker in MESH_TRACKERS:
            mesh_candidate_path(work, tracker).unlink(missing_ok=True)
        mesh_out = MESH_DIR / f"{card_id}.json"
        mesh_out.unlink(missing_ok=True)

    if step == "symbols":
        clear_symbol_points(MESH_DIR / f"{card_id}.json")

    if step == "compress":
        card_dir = CARDS_DIR / card_id
        if card_dir.exists():
            for sidecar in (card_dir / "background.webm", card_dir / "foreground.webm"):
                sidecar.unlink(missing_ok=True)


def _invalidate_after_mesh_switch(state: dict) -> None:
    for step in ("symbols", "compress"):
        if step in state["approved"]:
            state["approved"].remove(step)


def approve_flow_step(
    card_id: str,
    step: VideoFlowStep,
    *,
    mesh_tracker: MeshTracker | None = None,
) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    if step == "mesh" and mesh_tracker:
        if mesh_tracker not in MESH_TRACKERS:
            raise RuntimeError(
                "Pick bootstapir, cotracker, or blend before approving the mesh step."
            )
        if not mesh_candidate_path(work, mesh_tracker).exists():
            raise RuntimeError(
                f"Mesh candidate '{mesh_tracker}' not found — generate it for comparison first."
            )
        switching = step in state["approved"]
        publish_mesh_choice(work, card_id, mesh_tracker)
        if switching:
            mesh_out = MESH_DIR / f"{card_id}.json"
            if mesh_out.exists():
                clear_symbol_points(mesh_out)
            _invalidate_after_mesh_switch(state)
        if step not in state["approved"]:
            state["approved"].append(step)
        write_state(work, state)
        return flow_state(card_id)
    if not step_artifact_ready(work, card_id, step, state):
        raise RuntimeError(f"Step '{step}' has no result to approve yet.")
    prev = STEP_DEPS[step]
    if prev and not step_unlocked(state, step):
        missing = next(dep for dep in prev if dep not in state["approved"])
        raise RuntimeError(f"Approve '{STEP_LABELS[missing]}' before '{STEP_LABELS[step]}'.")
    if step == "mesh" and mesh_candidates_ready(work):
        if mesh_tracker not in MESH_TRACKERS:
            raise RuntimeError(
                "Pick bootstapir, cotracker, or blend before approving the mesh step."
            )
        publish_mesh_choice(work, card_id, mesh_tracker)
    if step not in state["approved"]:
        state["approved"].append(step)
        if step == "background" and "dress" not in state["approved"]:
            dressed = work / "foreground-dressed.mp4"
            dressed.unlink(missing_ok=True)
            request_id_sidecar(dressed).unlink(missing_ok=True)
        write_state(work, state)
    return flow_state(card_id)


def reject_flow_step(card_id: str, step: VideoFlowStep) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    for downstream in downstream_steps(step):
        if downstream in state["approved"]:
            state["approved"].remove(downstream)
        clear_step_outputs(work, card_id, downstream)
    write_state(work, state)
    return flow_state(card_id)


def step_status(
    work: Path,
    card_id: str,
    step: VideoFlowStep,
    state: dict,
    *,
    probe_videos: bool = True,
) -> str:
    if not step_unlocked(state, step):
        return "locked"
    if step in state["approved"]:
        if not step_artifact_ready(work, card_id, step, state, probe_videos=probe_videos):
            return "ready"
        return "approved"
    if step == "mesh" and mesh_candidates_ready(work):
        return "review"
    if step in REVIEW_STEPS and step_artifact_ready(
        work, card_id, step, state, probe_videos=probe_videos
    ):
        return "review"
    return "ready"


def _sync_foreground_to_background(work: Path, paths: dict[str, Path]) -> None:
    """Force foreground to match background resolution and timing after Grok edit."""
    if not output_video_ready(paths["background_raw"]) or not output_video_ready(
        paths["foreground_dressed"]
    ):
        return
    bg_meta = probe_video(paths["background_raw"])
    fg_meta = probe_video(paths["foreground_dressed"])
    if (
        bg_meta["width"] == fg_meta["width"]
        and bg_meta["height"] == fg_meta["height"]
        and abs(float(bg_meta["duration"]) - float(fg_meta["duration"])) < 0.05
    ):
        return
    aligned = work / "foreground-dressed-aligned.mp4"
    print(
        f"Foreground mismatch ({fg_meta['width']}x{fg_meta['height']} "
        f"{fg_meta['duration']:.2f}s) — aligning to background "
        f"({bg_meta['width']}x{bg_meta['height']} {bg_meta['duration']:.2f}s)"
    )
    align_clip_to_reference(paths["background_raw"], paths["foreground_dressed"], aligned)
    shutil.move(str(aligned), str(paths["foreground_dressed"]))
    synced = probe_video(paths["foreground_dressed"])
    print(
        f"Foreground synced: {synced['width']}x{synced['height']} "
        f"{synced['duration']:.2f}s"
    )


def _draft_model_id(work: Path) -> str | None:
    draft_file = draft_path(work)
    if not draft_file.exists():
        return None
    try:
        data = json.loads(draft_file.read_text(encoding="utf-8"))
        model_id = data.get("model_id")
        if isinstance(model_id, str) and model_id.strip():
            return model_id.strip()
    except Exception:
        pass
    return None


def import_manual_clips(
    *,
    card_id: str,
    card_label: str,
    background: str | Path,
    foreground: str | Path,
    model_id: str | None = None,
) -> dict:
    """Skip Grok steps 0–3 by publishing hand-picked background + foreground clips.

    Copies both videos into the work dir and public/cards/<id>/, then marks
    background, dress, and card as approved so mesh can run next.
    """
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise RuntimeError("Invalid card id")
    label = card_label.strip()
    if not label:
        raise RuntimeError("Card label is required")

    background_src = Path(background)
    foreground_src = Path(foreground)
    if not background_src.is_absolute():
        background_src = ROOT / background_src
    if not foreground_src.is_absolute():
        foreground_src = ROOT / foreground_src
    background_src = background_src.resolve()
    foreground_src = foreground_src.resolve()
    if ROOT.resolve() not in background_src.parents and background_src != ROOT.resolve():
        raise RuntimeError(f"Background path is outside the project: {background}")
    if ROOT.resolve() not in foreground_src.parents and foreground_src != ROOT.resolve():
        raise RuntimeError(f"Foreground path is outside the project: {foreground}")
    if not background_src.is_file():
        raise RuntimeError(f"Background video not found: {background}")
    if not foreground_src.is_file():
        raise RuntimeError(f"Foreground video not found: {foreground}")
    if not output_video_ready(background_src):
        raise RuntimeError(f"Background video is unreadable: {background}")
    if not output_video_ready(foreground_src):
        raise RuntimeError(f"Foreground video is unreadable: {foreground}")

    work = work_dir(card_id)
    paths = _paths(work)
    shutil.copy2(background_src, paths["background_raw"])
    shutil.copy2(foreground_src, paths["foreground_dressed"])
    _publish_card(
        card_id=card_id,
        card_label=label,
        paths=paths,
        model_id=model_id,
    )

    state = read_state(work)
    state["approved"] = ["background", "dress", "card"]
    # Keep mesh/symbols if those artifacts already exist for this card.
    mesh_out = MESH_DIR / f"{card_id}.json"
    if mesh_out.exists():
        state["approved"].append("mesh")
        if symbol_points_complete(mesh_out):
            state["approved"].append("symbols")
    write_state(work, state)
    print(
        f"Imported manual clips for {card_id} — "
        "background, dress, and card marked approved."
    )
    return flow_state(card_id)


def _publish_card(
    *,
    card_id: str,
    card_label: str,
    paths: dict[str, Path],
    model_id: str | None = None,
) -> None:
    work = paths["background_raw"].parent
    effective_model_id = model_id or _draft_model_id(work)
    background = str(paths["background_raw"].relative_to(ROOT))
    foreground = str(paths["foreground_dressed"].relative_to(ROOT))
    card_dir = CARDS_DIR / card_id
    if card_dir.exists():
        card = update_card(
            ROOT,
            CARDS_DIR,
            MESH_DIR,
            card_id,
            UpdateCardRequest(
                label=card_label,
                background=background,
                foreground=foreground,
                model_id=effective_model_id,
            ),
        )
        print(f"Card updated: {card.id} ({card.label})")
        return
    try:
        card = create_card(
            ROOT,
            CARDS_DIR,
            MESH_DIR,
            CreateCardRequest(
                id=card_id,
                label=card_label,
                background=background,
                foreground=foreground,
                model_id=effective_model_id,
            ),
        )
    except HTTPException as exc:
        raise RuntimeError(str(exc.detail)) from exc
    print(f"Card created: {card.id} ({card.label})")


def _ensure_card_published(
    *,
    work: Path,
    card_id: str,
    card_label: str,
    paths: dict[str, Path],
) -> Path:
    card_dir = CARDS_DIR / card_id
    bg_dst, fg_dst = card_paths(ROOT, CARDS_DIR, card_id)
    if card_dir.exists() and output_video_ready(bg_dst) and output_video_ready(fg_dst):
        return card_dir
    if not output_video_ready(paths["background_raw"]) or not output_video_ready(
        paths["foreground_dressed"]
    ):
        raise RuntimeError("Source clips missing — complete Grok steps first.")
    print("Card folder missing or incomplete — re-publishing from approved Grok clips.")
    _sync_foreground_to_background(work, paths)
    _publish_card(card_id=card_id, card_label=card_label, paths=paths)
    if not card_dir.exists():
        raise RuntimeError("Card missing — run create card first.")
    return card_dir


def recover_stale_approvals(
    work: Path,
    card_id: str,
    state: dict,
    *,
    probe_videos: bool = True,
) -> bool:
    """Restore approvals when artifacts still exist but state.json was cleared."""
    if state["approved"]:
        return False
    paths = _paths(work)
    card_dir = CARDS_DIR / card_id
    card_bg = card_dir / "background.mp4"
    card_fg = card_dir / "foreground.mp4"
    video_ok = output_video_ready if probe_videos else video_file_present
    background_clip = _work_background_clip(work)
    published = (
        card_dir.exists()
        and video_ok(card_bg)
        and video_ok(card_fg)
    )
    # Published card implies background + dress + card were done, even if the
    # work-dir dress clip was cleaned up or only a grok-compatible bg remains.
    if published:
        restored: list[VideoFlowStep] = ["background", "dress", "card"]
    elif background_clip and video_ok(background_clip):
        restored = ["background"]
        if video_ok(paths["foreground_dressed"]):
            restored.append("dress")
    else:
        return False
    mesh_out = MESH_DIR / f"{card_id}.json"
    if "card" in restored and mesh_out.exists():
        restored.append("mesh")
    if "mesh" in restored and symbol_points_complete(mesh_out):
        restored.append("symbols")
    state["approved"] = restored
    if not state.get("recovery_notified"):
        print(f"Recovered pipeline approvals from existing artifacts: {', '.join(restored)}")
        state["recovery_notified"] = True
    return True


def read_compress_report(card_id: str) -> dict | None:
    path = work_dir(card_id) / "compress-report.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def flow_state(card_id: str, *, probe_videos: bool = True) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    recovered = recover_stale_approvals(work, card_id, state, probe_videos=probe_videos)
    if "mesh" in state["approved"]:
        ensure_active_mesh_snapshotted(work, card_id)
    write_state(work, state)
    previews = preview_paths(work, card_id, state, probe_videos=probe_videos)
    steps = {
        step: {
            "status": step_status(work, card_id, step, state, probe_videos=probe_videos),
            "label": STEP_LABELS[step],
            "artifacts": previews[step],
        }
        for step in STEP_ORDER
    }
    return {
        "card_id": card_id,
        "approved": list(state["approved"]),
        "steps": steps,
        "complete": step_status(
            work, card_id, "compress", state, probe_videos=probe_videos
        )
        == "approved",
        "mesh_compare": mesh_compare_entries(work, card_id),
        "compress_report": read_compress_report(card_id),
        "recovered_approvals": recovered,
    }


def draft_path(work: Path) -> Path:
    return work / "draft.json"


def source_image_path(work: Path) -> Path:
    return work / "source-image.png"


def save_flow_draft(
    *,
    image: str | Path,
    background_motion_prompt: str,
    foreground_motion_prompt: str,
    dress_prompt: str,
    card_id: str,
    card_label: str,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    video_field: str,
    enhance_dress_prompt: bool,
    tracker: str,
    write_webm: bool,
    dress_reference_image: str = "",
    source_mode: str = "upload",
    source_prompt: str = "",
    face_image: str = "",
    base_image: str = "",
    mesh_tune: dict | None = None,
    ai_provider: str = "xai",
    source_image_model: str = "grok-imagine",
    background_video_model: str = "grok-imagine",
    dress_video_model: str = "wan-2.2-video-edit",
    compress_preset: str = "mobile",
    model_id: str = "",
) -> dict:
    work = work_dir(card_id)
    draft = {
        "image": str(image),
        "background_motion_prompt": background_motion_prompt,
        "foreground_motion_prompt": foreground_motion_prompt,
        "dress_prompt": dress_prompt,
        "dress_reference_image": dress_reference_image,
        "card_id": card_id,
        "card_label": card_label,
        "model_id": model_id.strip(),
        "model": model,
        "resolution": resolution,
        "image_field": image_field,
        "endpoint": endpoint,
        "video_field": video_field,
        "enhance_dress_prompt": enhance_dress_prompt,
        "tracker": tracker,
        "write_webm": write_webm,
        "compress_preset": normalize_compress_preset(compress_preset),
        "source_mode": source_mode,
        "source_prompt": source_prompt,
        "face_image": face_image,
        "base_image": base_image,
        "mesh_tune": mesh_tune_from_dict(mesh_tune).model_dump(),
        "ai_provider": normalize_provider(ai_provider),
        "source_image_model": normalize_source_image_model(
            source_image_model,
            provider=ai_provider,
        ),
        "background_video_model": normalize_background_video_model(background_video_model),
        "dress_video_model": normalize_dress_video_model(dress_video_model),
        "updated_at": time.time(),
    }
    draft_path(work).write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    return draft


def patch_flow_draft_model(card_id: str, model_id: str) -> None:
    """Sync an existing flow draft's model_id after a card is re-assigned.

    No-op when the card has no video-flow work dir / draft."""
    draft_file = WORK_DIR / card_id / "draft.json"
    if not draft_file.exists():
        return
    try:
        data = json.loads(draft_file.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    data["model_id"] = model_id.strip()
    data["updated_at"] = time.time()
    draft_file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def patch_flow_draft_source(
    card_id: str,
    *,
    image: str | Path,
    source_mode: str,
    source_prompt: str = "",
    face_image: str = "",
    base_image: str = "",
) -> dict:
    work = work_dir(card_id)
    existing = read_flow_draft(card_id) or {}
    new_image = str(image)
    image_changed = new_image != str(existing.get("image", ""))
    draft = {
        **existing,
        "image": new_image,
        "source_mode": source_mode,
        "source_prompt": source_prompt,
        "face_image": face_image,
        "base_image": base_image,
        "card_id": card_id,
        "updated_at": time.time(),
    }
    draft_path(work).write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    if image_changed:
        invalidate_after_source_image_change(card_id)
    return draft


def _resolve_image_path(image: str | Path) -> Path:
    path = Path(str(image))
    if not path.is_absolute():
        path = ROOT / path
    return path


def _source_image_newer_than_background(
    work: Path,
    paths: dict[str, Path],
    image: str | Path,
) -> bool:
    background = paths["background_raw"]
    if not output_video_ready(background):
        return False
    source = _resolve_image_path(image)
    if not source.exists():
        return False
    return source.stat().st_mtime > background.stat().st_mtime


def _clear_background_clip(paths: dict[str, Path]) -> None:
    paths["background_raw"].unlink(missing_ok=True)
    request_id_sidecar(paths["background_raw"]).unlink(missing_ok=True)


def invalidate_after_source_image_change(card_id: str) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    paths = _paths(work)
    has_background = output_video_ready(paths["background_raw"]) or "background" in state.get(
        "approved", []
    )
    if not has_background:
        return flow_state(card_id)
    print("Source image changed — clearing background clip and downstream steps.")
    return reject_flow_step(card_id, "background")


def _draft_path_value(value: str | Path) -> str:
    if not value:
        return ""
    path = Path(value)
    if not path.is_absolute():
        return str(value)
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def run_generate_source_image(
    *,
    card_id: str,
    mode: Literal["prompt", "face_swap"],
    prompt: str = "",
    face_image: str | Path = "",
    base_image: str | Path = "",
    aspect_ratio: str = "9:16",
    provider: str = "xai",
    image_model: str = "grok-imagine",
) -> dict:
    work = work_dir(card_id)
    out = source_image_path(work)
    out.unlink(missing_ok=True)
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    ai_provider = normalize_provider(provider)
    source_image_model = normalize_source_image_model(image_model, provider=provider)
    if mode == "prompt":
        generate_portrait_image(
            provider=ai_provider,
            image_model=source_image_model,
            prompt=text,
            out=out,
            face_image=face_image or None,
            aspect_ratio=aspect_ratio,
        )
        patched = patch_flow_draft_source(
            card_id,
            image=out.relative_to(ROOT).as_posix(),
            source_mode="prompt",
            source_prompt=text,
            face_image=_draft_path_value(face_image) if face_image else "",
            base_image="",
        )
    elif mode == "face_swap":
        if not base_image or not face_image:
            raise RuntimeError("Face swap requires base_image and face_image.")
        swap_face_on_image(
            provider=ai_provider,
            image_model=source_image_model,
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=None if is_stock_portrait_prompt(prompt) else prompt.strip(),
            aspect_ratio=aspect_ratio,
        )
        patched = patch_flow_draft_source(
            card_id,
            image=out.relative_to(ROOT).as_posix(),
            source_mode="face_swap",
            source_prompt="" if is_stock_portrait_prompt(prompt) else prompt.strip(),
            face_image=_draft_path_value(face_image),
            base_image=_draft_path_value(base_image),
        )
    else:  # pragma: no cover
        raise RuntimeError(f"Unknown source image mode: {mode}")
    invalidate_after_source_image_change(card_id)
    print(f"Source image written: {out.name}")
    return patched


def read_flow_draft(card_id: str) -> dict | None:
    work = WORK_DIR / card_id
    path = draft_path(work)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def flow_has_progress(work: Path) -> bool:
    if state_path(work).exists():
        return True
    if draft_path(work).exists():
        return True
    return any(work.glob("*.mp4"))


def flow_updated_at(work: Path) -> float:
    times = [path.stat().st_mtime for path in work.iterdir() if path.is_file()]
    return max(times) if times else 0.0


def list_flow_summary(card_id: str) -> dict:
    """Lightweight project row for the dropdown — no ffprobe / mesh JSON parsing."""
    work = WORK_DIR / card_id
    state = read_state(work)
    recover_stale_approvals(work, card_id, state, probe_videos=False)
    write_state(work, state)
    approved = list(state["approved"])
    steps = {}
    for step in STEP_ORDER:
        if not step_unlocked(state, step):
            status = "locked"
        elif step in approved:
            status = "approved"
        else:
            status = "ready"
        steps[step] = {
            "status": status,
            "label": STEP_LABELS[step],
            "artifacts": [],
        }
    return {
        "card_id": card_id,
        "approved": approved,
        "steps": steps,
        "complete": "compress" in approved,
        "mesh_compare": [],
        "compress_report": None,
        "recovered_approvals": False,
    }


def list_flows() -> list[dict]:
    if not WORK_DIR.exists():
        return []
    flows: list[dict] = []
    for work in WORK_DIR.iterdir():
        if not work.is_dir():
            continue
        card_id = work.name
        if not re.fullmatch(r"[a-z0-9_]+", card_id):
            continue
        if not flow_has_progress(work):
            continue
        # Dropdown only needs draft + coarse status; full probe happens on open.
        entry = list_flow_summary(card_id)
        draft = read_flow_draft(card_id)
        if draft:
            entry["draft"] = draft
        entry["updated_at"] = flow_updated_at(work)
        flows.append(entry)
    flows.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)
    return flows


def _paths(work: Path) -> dict[str, Path]:
    return {
        "background_raw": work / "background-raw.mp4",
        "foreground_dressed": work / "foreground-dressed.mp4",
    }


def run_mesh_candidate_generation(
    *,
    card_id: str,
    card_label: str,
    tracker: MeshTracker,
    mesh_tune: dict | None = None,
    force: bool = False,
) -> None:
    """Generate one mesh candidate for side-by-side comparison (does not change approvals)."""
    if tracker not in MESH_TRACKERS:
        raise RuntimeError(f"Unknown mesh tracker: {tracker}")
    tune = mesh_tune_from_dict(mesh_tune)
    work = work_dir(card_id)
    ensure_active_mesh_snapshotted(work, card_id)
    candidate = mesh_candidate_path(work, tracker)
    if candidate.exists():
        if not force:
            print(f"Mesh candidate already exists: {candidate.name} — use force to regenerate.")
            return
        candidate.unlink()
        print(f"Replacing existing candidate: {candidate.name}")
    paths = _paths(work)
    _ensure_card_published(work=work, card_id=card_id, card_label=card_label, paths=paths)
    card_dir = CARDS_DIR / card_id
    foreground = str((card_dir / "foreground.mp4").relative_to(ROOT))
    print(f"=== Mesh compare candidate: {tracker} ===")
    generate_mesh(
        build_mesh_tracking_env(
            input_video=foreground,
            output_json=str(candidate.relative_to(ROOT)),
            tracker=tracker,
            tune=tune,
        )
    )
    print(f"Candidate written: {candidate.name}")
    try:
        generate_garment_mask(candidate)
    except Exception as exc:
        print(f"Auto garment mask skipped for {candidate.name}: {exc}")


def run_video_flow_step(
    *,
    step: VideoFlowStep,
    image: str | Path,
    background_motion_prompt: str,
    foreground_motion_prompt: str,
    dress_prompt: str,
    card_id: str,
    card_label: str,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    video_field: str,
    enhance_dress_prompt: bool = True,
    tracker: str = "bootstapir",
    write_webm: bool = True,
    dress_reference_image: str = "",
    mesh_tune: dict | None = None,
    force: bool = False,
    provider: str = "xai",
    background_video_model: str = "grok-imagine",
    dress_video_model: str = "wan-2.2-video-edit",
    compress_preset: str = "mobile",
    model_id: str = "",
) -> None:
    del foreground_motion_prompt, provider
    tune = mesh_tune_from_dict(mesh_tune)
    ai_provider = "xai"
    bg_video_model = normalize_background_video_model(background_video_model)
    dress_model = normalize_dress_video_model(dress_video_model)
    delivery_preset = normalize_compress_preset(compress_preset)
    work = work_dir(card_id)
    state = read_state(work)
    paths = _paths(work)
    index = STEP_ORDER.index(step) + 1
    print(f"=== Step {index}/{len(STEP_ORDER)}: {STEP_LABELS[step]} ===")

    save_flow_draft(
        image=image,
        background_motion_prompt=background_motion_prompt,
        foreground_motion_prompt=background_motion_prompt,
        dress_prompt=dress_prompt,
        card_id=card_id,
        card_label=card_label,
        model=model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
        video_field=video_field,
        enhance_dress_prompt=enhance_dress_prompt,
        tracker=tracker,
        write_webm=write_webm,
        dress_reference_image=dress_reference_image,
        mesh_tune=tune.model_dump(),
        ai_provider=ai_provider,
        background_video_model=bg_video_model,
        dress_video_model=dress_model,
        compress_preset=delivery_preset,
        model_id=model_id,
    )

    # Re-read state in case approvals changed while the job was queued.
    state = read_state(work)
    prev = STEP_DEPS[step]
    if prev and not step_unlocked(state, step):
        missing = next(dep for dep in prev if dep not in state["approved"])
        raise RuntimeError(f"Approve the {STEP_LABELS[missing]} result before running this step.")

    if step in state["approved"] and not force:
        print(f"Already approved — skipping {step}.")
        return

    if step_artifact_ready(work, card_id, step, state) and not force and step in REVIEW_STEPS:
        if step == "background" and _source_image_newer_than_background(work, paths, image):
            print("Source image is newer than the saved background clip — regenerating.")
            _clear_background_clip(paths)
        else:
            print(f"Result already exists — open the dashboard to approve or reject it.")
            return

    if (
        step == "mesh"
        and mesh_candidates_ready(work)
        and not force
        and step not in state["approved"]
    ):
        print("Mesh candidates ready — pick one in the dashboard.")
        return

    if force:
        reject_flow_step(card_id, step)
        state = read_state(work)

    if step == "background":
        if _source_image_newer_than_background(work, paths, image):
            _clear_background_clip(paths)
        motion_prompt = normalize_background_motion_prompt(background_motion_prompt)
        if bg_video_model == "wan-2.2-spicy":
            print("Background video: WaveSpeed WAN 2.2 Spicy (image-to-video)")
        else:
            print("Background video: x.ai Grok Imagine")
        print("Motion prompt uses locked-camera framing (enhance when XAI_API_KEY is set).")
        image_to_video(
            provider=ai_provider,
            image=image,
            prompt=motion_prompt,
            out=paths["background_raw"],
            model=model,
            resolution=resolution,
            image_field=image_field,
            endpoint=endpoint,
            background_video_model=bg_video_model,
            enhance_motion_prompt=True,
        )
    elif step == "dress":
        if not output_video_ready(paths["background_raw"]):
            raise RuntimeError("Background clip missing — run the bikini step first.")
        print("Dress edit uses the approved background clip as input (same motion and scenery).")
        if dress_model == "wan-2.2-video-edit":
            print("Dress video: WaveSpeed WAN 2.2 Video Edit")
        else:
            print("Dress video: x.ai Grok Imagine (scans the bikini input video for moderation)")
        reference = (dress_reference_image or "").strip()
        if reference:
            if dress_model == "wan-2.2-video-edit":
                print(
                    f"Dress reference image on disk ({reference}) — "
                    "describe the outfit in the prompt; WAN edit is prompt-only."
                )
            else:
                print(f"Using dress reference image: {reference}")
        edit_video(
            provider=ai_provider,
            video=paths["background_raw"],
            prompt=dress_prompt,
            out=paths["foreground_dressed"],
            model=model,
            resolution=resolution,
            video_field=video_field,
            enhance=enhance_dress_prompt,
            prepare_compatible=True,
            enhance_system=DRESS_ENHANCE_SYSTEM,
            reference_image=reference or None,
            dress_video_model=dress_model,
        )
        _sync_foreground_to_background(work, paths)
    elif step == "card":
        if not output_video_ready(paths["background_raw"]) or not output_video_ready(
            paths["foreground_dressed"]
        ):
            raise RuntimeError("Source clips missing — complete Grok steps first.")
        _sync_foreground_to_background(work, paths)
        _publish_card(
            card_id=card_id,
            card_label=card_label,
            paths=paths,
            model_id=model_id or None,
        )
    elif step == "mesh":
        _ensure_card_published(work=work, card_id=card_id, card_label=card_label, paths=paths)
        card_dir = CARDS_DIR / card_id
        card = CreateCardRequest(
            id=card_id,
            label=card_label,
            background=str((card_dir / "background.mp4").relative_to(ROOT)),
            foreground=str((card_dir / "foreground.mp4").relative_to(ROOT)),
        )
        base_env = build_mesh_tracking_env(
            input_video=card.foreground,
            output_json="",
            tracker=tracker if tracker != "all" else "blend",
            tune=tune,
        )
        if tracker == "all":
            for mesh_tracker in MESH_TRACKERS:
                candidate = mesh_candidate_path(work, mesh_tracker)
                print(f"--- Mesh candidate: {mesh_tracker} ---")
                generate_mesh(
                    {
                        **base_env,
                        "OUTPUT_JSON": str(candidate.relative_to(ROOT)),
                        "TRACKER": mesh_tracker,
                    }
                )
                print(f"Candidate written: {candidate.name}")
                try:
                    generate_garment_mask(candidate)
                except Exception as exc:
                    print(f"Auto garment mask skipped for {candidate.name}: {exc}")
            print("All mesh candidates ready — pick bootstapir, cotracker, or blend in the dashboard.")
        else:
            mesh_out = MESH_DIR / f"{card.id}.json"
            generate_mesh(
                {
                    **base_env,
                    "OUTPUT_JSON": str(mesh_out.relative_to(ROOT)),
                    "TRACKER": tracker,
                }
            )
            print(f"Mesh written: {mesh_out.name}")
            try:
                generate_garment_mask(mesh_out)
            except Exception as exc:
                print(f"Auto garment mask skipped for {mesh_out.name}: {exc}")
    elif step == "symbols":
        mesh_out = MESH_DIR / f"{card_id}.json"
        if not mesh_out.exists():
            raise RuntimeError("Mesh missing — generate mesh first.")
        if not symbol_points_complete(mesh_out):
            raise RuntimeError(
                "Place 12 symbol points in the dashboard before continuing."
            )
        print(f"Symbol points verified in {mesh_out.name}")
    elif step == "compress":
        _ensure_card_published(work=work, card_id=card_id, card_label=card_label, paths=paths)
        card_dir = CARDS_DIR / card_id
        bg_dst, fg_dst = card_paths(ROOT, CARDS_DIR, card_id)
        if not output_video_ready(bg_dst) or not output_video_ready(fg_dst):
            raise RuntimeError("Card videos missing — run create card first.")
        # Work-dir raws may be gone after cleanup; published card clips are enough.
        background_clip = _work_background_clip(work) or bg_dst
        foreground_clip = (
            paths["foreground_dressed"]
            if output_video_ready(paths["foreground_dressed"])
            else fg_dst
        )
        report = finalize_card_videos(
            background_src=background_clip,
            foreground_src=foreground_clip,
            background_dst=bg_dst,
            foreground_dst=fg_dst,
            motion_reference=background_clip,
            work_dir=work,
            backup_dir=ROOT / ".video-backups",
            preset=delivery_preset,
            write_webm=write_webm,
            report_path=work / "compress-report.json",
        )
        print(
            f"Delivery ready under {card_dir} "
            f"({report['preset_label']}, saved {report['saved']})"
        )
    else:  # pragma: no cover
        raise RuntimeError(f"Unknown step: {step}")

    if step in REVIEW_STEPS:
        print(f"Step complete: {step} — preview the clip in the dashboard, then continue.")
    elif step == "mesh" and tracker == "all":
        print(f"Step complete: {step} — pick a mesh tracker in the dashboard.")
    else:
        approve_flow_step(card_id, step)
        print(f"Step complete: {step} — ready for next step.")


def video_flow(
    *,
    image: str | Path,
    background_motion_prompt: str,
    foreground_motion_prompt: str,
    dress_prompt: str,
    card_id: str,
    card_label: str,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    video_field: str,
    enhance_dress_prompt: bool = True,
    tracker: str = "bootstapir",
    write_webm: bool = True,
) -> None:
    """Run every step sequentially (CLI / legacy full pipeline)."""
    shared = {
        "image": image,
        "background_motion_prompt": background_motion_prompt,
        "foreground_motion_prompt": foreground_motion_prompt,
        "dress_prompt": dress_prompt,
        "card_id": card_id,
        "card_label": card_label,
        "model": model,
        "resolution": resolution,
        "image_field": image_field,
        "endpoint": endpoint,
        "video_field": video_field,
        "enhance_dress_prompt": enhance_dress_prompt,
        "tracker": tracker,
        "write_webm": write_webm,
    }
    for step in STEP_ORDER:
        run_video_flow_step(step=step, **shared)
        if step in REVIEW_STEPS:
            approve_flow_step(card_id, step)
    print(f"Video flow complete: card={card_id}")
