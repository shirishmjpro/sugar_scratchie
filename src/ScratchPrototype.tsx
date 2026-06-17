import { useEffect, useRef, useState } from "react";

type Vec2 = {
  x: number;
  y: number;
};

type Vec3 = {
  x: number;
  y: number;
  z: number;
};

type SurfaceProjection = {
  point: Vec2;
  z: number;
  frontWeight: number;
};

type GarmentFrame = {
  origin: Vec2;
  uAxis: Vec2;
  vAxis: Vec2;
  width: number;
  height: number;
};

type ScratchMark = {
  u: number;
  v: number;
  radius: number;
};

type DressPoint = {
  id: string;
  label: string;
  u: number;
  v: number;
};

type DressKeyframe = {
  time: number;
  frame?: GarmentFrame;
  points: DressPoint[];
};

type MeshKeyframeData = {
  generator?: string;
  poseModel?: string;
  keyframes: DressKeyframe[];
};

const CANVAS_WIDTH = 390;
const CANVAS_HEIGHT = 672;
const BOTTOM_VIDEO_SRC = "/cards/ai%20girl%202.mp4";
const FOREGROUND_VIDEO_SRC = "/cards/Green%20bg%20sample%202%20swap.mp4";
const MESH_INDEX_SRC = "/mesh/index.json";
const MESH_DIRECTORY_SRC = "/mesh";
const DEFAULT_MESH_FILE = "tracked-mesh.json";
const CLAIM_THRESHOLD = 0.35;
const FRONT_SURFACE_MIN_WEIGHT = 0.12;
const FRONT_SURFACE_U_IS_MIRRORED = true;
// Front face spans a touch under a half-cylinder so the left/right edges land
// on the silhouette rather than curling around the back.
const BODY_WRAP_RADIANS = Math.PI * 0.92;
// How strongly the horizontal mapping bows away from the flat silhouette
// mapping. 0 = flat, 1 = full sine wrap. Kept low so the cage hugs the body.
const BODY_WRAP_FORESHORTEN = 0.22;
const BODY_WRAP_DEPTH = 96;
const UI_STATE_UPDATE_INTERVAL_MS = 250;
const HOVER_REVEAL_RADIUS = 46;
const CURVED_MESH_COLUMNS = 26;
const CURVED_MESH_ROWS = 34;
const CURVED_MESH_LINE_SAMPLES = 64;
const CURVED_MESH_DIAGONAL_SAMPLES = 10;

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

const STABLE_BODY_CAGE_PROFILE = [
  { v: 0, left: 0.39, right: 0.61 },
  { v: 0.05, left: 0.31, right: 0.69 },
  { v: 0.12, left: 0.2, right: 0.8 },
  { v: 0.22, left: 0.18, right: 0.82 },
  { v: 0.34, left: 0.23, right: 0.77 },
  { v: 0.48, left: 0.29, right: 0.71 },
  { v: 0.62, left: 0.22, right: 0.78 },
  { v: 0.78, left: 0.27, right: 0.73 },
  { v: 0.92, left: 0.32, right: 0.68 },
  { v: 1, left: 0.36, right: 0.64 },
];

const BODY_PROFILE_MAX_WIDTH = STABLE_BODY_CAGE_PROFILE.reduce(
  (max, profile) => Math.max(max, profile.right - profile.left),
  0,
);

const DEFAULT_DRESS_POINTS: DressPoint[] = [
  { id: "left-strap", label: "L strap", u: -0.35, v: 0.003 },
  { id: "left-chest", label: "L chest", u: -0.04, v: 0.162 },
  { id: "left-waist", label: "L waist", u: 0.084, v: 0.564 },
  { id: "left-hem", label: "L hem", u: 0.029, v: 1.034 },
  { id: "right-hem", label: "R hem", u: 0.929, v: 1.01 },
  { id: "right-waist", label: "R waist", u: 0.966, v: 0.541 },
  { id: "right-chest", label: "R chest", u: 1.069, v: 0.132 },
  { id: "right-strap", label: "R strap", u: 0.867, v: -0.029 },
];

const reusableCanvases = new Map<string, HTMLCanvasElement>();

function getReusableCanvas(id: string) {
  let canvas = reusableCanvases.get(id);
  if (!canvas) {
    canvas = document.createElement("canvas");
    reusableCanvases.set(id, canvas);
  }

  if (canvas.width !== CANVAS_WIDTH) canvas.width = CANVAS_WIDTH;
  if (canvas.height !== CANVAS_HEIGHT) canvas.height = CANVAS_HEIGHT;

  return canvas;
}

function getContainRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight };
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function drawVideoContain(context: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const rect = getContainRect(video.videoWidth, video.videoHeight, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.drawImage(video, rect.x, rect.y, rect.width, rect.height);
}

const DEFAULT_KEYFRAMES: DressKeyframe[] = [
  {
    time: 0,
    points: DEFAULT_DRESS_POINTS,
  },
  {
    time: 2.5,
    points: [
      { id: "left-strap", label: "L strap", u: 0.018, v: -0.007 },
      { id: "left-chest", label: "L chest", u: -0.344, v: 0.17 },
      { id: "left-waist", label: "L waist", u: 0.034, v: 0.566 },
      { id: "left-hem", label: "L hem", u: -0.216, v: 1.041 },
      { id: "right-hem", label: "R hem", u: 0.761, v: 1.015 },
      { id: "right-waist", label: "R waist", u: 1.093, v: 0.537 },
      { id: "right-chest", label: "R chest", u: 0.969, v: 0.135 },
      { id: "right-strap", label: "R strap", u: 0.822, v: -0.028 },
    ],
  },
  {
    time: 5,
    points: [
      { id: "left-strap", label: "L strap", u: 0.122, v: -0.009 },
      { id: "left-chest", label: "L chest", u: -0.34, v: 0.17 },
      { id: "left-waist", label: "L waist", u: 0.098, v: 0.564 },
      { id: "left-hem", label: "L hem", u: 0.052, v: 1.034 },
      { id: "right-hem", label: "R hem", u: 1.161, v: 1.004 },
      { id: "right-waist", label: "R waist", u: 1.025, v: 0.539 },
      { id: "right-chest", label: "R chest", u: 0.987, v: 0.134 },
      { id: "right-strap", label: "R strap", u: 0.949, v: -0.032 },
    ],
  },
  {
    time: 7.5,
    points: [
      { id: "left-strap", label: "L strap", u: 0.036, v: -0.007 },
      { id: "left-chest", label: "L chest", u: -0.34, v: 0.17 },
      { id: "left-waist", label: "L waist", u: 0.007, v: 0.566 },
      { id: "left-hem", label: "L hem", u: -0.107, v: 1.038 },
      { id: "right-hem", label: "R hem", u: 0.879, v: 1.012 },
      { id: "right-waist", label: "R waist", u: 1.075, v: 0.538 },
      { id: "right-chest", label: "R chest", u: 0.987, v: 0.134 },
      { id: "right-strap", label: "R strap", u: 0.876, v: -0.03 },
    ],
  },
  {
    time: 10,
    points: [
      { id: "left-strap", label: "L strap", u: -0.35, v: 0.003 },
      { id: "left-chest", label: "L chest", u: -0.035, v: 0.161 },
      { id: "left-waist", label: "L waist", u: 0.08, v: 0.564 },
      { id: "left-hem", label: "L hem", u: 0.065, v: 1.033 },
      { id: "right-hem", label: "R hem", u: 0.988, v: 1.009 },
      { id: "right-waist", label: "R waist", u: 0.948, v: 0.541 },
      { id: "right-chest", label: "R chest", u: 1.037, v: 0.133 },
      { id: "right-strap", label: "R strap", u: 0.863, v: -0.029 },
    ],
  },
  {
    time: 12.5,
    points: [
      { id: "left-strap", label: "L strap", u: 0.018, v: -0.007 },
      { id: "left-chest", label: "L chest", u: -0.335, v: 0.169 },
      { id: "left-waist", label: "L waist", u: -0.011, v: 0.567 },
      { id: "left-hem", label: "L hem", u: -0.175, v: 1.04 },
      { id: "right-hem", label: "R hem", u: 0.815, v: 1.013 },
      { id: "right-waist", label: "R waist", u: 1.189, v: 0.535 },
      { id: "right-chest", label: "R chest", u: 1.033, v: 0.133 },
      { id: "right-strap", label: "R strap", u: 0.854, v: -0.029 },
    ],
  },
  {
    time: 15,
    points: [
      { id: "left-strap", label: "L strap", u: 0.09, v: -0.009 },
      { id: "left-chest", label: "L chest", u: -0.331, v: 0.169 },
      { id: "left-waist", label: "L waist", u: 0.153, v: 0.562 },
      { id: "left-hem", label: "L hem", u: 0.025, v: 1.034 },
      { id: "right-hem", label: "R hem", u: 0.974, v: 1.009 },
      { id: "right-waist", label: "R waist", u: 1.161, v: 0.535 },
      { id: "right-chest", label: "R chest", u: 1.074, v: 0.132 },
      { id: "right-strap", label: "R strap", u: 0.958, v: -0.032 },
    ],
  },
  {
    time: 17.5,
    points: [
      { id: "left-strap", label: "L strap", u: -0.35, v: 0.003 },
      { id: "left-chest", label: "L chest", u: -0.053, v: 0.162 },
      { id: "left-waist", label: "L waist", u: -0.043, v: 0.568 },
      { id: "left-hem", label: "L hem", u: 0.047, v: 1.034 },
      { id: "right-hem", label: "R hem", u: 1.011, v: 1.008 },
      { id: "right-waist", label: "R waist", u: 1.23, v: 0.534 },
      { id: "right-chest", label: "R chest", u: 1.042, v: 0.133 },
      { id: "right-strap", label: "R strap", u: 0.858, v: -0.029 },
    ],
  },
];

function pointInPolygon(point: Vec2, polygon: Vec2[]) {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;

    if (intersects) inside = !inside;
  }

  return inside;
}

