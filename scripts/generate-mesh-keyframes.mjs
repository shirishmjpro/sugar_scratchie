import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CANVAS_WIDTH = 390;
const CANVAS_HEIGHT = 672;
const SAMPLE_INTERVAL_SECONDS = 0.25;
const FPS = 1 / SAMPLE_INTERVAL_SECONDS;
const FRAME_BYTES = CANVAS_WIDTH * CANVAS_HEIGHT * 4;
const INPUT_VIDEO = resolve("public/cards/Green bg sample 2 swap.mp4");
const OUTPUT_JSON = resolve("public/cards/generated-mesh-keyframes.json");

const BODY_MESH_ROWS = [
  { id: "neck", label: "Neck", v: 0.025 },
  { id: "shoulder", label: "Shoulder", v: 0.075 },
  { id: "upper-arm", label: "Upper", v: 0.13 },
  { id: "underarm", label: "Under", v: 0.19 },
  { id: "bust", label: "Bust", v: 0.25 },
  { id: "chest", label: "Chest", v: 0.31 },
  { id: "rib", label: "Rib", v: 0.38 },
  { id: "mid-waist", label: "M Waist", v: 0.45 },
  { id: "waist", label: "Waist", v: 0.52 },
  { id: "high-hip", label: "H Hip", v: 0.59 },
  { id: "hip", label: "Hip", v: 0.66 },
  { id: "upper-thigh", label: "U Thigh", v: 0.73 },
  { id: "mid-thigh", label: "M Thigh", v: 0.8 },
  { id: "thigh", label: "Thigh", v: 0.87 },
  { id: "knee", label: "Knee", v: 0.93 },
  { id: "leg", label: "Leg", v: 0.985 },
];

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function localToWorld(frame, u, v) {
  const x = (u - 0.5) * frame.width;
  const y = v * frame.height;

  return {
    x: frame.origin.x + frame.uAxis.x * x + frame.vAxis.x * y,
    y: frame.origin.y + frame.uAxis.y * x + frame.vAxis.y * y,
  };
}

function worldToLocal(frame, point) {
  const relative = {
    x: point.x - frame.origin.x,
    y: point.y - frame.origin.y,
  };

  return {
    u: dot(relative, frame.uAxis) / frame.width + 0.5,
    v: dot(relative, frame.vAxis) / frame.height,
  };
}

function getVideoGarmentFrame() {
  return {
    origin: { x: 210, y: 236 },
    uAxis: normalize({ x: 1, y: 0.02 }),
    vAxis: normalize({ x: -0.05, y: 1 }),
    width: 220,
    height: 410,
  };
}

function isForegroundMaskPixel(image, index) {
  return image.data[index + 3] > 72;
}

function quantile(values, amount) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * amount), 0, sorted.length - 1);
  return sorted[index];
}

function chromaKeyFrame(frameBuffer) {
  const data = new Uint8ClampedArray(frameBuffer);

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const greenDominance = green - Math.max(red, blue);

    if (green > 130 && greenDominance > 38) {
      data[index + 3] = Math.max(0, 255 - greenDominance * 6);
    }
  }

  return { data };
}

