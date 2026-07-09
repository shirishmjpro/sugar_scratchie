import {
  AlertTriangle,
  Check,
  Clapperboard,
  ExternalLink,
  FileArchive,
  FileUp,
  Image,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
  UserRound,
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
import { MaskEditor } from "./videoFlow/MaskEditor";

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


function VideoManagerPanel({
  cards,
  editingCardId,
  onEditingCardChange,
  onRefresh,
  onRefreshJobs,
  onError,
}: {
  cards: CardInfo[];
  editingCardId: string;
  onEditingCardChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onRefreshJobs: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [newCardId, setNewCardId] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [newBackground, setNewBackground] = useState("");
  const [newForeground, setNewForeground] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editBackground, setEditBackground] = useState("");
  const [editForeground, setEditForeground] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressWebm, setCompressWebm] = useState(true);

  const editingCard = useMemo(
    () => cards.find((card) => card.id === editingCardId) ?? cards[0],
    [cards, editingCardId],
  );

  useEffect(() => {
    if (!editingCard) return;
    setEditLabel(editingCard.label);
    setEditBackground("");
    setEditForeground("");
  }, [editingCard]);

  async function saveCard() {
    if (!editingCard) return;
    setIsSaving(true);
    onError("");
    try {
      await api<CardInfo>(`/api/cards/${editingCard.id}`, {
        method: "PUT",
        body: JSON.stringify({
          label: editLabel,
          ...(editBackground ? { background: editBackground } : {}),
          ...(editForeground ? { foreground: editForeground } : {}),
        }),
      });
      await onRefresh();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSaving(false);
    }
  }

  async function createCard() {
    setIsCreating(true);
    onError("");
    try {
      await api<CardInfo>("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          id: newCardId,
          label: newCardLabel,
          background: newBackground,
          foreground: newForeground,
        }),
      });
      setNewCardId("");
      setNewCardLabel("");
      setNewBackground("");
      setNewForeground("");
      await onRefresh();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsCreating(false);
    }
  }

  async function deleteCard() {
    if (!editingCard || editingCard.id === "original") return;
    if (!window.confirm(`Delete card "${editingCard.label}" and its video files?`)) return;
    setIsDeleting(true);
    onError("");
    try {
      await api<{ ok: boolean }>(`/api/cards/${editingCard.id}`, { method: "DELETE" });
      onEditingCardChange(cards.find((card) => card.id === "original")?.id ?? cards[0]?.id ?? "");
      await onRefresh();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsDeleting(false);
    }
  }

  async function compressCard() {
    if (!editingCard) return;
    if (
      !window.confirm(
        `Compress "${editingCard.label}" to 540px H.264? Originals are backed up to .video-backups/ before being overwritten.`,
      )
    ) {
      return;
    }
    setIsCompressing(true);
    onError("");
    try {
      await api<JobInfo>(`/api/jobs/cards/${editingCard.id}/compress`, {
        method: "POST",
        body: JSON.stringify({ write_webm: compressWebm }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsCompressing(false);
    }
  }

  const canCreate = Boolean(newCardId.trim() && newCardLabel.trim() && newBackground && newForeground);

  return (
    <Grid
      columns={{ initial: "1", lg: "2" }}
      gap="5"
    >
      <Flex
        direction="column"
        gap="4"
      >
        <Heading size="4">Edit card</Heading>
        <Field label="Card">
          <CardSelect
            cards={cards}
            selectedCardId={editingCard?.id ?? ""}
            onValueChange={onEditingCardChange}
          />
        </Field>
        <Field label="Label">
          <TextField.Root
            value={editLabel}
            onChange={(event) => setEditLabel(event.currentTarget.value)}
          />
        </Field>
        <Field label="Background video (reveal layer)">
          <FilePathPicker
            accept="video/*"
            preview="video"
            previewLabel={editBackground ? "New background preview" : "Current background"}
            value={editBackground || editingCard?.background || ""}
            onChange={setEditBackground}
            onError={onError}
          />
        </Field>
        <Field label="Foreground video (green-screen scratch layer)">
          <FilePathPicker
            accept="video/*"
            preview="video"
            previewLabel={editForeground ? "New foreground preview" : "Current foreground"}
            value={editForeground || editingCard?.foreground || ""}
            onChange={setEditForeground}
            onError={onError}
          />
        </Field>
        <Flex gap="2">
          <Button
            disabled={!editingCard || isSaving}
            onClick={saveCard}
          >
            {isSaving ? <LoaderCircle {...iconProps} /> : <FileUp {...iconProps} />}
            {isSaving ? "Saving" : "Save changes"}
          </Button>
          <Button
            color="red"
            disabled={!editingCard || editingCard.id === "original" || isDeleting}
            variant="soft"
            onClick={deleteCard}
          >
            {isDeleting ? <LoaderCircle {...iconProps} /> : <Trash2 {...iconProps} />}
            Delete card
          </Button>
        </Flex>
        <Text
          color="gray"
          size="1"
        >
          Upload replacements or pick a workspace path, then save. The original card can be updated but not deleted.
        </Text>

        <Separator size="4" />
        <Heading size="3">Compress videos</Heading>
        <label className="checkbox-label">
          <Checkbox
            checked={compressWebm}
            onCheckedChange={(checked) => setCompressWebm(checked === true)}
          />
          Also write VP9 WebM sidecars
        </label>
        <Flex gap="2">
          <Button
            color="gray"
            disabled={!editingCard || isCompressing}
            variant="soft"
            onClick={compressCard}
          >
            {isCompressing ? <LoaderCircle {...iconProps} /> : <FileArchive {...iconProps} />}
            {isCompressing ? "Starting" : "Compress videos"}
          </Button>
        </Flex>
        <Text
          color="gray"
          size="1"
        >
          Re-encodes both clips to 540px H.264 in place (same as the Video Flow compress step). Originals are
          backed up to .video-backups/. Watch progress in the Jobs tab.
        </Text>
      </Flex>

      <Flex
        direction="column"
        gap="4"
      >
        <Heading size="4">Create card</Heading>
        <Field label="Card id">
          <TextField.Root
            placeholder="my_card_1"
            value={newCardId}
            onChange={(event) => setNewCardId(event.currentTarget.value)}
          />
        </Field>
        <Field label="Label">
          <TextField.Root
            placeholder="My Card 1"
            value={newCardLabel}
            onChange={(event) => setNewCardLabel(event.currentTarget.value)}
          />
        </Field>
        <Field label="Background video">
          <FilePathPicker
            accept="video/*"
            preview="video"
            previewLabel="Background preview"
            value={newBackground}
            onChange={setNewBackground}
            onError={onError}
          />
        </Field>
        <Field label="Foreground video">
          <FilePathPicker
            accept="video/*"
            preview="video"
            previewLabel="Foreground preview"
            value={newForeground}
            onChange={setNewForeground}
            onError={onError}
          />
        </Field>
        <Button
          disabled={!canCreate || isCreating}
          onClick={createCard}
        >
          {isCreating ? <LoaderCircle {...iconProps} /> : <Video {...iconProps} />}
          {isCreating ? "Creating" : "Create card"}
        </Button>
        <Text
          color="gray"
          size="1"
        >
          New cards are stored under public/cards/&lt;id&gt;/ and appear in the prototype card switcher after refresh.
        </Text>
      </Flex>
    </Grid>
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
  const [sourceImage, setSourceImage] = useState("");
  const [motionPrompt, setMotionPrompt] = useState(
    "Animate this still portrait into a short natural fashion video with subtle body movement and a steady camera.",
  );
  const [flowDressPrompt, setFlowDressPrompt] = useState(
    "Replace only her dress with a fitted emerald satin dress. Keep the same person, face, hair, pose, motion, lighting and background.",
  );
  const [flowBaseOut, setFlowBaseOut] = useState(".tmp/image-video-base.mp4");
  const [flowOut, setFlowOut] = useState(".tmp/image-dress-video.mp4");
  const [videoManagerCardId, setVideoManagerCardId] = useState("");

  const selectedCard = useMemo(() => {
    return assets.cards.find((card) => card.id === selectedCardId) ?? assets.cards[0];
  }, [assets.cards, selectedCardId]);

  async function refreshAssets() {
    const data = await api<AssetsResponse>("/api/assets");
    setAssets(data);
    setSelectedCardId((current) => current || data.cards[0]?.id || "");
    setVideoManagerCardId((current) => current || data.cards[0]?.id || "");
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
              <Button asChild variant="soft">
                <a href="/dashboard/models">
                  <UserRound {...iconProps} />
                  Models
                </a>
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/video-flow">
                  <Clapperboard {...iconProps} />
                  Video Flow
                </a>
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
              <Tabs.Trigger value="image-flow">
                <Image {...iconProps} />
                Image Flow
              </Tabs.Trigger>

              <Tabs.Trigger value="dress-edit">
                <WandSparkles {...iconProps} />
                Dress Edit
              </Tabs.Trigger>
              <Tabs.Trigger value="videos">
                <Video {...iconProps} />
                Videos
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
                <Card>
                  <Flex direction="column" gap="4">
                    <Field label="Card">
                      <CardSelect
                        cards={assets.cards}
                        selectedCardId={selectedCard?.id ?? ""}
                        onValueChange={setSelectedCardId}
                      />
                    </Field>
                    {selectedCard ? (
                      <MaskEditor
                        meshFile={selectedCard.mesh}
                        videoSrc={previewSource(selectedCard.foreground)}
                        onSaved={() => refreshAssets().catch(() => undefined)}
                        onError={setError}
                      />
                    ) : null}
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

              <Tabs.Content value="videos">
                <Card>
                  <Flex
                    direction="column"
                    gap="5"
                  >
                    <Flex
                      align="center"
                      justify="between"
                    >
                      <Heading size="4">Manage Videos</Heading>
                      <Button
                        color="gray"
                        variant="soft"
                        onClick={() => refreshAssets().catch((caught) => setError(String(caught)))}
                      >
                        <LoaderCircle {...iconProps} />
                        Refresh cards
                      </Button>
                    </Flex>
                    <VideoManagerPanel
                      cards={assets.cards}
                      editingCardId={videoManagerCardId || selectedCard?.id || ""}
                      onEditingCardChange={setVideoManagerCardId}
                      onError={setError}
                      onRefresh={refreshAssets}
                      onRefreshJobs={refreshJobs}
                    />
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
