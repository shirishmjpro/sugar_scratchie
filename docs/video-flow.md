# Video Flow (image → card)

Chained pipeline from **one still photo** to a playable scratch card:

1. **Background video** — Grok image-to-video with a loop/boomerang bikini motion prompt (what gets revealed when scratching)
2. **Foreground video** — Grok image-to-video on green screen, then dress-up edit (the scratchable outfit layer)
3. Compress both clips to 540px H.264
4. Create card under `public/cards/<id>/`
5. Generate tracked mesh at `public/mesh/<id>.json`

Available in the dashboard under **Video Flow**.

## CLI

```bash
XAI_API_KEY=sk-... .venv/bin/python scripts/video-flow.py \
  --image .tmp/uploads/source.png \
  --card-id julia_1 \
  --card-label "Julia 1"
```

Custom prompts:

```bash
XAI_API_KEY=sk-... .venv/bin/python scripts/video-flow.py \
  --image .tmp/uploads/source.png \
  --card-id julia_1 \
  --card-label "Julia 1" \
  --background-motion-prompt "Seamless boomerang loop, bikini, beach sway..." \
  --foreground-motion-prompt "Subtle fashion motion, green screen..." \
  --dress-prompt "Replace only her dress with a red satin mini dress..."
```

## Dashboard pipeline steps

| Step | What it does |
|------|----------------|
| Source image | Upload / pick the photo |
| Background video | Loop/boomerang bikini motion prompt |
| Foreground dress-up | Green-screen motion + outfit prompt |
| Compress | 540px H.264 (+ optional WebM) |
| Create card | id + label |
| Generate mesh | tracker choice |

## Requirements

- `XAI_API_KEY` or `GROK_API_KEY`
- `ffmpeg` / `ffprobe` on `PATH`
- Local SegFormer / tracker weights for mesh

## npm

```bash
npm run video-flow -- --help
```
