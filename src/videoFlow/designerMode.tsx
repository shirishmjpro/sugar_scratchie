import { Check, ChevronDown, Play, RotateCcw } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Heading,
  Select,
  Separator,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useState } from "react";
import { FlowCanvas, type FlowNodeRuntime } from "./flowCanvas";
import { layoutFlowForRunView } from "./runFlowLayout";
import {
  COMPRESS_PRESETS,
  DEFAULT_VIDEO_FLOW_JSON,
  parseCompressPreset,
  parseVideoFlowJson,
  stringifyVideoFlowJson,
  type CompressPreset,
  type FlowNodeDef,
  type FlowNodeId,
  type VideoFlowJson,
  type VideoFlowStepKey,
} from "./schema";
import { Field, FilePathPicker, iconProps, MESH_TRACKER_MODES, meshTrackerModeLabel, type MeshTrackerMode } from "./ui";

type DesignerModeProps = {
  flow: VideoFlowJson;
  flowJsonText: string;
  activeProjectId?: string;
  onFlowJsonTextChange: (value: string) => void;
  onApplyFlow: (flow: VideoFlowJson) => void;
  onError: (message: string) => void;
};

function nodeById(flow: VideoFlowJson, id: FlowNodeId) {
  return flow.nodes.find((node) => node.id === id);
}

function updateNode(flow: VideoFlowJson, id: FlowNodeId, patch: Partial<FlowNodeDef>): VideoFlowJson {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  };
}

