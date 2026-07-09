import {
  DEFAULT_BACKGROUND_MOTION_PROMPT,
  DEFAULT_VIDEO_FLOW_JSON,
  LEGACY_BACKGROUND_MOTION_PROMPT,
  LEGACY_LOCKED_CAMERA_MOTION_PROMPT,
  parseCompressPreset,
  stringifyVideoFlowJson,
  type CompressPreset,
  type VideoFlowJson,
} from "./schema";
import { DEFAULT_MESH_TUNE, meshTuneFromApi, type MeshTuneSettings } from "./meshTune";

export type SourceImageMode = "upload" | "prompt" | "face_swap";

export type AiProvider = "xai" | "wavespeed";

export type SourceImageModel = "grok-imagine" | "seedream-v5-lite";

export type BackgroundVideoModel = "grok-imagine" | "wan-2.2-spicy";

export type DressVideoModel = "grok-imagine" | "wan-2.2-video-edit";

export const DEFAULT_SOURCE_IMAGE_PROVIDER: AiProvider = "wavespeed";
export const DEFAULT_SOURCE_IMAGE_MODEL: SourceImageModel = "seedream-v5-lite";
export const DEFAULT_DRESS_VIDEO_MODEL: DressVideoModel = "wan-2.2-video-edit";

export function parseBackgroundVideoModel(value: unknown): BackgroundVideoModel {
  return value === "wan-2.2-spicy" ? "wan-2.2-spicy" : "grok-imagine";
}

export function parseDressVideoModel(value: unknown): DressVideoModel {
  return value === "wan-2.2-video-edit" ? "wan-2.2-video-edit" : "grok-imagine";
}

export function wavespeedPipelineModelValue(
  sourceImageModel: SourceImageModel,
  backgroundVideoModel: BackgroundVideoModel,
): string {
  if (backgroundVideoModel === "wan-2.2-spicy") return "wan-2.2-spicy";
  return sourceImageModel;
}

export function parseAiProvider(value: unknown): AiProvider {
  return value === "wavespeed" || value === "seedream-v5-lite" ? "wavespeed" : "xai";
}

export function parseSourceImageModel(value: unknown, legacyProvider?: unknown): SourceImageModel {
  if (value === "seedream-v5-lite" || value === "seedream-v5.0-lite" || legacyProvider === "seedream-v5-lite" || legacyProvider === "seedream-v5.0-lite") {
    return "seedream-v5-lite";
  }
  return "grok-imagine";
}

export const DEFAULT_PORTRAIT_PROMPT =
  "Medium full-body portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo. Frame from head to mid-thigh so she fills most of the vertical frame — same camera distance as a standard fashion lookbook shot. Do not crop as a close-up face shot and do not pull back to a distant full-body wide shot with empty space.";

export const LEGACY_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo.";

export const LEGACY_BIKINI_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in a black bikini, plain white studio background, facing camera, fashion photo.";

export function isStockPortraitPrompt(prompt: string): boolean {
  const stripped = prompt.trim();
  return (
    !stripped ||
    stripped === DEFAULT_PORTRAIT_PROMPT ||
    stripped === LEGACY_PORTRAIT_PROMPT ||
    stripped === LEGACY_BIKINI_PORTRAIT_PROMPT
  );
}

function normalizeStoredMotionPrompt(prompt: string | undefined): string {
  const stripped = (prompt ?? "").trim();
  if (
    !stripped ||
    stripped === LEGACY_BACKGROUND_MOTION_PROMPT ||
    stripped === LEGACY_LOCKED_CAMERA_MOTION_PROMPT ||
    stripped === DEFAULT_BACKGROUND_MOTION_PROMPT
  ) {
    return DEFAULT_BACKGROUND_MOTION_PROMPT;
  }
  return stripped;
}

export type StoredVideoFlowDraft = {
  image: string;
  backgroundMotionPrompt: string;
  foregroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  modelId: string;
  writeWebm: boolean;
  compressPreset: CompressPreset;
  resolution: string;
  tracker: "bootstapir" | "cotracker" | "blend" | "all";
  meshTune: MeshTuneSettings;
  sourceMode: SourceImageMode;
  sourcePrompt: string;
  faceImage: string;
  baseImage: string;
  aiProvider: AiProvider;
  sourceImageModel: SourceImageModel;
  backgroundVideoModel: BackgroundVideoModel;
  dressVideoModel: DressVideoModel;
};

const DRAFT_STORAGE_KEY = "sugar-scratchie:video-flow-draft";
const FLOW_JSON_STORAGE_KEY = "sugar-scratchie:video-flow-json";
const ACTIVE_PROJECT_STORAGE_KEY = "sugar-scratchie:video-flow-active-project";

