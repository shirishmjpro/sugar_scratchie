import { Check, Loader2, Play, RotateCcw } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
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
import { useEffect, useMemo, useState } from "react";
import { api } from "../shared/api";
import { flowStepBadge, type FlowNodeRuntime } from "./flowCanvas";
import {
  nodeToStep,
  stepToNode,
  type FlowNodeId,
  type VideoFlowJson,
  type VideoFlowStepKey,
} from "./schema";
import { MaskEditor } from "./MaskEditor";
import { MeshTunePanel } from "./MeshTunePanel";
import { meshTuneToApi, type MeshTuneSettings } from "./meshTune";
import { SymbolPointPicker } from "./SymbolPointPicker";
import { Field, FilePathPicker, iconProps, MediaPreview, MESH_TRACKERS, MESH_TRACKER_MODES, meshTrackerFromArtifact, meshTrackerModeLabel, type MeshTracker, type MeshTrackerMode } from "./ui";
import { isStockPortraitPrompt, storedDraftFromApi, type SourceImageMode, type StoredVideoFlowDraft } from "./storage";

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
  recovered_approvals?: boolean;
};

function flowStepFromJobCommand(command: string[]): VideoFlowStepKey | null {
  if (command[0] !== "video-flow-step") return null;
  const step = command[1];
  if (step === "background" || step === "dress" || step === "compress" || step === "card" || step === "mesh" || step === "symbols") {
    return step;
  }
  return null;
}

function pipelineFocusStep(
  flow: VideoFlowJson,
  flowState: VideoFlowState | null,
  runningStep: VideoFlowStepKey | null,
  failedStep: VideoFlowStepKey | null,
): VideoFlowStepKey | null {
  if (
    runningStep &&
    flowState?.steps[runningStep]?.status !== "locked"
  ) {
    return runningStep;
  }
  if (failedStep) return failedStep;
  if (!flowState) return flow.pipeline[0] ?? null;
  for (const step of flow.pipeline) {
    const status = flowState.steps[step]?.status;
    if (status === "review" || status === "ready") return step;
  }
  return null;
}

