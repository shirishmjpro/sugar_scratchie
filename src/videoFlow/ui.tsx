import { FileUp, Maximize2, Trash2, X } from "lucide-react";
import { Badge, Box, Button, Flex, Text, TextField } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { uploadFile } from "../shared/api";

export const MESH_TRACKERS = ["bootstapir", "cotracker", "blend"] as const;
export const MESH_TRACKER_MODES = ["all", ...MESH_TRACKERS] as const;
export const TRACKERS = MESH_TRACKERS;

export type MeshTracker = (typeof MESH_TRACKERS)[number];
export type MeshTrackerMode = (typeof MESH_TRACKER_MODES)[number];

export function meshTrackerFromArtifact(path: string): MeshTracker | null {
  const match = path.match(/mesh-(bootstapir|cotracker|blend)\.json$/);
  return match ? (match[1] as MeshTracker) : null;
}

export function meshTrackerModeLabel(mode: MeshTrackerMode): string {
  if (mode === "all") return "All (compare & pick)";
  return mode;
}

export const iconProps = {
  "aria-hidden": true,
  size: 16,
  strokeWidth: 2.25,
} as const;

export function previewSource(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return trimmed;
  }
  return `/api/files/preview?path=${encodeURIComponent(trimmed)}`;
}

export function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Flex direction="column" gap="2">
      <Text color="gray" size="2" weight="bold">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

export function MediaPreview({
  label,
  size = "normal",
  type,
  value,
  zoomable = false,
  onDelete,
}: {
  label: string;
  size?: "compact" | "normal";
  type: "image" | "video";
  value: string;
  zoomable?: boolean;
  onDelete?: () => void;
}) {
  const src = previewSource(value);
  const [hasError, setHasError] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    setHasError(false);
    setZoomOpen(false);
  }, [src]);

  useEffect(() => {
    if (!zoomOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomOpen]);

  if (!src) return null;

  const showZoom = zoomable && type === "image";

  return (
    <>
      <Box className={`dashboard-preview${size === "compact" ? " dashboard-preview--compact" : ""}`}>
        <Flex align="center" justify="between" mb="2">
          <Text color="gray" size="1" weight="bold">
            {label}
          </Text>
          <Flex align="center" gap="1">
            {showZoom && !hasError ? (
              <Button
                aria-label={`Zoom ${label}`}
                size="1"
                type="button"
                variant="ghost"
                onClick={() => setZoomOpen(true)}
              >
                <Maximize2 {...iconProps} />
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                aria-label={`Remove ${label}`}
                color="red"
                size="1"
                type="button"
                variant="ghost"
                onClick={onDelete}
              >
                <Trash2 {...iconProps} />
              </Button>
            ) : null}
            <Badge color={hasError ? "red" : "gray"} variant="soft">
              {hasError ? "failed" : type}
            </Badge>
          </Flex>
        </Flex>
        {hasError ? (
          <Box className="dashboard-preview-empty">
            <Text color="red" size="2">
              Couldn’t load {type}: {label}
            </Text>
            <Text as="div" color="gray" size="1" mt="1">
              {value}
            </Text>
          </Box>
        ) : type === "image" ? (
          <button
            className={`dashboard-preview-media-button${size === "compact" ? " dashboard-preview-media-button--compact" : ""}`}
            disabled={!showZoom}
            type="button"
            onClick={() => {
              if (showZoom) setZoomOpen(true);
            }}
          >
            <img
              alt={label}
              className={`dashboard-preview-media${size === "compact" ? " dashboard-preview-media--compact" : ""}`}
              onError={() => setHasError(true)}
              src={src}
            />
          </button>
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
      {showZoom && zoomOpen ? (
        <div
          className="media-preview-zoom"
          role="dialog"
          aria-label={`${label} zoom`}
          onClick={() => setZoomOpen(false)}
        >
          <button
            aria-label="Close zoom"
            className="media-preview-zoom-close"
            type="button"
            onClick={() => setZoomOpen(false)}
          >
            <X {...iconProps} />
          </button>
          <img
            alt={label}
            className="media-preview-zoom-image"
            src={src}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}

export function FilePathPicker({
  accept,
  onChange,
  onError,
  placeholder,
  preview,
  previewLabel,
  previewSize = "normal",
  previewZoomable = false,
  value,
}: {
  accept?: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
  placeholder?: string;
  preview?: "image" | "video";
  previewLabel?: string;
  previewSize?: "compact" | "normal";
  previewZoomable?: boolean;
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
    }
  }

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2">
        <TextField.Root
          placeholder={placeholder ?? "Path or URL"}
          style={{ flex: 1 }}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <Button
          disabled={isUploading}
          type="button"
          variant="soft"
          onClick={() => inputRef.current?.click()}
        >
          <FileUp {...iconProps} />
          {isUploading ? "Uploading" : "Upload"}
        </Button>
      </Flex>
      <input
        ref={inputRef}
        accept={accept}
        className="visually-hidden"
        type="file"
        onChange={(event) => {
          void handleFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {preview && value ? (
        <MediaPreview
          label={previewLabel ?? "Preview"}
          size={previewSize}
          type={preview}
          value={value}
          zoomable={previewZoomable && preview === "image"}
          onDelete={() => onChange("")}
        />
      ) : null}
    </Flex>
  );
}