function getForegroundSpansAtRow(image, centerY, band) {
  const minY = Math.max(0, Math.floor(centerY - band));
  const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(centerY + band));
  const minColumnHits = Math.max(2, Math.round((maxY - minY + 1) * 0.16));
  const spans = [];
  let current = null;

  for (let x = 6; x < CANVAS_WIDTH - 6; x += 1) {
    let hits = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const index = (y * CANVAS_WIDTH + x) * 4;
      if (isForegroundMaskPixel(image, index)) {
        hits += 1;
      }
    }

    if (hits >= minColumnHits) {
      if (!current) current = { left: x, right: x, pixelsFound: 0, samples: [] };
      current.right = x;
      current.pixelsFound += hits;
      current.samples.push(x);
      continue;
    }

    if (current) {
      spans.push(current);
      current = null;
    }
  }

  if (current) spans.push(current);

  const merged = [];
  for (const span of spans.filter((item) => item.right - item.left >= 5)) {
    const previous = merged[merged.length - 1];
    if (previous && span.left - previous.right <= 4) {
      previous.right = span.right;
      previous.pixelsFound += span.pixelsFound;
      previous.samples.push(...span.samples);
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
}

function findBodyBoundsAtRow(image, centerY, band, expectedCenterX) {
  const spans = getForegroundSpansAtRow(image, centerY, band);
  if (spans.length === 0) return null;

  const selectedSpan = spans
    .map((span) => {
      const center = (span.left + span.right) / 2;
      const width = span.right - span.left;
      const centerDistance = Math.abs(center - expectedCenterX);
      const tooWidePenalty = Math.max(0, width - 210) * 1.9;
      return {
        ...span,
        score: span.pixelsFound + width * 4 - centerDistance * 5 - tooWidePenalty,
      };
    })
    .sort((a, b) => b.score - a.score)[0];

  if (!selectedSpan || selectedSpan.pixelsFound < 18) return null;

  const trimAmount = selectedSpan.right - selectedSpan.left > 96 ? 0.08 : 0.04;
  const left = quantile(selectedSpan.samples, trimAmount);
  const right = quantile(selectedSpan.samples, 1 - trimAmount);
  if (right <= left) return null;

  return {
    left,
    right,
    pixelsFound: selectedSpan.pixelsFound,
    spanCount: spans.length,
  };
}

function trackBodyFrameFromForeground(keyedImage, fallbackFrame, previousFrame) {
  let minX = CANVAS_WIDTH;
  let maxX = 0;
  let minY = CANVAS_HEIGHT;
  let maxY = 0;
  let pixelsFound = 0;

  for (let y = 214; y < CANVAS_HEIGHT - 12; y += 2) {
    for (let x = 4; x < CANVAS_WIDTH - 4; x += 2) {
      const index = (y * CANVAS_WIDTH + x) * 4;
      if (isForegroundMaskPixel(keyedImage, index)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        pixelsFound += 1;
      }
    }
  }

  if (pixelsFound < 420 || maxX <= minX || maxY <= minY) return fallbackFrame;

  const detectedFrame = {
    origin: {
      x: (minX + maxX) / 2,
      y: clamp(minY - 8, 198, 252),
    },
    uAxis: fallbackFrame.uAxis,
    vAxis: fallbackFrame.vAxis,
    width: clamp((maxX - minX) * 0.96, 240, 360),
    height: clamp(maxY - minY + 18, 420, 548),
  };

  if (!previousFrame) return detectedFrame;

  return {
    origin: {
      x: previousFrame.origin.x * 0.68 + detectedFrame.origin.x * 0.32,
      y: previousFrame.origin.y * 0.72 + detectedFrame.origin.y * 0.28,
    },
    uAxis: fallbackFrame.uAxis,
    vAxis: fallbackFrame.vAxis,
    width: previousFrame.width * 0.68 + detectedFrame.width * 0.32,
    height: previousFrame.height * 0.72 + detectedFrame.height * 0.28,
  };
}

function trackBodyPointsFromForeground(frame, keyedImage, previousPoints) {
  const leftPoints = [];
  const rightPoints = [];
  const previousById = previousPoints ? new Map(previousPoints.map((point) => [point.id, point])) : null;
  let expectedCenterX = localToWorld(frame, 0.5, BODY_MESH_ROWS[0].v).x;
  let trackedRows = 0;

  for (const row of BODY_MESH_ROWS) {
    const rowCenter = localToWorld(frame, 0.5, row.v).y;
    const previousLeft = previousById?.get(`left-${row.id}`);
    const previousRight = previousById?.get(`right-${row.id}`);
    if (previousLeft && previousRight) {
      const previousLeftWorld = localToWorld(frame, previousLeft.u, row.v);
      const previousRightWorld = localToWorld(frame, previousRight.u, row.v);
      expectedCenterX = (previousLeftWorld.x + previousRightWorld.x) / 2;
    }

    const bounds = findBodyBoundsAtRow(keyedImage, rowCenter, row.v < 0.2 ? 9 : 12, expectedCenterX);
    if (!bounds) {
      const fallbackLeftU = 0.08 + Math.abs(row.v - 0.45) * 0.18;
      const fallbackRightU = 0.92 - Math.abs(row.v - 0.45) * 0.18;
      leftPoints.push({ id: `left-${row.id}`, label: `L ${row.label}`, u: fallbackLeftU, v: row.v });
      rightPoints.push({ id: `right-${row.id}`, label: `R ${row.label}`, u: fallbackRightU, v: row.v });
      continue;
    }

    const leftLocal = worldToLocal(frame, { x: bounds.left, y: rowCenter });
    const rightLocal = worldToLocal(frame, { x: bounds.right, y: rowCenter });
    const edgePadding = row.v < 0.24 ? 0.006 : 0.012;
    expectedCenterX = (bounds.left + bounds.right) / 2;
    leftPoints.push({
      id: `left-${row.id}`,
      label: `L ${row.label}`,
      u: clamp(leftLocal.u + edgePadding, -0.25, 0.42),
      v: row.v,
    });
    rightPoints.push({
      id: `right-${row.id}`,
      label: `R ${row.label}`,
      u: clamp(rightLocal.u - edgePadding, 0.58, 1.25),
      v: row.v,
    });
    trackedRows += 1;
  }

  const tracked = [...leftPoints, ...rightPoints.reverse()];
  if (trackedRows < 3) return previousPoints ?? tracked;
  if (!previousPoints || previousPoints.length !== tracked.length) return tracked;

  return tracked.map((point) => {
    const previous = previousById.get(point.id);
    if (!previous) return point;
    return {
      ...point,
      u: previous.u * 0.58 + point.u * 0.42,
      v: previous.v * 0.72 + point.v * 0.28,
    };
  });
}

function roundFrame(frame) {
  return {
    origin: {
      x: Number(frame.origin.x.toFixed(3)),
      y: Number(frame.origin.y.toFixed(3)),
    },
    uAxis: {
      x: Number(frame.uAxis.x.toFixed(6)),
      y: Number(frame.uAxis.y.toFixed(6)),
    },
    vAxis: {
      x: Number(frame.vAxis.x.toFixed(6)),
      y: Number(frame.vAxis.y.toFixed(6)),
    },
    width: Number(frame.width.toFixed(3)),
    height: Number(frame.height.toFixed(3)),
  };
}

function roundPoints(points) {
  return points.map((point) => ({
    id: point.id,
    label: point.label,
    u: Number(point.u.toFixed(4)),
    v: Number(point.v.toFixed(4)),
  }));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr?.toString() ?? ""}`);
  }

  return result.stdout;
}

if (!existsSync(INPUT_VIDEO)) {
  throw new Error(`Foreground video not found: ${INPUT_VIDEO}`);
}

const durationOutput = run(
  "ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", INPUT_VIDEO],
  { encoding: "utf8" },
);
const duration = Number.parseFloat(durationOutput.trim());

const rawVideo = run("ffmpeg", [
  "-v",
  "error",
  "-i",
  INPUT_VIDEO,
  "-vf",
  `fps=${FPS},scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT},format=rgba`,
  "-f",
  "rawvideo",
  "pipe:1",
]);

const frameCount = Math.floor(rawVideo.length / FRAME_BYTES);
const keyframes = [];
let previousFrame = null;
let previousPoints = null;
const fallbackFrame = getVideoGarmentFrame();

for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
  const start = frameIndex * FRAME_BYTES;
  const keyedImage = chromaKeyFrame(rawVideo.subarray(start, start + FRAME_BYTES));
  const frame = trackBodyFrameFromForeground(keyedImage, fallbackFrame, previousFrame);
  const points = trackBodyPointsFromForeground(frame, keyedImage, previousPoints);
  const time = Number((frameIndex * SAMPLE_INTERVAL_SECONDS).toFixed(2));

  keyframes.push({
    time,
    frame: roundFrame(frame),
    points: roundPoints(points),
  });

  previousFrame = frame;
  previousPoints = points;
}

mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
writeFileSync(
  OUTPUT_JSON,
  `${JSON.stringify(
    {
      source: "public/cards/Green bg sample 2 swap.mp4",
      generatedAt: new Date().toISOString(),
      sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
      canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      durationSeconds: Number(duration.toFixed(3)),
      keyframes,
    },
    null,
    2,
  )}\n`,
);

console.log(`Generated ${keyframes.length} mesh keyframes at ${OUTPUT_JSON}`);
