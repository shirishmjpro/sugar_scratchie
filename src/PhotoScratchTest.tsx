import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import { useEffect, useRef, useState } from "react";
import {
  GarmentGLRenderer,
  PRESENT_ZOOM,
  type ImageLayerCameras,
} from "./glRenderer";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  SYMBOL_POINT_COUNT,
  parseTrackedMesh,
  sampleMeshUvToWorld,
  sampleTrackedMesh,
  trackedWorldToUv,
  type TrackedMesh,
  type TrackedMeshSample,
  type Vec2,
} from "./meshGeometry";
import { useDeviceParallax, type ParallaxState } from "./useDeviceParallax";

const BACK_LAYER_SRC = "/photo-scratch/background.jpg";
const MID_LAYER_SRC = "/photo-scratch/mid.png";
const FRONT_LAYER_SRC = "/photo-scratch/foreground.png";
const MESH_SRC = "/photo-scratch/mesh.json";

type PhotoScratchCardEntry = {
  id: string;
  label: string;
  background: string;
  bikini: string;
  clothes: string;
  mesh: string;
  model_id?: string;
};

function readCardIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("card")?.trim() || "";
}

async function fetchPhotoScratchIndex(): Promise<PhotoScratchCardEntry[]> {
  const response = await fetch("/photo-scratch/index.json", {
    cache: "no-store",
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { cards?: PhotoScratchCardEntry[] };
  return data.cards ?? [];
}

const SCRATCH_RADIUS = 0.045;
const MANUAL_SCRATCH_PATH_STEP = SCRATCH_RADIUS * 0.65 * CANVAS_HEIGHT;
const MANUAL_SCRATCH_MAX_POINTS = 40;
const FOREGROUND_CHROMA = false;
// Room bg needs extra overscan beyond PRESENT_ZOOM so tilt + finger parallax
// never reveals the stage letterboxing.
const PARALLAX_MAX_X = 22;
const PARALLAX_MAX_Y = 16;
// Opposite room drift while scratching — girl layers stay locked.
const PARALLAX_FINGER_MAX = 16;
const PARALLAX_FINGER_GAIN = 0.22;
const BG_OVERSCAN = Math.max(
  PRESENT_ZOOM,
  1 + (2 * (PARALLAX_MAX_X + PARALLAX_FINGER_MAX)) / CANVAS_WIDTH,
  1 + (2 * (PARALLAX_MAX_Y + PARALLAX_FINGER_MAX)) / CANVAS_HEIGHT,
);
// Idle “alive” sway for synced bikini + clothes before the first scratch.
// Soft motion after load — mostly up/down with a slight right drift.
const IDLE_SWAY_AMP_X = 2.8;
const IDLE_SWAY_AMP_Y = 5.5;
const IDLE_SWAY_PERIOD_MS = 4200;
const IDLE_SWAY_EASE = 0.04;
// Softly ease girl cam toward lock (center) / unlock — no hard snap.
const GIRL_CAM_EASE = 0.085;
// Room blur/zoom ease slower than girl lock; keep blur subtle.
const BG_FX_EASE = 0.035;
const BG_BLUR_PX = 7;
const BG_BRIGHTNESS_DIM = 0.8;

type ScratchMark = { u: number; v: number; radius: number };

// Lottie game symbols (same set as the video prototype). Symbols are revealed
// when a scratch stroke passes near their mesh-UV anchor from mesh.json.
const SYMBOL_TYPES: { src: string; label: string }[] = [
  { src: "/lotties/01-Heart.lottie", label: "Heart" },
  { src: "/lotties/02-Lock.lottie", label: "Lock" },
  { src: "/lotties/03-GemDiamond.lottie", label: "Gem" },
  { src: "/lotties/04-Star.lottie", label: "Star" },
  { src: "/lotties/05-Diamond.lottie", label: "Diamond" },
  { src: "/lotties/06-Magnet.lottie", label: "Magnet" },
  { src: "/lotties/07-Crown.lottie", label: "Crown" },
  { src: "/lotties/08-Gold%20Coins.lottie", label: "Gold Coins" },
  { src: "/lotties/09-Key.lottie", label: "Key" },
  { src: "/lotties/10-Treasure%20Chest.lottie", label: "Treasure Chest" },
  { src: "/lotties/11-Diamond%20Cards.lottie", label: "Diamond Cards" },
  { src: "/lotties/12-WinnerTrophy.lottie", label: "Trophy" },
];
const SYMBOL_REVEAL_UV_RADIUS = 0.06;

function buildSessionSymbols(): number[] {
  return Array.from({ length: SYMBOL_POINT_COUNT }, () =>
    Math.floor(Math.random() * SYMBOL_TYPES.length),
  );
}

function GameSymbolIcon({
  typeId,
  size = 24,
}: {
  typeId: number;
  size?: number;
}) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  return (
    <DotLottieReact
      src={entry.src}
      autoplay
      loop
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="game-symbol-lottie"
    />
  );
}

function worldPointToStage(
  worldPoint: Vec2,
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  camera: { x: number; y: number },
): Vec2 {
  const canvasRect = canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const refClipX = (worldPoint.x / CANVAS_WIDTH) * 2 - 1;
  const refClipY = 1 - (worldPoint.y / CANVAS_HEIGHT) * 2;
  const presentX =
    ((refClipX * PRESENT_ZOOM + camera.x + 1) / 2) * CANVAS_WIDTH;
  const presentY =
    ((1 - (refClipY * PRESENT_ZOOM + camera.y)) / 2) * CANVAS_HEIGHT;
  const clientX =
    canvasRect.left + (presentX / CANVAS_WIDTH) * canvasRect.width;
  const clientY =
    canvasRect.top + (presentY / CANVAS_HEIGHT) * canvasRect.height;
  return { x: clientX - stageRect.left, y: clientY - stageRect.top };
}

function clamp(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

function workCardPreviewPath(cardId: string, file: string) {
  return `/api/files/preview?path=${encodeURIComponent(`.tmp/photo-flow/${cardId}/${file}`)}`;
}

async function loadWorkCardAssets(cardId: string) {
  const [back, mid, front, meshRes] = await Promise.all([
    loadImage(workCardPreviewPath(cardId, "background.png")),
    loadImage(workCardPreviewPath(cardId, "bikini.png")),
    loadImage(workCardPreviewPath(cardId, "clothes.png")),
    fetch(workCardPreviewPath(cardId, "mesh.json"), { cache: "no-store" }),
  ]);
  if (!meshRes.ok)
    throw new Error(`Work-folder mesh missing (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error(`Invalid work-folder mesh for ${cardId}`);
  return { back, mid, front, mesh, label: `${cardId} (unpublished preview)` };
}

async function loadSampleAssets() {
  const [back, mid, front, meshRes] = await Promise.all([
    loadImage(BACK_LAYER_SRC),
    loadImage(MID_LAYER_SRC),
    loadImage(FRONT_LAYER_SRC),
    fetch(MESH_SRC),
  ]);
  if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
  return { back, mid, front, mesh, label: "Sample assets" };
}

async function loadCardAssets(cardId: string) {
  const cards = await fetchPhotoScratchIndex();
  const entry = cards.find((card) => card.id === cardId);
  if (!entry) throw new Error(`Photo card not found: ${cardId}`);
  const [back, mid, front, meshRes] = await Promise.all([
    loadImage(entry.background),
    loadImage(entry.bikini),
    loadImage(entry.clothes),
    fetch(entry.mesh),
  ]);
  if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error(`Invalid mesh for card ${cardId}`);
  return { back, mid, front, mesh, label: entry.label };
}

async function loadCardAssetsWithFallback(cardId: string) {
  try {
    return await loadCardAssets(cardId);
  } catch (publishedError) {
    try {
      return await loadWorkCardAssets(cardId);
    } catch {
      throw publishedError;
    }
  }
}

function densifyStrokeSegment(
  from: Vec2,
  to: Vec2,
  maxStep: number,
  maxPoints: number,
): Vec2[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxStep) return [from, to];
  const steps = Math.ceil(dist / maxStep);
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  if (points.length <= maxPoints) return points;
  const kept: Vec2[] = [points[0]];
  const lastIndex = points.length - 1;
  for (let i = 1; i < maxPoints - 1; i += 1) {
    const idx = Math.round((i / (maxPoints - 1)) * lastIndex);
    kept.push(points[idx]);
  }
  kept.push(points[lastIndex]);
  return kept;
}

function toGlSample(
  sample: TrackedMeshSample,
  garment: number[] | null = null,
) {
  return {
    cols: sample.cols,
    rows: sample.rows,
    uv: sample.uv,
    verts: sample.verts,
    vis: sample.vis,
    garment,
  };
}

function pxToClipX(px: number, cssWidth: number) {
  return clamp((px / cssWidth) * 2, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
}

function pxToClipY(px: number, cssHeight: number) {
  return clamp((px / cssHeight) * 2, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
}

function groupCamerasFromParallax(
  state: ParallaxState | null,
  cssWidth: number,
  cssHeight: number,
): ImageLayerCameras {
  const group = state?.group ?? { x: 0, y: 0 };
  const cam = {
    x: pxToClipX(group.x, cssWidth),
    y: pxToClipY(group.y, cssHeight),
  };
  return { back: cam, mid: cam, front: cam };
}

function motionStatusLabel(status: string) {
  switch (status) {
    case "active":
      return "motion active";
    case "pending":
      return "requesting…";
    case "denied":
      return "permission denied";
    case "insecure":
      return "needs HTTPS";
    case "unsupported":
      return "unsupported";
    default:
      return "idle";
  }
}

export function PhotoScratchTest() {
  const bgImageRef = useRef<HTMLImageElement>(null);
  const fgCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fgRendererRef = useRef<GarmentGLRenderer | null>(null);
  const trackedMeshRef = useRef<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const backImageRef = useRef<HTMLImageElement | null>(null);
  const midImageRef = useRef<HTMLImageElement | null>(null);
  const frontImageRef = useRef<HTMLImageElement | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const bodyMarkerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const revealedPointsRef = useRef<boolean[]>(
    Array.from({ length: SYMBOL_POINT_COUNT }, () => false),
  );
  const lastScratchWorldRef = useRef<Vec2 | null>(null);
  const isScratchingRef = useRef(false);
  const scratchStartedRef = useRef(false);
  const idleSwayRef = useRef<Vec2>({ x: 0, y: 0 });
  const girlCamRef = useRef<Vec2>({ x: 0, y: 0 });
  const bgBlurRef = useRef(0);
  const bgBrightnessRef = useRef(1);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const parallaxStateRef = useRef<ParallaxState | null>({
    fg: { x: 0, y: 0 },
    bg: { x: 0, y: 0 },
    group: { x: 0, y: 0 },
  });

  const parallax = useDeviceParallax({
    stageRef,
    stateOutRef: parallaxStateRef,
    maxX: PARALLAX_MAX_X,
    maxY: PARALLAX_MAX_Y,
    // Smaller rangeDeg = more travel per degree of tilt (compass feels livelier).
    rangeDeg: 12,
    bgGain: 1.15,
    fingerGain: PARALLAX_FINGER_GAIN,
    fingerMax: PARALLAX_FINGER_MAX,
    fingerMovesGroup: false,
    smooth: 0.12,
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  const [scratchCount, setScratchCount] = useState(0);
  const [isScratching, setIsScratching] = useState(false);
  const [pageOrigin, setPageOrigin] = useState("");
  const [usingSample, setUsingSample] = useState(true);
  const [uploadLabel, setUploadLabel] = useState("Sample assets");
  const [backSrc, setBackSrc] = useState(BACK_LAYER_SRC);
  const [midSrc, setMidSrc] = useState(MID_LAYER_SRC);
  const [frontSrc, setFrontSrc] = useState(FRONT_LAYER_SRC);
  const [showLayerBg, setShowLayerBg] = useState(true);
  const [showLayerMid, setShowLayerMid] = useState(true);
  const [showLayerClothes, setShowLayerClothes] = useState(true);
  const showLayersRef = useRef({
    bg: true,
    mid: true,
    clothes: true,
  });
  showLayersRef.current = {
    bg: showLayerBg,
    mid: showLayerMid,
    clothes: showLayerClothes,
  };
  const [sessionSymbols, setSessionSymbols] =
    useState<number[]>(buildSessionSymbols);
  const [revealedSymbols, setRevealedSymbols] = useState(0);
  const [hasBodySymbols, setHasBodySymbols] = useState(false);

  function trackObjectUrl(url: string) {
    objectUrlsRef.current.push(url);
    return url;
  }

  function revokeObjectUrls() {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
  }

  function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    return loadImage(trackObjectUrl(URL.createObjectURL(file)));
  }

  function applyMesh(mesh: TrackedMesh) {
    trackedMeshRef.current = mesh;
    trackedSampleRef.current = sampleTrackedMesh(mesh, 0);
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_POINT_COUNT },
      () => false,
    );
    setSessionSymbols(buildSessionSymbols());
    setRevealedSymbols(0);
    setHasBodySymbols(mesh.symbolPoints?.length === SYMBOL_POINT_COUNT);
  }

  async function loadAssetsFromSample() {
    revokeObjectUrls();
    const cardId = readCardIdFromLocation();
    const { back, mid, front, mesh, label } = cardId
      ? await loadCardAssetsWithFallback(cardId)
      : await loadSampleAssets();
    backImageRef.current = back;
    midImageRef.current = mid;
    frontImageRef.current = front;
    applyMesh(mesh);
    setBackSrc(back.src);
    setMidSrc(mid.src);
    setFrontSrc(front.src);
    setUsingSample(!cardId);
    setUploadLabel(label);
    setReady(true);
    setLoadError(null);
  }

  async function applyUploadedLayer(
    slot: "back" | "mid" | "front",
    file: File,
  ) {
    const img = await loadImageFromFile(file);
    if (slot === "back") {
      backImageRef.current = img;
      setBackSrc(img.src);
    }
    if (slot === "mid") {
      midImageRef.current = img;
      setMidSrc(img.src);
    }
    if (slot === "front") {
      frontImageRef.current = img;
      setFrontSrc(img.src);
    }
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok)
        throw new Error(`Failed to load mesh (${meshRes.status})`);
      const mesh = parseTrackedMesh(await meshRes.json());
      if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
      applyMesh(mesh);
    }
    setUsingSample(false);
    setUploadLabel(file.name);
    setReady(true);
    resetScratches();
    setLoadError(null);
  }

  async function applyFullPhoto(file: File) {
    revokeObjectUrls();
    const img = await loadImageFromFile(file);
    backImageRef.current = img;
    midImageRef.current = img;
    frontImageRef.current = img;
    setBackSrc(img.src);
    setMidSrc(img.src);
    setFrontSrc(img.src);
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok)
        throw new Error(`Failed to load mesh (${meshRes.status})`);
      const mesh = parseTrackedMesh(await meshRes.json());
      if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
      applyMesh(mesh);
    }
    setUsingSample(false);
    setUploadLabel(file.name);
    resetScratches();
    setReady(true);
    setLoadError(null);
  }

  useEffect(() => {
    setPageOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.setProperty("--bg-base-scale", String(BG_OVERSCAN));
    stage.style.setProperty("--bg-base-x", "0px");
    stage.style.setProperty("--bg-base-y", "0px");
    stage.style.setProperty("--bg-blur", "0px");
    stage.style.setProperty("--bg-brightness", "1");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        await loadAssetsFromSample();
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load assets",
          );
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
      revokeObjectUrls();
    };
  }, []);

  useEffect(() => {
    const fgCanvas = fgCanvasRef.current;
    if (!fgCanvas || !ready) return;

    let fgRenderer: GarmentGLRenderer;
    try {
      fgRenderer = new GarmentGLRenderer(
        fgCanvas,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        {
          alpha: true,
          preserveDrawingBuffer: true,
        },
      );
      fgRendererRef.current = fgRenderer;
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "WebGL2 unavailable",
      );
      return;
    }

    let frameId = 0;
    const render = () => {
      const sample = trackedSampleRef.current;
      const rect = fgCanvas.getBoundingClientRect();
      const cameras = groupCamerasFromParallax(
        parallaxStateRef.current,
        rect.width || CANVAS_WIDTH,
        rect.height || CANVAS_HEIGHT,
      );

      // Synced bikini + clothes idle sway (up/down + diagonal to the right).
      // Active whenever the finger is up — same gentle motion as after load.
      const phase = (performance.now() / IDLE_SWAY_PERIOD_MS) * Math.PI * 2;
      const wantIdle = !isScratchingRef.current;
      const wave = Math.sin(phase);
      // Same phase on X/Y → diagonal; bias X positive so the drift leans right.
      const targetIdleX = wantIdle
        ? wave * IDLE_SWAY_AMP_X + Math.abs(wave) * 1.2
        : 0;
      const targetIdleY = wantIdle ? wave * IDLE_SWAY_AMP_Y : 0;
      const idle = idleSwayRef.current;
      idle.x += (targetIdleX - idle.x) * IDLE_SWAY_EASE;
      idle.y += (targetIdleY - idle.y) * IDLE_SWAY_EASE;

      // Ease girl cam toward center while scratching; ease back to tilt/idle after.
      // Hard-locking to {0,0} felt like a dry snap to the middle.
      const scratching = isScratchingRef.current;
      const liveCam = {
        x: cameras.front.x + pxToClipX(idle.x, rect.width || CANVAS_WIDTH),
        y: cameras.front.y + pxToClipY(idle.y, rect.height || CANVAS_HEIGHT),
      };
      const targetCam = scratching ? { x: 0, y: 0 } : liveCam;
      const girlCam = girlCamRef.current;
      girlCam.x += (targetCam.x - girlCam.x) * GIRL_CAM_EASE;
      girlCam.y += (targetCam.y - girlCam.y) * GIRL_CAM_EASE;
      const groupCam = { x: girlCam.x, y: girlCam.y };

      // Ease room blur + brightness in/out with scratch.
      const blurTarget = scratching ? BG_BLUR_PX : 0;
      const brightnessTarget = scratching ? BG_BRIGHTNESS_DIM : 1;
      bgBlurRef.current += (blurTarget - bgBlurRef.current) * BG_FX_EASE;
      bgBrightnessRef.current +=
        (brightnessTarget - bgBrightnessRef.current) * BG_FX_EASE;
      if (stageRef.current) {
        stageRef.current.style.setProperty(
          "--bg-blur",
          `${bgBlurRef.current.toFixed(2)}px`,
        );
        stageRef.current.style.setProperty(
          "--bg-brightness",
          bgBrightnessRef.current.toFixed(3),
        );
      }

      const layers = showLayersRef.current;
      fgRenderer.renderPhotoForeground(
        layers.mid ? midImageRef.current : null,
        layers.clothes ? frontImageRef.current : null,
        sample
          ? toGlSample(sample, trackedMeshRef.current?.garment ?? null)
          : null,
        showMesh,
        groupCam,
        FOREGROUND_CHROMA,
      );

      // Pin revealed Lottie symbols to their mesh-UV anchors.
      const bodyPoints = trackedMeshRef.current?.symbolPoints;
      const stage = stageRef.current;
      if (
        bodyPoints &&
        bodyPoints.length === SYMBOL_POINT_COUNT &&
        sample &&
        stage
      ) {
        const frontCam = fgRenderer.getFrontPresentCamera();
        for (let index = 0; index < SYMBOL_POINT_COUNT; index += 1) {
          const marker = bodyMarkerRefs.current[index];
          if (!marker) continue;
          const revealed = revealedPointsRef.current[index];
          const world = sampleMeshUvToWorld(
            sample,
            bodyPoints[index].u,
            bodyPoints[index].v,
          );
          const stagePos = worldPointToStage(world, fgCanvas, stage, frontCam);
          marker.style.display = revealed ? "flex" : "none";
          marker.style.transform = `translate(${stagePos.x}px, ${stagePos.y}px)`;
          marker.classList.toggle("is-revealed", revealed);
        }
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      fgRendererRef.current = null;
    };
  }, [ready, showMesh]);

  useEffect(() => {
    const fgCanvas = fgCanvasRef.current;
    if (!fgCanvas || !ready) return;

    const blockTouchScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    fgCanvas.addEventListener("touchstart", blockTouchScroll, {
      passive: false,
    });
    fgCanvas.addEventListener("touchmove", blockTouchScroll, {
      passive: false,
    });

    return () => {
      fgCanvas.removeEventListener("touchstart", blockTouchScroll);
      fgCanvas.removeEventListener("touchmove", blockTouchScroll);
    };
  }, [ready]);

  function getCanvasPoint(clientX: number, clientY: number): Vec2 | null {
    const canvas = fgCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const presentX = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const presentY = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    const frontCam = fgRendererRef.current?.getFrontPresentCamera() ?? {
      x: 0,
      y: 0,
    };
    const refClipX =
      ((presentX / CANVAS_WIDTH) * 2 - 1 - frontCam.x) / PRESENT_ZOOM;
    const refClipY =
      (1 - (presentY / CANVAS_HEIGHT) * 2 - frontCam.y) / PRESENT_ZOOM;
    return {
      x: ((refClipX + 1) / 2) * CANVAS_WIDTH,
      y: ((1 - refClipY) / 2) * CANVAS_HEIGHT,
    };
  }

  function applyScratchAtUv(u: number, v: number, radius: number) {
    marksRef.current = [...marksRef.current, { u, v, radius }].slice(-180);
    fgRendererRef.current?.paintScratch(u, v, radius);
    setScratchCount(marksRef.current.length);

    const bodyPoints = trackedMeshRef.current?.symbolPoints;
    if (!bodyPoints || bodyPoints.length !== SYMBOL_POINT_COUNT) return;
    let changed = false;
    for (let index = 0; index < bodyPoints.length; index += 1) {
      if (revealedPointsRef.current[index]) continue;
      const distance = Math.hypot(
        u - bodyPoints[index].u,
        v - bodyPoints[index].v,
      );
      if (distance <= SYMBOL_REVEAL_UV_RADIUS) {
        revealedPointsRef.current[index] = true;
        changed = true;
      }
    }
    if (changed) {
      setRevealedSymbols(revealedPointsRef.current.filter(Boolean).length);
    }
  }

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    const sample = trackedSampleRef.current;
    if (!point || !sample) return;

    const last = lastScratchWorldRef.current;
    const strokePoints =
      last !== null
        ? densifyStrokeSegment(
            last,
            point,
            MANUAL_SCRATCH_PATH_STEP,
            MANUAL_SCRATCH_MAX_POINTS,
          )
        : [point];

    let applied = false;
    for (const strokePoint of strokePoints) {
      const uv = trackedWorldToUv(sample, strokePoint);
      if (!uv) continue;
      applyScratchAtUv(uv.x, uv.y, SCRATCH_RADIUS);
      applied = true;
    }
    if (applied) lastScratchWorldRef.current = point;
  }

  function resetScratches() {
    marksRef.current = [];
    lastScratchWorldRef.current = null;
    scratchStartedRef.current = false;
    idleSwayRef.current = { x: 0, y: 0 };
    fgRendererRef.current?.clearScratch();
    setScratchCount(0);
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_POINT_COUNT },
      () => false,
    );
    setSessionSymbols(buildSessionSymbols());
    setRevealedSymbols(0);
  }

  async function enableMotion() {
    const ok = await parallax.requestPermission();
    if (!ok) {
      if (parallax.isInsecure) {
        setLoadError(
          "Open https:// on your phone (not http://) and accept the certificate warning.",
        );
      } else if (parallax.isDenied) {
        setLoadError(
          "Motion permission denied — allow Motion & Orientation in Safari settings.",
        );
      } else {
        setLoadError("Could not enable motion sensors.");
      }
      return;
    }
    setLoadError(null);
  }

  function trackFingerParallax(clientX: number, clientY: number) {
    const last = lastPointerRef.current;
    lastPointerRef.current = { x: clientX, y: clientY };
    if (!last) return;
    parallax.addFingerDelta(clientX - last.x, clientY - last.y);
  }

  function onPointerDown(clientX: number, clientY: number) {
    isScratchingRef.current = true;
    scratchStartedRef.current = true;
    setIsScratching(true);
    lastScratchWorldRef.current = null;
    lastPointerRef.current = { x: clientX, y: clientY };
    addScratch(clientX, clientY);
  }

  function onPointerMove(clientX: number, clientY: number) {
    trackFingerParallax(clientX, clientY);
    if (!isScratchingRef.current) return;
    addScratch(clientX, clientY);
  }

  function onPointerUp() {
    isScratchingRef.current = false;
    setIsScratching(false);
    lastScratchWorldRef.current = null;
    lastPointerRef.current = null;
    parallax.releaseFinger();
  }

  const parallaxState = parallaxStateRef.current;

  return (
    <main className="app-shell photo-scratch-page">
      <section className="prototype photo-scratch-prototype">
        <aside className="panel photo-scratch-panel">
          <header className="photo-scratch-header">
            <h1>Photo scratch test</h1>
            <p>
              Upload pictures, scratch the clothes layer, and drag or tilt to
              move the scene.
            </p>
          </header>

          <section className="photo-scratch-flow" aria-label="Scratch flow">
            <h2>Flow</h2>
            <ol>
              <li>
                Upload background, bikini, and clothes — or open with{" "}
                <code>?card=</code>.
              </li>
              <li>Click and drag on the canvas to scratch the clothes off.</li>
              <li>Tap Enable motion for tilt parallax (top bar on phone).</li>
            </ol>
          </section>

          <section
            className="photo-scratch-uploads"
            aria-label="Make from picture"
          >
            <h2>Make from picture</h2>
            <p className="photo-scratch-upload-note">
              Current: <strong>{uploadLabel}</strong>
              {usingSample ? " (room + separated bikini/clothes PNGs)" : ""}
            </p>
            <div className="photo-scratch-upload-grid">
              <label className="photo-scratch-upload-field">
                <span>Full photo (quick test)</span>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyFullPhoto(file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Background</span>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("back", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Reveal (bikini)</span>
                <input
                  accept="image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("mid", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Scratch layer (clothes)</span>
                <input
                  accept="image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("front", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
            </div>
            <button
              type="button"
              className="photo-scratch-sample-btn"
              onClick={() => {
                void loadAssetsFromSample()
                  .then(() => resetScratches())
                  .catch((error) => {
                    setLoadError(
                      error instanceof Error
                        ? error.message
                        : "Failed to load sample",
                    );
                  });
              }}
            >
              Load sample assets
            </button>
          </section>

          <section
            className="photo-scratch-layers"
            aria-label="Layer stack"
          >
            <h2>Layers</h2>
            <p className="photo-scratch-upload-note">
              Stack bottom → top. Toggle one off to see what sits underneath.
            </p>
            <div className="photo-scratch-layer-grid">
              {(
                [
                  {
                    id: "bg",
                    label: "1. Background",
                    hint: "room",
                    src: backSrc,
                    on: showLayerBg,
                    set: setShowLayerBg,
                  },
                  {
                    id: "mid",
                    label: "2. Bikini",
                    hint: "mid / reveal",
                    src: midSrc,
                    on: showLayerMid,
                    set: setShowLayerMid,
                  },
                  {
                    id: "clothes",
                    label: "3. Clothes",
                    hint: "top / scratch",
                    src: frontSrc,
                    on: showLayerClothes,
                    set: setShowLayerClothes,
                  },
                ] as const
              ).map((layer) => (
                <label
                  key={layer.id}
                  className={`photo-scratch-layer-card${layer.on ? " is-on" : " is-off"}`}
                >
                  <span className="photo-scratch-layer-thumb">
                    <img src={layer.src} alt="" draggable={false} />
                  </span>
                  <span className="photo-scratch-layer-meta">
                    <span className="photo-scratch-layer-title">
                      {layer.label}
                    </span>
                    <span className="photo-scratch-layer-hint">{layer.hint}</span>
                    <span className="photo-scratch-layer-toggle">
                      <input
                        type="checkbox"
                        checked={layer.on}
                        onChange={(event) => layer.set(event.target.checked)}
                      />
                      {layer.on ? "visible" : "hidden"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="photo-scratch-layer-actions">
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(true);
                  setShowLayerMid(true);
                  setShowLayerClothes(true);
                }}
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(true);
                  setShowLayerMid(false);
                  setShowLayerClothes(false);
                }}
              >
                Solo bg
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(false);
                  setShowLayerMid(true);
                  setShowLayerClothes(false);
                }}
              >
                Solo bikini
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(false);
                  setShowLayerMid(false);
                  setShowLayerClothes(true);
                }}
              >
                Solo clothes
              </button>
            </div>
          </section>

          <div className="photo-scratch-controls">
            {parallax.showEnableButton ? (
              <button
                type="button"
                onClick={() => void enableMotion()}
                disabled={parallax.isPending}
              >
                {parallax.isPending ? "Enabling…" : "Enable motion"}
              </button>
            ) : null}
            {parallax.isActive ? (
              <button type="button" onClick={() => parallax.recalibrate()}>
                Recalibrate
              </button>
            ) : null}
            <button type="button" onClick={() => setShowMesh((v) => !v)}>
              {showMesh ? "Hide mesh" : "Mesh"}
            </button>
            <button type="button" onClick={resetScratches}>
              Reset scratches
            </button>
            <span className="photo-scratch-count">Marks: {scratchCount}</span>
            {hasBodySymbols ? (
              <span className="photo-scratch-count">
                Symbols: {revealedSymbols}/{SYMBOL_POINT_COUNT}
              </span>
            ) : null}
          </div>

          {loadError ? (
            <p className="photo-scratch-error">{loadError}</p>
          ) : null}

          <div className="photo-scratch-meta">
            <div>
              Phone URL:{" "}
              <code>{pageOrigin ? `${pageOrigin}/photo-scratch` : "…"}</code>
            </div>
            <div>
              Parallax: {motionStatusLabel(parallax.status)} · secure:{" "}
              {typeof window !== "undefined" && window.isSecureContext
                ? "yes"
                : "no"}
            </div>
            {parallax.isActive && parallaxState ? (
              <div>
                group ({parallaxState.group.x.toFixed(1)},{" "}
                {parallaxState.group.y.toFixed(1)})
              </div>
            ) : null}
            {parallax.isInsecure ? (
              <div className="photo-scratch-warn">
                Motion needs HTTPS on your phone.
              </div>
            ) : null}
          </div>
        </aside>

        <div
          ref={stageRef}
          className={`stage photo-scratch-stage${ready ? " is-ready" : ""}${isScratching ? " is-finger-dragging is-scratching" : ""}${showLayerBg ? "" : " is-bg-hidden"}`}
        >
          <div
            className={`bg-drag-scale${isScratching ? " is-bg-blurred" : ""}`}
            aria-hidden="true"
          >
            <img
              ref={bgImageRef}
              className="layer-bg photo-scratch-bg-layer"
              src={backSrc}
              alt=""
              draggable={false}
            />
          </div>
          <div className="photo-scratch-fg-drag-scale">
            <canvas
              ref={fgCanvasRef}
              className="photo-scratch-fg-layer"
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              style={{ touchAction: "none", cursor: "crosshair" }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                onPointerDown(event.clientX, event.clientY);
              }}
              onPointerMove={(event) => {
                event.preventDefault();
                onPointerMove(event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                onPointerUp();
              }}
              onPointerCancel={onPointerUp}
            />
            {hasBodySymbols
              ? sessionSymbols.map((typeId, index) => (
                  <div
                    key={`body-symbol-${index}`}
                    ref={(el) => {
                      bodyMarkerRefs.current[index] = el;
                    }}
                    className="body-symbol-marker"
                    style={{ display: "none" }}
                  >
                    <span className="body-symbol-icon">
                      <GameSymbolIcon typeId={typeId} size={42} />
                    </span>
                  </div>
                ))
              : null}
          </div>
        </div>
      </section>
    </main>
  );
}