export function readStoredVideoFlowDraft(): StoredVideoFlowDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredVideoFlowDraft>;
    if (!parsed.cardId && !parsed.image) return null;
    return {
      image: parsed.image ?? "",
      backgroundMotionPrompt: normalizeStoredMotionPrompt(parsed.backgroundMotionPrompt),
      foregroundMotionPrompt: normalizeStoredMotionPrompt(
        parsed.foregroundMotionPrompt || parsed.backgroundMotionPrompt,
      ),
      dressPrompt: parsed.dressPrompt ?? "",
      dressReferenceImage: parsed.dressReferenceImage ?? "",
      cardId: parsed.cardId ?? "",
      cardLabel: parsed.cardLabel ?? "",
      modelId: parsed.modelId ?? "",
      writeWebm: parsed.writeWebm ?? true,
      compressPreset: parseCompressPreset(parsed.compressPreset),
      resolution: parsed.resolution ?? "720p",
      tracker: parsed.tracker ?? "all",
      meshTune: meshTuneFromApi(parsed.meshTune),
      sourceMode: parsed.sourceMode ?? "upload",
      sourcePrompt: isStockPortraitPrompt(parsed.sourcePrompt ?? "")
        ? DEFAULT_PORTRAIT_PROMPT
        : (parsed.sourcePrompt ?? DEFAULT_PORTRAIT_PROMPT),
      faceImage: parsed.faceImage ?? "",
      baseImage: parsed.baseImage ?? "",
      aiProvider: parseAiProvider(parsed.aiProvider),
      sourceImageModel: parseSourceImageModel(parsed.sourceImageModel, parsed.aiProvider),
      backgroundVideoModel: parseBackgroundVideoModel(parsed.backgroundVideoModel),
      dressVideoModel: parseDressVideoModel(parsed.dressVideoModel),
    };
  } catch {
    return null;
  }
}

export function writeStoredVideoFlowDraft(draft: StoredVideoFlowDraft) {
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function readStoredFlowJson(): VideoFlowJson | null {
  try {
    const raw = localStorage.getItem(FLOW_JSON_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as VideoFlowJson;
  } catch {
    return null;
  }
}

export function writeStoredFlowJson(flow: VideoFlowJson) {
  localStorage.setItem(FLOW_JSON_STORAGE_KEY, JSON.stringify(flow));
}

export function readActiveProjectId(): string {
  return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)?.trim() ?? "";
}

export function writeActiveProjectId(projectId: string) {
  if (projectId.trim()) {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId.trim());
  } else {
    localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  }
}

export function canUseAiProvider(
  provider: AiProvider,
  health: { xai_key_loaded?: boolean; wavespeed_key_loaded?: boolean } | null,
): boolean {
  if (!health) return false;
  if (provider === "xai") return Boolean(health.xai_key_loaded);
  return Boolean(health.wavespeed_key_loaded);
}

export function readFlowJsonText(): string {
  const stored = readStoredFlowJson();
  return stringifyVideoFlowJson(stored ?? DEFAULT_VIDEO_FLOW_JSON);
}

export function storedDraftFromApi(draft?: {
  image?: string;
  background_motion_prompt?: string;
  foreground_motion_prompt?: string;
  dress_prompt?: string;
  dress_reference_image?: string;
  card_id?: string;
  card_label?: string;
  model_id?: string;
  write_webm?: boolean;
  compress_preset?: string;
  resolution?: string;
  tracker?: string;
  source_mode?: string;
  source_prompt?: string;
  face_image?: string;
  base_image?: string;
  mesh_tune?: unknown;
  ai_provider?: string;
  source_image_model?: string;
  background_video_model?: string;
  dress_video_model?: string;
}): StoredVideoFlowDraft | null {
  if (!draft?.card_id) return null;
  const sourceMode = draft.source_mode;
  return {
    image: draft.image ?? "",
    backgroundMotionPrompt: draft.background_motion_prompt ?? "",
    foregroundMotionPrompt: draft.foreground_motion_prompt ?? "",
    dressPrompt: draft.dress_prompt ?? "",
    dressReferenceImage: draft.dress_reference_image ?? "",
    cardId: draft.card_id,
    cardLabel: draft.card_label ?? "",
    modelId: draft.model_id ?? "",
    writeWebm: draft.write_webm ?? true,
    compressPreset: parseCompressPreset(draft.compress_preset),
    resolution: draft.resolution ?? "720p",
    tracker: (draft.tracker as StoredVideoFlowDraft["tracker"]) ?? "all",
    meshTune: meshTuneFromApi(draft.mesh_tune),
    sourceMode:
      sourceMode === "prompt" || sourceMode === "face_swap" || sourceMode === "upload"
        ? sourceMode
        : "upload",
    sourcePrompt: draft.source_prompt ?? "",
    faceImage: draft.face_image ?? "",
    baseImage: draft.base_image ?? "",
    aiProvider: parseAiProvider(draft.ai_provider),
    sourceImageModel: parseSourceImageModel(draft.source_image_model, draft.ai_provider),
    backgroundVideoModel: parseBackgroundVideoModel(draft.background_video_model),
    dressVideoModel: parseDressVideoModel(draft.dress_video_model),
  };
}
