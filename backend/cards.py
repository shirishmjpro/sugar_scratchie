from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field


CARD_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

ORIGINAL_ID = "original"
ORIGINAL_BACKGROUND = "public/cards/ai girl 2.mp4"
ORIGINAL_FOREGROUND = "public/cards/Green bg sample 2 swap.mp4"
ORIGINAL_MESH = "tracked-mesh.json"


class PhotoInfo(BaseModel):
    id: str
    src: str


class CardInfo(BaseModel):
    id: str
    label: str
    background: str
    foreground: str
    mesh: str
    has_mesh: bool
    model_id: str | None = None
    sort_order: int = 0
    photos: list[PhotoInfo] = Field(default_factory=list)


class CreateCardRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    background: str
    foreground: str
    model_id: str | None = None


class UpdateCardRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    background: str | None = None
    foreground: str | None = None
    model_id: str | None = None
    sort_order: int | None = None


class ReorderCardsRequest(BaseModel):
    card_ids: list[str] = Field(min_length=1)


PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


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


def read_card_meta(card_dir: Path, default_label: str) -> dict:
    meta = card_dir / "meta.json"
    if not meta.exists():
        return {"label": default_label}
    try:
        data = json.loads(meta.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {"label": default_label}


def read_card_label(card_dir: Path, default: str) -> str:
    meta = read_card_meta(card_dir, default)
    label = meta.get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    return default


def read_card_model_id(card_dir: Path) -> str | None:
    meta = read_card_meta(card_dir, "")
    model_id = meta.get("model_id")
    if isinstance(model_id, str) and model_id.strip():
        return model_id.strip()
    return None


def read_card_sort_order(card_dir: Path) -> int:
    meta = read_card_meta(card_dir, "")
    value = meta.get("sort_order")
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def write_card_sort_order(card_dir: Path, sort_order: int) -> None:
    write_card_meta(card_dir, sort_order=int(sort_order))


def next_sort_order_for_model(cards_dir: Path, model_id: str | None) -> int:
    if not model_id or not cards_dir.exists():
        return 0
    highest = -1
    for directory in cards_dir.iterdir():
        if not directory.is_dir():
            continue
        if read_card_model_id(directory) != model_id:
            continue
        highest = max(highest, read_card_sort_order(directory))
    return highest + 1


def read_card_photos(card_dir: Path, card_id: str) -> list[PhotoInfo]:
    meta = read_card_meta(card_dir, card_id)
    raw = meta.get("photos")
    if not isinstance(raw, list):
        return []
    photos: list[PhotoInfo] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        photo_id = entry.get("id")
        src = entry.get("src")
        if isinstance(photo_id, str) and photo_id.strip() and isinstance(src, str) and src.strip():
            photos.append(PhotoInfo(id=photo_id.strip(), src=src.strip()))
    return photos


def write_card_meta(card_dir: Path, **updates: object) -> None:
    default_label = card_dir.name.replace("_", " ").title()
    data = read_card_meta(card_dir, default_label)
    for key, value in updates.items():
        if value is not None:
            data[key] = value
    card_dir.mkdir(parents=True, exist_ok=True)
    (card_dir / "meta.json").write_text(json.dumps(data, indent=2) + "\n")


def write_card_label(card_dir: Path, label: str) -> None:
    write_card_meta(card_dir, label=label.strip())


def write_card_model_id(card_dir: Path, model_id: str | None) -> None:
    if model_id and model_id.strip():
        write_card_meta(card_dir, model_id=model_id.strip())
    else:
        data = read_card_meta(card_dir, card_dir.name.replace("_", " ").title())
        data.pop("model_id", None)
        card_dir.mkdir(parents=True, exist_ok=True)
        (card_dir / "meta.json").write_text(json.dumps(data, indent=2) + "\n")


def write_card_photos(card_dir: Path, photos: list[PhotoInfo]) -> None:
    write_card_meta(
        card_dir,
        photos=[{"id": photo.id, "src": photo.src} for photo in photos],
    )


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
            sort_order=0,
        )
    ]

    if not cards_dir.exists():
        return cards

    discovered: list[CardInfo] = []
    for directory in cards_dir.iterdir():
        if not directory.is_dir():
            continue
        background = directory / "background.mp4"
        foreground = directory / "foreground.mp4"
        if not background.exists() or not foreground.exists():
            continue
        card_id = directory.name
        mesh = f"{card_id}.json"
        discovered.append(
            CardInfo(
                id=card_id,
                label=read_card_label(directory, card_id.replace("_", " ").title()),
                background=relative(root, background),
                foreground=relative(root, foreground),
                mesh=mesh,
                has_mesh=mesh in meshes,
                model_id=read_card_model_id(directory),
                sort_order=read_card_sort_order(directory),
                photos=read_card_photos(directory, card_id),
            )
        )
    discovered.sort(key=lambda card: (card.model_id or "", card.sort_order, card.id))
    cards.extend(discovered)
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
                "sort_order": card.sort_order,
                **({"model_id": card.model_id} if card.model_id else {}),
                **(
                    {"photos": [{"id": photo.id, "src": photo.src} for photo in card.photos]}
                    if card.photos
                    else {}
                ),
            }
            for card in cards
        ]
    }
    cards_dir.mkdir(parents=True, exist_ok=True)
    (cards_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n")


def reorder_model_cards(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
    card_ids: list[str],
) -> list[CardInfo]:
    if not card_ids:
        raise HTTPException(status_code=400, detail="card_ids must not be empty")
    if len(set(card_ids)) != len(card_ids):
        raise HTTPException(status_code=400, detail="card_ids must be unique")

    cards = list_cards(root, cards_dir, mesh_dir)
    owned = [card for card in cards if card.model_id == model_id]
    owned_ids = {card.id for card in owned}
    if set(card_ids) != owned_ids:
        raise HTTPException(
            status_code=400,
            detail="card_ids must include every motion card for this model, and only those cards",
        )

    for index, card_id in enumerate(card_ids):
        write_card_sort_order(card_directory(cards_dir, card_id), index)
    write_cards_index(root, cards_dir, mesh_dir)
    return [card for card in list_cards(root, cards_dir, mesh_dir) if card.model_id == model_id]


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
    sort_order = next_sort_order_for_model(cards_dir, request.model_id) if request.model_id else 0
    if request.model_id:
        write_card_model_id(card_dir, request.model_id)
        write_card_sort_order(card_dir, sort_order)
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
        model_id=request.model_id,
        sort_order=sort_order,
        photos=[],
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
    if request.model_id is not None:
        previous_model = card.model_id
        if request.model_id and request.model_id != previous_model and request.sort_order is None:
            write_card_sort_order(card_dir, next_sort_order_for_model(cards_dir, request.model_id))
        write_card_model_id(card_dir, request.model_id)
    if request.sort_order is not None:
        write_card_sort_order(card_dir, request.sort_order)

    write_cards_index(root, cards_dir, mesh_dir)
    meshes = mesh_names(mesh_dir)
    return CardInfo(
        id=card.id,
        label=label,
        background=relative(root, background_dst),
        foreground=relative(root, foreground_dst),
        mesh=card.mesh,
        has_mesh=card.mesh in meshes,
        model_id=read_card_model_id(card_dir),
        sort_order=read_card_sort_order(card_dir),
        photos=read_card_photos(card_dir, card.id),
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


def card_photos_dir(cards_dir: Path, card_id: str) -> Path:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot add photos to the original card")
    return cards_dir / card_id / "photos"


async def upload_card_photo(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    upload: UploadFile,
) -> PhotoInfo:
    cards = list_cards(root, cards_dir, mesh_dir)
    card = next((entry for entry in cards if entry.id == card_id), None)
    if not card:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Photo must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded photo is empty")
    photo_id = uuid.uuid4().hex[:12]
    photos_dir = card_photos_dir(cards_dir, card_id)
    photos_dir.mkdir(parents=True, exist_ok=True)
    target = photos_dir / f"{photo_id}{ext}"
    target.write_bytes(data)
    src = public_url(f"cards/{card_id}/photos/{photo_id}{ext}")
    photos = [*card.photos, PhotoInfo(id=photo_id, src=src)]
    write_card_photos(cards_dir / card_id, photos)
    write_cards_index(root, cards_dir, mesh_dir)
    return PhotoInfo(id=photo_id, src=src)


def delete_card_photo(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    photo_id: str,
) -> None:
    cards = list_cards(root, cards_dir, mesh_dir)
    card = next((entry for entry in cards if entry.id == card_id), None)
    if not card:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    photo = next((entry for entry in card.photos if entry.id == photo_id), None)
    if not photo:
        raise HTTPException(status_code=404, detail=f"Photo not found: {photo_id}")
    photos_dir = card_photos_dir(cards_dir, card_id)
    for path in photos_dir.glob(f"{photo_id}.*"):
        if path.is_file():
            path.unlink()
    remaining = [entry for entry in card.photos if entry.id != photo_id]
    write_card_photos(cards_dir / card_id, remaining)
    write_cards_index(root, cards_dir, mesh_dir)