function formatSourceImageJobError(log: string | undefined): string {
  if (!log) return "Source image job failed — check the Jobs tab for details.";
  const cleaned = log.replace(/^Job runner error: /, "");
  if (cleaned.toLowerCase().includes("content moderation")) {
    return (
      "xAI rejected the result (content moderation). " +
      "Try a less revealing prompt, different photos, or use Upload instead."
    );
  }
  return cleaned;
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

  if (!flowState) {
    const firstStep = flow.pipeline[0];
    const firstNode = firstStep ? stepToNodeMap[firstStep] : undefined;
    if (firstNode) next[firstNode] = image ? "ready" : "locked";
    return next;
  }

  for (const [step, nodeId] of Object.entries(stepToNodeMap) as [VideoFlowStepKey, FlowNodeId][]) {
    const stepState = flowState.steps[step];
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

  next.output = flowState.complete ? "approved" : "idle";
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
  enhancePrompt: boolean;
  image: string;
  backgroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  writeWebm: boolean;
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
  onTrackerChange: (value: MeshTrackerMode) => void;
  onMeshTuneChange: (value: MeshTuneSettings) => void;
  onResolutionChange: (value: string) => void;
  onSourceModeChange: (value: SourceImageMode) => void;
  onSourcePromptChange: (value: string) => void;
  onFaceImageChange: (value: string) => void;
  onBaseImageChange: (value: string) => void;
  onApplyDraft: (draft: StoredVideoFlowDraft) => void;
  onRefreshJobs: () => Promise<void>;
  onRefreshAssets: () => Promise<void>;
  onError: (message: string) => void;
};

export function RunMode(props: RunModeProps) {
  const {
    flow,
    jobs,
    canUseGrok,
    enhancePrompt,
    image,
    backgroundMotionPrompt,
    dressPrompt,
    dressReferenceImage,
    cardId,
    cardLabel,
    writeWebm,
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
    onTrackerChange,
    onMeshTuneChange,
    onResolutionChange,
    onSourceModeChange,
    onSourcePromptChange,
    onFaceImageChange,
    onBaseImageChange,
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
  const [showFaceSwapPrompt, setShowFaceSwapPrompt] = useState(false);
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
  const meshComparePin =
    meshCandidateRunning || (meshStepApproved && meshCompareCount >= 2);

  const [meshFocusOverride, setMeshFocusOverride] = useState(false);
  const shouldPinMesh = meshComparePin && !meshFocusOverride;

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
      setFlowState(data);
    } catch (caught) {
      setFlowState(null);
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
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
    }
  }, [stepJob?.id, stepJob?.status]);

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
      }
    }
  }, [meshCandidateJob?.id, meshCandidateJob?.status, stepJob?.id]);

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
        const parsed = storedDraftFromApi(data.draft);
        if (parsed) onApplyDraft(parsed);
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [cardId, onApplyDraft, onError, sourceImageJob, sourceJobHandledId]);

  useEffect(() => {
    if (meshCandidateRunning) setMeshFocusOverride(false);
  }, [meshCandidateRunning]);

  const focusStep = useMemo(() => {
    if (shouldPinMesh) return "mesh";
    return pipelineFocusStep(flow, flowState, effectiveRunningStep, failedStep);
  }, [flow, flowState, effectiveRunningStep, failedStep, shouldPinMesh]);

  useEffect(() => {
    if (effectiveRunningStep && stepToNodeMap[effectiveRunningStep]) {
      setActiveNode(stepToNodeMap[effectiveRunningStep]!);
      return;
    }
    if (failedStep && stepToNodeMap[failedStep]) {
      setActiveNode(stepToNodeMap[failedStep]!);
      return;
    }
    if (shouldPinMesh && stepToNodeMap.mesh) {
      setActiveNode(stepToNodeMap.mesh);
      return;
    }
    if (!focusStep || !stepToNodeMap[focusStep]) return;
    const status = flowState?.steps[focusStep]?.status;
    if (status === "review" || status === "ready") {
      setActiveNode(stepToNodeMap[focusStep]!);
    }
  }, [effectiveRunningStep, failedStep, focusStep, flowState, stepToNodeMap, shouldPinMesh]);

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

  const actionStep: VideoFlowStepKey | null = activeStep ?? focusStep;
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
  const actionNeedsGrok = actionStep === "background" || actionStep === "dress";
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
    resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker,
    write_webm: writeWebm,
    mesh_tune: meshTuneToApi(meshTune),
    source_mode: sourceMode,
    source_prompt: sourcePrompt,
    face_image: faceImage,
    base_image: baseImage,
  };

  const canGeneratePromptImage = Boolean(cardId.trim() && canUseGrok && !sourceImageBusy);
  const canGenerateFaceSwap = Boolean(
    cardId.trim() && baseImage.trim() && faceImage.trim() && canUseGrok && !sourceImageBusy,
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
        }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  const canRunActionStep = Boolean(
    actionStep &&
      !actionIsInteractive &&
      cardId.trim() &&
      cardLabel.trim() &&
      image &&
      (!actionNeedsGrok || canUseGrok) &&
      actionStatus === "ready" &&
      !jobBusy,
  );

  const canRemakeActionStep = Boolean(
    actionStep &&
      cardId.trim() &&
      cardLabel.trim() &&
      image &&
      (!actionNeedsGrok || canUseGrok) &&
      actionStatus === "approved" &&
      !jobBusy,
  );

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
    setMeshFocusOverride(false);
    const meshNode = stepToNodeMap.mesh;
    if (meshNode) setActiveNode(meshNode);
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
                  status === "locked" ? "is-disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={status === "locked"}
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
                {stepJob.logs[stepJob.logs.length - 1]?.replace(/^Job runner error: /, "") ??
                  "Step failed — check the Jobs tab for details."}
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
                      value={image}
                      onChange={onImageChange}
                      onError={onError}
                    />
                  </Field>
                </Tabs.Content>

                <Tabs.Content value="prompt">
                  <Flex direction="column" gap="4">
                    <Field label="Portrait prompt">
                      <TextArea
                        className="dashboard-textarea"
                        value={sourcePrompt}
                        onChange={(event) => onSourcePromptChange(event.currentTarget.value)}
                      />
                    </Field>
                    <Text color="gray" size="2">
                      Bikini styling is added in the next step (image to video). Keep this prompt
                      neutral to avoid xAI moderation rejections.
                    </Text>
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
                    {faceImage.trim() ? (
                      <Callout.Root color="orange">
                        <Callout.Text>
                          Face-guided generation uses a moderation-safe resort-wear default unless you
                          change the prompt. Bikini or revealing prompts are often rejected.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    <Flex align="center" gap="3" wrap="wrap">
                      <Button
                        disabled={!canGeneratePromptImage}
                        type="button"
                        onClick={() => void generateSourceImage("prompt")}
                      >
                        {sourceImageBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                        Generate source image
                      </Button>
                      {!canUseGrok ? (
                        <Text color="gray" size="2">
                          Add XAI_API_KEY to .env first.
                        </Text>
                      ) : null}
                    </Flex>
                  </Flex>
                </Tabs.Content>

                <Tabs.Content value="face_swap">
                  <Flex direction="column" gap="4">
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
                      {!canUseGrok ? (
                        <Text color="gray" size="2">
                          Add XAI_API_KEY to .env first.
                        </Text>
                      ) : null}
                    </Flex>
                  </Flex>
                </Tabs.Content>
              </Box>
            </Tabs.Root>

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
              <MediaPreview label="Resolved source image" size="compact" type="image" value={image} />
            ) : null}

            <Field label="Grok resolution">
              <Select.Root
                value={resolution || "default"}
                onValueChange={(value) => onResolutionChange(value === "default" ? "" : value)}
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="720p">720p</Select.Item>
                  <Select.Item value="480p">480p</Select.Item>
                  <Select.Item value="default">Default</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field>
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
          <Field label="Bikini background prompt (image to video — approve before dress-up)">
            <TextArea
              className="dashboard-textarea"
              value={backgroundMotionPrompt}
              onChange={(event) => onBackgroundMotionPromptChange(event.currentTarget.value)}
            />
          </Field>
        ) : null}

        {activeNode === "dress" ? (
          <Flex direction="column" gap="4">
            <Field label="Dress-up edit prompt (video edit on approved background — same scenery)">
              <TextArea
                className="dashboard-textarea"
                value={dressPrompt}
                onChange={(event) => onDressPromptChange(event.currentTarget.value)}
              />
            </Field>
            <Field label="Dress reference image (optional — guides the outfit shape/style)">
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
            <Text color="gray" size="2">
              Grok edits the approved background clip in place — same beach, same frames; only
              the outfit changes. Prompt enhancement is{" "}
              {enhancePrompt ? "on" : "off"}.
            </Text>
          </Flex>
        ) : null}

        {activeNode === "compress" ? (
          <Flex direction="column" gap="3">
            <Text size="2">
              Both card videos are re-encoded to <Code>540px</Code> wide H.264 after mesh tracking.
            </Text>
            <label className="checkbox-label">
              <Checkbox
                checked={writeWebm}
                onCheckedChange={(checked) => onWriteWebmChange(checked === true)}
              />
              Also write VP9 WebM sidecars
            </label>
          </Flex>
        ) : null}

        {activeNode === "card" ? (
          <Text size="2">
            Copies approved Grok clips to <Code>public/cards/{cardId || "<id>"}/</Code> before mesh
            and compress.
          </Text>
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

            <Separator size="4" />
            <MeshTunePanel value={meshTune} onChange={onMeshTuneChange} />

            <Callout.Root color="blue">
              <Callout.Text size="2">
                <strong>Two things you can change:</strong> (1) Tuning sliders → then{" "}
                <strong>Remake step</strong> or <strong>Regenerate</strong> below. (2) Scratch mask →{" "}
                <strong>Erase</strong> brush on bad zones, then <strong>Save mask</strong>. You cannot drag
                mesh points — folded triangles are tracking limits on this clip.
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
            onSaved={() => void refreshFlowState()}
            onError={onError}
          />
        ) : null}

        {activeStep && activeStep !== "symbols" && flowState?.steps[activeStep]?.artifacts.length ? (
          <Flex direction="column" gap="3">
            {flowState.steps[activeStep].artifacts.map((artifact) =>
              artifact.endsWith(".json") ? (
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
        ) : null}
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

          {actionStatus === "ready" ? (
            <Button
              disabled={!canRunActionStep}
              type="button"
              onClick={() => actionStep && void runStep(actionStep, false)}
            >
              <Play {...iconProps} />
              Run step
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
    </Flex>
  );
}