function normalize(vector: Vec2) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: Vec2, b: Vec2) {
  return a.x * b.x + a.y * b.y;
}

function getSyntheticFrame(time: number): GarmentFrame {
  const sway = Math.sin(time * 1.8);
  const angle = -0.28 + sway * 0.22;
  const origin = {
    x: CANVAS_WIDTH * 0.54 + sway * 18,
    y: 214 + Math.sin(time * 1.2) * 8,
  };

  return {
    origin,
    uAxis: normalize({ x: Math.cos(angle), y: Math.sin(angle) }),
    vAxis: normalize({ x: -Math.sin(angle), y: Math.cos(angle) }),
    width: 92,
    height: 248,
  };
}

function getVideoGarmentFrame(): GarmentFrame {
  return {
    origin: { x: 210, y: 236 },
    uAxis: normalize({ x: 1, y: 0.02 }),
    vAxis: normalize({ x: -0.05, y: 1 }),
    width: 220,
    height: 410,
  };
}

function localToWorld(frame: GarmentFrame, u: number, v: number): Vec2 {
  const x = (u - 0.5) * frame.width;
  const y = v * frame.height;

  return {
    x: frame.origin.x + frame.uAxis.x * x + frame.vAxis.x * y,
    y: frame.origin.y + frame.uAxis.y * x + frame.vAxis.y * y,
  };
}

function projectSurfacePoint(frame: GarmentFrame, u: number, v: number, isCurved: boolean): SurfaceProjection {
  if (!isCurved) {
    return {
      point: localToWorld(frame, u, v),
      z: 0,
      frontWeight: 1,
    };
  }

  const clampedU = Math.max(0, Math.min(1, u));
  const overflowU = u - clampedU;
  const theta = (clampedU - 0.5) * BODY_WRAP_RADIANS;
  // Cross-section depth follows the silhouette: deep where the body is wide
  // (bust, hip), shallow where it pinches (waist), tapering at neck and legs.
  const widthRatio = Math.max(0.2, getBodyProfileWidth(v) / BODY_PROFILE_MAX_WIDTH);
  const endTaper = Math.max(0.32, 1 - Math.abs(v - 0.5) * 0.35);
  const depthFalloff = widthRatio * endTaper;
  // Horizontal: blend the flat silhouette offset with a sine bow. Both reach the
  // same half-width at the edges, so the cage stays on the body and only the
  // interior bows, instead of ballooning past the silhouette.
  const flatOffset = (clampedU - 0.5) * frame.width;
  const bowOffset = Math.sin(theta) * frame.width * 0.5;
  const surface: Vec3 = {
    x: flatOffset * (1 - BODY_WRAP_FORESHORTEN) + bowOffset * BODY_WRAP_FORESHORTEN + overflowU * frame.width * 0.34,
    y: (v - 0.5) * frame.height,
    z: Math.cos(theta) * BODY_WRAP_DEPTH * depthFalloff,
  };
  // Mild perspective on the wrap axis only gives roundness without stretching
  // the cage vertically or lifting it off the body.
  const cameraDistance = 820;
  const perspective = cameraDistance / (cameraDistance - surface.z);
  const center = localToWorld(frame, 0.5, 0.5);
  const frontWeight = Math.max(0, Math.cos(theta)) * depthFalloff;

  return {
    point: {
      x: center.x + frame.uAxis.x * surface.x * perspective + frame.vAxis.x * surface.y,
      y: center.y + frame.uAxis.y * surface.x * perspective + frame.vAxis.y * surface.y - surface.z * 0.05,
    },
    z: surface.z,
    frontWeight,
  };
}

function projectLocalToWorld(frame: GarmentFrame, u: number, v: number, isCurved: boolean): Vec2 {
  return projectSurfacePoint(frame, u, v, isCurved).point;
}

function worldToLocal(frame: GarmentFrame, point: Vec2) {
  const relative = {
    x: point.x - frame.origin.x,
    y: point.y - frame.origin.y,
  };

  return {
    u: dot(relative, frame.uAxis) / frame.width + 0.5,
    v: dot(relative, frame.vAxis) / frame.height,
  };
}

function getGarmentQuad(frame: GarmentFrame) {
  return [
    localToWorld(frame, 0, 0),
    localToWorld(frame, 1, 0),
    localToWorld(frame, 1, 1),
    localToWorld(frame, 0, 1),
  ];
}

function drawQuadPath(context: CanvasRenderingContext2D, quad: Vec2[]) {
  context.beginPath();
  context.moveTo(quad[0].x, quad[0].y);
  for (let index = 1; index < quad.length; index += 1) {
    context.lineTo(quad[index].x, quad[index].y);
  }
  context.closePath();
}

function drawSyntheticVideoFrame(context: CanvasRenderingContext2D, frame: GarmentFrame, time: number) {
  const gradient = context.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
  gradient.addColorStop(0, "#f5e8da");
  gradient.addColorStop(1, "#d8eadf");
  context.fillStyle = gradient;
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  context.fillStyle = "#2b2220";
  context.beginPath();
  context.ellipse(CANVAS_WIDTH * 0.5, 152, 44, 54, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#c98965";
  context.beginPath();
  context.ellipse(CANVAS_WIDTH * 0.5, 132, 31, 38, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#365f6b";
  context.beginPath();
  context.roundRect(124, 204, 142, 240, 34);
  context.fill();

  context.fillStyle = "#294d58";
  context.beginPath();
  context.roundRect(144, 236, 100, 202, 28);
  context.fill();

  const leftArmX = 92 + Math.sin(time * 1.5) * 6;
  context.strokeStyle = "#9f6b51";
  context.lineWidth = 34;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(136, 236);
  context.lineTo(leftArmX, 392);
  context.stroke();

  const garmentQuad = getGarmentQuad(frame);
  drawQuadPath(context, garmentQuad);
  context.fillStyle = "#c95f4d";
  context.fill();

  context.strokeStyle = "rgba(255,255,255,0.22)";
  context.lineWidth = 2;
  drawQuadPath(context, garmentQuad);
  context.stroke();
}

function syncVideoTime(source: HTMLVideoElement, target: HTMLVideoElement) {
  if (source.paused && !target.paused) {
    target.pause();
  }

  if (!source.paused && target.paused) {
    void target.play().catch(() => undefined);
  }

  if (Number.isFinite(source.currentTime) && Number.isFinite(target.duration) && target.duration > 0) {
    const targetTime = source.currentTime % target.duration;
    if (Math.abs(targetTime - target.currentTime) > 0.12) {
      target.currentTime = targetTime;
    }
  }
}

function drawChromaKeyedVideo(
  foregroundContext: CanvasRenderingContext2D,
  video: HTMLVideoElement,
) {
  foregroundContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  drawVideoContain(foregroundContext, video);

  const image = foregroundContext.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const pixels = image.data;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const greenDominance = green - Math.max(red, blue);

    if (green > 130 && greenDominance > 38) {
      const alpha = Math.max(0, 255 - greenDominance * 6);
      pixels[index + 3] = alpha;
    }
  }

  foregroundContext.putImageData(image, 0, 0);
  return image;
}

function getDressWorldPoints(frame: GarmentFrame, points: DressPoint[], isCurved = false) {
  return points.map((point) => projectLocalToWorld(frame, point.u, point.v, isCurved));
}

function getTrackedBodyCenterU(points: DressPoint[], v: number) {
  const leftPoints = points.filter((point) => point.id.startsWith("left-"));
  const rightPoints = points.filter((point) => point.id.startsWith("right-"));
  const centers = leftPoints
    .map((leftPoint) => {
      const rowId = leftPoint.id.replace(/^left-/, "");
      const rightPoint = rightPoints.find((point) => point.id === `right-${rowId}`);
      if (!rightPoint) return null;

      return {
        v: (leftPoint.v + rightPoint.v) / 2,
        u: (leftPoint.u + rightPoint.u) / 2,
      };
    })
    .filter((center): center is { u: number; v: number } => Boolean(center))
    .sort((a, b) => a.v - b.v);

  if (centers.length === 0) return 0.5;

  const clampedV = Math.max(0, Math.min(1, v));
  if (clampedV <= centers[0].v) return Math.max(0.32, Math.min(0.68, centers[0].u));
  if (clampedV >= centers[centers.length - 1].v) {
    return Math.max(0.32, Math.min(0.68, centers[centers.length - 1].u));
  }

  for (let index = 0; index < centers.length - 1; index += 1) {
    const current = centers[index];
    const next = centers[index + 1];
    if (clampedV >= current.v && clampedV <= next.v) {
      const span = next.v - current.v || 1;
      const blend = (clampedV - current.v) / span;
      const centerU = current.u + (next.u - current.u) * blend;
      return Math.max(0.32, Math.min(0.68, centerU));
    }
  }

  return 0.5;
}

function getBodyProfileWidth(v: number) {
  const sorted = STABLE_BODY_CAGE_PROFILE;
  const clampedV = Math.max(0, Math.min(1, v));
  const widthAt = (profile: (typeof sorted)[number]) => profile.right - profile.left;

  if (clampedV <= sorted[0].v) return widthAt(sorted[0]);
  if (clampedV >= sorted[sorted.length - 1].v) return widthAt(sorted[sorted.length - 1]);

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (clampedV >= current.v && clampedV <= next.v) {
      const span = next.v - current.v || 1;
      const blend = (clampedV - current.v) / span;
      return widthAt(current) + (widthAt(next) - widthAt(current)) * blend;
    }
  }

  return widthAt(sorted[0]);
}

