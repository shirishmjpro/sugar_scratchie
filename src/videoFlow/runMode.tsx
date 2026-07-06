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
import { SymbolPointPicker } from "./SymbolPointPicker";
import { Field, FilePathPicker, iconProps, MediaPreview, TRACKERS } from "./ui";
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

type RunModeProps = {
  flow: VideoFlowJson;
  jobs: JobInfo[];
  canUseGrok: boolean;
  enhancePrompt: boolean;
  image: string;
  backgroundMotionPrompt: string;
  dressPrompt: string;
  cardId: string;
  cardLabel: string;
  writeWebm: boolean;
  resolution: string;
  tracker: (typeof TRACKERS)[number];
  sourceMode: SourceImageMode;
  sourcePrompt: string;
  faceImage: string;
  baseImage: string;
  onImageChange: (value: string) => void;
  onBackgroundMotionPromptChange: (value: string) => void;
  onDressPromptChange: (value: string) => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onWriteWebmChange: (value: boolean) => void;
  onTrackerChange: (value: (typeof TRACKERS)[number]) => void;
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
    cardId,
    cardLabel,
    writeWebm,
    resolution,
    tracker,
    sourceMode,
    sourcePrompt,
    faceImage,
    baseImage,
    onImageChange,
    onBackgroundMotionPromptChange,
    onDressPromptChange,
    onCardIdChange,
    onCardLabelChange,
    onWriteWebmChange,
    onTrackerChange,
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
      if (stepJob.status === "succeeded" && flowStepFromJobCommand(stepJob.command) === "card") {
        void onRefreshAssets();
      }
    }
  }, [stepJob?.id, stepJob?.status]);

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

  const focusStep = useMemo(
    () => pipelineFocusStep(flow, flowState, activeRunningStep, failedStep),
    [flow, flowState, activeRunningStep, failedStep],
  );

  useEffect(() => {
    if (activeRunningStep && stepToNodeMap[activeRunningStep]) {
      setActiveNode(stepToNodeMap[activeRunningStep]!);
      return;
    }
    if (failedStep && stepToNodeMap[failedStep]) {
      setActiveNode(stepToNodeMap[failedStep]!);
      return;
    }
    if (!focusStep || !stepToNodeMap[focusStep]) return;
    const status = flowState?.steps[focusStep]?.status;
    if (status === "review" || status === "ready") {
      setActiveNode(stepToNodeMap[focusStep]!);
    }
  }, [activeRunningStep, failedStep, focusStep, flowState, stepToNodeMap]);

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
        activeRunningStep,
        failedStep,
      ),
    [flow, flowState, image, cardId, activeRunningStep, failedStep],
  );

  const activeMeta = flow.nodes.find((node) => node.id === activeNode) ?? flow.nodes[0];
  const activeStep = nodeToStepMap[activeNode];
  const jobBusy =
    ((stepJob?.status === "running" || stepJob?.status === "queued") && !staleRunningStep) ||
    flowBusy;

  const actionStep: VideoFlowStepKey | null = activeStep ?? focusStep;
  const actionStatus =
    actionStep && activeRunningStep === actionStep
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

  const stepPayload = {
    image,
    background_motion_prompt: backgroundMotionPrompt,
    foreground_motion_prompt: backgroundMotionPrompt,
    dress_prompt: dressPrompt,
    card_id: cardId.trim(),
    card_label: cardLabel.trim(),
    resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker,
    write_webm: writeWebm,
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

  async function approveStep(step: VideoFlowStepKey) {
    if (!cardId.trim()) return;
    setFlowBusy(true);
    onError("");
    try {
      const data = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId.trim())}/approve`,
        { method: "POST", body: JSON.stringify({ step }) },
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
      setActiveNode("source");
      return;
    }
    if (flowState?.steps[step]?.status === "locked") return;
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
              <Select.Root value={tracker} onValueChange={(value) => onTrackerChange(value as typeof tracker)}>
                <Select.Trigger />
                <Select.Content>
                  {TRACKERS.map((entry) => (
                    <Select.Item key={entry} value={entry}>
                      {entry}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>

            {flowState?.steps.mesh?.artifacts.length ? (
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
            ) : (
              <Text color="gray" size="2">
                Run this step to generate the mesh, then paint which cells are scratchable below.
              </Text>
            )}
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
