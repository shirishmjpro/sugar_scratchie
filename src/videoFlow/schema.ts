export type FlowNodeId =
  | "source"
  | "background"
  | "dress"
  | "compress"
  | "card"
  | "mesh"
  | "symbols"
  | "output";

export type FlowNodeKind = "input" | "grok" | "process" | "output";

export type VideoFlowStepKey =
  | "background"
  | "dress"
  | "compress"
  | "card"
  | "mesh"
  | "symbols";

export type FlowNodeDef = {
  id: FlowNodeId;
  kind: FlowNodeKind;
  title: string;
  subtitle: string;
  description: string;
  x: number;
  y: number;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  step?: VideoFlowStepKey | null;
};

export type FlowWireDef = {
  from: FlowNodeId;
  to: FlowNodeId;
  dashed?: boolean;
};

export type VideoFlowJson = {
  id: string;
  label: string;
  description: string;
  version: number;
  pipeline: VideoFlowStepKey[];
  reviewSteps: VideoFlowStepKey[];
  canvas: { width: number; height: number };
  nodes: FlowNodeDef[];
  wires: FlowWireDef[];
  defaults: {
    background_motion_prompt: string;
    dress_prompt: string;
    dress_reference_image: string;
    resolution: string;
    tracker: "bootstapir" | "cotracker" | "blend" | "all";
    write_webm: boolean;
    compress_preset: "mobile" | "hd" | "master";
    enhance_dress_prompt: boolean;
  };
};

export const FLOW_NODE_WIDTH = 176;
export const FLOW_NODE_HEIGHT = 88;

export const DEFAULT_BACKGROUND_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep the exact same framing and subject size as the input image in every frame. Keep her face, identity, hair, and skin tone identical in every frame — same undertone, same lightness, no tan/pale flicker, no color grading shifts on skin. Perfect loop, warm beach lighting.";

export const LEGACY_BACKGROUND_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion, steady camera, perfect loop, warm beach lighting.";

export const LEGACY_LOCKED_CAMERA_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep the exact same framing and subject size as the input image in every frame. Perfect loop, warm beach lighting.";

export const DEFAULT_DRESS_PROMPT =
  "Replace her entire bikini with a fitted emerald satin dress (top and bottom). Keep the exact same beach background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. Keep her face, identity, hair, and skin tone identical in every frame (same undertone and lightness — no tan/pale flicker). No zoom or camera move.";

export type CompressPreset = "mobile" | "hd" | "master";

export const COMPRESS_PRESETS: {
  id: CompressPreset;
  label: string;
  detail: string;
}[] = [
  {
    id: "mobile",
    label: "Mobile delivery",
    detail: "390×672 cover-crop · CRF 23 — exact prototype canvas",
  },
  {
    id: "hd",
    label: "HD delivery",
    detail: "540×930 cover-crop · CRF 20 — same 390∶672 frame, sharper",
  },
  {
    id: "master",
    label: "Master archive",
    detail: "720×1240 cover-crop · CRF 18 — same frame, keep quality",
  },
];

export function parseCompressPreset(value: unknown): CompressPreset {
  return value === "hd" || value === "master" ? value : "mobile";
}

