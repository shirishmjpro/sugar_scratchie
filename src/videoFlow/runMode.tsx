import { Check, ChevronDown, ImagePlus, Loader2, Play, RotateCcw, Trash2 } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Flex,
  Grid,
  Heading,
  Select,
  Separator,
  Tabs,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/api";
import { deleteCardPhoto, uploadCardPhoto, type PhotoInfo } from "../shared/models";
import { flowStepBadge, type FlowNodeRuntime } from "./flowCanvas";
import {
  COMPRESS_PRESETS,
  nodeToStep,
  stepToNode,
  type CompressPreset,
  type FlowNodeId,
  type VideoFlowJson,
  type VideoFlowStepKey,
} from "./schema";
import type { CompressReport } from "./projects";
import { MaskEditor } from "./MaskEditor";
import { MeshTunePanel } from "./MeshTunePanel";
import { meshTuneToApi, type MeshTuneSettings } from "./meshTune";
import { SymbolPointPicker } from "./SymbolPointPicker";
import { Field, FilePathPicker, iconProps, MediaPreview, MESH_TRACKERS, MESH_TRACKER_MODES, meshTrackerFromArtifact, meshTrackerModeLabel, type MeshTracker, type MeshTrackerMode } from "./ui";
import { isStockPortraitPrompt, storedDraftFromApi, wavespeedPipelineModelValue, type AiProvider, type BackgroundVideoModel, type DressVideoModel, type SourceImageMode, type SourceImageModel, type StoredVideoFlowDraft } from "./storage";

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type VideoFlowStepState = {
  status: "locked" | "ready" | "review" | "approved";
  label: string;
  artifacts: string[];
};

type VideoFlowState = {
  card_id: string;
  approved: VideoFlowStepKey[];
  steps: Record<VideoFlowStepKey, VideoFlowStepState>;
  complete: boolean;
  mesh_compare?: { path: string; tracker: string; active: boolean }[];
  compress_report?: CompressReport | null;
  recovered_approvals?: boolean;
};

function CompressReportPanel({ report }: { report: CompressReport }) {
  const beforeBg = report.before?.background;
  const beforeFg = report.before?.foreground;
  const afterBg = report.after?.background;
  const afterFg = report.after?.foreground;
  const ratioPct =
    typeof report.size_ratio === "number" ? Math.round(report.size_ratio * 100) : null;
  const targetLabel =
    report.target_width && report.target_height
      ? `${report.target_width}×${report.target_height}`
      : report.target_width
        ? `${report.target_width}px`
        : "?";

  return (
    <Callout.Root color={report.aspect_ok === false ? "orange" : "green"}>
      <Callout.Text size="2">
        <strong>Last finalize:</strong> {report.preset_label ?? report.preset ?? "delivery"} ·{" "}
        {targetLabel}
        {report.aspect ? ` (${report.aspect})` : ""} · {report.fit ?? "cover-crop"} · CRF{" "}
        {report.crf ?? "?"}
        {report.write_webm ? " · WebM on" : " · WebM off"}
      </Callout.Text>
      <Box mt="2">
        <Grid columns="2" gap="3">
          <Box>
            <Text size="1" color="gray" weight="medium">
              Before
            </Text>
            <Text as="div" size="2">
              BG {beforeBg?.width ?? "?"}×{beforeBg?.height ?? "?"} · {beforeBg?.size ?? "—"}
            </Text>
            <Text as="div" size="2">
              FG {beforeFg?.width ?? "?"}×{beforeFg?.height ?? "?"} · {beforeFg?.size ?? "—"}
            </Text>
          </Box>
          <Box>
            <Text size="1" color="gray" weight="medium">
              After
            </Text>
            <Text as="div" size="2">
              BG {afterBg?.width ?? "?"}×{afterBg?.height ?? "?"} · {afterBg?.size ?? "—"}
            </Text>
            <Text as="div" size="2">
              FG {afterFg?.width ?? "?"}×{afterFg?.height ?? "?"} · {afterFg?.size ?? "—"}
            </Text>
          </Box>
        </Grid>
        <Text as="div" size="2" mt="2">
          Saved {report.saved ?? "—"}
          {ratioPct != null ? ` · now ${ratioPct}% of original` : ""}
          {typeof report.duration_delta_before === "number" && report.duration_delta_before > 0.05
            ? ` · synced ${report.duration_delta_before.toFixed(2)}s timing drift`
            : ""}
          {report.aspect_ok === false ? " · warning: output size mismatch" : ""}
        </Text>
      </Box>
    </Callout.Root>
  );
}

function flowStepFromJobCommand(command: string[]): VideoFlowStepKey | null {
  if (command[0] !== "video-flow-step") return null;
  const step = command[1];
  if (step === "background" || step === "dress" || step === "compress" || step === "card" || step === "mesh" || step === "symbols") {
    return step;
  }
  return null;
}

function nextPipelineStep(
  flow: VideoFlowJson,
  current: VideoFlowStepKey,
): VideoFlowStepKey | null {
  const index = flow.pipeline.indexOf(current);
  if (index < 0 || index >= flow.pipeline.length - 1) return null;
  return flow.pipeline[index + 1] ?? null;
}

function formatSourceImageJobError(log: string | undefined): string {
  if (!log) return "Source image job failed — check the Jobs tab for details.";
  const fullLog = (log || "").replace(/^Job runner error: /, "");
  const cleaned = fullLog.split("\n").pop()?.trim() || fullLog;
  const lowered = cleaned.toLowerCase();
  if (lowered.includes("both wavespeed and x.ai blocked")) {
    return cleaned.replace(/^Job runner error: /, "");
  }
  if (
    lowered.includes("content moderation") ||
    lowered.includes("potentially sensitive") ||
    lowered.includes("flagged as potentially sensitive")
  ) {
    const triedFallback = /retrying via x\.ai/i.test(log || "");
    return (
      (triedFallback
        ? "WaveSpeed and x.ai both blocked this prompt (content moderation). "
        : "Image generation was blocked (content moderation). ") +
      "Use a neutral, fully-clothed studio portrait prompt, or upload a source image instead."
    );
  }
  const wavespeedFailed = cleaned.match(/WaveSpeed [^:]+ failed: (.+)$/);
  if (wavespeedFailed?.[1]) return wavespeedFailed[1];
  return cleaned;
}

function formatStepJobError(log: string | undefined, step: VideoFlowStepKey | null): string {
  if (!log) return "Step failed — check the Jobs tab for details.";
  const cleaned = log.replace(/^Job runner error: /, "").trim();
  const lowered = cleaned.toLowerCase();
  if (step === "dress" && lowered.includes("content moderation")) {
    if (
      lowered.includes("switch step 2") ||
      lowered.includes("wan 2.2") ||
      lowered.includes("wavespeed")
    ) {
      return cleaned;
    }
    return `${cleaned} Step 2 sends your approved bikini clip to the API — x.ai scans the video frames, not just your dress prompt. Switch to WaveSpeed WAN 2.2 Video Edit above.`;
  }
  return cleaned;
}

function SourceImageProviderFields({
  aiProvider,
  sourceImageModel,
  backgroundVideoModel,
  onAiProviderChange,
  onSourceImageModelChange,
  onBackgroundVideoModelChange,
}: {
  aiProvider: AiProvider;
  sourceImageModel: SourceImageModel;
  backgroundVideoModel: BackgroundVideoModel;
  onAiProviderChange: (value: AiProvider) => void;
  onSourceImageModelChange: (value: SourceImageModel) => void;
  onBackgroundVideoModelChange: (value: BackgroundVideoModel) => void;
}) {
  const pipelineModel = wavespeedPipelineModelValue(sourceImageModel, backgroundVideoModel);

  return (
    <>
      <Field label="Provider">
        <Select.Root value={aiProvider} onValueChange={(value) => onAiProviderChange(value as AiProvider)}>
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="xai">x.ai</Select.Item>
            <Select.Item value="wavespeed">WaveSpeed</Select.Item>
          </Select.Content>
        </Select.Root>
      </Field>
      {aiProvider === "wavespeed" ? (
        <Field label="Image model">
          <Select.Root
            value={pipelineModel}
            onValueChange={(value) => {
              if (value === "wan-2.2-spicy") {
                onBackgroundVideoModelChange("wan-2.2-spicy");
                return;
              }
              onSourceImageModelChange(value as SourceImageModel);
              onBackgroundVideoModelChange("grok-imagine");
            }}
          >
            <Select.Trigger />
            <Select.Content>
              <Select.Item value="grok-imagine">Grok Imagine</Select.Item>
              <Select.Item value="seedream-v5-lite">Seedream v5.0 Lite</Select.Item>
              <Select.Item value="wan-2.2-spicy">WAN 2.2 Spicy (Step 1 video)</Select.Item>
            </Select.Content>
          </Select.Root>
        </Field>
      ) : (
        <Text color="gray" size="2">
          Seedream v5.0 Lite and WAN 2.2 Spicy are available under the WaveSpeed provider.
        </Text>
      )}
      {aiProvider === "wavespeed" && backgroundVideoModel === "wan-2.2-spicy" ? (
        <Callout.Root color="blue">
          <Callout.Text>
            WAN 2.2 Spicy animates your source portrait on <strong>Step 1 (image to video)</strong> via
            WaveSpeed — not for still portraits. Use Grok Imagine or Seedream above to generate the source
            image first.
          </Callout.Text>
        </Callout.Root>
      ) : null}
    </>
  );
}

