import { useEffect, useRef, useState } from "react";

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
const BOTTOM_VIDEO_SRC = "/cards/ai%20girl%202.mp4";
const FOREGROUND_VIDEO_SRC = "/cards/Green%20bg%20sample%202%20swap.mp4";
const MESH_INDEX_SRC = "/mesh/index.json";
const MESH_DIRECTORY_SRC = "/mesh";
const DEFAULT_MESH_FILE = "tracked-mesh.json";
const CLAIM_THRESHOLD = 0.35;
const UI_STATE_UPDATE_INTERVAL_MS = 250;
const HOVER_REVEAL_RADIUS = 46;

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

function drawChromaKeyedVideo(foregroundContext: CanvasRenderingContext2D, video: HTMLVideoElement) {
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
  const marksRef = useRef<ScratchMark[]>([]);
  const hoverPointRef = useRef<Vec2 | null>(null);
  const drawingRef = useRef(false);
  const [trackedMesh, setTrackedMesh] = useState<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const [meshFiles, setMeshFiles] = useState<string[]>([]);
  const [selectedMeshFile, setSelectedMeshFile] = useState("");
  const [meshReloadToken, setMeshReloadToken] = useState(0);
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
      const videoTime = bottomVideo?.currentTime ?? time;
      const trackedSample = trackedMesh && hasForegroundFrame ? sampleTrackedMesh(trackedMesh, videoTime) : null;
      trackedSampleRef.current = trackedSample;

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
      }

      if (foregroundVideo && hasForegroundFrame && foregroundCanvasRef.current && trackedSample) {
        drawTrackedForegroundLayer(
          context,
          foregroundCanvasRef.current,
          foregroundContext,
          foregroundVideo,
          null,
          trackedSample,
          marksRef.current,
          showMesh,
          hoverPointRef.current,
        );
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
  }, [showMesh, trackedMesh]);

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

    // Invert the deforming lattice to get garment UV, so the scratch rides the
    // tracked fabric.
    const trackedSample = trackedSampleRef.current;
    if (!trackedSample) return;
    const uv = trackedWorldToUv(trackedSample, point);
    if (!uv) return;

    marksRef.current = [...marksRef.current, { u: uv.x, v: uv.y, radius: 0.045 }].slice(-180);
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
