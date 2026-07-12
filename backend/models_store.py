from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.cards import list_cards, public_url

MODEL_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

AVATAR_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class ModelInfo(BaseModel):
    id: str
    label: str
    avatar: str | None = None
    created_at: float | None = None


class CreateModelRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)


class UpdateModelRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)


def safe_model_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not MODEL_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Model id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def read_model_meta(model_dir: Path, default_label: str) -> dict:
    meta = model_dir / "meta.json"
    if not meta.exists():
        return {"label": default_label}
    try:
        data = json.loads(meta.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {"label": default_label}


def write_model_meta(model_dir: Path, *, label: str, created_at: float | None = None) -> None:
    meta = model_dir / "meta.json"
    data: dict = {}
    if meta.exists():
        try:
            loaded = json.loads(meta.read_text())
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            pass
    data["label"] = label.strip()
    if created_at is not None:
        data["created_at"] = created_at
    elif "created_at" not in data:
        data["created_at"] = time.time()
    model_dir.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps(data, indent=2) + "\n")


def find_avatar(model_dir: Path) -> str | None:
    for ext in AVATAR_EXTENSIONS:
        candidate = model_dir / f"avatar{ext}"
        if candidate.is_file():
            return public_url(f"models/{model_dir.name}/avatar{ext}")
    return None


def list_models(models_dir: Path) -> list[ModelInfo]:
    if not models_dir.exists():
        return []
    models: list[ModelInfo] = []
    for directory in sorted(path for path in models_dir.iterdir() if path.is_dir()):
        meta = read_model_meta(directory, directory.name.replace("_", " ").title())
        label = meta.get("label")
        if not isinstance(label, str) or not label.strip():
            label = directory.name.replace("_", " ").title()
        created_at = meta.get("created_at")
        models.append(
            ModelInfo(
                id=directory.name,
                label=label.strip(),
                avatar=find_avatar(directory),
                created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
            )
        )
    return models


def write_models_index(models_dir: Path) -> None:
    models = list_models(models_dir)
    payload = {
        "models": [
            {
                "id": model.id,
                "label": model.label,
                "avatar": model.avatar,
            }
            for model in models
        ]
    }
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n")


def create_model(models_dir: Path, request: CreateModelRequest) -> ModelInfo:
    model_id = safe_model_id(request.id)
    model_dir = models_dir / model_id
    if model_dir.exists():
        raise HTTPException(status_code=409, detail=f"Model already exists: {model_id}")
    created_at = time.time()
    write_model_meta(model_dir, label=request.label, created_at=created_at)
    write_models_index(models_dir)
    return ModelInfo(
        id=model_id,
        label=request.label.strip(),
        avatar=None,
        created_at=created_at,
    )


def update_model(models_dir: Path, model_id: str, request: UpdateModelRequest) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = request.label.strip() if request.label is not None else str(meta.get("label", model_id))
    write_model_meta(model_dir, label=label)
    write_models_index(models_dir)
    created_at = meta.get("created_at")
    return ModelInfo(
        id=model_id,
        label=label,
        avatar=find_avatar(model_dir),
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


def delete_model(
    root: Path,
    models_dir: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
) -> None:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    cards = list_cards(root, cards_dir, mesh_dir)
    linked = [card.id for card in cards if card.model_id == model_id]
    if linked:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete model — cards still reference it: {', '.join(linked)}",
        )
    shutil.rmtree(model_dir)
    write_models_index(models_dir)


async def upload_model_avatar(models_dir: Path, model_id: str, upload: UploadFile) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in AVATAR_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Avatar must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded avatar is empty")
    for old_ext in AVATAR_EXTENSIONS:
        old = model_dir / f"avatar{old_ext}"
        if old.exists():
            old.unlink()
    target = model_dir / f"avatar{ext}"
    target.write_bytes(data)
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return ModelInfo(
        id=model_id,
        label=label,
        avatar=public_url(f"models/{model_id}/avatar{ext}"),
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )
