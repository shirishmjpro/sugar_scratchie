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
from backend.services.grok import (
    DRESS_ENHANCE_SYSTEM,
    edit_video,
    image_to_video,
    output_video_ready,
    probe_video,
    request_id_sidecar,
)
from backend.services.mesh_symbols import (
    clear_symbol_points,
    read_symbol_points,
    symbol_points_complete,
)
from backend.services.mesh_tracking import generate_mesh
from backend.services.video_prep import (
    align_clip_to_reference,
    backup_video,
    compress_video,
    compress_video_webm,
)

ROOT = Path(__file__).resolve().parents[2]
CARDS_DIR = ROOT / "public" / "cards"
MESH_DIR = ROOT / "public" / "mesh"
WORK_DIR = ROOT / ".tmp" / "video-flow"

VideoFlowStep = Literal["background", "dress", "card", "mesh", "symbols", "compress"]

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
    "compress": "Compress front and back videos",
}


def work_dir(card_id: str) -> Path:
    work = WORK_DIR / card_id
    work.mkdir(parents=True, exist_ok=True)
    return work


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


def artifact_paths(work: Path, card_id: str, state: dict | None = None) -> dict[VideoFlowStep, list[str]]:
    mesh_out = MESH_DIR / f"{card_id}.json"
    card_bg = CARDS_DIR / card_id / "background.mp4"
    card_fg = CARDS_DIR / card_id / "foreground.mp4"
    approved = state["approved"] if state else []
    background_raw = work / "background-raw.mp4"
    foreground_dressed = work / "foreground-dressed.mp4"
    return {
        "background": [
            str(background_raw.relative_to(ROOT)) if output_video_ready(background_raw) else ""
        ],
        "dress": [
            str(foreground_dressed.relative_to(ROOT))
            if output_video_ready(foreground_dressed) and "background" in approved
            else ""
        ],
        "card": [
            str(card_bg.relative_to(ROOT)) if output_video_ready(card_bg) else "",
            str(card_fg.relative_to(ROOT)) if output_video_ready(card_fg) else "",
        ],
        "mesh": [str(mesh_out.relative_to(ROOT)) if mesh_out.exists() else ""],
        "symbols": [
            str(mesh_out.relative_to(ROOT))
            if mesh_out.exists() and symbol_points_complete(mesh_out)
            else ""
        ],
        "compress": [
            str(card_bg.relative_to(ROOT)) if output_video_ready(card_bg) else "",
            str(card_fg.relative_to(ROOT)) if output_video_ready(card_fg) else "",
        ],
    }


def preview_paths(work: Path, card_id: str, state: dict | None = None) -> dict[VideoFlowStep, list[str]]:
    artifacts = artifact_paths(work, card_id, state)
    return {step: [path for path in paths if path] for step, paths in artifacts.items()}


def step_artifact_ready(work: Path, card_id: str, step: VideoFlowStep, state: dict | None = None) -> bool:
    if step == "symbols":
        mesh_out = MESH_DIR / f"{card_id}.json"
        return mesh_out.exists() and symbol_points_complete(mesh_out)
    paths = preview_paths(work, card_id, state)[step]
    if not paths:
        return False
    for rel in paths:
        path = ROOT / rel
        if step in ("background", "dress", "compress", "card"):
            if not output_video_ready(path):
                return False
        elif not path.exists():
            return False
    return True


def step_unlocked(state: dict, step: VideoFlowStep) -> bool:
    return all(dep in state["approved"] for dep in STEP_DEPS[step])


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
        mesh_out = MESH_DIR / f"{card_id}.json"
        mesh_out.unlink(missing_ok=True)

    if step == "symbols":
        clear_symbol_points(MESH_DIR / f"{card_id}.json")

    if step == "compress":
        card_dir = CARDS_DIR / card_id
        if card_dir.exists():
            for sidecar in (card_dir / "background.webm", card_dir / "foreground.webm"):
                sidecar.unlink(missing_ok=True)


def approve_flow_step(card_id: str, step: VideoFlowStep) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    if not step_artifact_ready(work, card_id, step, state):
        raise RuntimeError(f"Step '{step}' has no result to approve yet.")
    prev = STEP_DEPS[step]
    if prev and not step_unlocked(state, step):
        missing = next(dep for dep in prev if dep not in state["approved"])
        raise RuntimeError(f"Approve '{STEP_LABELS[missing]}' before '{STEP_LABELS[step]}'.")
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


def step_status(work: Path, card_id: str, step: VideoFlowStep, state: dict) -> str:
    if not step_unlocked(state, step):
        return "locked"
    if step in state["approved"]:
        if not step_artifact_ready(work, card_id, step, state):
            return "ready"
        return "approved"
    if step in REVIEW_STEPS and step_artifact_ready(work, card_id, step, state):
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


def _publish_card(
    *,
    card_id: str,
    card_label: str,
    paths: dict[str, Path],
) -> None:
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


