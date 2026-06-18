import { useEffect, useRef, useState } from "react";
import { GarmentGLRenderer, PRESENT_ZOOM } from "./glRenderer";

type Vec2 = {
  x: number;
  y: number;
};

type ScratchMark = {
  u: number;
  v: number;
  radius: number;
};

const CANVAS_WIDTH = 390;
const CANVAS_HEIGHT = 672;
// A card pairs the reveal (bottom) video, the green-screen foreground video, and
// the tracked mesh generated from that foreground. Switching cards swaps all
// three together so the scratch holes line up with the right clip.
type Card = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
  mesh: string;
};

const CARDS: Card[] = [
  {
    id: "original",
    label: "Original",
    bottom: "/cards/ai%20girl%202.mp4",
    foreground: "/cards/Green%20bg%20sample%202%20swap.mp4",
    mesh: "tracked-mesh.json",
  },
  {
    id: "girl_1",
    label: "Girl 1",
    bottom: "/cards/girl_1/background.mp4",
    foreground: "/cards/girl_1/foreground.mp4",
    mesh: "girl_1.json",
  },
  {
    id: "girl_2",
    label: "Girl 2",
    bottom: "/cards/girl_2/background.mp4",
    foreground: "/cards/girl_2/foreground.mp4",
    mesh: "girl_2.json",
  },
  {
    id: "juliana_1",
    label: "Juliana 1",
    bottom: "/cards/juliana_1/background.mp4",
    foreground: "/cards/juliana_1/foreground.mp4",
    mesh: "juliana_1.json",
  },
];

const MESH_INDEX_SRC = "/mesh/index.json";
const MESH_DIRECTORY_SRC = "/mesh";
const DEFAULT_MESH_FILE = "tracked-mesh.json";
const CLAIM_THRESHOLD = 0.35;
const UI_STATE_UPDATE_INTERVAL_MS = 250;
// Scratch brush radius in garment-UV units (0..1). Smaller = finer scratches.
const SCRATCH_RADIUS = 0.028;

// Subtle virtual camera that keeps the performer's chest near a fixed framing
// point. The chest anchor is a mesh-UV coordinate (roughly center, upper torso);
// each frame we sample where it lands and pan the presented shot toward the
// target. Pan is clamped small (and < PRESENT_ZOOM-1 so no edge shows) and
// smoothed so the move stays gentle.
const CHEST_ANCHOR_UV = { x: 0.5, y: 0.4 };
const CHEST_TARGET_UV = { x: 0.5, y: 0.4 };
const CHEST_FOLLOW_STRENGTH = 0.7;
const CHEST_CAM_MAX = Math.min(0.05, PRESENT_ZOOM - 1);
const CHEST_SMOOTH = 0.08;

