import {
  AlertTriangle,
  ExternalLink,
  FileUp,
  Image,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  Square,
  Video,
  WandSparkles,
  Workflow,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Container,
  Flex,
  Grid,
  Heading,
  ScrollArea,
  Select,
  Separator,
  Table,
  Tabs,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type CardInfo = {
  id: string;
  label: string;
  background: string;
  foreground: string;
  mesh: string;
  has_mesh: boolean;
};

type MeshInfo = {
  file: string;
  path: string;
  source?: string | null;
  tracker?: string | null;
  generator?: string | null;
  frames?: number | null;
  cols?: number | null;
  rows?: number | null;
  size_bytes: number;
  modified_at: number;
};

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  return_code?: number | null;
  logs: string[];
};

type AssetsResponse = {
  cards: CardInfo[];
  meshes: MeshInfo[];
};

type UploadedFileInfo = {
  path: string;
  size_bytes: number;
};

type HealthResponse = {
  ok: boolean;
  root: string;
  env_files: Record<string, boolean>;
  xai_key_loaded: boolean;
  ffmpeg_available: boolean;
  python: string;
};

type TrackedMeshFrame = {
  t: number;
  verts: [number, number][];
  vis?: number[];
};

type TrackedMeshPreviewData = {
  canvas?: {
    width?: number;
    height?: number;
  };
  mesh?: {
    cols?: number;
    rows?: number;
  };
  frames?: TrackedMeshFrame[];
};

