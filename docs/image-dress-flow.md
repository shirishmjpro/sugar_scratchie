# Image To Dress Video Flow

This flow starts from a still image, generates a short base video, then sends
that generated video through the existing Grok dress-edit script.

```bash
XAI_API_KEY=sk-... python scripts/grok-image-dress-flow.py \
  --image public/images/source.png \
  --motion-prompt "Animate this still portrait into a short natural fashion video with subtle body movement and a steady camera." \
  --dress-prompt "Replace only her dress with a fitted emerald satin dress. Keep the same person, face, hair, pose, motion, lighting and background." \
  --base-video-out .tmp/image-video-base.mp4 \
  --out .tmp/image-dress-video.mp4
```

The same flow is available in the dashboard under **Image To Dress Video**.

## Outputs

- `--base-video-out`: the first generated video from the still image.
- `--out`: the final dress-edited video.

## API Schema Knobs

xAI video API schemas can vary by model/account. The script keeps these values
configurable:

| Option | Default |
|--------|---------|
| `--endpoint` | `/v1/videos/generations` |
| `--image-field` | `image` |
| `--video-field` | `video` |
| `--model` | `grok-imagine-video-1.5` |
| `--resolution` | `720p` |

If the API returns a field-name or endpoint error, adjust these options rather
than changing the script.
