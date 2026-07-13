import { useEffect, useRef, useState } from "react";
import { GarmentGLRenderer, PRESENT_ZOOM, type ImageLayerCameras } from "./glRenderer";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  parseTrackedMesh,
  sampleTrackedMesh,
  trackedWorldToUv,
  type TrackedMesh,
  type TrackedMeshSample,
  type Vec2,
} from "./meshGeometry";
import { useDeviceParallax, type ParallaxState } from "./useDeviceParallax";

const BACK_LAYER_SRC = "/photo-scratch/background-square.png";
const MID_LAYER_SRC = "/photo-scratch/bikini.png";
const FRONT_LAYER_SRC = "/photo-scratch/clothes.png";
const MESH_SRC = "/photo-scratch/mesh.json";

const SCRATCH_RADIUS = 0.045;
const MANUAL_SCRATCH_PATH_STEP = SCRATCH_RADIUS * 0.65 * CANVAS_HEIGHT;
const MANUAL_SCRATCH_MAX_POINTS = 40;
const FOREGROUND_CHROMA = false;
// Room bg needs extra overscan beyond PRESENT_ZOOM so tilt + finger parallax
// never reveals the stage letterboxing.
const PARALLAX_MAX_X = 22;
const PARALLAX_MAX_Y = 16;
const PARALLAX_FINGER_MAX = 20;
const BG_OVERSCAN = Math.max(
  PRESENT_ZOOM,
  1 + (2 * (PARALLAX_MAX_X + PARALLAX_FINGER_MAX)) / CANVAS_WIDTH,
  1 + (2 * (PARALLAX_MAX_Y + PARALLAX_FINGER_MAX)) / CANVAS_HEIGHT,
);
const BG_SCRATCH_ZOOM = 1.03;

type ScratchMark = { u: number; v: number; radius: number };

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
  return { back, mid, front, mesh };
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