function getTrackedBodyRows(points: DressPoint[]) {
  const rows = BODY_MESH_ROWS.map((row) => {
    const left = points.find((point) => point.id === `left-${row.id}`);
    const right = points.find((point) => point.id === `right-${row.id}`);
    return left && right ? { v: row.v, left: left.u, right: right.u } : null;
  }).filter((row): row is { v: number; left: number; right: number } => Boolean(row));

  return rows.length >= 4 ? rows : [];
}

function getTrackedBodySideU(side: "left" | "right", v: number, points: DressPoint[]) {
  const rows = getTrackedBodyRows(points);
  if (rows.length === 0) return null;

  const clampedV = Math.max(0, Math.min(1, v));
  const clampU = (value: number) => Math.max(-0.25, Math.min(1.25, value));

  if (clampedV <= rows[0].v) return clampU(rows[0][side]);
  if (clampedV >= rows[rows.length - 1].v) return clampU(rows[rows.length - 1][side]);

  for (let index = 0; index < rows.length - 1; index += 1) {
    const current = rows[index];
    const next = rows[index + 1];
    if (clampedV >= current.v && clampedV <= next.v) {
      const span = next.v - current.v || 1;
      const blend = (clampedV - current.v) / span;
      return clampU(current[side] + (next[side] - current[side]) * blend);
    }
  }

  return clampU(rows[0][side]);
}

function getStableBodyCageU(side: "left" | "right", v: number, points: DressPoint[] = []) {
  const trackedU = getTrackedBodySideU(side, v, points);
  if (trackedU !== null) return trackedU;

  const sorted = STABLE_BODY_CAGE_PROFILE;
  const clampedV = Math.max(0, Math.min(1, v));
  const centerU = getTrackedBodyCenterU(points, clampedV);
  const getProfileU = (value: number) => Math.max(-0.08, Math.min(1.08, centerU + value - 0.5));

  if (clampedV <= sorted[0].v) return getProfileU(sorted[0][side]);
  if (clampedV >= sorted[sorted.length - 1].v) return getProfileU(sorted[sorted.length - 1][side]);

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (clampedV >= current.v && clampedV <= next.v) {
      const span = next.v - current.v || 1;
      const blend = (clampedV - current.v) / span;
      return getProfileU(current[side] + (next[side] - current[side]) * blend);
    }
  }

  return getProfileU(sorted[0][side]);
}

function getStableBodyCageWorldPoints(frame: GarmentFrame, points: DressPoint[] = [], isCurved = false) {
  const rows = getTrackedBodyRows(points);
  const profileRows = rows.length > 0 ? rows : STABLE_BODY_CAGE_PROFILE;
  const leftPoints = profileRows.map((profile) =>
    projectLocalToWorld(frame, getStableBodyCageU("left", profile.v, points), profile.v, isCurved),
  );
  const rightPoints = [...profileRows]
    .reverse()
    .map((profile) => projectLocalToWorld(frame, getStableBodyCageU("right", profile.v, points), profile.v, isCurved));

  return [...leftPoints, ...rightPoints];
}

function cloneDressPoints(points: DressPoint[]) {
  return points.map((point) => ({ ...point }));
}

function cloneGarmentFrame(frame: GarmentFrame): GarmentFrame {
  return {
    origin: { ...frame.origin },
    uAxis: { ...frame.uAxis },
    vAxis: { ...frame.vAxis },
    width: frame.width,
    height: frame.height,
  };
}

function interpolateDressPoints(keyframes: DressKeyframe[], time: number) {
  if (keyframes.length === 0) return cloneDressPoints(DEFAULT_DRESS_POINTS);

  const sortedKeyframes = [...keyframes].sort((a, b) => a.time - b.time);
  const previous = [...sortedKeyframes].reverse().find((keyframe) => keyframe.time <= time) ?? sortedKeyframes[0];
  const next = sortedKeyframes.find((keyframe) => keyframe.time >= time) ?? sortedKeyframes[sortedKeyframes.length - 1];

  if (previous.time === next.time) return cloneDressPoints(previous.points);

  const blend = (time - previous.time) / (next.time - previous.time);
  return previous.points.map((point, index) => {
    const nextPoint = next.points[index] ?? point;
    return {
      ...point,
      u: point.u + (nextPoint.u - point.u) * blend,
      v: point.v + (nextPoint.v - point.v) * blend,
    };
  });
}

function interpolateGarmentFrame(keyframes: DressKeyframe[], time: number) {
  const keyframesWithFrames = keyframes.filter((keyframe) => keyframe.frame);
  if (keyframesWithFrames.length === 0) return null;

  const sortedKeyframes = [...keyframesWithFrames].sort((a, b) => a.time - b.time);
  const previous = [...sortedKeyframes].reverse().find((keyframe) => keyframe.time <= time) ?? sortedKeyframes[0];
  const next = sortedKeyframes.find((keyframe) => keyframe.time >= time) ?? sortedKeyframes[sortedKeyframes.length - 1];
  const previousFrame = previous.frame;
  const nextFrame = next.frame;

  if (!previousFrame || !nextFrame) return null;
  if (previous.time === next.time) return cloneGarmentFrame(previousFrame);

  const blend = (time - previous.time) / (next.time - previous.time);
  return {
    origin: {
      x: previousFrame.origin.x + (nextFrame.origin.x - previousFrame.origin.x) * blend,
      y: previousFrame.origin.y + (nextFrame.origin.y - previousFrame.origin.y) * blend,
    },
    uAxis: normalize({
      x: previousFrame.uAxis.x + (nextFrame.uAxis.x - previousFrame.uAxis.x) * blend,
      y: previousFrame.uAxis.y + (nextFrame.uAxis.y - previousFrame.uAxis.y) * blend,
    }),
    vAxis: normalize({
      x: previousFrame.vAxis.x + (nextFrame.vAxis.x - previousFrame.vAxis.x) * blend,
      y: previousFrame.vAxis.y + (nextFrame.vAxis.y - previousFrame.vAxis.y) * blend,
    }),
    width: previousFrame.width + (nextFrame.width - previousFrame.width) * blend,
    height: previousFrame.height + (nextFrame.height - previousFrame.height) * blend,
  };
}

function isValidDressPoint(value: unknown): value is DressPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as DressPoint;
  return (
    typeof point.id === "string" &&
    typeof point.u === "number" &&
    Number.isFinite(point.u) &&
    typeof point.v === "number" &&
    Number.isFinite(point.v)
  );
}