export function DesignerMode({
  flow,
  flowJsonText,
  activeProjectId,
  onFlowJsonTextChange,
  onApplyFlow,
  onError,
}: DesignerModeProps) {
  const [draft, setDraft] = useState<VideoFlowJson>(flow);
  const [activeNode, setActiveNode] = useState<FlowNodeId>("source");
  const [showJson, setShowJson] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(flow);
    setDirty(false);
  }, [flow]);

  const activeMeta = nodeById(draft, activeNode) ?? draft.nodes[0];
  const activeStep = activeMeta?.step ?? null;

  const nodeStates = useMemo(() => {
    const states = Object.fromEntries(draft.nodes.map((node) => [node.id, "ready"])) as Partial<
      Record<FlowNodeId, FlowNodeRuntime>
    >;
    if (draft.reviewSteps.includes("background")) states.background = "review";
    if (draft.reviewSteps.includes("dress")) states.dress = "review";
    return states;
  }, [draft.reviewSteps, draft.nodes]);

  const displayFlow = useMemo(() => layoutFlowForRunView(draft), [draft]);

  function patchDraft(next: VideoFlowJson) {
    setDraft(next);
    setDirty(true);
    onError("");
  }

  function setReview(step: VideoFlowStepKey, enabled: boolean) {
    const reviewSteps = enabled
      ? [...new Set([...draft.reviewSteps, step])]
      : draft.reviewSteps.filter((entry) => entry !== step);
    patchDraft({ ...draft, reviewSteps });
  }

  function saveFlow() {
    onError("");
    try {
      const parsed = parseVideoFlowJson(stringifyVideoFlowJson(draft));
      onApplyFlow(parsed);
      onFlowJsonTextChange(stringifyVideoFlowJson(parsed));
      setDirty(false);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function resetFlow() {
    onError("");
    setDraft(DEFAULT_VIDEO_FLOW_JSON);
    onApplyFlow(DEFAULT_VIDEO_FLOW_JSON);
    onFlowJsonTextChange(stringifyVideoFlowJson(DEFAULT_VIDEO_FLOW_JSON));
    setActiveNode("source");
    setDirty(false);
  }

  function applyJsonEdits() {
    onError("");
    try {
      const parsed = parseVideoFlowJson(flowJsonText);
      setDraft(parsed);
      onApplyFlow(parsed);
      setDirty(false);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="between" wrap="wrap" gap="3">
        <Text color="gray" size="2">
          Click a node to edit shared defaults. Save, then open a card from Models to run it.
        </Text>
        <Flex gap="2" wrap="wrap">
          <Button type="button" variant="soft" onClick={resetFlow}>
            <RotateCcw {...iconProps} />
            Reset
          </Button>
          <Button type="button" disabled={!dirty} onClick={saveFlow}>
            <Check {...iconProps} />
            Save flow
          </Button>
          <Button asChild type="button" variant="soft">
            <a href="/dashboard/video-flow/run">
              <Play {...iconProps} />
              Open Run
            </a>
          </Button>
        </Flex>
      </Flex>

      <div className="video-flow-designer-layout">
        <Box className="video-flow-designer-canvas-wrap">
          <Text size="2" weight="bold" mb="2">
            Flow map
          </Text>
          <Text color="gray" mb="3" size="1">
            Click a step to edit its settings.
          </Text>
          <FlowCanvas
            flow={displayFlow}
            activeNode={activeNode}
            nodeStates={nodeStates}
            wireLayout="vertical"
            onNodeClick={setActiveNode}
          />
        </Box>

        <Box className="video-flow-designer-panel">
          <Flex align="center" gap="2" mb="2">
            <Badge color="gray">{activeMeta?.kind ?? "node"}</Badge>
            <Heading size="4">{activeMeta?.title ?? "Node"}</Heading>
          </Flex>
          <Text color="gray" size="2" mb="4">
            {activeMeta?.description}
          </Text>

          {activeNode === "source" ? (
            <Flex direction="column" gap="4">
              <Text color="gray" size="2">
                Design edits the shared pipeline template. Create and open motion cards from{" "}
                <a href="/dashboard/models">Models</a>
                {activeProjectId ? (
                  <>
                    {" "}
                    (last opened: <strong>{activeProjectId}</strong>)
                  </>
                ) : null}
                .
              </Text>
              <Field label="Flow name">
                <TextField.Root
                  value={draft.label}
                  onChange={(event) => patchDraft({ ...draft, label: event.currentTarget.value })}
                />
              </Field>
              <Field label="Description">
                <TextArea
                  className="dashboard-textarea"
                  rows={3}
                  value={draft.description}
                  onChange={(event) =>
                    patchDraft({ ...draft, description: event.currentTarget.value })
                  }
                />
              </Field>
              <Field label="Flow id (folder name prefix)">
                <TextField.Root value={draft.id} readOnly />
              </Field>
              <Field label="Default Grok resolution">
                <Select.Root
                  value={draft.defaults.resolution}
                  onValueChange={(value) =>
                    patchDraft({
                      ...draft,
                      defaults: { ...draft.defaults, resolution: value },
                    })
                  }
                >
                  <Select.Trigger />
                  <Select.Content>
                    <Select.Item value="720p">720p</Select.Item>
                    <Select.Item value="480p">480p</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Field>
            </Flex>
          ) : null}

          {activeNode === "background" ? (
            <Flex direction="column" gap="4">
              <Field label="Step title">
                <TextField.Root
                  value={activeMeta?.title ?? ""}
                  onChange={(event) =>
                    patchDraft(updateNode(draft, "background", { title: event.currentTarget.value }))
                  }
                />
              </Field>
              <Field label="Bikini background prompt">
                <TextArea
                  className="dashboard-textarea"
                  rows={5}
                  value={draft.defaults.background_motion_prompt}
                  onChange={(event) =>
                    patchDraft({
                      ...draft,
                      defaults: {
                        ...draft.defaults,
                        background_motion_prompt: event.currentTarget.value,
                      },
                    })
                  }
                />
              </Field>
              <label className="checkbox-label">
                <Checkbox
                  checked={draft.reviewSteps.includes("background")}
                  onCheckedChange={(checked) => setReview("background", checked === true)}
                />
                Require manual approval after this clip
              </label>
            </Flex>
          ) : null}

          {activeNode === "dress" ? (
            <Flex direction="column" gap="4">
              <Field label="Step title">
                <TextField.Root
                  value={activeMeta?.title ?? ""}
                  onChange={(event) =>
                    patchDraft(updateNode(draft, "dress", { title: event.currentTarget.value }))
                  }
                />
              </Field>
              <Field label="Dress-up prompt (same background as background clip)">
                <TextArea
                  className="dashboard-textarea"
                  rows={5}
                  value={draft.defaults.dress_prompt}
                  onChange={(event) =>
                    patchDraft({
                      ...draft,
                      defaults: { ...draft.defaults, dress_prompt: event.currentTarget.value },
                    })
                  }
                />
              </Field>
              <Field label="Dress reference image (optional — guides the outfit shape/style)">
                <FilePathPicker
                  accept="image/*"
                  placeholder="Pick a dress photo or paste a path/URL"
                  preview="image"
                  previewLabel="Dress reference"
                  previewSize="compact"
                  value={draft.defaults.dress_reference_image}
                  onChange={(value) =>
                    patchDraft({
                      ...draft,
                      defaults: { ...draft.defaults, dress_reference_image: value },
                    })
                  }
                  onError={onError}
                />
              </Field>
              <label className="checkbox-label">
                <Checkbox
                  checked={draft.defaults.enhance_dress_prompt}
                  onCheckedChange={(checked) =>
                    patchDraft({
                      ...draft,
                      defaults: {
                        ...draft.defaults,
                        enhance_dress_prompt: checked === true,
                      },
                    })
                  }
                />
                Enhance dress prompt with AI
              </label>
              <label className="checkbox-label">
                <Checkbox
                  checked={draft.reviewSteps.includes("dress")}
                  onCheckedChange={(checked) => setReview("dress", checked === true)}
                />
                Require manual approval after this clip
              </label>
            </Flex>
          ) : null}

          {activeNode === "mesh" ? (
            <Field label="Mesh tracker">
              <Select.Root
                value={draft.defaults.tracker}
                onValueChange={(value) =>
                  patchDraft({
                    ...draft,
                    defaults: {
                      ...draft.defaults,
                      tracker: value as MeshTrackerMode,
                    },
                  })
                }
              >
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
          ) : null}

          {activeNode === "compress" ? (
            <Flex direction="column" gap="3">
              <Field label="Default delivery preset">
                <Select.Root
                  value={parseCompressPreset(draft.defaults.compress_preset)}
                  onValueChange={(value) =>
                    patchDraft({
                      ...draft,
                      defaults: {
                        ...draft.defaults,
                        compress_preset: value as CompressPreset,
                      },
                    })
                  }
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
                {COMPRESS_PRESETS.find(
                  (entry) => entry.id === parseCompressPreset(draft.defaults.compress_preset),
                )?.detail}
              </Text>
              <label className="checkbox-label">
                <Checkbox
                  checked={draft.defaults.write_webm}
                  onCheckedChange={(checked) =>
                    patchDraft({
                      ...draft,
                      defaults: { ...draft.defaults, write_webm: checked === true },
                    })
                  }
                />
                Also write VP9 WebM sidecars by default
              </label>
            </Flex>
          ) : null}

          {activeNode === "card" || activeNode === "output" ? (
            <Text size="2" color="gray">
              This step runs automatically after the previous steps complete. No prompts to edit
              here.
            </Text>
          ) : null}

          {activeStep && !["background", "dress", "mesh", "symbols", "compress"].includes(activeStep) ? (
            <Flex direction="column" gap="3">
              <Field label="Step title">
                <TextField.Root
                  value={activeMeta?.title ?? ""}
                  onChange={(event) =>
                    patchDraft(updateNode(draft, activeNode, { title: event.currentTarget.value }))
                  }
                />
              </Field>
              <Field label="Subtitle">
                <TextField.Root
                  value={activeMeta?.subtitle ?? ""}
                  onChange={(event) =>
                    patchDraft(updateNode(draft, activeNode, { subtitle: event.currentTarget.value }))
                  }
                />
              </Field>
            </Flex>
          ) : null}

          <Separator size="4" my="4" />

          <button
            type="button"
            className="video-flow-advanced-toggle"
            onClick={() => setShowJson((value) => !value)}
          >
            <ChevronDown
              {...iconProps}
              style={{ transform: showJson ? "rotate(180deg)" : undefined }}
            />
            Advanced — edit raw JSON
          </button>

          {showJson ? (
            <Flex direction="column" gap="2" mt="3">
              <TextArea
                className="dashboard-textarea video-flow-json-editor"
                rows={14}
                value={flowJsonText}
                onChange={(event) => {
                  onFlowJsonTextChange(event.currentTarget.value);
                  setDirty(true);
                }}
              />
              <Button type="button" variant="soft" onClick={applyJsonEdits}>
                Apply JSON changes
              </Button>
            </Flex>
          ) : null}
        </Box>
      </div>
    </Flex>
  );
}