function toGlSample(sample: TrackedMeshSample) {
  return {
    cols: sample.cols,
    rows: sample.rows,
    uv: sample.uv,
    verts: sample.verts,
    vis: sample.vis,
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
  const lastScratchWorldRef = useRef<Vec2 | null>(null);
  const isScratchingRef = useRef(false);
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
    rangeDeg: 16,
    bgGain: 1,
    fingerGain: 0.2,
    fingerMax: PARALLAX_FINGER_MAX,
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
  }

  async function loadAssetsFromSample() {
    revokeObjectUrls();
    const { back, mid, front, mesh } = await loadSampleAssets();
    backImageRef.current = back;
    midImageRef.current = mid;
    frontImageRef.current = front;
    applyMesh(mesh);
    setBackSrc(BACK_LAYER_SRC);
    setUsingSample(true);
    setUploadLabel("Sample assets");
    setReady(true);
    setLoadError(null);
  }

  async function applyUploadedLayer(slot: "back" | "mid" | "front", file: File) {
    const img = await loadImageFromFile(file);
    if (slot === "back") {
      backImageRef.current = img;
      setBackSrc(img.src);
    }
    if (slot === "mid") midImageRef.current = img;
    if (slot === "front") frontImageRef.current = img;
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
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
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
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
    let cancelled = false;

    async function boot() {
      try {
        await loadAssetsFromSample();
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load assets");
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
      fgRenderer = new GarmentGLRenderer(fgCanvas, CANVAS_WIDTH, CANVAS_HEIGHT, {
        alpha: true,
        preserveDrawingBuffer: true,
      });
      fgRendererRef.current = fgRenderer;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "WebGL2 unavailable");
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
      const groupCam = cameras.front;
      const group = parallaxStateRef.current?.group ?? { x: 0, y: 0 };
      const bgImg = bgImageRef.current;
      if (bgImg) {
        const bgScale = BG_OVERSCAN * (isScratchingRef.current ? BG_SCRATCH_ZOOM : 1);
        bgImg.style.transform = `translate(calc(-50% + ${group.x}px), calc(-50% + ${group.y}px)) scale(${bgScale})`;
      }

      fgRenderer.renderPhotoForeground(
        midImageRef.current,
        frontImageRef.current,
        sample ? toGlSample(sample) : null,
        showMesh,
        groupCam,
        FOREGROUND_CHROMA,
      );
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
    fgCanvas.addEventListener("touchstart", blockTouchScroll, { passive: false });
    fgCanvas.addEventListener("touchmove", blockTouchScroll, { passive: false });

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
    const frontCam = fgRendererRef.current?.getFrontPresentCamera() ?? { x: 0, y: 0 };
    const refClipX = ((presentX / CANVAS_WIDTH) * 2 - 1 - frontCam.x) / PRESENT_ZOOM;
    const refClipY = (1 - (presentY / CANVAS_HEIGHT) * 2 - frontCam.y) / PRESENT_ZOOM;
    return {
      x: ((refClipX + 1) / 2) * CANVAS_WIDTH,
      y: ((1 - refClipY) / 2) * CANVAS_HEIGHT,
    };
  }

  function applyScratchAtUv(u: number, v: number, radius: number) {
    marksRef.current = [...marksRef.current, { u, v, radius }].slice(-180);
    fgRendererRef.current?.paintScratch(u, v, radius);
    setScratchCount(marksRef.current.length);
  }

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    const sample = trackedSampleRef.current;
    if (!point || !sample) return;

    const last = lastScratchWorldRef.current;
    const strokePoints =
      last !== null
        ? densifyStrokeSegment(last, point, MANUAL_SCRATCH_PATH_STEP, MANUAL_SCRATCH_MAX_POINTS)
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
    fgRendererRef.current?.clearScratch();
    setScratchCount(0);
  }

  async function enableMotion() {
    const ok = await parallax.requestPermission();
    if (!ok) {
      if (parallax.isInsecure) {
        setLoadError("Open https:// on your phone (not http://) and accept the certificate.");
      } else if (parallax.isDenied) {
        setLoadError("Motion permission denied — allow Motion & Orientation in Safari settings.");
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
              Upload pictures, scratch the clothes layer, and drag or tilt to move
              the scene.
            </p>
          </header>

          <section className="photo-scratch-flow" aria-label="Scratch flow">
            <h2>Flow</h2>
            <ol>
              <li>Upload a background, reveal, and clothes picture — or use the sample.</li>
              <li>Click and drag on the canvas to scratch the clothes off.</li>
              <li>While scratching, the background blurs slightly. Drag for finger parallax.</li>
              <li>On phone, enable motion for tilt parallax.</li>
            </ol>
          </section>

          <section className="photo-scratch-uploads" aria-label="Make from picture">
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
                      setLoadError(error instanceof Error ? error.message : "Upload failed");
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
                      setLoadError(error instanceof Error ? error.message : "Upload failed");
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
                      setLoadError(error instanceof Error ? error.message : "Upload failed");
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
                      setLoadError(error instanceof Error ? error.message : "Upload failed");
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
                    setLoadError(error instanceof Error ? error.message : "Failed to load sample");
                  });
              }}
            >
              Load sample assets
            </button>
          </section>

          <div className="photo-scratch-controls">
            <a href="/">Back</a>
            {parallax.showEnableButton ? (
              <button type="button" onClick={() => void enableMotion()} disabled={parallax.isPending}>
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
          </div>

          {loadError ? <p className="photo-scratch-error">{loadError}</p> : null}

          <div className="photo-scratch-meta">
            <div>
              Phone URL: <code>{pageOrigin ? `${pageOrigin}/photo-scratch` : "…"}</code>
            </div>
            <div>
              Parallax: {motionStatusLabel(parallax.status)} · secure:{" "}
              {typeof window !== "undefined" && window.isSecureContext ? "yes" : "no"}
            </div>
            {parallax.isActive && parallaxState ? (
              <div>
                group ({parallaxState.group.x.toFixed(1)}, {parallaxState.group.y.toFixed(1)})
              </div>
            ) : null}
            {parallax.isInsecure ? (
              <div className="photo-scratch-warn">Motion needs HTTPS on your phone.</div>
            ) : null}
          </div>
        </aside>

        <div
          ref={stageRef}
          className={`stage photo-scratch-stage${isScratching ? " is-scratching" : ""}`}
        >
          <img
            ref={bgImageRef}
            className="photo-scratch-bg-layer"
            src={backSrc}
            alt=""
            draggable={false}
          />
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
        </div>
      </section>
    </main>
  );
}
