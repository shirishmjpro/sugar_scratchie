import { Button, Flex, Text } from "@radix-ui/themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  drawMeshLines,
  parseTrackedMesh,
  sampleMeshUvToWorld,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
  trackedWorldToUv,
  type SymbolPoint,
  type TrackedMesh,
  type Vec2,
} from "../meshGeometry";
import { api } from "../shared/api";

type SymbolPointsResponse = {
  points: SymbolPoint[];
  required: number;
  complete: boolean;
};

type SymbolPointPickerProps = {
  cardId: string;
  foregroundVideo: string;
  meshJsonPath: string;
  onSaved: () => void;
  onError: (message: string) => void;
};

function canvasPointFromEvent(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Vec2 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
  };
}

export function SymbolPointPicker({
  cardId,
  foregroundVideo,
  meshJsonPath,
  onSaved,
  onError,
}: SymbolPointPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const meshRef = useRef<TrackedMesh | null>(null);
  const [points, setPoints] = useState<SymbolPoint[]>([]);
  const [mesh, setMesh] = useState<TrackedMesh | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [meshTime, setMeshTime] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      const [meshResponse, pointsResponse] = await Promise.all([
        fetch(meshJsonPath, { cache: "no-store" }),
        api<SymbolPointsResponse>(
          `/api/video-flow/${encodeURIComponent(cardId)}/symbol-points`,
        ),
      ]);
      if (!meshResponse.ok) {
        throw new Error(`Mesh not found (${meshResponse.status})`);
      }
      const meshData = parseTrackedMesh(await meshResponse.json());
      if (!meshData) {
        throw new Error("Invalid mesh JSON");
      }
      meshRef.current = meshData;
      setMesh(meshData);
      setPoints(pointsResponse.points);
      const refTime = meshData.frames[Math.floor(meshData.frames.length / 2)]?.t ?? 0;
      setMeshTime(refTime);
    } catch (caught) {
      meshRef.current = null;
      setMesh(null);
      setPoints([]);
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [cardId, meshJsonPath, onError]);

  useEffect(() => {
    void loadData();
  }, [loadData, reloadToken]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const meshNow = meshRef.current;
    if (!canvas || !meshNow) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sample = sampleTrackedMesh(meshNow, meshTime);
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (showMesh) {
      drawMeshLines(ctx, sample);
    }
    if (showPoints) {
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const world = sampleMeshUvToWorld(sample, point.u, point.v);
        ctx.beginPath();
        ctx.arc(world.x, world.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 217, 120, 0.9)";
        ctx.fill();
        ctx.strokeStyle = "rgba(20, 18, 16, 0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#141210";
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(index + 1), world.x, world.y);
      }
    }
  }, [meshTime, points, showMesh, showPoints]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setMeshTime(video.currentTime);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [mesh]);

  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (points.length >= SYMBOL_POINT_COUNT) return;
    const canvas = canvasRef.current;
    const meshNow = meshRef.current;
    if (!canvas || !meshNow) return;
    const world = canvasPointFromEvent(canvas, event.clientX, event.clientY);
    if (!world) return;
    const sample = sampleTrackedMesh(meshNow, meshTime);
    const uv = trackedWorldToUv(sample, world);
    if (!uv) return;
    setPoints((current) => [...current, { u: uv.x, v: uv.y }]);
  }

  async function handleSave() {
    if (points.length !== SYMBOL_POINT_COUNT) return;
    setSaving(true);
    onError("");
    try {
      await api(`/api/video-flow/${encodeURIComponent(cardId)}/symbol-points`, {
        method: "POST",
        body: JSON.stringify({ points }),
      });
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Text size="2">Loading mesh…</Text>;
  }

  if (!mesh) {
    return (
      <Text size="2" color="red">
        Mesh unavailable — generate mesh first.
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="3">
      <Text size="2" color="gray">
        Click on the garment to place {SYMBOL_POINT_COUNT} symbol points. Coordinates are stored in
        mesh UV space and follow the body at runtime — nothing is baked into the video.
      </Text>

      <div className="symbol-picker-stage">
        <video
          ref={videoRef}
          className="symbol-picker-video"
          src={foregroundVideo}
          muted
          playsInline
          loop
          autoPlay
        />
        <canvas
          ref={canvasRef}
          className="symbol-picker-canvas"
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onClick={handleCanvasClick}
        />
      </div>

      <Flex gap="2" wrap="wrap">
        <Button type="button" variant="soft" onClick={() => setShowMesh((current) => !current)}>
          {showMesh ? "Hide mesh" : "Show mesh"}
        </Button>
        <Button type="button" variant="soft" onClick={() => setShowPoints((current) => !current)}>
          {showPoints ? "Hide points" : "Show points"}
        </Button>
        <Button type="button" variant="soft" onClick={() => setReloadToken((current) => current + 1)}>
          Reload mesh
        </Button>
        <Button
          type="button"
          variant="soft"
          disabled={points.length === 0}
          onClick={() => setPoints((current) => current.slice(0, -1))}
        >
          Clear last
        </Button>
        <Button
          type="button"
          variant="soft"
          color="red"
          disabled={points.length === 0}
          onClick={() => setPoints([])}
        >
          Clear all
        </Button>
      </Flex>

      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Text size="2" weight="medium">
          {points.length}/{SYMBOL_POINT_COUNT} points placed
        </Text>
        <Button
          type="button"
          disabled={points.length !== SYMBOL_POINT_COUNT || saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save & continue"}
        </Button>
      </Flex>
    </Flex>
  );
}