export const DEFAULT_VIDEO_FLOW_JSON: VideoFlowJson = {
  id: "image-to-card",
  label: "Image To Card",
  description:
    "Bikini background from the source image, then a dress edit on the same frames. Card and mesh run automatically; place symbol points, then compress.",
  version: 1,
  pipeline: ["background", "dress", "card", "mesh", "symbols", "compress"],
  reviewSteps: ["background", "dress"],
  canvas: { width: 1280, height: 200 },
  nodes: [
    {
      id: "source",
      kind: "input",
      title: "Flow input",
      subtitle: "Source image",
      description:
        "Upload a still, generate a portrait from a prompt (optional face reference), or face-swap onto a body photo",
      x: 20,
      y: 56,
      step: null,
      inputs: [],
      outputs: [{ id: "image", label: "image" }],
    },
    {
      id: "background",
      kind: "grok",
      title: "Image to video",
      subtitle: "Bikini background",
      description: "Master motion clip — beach / bikini reveal",
      x: 220,
      y: 56,
      step: "background",
      inputs: [{ id: "image", label: "image" }],
      outputs: [{ id: "video", label: "video" }],
    },
    {
      id: "dress",
      kind: "grok",
      title: "Video edit",
      subtitle: "Foreground dress",
      description: "Dress edit on the approved background clip — same scenery, same frames",
      x: 420,
      y: 56,
      step: "dress",
      inputs: [{ id: "video", label: "background" }],
      outputs: [{ id: "video", label: "video" }],
    },
    {
      id: "card",
      kind: "process",
      title: "Create card",
      subtitle: "public/cards/",
      description: "Publish raw clips under public/cards/<id>/, or import both videos by hand",
      x: 620,
      y: 56,
      step: "card",
      inputs: [
        { id: "background", label: "background" },
        { id: "foreground", label: "foreground" },
      ],
      outputs: [{ id: "card", label: "card" }],
    },
    {
      id: "mesh",
      kind: "process",
      title: "Generate mesh",
      subtitle: "Garment tracking",
      description: "Track the foreground for garment-local scratching",
      x: 820,
      y: 56,
      step: "mesh",
      inputs: [{ id: "card", label: "card" }],
      outputs: [{ id: "mesh", label: "mesh" }],
    },
    {
      id: "symbols",
      kind: "process",
      title: "Place symbols",
      subtitle: "12 mesh points",
      description: "Place 12 symbol points randomly (or by click) on the garment mesh",
      x: 920,
      y: 56,
      step: "symbols",
      inputs: [{ id: "mesh", label: "mesh" }],
      outputs: [{ id: "points", label: "points" }],
    },
    {
      id: "compress",
      kind: "process",
      title: "Finalize",
      subtitle: "390∶672 delivery",
      description: "Cover-crop both clips to the prototype canvas, encode delivery MP4s, optional WebM",
      x: 1120,
      y: 56,
      step: "compress",
      inputs: [
        { id: "background", label: "background" },
        { id: "foreground", label: "foreground" },
      ],
      outputs: [{ id: "clips", label: "clips" }],
    },
    {
      id: "output",
      kind: "output",
      title: "Flow output",
      subtitle: "Scratch card",
      description: "Playable card in the scratch prototype",
      x: 1184,
      y: 56,
      step: null,
      inputs: [{ id: "mesh", label: "mesh" }],
      outputs: [],
    },
  ],
  wires: [
    { from: "source", to: "background" },
    { from: "background", to: "dress" },
    { from: "background", to: "card" },
    { from: "dress", to: "card" },
    { from: "card", to: "mesh" },
    { from: "mesh", to: "symbols" },
    { from: "symbols", to: "compress" },
    { from: "card", to: "compress" },
    { from: "dress", to: "compress" },
    { from: "mesh", to: "output" },
  ],
  defaults: {
    background_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
    dress_prompt: DEFAULT_DRESS_PROMPT,
    dress_reference_image: "",
    resolution: "720p",
    tracker: "blend",
    write_webm: true,
    compress_preset: "mobile",
    enhance_dress_prompt: true,
  },
};

const STEP_IDS = new Set<VideoFlowStepKey>([
  "background",
  "dress",
  "card",
  "mesh",
  "symbols",
  "compress",
]);
const NODE_IDS = new Set<FlowNodeId>([
  "source",
  "background",
  "dress",
  "compress",
  "card",
  "mesh",
  "symbols",
  "output",
]);

export function stringifyVideoFlowJson(flow: VideoFlowJson): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}

/** Upgrade flows saved before the symbols step existed. */
function migrateVideoFlow(flow: Partial<VideoFlowJson>): Partial<VideoFlowJson> {
  const pipeline = Array.isArray(flow.pipeline) ? [...flow.pipeline] : [];
  if (pipeline.includes("symbols") || !pipeline.includes("mesh")) {
    return migrateLockedCameraDefaults(flow);
  }
  const meshIndex = pipeline.indexOf("mesh");
  pipeline.splice(meshIndex + 1, 0, "symbols");
  const nodes = Array.isArray(flow.nodes) ? [...flow.nodes] : [];
  if (!nodes.some((node) => node?.id === "symbols")) {
    const symbolsNode = DEFAULT_VIDEO_FLOW_JSON.nodes.find((node) => node.id === "symbols");
    if (symbolsNode) nodes.push(symbolsNode);
  }
  return migrateLockedCameraDefaults({
    ...flow,
    pipeline,
    nodes,
    wires: DEFAULT_VIDEO_FLOW_JSON.wires,
    description: DEFAULT_VIDEO_FLOW_JSON.description,
  });
}

