from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "generate-mesh-tracking.py"


def default_mesh_device() -> str:
    """Match CLI mesh defaults: explicit DEVICE env, else Apple MPS, else CPU."""
    explicit = os.environ.get("DEVICE")
    if explicit:
        return explicit
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def generate_mesh(env: dict[str, str]) -> None:
    """Run the existing mesh tracker in-process under backend job control."""

    previous_env = os.environ.copy()
    previous_path = list(sys.path)
    os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location("backend_mesh_tracking_impl", SCRIPT)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load mesh tracking implementation: {SCRIPT}")
        module = importlib.util.module_from_spec(spec)
        sys.modules["backend_mesh_tracking_impl"] = module
        spec.loader.exec_module(module)
        run_main(module)
    finally:
        os.environ.clear()
        os.environ.update(previous_env)
        sys.path[:] = previous_path
        sys.modules.pop("backend_mesh_tracking_impl", None)


def run_main(module: ModuleType) -> None:
    try:
        module.main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise RuntimeError(str(exc)) from exc
