# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Sugar Scratchie is a single-page prototype validating one product mechanic: scratching a video-attached garment layer while the scratch mask stays in **garment-local (UV) coordinates** so scratched holes follow the moving body instead of noisy 2D silhouette edges. There is no backend — it is a Vite + React 19 + TypeScript app whose entire logic lives in one component plus an offline Python mesh-tracking generator.

## Commands

```bash
npm install
npm run dev        # Vite dev server, fixed at http://127.0.0.1:5080
npm run build      # tsc (type-check, noEmit) then vite build
npm run preview    # serve the production build on 127.0.0.1:5080
```

There is **no test runner and no linter configured**. `npm run build` is the only correctness gate — `tsconfig.json` runs `tsc` in `strict` mode with `noEmit`, so a passing build means types are clean. Always run it after non-trivial edits.

### Regenerating the tracked mesh

```bash
.venv/bin/pip install -r scripts/requirements-tracking.txt
npm run generate:mesh    # = PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python scripts/generate-mesh-tracking.py
```

Runs a point tracker + SegFormer clothes-parsing on Apple-Silicon Torch **MPS** to produce `public/mesh/tracked-mesh.json`. Needs `ffmpeg`/`ffprobe` on PATH. Useful env knobs: `REF_IMAGE` (seed from a hand-picked frame, e.g. `.tmp/canvasframes/c044.png`), `FPS`, `GRID_COLS`/`GRID_ROWS`, `SMOOTH_METHOD` (`savgol`|`gaussian`), `SMOOTH_SIGMA`, `LOOP_CLOSE`, `PER_FRAME_MASK`, `HEAD_DILATE` (how far the hair/head mask grows before being subtracted — keep small so long hair doesn't delete the arm beneath it), `FIELD_NEIGHBORS`, `FIELD_POWER`, `EXTRA_DRIVER_POINTS`/`EXTRA_DRIVER_MIN_DISTANCE` (extra hand/edge tracking seeds), `FULL_SCREEN_FIELD=0` (old performer-only mesh), `DEBUG_OVERLAY=1` (overlays to `.tmp/track_overlay`, where `trk*.png` is the output field and `drv*.png` is the raw driver layer).

**Trackers** (`TRACKER` env): `cotracker` (CoTracker3, fetched via `torch.hub`), `bootstapir` (DeepMind BootsTAPIR — torch port vendored under `scripts/vendor/tapnet_torch`, checkpoint cached once to `~/.cache/tapnet/`, wrapped in `scripts/bootstapir_tracker.py`), or `blend` (run both, keep the more-confident tracker per point per frame). On this clip BootsTAPIR has notably better hand/arm point survival but more runaway drift, so `blend` (the default-quality choice) plus the existing `prune_drivers`/`close_loop` gives the best result. Run `COMPARE_TRACKERS=1 DEBUG_OVERLAY=1 ...` to track the same seeds with both, write side-by-side `cotracker_drv*.png` / `bootstapir_drv*.png` overlays and a survival/jitter/drift table, then exit without writing a mesh.

## Architecture

### Rendering pipeline (`src/ScratchPrototype.tsx`, ~800 lines, the whole app)

Everything renders to one `<canvas>` driven by a `requestAnimationFrame` loop inside a `useEffect` — read `render()` first. Each frame:

1. Draw the **bottom video** (`ai girl 2.mp4`) full-frame, aspect-correct (`drawVideoContain`) — the content revealed underneath.
2. `drawTrackedForegroundLayer`: chroma-key the green-screen **foreground video** (`Green bg sample 2 swap.mp4`) into an offscreen canvas (`drawChromaKeyedVideo`), cut holes for each scratch mark with `globalCompositeOperation = "destination-out"`, then composite over the bottom.

The render-loop `useEffect` dependency array is `[showMesh, trackedMesh]` — new state the loop reads must be added there. If no tracked mesh is loaded, only the videos draw (there is no fallback renderer).

### The coordinate model (the core idea)

The garment is a **deforming triangle lattice** tracked across the clip. The current generator outputs a full-screen deformation field: real CoTracker driver points are seeded on the performer/body, then their displacements are blended into a full-canvas UV grid so the mesh covers the whole `390×672` screen while still moving with the performer. `tracked-mesh.json` holds a static UV grid (`cols`×`rows`) plus, per frame, each vertex's canvas position and a visibility flag. Per video-time:

- `sampleTrackedMesh` interpolates vertex positions between the two bracketing frames → a `TrackedMeshSample`.
- **Scratch marks are stored as mesh-UV `{u, v, radius}`** (`ScratchMark`), never pixels. On pointer-down, `trackedWorldToUv` inverts the deformed lattice (per-cell barycentric) to UV; each render `trackedUvToWorld` (bilinear) re-projects the marks onto the live fabric. This is what glues holes to the garment.
- A cell renders / accepts scratches only when **all four corners are visible** (`cellVisible`). In full-screen-field meshes visibility is intentionally `1` everywhere; in old performer-only meshes off-body and occluded cells are skipped.

Reveal progress is sampled in UV space (`calculateRevealProgress`); crossing `CLAIM_THRESHOLD` (0.35) sets the "claimed" reward state.

### Mesh discovery

Mesh JSON files are discovered via `public/mesh/index.json`, **auto-generated by a custom Vite plugin** (`mesh-json-index` in `vite.config.ts`) on build and served live in dev — do not hand-edit it. The in-app "Mesh" dropdown switches files; "Reload mesh" re-fetches. `parseTrackedMesh` validates the schema (`uv.length === cols*rows`, per-frame `verts` length match) and returns null on mismatch.

### The offline generator (`scripts/generate-mesh-tracking.py`)

Seeds driver points over the performer in the **most frontal frame** (max body area, or `REF_IMAGE`), tracks them **bidirectionally** with CoTracker3 so sides that rotate into view later are captured, applies temporal smoothing + loop closure, and writes `{ uv, frames: [{ t, verts, vis }] }`. By default it also adds extra thin/edge-region drivers (`EXTRA_DRIVER_POINTS`, currently 320) to improve hands/sleeves before extending driver displacements into a full-canvas field (`FULL_SCREEN_FIELD=1`); set `FULL_SCREEN_FIELD=0` to restore the old performer-only output. The trackable driver region is the chroma-key silhouette **minus the head** (SegFormer). `CANVAS_WIDTH`/`CANVAS_HEIGHT` (390×672) are duplicated between the script and the TSX and must match.

## Conventions

- `src/ScratchPrototype.tsx` is intentionally one file: pure geometry/drawing helpers (no React) on top, then the `ScratchPrototype` component. New geometry logic goes in the helper section as a standalone function, not inside the component.
- Per-frame mutable state (marks, hover point, tracked sample) lives in `useRef`, not `useState`, to avoid re-renders in the animation loop; React state is reserved for UI-panel display and throttled via `UI_STATE_UPDATE_INTERVAL_MS`.
- Tunable magic numbers are named `const`s at the top of the file (thresholds, radii). Adjust those rather than inlining literals.