function isValidGarmentFrame(value: unknown): value is GarmentFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as GarmentFrame;
  return (
    typeof frame.origin?.x === "number" &&
    typeof frame.origin?.y === "number" &&
    typeof frame.uAxis?.x === "number" &&
    typeof frame.uAxis?.y === "number" &&
    typeof frame.vAxis?.x === "number" &&
    typeof frame.vAxis?.y === "number" &&
    typeof frame.width === "number" &&
    Number.isFinite(frame.width) &&
    typeof frame.height === "number" &&
    Number.isFinite(frame.height)
  );
}

function parseGeneratedKeyframes(value: unknown): MeshKeyframeData {
  const keyframeValues = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { keyframes?: unknown }).keyframes)
      ? (value as { keyframes: unknown[] }).keyframes
      : [];

  const keyframes = keyframeValues
    .filter((keyframe): keyframe is { time: number; frame?: unknown; points: unknown[] } => {
      return (
        keyframe !== null &&
        typeof keyframe === "object" &&
        typeof (keyframe as { time?: unknown }).time === "number" &&
        Array.isArray((keyframe as { points?: unknown }).points)
      );
    })
    .map((keyframe) => ({
      time: keyframe.time,
      frame: isValidGarmentFrame(keyframe.frame) ? cloneGarmentFrame(keyframe.frame) : undefined,
      points: keyframe.points.filter(isValidDressPoint).map((point) => ({
        id: point.id,
        label: typeof point.label === "string" ? point.label : point.id,
        u: point.u,
        v: point.v,
      })),
    }))
    .filter((keyframe) => keyframe.points.length >= 6)
    .sort((a, b) => a.time - b.time);

  return {
    generator:
      value && typeof value === "object" && typeof (value as { generator?: unknown }).generator === "string"
        ? (value as { generator: string }).generator
        : undefined,
    poseModel:
      value && typeof value === "object" && typeof (value as { poseModel?: unknown }).poseModel === "string"
        ? (value as { poseModel: string }).poseModel
        : undefined,
    keyframes,
  };
}

function parseMeshIndex(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files)) {
    return [];
  }

  return (value as { files: unknown[] }).files
    .filter((file): file is string => {
      return typeof file === "string" && file.toLowerCase().endsWith(".json") && !file.includes("/");
    })
    .sort((a, b) => a.localeCompare(b));
}

function isTrackableGarmentPixel(image: ImageData, index: number) {
  const red = image.data[index];
  const green = image.data[index + 1];
  const blue = image.data[index + 2];
  const alpha = image.data[index + 3];
  const isLikelySkin = red > 145 && green > 86 && green < 178 && blue < 145 && red - blue > 26;
  const isBrightGarment = red > 118 && green > 118 && blue > 118;
  const isCoolGarment = blue > 118 && green > 86 && blue >= red - 8;

  return alpha > 72 && !isLikelySkin && (isBrightGarment || isCoolGarment);
}

function isForegroundMaskPixel(image: ImageData, index: number) {
  return image.data[index + 3] > 72;
}

function quantile(values: number[], amount: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * amount), 0, sorted.length - 1);
  return sorted[index];
}

type ForegroundSpan = {
  left: number;
  right: number;
  pixelsFound: number;
  samples: number[];
};

function getForegroundSpansAtRow(image: ImageData, centerY: number, band: number) {
  const minY = Math.max(0, Math.floor(centerY - band));
  const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(centerY + band));
  const minColumnHits = Math.max(2, Math.round((maxY - minY + 1) * 0.16));
  const spans: ForegroundSpan[] = [];
  let current: ForegroundSpan | null = null;

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

  const merged: ForegroundSpan[] = [];
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

function findBodyBoundsAtRow(image: ImageData, centerY: number, band: number, expectedCenterX: number) {
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

function trackBodyPointsFromForeground(
  frame: GarmentFrame,
  keyedImage: ImageData,
  previousPoints: DressPoint[] | null,
) {
  const leftPoints: DressPoint[] = [];
  const rightPoints: DressPoint[] = [];
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
      u: Math.max(-0.25, Math.min(0.42, leftLocal.u + edgePadding)),
      v: row.v,
    });
    rightPoints.push({
      id: `right-${row.id}`,
      label: `R ${row.label}`,
      u: Math.max(0.58, Math.min(1.25, rightLocal.u - edgePadding)),
      v: row.v,
    });
    trackedRows += 1;
  }

  const tracked = [...leftPoints, ...rightPoints.reverse()];
  if (trackedRows < 3) return previousPoints ?? tracked;
  if (!previousPoints || previousPoints.length !== tracked.length) return tracked;

  return tracked.map((point) => {
    const previous = previousById?.get(point.id);
    if (!previous) return point;
    return {
      ...point,
      u: previous.u * 0.42 + point.u * 0.58,
      v: previous.v * 0.55 + point.v * 0.45,
    };
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function trackBodyFrameFromForeground(
  keyedImage: ImageData,
  fallbackFrame: GarmentFrame,
  previousFrame: GarmentFrame | null,
) {
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

  const detectedFrame: GarmentFrame = {
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
      x: previousFrame.origin.x * 0.5 + detectedFrame.origin.x * 0.5,
      y: previousFrame.origin.y * 0.55 + detectedFrame.origin.y * 0.45,
    },
    uAxis: fallbackFrame.uAxis,
    vAxis: fallbackFrame.vAxis,
    width: previousFrame.width * 0.5 + detectedFrame.width * 0.5,
    height: previousFrame.height * 0.55 + detectedFrame.height * 0.45,
  };
}

function drawDressPath(context: CanvasRenderingContext2D, frame: GarmentFrame, points: DressPoint[], isCurved = false) {
  const worldPoints = getDressWorldPoints(frame, points, isCurved);

  context.beginPath();
  context.moveTo(worldPoints[0].x, worldPoints[0].y);
  for (let index = 1; index < worldPoints.length; index += 1) {
    context.lineTo(worldPoints[index].x, worldPoints[index].y);
  }
  context.closePath();
}

function drawStableBodyCagePath(
  context: CanvasRenderingContext2D,
  frame: GarmentFrame,
  points: DressPoint[] = [],
  isCurved = false,
) {
  const worldPoints = getStableBodyCageWorldPoints(frame, points, isCurved);

  context.beginPath();
  context.moveTo(worldPoints[0].x, worldPoints[0].y);
  for (let index = 1; index < worldPoints.length; index += 1) {
    context.lineTo(worldPoints[index].x, worldPoints[index].y);
  }
  context.closePath();
}

function drawEditorHandles(context: CanvasRenderingContext2D, frame: GarmentFrame, points: DressPoint[], isCurved = false) {
  context.save();
  context.font = "600 10px Inter, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const point of points) {
    const world = projectLocalToWorld(frame, point.u, point.v, isCurved);
    context.fillStyle = "#f8c846";
    context.strokeStyle = "#171513";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(world.x, world.y, 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.fillStyle = "rgba(23, 21, 19, 0.82)";
    context.fillRect(world.x - 20, world.y - 24, 40, 14);
    context.fillStyle = "#ffffff";
    context.fillText(point.label, world.x, world.y - 17);
  }

  context.restore();
}

function getMeshPoint(frame: GarmentFrame, points: DressPoint[], u: number, v: number, isCurved: boolean) {
  return getMeshProjection(frame, points, u, v, isCurved).point;
}

function getMeshProjection(
  frame: GarmentFrame,
  points: DressPoint[],
  u: number,
  v: number,
  isCurved: boolean,
) {
  const leftU = getStableBodyCageU("left", v, points);
  const rightU = getStableBodyCageU("right", v, points);
  const frontU = isCurved && FRONT_SURFACE_U_IS_MIRRORED ? 1 - u : u;
  const surfaceU = leftU + (rightU - leftU) * frontU;
  return projectSurfacePoint(frame, surfaceU, v, isCurved);
}

function worldToMeshLocal(frame: GarmentFrame, points: DressPoint[], point: Vec2, isCurved: boolean) {
  let best = { u: 0.5, v: 0.5, score: Number.POSITIVE_INFINITY };
  const columns = 36;
  const rows = 56;

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const projection = getMeshProjection(frame, points, u, v, isCurved);
      if (isCurved && projection.frontWeight < FRONT_SURFACE_MIN_WEIGHT) continue;

      const distance = Math.hypot(projection.point.x - point.x, projection.point.y - point.y);
      const edgeDistance = Math.min(u, 1 - u);
      const sidePenalty = isCurved ? Math.max(0, FRONT_SURFACE_MIN_WEIGHT - edgeDistance) * 90 : 0;
      const frontWeightBonus = isCurved ? projection.frontWeight * 18 : 0;
      const score = distance + sidePenalty - frontWeightBonus;
      if (score < best.score) {
        best = { u, v, score };
      }
    }
  }

  return { u: best.u, v: best.v };
}

