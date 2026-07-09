from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
from pydantic import BaseModel, Field


CARD_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

ORIGINAL_ID = "original"
ORIGINAL_BACKGROUND = "public/cards/ai girl 2.mp4"
ORIGINAL_FOREGROUND = "public/cards/Green bg sample 2 swap.mp4"
ORIGINAL_MESH = "tracked-mesh.json"


class CardInfo(BaseModel):
    id: str
    label: str
    background: str
    foreground: str
    mesh: str
    has_mesh: bool


class CreateCardRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    background: str
    foreground: str


class UpdateCardRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    background: str | None = None
    foreground: str | None = None


def relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def safe_card_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not CARD_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Card id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def read_card_label(card_dir: Path, default: str) -> str:
    meta = card_dir / "meta.json"
    if not meta.exists():
        return default
    try:
        data = json.loads(meta.read_text())
    except Exception:
        return default
    label = data.get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    return default


def write_card_label(card_dir: Path, label: str) -> None:
    meta = card_dir / "meta.json"
    data: dict[str, str] = {}
    if meta.exists():
        try:
            loaded = json.loads(meta.read_text())
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            pass
    data["label"] = label.strip()
    card_dir.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps(data, indent=2) + "\n")


def mesh_names(mesh_dir: Path) -> set[str]:
    if not mesh_dir.exists():
        return set()
    return {path.name for path in mesh_dir.glob("*.json") if path.name != "index.json"}


def list_cards(root: Path, cards_dir: Path, mesh_dir: Path) -> list[CardInfo]:
    meshes = mesh_names(mesh_dir)
    cards: list[CardInfo] = [
        CardInfo(
            id=ORIGINAL_ID,
            label=read_card_label(cards_dir, "Original"),
            background=ORIGINAL_BACKGROUND,
            foreground=ORIGINAL_FOREGROUND,
            mesh=ORIGINAL_MESH,
            has_mesh=ORIGINAL_MESH in meshes,
        )
    ]

    if not cards_dir.exists():
        return cards

    for directory in sorted(path for path in cards_dir.iterdir() if path.is_dir()):
        background = directory / "background.mp4"
        foreground = directory / "foreground.mp4"
        if not background.exists() or not foreground.exists():
            continue
        card_id = directory.name
        mesh = f"{card_id}.json"
        cards.append(
            CardInfo(
                id=card_id,
                label=read_card_label(directory, card_id.replace("_", " ").title()),
                background=relative(root, background),
                foreground=relative(root, foreground),
                mesh=mesh,
                has_mesh=mesh in meshes,
            )
        )
    return cards


def write_cards_index(root: Path, cards_dir: Path, mesh_dir: Path) -> None:
    cards = list_cards(root, cards_dir, mesh_dir)
    payload = {
        "cards": [
            {
                "id": card.id,
                "label": card.label,
                "bottom": public_url(card.background),
                "foreground": public_url(card.foreground),
                "mesh": card.mesh,
                "chroma_key": card.id == ORIGINAL_ID,
            }
            for card in cards
        ]
    }
    cards_dir.mkdir(parents=True, exist_ok=True)
    (cards_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n")


def public_url(workspace_path: str) -> str:
    trimmed = workspace_path.strip()
    if trimmed.startswith("public/"):
        trimmed = trimmed.removeprefix("public/")
    parts = [part for part in trimmed.split("/") if part]
    encoded = "/".join(quote(part) for part in parts)
    return f"/{encoded}"


def resolve_source(root: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    if root.resolve() not in resolved.parents and resolved != root.resolve():
        raise HTTPException(status_code=400, detail=f"Path is outside the project: {value}")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"Video not found: {value}")
    return resolved


def copy_video(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def card_paths(root: Path, cards_dir: Path, card_id: str) -> tuple[Path, Path]:
    if card_id == ORIGINAL_ID:
        return root / ORIGINAL_BACKGROUND, root / ORIGINAL_FOREGROUND
    card_dir = cards_dir / card_id
    return card_dir / "background.mp4", card_dir / "foreground.mp4"


def card_directory(cards_dir: Path, card_id: str) -> Path:
    if card_id == ORIGINAL_ID:
        return cards_dir
    return cards_dir / card_id


def create_card(root: Path, cards_dir: Path, mesh_dir: Path, request: CreateCardRequest) -> CardInfo:
    card_id = safe_card_id(request.id)
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot create a card with id 'original'")
    card_dir = cards_dir / card_id
    if card_dir.exists():
        raise HTTPException(status_code=409, detail=f"Card already exists: {card_id}")

    background_src = resolve_source(root, request.background)
    foreground_src = resolve_source(root, request.foreground)
    background_dst, foreground_dst = card_paths(root, cards_dir, card_id)
    copy_video(background_src, background_dst)
    copy_video(foreground_src, foreground_dst)
    write_card_label(card_dir, request.label)
    write_cards_index(root, cards_dir, mesh_dir)
    meshes = mesh_names(mesh_dir)
    mesh = f"{card_id}.json"
    return CardInfo(
        id=card_id,
        label=request.label.strip(),
        background=relative(root, background_dst),
        foreground=relative(root, foreground_dst),
        mesh=mesh,
        has_mesh=mesh in meshes,
    )


def update_card(root: Path, cards_dir: Path, mesh_dir: Path, card_id: str, request: UpdateCardRequest) -> CardInfo:
    cards = list_cards(root, cards_dir, mesh_dir)
    card = next((entry for entry in cards if entry.id == card_id), None)
    if not card:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")

    card_dir = card_directory(cards_dir, card_id)
    background_dst, foreground_dst = card_paths(root, cards_dir, card_id)

    if request.background is not None:
        copy_video(resolve_source(root, request.background), background_dst)
    if request.foreground is not None:
        copy_video(resolve_source(root, request.foreground), foreground_dst)

    label = card.label
    if request.label is not None:
        label = request.label.strip()
        write_card_label(card_dir, label)

    write_cards_index(root, cards_dir, mesh_dir)
    meshes = mesh_names(mesh_dir)
    return CardInfo(
        id=card.id,
        label=label,
        background=relative(root, background_dst),
        foreground=relative(root, foreground_dst),
        mesh=card.mesh,
        has_mesh=card.mesh in meshes,
    )


def delete_card(root: Path, cards_dir: Path, mesh_dir: Path, card_id: str) -> None:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="The original card cannot be deleted")
    card_dir = cards_dir / card_id
    if not card_dir.exists():
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    shutil.rmtree(card_dir)
    write_cards_index(root, cards_dir, mesh_dir)


def compress_card(
    root: Path,
    cards_dir: Path,
    card_id: str,
    *,
    write_webm: bool = True,
    compress_preset: str = "mobile",
) -> None:
    """Re-encode a card's background/foreground in place using the same settings
    as the Video Flow finalize step. Originals are backed up under .video-backups/
    before being overwritten."""
    from backend.services.video_prep import (
        backup_video,
        compress_video,
        compress_video_webm,
        normalize_compress_preset,
    )

    background, foreground = card_paths(root, cards_dir, card_id)
    if not background.is_file() or not foreground.is_file():
        raise HTTPException(status_code=404, detail=f"Card videos not found: {card_id}")

    preset = normalize_compress_preset(compress_preset)
    backup_dir = root / ".video-backups"
    for src in (background, foreground):
        backup_video(src, backup_dir)
        tmp = src.with_name(f"{src.stem}-compress-tmp{src.suffix}")
        compress_video(src, tmp, preset=preset)
        shutil.move(str(tmp), str(src))
        if write_webm:
            compress_video_webm(src, src.with_suffix(".webm"), preset=preset)
