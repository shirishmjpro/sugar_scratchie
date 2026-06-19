from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
CARDS_DIR = PUBLIC / "cards"
MESH_DIR = PUBLIC / "mesh"
PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON_CMD = str(PYTHON if PYTHON.exists() else Path(sys.executable))


def now() -> float:
    return round(time.time(), 3)


def workspace_path(value: str, *, must_exist: bool = False) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve()
    if ROOT not in resolved.parents and resolved != ROOT:
        raise HTTPException(status_code=400, detail=f"Path is outside the project: {value}")
    if must_exist and not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {value}")
    return resolved


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


class CardInfo(BaseModel):
    id: str
    label: str
    background: str
    foreground: str
    mesh: str
    has_mesh: bool


class MeshInfo(BaseModel):
    file: str
    path: str
    source: str | None = None
    tracker: str | None = None
    generator: str | None = None
    frames: int | None = None
    cols: int | None = None
    rows: int | None = None
    size_bytes: int
    modified_at: float


class GenerateMeshRequest(BaseModel):
    input_video: str
    output_json: str
    tracker: Literal["cotracker", "bootstapir", "blend"] = "bootstapir"
    debug_overlay: bool = False
    compare_trackers: bool = False
    fps: float | None = Field(default=None, gt=0)
    grid_cols: int | None = Field(default=None, ge=2)
    grid_rows: int | None = Field(default=None, ge=2)
    loop_close: float | None = Field(default=None, ge=0)
    extra_driver_points: int | None = Field(default=None, ge=0)


class GrokEditRequest(BaseModel):
    video: str
    prompt: str = Field(min_length=1)
    out: str
    enhance: bool = False
    model: str = "grok-imagine-video-1.5"
    resolution: str = "720p"
    video_field: str = "video"


@dataclass
class Job:
    id: str
    kind: str
    command: list[str]
    env: dict[str, str]
    status: str = "queued"
    created_at: float = field(default_factory=now)
    started_at: float | None = None
    ended_at: float | None = None
    return_code: int | None = None
    logs: list[str] = field(default_factory=list)
    process: subprocess.Popen[str] | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "command": self.command,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "return_code": self.return_code,
            "logs": self.logs[-500:],
        }


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


app = FastAPI(title="Sugar Scratchie Dashboard API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5080", "http://127.0.0.1:5080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def run_job(job: Job) -> None:
    with jobs_lock:
        job.status = "running"
        job.started_at = now()
    env = os.environ.copy()
    env.update(job.env)
    try:
        process = subprocess.Popen(
            job.command,
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        with jobs_lock:
            job.process = process
        assert process.stdout is not None
        for line in process.stdout:
            with jobs_lock:
                job.logs.append(line.rstrip("\n"))
        return_code = process.wait()
        with jobs_lock:
            job.return_code = return_code
            if job.status != "cancelled":
                job.status = "succeeded" if return_code == 0 else "failed"
            job.ended_at = now()
            job.process = None
    except Exception as exc:  # pragma: no cover - last-resort job reporting
        with jobs_lock:
            job.status = "failed"
            job.logs.append(f"Job runner error: {exc}")
            job.ended_at = now()


def enqueue(kind: str, command: list[str], env: dict[str, str]) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, command=command, env=env)
    with jobs_lock:
        jobs[job.id] = job
    thread = threading.Thread(target=run_job, args=(job,), daemon=True)
    thread.start()
    return job


def read_mesh_info(path: Path) -> MeshInfo:
    source = tracker = generator = None
    frames = cols = rows = None
    try:
        import json

        data = json.loads(path.read_text())
        source = data.get("source")
        tracker = data.get("tracker")
        generator = data.get("generator")
        if isinstance(data.get("frames"), list):
            frames = len(data["frames"])
        mesh = data.get("mesh") or {}
        cols = mesh.get("cols")
        rows = mesh.get("rows")
    except Exception:
        pass
    stat = path.stat()
    return MeshInfo(
        file=path.name,
        path=relative(path),
        source=source,
        tracker=tracker,
        generator=generator,
        frames=frames,
        cols=cols,
        rows=rows,
        size_bytes=stat.st_size,
        modified_at=stat.st_mtime,
    )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "root": str(ROOT)}


@app.get("/api/assets")
def assets() -> dict:
    meshes = sorted(MESH_DIR.glob("*.json"))
    mesh_names = {path.name for path in meshes if path.name != "index.json"}
    cards: list[CardInfo] = [
        CardInfo(
            id="original",
            label="Original",
            background="public/cards/ai girl 2.mp4",
            foreground="public/cards/Green bg sample 2 swap.mp4",
            mesh="tracked-mesh.json",
            has_mesh="tracked-mesh.json" in mesh_names,
        )
    ]
    for directory in sorted(path for path in CARDS_DIR.iterdir() if path.is_dir()):
        background = directory / "background.mp4"
        foreground = directory / "foreground.mp4"
        if not background.exists() or not foreground.exists():
            continue
        mesh = f"{directory.name}.json"
        cards.append(
            CardInfo(
                id=directory.name,
                label=directory.name.replace("_", " ").title(),
                background=relative(background),
                foreground=relative(foreground),
                mesh=mesh,
                has_mesh=mesh in mesh_names,
            )
        )
    return {
        "cards": [card.dict() for card in cards],
        "meshes": [read_mesh_info(path).dict() for path in meshes if path.name != "index.json"],
    }


@app.post("/api/jobs/generate-mesh")
def generate_mesh(request: GenerateMeshRequest) -> dict:
    input_video = workspace_path(request.input_video, must_exist=True)
    output_json = workspace_path(request.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)

    env = {
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        "INPUT_VIDEO": relative(input_video),
        "OUTPUT_JSON": relative(output_json),
        "TRACKER": request.tracker,
        "DEBUG_OVERLAY": "1" if request.debug_overlay else "",
        "COMPARE_TRACKERS": "1" if request.compare_trackers else "0",
    }
    optional = {
        "FPS": request.fps,
        "GRID_COLS": request.grid_cols,
        "GRID_ROWS": request.grid_rows,
        "LOOP_CLOSE": request.loop_close,
        "EXTRA_DRIVER_POINTS": request.extra_driver_points,
    }
    env.update({key: str(value) for key, value in optional.items() if value is not None})
    job = enqueue("generate-mesh", [PYTHON_CMD, "scripts/generate-mesh-tracking.py"], env)
    return job.public()


@app.post("/api/jobs/grok-edit")
def grok_edit(request: GrokEditRequest) -> dict:
    if request.video.startswith(("http://", "https://")):
        video_arg = request.video
    else:
        video_arg = relative(workspace_path(request.video, must_exist=True))
    out = relative(workspace_path(request.out))
    command = [
        PYTHON_CMD,
        "scripts/grok-dress-edit.py",
        "--video",
        video_arg,
        "--prompt",
        request.prompt,
        "--out",
        out,
        "--model",
        request.model,
        "--video-field",
        request.video_field,
    ]
    if request.resolution:
        command.extend(["--resolution", request.resolution])
    if request.enhance:
        command.append("--enhance")
    job = enqueue("grok-edit", command, {})
    return job.public()


@app.get("/api/jobs")
def list_jobs() -> dict:
    with jobs_lock:
        ordered = sorted(jobs.values(), key=lambda item: item.created_at, reverse=True)
        return {"jobs": [job.public() for job in ordered]}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job.public()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        process = job.process
        job.status = "cancelled"
    if process and process.poll() is None:
        process.send_signal(signal.SIGTERM)
    return job.public()
