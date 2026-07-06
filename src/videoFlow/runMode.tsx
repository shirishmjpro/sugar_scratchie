import { Check, Play, RotateCcw } from "lucide-react";
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
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useState } from "react";
import { api } from "../shared/api";
import { flowStepBadge, type FlowNodeRuntime } from "./flowCanvas";
import { FlowCanvas } from "./flowCanvas";
import { layoutFlowForRunView } from "./runFlowLayout";
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
  if (runningStep) return runningStep;
  if (failedStep) return failedStep;
  if (!flowState) return flow.pipeline[0] ?? null;
  for (const step of flow.pipeline) {
    const status = flowState.steps[step]?.status;
    if (status === "review" || status === "ready") return step;
  }
  return null;
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
    if (runningStep === step) {
      next[nodeId] = "running";
      continue;
    }
    if (failedStep === step) {
      next[nodeId] = "failed";
      continue;
    }
    const stepState = flowState.steps[step];
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
  onImageChange: (value: string) => void;
  onBackgroundMotionPromptChange: (value: string) => void;
  onDressPromptChange: (value: string) => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onWriteWebmChange: (value: boolean) => void;
  onTrackerChange: (value: (typeof TRACKERS)[number]) => void;
  onResolutionChange: (value: string) => void;
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
    onImageChange,
    onBackgroundMotionPromptChange,
    onDressPromptChange,
    onCardIdChange,
    onCardLabelChange,
    onWriteWebmChange,
    onTrackerChange,
    onResolutionChange,
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

  const focusStep = useMemo(
    () => pipelineFocusStep(flow, flowState, runningStep, failedStep),
    [flow, flowState, runningStep, failedStep],
  );

  useEffect(() => {
    if (runningStep && stepToNodeMap[runningStep]) {
      setActiveNode(stepToNodeMap[runningStep]!);
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
  }, [runningStep, failedStep, focusStep, flowState, stepToNodeMap]);

  const nodeStates = useMemo(
    () => resolveFlowNodeStatuses(flow, flowState, Boolean(image), cardId.trim(), runningStep, failedStep),
    [flow, flowState, image, cardId, runningStep, failedStep],
  );

  const runFlowMap = useMemo(() => layoutFlowForRunView(flow), [flow]);

  function onFlowNodeClick(nodeId: FlowNodeId) {
    if (nodeId === "source") {
      selectStep("source");
      return;
    }
    const step = nodeToStepMap[nodeId];
    if (step) selectStep(step);
  }

  const activeMeta = flow.nodes.find((node) => node.id === activeNode) ?? flow.nodes[0];
  const activeStep = nodeToStepMap[activeNode];
  const jobBusy = stepJob?.status === "running" || stepJob?.status === "queued" || flowBusy;

  const actionStep: VideoFlowStepKey | null = activeStep ?? focusStep;
  const actionStatus =
    actionStep && runningStep === actionStep
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
  };

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
      <div className="video-flow-run-map">
        <Text size="2" weight="bold" mb="2">
          Flow map
        </Text>
        <FlowCanvas
          flow={runFlowMap}
          activeNode={activeNode}
          nodeStates={nodeStates}
          wireLayout="vertical"
          onNodeClick={onFlowNodeClick}
        />
      </div>

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