const TRACKERS = ["bootstapir", "cotracker", "blend"] as const;
const iconProps = {
  "aria-hidden": true,
  size: 16,
  strokeWidth: 2.25,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function uploadFile(file: File): Promise<UploadedFileInfo> {
  const response = await fetch("/api/files/upload", {
    method: "POST",
    body: file,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<UploadedFileInfo>;
}

function formatBytes(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function statusLabel(status: JobInfo["status"]) {
  if (status === "succeeded") return "Done";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  return "Queued";
}

function statusColor(status: JobInfo["status"]): "blue" | "green" | "gray" | "orange" | "red" {
  if (status === "succeeded") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "gray";
  if (status === "running") return "blue";
  return "orange";
}

function previewSource(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return trimmed;
  }
  return `/api/files/preview?path=${encodeURIComponent(trimmed)}`;
}

function MediaPreview({
  label,
  size = "normal",
  type,
  value,
}: {
  label: string;
  size?: "compact" | "normal";
  type: "image" | "video";
  value: string;
}) {
  const src = previewSource(value);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (!src || hasError) return null;

  return (
    <Box className={`dashboard-preview${size === "compact" ? " dashboard-preview--compact" : ""}`}>
      <Flex
        align="center"
        justify="between"
        mb="2"
      >
        <Text
          color="gray"
          size="1"
          weight="bold"
        >
          {label}
        </Text>
        <Badge color="gray" variant="soft">
          {type}
        </Badge>
      </Flex>
      {type === "image" ? (
        <img
          alt={label}
          className={`dashboard-preview-media${size === "compact" ? " dashboard-preview-media--compact" : ""}`}
          onError={() => setHasError(true)}
          src={src}
        />
      ) : (
        <video
          className="dashboard-preview-media"
          controls
          muted
          onError={() => setHasError(true)}
          playsInline
          preload="metadata"
          src={src}
        />
      )}
    </Box>
  );
}

function frameForTime(frames: TrackedMeshFrame[], time: number) {
  if (frames.length === 0) return null;
  const lastTime = frames[frames.length - 1]?.t ?? 0;
  const target = lastTime > 0 ? time % lastTime : time;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((frames[mid]?.t ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  const current = frames[lo];
  const previous = frames[Math.max(0, lo - 1)];
  if (!current) return previous ?? null;
  if (!previous) return current;
  return Math.abs(previous.t - target) < Math.abs(current.t - target) ? previous : current;
}

function MeshOverlayPreview({
  label,
  mesh,
  value,
}: {
  label: string;
  mesh: string;
  value: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const src = previewSource(value);
  const meshSrc = previewSource(mesh);
  const [hasVideoError, setHasVideoError] = useState(false);
  const [meshData, setMeshData] = useState<TrackedMeshPreviewData | null>(null);
  const [meshError, setMeshError] = useState("");

  useEffect(() => {
    setHasVideoError(false);
  }, [src]);

  useEffect(() => {
    let cancelled = false;
    setMeshData(null);
    setMeshError("");
    if (!meshSrc) return undefined;

    fetch(meshSrc)
      .then((response) => {
        if (!response.ok) throw new Error(`Mesh not available (${response.status})`);
        return response.json() as Promise<TrackedMeshPreviewData>;
      })
      .then((data) => {
        if (!cancelled) setMeshData(data);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setMeshError(caught instanceof Error ? caught.message : String(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [meshSrc]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const frames = meshData?.frames ?? [];
    const cols = meshData?.mesh?.cols ?? 0;
    const rows = meshData?.mesh?.rows ?? 0;
    if (!video || !canvas || frames.length === 0 || cols <= 1 || rows <= 1) return undefined;

    const activeVideo = video;
    const activeCanvas = canvas;
    const width = meshData?.canvas?.width ?? 390;
    const height = meshData?.canvas?.height ?? 672;
    activeCanvas.width = width;
    activeCanvas.height = height;
    const context = activeCanvas.getContext("2d");
    if (!context) return undefined;
    const ctx = context;

    let raf = 0;

    function fitMeshToVideo() {
      const renderedWidth = activeCanvas.clientWidth;
      const renderedHeight = activeCanvas.clientHeight;
      const videoWidth = activeVideo.videoWidth || width;
      const videoHeight = activeVideo.videoHeight || height;
      const meshAspect = width / height;
      const videoAspect = videoWidth / videoHeight;
      const scale = videoAspect > meshAspect ? width / videoWidth : height / videoHeight;
      const fittedMeshWidth = videoWidth * scale;
      const fittedMeshHeight = videoHeight * scale;
      const offsetX = (width - fittedMeshWidth) / 2;
      const offsetY = (height - fittedMeshHeight) / 2;
      const renderScaleX = renderedWidth / width;
      const renderScaleY = renderedHeight / height;
      return {
        height: fittedMeshHeight * renderScaleY,
        offsetX: offsetX * renderScaleX,
        offsetY: offsetY * renderScaleY,
        scaleX: scale * renderScaleX,
        scaleY: scale * renderScaleY,
        width: fittedMeshWidth * renderScaleX,
      };
    }

    function isVisible(frame: TrackedMeshFrame, index: number) {
      return !frame.vis || frame.vis[index] !== 0;
    }

    function drawLine(frame: TrackedMeshFrame, from: number, to: number) {
      if (!isVisible(frame, from) || !isVisible(frame, to)) return;
      const a = frame.verts[from];
      const b = frame.verts[to];
      if (!a || !b) return;
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }

    function draw() {
      const frame = frameForTime(frames, activeVideo.currentTime);
      const fit = fitMeshToVideo();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (frame) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(fit.offsetX, fit.offsetY, fit.width, fit.height);
        ctx.clip();
        ctx.setTransform(fit.scaleX, 0, 0, fit.scaleY, fit.offsetX, fit.offsetY);
        ctx.lineWidth = 0.85;
        ctx.strokeStyle = "rgba(0, 220, 255, 0.52)";
        ctx.beginPath();
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const index = row * cols + col;
            if (col < cols - 1) drawLine(frame, index, index + 1);
            if (row < rows - 1) drawLine(frame, index, index + cols);
          }
        }
        ctx.stroke();

        ctx.fillStyle = "rgba(0, 205, 255, 0.95)";
        for (let index = 0; index < frame.verts.length; index += 1) {
          if (!isVisible(frame, index)) continue;
          const vert = frame.verts[index];
          if (!vert) continue;
          ctx.beginPath();
          ctx.arc(vert[0], vert[1], 1.75, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (!activeVideo.paused && !activeVideo.ended) raf = window.requestAnimationFrame(draw);
    }

    const start = () => {
      window.cancelAnimationFrame(raf);
      draw();
    };
    const stop = () => {
      window.cancelAnimationFrame(raf);
      draw();
    };

    activeVideo.addEventListener("loadeddata", draw);
    activeVideo.addEventListener("timeupdate", draw);
    activeVideo.addEventListener("play", start);
    activeVideo.addEventListener("pause", stop);
    activeVideo.addEventListener("seeked", draw);
    draw();

    return () => {
      window.cancelAnimationFrame(raf);
      activeVideo.removeEventListener("loadeddata", draw);
      activeVideo.removeEventListener("timeupdate", draw);
      activeVideo.removeEventListener("play", start);
      activeVideo.removeEventListener("pause", stop);
      activeVideo.removeEventListener("seeked", draw);
    };
  }, [meshData]);

  if (!src) return null;

  return (
    <Box className="dashboard-preview">
      <Flex
        align="center"
        justify="between"
        mb="2"
      >
        <Text
          color="gray"
          size="1"
          weight="bold"
        >
          {label}
        </Text>
        <Badge color={meshError ? "orange" : "cyan"} variant="soft">
          {meshError ? "mesh missing" : "mesh"}
        </Badge>
      </Flex>
      {hasVideoError ? (
        <Flex
          align="center"
          className="dashboard-preview-empty dashboard-preview-empty--mesh"
          justify="center"
        >
          <Text
            color="gray"
            size="2"
            weight="medium"
          >
            Preview not available yet
          </Text>
        </Flex>
      ) : (
        <Box className="dashboard-mesh-stack">
          <video
            ref={videoRef}
            className="dashboard-preview-media dashboard-preview-media--mesh"
            controls
            muted
            onError={() => setHasVideoError(true)}
            playsInline
            preload="metadata"
            src={src}
          />
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="dashboard-mesh-canvas"
          />
        </Box>
      )}
      {meshError ? (
        <Text
          as="div"
          color="orange"
          mt="2"
          size="1"
          weight="medium"
        >
          {meshError}
        </Text>
      ) : null}
    </Box>
  );
}

type GarmentMeshData = TrackedMeshPreviewData & {
  garment?: number[] | null;
};

function coverFit(videoWidth: number, videoHeight: number, width: number, height: number) {
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  return {
    dx: (width - drawWidth) / 2,
    dy: (height - drawHeight) / 2,
    dw: drawWidth,
    dh: drawHeight,
  };
}

/**
 * Paint-the-mask editor. The app stores scratchability as a static per-vertex
 * `garment` array; here the operator scrubs the clip to a pose (e.g. arm raised,
 * or to expose the neck), then paints/erases the vertices that sit on the fabric
 * in that frame. Because vertices are drawn at their tracked positions for the
 * current frame, painting a raised arm marks exactly the cells that will be
 * under the finger when the arm is raised in the prototype.
 */
function MaskEditor({
  cards,
  selectedCardId,
  onSelectCard,
  onSaved,
  onError,
}: {
  cards: CardInfo[];
  selectedCardId: string;
  onSelectCard: (value: string) => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const card = useMemo(
    () => cards.find((entry) => entry.id === selectedCardId) ?? cards[0],
    [cards, selectedCardId],
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const garmentRef = useRef<Uint8Array | null>(null);
  const framesRef = useRef<TrackedMeshFrame[]>([]);
  const dimsRef = useRef({ cols: 0, rows: 0, width: 390, height: 672 });
  const brushRef = useRef({ mode: "add" as "add" | "erase", radius: 26 });
  const drawingRef = useRef(false);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  const [meshReady, setMeshReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [coverage, setCoverage] = useState({ on: 0, total: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [brushMode, setBrushMode] = useState<"add" | "erase">("add");
  const [brushRadius, setBrushRadius] = useState(26);
  const [playing, setPlaying] = useState(false);

  const meshFile = card?.mesh ?? "";
  const videoSrc = card ? previewSource(card.foreground) : "";
  const meshSrc = meshFile ? previewSource(`public/mesh/${meshFile}`) : "";

  useEffect(() => {
    brushRef.current.mode = brushMode;
  }, [brushMode]);
  useEffect(() => {
    brushRef.current.radius = brushRadius;
  }, [brushRadius]);

  function recomputeCoverage() {
    const garment = garmentRef.current;
    if (!garment) return;
    let on = 0;
    for (let i = 0; i < garment.length; i += 1) on += garment[i];
    setCoverage({ on, total: garment.length });
  }

  // Load the mesh JSON (geometry + current garment mask) for the selected card.
  useEffect(() => {
    let cancelled = false;
    setMeshReady(false);
    setLoadError("");
    setSaveMsg("");
    setDirty(false);
    garmentRef.current = null;
    framesRef.current = [];
    if (!meshSrc) return undefined;

    // Cache-bust so the editor always edits the latest on-disk mask (the backend
    // FileResponse can otherwise be served from the browser cache, losing edits).
    const freshSrc = `${meshSrc}${meshSrc.includes("?") ? "&" : "?"}v=${Date.now()}`;
    fetch(freshSrc, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Mesh not available (${response.status})`);
        return response.json() as Promise<GarmentMeshData>;
      })
      .then((data) => {
        if (cancelled) return;
        const cols = data.mesh?.cols ?? 0;
        const rows = data.mesh?.rows ?? 0;
        const total = cols * rows;
        if (total <= 0 || !data.frames || data.frames.length === 0) {
          throw new Error("Mesh has no grid or frames");
        }
        const garment = new Uint8Array(total);
        if (Array.isArray(data.garment) && data.garment.length === total) {
          for (let i = 0; i < total; i += 1) garment[i] = data.garment[i] ? 1 : 0;
        } else {
          // No mask yet — start fully scratchable so the operator carves it down.
          garment.fill(1);
        }
        garmentRef.current = garment;
        framesRef.current = data.frames;
        dimsRef.current = {
          cols,
          rows,
          width: data.canvas?.width ?? 390,
          height: data.canvas?.height ?? 672,
        };
        setMeshReady(true);
        recomputeCoverage();
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [meshSrc]);

  // Render loop: video (cover-fit) + scratchable cells + grid + vertices + brush.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !meshReady) return undefined;
    const { cols, rows, width, height } = dimsRef.current;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let raf = 0;

    const draw = () => {
      const frames = framesRef.current;
      const garment = garmentRef.current;
      ctx.clearRect(0, 0, width, height);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const fit = coverFit(video.videoWidth, video.videoHeight, width, height);
        try {
          ctx.drawImage(video, fit.dx, fit.dy, fit.dw, fit.dh);
        } catch {
          /* frame not ready */
        }
      }
      const frame = frameForTime(frames, video.currentTime);
      if (frame && garment) {
        const on = (index: number) => garment[index] === 1;
        // Fill scratchable cells (all four corners painted on).
        ctx.fillStyle = "rgba(34, 220, 130, 0.30)";
        for (let row = 0; row < rows - 1; row += 1) {
          for (let col = 0; col < cols - 1; col += 1) {
            const tl = row * cols + col;
            const tr = tl + 1;
            const bl = tl + cols;
            const br = bl + 1;
            if (!(on(tl) && on(tr) && on(bl) && on(br))) continue;
            const a = frame.verts[tl];
            const b = frame.verts[tr];
            const c = frame.verts[br];
            const d = frame.verts[bl];
            if (!a || !b || !c || !d) continue;
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.lineTo(c[0], c[1]);
            ctx.lineTo(d[0], d[1]);
            ctx.closePath();
            ctx.fill();
          }
        }
        // Faint grid.
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.beginPath();
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const index = row * cols + col;
            const here = frame.verts[index];
            if (!here) continue;
            if (col < cols - 1) {
              const right = frame.verts[index + 1];
              if (right) {
                ctx.moveTo(here[0], here[1]);
                ctx.lineTo(right[0], right[1]);
              }
            }
            if (row < rows - 1) {
              const down = frame.verts[index + cols];
              if (down) {
                ctx.moveTo(here[0], here[1]);
                ctx.lineTo(down[0], down[1]);
              }
            }
          }
        }
        ctx.stroke();
        // Vertices: bright green where scratchable, dim otherwise.
        for (let index = 0; index < frame.verts.length; index += 1) {
          const vert = frame.verts[index];
          if (!vert) continue;
          if (on(index)) {
            ctx.fillStyle = "rgba(46, 255, 150, 0.95)";
            ctx.beginPath();
            ctx.arc(vert[0], vert[1], 2.1, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = "rgba(255, 90, 90, 0.55)";
            ctx.beginPath();
            ctx.arc(vert[0], vert[1], 1.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // Brush cursor.
      const cursor = cursorRef.current;
      if (cursor) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = brushRef.current.mode === "add" ? "rgba(46, 255, 150, 0.9)" : "rgba(255, 90, 90, 0.9)";
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, brushRef.current.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      raf = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(raf);
  }, [meshReady]);

  function toMeshPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const { width, height } = dimsRef.current;
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }

  function paintAt(clientX: number, clientY: number) {
    const point = toMeshPoint(clientX, clientY);
    if (!point) return;
    cursorRef.current = point;
    if (!drawingRef.current) return;
    const garment = garmentRef.current;
    const video = videoRef.current;
    if (!garment || !video) return;
    const frame = frameForTime(framesRef.current, video.currentTime);
    if (!frame) return;
    const radius = brushRef.current.radius;
    const r2 = radius * radius;
    const value = brushRef.current.mode === "add" ? 1 : 0;
    let changed = false;
    for (let index = 0; index < frame.verts.length; index += 1) {
      const vert = frame.verts[index];
      if (!vert) continue;
      const dx = vert[0] - point.x;
      const dy = vert[1] - point.y;
      if (dx * dx + dy * dy <= r2 && garment[index] !== value) {
        garment[index] = value;
        changed = true;
      }
    }
    if (changed && !dirty) setDirty(true);
  }

  function fillAll(value: 0 | 1) {
    const garment = garmentRef.current;
    if (!garment) return;
    garment.fill(value);
    setDirty(true);
    recomputeCoverage();
  }

  async function save() {
    const garment = garmentRef.current;
    if (!garment || !meshFile) return;
    setSaving(true);
    setSaveMsg("");
    onError("");
    try {
      const result = await api<{ ok: boolean; sum: number; total: number }>("/api/mesh/garment", {
        method: "POST",
        body: JSON.stringify({ file: meshFile, garment: Array.from(garment) }),
      });
      setDirty(false);
      setSaveMsg(`Saved ${result.sum}/${result.total} cells. Reload the mesh in the prototype to see it.`);
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => undefined);
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  function step(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setPlaying(false);
    video.currentTime = Math.max(0, Math.min((video.duration || 0) - 0.001, video.currentTime + deltaSeconds));
  }

  const coveragePct = coverage.total > 0 ? Math.round((coverage.on / coverage.total) * 100) : 0;

  return (
    <Card>
      <Grid columns={{ initial: "1", md: "2" }} gap="5">
        <Flex direction="column" gap="4">
          <Flex align="center" justify="between">
            <Heading size="4">Mask Editor</Heading>
            <Badge color={dirty ? "orange" : "gray"}>{dirty ? "Unsaved" : "Saved"}</Badge>
          </Flex>
          <Text color="gray" size="2">
            Paint the cells that should be scratchable. Scrub to a frame (e.g. the arm raised, or to expose the neck),
            then drag on the figure to add or erase. Save writes the mask back into the mesh; hit "Reload mesh" in the
            prototype to pick it up.
          </Text>

          <Field label="Card">
            <CardSelect cards={cards} selectedCardId={card?.id ?? ""} onValueChange={onSelectCard} />
          </Field>

          <Field label="Brush">
            <Flex gap="2" wrap="wrap">
              <Button
                color={brushMode === "add" ? "green" : "gray"}
                variant={brushMode === "add" ? "solid" : "soft"}
                onClick={() => setBrushMode("add")}
              >
                Add
              </Button>
              <Button
                color={brushMode === "erase" ? "red" : "gray"}
                variant={brushMode === "erase" ? "solid" : "soft"}
                onClick={() => setBrushMode("erase")}
              >
                Erase
              </Button>
            </Flex>
          </Field>

          <Field label={`Brush size (${brushRadius}px)`}>
            <input
              max={80}
              min={8}
              onChange={(event) => setBrushRadius(Number(event.currentTarget.value))}
              type="range"
              value={brushRadius}
            />
          </Field>

          <Field label="Playback">
            <Flex gap="2" wrap="wrap">
              <Button color="gray" variant="soft" onClick={togglePlay}>
                {playing ? <Square {...iconProps} /> : <Play {...iconProps} />}
                {playing ? "Pause" : "Play"}
              </Button>
              <Button color="gray" variant="soft" onClick={() => step(-0.1)}>
                -0.1s
              </Button>
              <Button color="gray" variant="soft" onClick={() => step(0.1)}>
                +0.1s
              </Button>
            </Flex>
          </Field>

          <Field label="Whole mask">
            <Flex gap="2" wrap="wrap">
              <Button color="gray" variant="soft" onClick={() => fillAll(1)}>
                Fill all
              </Button>
              <Button color="gray" variant="soft" onClick={() => fillAll(0)}>
                Clear all
              </Button>
            </Flex>
          </Field>

          <Separator size="4" />
          <Flex align="center" gap="3" justify="between">
            <Text color="gray" size="2" weight="bold">
              Scratchable: {coveragePct}% ({coverage.on}/{coverage.total})
            </Text>
            <Button disabled={!meshReady || saving || !dirty} onClick={save}>
              <Play {...iconProps} />
              {saving ? "Saving" : "Save mask"}
            </Button>
          </Flex>
          {saveMsg ? (
            <Text as="div" color="green" size="1" weight="medium">
              {saveMsg}
            </Text>
          ) : null}
          {loadError ? (
            <Text as="div" color="orange" size="1" weight="medium">
              {loadError}
            </Text>
          ) : null}
        </Flex>

        <Flex direction="column" gap="3">
          <Heading size="3">Canvas</Heading>
          <Separator size="4" />
          <Box className="mask-editor-stage">
            <video
              ref={videoRef}
              className="mask-editor-video"
              loop
              muted
              playsInline
              preload="auto"
              src={videoSrc}
            />
            <canvas
              ref={canvasRef}
              className="mask-editor-canvas"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drawingRef.current = true;
                paintAt(event.clientX, event.clientY);
              }}
              onPointerMove={(event) => paintAt(event.clientX, event.clientY)}
              onPointerUp={() => {
                drawingRef.current = false;
                recomputeCoverage();
              }}
              onPointerLeave={() => {
                drawingRef.current = false;
                cursorRef.current = null;
                recomputeCoverage();
              }}
            />
          </Box>
          <Text color="gray" size="1">
            Green dots/cells are scratchable. Red dots are off. The video is shown cover-fit to match how the
            prototype renders it, so what you paint lines up with the live scratch area.
          </Text>
        </Flex>
      </Grid>
    </Card>
  );
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <Flex
      direction="column"
      gap="2"
    >
      <Text
        color="gray"
        size="2"
        weight="bold"
      >
        {label}
      </Text>
      {children}
    </Flex>
  );
}

function CardSelect({
  cards,
  selectedCardId,
  onValueChange,
}: {
  cards: CardInfo[];
  selectedCardId: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select.Root
      value={selectedCardId}
      onValueChange={onValueChange}
    >
      <Select.Trigger placeholder="Select card" />
      <Select.Content>
        {cards.map((card) => (
          <Select.Item
            key={card.id}
            value={card.id}
          >
            {card.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function FilePathPicker({
  accept,
  onChange,
  onError,
  placeholder,
  preview,
  previewLabel,
  previewSize = "normal",
  value,
}: {
  accept?: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
  placeholder?: string;
  preview?: "image" | "video";
  previewLabel?: string;
  previewSize?: "compact" | "normal";
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setIsUploading(true);
    onError("");
    try {
      const uploaded = await uploadFile(file);
      onChange(uploaded.path);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Flex direction="column" gap="2">
      <Flex
        direction={{ initial: "column", sm: "row" }}
        gap="2"
      >
        <Box flexGrow="1">
          <TextField.Root
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Box>
        <Button
          color="gray"
          type="button"
          variant="soft"
          disabled={isUploading}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? <LoaderCircle {...iconProps} /> : <FileUp {...iconProps} />}
          {isUploading ? "Uploading" : "Pick file"}
        </Button>
      </Flex>
      {preview ? (
        <MediaPreview
          label={previewLabel ?? "Preview"}
          size={previewSize}
          type={preview}
          value={value}
        />
      ) : null}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={accept}
        onChange={(event) => handleFile(event.currentTarget.files?.[0])}
      />
    </Flex>
  );
}

export function Dashboard() {
  const [assets, setAssets] = useState<AssetsResponse>({ cards: [], meshes: [] });
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [tracker, setTracker] = useState<(typeof TRACKERS)[number]>("bootstapir");
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [compareTrackers, setCompareTrackers] = useState(false);
  const [grokPrompt, setGrokPrompt] = useState(
    "Replace only her dress with a fitted red satin dress. Keep the same person, face, hair, pose, motion, lighting and background.",
  );
  const [grokVideo, setGrokVideo] = useState("");
  const [grokOut, setGrokOut] = useState(".tmp/grok-edit.mp4");
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [resolution, setResolution] = useState("720p");
  const [imageVideoSource, setImageVideoSource] = useState("");
  const [imageVideoPrompt, setImageVideoPrompt] = useState(
    "Animate this still image into a short natural fashion video with subtle body movement and a steady camera.",
  );
  const [imageVideoOut, setImageVideoOut] = useState(".tmp/image-to-video.mp4");
  const [sourceImage, setSourceImage] = useState("");
  const [motionPrompt, setMotionPrompt] = useState(
    "Animate this still portrait into a short natural fashion video with subtle body movement and a steady camera.",
  );
  const [flowDressPrompt, setFlowDressPrompt] = useState(
    "Replace only her dress with a fitted emerald satin dress. Keep the same person, face, hair, pose, motion, lighting and background.",
  );
  const [flowBaseOut, setFlowBaseOut] = useState(".tmp/image-video-base.mp4");
  const [flowOut, setFlowOut] = useState(".tmp/image-dress-video.mp4");

  const selectedCard = useMemo(() => {
    return assets.cards.find((card) => card.id === selectedCardId) ?? assets.cards[0];
  }, [assets.cards, selectedCardId]);

  async function refreshAssets() {
    const data = await api<AssetsResponse>("/api/assets");
    setAssets(data);
    setSelectedCardId((current) => current || data.cards[0]?.id || "");
  }

  async function refreshJobs() {
    const data = await api<{ jobs: JobInfo[] }>("/api/jobs");
    setJobs(data.jobs);
  }

  async function refreshHealth() {
    const data = await api<HealthResponse>("/api/health");
    setHealth(data);
  }

  useEffect(() => {
    refreshHealth().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    refreshAssets().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    refreshJobs().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshJobs().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedCard) return;
    setGrokVideo(selectedCard.foreground);
    setGrokOut(`.tmp/${selectedCard.id}-edit.mp4`);
  }, [selectedCard]);

  async function startMeshJob() {
    if (!selectedCard) return;
    setError("");
    try {
      await api<JobInfo>("/api/jobs/generate-mesh", {
        method: "POST",
        body: JSON.stringify({
          input_video: selectedCard.foreground,
          output_json: `public/mesh/${selectedCard.mesh}`,
          tracker,
          debug_overlay: debugOverlay,
          compare_trackers: compareTrackers,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function startGrokJob() {
    if (!grokVideo) return;
    setError("");
    try {
      await api<JobInfo>("/api/jobs/grok-edit", {
        method: "POST",
        body: JSON.stringify({
          video: grokVideo,
          prompt: grokPrompt,
          out: grokOut,
          enhance: enhancePrompt,
          resolution,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function startImageToVideoJob() {
    setError("");
    try {
      await api<JobInfo>("/api/jobs/image-to-video", {
        method: "POST",
        body: JSON.stringify({
          image: imageVideoSource,
          prompt: imageVideoPrompt,
          out: imageVideoOut,
          resolution,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function startImageDressFlow() {
    setError("");
    try {
      await api<JobInfo>("/api/jobs/image-dress-flow", {
        method: "POST",
        body: JSON.stringify({
          image: sourceImage,
          motion_prompt: motionPrompt,
          dress_prompt: flowDressPrompt,
          base_video_out: flowBaseOut,
          out: flowOut,
          enhance_dress_prompt: enhancePrompt,
          resolution,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function cancelJob(id: string) {
    await api<JobInfo>(`/api/jobs/${id}/cancel`, { method: "POST" });
    await refreshJobs();
  }

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const canUseCard = Boolean(selectedCard);
  const canUseGrok = health?.xai_key_loaded === true;

  return (
    <main className="dashboard-root">
      <Container
        size="4"
        px="5"
        py="6"
      >
        <Flex
          direction="column"
          gap="5"
        >
          <Flex
            align={{ initial: "start", sm: "center" }}
            direction={{ initial: "column", sm: "row" }}
            gap="3"
            justify="between"
          >
            <Box>
              <Text
                color="red"
                size="2"
                weight="bold"
              >
                Operator Dashboard
              </Text>
              <Heading
                as="h1"
                size="8"
              >
                Sugar Scratchie Tools
              </Heading>
            </Box>
            <Flex gap="2">
              <Button
                color="gray"
                variant="soft"
                onClick={() => {
                  refreshHealth().catch((caught) => setError(String(caught)));
                  refreshAssets().catch((caught) => setError(String(caught)));
                  refreshJobs().catch(() => undefined);
                }}
              >
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
              <Button asChild>
                <a href="/">
                  <ExternalLink {...iconProps} />
                  Open prototype
                </a>
              </Button>
            </Flex>
          </Flex>

          {error ? (
            <Callout.Root color="red">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          {health && !health.xai_key_loaded ? (
            <Callout.Root color="orange">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>
                Add XAI_API_KEY or GROK_API_KEY to .env, then restart the backend before running Grok jobs.
              </Callout.Text>
            </Callout.Root>
          ) : null}

          <Grid
            columns={{ initial: "1", md: "4" }}
            gap="3"
          >
            <Card>
              <Flex
                align="center"
                gap="3"
              >
                <SlidersHorizontal {...iconProps} />
                <Box>
                  <Text
                    as="div"
                    size="2"
                    weight="bold"
                  >
                    API status
                  </Text>
                  <Text
                    as="div"
                    color={health?.ok ? "green" : "gray"}
                    size="2"
                  >
                    {health?.ok ? "Connected" : "Checking"}
                  </Text>
                </Box>
              </Flex>
            </Card>
            <Card>
              <Flex
                align="center"
                gap="3"
              >
                <Workflow {...iconProps} />
                <Box>
                  <Text
                    as="div"
                    size="2"
                    weight="bold"
                  >
                    API key
                  </Text>
                  <Text
                    as="div"
                    color={health?.xai_key_loaded ? "green" : "orange"}
                    size="2"
                  >
                    {health?.xai_key_loaded ? "API key loaded" : "API key missing"}
                  </Text>
                </Box>
              </Flex>
            </Card>
            <Card>
              <Flex
                align="center"
                gap="3"
              >
                <SlidersHorizontal {...iconProps} />
                <Box>
                  <Text
                    as="div"
                    size="2"
                    weight="bold"
                  >
                    Video tools
                  </Text>
                  <Text
                    as="div"
                    color={health?.ffmpeg_available ? "green" : "orange"}
                    size="2"
                  >
                    {health?.ffmpeg_available ? "ffmpeg ready" : "ffmpeg missing"}
                  </Text>
                </Box>
              </Flex>
            </Card>
            <Card>
              <Flex
                align="center"
                gap="3"
              >
                <Video {...iconProps} />
                <Box>
                  <Text
                    as="div"
                    size="2"
                    weight="bold"
                  >
                    Active jobs
                  </Text>
                  <Text
                    as="div"
                    color="gray"
                    size="2"
                  >
                    {activeJobs.length} queued or running
                  </Text>
                </Box>
              </Flex>
            </Card>
          </Grid>

          <Tabs.Root defaultValue="mesh">
            <Tabs.List className="dashboard-tabs">
              <Tabs.Trigger value="mesh">
                <Workflow {...iconProps} />
                Generate Mesh
              </Tabs.Trigger>
              <Tabs.Trigger value="mask">
                <SlidersHorizontal {...iconProps} />
                Mask Editor
              </Tabs.Trigger>
              <Tabs.Trigger value="image-video">
                <Video {...iconProps} />
                Image Video
              </Tabs.Trigger>
              <Tabs.Trigger value="image-flow">
                <Image {...iconProps} />
                Image Flow
              </Tabs.Trigger>
              <Tabs.Trigger value="dress-edit">
                <WandSparkles {...iconProps} />
                Dress Edit
              </Tabs.Trigger>
              <Tabs.Trigger value="assets">Assets</Tabs.Trigger>
              <Tabs.Trigger value="jobs">Jobs</Tabs.Trigger>
            </Tabs.List>

            <Box pt="4">
              <Tabs.Content value="mesh">
                <Card>
                  <Grid
                    columns={{ initial: "1", md: "2" }}
                    gap="5"
                  >
                    <Flex
                      direction="column"
                      gap="4"
                    >
                      <Flex
                        align="center"
                        justify="between"
                      >
                        <Heading size="4">Generate Mesh</Heading>
                        <Badge color={activeJobs.length ? "blue" : "gray"}>{activeJobs.length} active</Badge>
                      </Flex>
                      <Field label="Card">
                        <CardSelect
                          cards={assets.cards}
                          selectedCardId={selectedCard?.id ?? ""}
                          onValueChange={setSelectedCardId}
                        />
                      </Field>
                      <Field label="Tracker">
                        <Select.Root
                          value={tracker}
                          onValueChange={(value) => setTracker(value as typeof tracker)}
                        >
                          <Select.Trigger />
                          <Select.Content>
                            {TRACKERS.map((entry) => (
                              <Select.Item
                                key={entry}
                                value={entry}
                              >
                                {entry}
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                      </Field>
                      <Grid
                        columns={{ initial: "1", sm: "2" }}
                        gap="3"
                      >
                        <Text
                          as="label"
                          size="2"
                        >
                          <Flex
                            align="center"
                            gap="2"
                          >
                            <Checkbox
                              checked={debugOverlay}
                              onCheckedChange={(checked) => setDebugOverlay(checked === true)}
                            />
                            Debug overlays
                          </Flex>
                        </Text>
                        <Text
                          as="label"
                          size="2"
                        >
                          <Flex
                            align="center"
                            gap="2"
                          >
                            <Checkbox
                              checked={compareTrackers}
                              onCheckedChange={(checked) => setCompareTrackers(checked === true)}
                            />
                            Compare only
                          </Flex>
                        </Text>
                      </Grid>
                      <Button
                        disabled={!canUseCard}
                        onClick={startMeshJob}
                      >
                        <Play {...iconProps} />
                        Start mesh job
                      </Button>
                    </Flex>

                    <Flex
                      direction="column"
                      gap="3"
                    >
                      <Heading size="3">Preview</Heading>
                      <Separator size="4" />
                      {selectedCard ? (
                        <MeshOverlayPreview
                          label="Foreground mesh"
                          mesh={`public/mesh/${selectedCard.mesh}`}
                          value={selectedCard.foreground}
                        />
                      ) : null}
                      <Text
                        color="gray"
                        size="2"
                        weight="bold"
                      >
                        Input
                      </Text>
                      <Code className="dashboard-code">{selectedCard?.foreground ?? "No card selected"}</Code>
                      <Text
                        color="gray"
                        size="2"
                        weight="bold"
                      >
                        Output
                      </Text>
                      <Code className="dashboard-code">
                        {selectedCard ? `public/mesh/${selectedCard.mesh}` : "No card selected"}
                      </Code>
                    </Flex>
                  </Grid>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="mask">
                <MaskEditor
                  cards={assets.cards}
                  selectedCardId={selectedCard?.id ?? ""}
                  onSelectCard={setSelectedCardId}
                  onSaved={() => refreshAssets().catch(() => undefined)}
                  onError={setError}
                />
              </Tabs.Content>

              <Tabs.Content value="image-video">
                <Card>
                  <Flex
                    direction="column"
                    gap="4"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Image To Video</Heading>
                      <Badge color="blue">Generator</Badge>
                    </Flex>
                    <Field label="Source image path or URL">
                      <FilePathPicker
                        accept="image/*"
                        placeholder="Pick an image or paste a path/URL"
                        preview="image"
                        previewLabel="Source image"
                        previewSize="compact"
                        value={imageVideoSource}
                        onChange={setImageVideoSource}
                        onError={setError}
                      />
                    </Field>
                    <Field label="Motion prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={imageVideoPrompt}
                        onChange={(event) => setImageVideoPrompt(event.currentTarget.value)}
                      />
                    </Field>
                    <Grid
                      columns={{ initial: "1", md: "2" }}
                      gap="3"
                    >
                      <Field label="Output video">
                        <FilePathPicker
                          accept="video/*"
                          preview="video"
                          previewLabel="Generated video"
                          value={imageVideoOut}
                          onChange={setImageVideoOut}
                          onError={setError}
                        />
                      </Field>
                      <Field label="Resolution">
                        <Select.Root
                          value={resolution || "default"}
                          onValueChange={(value) => setResolution(value === "default" ? "" : value)}
                        >
                          <Select.Trigger />
                          <Select.Content>
                            <Select.Item value="720p">720p</Select.Item>
                            <Select.Item value="480p">480p</Select.Item>
                            <Select.Item value="default">Default</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Field>
                    </Grid>
                    <Button
                      disabled={!imageVideoSource || !canUseGrok}
                      onClick={startImageToVideoJob}
                    >
                      <Play {...iconProps} />
                      Start image video
                    </Button>
                  </Flex>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="image-flow">
                <Card>
                  <Flex
                    direction="column"
                    gap="4"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Image To Dress Video</Heading>
                      <Badge color="red">Chained flow</Badge>
                    </Flex>
                    <Field label="Source image path or URL">
                      <FilePathPicker
                        accept="image/*"
                        placeholder="Pick an image or paste a path/URL"
                        preview="image"
                        previewLabel="Source image"
                        previewSize="compact"
                        value={sourceImage}
                        onChange={setSourceImage}
                        onError={setError}
                      />
                    </Field>
                    <Field label="Motion prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={motionPrompt}
                        onChange={(event) => setMotionPrompt(event.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Dress edit prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={flowDressPrompt}
                        onChange={(event) => setFlowDressPrompt(event.currentTarget.value)}
                      />
                    </Field>
                    <Grid
                      columns={{ initial: "1", md: "2" }}
                      gap="3"
                    >
                      <Field label="Base video output">
                        <FilePathPicker
                          accept="video/*"
                          preview="video"
                          previewLabel="Base video"
                          value={flowBaseOut}
                          onChange={setFlowBaseOut}
                          onError={setError}
                        />
                      </Field>
                      <Field label="Final video output">
                        <FilePathPicker
                          accept="video/*"
                          preview="video"
                          previewLabel="Final video"
                          value={flowOut}
                          onChange={setFlowOut}
                          onError={setError}
                        />
                      </Field>
                    </Grid>
                    <Button
                      disabled={!sourceImage || !canUseGrok}
                      onClick={startImageDressFlow}
                    >
                      <Play {...iconProps} />
                      Start image flow
                    </Button>
                  </Flex>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="dress-edit">
                <Card>
                  <Flex
                    direction="column"
                    gap="4"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Grok Dress Edit</Heading>
                      <Badge color="purple">Video edit</Badge>
                    </Flex>
                    <Field label="Source video path or URL">
                      <FilePathPicker
                        accept="video/*"
                        preview="video"
                        previewLabel="Source video"
                        value={grokVideo}
                        onChange={setGrokVideo}
                        onError={setError}
                      />
                    </Field>
                    <Field label="Prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={grokPrompt}
                        onChange={(event) => setGrokPrompt(event.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Output file">
                      <FilePathPicker
                        accept="video/*"
                        preview="video"
                        previewLabel="Edited video"
                        value={grokOut}
                        onChange={setGrokOut}
                        onError={setError}
                      />
                    </Field>
                    <Grid
                      columns={{ initial: "1", sm: "2" }}
                      gap="3"
                    >
                      <Field label="Resolution">
                        <Select.Root
                          value={resolution || "default"}
                          onValueChange={(value) => setResolution(value === "default" ? "" : value)}
                        >
                          <Select.Trigger />
                          <Select.Content>
                            <Select.Item value="720p">720p</Select.Item>
                            <Select.Item value="480p">480p</Select.Item>
                            <Select.Item value="default">Default</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Field>
                      <Text
                        as="label"
                        size="2"
                      >
                        <Flex
                          align="center"
                          gap="2"
                          height="100%"
                          pt="5"
                        >
                          <Checkbox
                            checked={enhancePrompt}
                            onCheckedChange={(checked) => setEnhancePrompt(checked === true)}
                          />
                          Enhance prompt
                        </Flex>
                      </Text>
                    </Grid>
                    <Button
                      disabled={!grokVideo || !canUseGrok}
                      onClick={startGrokJob}
                    >
                      <Play {...iconProps} />
                      Start edit job
                    </Button>
                  </Flex>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="assets">
                <Card>
                  <Flex
                    direction="column"
                    gap="5"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Assets</Heading>
                      <Button
                        color="gray"
                        variant="soft"
                        onClick={() => refreshAssets().catch((caught) => setError(String(caught)))}
                      >
                        <LoaderCircle {...iconProps} />
                        Refresh assets
                      </Button>
                    </Flex>

                    <Box>
                      <Heading
                        mb="3"
                        size="3"
                      >
                        Cards
                      </Heading>
                      <ScrollArea>
                        <Table.Root variant="surface">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeaderCell>Card</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Foreground</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Mesh</Table.ColumnHeaderCell>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {assets.cards.map((card) => (
                              <Table.Row key={card.id}>
                                <Table.RowHeaderCell>{card.label}</Table.RowHeaderCell>
                                <Table.Cell>
                                  <Code className="dashboard-code">{card.foreground}</Code>
                                </Table.Cell>
                                <Table.Cell>
                                  <Badge color={card.has_mesh ? "green" : "orange"}>
                                    {card.has_mesh ? card.mesh : "Missing mesh"}
                                  </Badge>
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Root>
                      </ScrollArea>
                    </Box>

                    <Box>
                      <Heading
                        mb="3"
                        size="3"
                      >
                        Meshes
                      </Heading>
                      <ScrollArea>
                        <Table.Root variant="surface">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeaderCell>File</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Tracker</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Frames</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Grid</Table.ColumnHeaderCell>
                              <Table.ColumnHeaderCell>Size</Table.ColumnHeaderCell>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {assets.meshes.map((mesh) => (
                              <Table.Row key={mesh.file}>
                                <Table.RowHeaderCell>
                                  <Code className="dashboard-code">{mesh.file}</Code>
                                </Table.RowHeaderCell>
                                <Table.Cell>{mesh.tracker ?? "unknown"}</Table.Cell>
                                <Table.Cell>{mesh.frames ?? 0}</Table.Cell>
                                <Table.Cell>
                                  {mesh.cols ?? "-"}x{mesh.rows ?? "-"}
                                </Table.Cell>
                                <Table.Cell>{formatBytes(mesh.size_bytes)}</Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Root>
                      </ScrollArea>
                    </Box>
                  </Flex>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="jobs">
                <Card>
                  <Flex
                    direction="column"
                    gap="4"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Jobs</Heading>
                      <Button
                        color="gray"
                        variant="soft"
                        onClick={() => refreshJobs().catch(() => undefined)}
                      >
                        <LoaderCircle {...iconProps} />
                        Refresh jobs
                      </Button>
                    </Flex>

                    {jobs.length === 0 ? (
                      <Text
                        color="gray"
                        weight="medium"
                      >
                        No jobs yet.
                      </Text>
                    ) : null}

                    <Flex
                      direction="column"
                      gap="3"
                    >
                      {jobs.map((job) => (
                        <Box
                          className="dashboard-job"
                          key={job.id}
                        >
                          <Flex
                            align={{ initial: "start", sm: "center" }}
                            direction={{ initial: "column", sm: "row" }}
                            gap="3"
                            justify="between"
                          >
                            <Box>
                              <Text
                                as="div"
                                weight="bold"
                              >
                                {job.kind}
                              </Text>
                              <Code className="dashboard-code">{job.id}</Code>
                            </Box>
                            <Flex gap="2">
                              <Badge color={statusColor(job.status)}>{statusLabel(job.status)}</Badge>
                              {job.status === "running" || job.status === "queued" ? (
                                <Button
                                  color="red"
                                  size="1"
                                  variant="soft"
                                  onClick={() => cancelJob(job.id)}
                                >
                                  <Square {...iconProps} />
                                  Cancel
                                </Button>
                              ) : null}
                            </Flex>
                          </Flex>
                          <pre className="dashboard-log">{job.logs.slice(-28).join("\n") || "Waiting for output..."}</pre>
                        </Box>
                      ))}
                    </Flex>
                  </Flex>
                </Card>
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        </Flex>
      </Container>
    </main>
  );
}
