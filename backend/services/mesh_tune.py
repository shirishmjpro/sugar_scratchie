from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.services.mesh_tracking import default_mesh_device


class MeshTuneOptions(BaseModel):
    loop_close: bool = False
    prune_speed_mad_k: float = Field(default=4.0, ge=1.0, le=12.0)
    prune_min_mean_vis: float = Field(default=0.25, ge=0.05, le=0.9)
    field_neighbors: int = Field(default=4, ge=1, le=16)
    field_power: float = Field(default=2.5, ge=0.5, le=4.0)
    silhouette_source: Literal["person", "chroma"] = "person"
    per_frame_mask: bool = False
    ref_frame: int | None = Field(default=None, ge=0)


DEFAULT_MESH_TUNE = MeshTuneOptions()


def mesh_tune_from_dict(raw: dict | None) -> MeshTuneOptions:
    if not raw:
        return DEFAULT_MESH_TUNE.model_copy()
    return MeshTuneOptions.model_validate(raw)


def build_mesh_tracking_env(
    *,
    input_video: str,
    output_json: str,
    tracker: str,
    tune: MeshTuneOptions | None = None,
    device: str | None = None,
) -> dict[str, str]:
    opts = tune or DEFAULT_MESH_TUNE
    env: dict[str, str] = {
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DEVICE": device or default_mesh_device(),
        "INPUT_VIDEO": input_video,
        "OUTPUT_JSON": output_json,
        "TRACKER": tracker,
        "SILHOUETTE_SOURCE": opts.silhouette_source,
        "LOOP_CLOSE": "1" if opts.loop_close else "0",
        "PRUNE_SPEED_MAD_K": str(opts.prune_speed_mad_k),
        "PRUNE_MIN_MEAN_VIS": str(opts.prune_min_mean_vis),
        "FIELD_NEIGHBORS": str(opts.field_neighbors),
        "FIELD_POWER": str(opts.field_power),
        "PER_FRAME_MASK": "1" if opts.per_frame_mask else "0",
    }
    if opts.ref_frame is not None:
        env["REF_FRAME"] = str(opts.ref_frame)
    return env