function resolveFlowNodeStatuses(
  flow: VideoFlowJson,
  flowState: VideoFlowState | null,
  image: boolean,
  cardId: string,
  runningStep: VideoFlowStepKey | null,
  failedStep: VideoFlowStepKey | null,
): Record<FlowNodeId, FlowNodeRuntime> {
  const stepToNodeMap = stepToNode(flow);
  const next = Object.fromEntries(
    flow.nodes.map((node) => [node.id, "locked" as FlowNodeRuntime]),
  ) as Record<FlowNodeId, FlowNodeRuntime>;

  next.source = image && cardId ? "ready" : image ? "ready" : "idle";
  next.output = flowState?.complete ? "approved" : "idle";

  if (!cardId.trim()) {
    next.source = image ? "idle" : "idle";
    return next;
  }

  // Ignore leftover state from the previous card while the new one loads.
  const stateForCard =
    flowState && flowState.card_id === cardId.trim() ? flowState : null;

  if (!stateForCard) {
    const firstStep = flow.pipeline[0];
    const firstNode = firstStep ? stepToNodeMap[firstStep] : undefined;
    if (firstNode) next[firstNode] = image ? "ready" : "locked";
    return next;
  }

  for (const [step, nodeId] of Object.entries(stepToNodeMap) as [VideoFlowStepKey, FlowNodeId][]) {
    const stepState = stateForCard.steps[step];
    if (
      runningStep === step &&
      stepState?.status !== "locked"
    ) {
      next[nodeId] = "running";
      continue;
    }
    if (failedStep === step) {
      next[nodeId] = "failed";
      continue;
    }
    if (stepState) next[nodeId] = stepState.status;
  }

  next.output = stateForCard.complete ? "approved" : "idle";
  return next;
}

type MeshCompareEntry = { path: string; tracker: MeshTracker; active?: boolean };

