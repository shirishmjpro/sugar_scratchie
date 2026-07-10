import { Play, Square } from "lucide-react";
import { Badge, Box, Button, Flex, Grid, Heading, Separator, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api";
import { Field, iconProps, previewSource } from "./ui";

type TrackedMeshFrame = {
  t: number;
  verts: [number, number][];
  vis?: number[];
};

type GarmentMeshData = {
  canvas?: { width?: number; height?: number };
  mesh?: { cols?: number; rows?: number };
  frames?: TrackedMeshFrame[];
  garment?: number[] | null;
};

type JobInfo = {
  id: string;
  status: string;
  return_code: number | null;
  logs: string[];
};

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

export type MaskEditorProps = {
  meshFile: string;
  /** Relative repo path for save API (defaults to meshFile in public/mesh/). */
  meshSavePath?: string;
  videoSrc: string;
  meshUrl?: string;
  onError: (message: string) => void;
  onSaved?: () => void;
  title?: string;
};

export function MaskEditor({
  meshFile,
  meshSavePath,
  videoSrc,
  meshUrl,
  onError,
  onSaved,
  title = "Mask Editor",
}: MaskEditorProps) {
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
  const [reloadToken, setReloadToken] = useState(0);
  const [autoRunning, setAutoRunning] = useState(false);

  const meshFetchUrl =
    meshUrl ??
    (meshFile.startsWith("/") ? meshFile : previewSource(`public/mesh/${meshFile}`));

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

  useEffect(() => {
    let cancelled = false;
    setMeshReady(false);
    setLoadError("");
    setSaveMsg("");
    setDirty(false);
    garmentRef.current = null;
    framesRef.current = [];
    if (!meshFetchUrl) return undefined;

    const freshSrc = `${meshFetchUrl}${meshFetchUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
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
  }, [meshFetchUrl, reloadToken]);

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
      const cursor = cursorRef.current;
      if (cursor) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle =
          brushRef.current.mode === "add" ? "rgba(46, 255, 150, 0.9)" : "rgba(255, 90, 90, 0.9)";
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

  /** Grow or shrink the scratchable mask by one lattice ring (4-neighborhood). */
  function morphMask(expand: boolean) {
    const garment = garmentRef.current;
    const { cols, rows } = dimsRef.current;
    if (!garment || cols <= 0 || rows <= 0) return;
    const next = new Uint8Array(garment.length);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const value = garment[index];
        if (expand) {
          let on = value === 1;
          if (!on && col > 0 && garment[index - 1]) on = true;
          if (!on && col + 1 < cols && garment[index + 1]) on = true;
          if (!on && row > 0 && garment[index - cols]) on = true;
          if (!on && row + 1 < rows && garment[index + cols]) on = true;
          next[index] = on ? 1 : 0;
        } else {
          let keep = value === 1;
          if (keep && (col === 0 || !garment[index - 1])) keep = false;
          if (keep && (col + 1 >= cols || !garment[index + 1])) keep = false;
          if (keep && (row === 0 || !garment[index - cols])) keep = false;
          if (keep && (row + 1 >= rows || !garment[index + cols])) keep = false;
          next[index] = keep ? 1 : 0;
        }
      }
    }
    garment.set(next);
    setDirty(true);
    recomputeCoverage();
  }

  async function save() {
    const garment = garmentRef.current;
    const savePath = meshSavePath ?? meshFile;
    if (!garment || !savePath) return;
    setSaving(true);
    setSaveMsg("");
    onError("");
    try {
      const result = await api<{ ok: boolean; sum: number; total: number }>("/api/mesh/garment", {
        method: "POST",
        body: JSON.stringify({ file: savePath, garment: Array.from(garment) }),
      });
      setDirty(false);
      setSaveMsg(`Saved ${result.sum}/${result.total} scratchable cells.`);
      onSaved?.();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setSaveMsg("");
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  async function autoDetect() {
    const savePath = meshSavePath ?? meshFile;
    if (!savePath || autoRunning) return;
    setAutoRunning(true);
    setSaveMsg("");
    onError("");
    try {
      const job = await api<JobInfo>("/api/jobs/mesh/auto-garment", {
        method: "POST",
        body: JSON.stringify({ file: savePath, union_existing: false }),
      });
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const latest = await api<JobInfo>(`/api/jobs/${encodeURIComponent(job.id)}`);
        if (latest.status === "succeeded" || latest.status === "failed" || latest.status === "cancelled") {
          if (latest.status !== "succeeded") {
            const tail = latest.logs.slice(-4).join("\n");
            throw new Error(tail || `Auto mask ${latest.status}`);
          }
          break;
        }
        if (attempt === 179) throw new Error("Auto mask timed out");
      }
      setDirty(false);
      setSaveMsg("Auto-detected body/clothes mask — tweak with Grow/Erase if needed, then Save.");
      setReloadToken((token) => token + 1);
      onSaved?.();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAutoRunning(false);
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
    video.currentTime = Math.max(
      0,
      Math.min((video.duration || 0) - 0.001, video.currentTime + deltaSeconds),
    );
  }

  const coveragePct = coverage.total > 0 ? Math.round((coverage.on / coverage.total) * 100) : 0;

  return (
    <Grid columns={{ initial: "1", md: "2" }} gap="5">
      <Flex direction="column" gap="4">
        <Flex align="center" justify="between">
          <Heading size="4">{title}</Heading>
          <Badge color={dirty ? "orange" : "gray"}>{dirty ? "Unsaved" : "Saved"}</Badge>
        </Flex>
        <Text color="gray" size="2">
          <strong>Auto detect</strong> builds a clothes/arms/legs mask from the foreground video.
          Then use <strong>Grow</strong> / <strong>Erase</strong> to cover more of the outfit or
          clear hair/face bleed, and <strong>Save mask</strong>.
        </Text>

        <Field label="Auto">
          <Flex gap="2" wrap="wrap">
            <Button
              disabled={!meshReady || autoRunning || saving}
              onClick={() => void autoDetect()}
            >
              {autoRunning ? "Detecting…" : "Auto detect body/clothes"}
            </Button>
          </Flex>
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
            <Button
              color="green"
              variant="soft"
              disabled={!meshReady}
              onClick={() => morphMask(true)}
            >
              Grow +1
            </Button>
            <Button
              color="orange"
              variant="soft"
              disabled={!meshReady}
              onClick={() => morphMask(false)}
            >
              Shrink −1
            </Button>
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
          <Button disabled={!meshReady || saving || !dirty} onClick={() => void save()}>
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
  );
}
