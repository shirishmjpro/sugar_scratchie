# Grok Dress Edit

Change the dress (or any prompt-described detail) in a clip while keeping the
framing, motion and scene, using xAI's Grok video-edit endpoint. Wraps
[`scripts/grok-dress-edit.py`](../scripts/grok-dress-edit.py).

Output duration, resolution and aspect ratio always match the input.

## Prerequisites

- An xAI (Grok) API key.
- `ffmpeg` and `ffprobe` on your `PATH` (already required by the mesh pipeline).
- Python 3 (standard library only — no extra `pip install`).

## Quick start

```bash
XAI_API_KEY=sk-... python scripts/grok-dress-edit.py \
  --video public/cards/girl_1/foreground.mp4 \
  --prompt "Replace only her dress with a long red satin gown. Keep the person, face, pose, hair, lighting and background exactly the same." \
  --out .tmp/girl_1_red.mp4
```

The key can be `XAI_API_KEY` or `GROK_API_KEY`.

## What it does

1. Probes the input video (`ffprobe`).
2. **Checks Grok's limits and rejects** if the clip exceeds them (duration
   > ~8.7 s, or resolution above 720p). It does **not** convert, downscale, or
   re-encode — the original file is uploaded untouched.
3. Sends the local file inline (base64 data URI), or passes a remote URL through
   directly if `--video` is an `http(s)` URL.
4. Submits to `POST /v1/videos/edits`, polls `GET /v1/videos/{request_id}` until
   `status: done`, then downloads the result to `--out`.

## Options

| Flag | Default | Purpose |
|------|---------|---------|
| `--video` | (required) | Local mp4 path **or** an `https` URL of the source clip. |
| `--prompt` | (required) | Edit instruction (the new dress, etc.). |
| `--out` | `.tmp/grok-edit.mp4` | Where to save the edited video. |
| `--model` | `grok-imagine-video` | Override the video model id. |
| `--video-field` | `video` | Request-body field name for the input video. |

Environment overrides: `XAI_API_BASE`, `XAI_VIDEO_MODEL`, `XAI_VIDEO_FIELD`.

## Grok limits

- **Duration:** ≤ ~8.7 s (edit keeps the original duration).
- **Resolution:** ≤ 720p. The script does not downscale — clips above this are
  rejected.
- **Aspect ratio:** always matches the input (no custom aspect).
- **Inline size:** local files are sent base64-inline up to ~18 MB. For anything
  larger, host the clip and pass an `https` URL to `--video`.

## Writing a good prompt

This is a **prompt-driven** edit, not a masked one — so steer it explicitly:

- Name the change precisely: *"Replace her dress with a knee-length white linen
  sundress with thin straps."*
- Pin everything else: *"Keep the person, face, hair, body, pose, hands,
  lighting, shadows, colors and background exactly the same."*
- Avoid asking for motion/camera changes unless you want them.

## Limitations (read before relying on output)

- **Not pixel-identical.** The endpoint re-synthesizes the whole frame; it has no
  mask or strength control, so face/lighting/background can drift slightly even
  when you tell it not to. If you need non-dress pixels untouched, that requires
  a separate mask-and-composite pipeline (not this script).
- **Temporal artifacts.** Quality of fold/occlusion handling on the new garment
  depends entirely on the model.
- **Schema may need a nudge.** The exact `/v1/videos/edits` input-video field
  name and model id aren't fully published. Defaults here are `video: {url}` and
  `grok-imagine-video`. If the API returns an error, it is printed verbatim; flip
  `--video-field` (e.g. `video_url`) and/or `--model` (e.g.
  `grok-imagine-video-1.5`) to match what your account expects.

## Using the result in this app

The output is H.264 mp4 sized within app constraints, so it can become a card's
`foreground` (or `background`) video. After producing a new foreground clip,
regenerate its tracked mesh — see the "Regenerating the tracked mesh" section in
[`CLAUDE.md`](../CLAUDE.md) — and add the card in
[`src/ScratchPrototype.tsx`](../src/ScratchPrototype.tsx).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Set XAI_API_KEY ...` | Export `XAI_API_KEY` (or `GROK_API_KEY`). |
| `API error 4xx ... model` | Try `--model grok-imagine-video-1.5`. |
| `API error 4xx` mentioning the video field | Try `--video-field video_url`. |
| `Incompatible with Grok ...` | Provide a clip within ≤8.7 s and ≤720p. |
| `Encoded video is N MB (> cap)` | Host the clip; pass an `https` URL to `--video`. |
| Stuck `status=...` then timeout | Re-run; raise `POLL_TIMEOUT_S` in the script if your clips are large. |
