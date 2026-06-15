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
- Eight generated default keyframes sampled from the green-screen foreground clip
- A 3D UV mesh mode that projects the dress mask onto a rounded moving body surface
- A flat-mask fallback for comparing the projection
- A completion state when enough of the dress layer has been scratched

The app attempts to load both card videos. If the bottom video is not present or cannot play, it uses a synthetic fallback so the mechanic remains testable.

## Run

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

## Video Clips

Current clip paths:

```text
public/cards/ai girl 2.mp4
public/cards/Green bg sample 2 swap.mp4
```

The renderer draws the bottom video first, chroma-keys the green background out of the foreground video, then draws the keyed foreground video on top. Scratch marks cut holes in the foreground layer inside the editable dress shape, revealing the bottom video underneath.

The prototype starts with eight generated keyframes sampled across the foreground clip. Use **Edit dress shape** to tune the scratchable area at the current timestamp, then **Save keyframe** to replace or add a shape. The renderer interpolates between saved keyframes during playback. The JSON readouts expose both the current shape and saved keyframes so the annotation data can be moved into a real card definition later.

Use **Use flat mask** / **Use 3D mesh** to compare a flat polygon projection against the curved UV mesh projection. In mesh mode, the dress shape is subdivided into rows and columns, then projected through a curved body-surface approximation. Scratches are stored in garment UV coordinates, so when the keyframed mesh moves, the scratched holes move with the surface.

The current 3D mode is still canvas-based. A later Three.js/WebGL mesh can replace the renderer while keeping the same keyframe and scratch-coordinate model.