def flow_state(card_id: str) -> dict:
    work = work_dir(card_id)
    state = read_state(work)
    write_state(work, state)
    previews = preview_paths(work, card_id, state)
    steps = {
        step: {
            "status": step_status(work, card_id, step, state),
            "label": STEP_LABELS[step],
            "artifacts": previews[step],
        }
        for step in STEP_ORDER
    }
    return {
        "card_id": card_id,
        "approved": list(state["approved"]),
        "steps": steps,
        "complete": step_status(work, card_id, "compress", state) == "approved",
    }


def draft_path(work: Path) -> Path:
    return work / "draft.json"


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
) -> dict:
    work = work_dir(card_id)
    draft = {
        "image": str(image),
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
        "updated_at": time.time(),
    }
    draft_path(work).write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    return draft


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
        entry = flow_state(card_id)
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
    force: bool = False,
) -> None:
    del foreground_motion_prompt  # kept in draft/API for backward compatibility
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
    )

    prev = STEP_DEPS[step]
    if prev and not step_unlocked(state, step):
        missing = next(dep for dep in prev if dep not in state["approved"])
        raise RuntimeError(f"Approve the {STEP_LABELS[missing]} result before running this step.")

    if step in state["approved"] and not force:
        print(f"Already approved — skipping {step}.")
        return

    if step_artifact_ready(work, card_id, step, state) and not force and step in REVIEW_STEPS:
        print(f"Result already exists — open the dashboard to approve or reject it.")
        return

    if force:
        reject_flow_step(card_id, step)

    if step == "background":
        image_to_video(
            image=image,
            prompt=background_motion_prompt,
            out=paths["background_raw"],
            model=model,
            resolution=resolution,
            image_field=image_field,
            endpoint=endpoint,
        )
    elif step == "dress":
        if not output_video_ready(paths["background_raw"]):
            raise RuntimeError("Background clip missing — run the bikini step first.")
        print("Dress edit uses the approved background clip as input (same motion and scenery).")
        edit_video(
            video=paths["background_raw"],
            prompt=dress_prompt,
            out=paths["foreground_dressed"],
            model=model,
            resolution=resolution,
            video_field=video_field,
            enhance=enhance_dress_prompt,
            prepare_compatible=True,
            enhance_system=DRESS_ENHANCE_SYSTEM,
        )
        _sync_foreground_to_background(work, paths)
    elif step == "card":
        if not output_video_ready(paths["background_raw"]) or not output_video_ready(
            paths["foreground_dressed"]
        ):
            raise RuntimeError("Source clips missing — complete Grok steps first.")
        _sync_foreground_to_background(work, paths)
        _publish_card(card_id=card_id, card_label=card_label, paths=paths)
    elif step == "mesh":
        _ensure_card_published(work=work, card_id=card_id, card_label=card_label, paths=paths)
        card_dir = CARDS_DIR / card_id
        card = CreateCardRequest(
            id=card_id,
            label=card_label,
            background=str((card_dir / "background.mp4").relative_to(ROOT)),
            foreground=str((card_dir / "foreground.mp4").relative_to(ROOT)),
        )
        mesh_out = MESH_DIR / f"{card.id}.json"
        env = {
            "PYTORCH_ENABLE_MPS_FALLBACK": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "DEVICE": os.environ.get("DEVICE", "cpu"),
            "INPUT_VIDEO": card.foreground,
            "OUTPUT_JSON": str(mesh_out.relative_to(ROOT)),
            "TRACKER": tracker,
            "SILHOUETTE_SOURCE": "person",
        }
        generate_mesh(env)
        print(f"Mesh written: {mesh_out.name}")
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
        bg_meta = probe_video(paths["background_raw"])
        fg_meta = probe_video(paths["foreground_dressed"])
        card_bg_meta = probe_video(bg_dst)
        card_fg_meta = probe_video(fg_dst)
        print(
            "Sync check: "
            f"background={bg_meta['duration']:.2f}s "
            f"foreground={fg_meta['duration']:.2f}s "
            f"card_bg={card_bg_meta['duration']:.2f}s "
            f"card_fg={card_fg_meta['duration']:.2f}s"
        )
        aligned_fg = work / "foreground-aligned-for-compress.mp4"
        align_clip_to_reference(paths["background_raw"], fg_dst, aligned_fg)
        bg_tmp = work / "compress-bg-tmp.mp4"
        fg_tmp = work / "compress-fg-tmp.mp4"
        compress_video(bg_dst, bg_tmp)
        compress_video(aligned_fg, fg_tmp)
        backup_video(bg_dst)
        backup_video(fg_dst)
        shutil.move(str(bg_tmp), str(bg_dst))
        shutil.move(str(fg_tmp), str(fg_dst))
        if write_webm:
            compress_video_webm(bg_dst, bg_dst.with_suffix(".webm"))
            compress_video_webm(fg_dst, fg_dst.with_suffix(".webm"))
        print(f"Compressed card videos under {card_dir}")
    else:  # pragma: no cover
        raise RuntimeError(f"Unknown step: {step}")

    if step in REVIEW_STEPS:
        print(f"Step complete: {step} — preview the clip in the dashboard, then continue.")
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
