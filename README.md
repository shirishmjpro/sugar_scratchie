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

## Generate Mesh Keyframes

The prototype uses a single AI mesh-keyframe generator based on the RTMW whole-body pose model plus the foreground mask.
Use Python 3.11 on this machine and install with the bootstrap script:

```bash
scripts/install-ai-mesh-deps.sh
```

That creates `.venv311` and installs the compatible MMPose stack. The plain `pip install -r scripts/requirements-ai-mesh.txt` path is still unreliable because `mmpose` declares legacy transitive packages like `chumpy` and `xtcocotools` that are not needed for this project but still break installation.

Then generate keyframes from the foreground green-screen clip:

```bash
.venv311/bin/python scripts/generate-ai-mesh-keyframes.py
```

This samples `public/cards/Green bg sample 2 swap.mp4` every 0.25 seconds, runs AI pose detection, blends that with the chroma-keyed foreground mask, and writes:

```text
public/mesh/generated-ai-mesh-keyframes.json
```

When that file is present, the app loads it automatically. If the file is missing or invalid, the prototype falls back to its current live tracker and default hand-authored keyframes.

## Video Clips

Current clip paths:

```text
public/cards/ai girl 2.mp4
public/cards/Green bg sample 2 swap.mp4
```

The renderer draws the bottom video first, chroma-keys the green background out of the foreground video, then draws the keyed foreground video on top. Scratch marks cut holes in the foreground layer inside the editable dress shape, revealing the bottom video underneath.

The prototype starts with generated keyframes sampled across the foreground clip. Use **Edit dress shape** to tune the scratchable area at the current timestamp, then **Save keyframe** to replace or add a shape. The renderer interpolates between saved keyframes during playback. The JSON readouts expose both the current shape and saved keyframes so the annotation data can be moved into a real card definition later.

Use **Use flat mask** / **Use 3D mesh** to compare a flat stable cage projection against the curved UV mesh projection. In mesh mode, the stable body cage is subdivided into a triangular UV lattice, then projected through a curved body-surface approximation. Scratches are stored in garment UV coordinates, so when the keyframed frame moves, the scratched holes move with the surface without following noisy 2D silhouette edges.

The current 3D mode is still canvas-based. A later Three.js/WebGL mesh can replace the renderer while keeping the same keyframe and scratch-coordinate model.
