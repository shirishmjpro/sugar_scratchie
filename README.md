# Sugar Scratchie

Prototype for validating the core Sugar Scratchie product risk: scratching a video-attached garment layer while keeping the scratch mask in garment-local coordinates.

## Current Prototype

Milestone 1 demonstrates:

- A real portrait bottom video
- A green-screen foreground video used as the scratch surface
- The bottom video revealed only through scratched foreground holes
- Pointer/touch scratching converted into garment-space marks
- Scratch marks reprojected every frame from garment-local coordinates
- An edit mode with draggable dress-shape handles
- A JSON readout for the normalized dress control points
- Timeline scrubbing and timestamped dress-shape keyframes
- Interpolated dress masks during playback
- Offline generated mesh keyframes sampled from the green-screen foreground clip
- A 3D UV mesh mode that projects the dress mask onto a rounded moving body surface
- A triangular mesh overlay for denser body-surface feedback
- A flat-mask fallback for comparing the projection
- A completion state when enough of the dress layer has been scratched

The app attempts to load both card videos. If the bottom video is not present or cannot play, it uses a synthetic fallback so the mechanic remains testable.

## Run

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

## Dashboard

The operator dashboard is available at `/dashboard` and uses a local FastAPI
backend to run the mesh and Grok edit scripts.

```bash
.venv/bin/pip install -r backend/requirements.txt
npm run dev:api
npm run dev
```

Open `http://localhost:5080/dashboard`. The dashboard can scan cards/meshes,
start mesh-generation jobs, start Grok dress-edit jobs, cancel running jobs, and
show script logs. It also includes an image-to-video-to-dress-edit flow; see
[`docs/image-dress-flow.md`](docs/image-dress-flow.md).

## Generate the Tracked Mesh

The garment is driven by a deforming mesh tracked across the clip with
CoTracker3 (dense point tracking), with SegFormer clothes-parsing to seed the
grid on the dress. Install into a Python 3.11 venv (`.venv`) and run on
Apple-Silicon MPS:

```bash
.venv/bin/pip install -r scripts/requirements-tracking.txt
npm run generate:mesh
```

This samples `public/cards/Green bg sample 2 swap.mp4`, seeds driver points over
the performer in the most frontal frame, tracks those points bidirectionally,
then extends their motion into a full-screen deformation field and writes:

```text
public/mesh/tracked-mesh.json
```

Useful env knobs: `REF_IMAGE` (seed from a hand-picked frame), `FPS`,
`GRID_COLS`/`GRID_ROWS`, `SMOOTH_SIGMA`, `LOOP_CLOSE`, `FIELD_NEIGHBORS`,
`FIELD_POWER`, `EXTRA_DRIVER_POINTS` (extra hand/edge tracking seeds),
`FULL_SCREEN_FIELD=0` (old performer-only mesh), and `DEBUG_OVERLAY=1`. With
debug overlays enabled, `trk*.png` shows the output field and `drv*.png` shows
the raw performer driver points. The generator needs `ffmpeg`/`ffprobe` on PATH.
The app loads the tracked mesh automatically.

## Video Clips

Current clip paths:

```text
public/cards/ai girl 2.mp4
public/cards/Green bg sample 2 swap.mp4
```

The renderer draws the bottom video first, chroma-keys the green background out of the foreground video, then draws the keyed foreground video on top. Scratch marks cut holes in the foreground layer where the tracked mesh covers the garment, revealing the bottom video underneath.

Scratches are stored in mesh-UV coordinates and re-projected through the tracked deforming lattice each frame, so a scratched hole rides the same patch of fabric as the body moves. Use **Show/Hide mesh** to toggle the lattice overlay.

The renderer is still canvas-based. A later Three.js/WebGL mesh can replace it while keeping the same tracked-mesh and scratch-coordinate model.