function isPointOnForegroundMask(mask: ImageData | null, point: Vec2) {
  if (!mask) return true;

  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return false;

  const index = (y * CANVAS_WIDTH + x) * 4;
  return mask.data[index + 3] > 72;
}

function drawMeshUvLine(
  context: CanvasRenderingContext2D,
  frame: GarmentFrame,
  points: DressPoint[],
  start: Vec2,
  end: Vec2,
  isCurved: boolean,
  foregroundMask: ImageData | null,
  samples: number,
) {
  let isDrawing = false;

  context.beginPath();
  for (let sample = 0; sample <= samples; sample += 1) {
    const blend = sample / samples;
    const point = getMeshPoint(
      frame,
      points,
      start.x + (end.x - start.x) * blend,
      start.y + (end.y - start.y) * blend,
      isCurved,
    );

    if (isPointOnForegroundMask(foregroundMask, point)) {
      if (!isDrawing) {
        context.moveTo(point.x, point.y);
        isDrawing = true;
      } else {
        context.lineTo(point.x, point.y);
      }
      continue;
    }

    if (isDrawing) {
      context.stroke();
      context.beginPath();
      isDrawing = false;
    }
  }

  if (isDrawing) context.stroke();
}

function drawSurfaceMesh(
  context: CanvasRenderingContext2D,
  frame: GarmentFrame,
  points: DressPoint[],
  isCurved: boolean,
  foregroundMask: ImageData | null,
) {
  const columns = isCurved ? CURVED_MESH_COLUMNS : 9;
  const rows = isCurved ? CURVED_MESH_ROWS : 14;
  const samples = isCurved ? CURVED_MESH_LINE_SAMPLES : 42;
  const diagonalSamples = isCurved ? CURVED_MESH_DIAGONAL_SAMPLES : 8;
  const meshCanvas = getReusableCanvas("mesh");
  const meshContext = meshCanvas.getContext("2d");
  if (!meshContext) return;

  meshContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  meshContext.save();
  drawStableBodyCagePath(meshContext, frame, points, isCurved);
  meshContext.clip();
  meshContext.strokeStyle = isCurved ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.12)";
  meshContext.lineWidth = isCurved ? 0.85 : 0.7;

  for (let column = 1; column < columns; column += 1) {
    const u = column / columns;
    drawMeshUvLine(meshContext, frame, points, { x: u, y: 0 }, { x: u, y: 1 }, isCurved, foregroundMask, samples);
  }

  for (let row = 1; row < rows; row += 1) {
    const v = row / rows;
    drawMeshUvLine(meshContext, frame, points, { x: 0, y: v }, { x: 1, y: v }, isCurved, foregroundMask, samples);
  }

  meshContext.strokeStyle = isCurved ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.16)";
  meshContext.lineWidth = isCurved ? 0.95 : 0.75;

  for (let row = 0; row < rows; row += 1) {
    const v0 = row / rows;
    const v1 = (row + 1) / rows;
    for (let column = 0; column < columns; column += 1) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const shouldRise = (row + column) % 2 === 0;
      drawMeshUvLine(
        meshContext,
        frame,
        points,
        shouldRise ? { x: u0, y: v1 } : { x: u0, y: v0 },
        shouldRise ? { x: u1, y: v0 } : { x: u1, y: v1 },
        isCurved,
        foregroundMask,
        diagonalSamples,
      );
    }
  }

  meshContext.restore();

  if (foregroundMask) {
    const maskCanvas = getReusableCanvas("mesh-mask");
    const maskContext = maskCanvas.getContext("2d");
    if (maskContext) {
      maskContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      maskContext.putImageData(foregroundMask, 0, 0);
      meshContext.globalCompositeOperation = "destination-in";
      meshContext.drawImage(maskCanvas, 0, 0);
      meshContext.globalCompositeOperation = "source-over";
    }
  }

  context.drawImage(meshCanvas, 0, 0);
}

function drawCurvedSurfaceCues(context: CanvasRenderingContext2D, frame: GarmentFrame, points: DressPoint[]) {
  context.save();
  drawStableBodyCagePath(context, frame, points, true);
  context.clip();

  const centerU = getTrackedBodyCenterU(points, 0.5);
  const left = projectLocalToWorld(frame, getStableBodyCageU("left", 0.5, points), 0.5, true);
  const center = projectLocalToWorld(frame, centerU, 0.5, true);
  const right = projectLocalToWorld(frame, getStableBodyCageU("right", 0.5, points), 0.5, true);
  const shade = context.createLinearGradient(left.x, left.y, right.x, right.y);
  shade.addColorStop(0, "rgba(0, 0, 0, 0.3)");
  shade.addColorStop(0.5, "rgba(255, 255, 255, 0.13)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0.24)");
  context.fillStyle = shade;
  drawStableBodyCagePath(context, frame, points, true);
  context.fill();

  context.strokeStyle = "rgba(255, 255, 255, 0.22)";
  context.lineWidth = 1;
  for (let u = 0.18; u <= 0.82; u += 0.16) {
    const top = projectLocalToWorld(frame, u, 0.08, true);
    const bottom = projectLocalToWorld(frame, u, 0.98, true);
    context.beginPath();
    context.moveTo(top.x, top.y);
    context.quadraticCurveTo(center.x, center.y, bottom.x, bottom.y);
    context.stroke();
  }

  context.restore();
}