function clampValue(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

// Bilinearly interpolate the deformed mesh at a fractional UV grid position to
// get its current canvas-pixel location (the mesh UV grid is regular 0..1).
function sampleMeshUvToWorld(sample: TrackedMeshSample, u: number, v: number): Vec2 {
  const { cols, rows, verts } = sample;
  const gx = clampValue(u * (cols - 1), 0, cols - 1);
  const gy = clampValue(v * (rows - 1), 0, rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const v00 = verts[y0 * cols + x0];
  const v10 = verts[y0 * cols + x1];
  const v01 = verts[y1 * cols + x0];
  const v11 = verts[y1 * cols + x1];
  const topX = v00.x + (v10.x - v00.x) * fx;
  const topY = v00.y + (v10.y - v00.y) * fx;
  const botX = v01.x + (v11.x - v01.x) * fx;
  const botY = v01.y + (v11.y - v01.y) * fx;
  return { x: topX + (botX - topX) * fy, y: topY + (botY - topY) * fy };
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

// Interpolate vertex positions between the two source frames bracketing `time`,
// writing into a reused `store` to avoid per-frame allocation (this runs every
// rAF). Pass the previous return value back as `store`; it is reallocated only
// when the mesh identity/size changes.
function sampleTrackedMesh(
  mesh: TrackedMesh,
  time: number,
  store: TrackedMeshSample | null,
): TrackedMeshSample {
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
  const n = mesh.uv.length;

  let target = store;
  if (!target || target.verts.length !== n || target.uv !== mesh.uv) {
    const verts: Vec2[] = new Array(n);
    for (let i = 0; i < n; i += 1) verts[i] = { x: 0, y: 0 };
    target = { cols: mesh.cols, rows: mesh.rows, uv: mesh.uv, verts, vis: new Array(n) };
  }

  for (let i = 0; i < n; i += 1) {
    const p = previous.verts[i];
    const q = next.verts[i] ?? p;
    const vert = target.verts[i];
    vert.x = p.x + (q.x - p.x) * blend;
    vert.y = p.y + (q.y - p.y) * blend;
    target.vis[i] = previous.vis[i] && next.vis[i] ? 1 : 0;
  }
  return target;
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

// Map a canvas point to mesh-UV: find which deformed cell holds `point` and
// return its UV via barycentric interpolation across the cell triangles.
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

export function ScratchPrototype() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bottomVideoRef = useRef<HTMLVideoElement | null>(null);
  const foregroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const glRendererRef = useRef<GarmentGLRenderer | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const hoverPointRef = useRef<Vec2 | null>(null);
  const drawingRef = useRef(false);
  const [trackedMesh, setTrackedMesh] = useState<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  // Persistent sample reused across frames by sampleTrackedMesh (no per-frame alloc).
  const sampleStoreRef = useRef<TrackedMeshSample | null>(null);
  const trackedMeshRef = useRef<TrackedMesh | null>(null);
  trackedMeshRef.current = trackedMesh;
  // Smoothed chest-follow camera offset, in clip units. Read by getCanvasPoint
  // to invert the pan when mapping a tap back to fabric UV.
  const cameraRef = useRef({ x: 0, y: 0 });
  const [meshFiles, setMeshFiles] = useState<string[]>([]);
  const [selectedMeshFile, setSelectedMeshFile] = useState(CARDS[0].mesh);
  const [meshReloadToken, setMeshReloadToken] = useState(0);
  const [selectedCardId, setSelectedCardId] = useState(CARDS[0].id);
  const card = CARDS.find((entry) => entry.id === selectedCardId) ?? CARDS[0];
  // The mesh lattice is a dev overlay — default it off on phones (where the
  // toggle is hidden).
  const [showMesh, setShowMesh] = useState(
    () => !(typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches),
  );
  const showMeshRef = useRef(showMesh);
  showMeshRef.current = showMesh;
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

  // Create the WebGL renderer once so the scratch texture persists across mesh
  // / showMesh changes (those are read live via refs).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: GarmentGLRenderer;
    try {
      renderer = new GarmentGLRenderer(canvas, CANVAS_WIDTH, CANVAS_HEIGHT);
    } catch (error) {
      console.error("WebGL init failed", error);
      return;
    }
    glRendererRef.current = renderer;

    let animationId = 0;
    const startedAt = performance.now();

    const render = () => {
      const time = (performance.now() - startedAt) / 1000;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      const trackedMeshNow = trackedMeshRef.current;
      const hasForegroundFrame = Boolean(foregroundVideo && foregroundVideo.readyState >= 2);
      const videoTime = bottomVideo?.currentTime ?? time;
      const trackedSample =
        trackedMeshNow && hasForegroundFrame
          ? sampleTrackedMesh(trackedMeshNow, videoTime, sampleStoreRef.current)
          : null;
      sampleStoreRef.current = trackedSample ?? sampleStoreRef.current;
      trackedSampleRef.current = trackedSample;

      // Subtle chest-follow camera: pan toward keeping the chest anchor at its
      // target framing point, clamped + smoothed.
      const camera = cameraRef.current;
      let targetCamX = 0;
      let targetCamY = 0;
      if (trackedSample) {
        const chest = sampleMeshUvToWorld(trackedSample, CHEST_ANCHOR_UV.x, CHEST_ANCHOR_UV.y);
        const targetPx = CANVAS_WIDTH * CHEST_TARGET_UV.x;
        const targetPy = CANVAS_HEIGHT * CHEST_TARGET_UV.y;
        const shiftX = (targetPx - chest.x) * CHEST_FOLLOW_STRENGTH;
        const shiftY = (targetPy - chest.y) * CHEST_FOLLOW_STRENGTH;
        targetCamX = clampValue(shiftX / (CANVAS_WIDTH / 2), -CHEST_CAM_MAX, CHEST_CAM_MAX);
        targetCamY = clampValue(-shiftY / (CANVAS_HEIGHT / 2), -CHEST_CAM_MAX, CHEST_CAM_MAX);
      }
      camera.x += (targetCamX - camera.x) * CHEST_SMOOTH;
      camera.y += (targetCamY - camera.y) * CHEST_SMOOTH;

      if (bottomVideo && foregroundVideo && bottomVideo.readyState >= 2 && foregroundVideo.readyState >= 1) {
        syncVideoTime(bottomVideo, foregroundVideo);
      }

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

      renderer.render(bottomVideo, foregroundVideo, trackedSample, showMeshRef.current, camera);
      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationId);
      glRendererRef.current = null;
    };
  }, []);

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
      setTrackedMesh(null);
      return;
    }

    let isCancelled = false;

    fetch(`${MESH_DIRECTORY_SRC}/${encodeURIComponent(selectedMeshFile)}?v=${meshReloadToken}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        setTrackedMesh(parseTrackedMesh(data));
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken, selectedMeshFile]);

  // Switching cards: load that card's mesh and clear scratches/progress so holes
  // from the previous clip don't carry over onto the new fabric.
  useEffect(() => {
    setSelectedMeshFile(card.mesh);
    marksRef.current = [];
    glRendererRef.current?.clearScratch();
    progressRef.current = 0;
    claimedRef.current = false;
    setProgress(0);
    setClaimed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId]);

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

  function isPhoneLayout() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;
  }

  function resetScratch() {
    marksRef.current = [];
    glRendererRef.current?.clearScratch();
    progressRef.current = 0;
    claimedRef.current = false;
    setProgress(0);
    setClaimed(false);
  }

  // On phones the canvas is centered with a translate that fills the screen, so
  // the magnify scale has to be composed on top of it rather than replacing it.
  const canvasBaseTransform = () => (isPhoneLayout() ? "translate(-50%, -50%) " : "");

  function applyScratchZoom(point: Vec2) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.transformOrigin = `${(point.x / CANVAS_WIDTH) * 100}% ${(point.y / CANVAS_HEIGHT) * 100}%`;
    canvas.style.transform = `${canvasBaseTransform()}scale(1.35)`;
  }

  function clearScratchZoom() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.transform = `${canvasBaseTransform()}scale(1)`;
  }

  function getCanvasPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    // Screen -> presented canvas pixels.
    const presentX = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const presentY = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    // Invert the chest-follow camera (overscan + clip-space pan) so a tap maps to
    // the reference-frame fabric coordinate the mesh/holes live in.
    const cam = cameraRef.current;
    const refClipX = (presentX / CANVAS_WIDTH * 2 - 1 - cam.x) / PRESENT_ZOOM;
    const refClipY = (1 - presentY / CANVAS_HEIGHT * 2 - cam.y) / PRESENT_ZOOM;
    return {
      x: (refClipX + 1) / 2 * CANVAS_WIDTH,
      y: (1 - refClipY) / 2 * CANVAS_HEIGHT,
    };
  }

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    if (!point) return;

    // Invert the deforming lattice to get garment UV, so the scratch rides the
    // tracked fabric.
    const trackedSample = trackedSampleRef.current;
    if (!trackedSample) return;
    const uv = trackedWorldToUv(trackedSample, point);
    if (!uv) return;

    marksRef.current = [...marksRef.current, { u: uv.x, v: uv.y, radius: SCRATCH_RADIUS }].slice(-180);
    glRendererRef.current?.paintScratch(uv.x, uv.y, SCRATCH_RADIUS);
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
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            src={card.bottom}
          />
          <video
            ref={foregroundVideoRef}
            className="source-video"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            src={card.foreground}
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
          {/* Phones hide the dev panel, so surface compact controls on the stage
              itself. Hidden on desktop where the panel is used. */}
          <div className="mobile-controls">
            <label className="mobile-card-switch">
              <span className="visually-hidden">Card</span>
              <select
                aria-label="Card clip"
                onChange={(event) => setSelectedCardId(event.currentTarget.value)}
                value={selectedCardId}
              >
                {CARDS.map((entry) => (
                  <option
                    key={entry.id}
                    value={entry.id}
                  >
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="mobile-reset"
              aria-label="Reset scratch"
              onClick={resetScratch}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
        </div>
        <aside className="panel">
          <div>
            <p className="eyebrow">Milestone 1</p>
            <h1>Full Dress Scratch Test</h1>
          </div>
          <label>
            Card
            <select
              aria-label="Card clip"
              onChange={(event) => setSelectedCardId(event.currentTarget.value)}
              value={selectedCardId}
            >
              {CARDS.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                >
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
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
              onClick={resetScratch}
            >
              Reset scratch
            </button>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowMesh((current) => !current)}
            >
              {showMesh ? "Hide mesh" : "Show mesh"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setMeshReloadToken((current) => current + 1)}
            >
              Reload mesh
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}
