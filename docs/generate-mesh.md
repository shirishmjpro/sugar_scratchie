# Generating the tracked mesh

The tracked mesh (`public/mesh/*.json`) is what glues scratch holes to the moving
garment. It's produced offline by
[`scripts/generate-mesh-tracking.py`](../scripts/generate-mesh-tracking.py),
which tracks a lattice of points across a foreground clip and writes a
deforming full-canvas UV field.

You can drive the tracking with **two different point trackers** — CoTracker3
and BootsTAPIR — or **blend** them. This doc covers both.

## Setup (once)

```bash
.venv/bin/pip install -r scripts/requirements-tracking.txt
```

Needs `ffmpeg`/`ffprobe` on `PATH`. Runs on Apple-Silicon Torch **MPS**.

- **CoTracker3** weights are fetched at runtime via `torch.hub`.
- **BootsTAPIR** uses the vendored torch port in `scripts/vendor/tapnet_torch`;
  its checkpoint downloads once to `~/.cache/tapnet/bootstapir_checkpoint_v2.pt`.

## The two trackers

| Tracker    | `TRACKER=`            | Strengths                                            | Weaknesses                               |
| ---------- | --------------------- | ---------------------------------------------------- | ---------------------------------------- |
| CoTracker3 | `cotracker` (default) | Low jitter, low drift, stable                        | Drops more hand/arm points on hard clips |
| BootsTAPIR | `bootstapir`          | Higher point survival (hands/arms)                   | More runaway drift on hard clips         |
| Blend      | `blend`               | Per-point: keeps whichever tracker is more confident | ~2× runtime (runs both)                  |

`blend` runs both trackers and, for each point each frame, keeps the more
confident one — then the usual driver pruning + loop-closure clean up the rest.

## Generate with CoTracker (default)

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python scripts/generate-mesh-tracking.py
# or via npm:
npm run generate:mesh
```

Writes `public/mesh/tracked-mesh.json`.

## Generate with BootsTAPIR

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 TRACKER=bootstapir \
  .venv/bin/python scripts/generate-mesh-tracking.py
```

## Generate with the blend (both)

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 TRACKER=blend \
  .venv/bin/python scripts/generate-mesh-tracking.py
```

The chosen tracker is recorded in the output JSON (`tracker` field, and the
`generator` tag, e.g. `bootstapir-full-field-v9`).

## Generate for a specific card / clip

Point the generator at any foreground clip and choose where to write the mesh:

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 \
  INPUT_VIDEO="public/cards/girl_2/foreground.mp4" \
  OUTPUT_JSON="public/mesh/girl_2.json" \
  TRACKER=cotracker \
  .venv/bin/python scripts/generate-mesh-tracking.py
```

After generating, the mesh appears in the in-app **Mesh** dropdown (the Vite
plugin auto-indexes `public/mesh/`). To use it as a card, pair it with the
clip's videos in [`src/ScratchPrototype.tsx`](../src/ScratchPrototype.tsx).

## Compare the two trackers on a clip

Before committing to one tracker, run both on the same seed points and get a
side-by-side overlay + a metrics table (survival / jitter / drift). This writes
overlays and exits **without** writing a mesh:

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 COMPARE_TRACKERS=1 DEBUG_OVERLAY=1 \
  INPUT_VIDEO="public/cards/girl_1/foreground.mp4" \
  .venv/bin/python scripts/generate-mesh-tracking.py
```

Outputs to `.tmp/track_overlay/`:

- `cotracker_drv*.png` vs `bootstapir_drv*.png` — driver points per tracker
  (cyan = visible/confident, red = lost).
- A printed table: `survival all`, `survival hand/arm`, `jitter`, `drift mean`,
  `drift p95`, with the per-metric winner.

Pick the tracker that wins on what matters for your clip (usually hand/arm
survival), then regenerate normally with that `TRACKER=`.

## Key env knobs

| Env                                         | Default                         | Purpose                                                                                       |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `TRACKER`                                   | `cotracker`                     | `cotracker` \| `bootstapir` \| `blend`                                                        |
| `COMPARE_TRACKERS`                          | `0`                             | Run both, write overlays + metrics, no mesh                                                   |
| `INPUT_VIDEO`                               | original clip                   | Foreground clip to track                                                                      |
| `OUTPUT_JSON`                               | `public/mesh/tracked-mesh.json` | Output path                                                                                   |
| `DEBUG_OVERLAY`                             | off                             | Write overlays to `.tmp/track_overlay` (`trk*`=field, `drv*`=drivers)                         |
| `FPS`                                       | `20`                            | Sample/track frame rate                                                                       |
| `GRID_COLS` / `GRID_ROWS`                   | `24` / `36`                     | Mesh lattice density                                                                          |
| `SMOOTH_METHOD`                             | `savgol`                        | `savgol` (velocity-preserving) or `gaussian`                                                  |
| `LOOP_CLOSE`                                | `1`                             | Distribute end→start drift for seamless looping (set `0` for non-looping clips)               |
| `HEAD_DILATE`                               | `1`                             | How far the hair/head mask grows before being removed; small keeps hair-draped arms trackable |
| `CHROMA_GREEN_MIN` / `CHROMA_DOMINANCE_MIN` | `130` / `38`                    | Chroma-key thresholds; lower green-min for dark/uneven green screens                          |
| `EXTRA_DRIVER_POINTS`                       | `320`                           | Extra hand/edge tracking seeds                                                                |
| `PRUNE_SPEED_MAD_K` / `PRUNE_MIN_MEAN_VIS`  | `6.0` / `0.15`                  | Driver outlier pruning                                                                        |
| `FULL_SCREEN_FIELD`                         | `1`                             | `0` = old performer-only mesh                                                                 |

BootsTAPIR-specific (see [`scripts/bootstapir_tracker.py`](../scripts/bootstapir_tracker.py)):
`BOOTSTAPIR_RES` (default 256, raise for tighter localization),
`BOOTSTAPIR_VIS_THRESHOLD`, `BOOTSTAPIR_CHECKPOINT`.

## Notes

- The clip should be **green-screen** for the app's reveal to key the background;
  a non-green foreground tracks the whole scene and stays opaque except inside
  scratch holes.
- High `LOOP_CLOSE` drift in the log (e.g. tens of px) means the clip's start and
  end poses differ a lot — consider `LOOP_CLOSE=0` for non-looping clips.
- `npm run build` is the only correctness gate for the app; the mesh JSON is
  validated at load by `parseTrackedMesh`.