function drawSurfaceScratch(
  context: CanvasRenderingContext2D,
  frame: GarmentFrame,
  points: DressPoint[],
  mark: ScratchMark,
  isCurved: boolean,
) {
  const centerProjection = getMeshProjection(frame, points, mark.u, mark.v, isCurved);
  if (isCurved && centerProjection.frontWeight < FRONT_SURFACE_MIN_WEIGHT) return;

  const center = centerProjection.point;

  if (!isCurved) {
    context.beginPath();
    context.arc(center.x, center.y, mark.radius * frame.width, 0, Math.PI * 2);
    context.fill();
    return;
  }

  const uRadius = mark.radius;
  const vRadius = mark.radius * (frame.width / frame.height);
  const uEdge = getMeshProjection(frame, points, mark.u + uRadius, mark.v, true).point;
  const vEdge = getMeshProjection(frame, points, mark.u, mark.v + vRadius, true).point;
  const tangentX = { x: uEdge.x - center.x, y: uEdge.y - center.y };
  const tangentY = { x: vEdge.x - center.x, y: vEdge.y - center.y };
  const xRadius = Math.max(4, Math.hypot(tangentX.x, tangentX.y));
  const yRadius = Math.max(4, Math.hypot(tangentY.x, tangentY.y));
  const angle = Math.atan2(tangentX.y, tangentX.x);

  context.save();
  context.translate(center.x, center.y);
  context.rotate(angle);
  context.scale(xRadius, yRadius);
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawForegroundLayer(
  context: CanvasRenderingContext2D,
  foregroundCanvas: HTMLCanvasElement,
  foregroundContext: CanvasRenderingContext2D,
  foregroundVideo: HTMLVideoElement,
  foregroundMask: ImageData | null,
  frame: GarmentFrame,
  points: DressPoint[],
  marks: ScratchMark[],
  isEditing: boolean,
  isCurved: boolean,
  showMesh: boolean,
  hoverPoint: Vec2 | null,
) {
  const activeMask = foregroundMask ?? drawChromaKeyedVideo(foregroundContext, foregroundVideo);

  foregroundContext.save();
  if (isEditing) {
    drawDressPath(foregroundContext, frame, points, isCurved);
  } else {
    drawStableBodyCagePath(foregroundContext, frame, points, isCurved);
  }
  foregroundContext.clip();
  foregroundContext.globalCompositeOperation = "destination-out";
  for (const mark of marks) {
    drawSurfaceScratch(foregroundContext, frame, points, mark, isCurved);
  }
  foregroundContext.restore();
  foregroundContext.globalCompositeOperation = "source-over";

  if (hoverPoint) {
    foregroundContext.save();
    foregroundContext.globalCompositeOperation = "destination-out";
    const gradient = foregroundContext.createRadialGradient(
      hoverPoint.x,
      hoverPoint.y,
      0,
      hoverPoint.x,
      hoverPoint.y,
      HOVER_REVEAL_RADIUS,
    );
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.72, "rgba(0,0,0,1)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    foregroundContext.fillStyle = gradient;
    foregroundContext.beginPath();
    foregroundContext.arc(hoverPoint.x, hoverPoint.y, HOVER_REVEAL_RADIUS, 0, Math.PI * 2);
    foregroundContext.fill();
    foregroundContext.restore();
    foregroundContext.globalCompositeOperation = "source-over";
  }

  context.drawImage(foregroundCanvas, 0, 0);

  if (hoverPoint) {
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(hoverPoint.x, hoverPoint.y, HOVER_REVEAL_RADIUS, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  if (showMesh) {
    if (isCurved) drawCurvedSurfaceCues(context, frame, points);
    drawSurfaceMesh(context, frame, points, isCurved, activeMask);
  }

  if (isEditing) {
    context.save();
    context.strokeStyle = "#f8c846";
    context.lineWidth = 2.5;
    drawDressPath(context, frame, points, isCurved);
    context.stroke();
    context.restore();
    drawEditorHandles(context, frame, points, isCurved);
  }
}

function calculateRevealProgress(marks: ScratchMark[]) {
  const samplesAcross = 13;
  const samplesDown = 18;
  let revealed = 0;
  let total = 0;

  for (let yIndex = 0; yIndex <= samplesDown; yIndex += 1) {
    for (let xIndex = 0; xIndex <= samplesAcross; xIndex += 1) {
      const u = xIndex / samplesAcross;
      const v = yIndex / samplesDown;

      total += 1;
      const isRevealed = marks.some((mark) => {
        const localDistance = Math.hypot((mark.u - u) / mark.radius, (mark.v - v) / mark.radius);
        return localDistance <= 1;
      });

      if (isRevealed) revealed += 1;
    }
  }

  return Math.min(1, revealed / Math.max(total, 1));
}

type TrackedMeshFrame = {
  t: number;
  verts: Vec2[];
  vis: number[];
};

type TrackedMesh = {
  cols: number;
  rows: number;
  fps: number;
  uv: Vec2[];
  frames: TrackedMeshFrame[];
};

// A live mesh sampled at the current video time: per-vertex canvas positions
// plus visibility, sharing the static UV grid from the source TrackedMesh.
type TrackedMeshSample = {
  cols: number;
  rows: number;
  uv: Vec2[];
  verts: Vec2[];
  vis: number[];
};

function parseTrackedMesh(value: unknown): TrackedMesh | null {
  if (!value || typeof value !== "object") return null;
  const data = value as {
    mesh?: { cols?: unknown; rows?: unknown };
    fps?: unknown;
    uv?: unknown;
    frames?: unknown;
  };
  const cols = Number(data.mesh?.cols);
  const rows = Number(data.mesh?.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return null;
  if (!Array.isArray(data.uv) || !Array.isArray(data.frames) || data.frames.length === 0) return null;

  const expected = cols * rows;
  const uv = data.uv as unknown[];
  if (uv.length !== expected) return null;
  const parsedUv = uv.map((pair) => {
    const point = pair as number[];
    return { x: Number(point?.[0]), y: Number(point?.[1]) };
  });
  if (parsedUv.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;

  const frames: TrackedMeshFrame[] = [];
  for (const rawFrame of data.frames as unknown[]) {
    const frame = rawFrame as { t?: unknown; verts?: unknown; vis?: unknown };
    if (typeof frame.t !== "number" || !Array.isArray(frame.verts) || frame.verts.length !== expected) {
      return null;
    }
    const verts = (frame.verts as unknown[]).map((pair) => {
      const point = pair as number[];
      return { x: Number(point?.[0]), y: Number(point?.[1]) };
    });
    if (verts.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
    const visSource = Array.isArray(frame.vis) ? (frame.vis as unknown[]) : [];
    const vis = verts.map((_, index) => (Number(visSource[index]) ? 1 : 0));
    frames.push({ t: frame.t, verts, vis });
  }

  return {
    cols,
    rows,
    fps: Number(data.fps) || 10,
    uv: parsedUv,
    frames: frames.sort((a, b) => a.t - b.t),
  };
}

// Interpolate vertex positions between the two source frames bracketing `time`.
function sampleTrackedMesh(mesh: TrackedMesh, time: number): TrackedMeshSample {
  const frames = mesh.frames;
  const loopTime = frames.length > 1 ? time % (frames[frames.length - 1].t || 1) : time;
  let previous = frames[0];
  let next = frames[frames.length - 1];
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index].t <= loopTime) previous = frames[index];
    if (frames[index].t >= loopTime) {
      next = frames[index];
      break;
    }
  }

  const span = next.t - previous.t;
  const blend = span > 0 ? (loopTime - previous.t) / span : 0;
  const verts = previous.verts.map((point, index) => {
    const target = next.verts[index] ?? point;
    return { x: point.x + (target.x - point.x) * blend, y: point.y + (target.y - point.y) * blend };
  });
  const vis = previous.vis.map((value, index) => (value && next.vis[index] ? 1 : 0));

  return { cols: mesh.cols, rows: mesh.rows, uv: mesh.uv, verts, vis };
}

function meshVertexAt(sample: TrackedMeshSample, col: number, row: number) {
  return sample.verts[row * sample.cols + col];
}

// A cell is usable only if all four corners are visible this frame — this skips
// off-body cells (never seeded) and occluded ones (e.g. an arm crossing).
function cellVisible(sample: TrackedMeshSample, col: number, row: number) {
  const { cols, vis } = sample;
  return Boolean(
    vis[row * cols + col] &&
      vis[row * cols + col + 1] &&
      vis[(row + 1) * cols + col] &&
      vis[(row + 1) * cols + col + 1],
  );
}

function trackedCellAt(sample: TrackedMeshSample, u: number, v: number) {
  const col = Math.min(sample.cols - 2, Math.max(0, Math.floor(Math.max(0, Math.min(1, u)) * (sample.cols - 1))));
  const row = Math.min(sample.rows - 2, Math.max(0, Math.floor(Math.max(0, Math.min(1, v)) * (sample.rows - 1))));
  return { col, row };
}

// Bilinear map from mesh-UV (the static grid) to the current deformed canvas
// position, so a scratch stored in UV rides the tracked fabric.
function trackedUvToWorld(sample: TrackedMeshSample, u: number, v: number): Vec2 {
  const fx = Math.max(0, Math.min(1, u)) * (sample.cols - 1);
  const fy = Math.max(0, Math.min(1, v)) * (sample.rows - 1);
  const col = Math.min(sample.cols - 2, Math.floor(fx));
  const row = Math.min(sample.rows - 2, Math.floor(fy));
  const sx = fx - col;
  const sy = fy - row;
  const topLeft = meshVertexAt(sample, col, row);
  const topRight = meshVertexAt(sample, col + 1, row);
  const bottomLeft = meshVertexAt(sample, col, row + 1);
  const bottomRight = meshVertexAt(sample, col + 1, row + 1);
  const top = { x: topLeft.x + (topRight.x - topLeft.x) * sx, y: topLeft.y + (topRight.y - topLeft.y) * sx };
  const bottom = {
    x: bottomLeft.x + (bottomRight.x - bottomLeft.x) * sx,
    y: bottomLeft.y + (bottomRight.y - bottomLeft.y) * sx,
  };
  return { x: top.x + (bottom.x - top.x) * sy, y: top.y + (bottom.y - top.y) * sy };
}

function barycentric(point: Vec2, a: Vec2, b: Vec2, c: Vec2) {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v2x = point.x - a.x;
  const v2y = point.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-6) return null;
  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  const u = 1 - v - w;
  if (u < -0.001 || v < -0.001 || w < -0.001) return null;
  return { u, v, w };
}

// Inverse of trackedUvToWorld: find which deformed cell holds `point` and
// return its mesh-UV via barycentric interpolation across the cell triangles.
function trackedWorldToUv(sample: TrackedMeshSample, point: Vec2): Vec2 | null {
  for (let row = 0; row < sample.rows - 1; row += 1) {
    for (let col = 0; col < sample.cols - 1; col += 1) {
      if (!cellVisible(sample, col, row)) continue;
      const topLeft = meshVertexAt(sample, col, row);
      const topRight = meshVertexAt(sample, col + 1, row);
      const bottomLeft = meshVertexAt(sample, col, row + 1);
      const bottomRight = meshVertexAt(sample, col + 1, row + 1);
      const uvTL = sample.uv[row * sample.cols + col];
      const uvTR = sample.uv[row * sample.cols + col + 1];
      const uvBL = sample.uv[(row + 1) * sample.cols + col];
      const uvBR = sample.uv[(row + 1) * sample.cols + col + 1];

      const first = barycentric(point, topLeft, topRight, bottomRight);
      if (first) {
        return {
          x: uvTL.x * first.u + uvTR.x * first.v + uvBR.x * first.w,
          y: uvTL.y * first.u + uvTR.y * first.v + uvBR.y * first.w,
        };
      }
      const second = barycentric(point, topLeft, bottomRight, bottomLeft);
      if (second) {
        return {
          x: uvTL.x * second.u + uvBR.x * second.v + uvBL.x * second.w,
          y: uvTL.y * second.u + uvBR.y * second.v + uvBL.y * second.w,
        };
      }
    }
  }
  return null;
}

function drawTrackedScratch(context: CanvasRenderingContext2D, sample: TrackedMeshSample, mark: ScratchMark) {
  // Don't draw a hole whose fabric is off-body or occluded this frame.
  const cell = trackedCellAt(sample, mark.u, mark.v);
  if (!cellVisible(sample, cell.col, cell.row)) return;

  const center = trackedUvToWorld(sample, mark.u, mark.v);
  const uEdge = trackedUvToWorld(sample, mark.u + mark.radius, mark.v);
  const vEdge = trackedUvToWorld(sample, mark.u, mark.v + mark.radius);
  const xRadius = Math.max(5, Math.hypot(uEdge.x - center.x, uEdge.y - center.y));
  const yRadius = Math.max(5, Math.hypot(vEdge.x - center.x, vEdge.y - center.y));
  const angle = Math.atan2(uEdge.y - center.y, uEdge.x - center.x);

  context.save();
  context.translate(center.x, center.y);
  context.rotate(angle);
  context.scale(xRadius, yRadius);
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawTrackedMeshLattice(context: CanvasRenderingContext2D, sample: TrackedMeshSample) {
  context.save();
  context.strokeStyle = "rgba(255, 255, 255, 0.2)";
  context.lineWidth = 0.85;
  const { cols, rows } = sample;
  const stroke = (a: Vec2, b: Vec2, visA: number, visB: number) => {
    if (!visA || !visB) return;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  };
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (col + 1 < cols) {
        stroke(sample.verts[index], sample.verts[index + 1], sample.vis[index], sample.vis[index + 1]);
      }
      if (row + 1 < rows) {
        stroke(sample.verts[index], sample.verts[index + cols], sample.vis[index], sample.vis[index + cols]);
      }
    }
  }
  context.restore();
}

function drawTrackedForegroundLayer(
  context: CanvasRenderingContext2D,
  foregroundCanvas: HTMLCanvasElement,
  foregroundContext: CanvasRenderingContext2D,
  foregroundVideo: HTMLVideoElement,
  foregroundMask: ImageData | null,
  sample: TrackedMeshSample,
  marks: ScratchMark[],
  showMesh: boolean,
  hoverPoint: Vec2 | null,
) {
  drawChromaKeyedVideo(foregroundContext, foregroundVideo);
  void foregroundMask;

  // No perimeter clip: with a masked grid the outer ring isn't a clean garment
  // outline. Holes are constrained instead by per-cell validity in
  // drawTrackedScratch, so scratches only cut where the fabric is tracked.
  foregroundContext.save();
  foregroundContext.globalCompositeOperation = "destination-out";
  for (const mark of marks) drawTrackedScratch(foregroundContext, sample, mark);
  foregroundContext.restore();
  foregroundContext.globalCompositeOperation = "source-over";

  context.drawImage(foregroundCanvas, 0, 0);

  if (hoverPoint) {
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(hoverPoint.x, hoverPoint.y, HOVER_REVEAL_RADIUS, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  if (showMesh) drawTrackedMeshLattice(context, sample);
}

export function ScratchPrototype() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bottomVideoRef = useRef<HTMLVideoElement | null>(null);
  const foregroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundMaskRef = useRef<ImageData | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const hoverPointRef = useRef<Vec2 | null>(null);
  const drawingRef = useRef(false);
  const frameRef = useRef<GarmentFrame>(getSyntheticFrame(0));
  const renderedDressPointsRef = useRef<DressPoint[]>(DEFAULT_DRESS_POINTS);
  const trackedFrameRef = useRef<GarmentFrame | null>(null);
  const trackedDressPointsRef = useRef<DressPoint[] | null>(null);
  const [keyframes, setKeyframes] = useState(DEFAULT_KEYFRAMES);
  const [trackedMesh, setTrackedMesh] = useState<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const [meshFiles, setMeshFiles] = useState<string[]>([]);
  const [selectedMeshFile, setSelectedMeshFile] = useState("");
  const [meshReloadToken, setMeshReloadToken] = useState(0);
  const [isCurvedMask, setIsCurvedMask] = useState(true);
  const [showMesh, setShowMesh] = useState(true);
  const [progress, setProgress] = useState(0);
  const [claimed, setClaimed] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(18.8);
  const [isPaused, setIsPaused] = useState(false);
  const progressRef = useRef(progress);
  const claimedRef = useRef(claimed);
  const uiStateRef = useRef({
    currentTime,
    duration,
    isPaused,
    lastUpdatedAt: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const foregroundCanvas = document.createElement("canvas");
    foregroundCanvas.width = CANVAS_WIDTH;
    foregroundCanvas.height = CANVAS_HEIGHT;
    foregroundCanvasRef.current = foregroundCanvas;
    const foregroundContext = foregroundCanvas.getContext("2d", { willReadFrequently: true });
    if (!foregroundContext) return;

    let animationId = 0;
    const startedAt = performance.now();

    const render = () => {
      const time = (performance.now() - startedAt) / 1000;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      const hasVideoFrame = Boolean(bottomVideo && bottomVideo.readyState >= 2 && !bottomVideo.paused);
      const hasForegroundFrame = Boolean(foregroundVideo && foregroundVideo.readyState >= 2);
      const baseFrame = hasVideoFrame ? getVideoGarmentFrame() : getSyntheticFrame(time);
      const videoTime = bottomVideo?.currentTime ?? time;
      const keyedForeground =
        foregroundVideo && hasForegroundFrame && foregroundCanvasRef.current
          ? drawChromaKeyedVideo(foregroundContext, foregroundVideo)
          : null;
      // When a tracked deforming mesh is loaded it drives the garment directly,
      // so the per-frame silhouette tracking below is skipped.
      const trackedSample = trackedMesh && hasForegroundFrame ? sampleTrackedMesh(trackedMesh, videoTime) : null;
      trackedSampleRef.current = trackedSample;
      const keyframedFrame = interpolateGarmentFrame(keyframes, videoTime);
      const frame =
        keyframedFrame ??
        (keyedForeground && !trackedMesh
          ? trackBodyFrameFromForeground(keyedForeground, baseFrame, trackedFrameRef.current)
          : baseFrame);
      if (keyedForeground && !keyframedFrame && !trackedMesh) {
        trackedFrameRef.current = frame;
      }
      const keyframedDressPoints = interpolateDressPoints(keyframes, videoTime);
      const renderDressPoints =
        trackedMesh || keyframedFrame || !keyedForeground
          ? keyframedDressPoints
          : trackBodyPointsFromForeground(frame, keyedForeground, trackedDressPointsRef.current);
      if (keyedForeground && !keyframedFrame && !trackedMesh) {
        trackedDressPointsRef.current = cloneDressPoints(renderDressPoints);
      }
      foregroundMaskRef.current = keyedForeground;
      renderedDressPointsRef.current = renderDressPoints;
      frameRef.current = frame;

      if (bottomVideo) {
        const now = performance.now();
        const nextDuration = bottomVideo.duration || uiStateRef.current.duration;
        const nextPaused = bottomVideo.paused;
        const shouldUpdateUi =
          now - uiStateRef.current.lastUpdatedAt >= UI_STATE_UPDATE_INTERVAL_MS ||
          nextPaused !== uiStateRef.current.isPaused ||
          Math.abs(videoTime - uiStateRef.current.currentTime) > 1;

        if (shouldUpdateUi) {
          uiStateRef.current = {
            currentTime: videoTime,
            duration: nextDuration,
            isPaused: nextPaused,
            lastUpdatedAt: now,
          };
          setCurrentTime(videoTime);
          setDuration(nextDuration);
          setIsPaused(nextPaused);
        }
      }

      context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (bottomVideo && hasVideoFrame) {
        if (foregroundVideo && foregroundVideo.readyState >= 1) {
          syncVideoTime(bottomVideo, foregroundVideo);
        }
        drawVideoContain(context, bottomVideo);
      } else {
        drawSyntheticVideoFrame(context, frame, time);
      }

      if (foregroundVideo && hasForegroundFrame) {
        const foregroundLayer = foregroundCanvasRef.current;
        if (foregroundLayer && trackedSample) {
          drawTrackedForegroundLayer(
            context,
            foregroundLayer,
            foregroundContext,
            foregroundVideo,
            keyedForeground,
            trackedSample,
            marksRef.current,
            showMesh,
            hoverPointRef.current,
          );
        } else if (foregroundLayer) {
          drawForegroundLayer(
            context,
            foregroundLayer,
            foregroundContext,
            foregroundVideo,
            keyedForeground,
            frame,
            renderDressPoints,
            marksRef.current,
            false,
            isCurvedMask,
            showMesh,
            hoverPointRef.current,
          );
        }
      } else {
        drawEditorHandles(context, frame, renderDressPoints, isCurvedMask);
      }

      context.fillStyle = "rgba(20, 24, 26, 0.58)";
      context.fillRect(18, CANVAS_HEIGHT - 96, CANVAS_WIDTH - 36, 72);
      context.fillStyle = "#ffffff";
      context.font = "600 15px Inter, system-ui, sans-serif";
      context.fillText(
        claimedRef.current ? "Dress reveal completed" : "Scratch the foreground video",
        36,
        CANVAS_HEIGHT - 58,
      );
      context.font = "13px Inter, system-ui, sans-serif";
      context.fillText(`${Math.round(progressRef.current * 100)}% revealed`, 36, CANVAS_HEIGHT - 36);

      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [isCurvedMask, keyframes, showMesh, trackedMesh]);

  useEffect(() => {
    let isCancelled = false;

    fetch(`${MESH_INDEX_SRC}?v=${meshReloadToken}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        const files = parseMeshIndex(data);
        setMeshFiles(files);
        setSelectedMeshFile((currentFile) => currentFile || (files.includes(DEFAULT_MESH_FILE) ? DEFAULT_MESH_FILE : files[0]) || "");
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken]);

  useEffect(() => {
    if (!selectedMeshFile) {
      setKeyframes(DEFAULT_KEYFRAMES);
      setTrackedMesh(null);
      return;
    }

    let isCancelled = false;

    fetch(`${MESH_DIRECTORY_SRC}/${encodeURIComponent(selectedMeshFile)}?v=${meshReloadToken}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;

        // A tracked deforming mesh (CoTracker grid) takes priority over the
        // pose/silhouette keyframe format when the file matches its schema.
        const tracked = parseTrackedMesh(data);
        if (tracked) {
          setTrackedMesh(tracked);
          return;
        }

        setTrackedMesh(null);
        const generated = parseGeneratedKeyframes(data);
        if (generated.keyframes.length > 0) {
          setKeyframes(generated.keyframes);
        }
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken, selectedMeshFile]);

  useEffect(() => {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;

    const onBottomCanPlay = () => {
      const nextDuration = bottomVideo.duration || uiStateRef.current.duration;
      uiStateRef.current = {
        ...uiStateRef.current,
        duration: nextDuration,
        isPaused: bottomVideo.paused,
      };
      setDuration(nextDuration);
      void bottomVideo.play().catch(() => undefined);
    };
    const onForegroundCanPlay = () => {
      void foregroundVideo.play().catch(() => undefined);
    };

    bottomVideo.addEventListener("canplay", onBottomCanPlay);
    foregroundVideo.addEventListener("canplay", onForegroundCanPlay);

    return () => {
      bottomVideo.removeEventListener("canplay", onBottomCanPlay);
      foregroundVideo.removeEventListener("canplay", onForegroundCanPlay);
    };
  }, []);

  function applyScratchZoom(point: Vec2) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.transformOrigin = `${(point.x / CANVAS_WIDTH) * 100}% ${(point.y / CANVAS_HEIGHT) * 100}%`;
    canvas.style.transform = "scale(1.35)";
  }

  function clearScratchZoom() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.transform = "scale(1)";
  }

  function getCanvasPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    if (!point) return;

    // Tracked-mesh path: invert the deforming lattice to get garment UV.
    const trackedSample = trackedSampleRef.current;
    if (trackedSample) {
      const uv = trackedWorldToUv(trackedSample, point);
      if (!uv) return;
      marksRef.current = [...marksRef.current, { u: uv.x, v: uv.y, radius: 0.045 }].slice(-180);
      const nextProgressTracked = calculateRevealProgress(marksRef.current);
      progressRef.current = nextProgressTracked;
      setProgress(nextProgressTracked);
      if (nextProgressTracked >= CLAIM_THRESHOLD) {
        claimedRef.current = true;
        setClaimed(true);
      }
      return;
    }

    const frame = frameRef.current;
    const renderDressPoints = renderedDressPointsRef.current;
    const foregroundMask = foregroundMaskRef.current;
    const dressPolygon = getStableBodyCageWorldPoints(frame, renderDressPoints, isCurvedMask);

    if (!pointInPolygon(point, dressPolygon)) return;
    if (!isPointOnForegroundMask(foregroundMask, point)) return;

    const local = worldToMeshLocal(frame, renderDressPoints, point, isCurvedMask);
    if (local.u < 0 || local.u > 1 || local.v < 0 || local.v > 1) return;

    marksRef.current = [
      ...marksRef.current,
      {
        u: local.u,
        v: local.v,
        radius: 0.045,
      },
    ].slice(-180);

    const nextProgress = calculateRevealProgress(marksRef.current);
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    if (nextProgress >= CLAIM_THRESHOLD) {
      claimedRef.current = true;
      setClaimed(true);
    }
  }

  function setVideoTime(time: number) {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    const nextTime = Math.max(0, Math.min(duration || 0, time));

    if (bottomVideo) bottomVideo.currentTime = nextTime;
    if (foregroundVideo && Number.isFinite(foregroundVideo.duration) && foregroundVideo.duration > 0) {
      foregroundVideo.currentTime = nextTime % foregroundVideo.duration;
    }
    uiStateRef.current = {
      ...uiStateRef.current,
      currentTime: nextTime,
      lastUpdatedAt: performance.now(),
    };
    setCurrentTime(nextTime);
  }

  function togglePlayback() {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;

    if (bottomVideo.paused) {
      void bottomVideo.play();
      void foregroundVideo.play();
      uiStateRef.current = { ...uiStateRef.current, isPaused: false };
      setIsPaused(false);
    } else {
      bottomVideo.pause();
      foregroundVideo.pause();
      uiStateRef.current = { ...uiStateRef.current, isPaused: true };
      setIsPaused(true);
    }
  }

  return (
    <main className="app-shell">
      <section className="prototype">
        <div className="stage">
          <video
            ref={bottomVideoRef}
            className="source-video"
            muted
            loop
            playsInline
            preload="auto"
            src={BOTTOM_VIDEO_SRC}
          />
          <video
            ref={foregroundVideoRef}
            className="source-video"
            muted
            loop
            playsInline
            preload="auto"
            src={FOREGROUND_VIDEO_SRC}
          />
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={(event) => {
              drawingRef.current = true;
              const point = getCanvasPoint(event.clientX, event.clientY);
              hoverPointRef.current = point;
              event.currentTarget.setPointerCapture(event.pointerId);
              if (point) applyScratchZoom(point);
              addScratch(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              hoverPointRef.current = getCanvasPoint(event.clientX, event.clientY);
              if (!drawingRef.current) return;
              addScratch(event.clientX, event.clientY);
            }}
            onPointerUp={() => {
              drawingRef.current = false;
              clearScratchZoom();
            }}
            onPointerLeave={() => {
              drawingRef.current = false;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
            onPointerCancel={() => {
              drawingRef.current = false;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
          />
        </div>
        <aside className="panel">
          <div>
            <p className="eyebrow">Milestone 1</p>
            <h1>Full Dress Scratch Test</h1>
          </div>
          <label>
            Mesh
            <select
              aria-label="Mesh keyframe JSON"
              disabled={meshFiles.length === 0}
              onChange={(event) => setSelectedMeshFile(event.currentTarget.value)}
              value={selectedMeshFile}
            >
              {meshFiles.length === 0 ? (
                <option value="">No mesh JSON files</option>
              ) : (
                meshFiles.map((file) => (
                  <option
                    key={file}
                    value={file}
                  >
                    {file}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="timeline-controls">
            <input
              aria-label="Video timeline"
              max={duration || 0}
              min={0}
              onChange={(event) => setVideoTime(Number(event.currentTarget.value))}
              step={0.05}
              type="range"
              value={Math.min(currentTime, duration || currentTime)}
            />
          </div>
          <div className="button-row">
            <button
              type="button"
              onClick={togglePlayback}
            >
              {isPaused ? "Play video" : "Pause video"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                marksRef.current = [];
                progressRef.current = 0;
                claimedRef.current = false;
                setProgress(0);
                setClaimed(false);
              }}
            >
              Reset scratch
            </button>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIsCurvedMask((current) => !current)}
            >
              {isCurvedMask ? "Use flat mask" : "Use 3D mesh"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowMesh((current) => !current)}
            >
              {showMesh ? "Hide mesh" : "Show mesh"}
            </button>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setMeshReloadToken((current) => current + 1)}
          >
            Reload mesh
          </button>
        </aside>
      </section>
    </main>
  );
}