function MeshTrackerComparePanel({
  artifacts,
  cardId,
  jobBusy,
  meshApproved,
  onApprove,
  onReject,
  onError,
}: {
  artifacts: MeshCompareEntry[];
  cardId: string;
  jobBusy: boolean;
  meshApproved: boolean;
  onApprove: (tracker: MeshTracker) => void;
  onReject?: () => void;
  onError: (message: string) => void;
}) {
  const activeTracker = artifacts.find((entry) => entry.active)?.tracker;
  const readyToPick = meshApproved ? artifacts.length >= 2 : artifacts.length >= 3;
  const foregroundVideo = `/cards/${encodeURIComponent(cardId)}/foreground.mp4`;

  return (
    <Callout.Root color="amber" className="flow-review-panel">
      <Callout.Text weight="bold">
        {meshApproved
          ? readyToPick
            ? "Compare scratch masks side by side — switch tracker with Use when you find a better fit."
            : "Generate another tracker above to compare with your current mesh."
          : readyToPick
            ? "Three meshes are ready — preview scratch masks and pick the best tracker."
            : `${artifacts.length}/3 mesh candidates ready — waiting for the rest…`}
      </Callout.Text>
      {artifacts.length ? (
        <Tabs.Root defaultValue={artifacts[0]?.tracker ?? "bootstapir"} mt="3">
          <Tabs.List>
            {artifacts.map(({ tracker: meshTracker, active }) => (
              <Tabs.Trigger key={meshTracker} value={meshTracker}>
                {meshTracker}
                {active ? (
                  <Badge ml="2" size="1" color="green">
                    active
                  </Badge>
                ) : null}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {artifacts.map(({ path, tracker: meshTracker, active }) => (
            <Tabs.Content key={meshTracker} value={meshTracker}>
              <Flex direction="column" gap="3" mt="3">
                <MaskEditor
                  title={`${meshTracker} mesh`}
                  meshFile={path.split("/").pop() ?? path}
                  meshSavePath={path}
                  meshUrl={`/api/files/preview?path=${encodeURIComponent(path)}`}
                  videoSrc={foregroundVideo}
                  onError={onError}
                />
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    disabled={jobBusy || !readyToPick || active}
                    type="button"
                    onClick={() => onApprove(meshTracker)}
                  >
                    <Check {...iconProps} />
                    Use {meshTracker}
                  </Button>
                  {onReject ? (
                    <Button
                      disabled={jobBusy}
                      type="button"
                      color="red"
                      variant="soft"
                      onClick={onReject}
                    >
                      Re-run step
                    </Button>
                  ) : null}
                </Flex>
                {meshApproved && active ? (
                  <Text color="gray" size="2">
                    This is the mesh currently published to <Code>public/mesh/</Code>. Switching
                    invalidates symbol placement and compress — re-run those steps after you pick a
                    different tracker.
                  </Text>
                ) : null}
              </Flex>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      ) : null}
    </Callout.Root>
  );
}

function MeshJobProgress({ logs }: { logs: string[] }) {
  const tail = logs.slice(-14);
  return (
    <Callout.Root color="blue">
      <Callout.Text weight="bold">Mesh generation running — this can take several minutes.</Callout.Text>
      <Box
        asChild
        mt="3"
        style={{
          maxHeight: 220,
          overflow: "auto",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
        }}
      >
        <pre>{tail.join("\n") || "Starting…"}</pre>
      </Box>
    </Callout.Root>
  );
}

type RunModeProps = {
  flow: VideoFlowJson;
  jobs: JobInfo[];
  canUseGrok: boolean;
  canUseSourceAi: boolean;
  canUseWavespeed: boolean;
  aiProvider: AiProvider;
  sourceImageModel: SourceImageModel;
  backgroundVideoModel: BackgroundVideoModel;
  dressVideoModel: DressVideoModel;
  enhancePrompt: boolean;
  image: string;
  backgroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  modelId: string;
  writeWebm: boolean;
  compressPreset: CompressPreset;
  resolution: string;
  tracker: MeshTrackerMode;
  meshTune: MeshTuneSettings;
  sourceMode: SourceImageMode;
  sourcePrompt: string;
  faceImage: string;
  baseImage: string;
  onImageChange: (value: string) => void;
  onBackgroundMotionPromptChange: (value: string) => void;
  onDressPromptChange: (value: string) => void;
  onDressReferenceImageChange: (value: string) => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onWriteWebmChange: (value: boolean) => void;
  onCompressPresetChange: (value: CompressPreset) => void;
  onTrackerChange: (value: MeshTrackerMode) => void;
  onMeshTuneChange: (value: MeshTuneSettings) => void;
  onResolutionChange: (value: string) => void;
  onSourceModeChange: (value: SourceImageMode) => void;
  onSourcePromptChange: (value: string) => void;
  onFaceImageChange: (value: string) => void;
  onBaseImageChange: (value: string) => void;
  onAiProviderChange: (value: AiProvider) => void;
  onSourceImageModelChange: (value: SourceImageModel) => void;
  onBackgroundVideoModelChange: (value: BackgroundVideoModel) => void;
  onDressVideoModelChange: (value: DressVideoModel) => void;
  onEnhancePromptChange: (value: boolean) => void;
  onApplyDraft: (draft: StoredVideoFlowDraft) => void;
  onRefreshJobs: () => Promise<void>;
  onRefreshAssets: () => Promise<void>;
  onError: (message: string) => void;
};

type CardApiEntry = {
  id: string;
  label: string;
  photos?: PhotoInfo[];
};

function CardPhotosPanel({
  cardId,
  onError,
}: {
  cardId: string;
  onError: (message: string) => void;
}) {
  const [photos, setPhotos] = useState<PhotoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshPhotos = async () => {
    if (!cardId.trim()) {
      setPhotos([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api<{ cards: CardApiEntry[] }>("/api/cards");
      const card = data.cards.find((entry) => entry.id === cardId.trim());
      setPhotos(card?.photos ?? []);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshPhotos();
  }, [cardId]);

  async function handleUpload(file: File) {
    if (!cardId.trim()) return;
    setUploading(true);
    onError("");
    try {
      await uploadCardPhoto(cardId.trim(), file);
      await refreshPhotos();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(photoId: string) {
    if (!cardId.trim()) return;
    onError("");
    try {
      await deleteCardPhoto(cardId.trim(), photoId);
      await refreshPhotos();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Card size="3">
      <Flex align="center" justify="between" mb="3">
        <Box>
          <Heading size="3">PhotoScratch photos</Heading>
          <Text color="gray" size="2">
            Optional still images attached to this motion card. Scratch mechanics come later.
          </Text>
        </Box>
        <Button
          disabled={!cardId.trim() || uploading}
          type="button"
          variant="soft"
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus {...iconProps} />
          Upload photo
        </Button>
        <input
          ref={inputRef}
          accept="image/jpeg,image/png,image/webp"
          hidden
          type="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void handleUpload(file);
          }}
        />
      </Flex>

      {loading ? (
        <Text color="gray" size="2">
          Loading photos…
        </Text>
      ) : photos.length === 0 ? (
        <Text color="gray" size="2">
          No photos yet. Upload images to build the PhotoScratch gallery for this card.
        </Text>
      ) : (
        <Grid columns={{ initial: "2", sm: "3", md: "4" }} gap="3">
          {photos.map((photo) => (
            <Box key={photo.id} className="video-flow-photo-thumb">
              <img alt="" src={photo.src} style={{ width: "100%", borderRadius: 8, display: "block" }} />
              <Button
                color="red"
                mt="2"
                size="1"
                type="button"
                variant="soft"
                onClick={() => void handleDelete(photo.id)}
              >
                <Trash2 {...iconProps} />
                Remove
              </Button>
            </Box>
          ))}
        </Grid>
      )}
    </Card>
  );
}

export function RunMode(props: RunModeProps) {
  const {
    flow,
    jobs,
    canUseGrok,
    canUseSourceAi,
    canUseWavespeed,
    aiProvider,
    sourceImageModel,
    backgroundVideoModel,
    dressVideoModel,
    enhancePrompt,
    image,
    backgroundMotionPrompt,
    dressPrompt,
    dressReferenceImage,
    cardId,
    cardLabel,
    modelId,
    writeWebm,
    compressPreset,
    resolution,
    tracker,
    meshTune,
    sourceMode,
    sourcePrompt,
    faceImage,
    baseImage,
    onImageChange,
    onBackgroundMotionPromptChange,
    onDressPromptChange,
    onDressReferenceImageChange,
    onCardIdChange,
    onCardLabelChange,
    onWriteWebmChange,
    onCompressPresetChange,
    onTrackerChange,
    onMeshTuneChange,
    onResolutionChange,
    onSourceModeChange,
    onSourcePromptChange,
    onFaceImageChange,
    onBaseImageChange,
    onAiProviderChange,
    onSourceImageModelChange,
    onBackgroundVideoModelChange,
    onDressVideoModelChange,
    onEnhancePromptChange,
    onApplyDraft,
    onRefreshJobs,
    onRefreshAssets,
    onError,
  } = props;

  const nodeToStepMap = useMemo(() => nodeToStep(flow), [flow]);
  const stepToNodeMap = useMemo(() => stepToNode(flow), [flow]);
  const reviewSteps = useMemo(() => new Set(flow.reviewSteps), [flow.reviewSteps]);

  const [activeNode, setActiveNode] = useState<FlowNodeId>("source");
  const [flowState, setFlowState] = useState<VideoFlowState | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [manualBackground, setManualBackground] = useState("");
  const [manualForeground, setManualForeground] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [showFaceSwapPrompt, setShowFaceSwapPrompt] = useState(false);
  const [showMeshAdvanced, setShowMeshAdvanced] = useState(false);
  const [sourceJobHandledId, setSourceJobHandledId] = useState("");
  const [compareTracker, setCompareTracker] = useState<MeshTracker>("cotracker");

  const sourceImageJob = useMemo(() => {
    const scoped = jobs.filter(
      (job) => job.kind === "generate-source-image" && job.command[1] === cardId.trim(),
    );
    return (
      scoped.find((job) => job.status === "running" || job.status === "queued") ??
      scoped[0] ??
      null
    );
  }, [jobs, cardId]);

  const sourceImageBusy =
    sourceImageJob?.status === "running" || sourceImageJob?.status === "queued";

  const stepJob = useMemo(() => {
    const scoped = jobs.filter(
      (job) => job.kind === "video-flow-step" && job.command[2] === cardId.trim(),
    );
    return (
      scoped.find((job) => job.status === "running" || job.status === "queued") ??
      scoped[0] ??
      null
    );
  }, [jobs, cardId]);

  const meshCandidateJob = useMemo(() => {
    const scoped = jobs.filter(
      (job) => job.kind === "video-flow-mesh-candidate" && job.command[2] === cardId.trim(),
    );
    return (
      scoped.find((job) => job.status === "running" || job.status === "queued") ??
      scoped[0] ??
      null
    );
  }, [jobs, cardId]);

  const meshCandidateRunning =
    meshCandidateJob?.status === "running" || meshCandidateJob?.status === "queued";

  const meshCompareCount = flowState?.mesh_compare?.length ?? 0;
  const meshStepApproved = flowState?.steps.mesh?.status === "approved";
  const meshInReview = flowState?.steps.mesh?.status === "review";
  // Only pin while the user still needs to pick a tracker. After approve, let
  // the pipeline advance to Place symbols / Compress.
  const meshComparePin = meshInReview && meshCompareCount >= 1;

  const [meshFocusOverride, setMeshFocusOverride] = useState(false);
  const shouldPinMesh = meshComparePin && !meshFocusOverride && !meshCandidateRunning;

  const handledStepJobId = useRef("");
  const handledMeshJobId = useRef("");
  // Tracks which card async flow-state fetches belong to.
  const desiredFlowCardIdRef = useRef(cardId.trim());

  const runningStep = useMemo(() => {
    if (!stepJob || stepJob.status === "queued" || stepJob.status === "running") {
      return flowStepFromJobCommand(stepJob?.command ?? []);
    }
    return null;
  }, [stepJob]);

  const staleRunningStep = useMemo(() => {
    if (!runningStep || !flowState) return null;
    return flowState.steps[runningStep]?.status === "locked" ? runningStep : null;
  }, [runningStep, flowState]);

  const activeRunningStep = staleRunningStep ? null : runningStep;

  const effectiveRunningStep: VideoFlowStepKey | null =
    activeRunningStep ?? (meshCandidateRunning ? "mesh" : null);

  const failedStep = useMemo(() => {
    if (stepJob?.status === "failed" || stepJob?.status === "cancelled") {
      return flowStepFromJobCommand(stepJob.command);
    }
    return null;
  }, [stepJob]);

  const refreshFlowState = async () => {
    const id = cardId.trim();
    if (!id) {
      setFlowState(null);
      return;
    }
    try {
      const data = await api<VideoFlowState>(`/api/video-flow/${encodeURIComponent(id)}/state`);
      // Ignore late responses from a previous card.
      if (desiredFlowCardIdRef.current !== id) return;
      setFlowState(data);
    } catch (caught) {
      if (desiredFlowCardIdRef.current !== id) return;
      setFlowState(null);
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    const id = cardId.trim();
    desiredFlowCardIdRef.current = id;
    // Don't null flowState here — that flashes every step as Locked while the
    // new card's state loads. Stale responses are ignored via desiredFlowCardIdRef.
    void refreshFlowState();
  }, [cardId]);

  useEffect(() => {
    if (!stepJob) return;
    if (stepJob.status === "succeeded" || stepJob.status === "failed" || stepJob.status === "cancelled") {
      void refreshFlowState();
      const finishedStep = flowStepFromJobCommand(stepJob.command);
      if (stepJob.status === "succeeded" && (finishedStep === "card" || finishedStep === "mesh")) {
        void onRefreshAssets();
      }
      if (
        stepJob.status === "succeeded" &&
        finishedStep &&
        handledStepJobId.current !== stepJob.id
      ) {
        handledStepJobId.current = stepJob.id;
        const nodeId = stepToNodeMap[finishedStep];
        if (nodeId) {
          if (reviewSteps.has(finishedStep) || (finishedStep === "mesh" && tracker === "all")) {
            if (finishedStep === "mesh") setMeshFocusOverride(false);
            setActiveNode(nodeId);
          } else {
            const next = nextPipelineStep(flow, finishedStep);
            const nextNode = next ? stepToNodeMap[next] : undefined;
            if (nextNode) setActiveNode(nextNode);
            else setActiveNode(nodeId);
          }
        }
      }
    }
  }, [flow, reviewSteps, stepJob?.id, stepJob?.status, stepToNodeMap, tracker]);

  useEffect(() => {
    if (stepJob) return;
    if (!meshCandidateJob) return;
    if (
      meshCandidateJob.status === "succeeded" ||
      meshCandidateJob.status === "failed" ||
      meshCandidateJob.status === "cancelled"
    ) {
      void refreshFlowState();
      if (meshCandidateJob.status === "succeeded") {
        void onRefreshAssets();
        if (handledMeshJobId.current !== meshCandidateJob.id) {
          handledMeshJobId.current = meshCandidateJob.id;
          const meshNode = stepToNodeMap.mesh;
          if (meshNode) {
            setMeshFocusOverride(false);
            setActiveNode(meshNode);
          }
        }
      }
    }
  }, [meshCandidateJob?.id, meshCandidateJob?.status, stepJob?.id, stepToNodeMap]);

  useEffect(() => {
    if (activeRunningStep !== "mesh" && !meshCandidateRunning) return;
    const timer = window.setInterval(() => {
      void refreshFlowState();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeRunningStep, meshCandidateRunning, cardId]);

  useEffect(() => {
    if (!sourceImageJob || sourceImageJob.status !== "succeeded") return;
    if (sourceJobHandledId === sourceImageJob.id) return;
    const id = cardId.trim();
    if (!id) return;
    setSourceJobHandledId(sourceImageJob.id);
    void (async () => {
      try {
        const data = await api<{ draft: NonNullable<Parameters<typeof storedDraftFromApi>[0]> }>(
          `/api/video-flow/${encodeURIComponent(id)}/draft`,
        );
        if (desiredFlowCardIdRef.current !== id) return;
        const parsed = storedDraftFromApi(data.draft);
        if (parsed && parsed.cardId === id) onApplyDraft(parsed);
        if (desiredFlowCardIdRef.current !== id) return;
        const stateData = await api<VideoFlowState>(`/api/video-flow/${encodeURIComponent(id)}/state`);
        if (desiredFlowCardIdRef.current !== id) return;
        setFlowState(stateData);
      } catch (caught) {
        if (desiredFlowCardIdRef.current !== id) return;
        onError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [cardId, onApplyDraft, onError, sourceImageJob, sourceJobHandledId]);

  // Intentionally no auto-reject on image change. Draft loads / card switches
  // used to look like edits and wipe published cards. Use Remake step instead.

  useEffect(() => {
    if (failedStep && stepToNodeMap[failedStep]) {
      setActiveNode(stepToNodeMap[failedStep]!);
      return;
    }
    if (shouldPinMesh && stepToNodeMap.mesh) {
      setActiveNode(stepToNodeMap.mesh);
    }
  }, [failedStep, shouldPinMesh, stepToNodeMap]);

  useEffect(() => {
    if (!staleRunningStep || !stepJob) return;
    void (async () => {
      try {
        await api(`/api/jobs/${encodeURIComponent(stepJob.id)}/cancel`, { method: "POST" });
        await onRefreshJobs();
      } catch {
        // Ignore — job may have finished between render and cancel.
      }
    })();
  }, [staleRunningStep, stepJob?.id, onRefreshJobs]);

  const nodeStates = useMemo(
    () =>
      resolveFlowNodeStatuses(
        flow,
        flowState,
        Boolean(image),
        cardId.trim(),
        effectiveRunningStep,
        failedStep,
      ),
    [flow, flowState, image, cardId, effectiveRunningStep, failedStep],
  );

  const activeMeta = flow.nodes.find((node) => node.id === activeNode) ?? flow.nodes[0];
  const activeStep = nodeToStepMap[activeNode];
  const jobBusy =
    ((stepJob?.status === "running" || stepJob?.status === "queued") && !staleRunningStep) ||
    meshCandidateRunning ||
    flowBusy;

  const firstActionStep = useMemo(() => {
    if (!flowState) return flow.pipeline[0] ?? null;
    for (const step of flow.pipeline) {
      const status = flowState.steps[step]?.status;
      if (status === "review" || status === "ready") return step;
    }
    return null;
  }, [flow, flowState]);

  const actionStep: VideoFlowStepKey | null = activeStep ?? firstActionStep;
  const actionStatus =
    actionStep && effectiveRunningStep === actionStep
      ? "running"
      : actionStep && failedStep === actionStep
        ? "failed"
        : actionStep
          ? (flowState?.steps[actionStep]?.status ?? "ready")
          : null;
  const actionStepState = actionStep ? flowState?.steps[actionStep] : undefined;
  const actionPreviewArtifacts = actionStepState?.artifacts ?? [];
  const actionNeedsGrok =
    (actionStep === "dress" && dressVideoModel === "grok-imagine") ||
    (actionStep === "background" && backgroundVideoModel === "grok-imagine");
  const actionNeedsWavespeed =
    (actionStep === "dress" && dressVideoModel === "wan-2.2-video-edit") ||
    (actionStep === "background" && backgroundVideoModel === "wan-2.2-spicy");
  const canUseBackgroundVideo =
    backgroundVideoModel === "wan-2.2-spicy" ? canUseWavespeed : canUseGrok;
  const canUseDressVideo =
    dressVideoModel === "wan-2.2-video-edit" ? canUseWavespeed : canUseGrok;
  const actionIsInteractive = actionStep === "symbols";

  const meshCompareArtifacts = useMemo((): MeshCompareEntry[] => {
    if (flowState?.mesh_compare?.length) {
      return flowState.mesh_compare.flatMap((entry) => {
        const meshTracker = entry.tracker as MeshTracker;
        if (!MESH_TRACKERS.includes(meshTracker)) return [];
        return [{ path: entry.path, tracker: meshTracker, active: entry.active }];
      });
    }
    const artifacts = flowState?.steps.mesh?.artifacts ?? [];
    return artifacts.flatMap((path) => {
      const meshTracker = meshTrackerFromArtifact(path);
      return meshTracker ? [{ path, tracker: meshTracker }] : [];
    });
  }, [flowState?.mesh_compare, flowState?.steps.mesh?.artifacts]);

  const meshCompareReady = meshCompareArtifacts.length >= 1;
  const existingCompareTrackers = useMemo(
    () => new Set(meshCompareArtifacts.map((entry) => entry.tracker)),
    [meshCompareArtifacts],
  );
  const compareTrackerExists = existingCompareTrackers.has(compareTracker);

  useEffect(() => {
    if (MESH_TRACKERS.includes(compareTracker)) return;
    setCompareTracker(MESH_TRACKERS[0]!);
  }, [compareTracker]);

  const meshJobRunning =
    (activeRunningStep === "mesh" &&
      (stepJob?.status === "running" || stepJob?.status === "queued")) ||
    meshCandidateRunning;

  const stepPayload = {
    image,
    background_motion_prompt: backgroundMotionPrompt,
    foreground_motion_prompt: backgroundMotionPrompt,
    dress_prompt: dressPrompt,
    dress_reference_image: dressReferenceImage,
    card_id: cardId.trim(),
    card_label: cardLabel.trim(),
    model_id: modelId.trim(),
    resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker,
    write_webm: writeWebm,
    compress_preset: compressPreset,
    mesh_tune: meshTuneToApi(meshTune),
    source_mode: sourceMode,
    source_prompt: sourcePrompt,
    face_image: faceImage,
    base_image: baseImage,
    provider: aiProvider,
    image_model: sourceImageModel,
    background_video_model: backgroundVideoModel,
    dress_video_model: dressVideoModel,
  };

  const stepApiReady =
    actionStep === "background"
      ? canUseBackgroundVideo
      : actionStep === "dress"
        ? canUseDressVideo
        : true;

  const canGeneratePromptImage = Boolean(cardId.trim() && canUseSourceAi && !sourceImageBusy);
  const canGenerateFaceSwap = Boolean(
    cardId.trim() && baseImage.trim() && faceImage.trim() && canUseSourceAi && !sourceImageBusy,
  );

  async function generateSourceImage(mode: "prompt" | "face_swap") {
    const id = cardId.trim();
    if (!id) return;
    setFlowBusy(true);
    onError("");
    try {
      await api<JobInfo>("/api/jobs/generate-source-image", {
        method: "POST",
        body: JSON.stringify({
          mode,
          card_id: id,
          prompt:
            mode === "face_swap" && !showFaceSwapPrompt
              ? ""
              : mode === "face_swap" && isStockPortraitPrompt(sourcePrompt)
                ? ""
                : sourcePrompt.trim(),
          face_image: faceImage.trim(),
          base_image: baseImage.trim(),
          aspect_ratio: "9:16",
          provider: aiProvider,
          image_model: sourceImageModel,
        }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  const cardApproved = Boolean(flowState?.approved?.includes("card"));
  const needsSourceImage =
    actionStep === "background" || actionStep === "dress" || actionStep === "card";

  const canRunActionStep = Boolean(
    actionStep &&
      !actionIsInteractive &&
      cardId.trim() &&
      cardLabel.trim() &&
      (!needsSourceImage || image) &&
      (!actionNeedsGrok || canUseGrok) &&
      (!actionNeedsWavespeed || canUseWavespeed) &&
      stepApiReady &&
      actionStatus === "ready" &&
      !jobBusy,
  );

  const canRemakeActionStep = Boolean(
    actionStep &&
      cardId.trim() &&
      cardLabel.trim() &&
      (!needsSourceImage || image) &&
      (!actionNeedsGrok || canUseGrok) &&
      (!actionNeedsWavespeed || canUseWavespeed) &&
      stepApiReady &&
      actionStatus === "approved" &&
      !jobBusy,
  );

  const canImportManualClips = Boolean(
    cardId.trim() &&
      cardLabel.trim() &&
      manualBackground.trim() &&
      manualForeground.trim() &&
      !importBusy &&
      !jobBusy,
  );

  async function importManualClips() {
    const id = cardId.trim();
    if (!id || !canImportManualClips) return;
    setImportBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(id)}/import-clips`,
        {
          method: "POST",
          body: JSON.stringify({
            background: manualBackground.trim(),
            foreground: manualForeground.trim(),
            card_label: cardLabel.trim(),
            model_id: modelId.trim(),
          }),
        },
      );
      setFlowState(next);
      setManualBackground("");
      setManualForeground("");
      await onRefreshAssets();
      selectStep("mesh");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportBusy(false);
    }
  }

  async function runStep(step: VideoFlowStepKey, force = false) {
    setFlowBusy(true);
    onError("");
    try {
      await api<JobInfo>("/api/jobs/video-flow/step", {
        method: "POST",
        body: JSON.stringify({ ...stepPayload, step, force }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function generateMeshCandidate() {
    const id = cardId.trim();
    if (!id) return;
    setFlowBusy(true);
    onError("");
    try {
      await api<JobInfo>("/api/jobs/video-flow/mesh-candidate", {
        method: "POST",
        body: JSON.stringify({
          card_id: id,
          card_label: cardLabel.trim(),
          tracker: compareTracker,
          mesh_tune: meshTuneToApi(meshTune),
          force: true,
        }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function approveStep(step: VideoFlowStepKey, meshTracker?: MeshTracker) {
    if (!cardId.trim()) return;
    setFlowBusy(true);
    onError("");
    try {
      const data = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId.trim())}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            step,
            ...(meshTracker ? { mesh_tracker: meshTracker } : {}),
          }),
        },
      );
      setFlowState(data);
      const next = nextPipelineStep(flow, step);
      if (next && data.steps[next]?.status === "ready") {
        const nodeId = stepToNodeMap[next];
        if (nodeId) {
          // Leaving mesh after approve — don't let compare-pin yank us back.
          if (step === "mesh") setMeshFocusOverride(true);
          setActiveNode(nodeId);
        }
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function approveFocusClip() {
    if (!actionStep) return;
    await approveStep(actionStep);
  }

  async function rejectStep(step: VideoFlowStepKey) {
    if (!cardId.trim()) return;
    setFlowBusy(true);
    onError("");
    try {
      const data = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId.trim())}/reject`,
        { method: "POST", body: JSON.stringify({ step }) },
      );
      setFlowState(data);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function rejectFocusClip() {
    if (!actionStep) return;
    await rejectStep(actionStep);
  }

  function stepListStatus(step: VideoFlowStepKey): FlowNodeRuntime {
    const nodeId = stepToNodeMap[step];
    return nodeId ? nodeStates[nodeId] ?? "locked" : "locked";
  }

  function selectStep(step: VideoFlowStepKey | "source") {
    if (step === "source") {
      setMeshFocusOverride(true);
      setActiveNode("source");
      return;
    }
    if (flowState?.steps[step]?.status === "locked") return;
    if (step !== "mesh" && meshComparePin) setMeshFocusOverride(true);
    else if (step === "mesh") setMeshFocusOverride(false);
    const nodeId = stepToNodeMap[step];
    if (nodeId) setActiveNode(nodeId);
  }

  return (
    <Flex direction="column" gap="4">
      <div className="video-flow-run-layout">
        <aside className="video-flow-run-steps">
          <Text size="2" weight="bold" mb="3">
            Pipeline
          </Text>
          <button
            type="button"
            className={["video-flow-run-step", activeNode === "source" ? "is-active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => selectStep("source")}
          >
            <span className="video-flow-run-step-num">0</span>
            <span className="video-flow-run-step-body">
              <strong>Setup</strong>
              <span>Source image & card id</span>
            </span>
          </button>
          {flow.pipeline.map((step, index) => {
            const status = stepListStatus(step);
            const node = flow.nodes.find((entry) => entry.step === step);
            const badge = flowStepBadge(status);
            return (
              <button
                key={step}
                type="button"
                className={[
                  "video-flow-run-step",
                  `is-${status}`,
                  activeStep === step ? "is-active" : "",
                  status === "locked" && step !== "card" ? "is-disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={status === "locked" && step !== "card"}
                onClick={() => selectStep(step)}
              >
                <span className="video-flow-run-step-num">{index + 1}</span>
                <span className="video-flow-run-step-body">
                  <strong>{node?.title ?? step}</strong>
                  <span>{node?.subtitle ?? step}</span>
                </span>
                <Badge color={badge.color} size="1">
                  {badge.label}
                </Badge>
              </button>
            );
          })}
        </aside>

        <section className="video-flow-run-detail">
          {staleRunningStep && stepJob ? (
            <Callout.Root color="orange" mb="4">
              <Callout.Text>
                A background job for{" "}
                <strong>{flowState?.steps[staleRunningStep]?.label ?? staleRunningStep}</strong> is
                out of date — finish approving the earlier steps first. Cancelling it…
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {actionStatus === "review" && actionStep && reviewSteps.has(actionStep) ? (
            <Callout.Root color="amber" className="flow-review-panel" mb="4">
              <Callout.Text weight="bold">Approve this clip before the next step runs.</Callout.Text>
              <Flex direction="column" gap="3" mt="3">
                {(actionPreviewArtifacts.length > 0
                  ? actionPreviewArtifacts
                  : flowState?.steps[actionStep]?.artifacts ?? []
                ).map((artifact) => (
                  <MediaPreview
                    key={artifact}
                    label={artifact.split("/").pop() ?? "Generated clip"}
                    type="video"
                    value={artifact}
                  />
                ))}
                <Flex align="center" gap="2" wrap="wrap">
                  <Button disabled={jobBusy} type="button" onClick={() => void approveFocusClip()}>
                    <Check {...iconProps} />
                    Use this clip
                  </Button>
                  <Button
                    disabled={jobBusy}
                    type="button"
                    color="red"
                    variant="soft"
                    onClick={() => void rejectFocusClip()}
                  >
                    Re-run step
                  </Button>
                </Flex>
              </Flex>
            </Callout.Root>
          ) : null}

          {flowState?.recovered_approvals ? (
            <Callout.Root color="green" mb="4">
              <Callout.Text>
                Your bikini clip, dress edit, and card were still on disk — pipeline approvals
                were restored automatically. You only need to retry the step that failed.
              </Callout.Text>
            </Callout.Root>
          ) : null}

          {actionStatus === "failed" && stepJob?.logs.length ? (
            <Callout.Root color="red" mb="4">
              <Callout.Text>
                {formatStepJobError(stepJob.logs[stepJob.logs.length - 1], actionStep)}
              </Callout.Text>
            </Callout.Root>
          ) : null}

          <div className="flow-editor">
            <div className="flow-editor-head">
              <Flex align="center" gap="2">
                <Badge color="gray">{activeMeta.kind}</Badge>
                <Heading size="4">{activeMeta.title}</Heading>
              </Flex>
              <Text color="gray" size="2">
                {activeMeta.description}
              </Text>
            </div>

        {activeStep && flowState?.steps[activeStep]?.status === "approved" ? (
          <Callout.Root color="blue" mb="4">
            <Callout.Text>
              This step is finished. Edit the prompt above if you want a different result, then click{" "}
              <strong>Remake step</strong>. Steps after this one will need to run again.
            </Callout.Text>
          </Callout.Root>
        ) : null}

        {activeNode === "source" ? (
          <Flex direction="column" gap="4">
            <Tabs.Root value={sourceMode} onValueChange={(value) => onSourceModeChange(value as SourceImageMode)}>
              <Tabs.List className="dashboard-tabs">
                <Tabs.Trigger value="upload">Upload</Tabs.Trigger>
                <Tabs.Trigger value="prompt">Generate from prompt</Tabs.Trigger>
                <Tabs.Trigger value="face_swap">Face swap</Tabs.Trigger>
              </Tabs.List>

              <Box pt="4">
                <Tabs.Content value="upload">
                  <Field label="Source image path or URL">
                    <FilePathPicker
                      accept="image/*"
                      placeholder="Pick an image or paste a path/URL"
                      preview="image"
                      previewLabel="Source image"
                      previewSize="compact"
                      previewZoomable
                      value={image}
                      onChange={onImageChange}
                      onError={onError}
                    />
                  </Field>
                </Tabs.Content>

                <Tabs.Content value="prompt">
                  <Flex direction="column" gap="4">
                    <SourceImageProviderFields
                      aiProvider={aiProvider}
                      sourceImageModel={sourceImageModel}
                      backgroundVideoModel={backgroundVideoModel}
                      onAiProviderChange={onAiProviderChange}
                      onSourceImageModelChange={onSourceImageModelChange}
                      onBackgroundVideoModelChange={onBackgroundVideoModelChange}
                    />
                    <Field label="Portrait prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={sourcePrompt}
                        onChange={(event) => onSourcePromptChange(event.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Optional face reference (steers identity)">
                      <FilePathPicker
                        accept="image/*"
                        placeholder="Pick a face photo or paste a path/URL"
                        preview="image"
                        previewLabel="Face reference"
                        previewSize="compact"
                        value={faceImage}
                        onChange={onFaceImageChange}
                        onError={onError}
                      />
                    </Field>
                    <Flex align="center" gap="3" wrap="wrap">
                      <Button
                        disabled={!canGeneratePromptImage}
                        type="button"
                        onClick={() => void generateSourceImage("prompt")}
                      >
                        {sourceImageBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                        Generate source image
                      </Button>
                      {!canUseSourceAi ? (
                        <Text color="gray" size="2">
                          {aiProvider === "xai"
                            ? "Add XAI_API_KEY to .env first."
                            : "Add WAVESPEED_API_KEY to .env first."}
                        </Text>
                      ) : null}
                    </Flex>
                    {sourceImageJob ? (
                      <Callout.Root
                        color={
                          sourceImageJob.status === "failed" || sourceImageJob.status === "cancelled"
                            ? "red"
                            : sourceImageJob.status === "succeeded"
                              ? "green"
                              : "blue"
                        }
                      >
                        <Callout.Text>
                          Source image job {sourceImageJob.status}
                          {sourceImageJob.status === "failed"
                            ? ` — ${formatSourceImageJobError(sourceImageJob.logs[sourceImageJob.logs.length - 1])}`
                            : ""}
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {image ? (
                      <MediaPreview
                        label="Resolved source image"
                        size="compact"
                        type="image"
                        value={image}
                        zoomable
                        onDelete={() => onImageChange("")}
                      />
                    ) : null}
                  </Flex>
                </Tabs.Content>

                <Tabs.Content value="face_swap">
                  <Flex direction="column" gap="4">
                    <SourceImageProviderFields
                      aiProvider={aiProvider}
                      sourceImageModel={sourceImageModel}
                      backgroundVideoModel={backgroundVideoModel}
                      onAiProviderChange={onAiProviderChange}
                      onSourceImageModelChange={onSourceImageModelChange}
                      onBackgroundVideoModelChange={onBackgroundVideoModelChange}
                    />
                    <Field label="Base image (body / scene to keep)">
                      <FilePathPicker
                        accept="image/*"
                        placeholder="Pick a body or scene photo"
                        preview="image"
                        previewLabel="Base image"
                        previewSize="compact"
                        value={baseImage}
                        onChange={onBaseImageChange}
                        onError={onError}
                      />
                    </Field>
                    <Field label="Face image">
                      <FilePathPicker
                        accept="image/*"
                        placeholder="Pick a face photo"
                        preview="image"
                        previewLabel="Face image"
                        previewSize="compact"
                        value={faceImage}
                        onChange={onFaceImageChange}
                        onError={onError}
                      />
                    </Field>
                    <label className="checkbox-label">
                      <Checkbox
                        checked={showFaceSwapPrompt}
                        onCheckedChange={(checked) => setShowFaceSwapPrompt(checked === true)}
                      />
                      Custom swap prompt (advanced)
                    </label>
                    {showFaceSwapPrompt ? (
                      <Field label="Face swap prompt">
                        <TextArea
                          className="dashboard-textarea"
                          placeholder="Leave empty for the default swap instruction"
                          value={sourcePrompt}
                          onChange={(event) => onSourcePromptChange(event.currentTarget.value)}
                        />
                      </Field>
                    ) : null}
                    <Callout.Root color="orange">
                      <Callout.Text>
                        Face swap can be rejected by xAI moderation depending on the photos. Try
                        neutral studio portraits, or upload a finished source image instead.
                      </Callout.Text>
                    </Callout.Root>
                    <Flex align="center" gap="3" wrap="wrap">
                      <Button
                        disabled={!canGenerateFaceSwap}
                        type="button"
                        onClick={() => void generateSourceImage("face_swap")}
                      >
                        {sourceImageBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                        Apply face swap
                      </Button>
                      {!canUseSourceAi ? (
                        <Text color="gray" size="2">
                          {aiProvider === "xai"
                            ? "Add XAI_API_KEY to .env first."
                            : "Add WAVESPEED_API_KEY to .env first."}
                        </Text>
                      ) : null}
                    </Flex>
                    {sourceImageJob ? (
                      <Callout.Root
                        color={
                          sourceImageJob.status === "failed" || sourceImageJob.status === "cancelled"
                            ? "red"
                            : sourceImageJob.status === "succeeded"
                              ? "green"
                              : "blue"
                        }
                      >
                        <Callout.Text>
                          Source image job {sourceImageJob.status}
                          {sourceImageJob.status === "failed"
                            ? ` — ${formatSourceImageJobError(sourceImageJob.logs[sourceImageJob.logs.length - 1])}`
                            : ""}
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {image ? (
                      <MediaPreview
                        label="Resolved source image"
                        size="compact"
                        type="image"
                        value={image}
                        zoomable
                        onDelete={() => onImageChange("")}
                      />
                    ) : null}
                  </Flex>
                </Tabs.Content>
              </Box>
            </Tabs.Root>

            <Grid columns={{ initial: "1", md: "2" }} gap="3">
              <Field label="Card id (work folder)">
                <TextField.Root
                  placeholder="janja_1"
                  value={cardId}
                  onChange={(event) => onCardIdChange(event.currentTarget.value)}
                />
              </Field>
              <Field label="Card label">
                <TextField.Root
                  placeholder="Janja 1"
                  value={cardLabel}
                  onChange={(event) => onCardLabelChange(event.currentTarget.value)}
                />
              </Field>
            </Grid>
          </Flex>
        ) : null}

        {activeNode === "background" ? (
          <Flex direction="column" gap="4">
            {image ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  Step 1 uses the current source image above. If you changed it, click{" "}
                  <strong>Run step</strong> or <strong>Remake step</strong> — old clips are cleared
                  automatically.
                </Callout.Text>
              </Callout.Root>
            ) : null}
            <Field label="Step 1 video model">
              <Select.Root
                value={backgroundVideoModel}
                onValueChange={(value) => onBackgroundVideoModelChange(value as BackgroundVideoModel)}
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="grok-imagine">x.ai Grok Imagine</Select.Item>
                  <Select.Item value="wan-2.2-spicy">WaveSpeed WAN 2.2 Spicy</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field>
            <Field label="Video resolution">
              <Select.Root
                value={resolution || "default"}
                onValueChange={(value) => onResolutionChange(value === "default" ? "" : value)}
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="720p">720p</Select.Item>
                  <Select.Item value="480p">480p</Select.Item>
                  {backgroundVideoModel === "grok-imagine" ? (
                    <Select.Item value="default">Default</Select.Item>
                  ) : null}
                </Select.Content>
              </Select.Root>
            </Field>
            <Field label="Bikini background prompt (image to video — approve before dress-up)">
              <TextArea
                className="dashboard-textarea"
                value={backgroundMotionPrompt}
                onChange={(event) => onBackgroundMotionPromptChange(event.currentTarget.value)}
              />
            </Field>
            <Text color="gray" size="2">
              Locked camera + stable skin: the backend upgrades legacy prompts and enhances the
              motion text (when XAI_API_KEY is set) so framing, subject size, and skin tone stay
              consistent with the source still — match the blue reference crop in your upload for
              best results.
            </Text>
          </Flex>
        ) : null}

        {activeNode === "dress" ? (
          <Flex direction="column" gap="4">
            <Callout.Root color="orange">
              <Callout.Text size="2">
                Step 2 edits your approved bikini clip in place. x.ai Grok scans every frame of
                that video for moderation — a modest dress prompt can still fail. Use{" "}
                <strong>WaveSpeed WAN 2.2 Video Edit</strong> to avoid that scan.
              </Callout.Text>
            </Callout.Root>
            <Field label="Step 2 video model">
              <Select.Root
                value={dressVideoModel}
                onValueChange={(value) => onDressVideoModelChange(value as DressVideoModel)}
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="wan-2.2-video-edit">
                    WaveSpeed WAN 2.2 Video Edit (recommended)
                  </Select.Item>
                  <Select.Item value="grok-imagine">x.ai Grok Imagine</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field>
            {!canUseDressVideo ? (
              <Text color="gray" size="2">
                {dressVideoModel === "wan-2.2-video-edit"
                  ? "Add WAVESPEED_API_KEY to .env first."
                  : "Add XAI_API_KEY to .env first."}
              </Text>
            ) : null}
            <Field label="Dress-up edit prompt (video edit on approved background — same scenery)">
              <TextArea
                className="dashboard-textarea"
                value={dressPrompt}
                onChange={(event) => onDressPromptChange(event.currentTarget.value)}
              />
            </Field>
            <Field label="Dress reference image (optional — Grok only; describe outfit in prompt for WAN)">
              <FilePathPicker
                accept="image/*"
                placeholder="Pick a dress photo or paste a path/URL"
                preview="image"
                previewLabel="Dress reference"
                previewSize="compact"
                value={dressReferenceImage}
                onChange={onDressReferenceImageChange}
                onError={onError}
              />
            </Field>
            <label className="checkbox-label">
              <Checkbox
                checked={enhancePrompt}
                disabled={dressVideoModel === "wan-2.2-video-edit" && !canUseGrok}
                onCheckedChange={(checked) => onEnhancePromptChange(checked === true)}
              />
              Enhance dress prompt with Grok chat before video edit
            </label>
            <Text color="gray" size="2">
              Edits the approved background clip frame-for-frame — same scenery, motion, and
              subject scale; only the outfit changes.
              {dressVideoModel === "wan-2.2-video-edit"
                ? enhancePrompt && canUseGrok
                  ? " WAN edit uses a Grok-enhanced prompt (locked framing) when XAI_API_KEY is set."
                  : " WAN edit uses your prompt as written unless Grok enhancement is on with XAI_API_KEY."
                : ` Prompt enhancement is ${enhancePrompt ? "on" : "off"}.`}
            </Text>
          </Flex>
        ) : null}

        {activeNode === "compress" ? (
          <Flex direction="column" gap="4">
            <Callout.Root color="blue">
              <Callout.Text size="2">
                Finalize aligns foreground timing to the bikini motion clip, backs up the raw card
                videos, then <strong>cover-crops both clips to a fixed 390∶672 canvas</strong> (same
                aspect as the scratch prototype). Every card gets the same frame size — no more
                540×822 vs 540×706 mismatches.
              </Callout.Text>
            </Callout.Root>
            <Field label="Delivery preset">
              <Select.Root
                value={compressPreset}
                onValueChange={(value) => onCompressPresetChange(value as CompressPreset)}
              >
                <Select.Trigger />
                <Select.Content>
                  {COMPRESS_PRESETS.map((entry) => (
                    <Select.Item key={entry.id} value={entry.id}>
                      {entry.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
            <Text color="gray" size="2">
              {COMPRESS_PRESETS.find((entry) => entry.id === compressPreset)?.detail}
            </Text>
            <label className="checkbox-label">
              <Checkbox
                checked={writeWebm}
                onCheckedChange={(checked) => onWriteWebmChange(checked === true)}
              />
              Also write VP9 WebM sidecars (better browser fallback)
            </label>
            <Text color="gray" size="2">
              Originals are copied to <Code>.video-backups/</Code> before overwrite. A size report is
              saved under the project work folder after each run.
            </Text>
            {flowState?.compress_report ? (
              <CompressReportPanel report={flowState.compress_report} />
            ) : null}
          </Flex>
        ) : null}

        {activeNode === "card" ? (
          <Flex direction="column" gap="4">
            <Text size="2">
              Skip Setup through Create card by uploading both clips yourself. They are copied to{" "}
              <Code>public/cards/{cardId || "<id>"}/</Code> and mesh unlocks next.
            </Text>
            <Callout.Root color="blue">
              <Callout.Text>
                <strong>background.mp4</strong> is the revealed bikini layer.{" "}
                <strong>foreground.mp4</strong> is the dress layer you scratch through.
              </Callout.Text>
            </Callout.Root>
            <Field label="Background video (bikini / revealed)">
              <FilePathPicker
                accept="video/*"
                placeholder="Pick background.mp4 or paste a path"
                preview="video"
                previewLabel="background.mp4"
                previewSize="compact"
                value={manualBackground}
                onChange={setManualBackground}
                onError={onError}
              />
            </Field>
            <Field label="Foreground video (dress / scratch layer)">
              <FilePathPicker
                accept="video/*"
                placeholder="Pick foreground.mp4 or paste a path"
                preview="video"
                previewLabel="foreground.mp4"
                previewSize="compact"
                value={manualForeground}
                onChange={setManualForeground}
                onError={onError}
              />
            </Field>
            <Flex align="center" gap="3" wrap="wrap">
              <Button
                disabled={!canImportManualClips}
                type="button"
                onClick={() => void importManualClips()}
              >
                {importBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                {cardApproved ? "Replace clips & unlock mesh" : "Import clips & unlock mesh"}
              </Button>
              {!cardId.trim() || !cardLabel.trim() ? (
                <Text color="gray" size="2">
                  Set card id and label in Setup first.
                </Text>
              ) : null}
            </Flex>
            {cardApproved ? (
              <Text color="gray" size="2">
                Card already published. Re-importing replaces both videos and keeps mesh ready.
              </Text>
            ) : (
              <Text color="gray" size="2">
                Or run the AI pipeline (Setup → image to video → dress → Create card) instead.
              </Text>
            )}
          </Flex>
        ) : null}

        {activeNode === "mesh" ? (
          <Flex direction="column" gap="4">
            <Field label="Mesh tracker">
              <Select.Root value={tracker} onValueChange={(value) => onTrackerChange(value as MeshTrackerMode)}>
                <Select.Trigger />
                <Select.Content>
                  {MESH_TRACKER_MODES.map((entry) => (
                    <Select.Item key={entry} value={entry}>
                      {meshTrackerModeLabel(entry)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>

            <button
              type="button"
              className="video-flow-advanced-toggle"
              onClick={() => setShowMeshAdvanced((value) => !value)}
            >
              <ChevronDown
                {...iconProps}
                style={{ transform: showMeshAdvanced ? "rotate(180deg)" : undefined }}
              />
              Advanced options — mesh quality tuning
            </button>

            {showMeshAdvanced ? (
              <Box pt="3">
                <MeshTunePanel value={meshTune} onChange={onMeshTuneChange} />
              </Box>
            ) : null}

            <Callout.Root color="blue">
              <Callout.Text size="2">
                <strong>Two things you can change:</strong> (1) Tuning sliders in{" "}
                <strong>Advanced options</strong> → then <strong>Remake step</strong> or{" "}
                <strong>Regenerate</strong> below. (2) Scratch mask → <strong>Erase</strong> brush on
                bad zones, then <strong>Save mask</strong>. You cannot drag mesh points — folded
                triangles are tracking limits on this clip.
              </Callout.Text>
            </Callout.Root>

            {meshJobRunning ? (
              <MeshJobProgress logs={(meshCandidateRunning ? meshCandidateJob : stepJob)?.logs ?? []} />
            ) : null}

            {meshCompareReady && flowState?.steps.mesh?.status === "review" ? (
              <MeshTrackerComparePanel
                artifacts={meshCompareArtifacts}
                cardId={cardId.trim()}
                jobBusy={jobBusy}
                meshApproved={false}
                onApprove={(meshTracker) => void approveStep("mesh", meshTracker)}
                onReject={() => void rejectStep("mesh")}
                onError={onError}
              />
            ) : null}

            {meshStepApproved ? (
              <>
                {meshCompareArtifacts.length < 2 ? (
                  <>
                    <Separator size="4" />
                    <MaskEditor
                      title="Scratch mask"
                      meshFile={`${cardId.trim()}.json`}
                      meshUrl={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
                      videoSrc={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
                      onError={onError}
                    />
                  </>
                ) : null}

                <Separator size="4" />
                <Field label="Regenerate a tracker (uses tuning above)">
                  <Flex align="center" gap="3" wrap="wrap">
                    <Select.Root
                      value={compareTracker}
                      onValueChange={(value) => setCompareTracker(value as MeshTracker)}
                      disabled={meshCandidateRunning}
                    >
                      <Select.Trigger />
                      <Select.Content>
                        {MESH_TRACKERS.map((entry) => (
                          <Select.Item key={entry} value={entry}>
                            {entry}
                            {existingCompareTrackers.has(entry) ? " (exists)" : ""}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    <Button
                      disabled={jobBusy || meshCandidateRunning}
                      type="button"
                      onClick={() => void generateMeshCandidate()}
                    >
                      <Play {...iconProps} />
                      {compareTrackerExists ? "Regenerate" : "Generate compare"}
                    </Button>
                  </Flex>
                </Field>
                <Text color="gray" size="2">
                  Pick a tracker and run — overwrites that candidate with your current tuning. Use the
                  compare tabs below to preview, <strong>Erase</strong> bad scratch zones, save, then{" "}
                  <strong>Use …</strong> to publish.
                </Text>

                {meshCompareArtifacts.length >= 2 ? (
                  <MeshTrackerComparePanel
                    artifacts={meshCompareArtifacts}
                    cardId={cardId.trim()}
                    jobBusy={jobBusy}
                    meshApproved
                    onApprove={(meshTracker) => void approveStep("mesh", meshTracker)}
                    onError={onError}
                  />
                ) : null}
              </>
            ) : null}

            {!meshJobRunning &&
            !meshCompareReady &&
            flowState?.steps.mesh?.status !== "approved" ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  Choose <strong>All (compare &amp; pick)</strong>, then generate the mesh — it
                  usually takes several minutes and logs will appear here.
                </Callout.Text>
                <Flex mt="3">
                  <Button
                    disabled={!canRunActionStep}
                    type="button"
                    onClick={() => void runStep("mesh", false)}
                  >
                    <Play {...iconProps} />
                    Generate mesh
                  </Button>
                </Flex>
              </Callout.Root>
            ) : null}
          </Flex>
        ) : null}

        {activeNode === "symbols" ? (
          <SymbolPointPicker
            cardId={cardId.trim()}
            foregroundVideo={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
            meshJsonPath={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
            onSaved={(nextState) => {
              setFlowState(nextState as VideoFlowState);
              const next = nextPipelineStep(flow, "symbols");
              if (next && (nextState.steps[next]?.status === "ready" || nextState.steps[next]?.status === "approved")) {
                const nodeId = stepToNodeMap[next];
                if (nodeId) setActiveNode(nodeId);
              }
            }}
            onError={onError}
          />
        ) : null}

        {(() => {
          if (!activeStep || activeStep === "symbols" || activeStep === "mesh") return null;
          const stepStatus = flowState?.steps[activeStep]?.status;
          const fromState = (flowState?.steps[activeStep]?.artifacts ?? []).filter(Boolean);
          const id = cardId.trim();
          // Only fall back to published card videos after a step has produced
          // something (approved/review). "Ready" means not run yet — don't show
          // a missing public/cards/... path as a failed player.
          const fallback =
            fromState.length === 0 &&
            id &&
            (stepStatus === "approved" || stepStatus === "review")
              ? activeStep === "background"
                ? [`public/cards/${id}/background.mp4`]
                : activeStep === "dress"
                  ? [`public/cards/${id}/foreground.mp4`]
                  : activeStep === "card" || activeStep === "compress"
                    ? [
                        `public/cards/${id}/background.mp4`,
                        `public/cards/${id}/foreground.mp4`,
                      ]
                    : []
              : [];
          const artifacts = fromState.length ? fromState : fallback;
          if (!artifacts.length) return null;
          return (
            <Flex direction="column" gap="3" mt="3">
              {artifacts.map((artifact) =>
                artifact.endsWith("compress-report.json") ? (
                  <Text key={artifact} size="2">
                    Delivery report: <Code className="dashboard-code">{artifact}</Code>
                  </Text>
                ) : artifact.endsWith(".json") ? (
                  <Text key={artifact} size="2">
                    Mesh written to <Code className="dashboard-code">{artifact}</Code>
                  </Text>
                ) : (
                  <MediaPreview
                    key={artifact}
                    label={artifact.split("/").pop() ?? "Result"}
                    type="video"
                    value={artifact}
                  />
                ),
              )}
            </Flex>
          );
        })()}
      </div>

      <div className="flow-run-bar">
        <Flex direction="column" gap="3" style={{ flex: 1 }}>
          {actionStep && flowState ? (
            <Text size="2" weight="medium">
              {flowState.steps[actionStep].label}
              {actionStatus === "review" && reviewSteps.has(actionStep)
                ? " — watch the clip, then continue"
                : actionStatus === "review" && actionStep === "mesh"
                  ? " — compare trackers and pick one"
                  : actionStatus === "ready"
                  ? actionIsInteractive
                    ? " — place points on the mesh, then save"
                    : " — ready to run"
                  : actionStatus === "approved"
                    ? " — done (remake to regenerate)"
                    : actionStatus === "running" || jobBusy
                      ? " — running…"
                      : ""}
            </Text>
          ) : activeNode === "source" ? (
            <Text size="2">Setup — source image and card id.</Text>
          ) : activeNode === "card" ? (
            <Text size="2">
              Create card — upload both videos to skip the AI steps, or run after dress is approved.
            </Text>
          ) : (
            <Text size="2">Select a pipeline step to run or remake.</Text>
          )}
        </Flex>

        <Flex align="center" gap="2" wrap="wrap">
          {actionStatus === "review" && actionStep && !reviewSteps.has(actionStep) ? (
            <Button disabled={jobBusy} type="button" onClick={() => void approveFocusClip()}>
              Continue
            </Button>
          ) : null}

          {actionStatus === "review" && actionStep && reviewSteps.has(actionStep) ? (
            <>
              <Button disabled={jobBusy} type="button" onClick={() => void approveFocusClip()}>
                <Check {...iconProps} />
                Use this clip
              </Button>
              <Button
                disabled={jobBusy}
                type="button"
                color="red"
                variant="soft"
                onClick={() => void rejectFocusClip()}
              >
                Re-run
              </Button>
            </>
          ) : null}

          {actionStatus === "ready" &&
          actionStep === "compress" &&
          flowState?.compress_report ? (
            <Button disabled={jobBusy} type="button" onClick={() => void approveFocusClip()}>
              <Check {...iconProps} />
              Mark complete
            </Button>
          ) : null}

          {actionStatus === "ready" ? (
            <Button
              disabled={!canRunActionStep}
              type="button"
              onClick={() => actionStep && void runStep(actionStep, false)}
            >
              <Play {...iconProps} />
              {actionStep === "compress" && flowState?.compress_report ? "Re-run finalize" : "Run step"}
            </Button>
          ) : null}

          {actionStatus === "approved" && actionStep ? (
            <Button
              disabled={!canRemakeActionStep}
              type="button"
              onClick={() => void runStep(actionStep, true)}
            >
              <RotateCcw {...iconProps} />
              Remake step
            </Button>
          ) : null}

          {actionStatus === "failed" && actionStep ? (
            <Button disabled={jobBusy} type="button" onClick={() => void runStep(actionStep, true)}>
              Retry
            </Button>
          ) : null}

          {flowState?.complete ? <Badge color="green">Flow complete</Badge> : null}
        </Flex>
      </div>
        </section>
      </div>

      {cardId.trim() ? (
        <CardPhotosPanel cardId={cardId.trim()} onError={onError} />
      ) : null}
    </Flex>
  );
}