/** Upgrade empty/legacy motion prompts to the locked-camera + skin-stable default. */
function migrateLockedCameraDefaults(flow: Partial<VideoFlowJson>): Partial<VideoFlowJson> {
  const defaults = flow.defaults;
  if (!defaults || typeof defaults !== "object") return flow;
  const motion = defaults.background_motion_prompt?.trim() ?? "";
  const dress = defaults.dress_prompt?.trim() ?? "";
  const nextDefaults = { ...defaults };
  let changed = false;
  if (
    !motion ||
    motion === LEGACY_BACKGROUND_MOTION_PROMPT ||
    motion === LEGACY_LOCKED_CAMERA_MOTION_PROMPT ||
    motion === DEFAULT_BACKGROUND_MOTION_PROMPT
  ) {
    nextDefaults.background_motion_prompt = DEFAULT_BACKGROUND_MOTION_PROMPT;
    changed = true;
  }
  const legacyDress =
    "Replace her entire bikini with a fitted emerald satin dress (top and bottom). Keep the exact same beach background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. No zoom or camera move.";
  if (!dress || dress === legacyDress || dress === DEFAULT_DRESS_PROMPT) {
    nextDefaults.dress_prompt = DEFAULT_DRESS_PROMPT;
    changed = true;
  }
  if (!changed) return flow;
  return {
    ...flow,
    defaults: nextDefaults,
  };
}

export function parseVideoFlowJson(raw: string): VideoFlowJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Invalid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Flow JSON must be an object.");
  }
  const flow = migrateVideoFlow(parsed as Partial<VideoFlowJson>);
  if (!flow.id?.trim()) throw new Error("Flow JSON requires a non-empty id.");
  if (!flow.label?.trim()) throw new Error("Flow JSON requires a non-empty label.");
  if (!Array.isArray(flow.pipeline) || flow.pipeline.length === 0) {
    throw new Error("Flow JSON requires a non-empty pipeline array.");
  }
  for (const step of flow.pipeline) {
    if (!STEP_IDS.has(step as VideoFlowStepKey)) {
      throw new Error(`Unknown pipeline step: ${String(step)}`);
    }
  }
  if (!Array.isArray(flow.reviewSteps)) {
    throw new Error("Flow JSON requires reviewSteps array.");
  }
  for (const step of flow.reviewSteps) {
    if (!STEP_IDS.has(step as VideoFlowStepKey)) {
      throw new Error(`Unknown review step: ${String(step)}`);
    }
  }
  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    throw new Error("Flow JSON requires at least one node.");
  }
  for (const node of flow.nodes) {
    if (!node?.id || !NODE_IDS.has(node.id)) {
      throw new Error(`Invalid node id: ${String(node?.id)}`);
    }
  }
  if (!Array.isArray(flow.wires)) {
    throw new Error("Flow JSON requires wires array.");
  }
  if (!flow.defaults || typeof flow.defaults !== "object") {
    throw new Error("Flow JSON requires defaults object.");
  }
  return {
    ...DEFAULT_VIDEO_FLOW_JSON,
    ...flow,
    id: flow.id.trim(),
    label: flow.label.trim(),
    description: flow.description?.trim() || DEFAULT_VIDEO_FLOW_JSON.description,
    version: typeof flow.version === "number" ? flow.version : 1,
    canvas: {
      width: flow.canvas?.width ?? DEFAULT_VIDEO_FLOW_JSON.canvas.width,
      height: flow.canvas?.height ?? DEFAULT_VIDEO_FLOW_JSON.canvas.height,
    },
    pipeline: flow.pipeline as VideoFlowStepKey[],
    reviewSteps: flow.reviewSteps as VideoFlowStepKey[],
    nodes: (flow.nodes as FlowNodeDef[]).map((node) => {
      const def = DEFAULT_VIDEO_FLOW_JSON.nodes.find((entry) => entry.id === node.id);
      if (!def) return node;
      return {
        ...node,
        description: def.description,
      };
    }),
    wires: flow.wires as FlowWireDef[],
    defaults: {
      ...DEFAULT_VIDEO_FLOW_JSON.defaults,
      ...flow.defaults,
      compress_preset: parseCompressPreset(
        (flow.defaults as VideoFlowJson["defaults"] | undefined)?.compress_preset,
      ),
    },
  };
}

export function stepToNode(flow: VideoFlowJson): Partial<Record<VideoFlowStepKey, FlowNodeId>> {
  const map: Partial<Record<VideoFlowStepKey, FlowNodeId>> = {};
  for (const node of flow.nodes) {
    if (node.step) map[node.step] = node.id;
  }
  return map;
}

export function nodeToStep(flow: VideoFlowJson): Partial<Record<FlowNodeId, VideoFlowStepKey>> {
  const map: Partial<Record<FlowNodeId, VideoFlowStepKey>> = {};
  for (const node of flow.nodes) {
    if (node.step) map[node.id] = node.step;
  }
  return map;
}
