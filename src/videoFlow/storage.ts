import { DEFAULT_VIDEO_FLOW_JSON, stringifyVideoFlowJson, type VideoFlowJson } from "./schema";
import { DEFAULT_MESH_TUNE, meshTuneFromApi, type MeshTuneSettings } from "./meshTune";

export type SourceImageMode = "upload" | "prompt" | "face_swap";

export const DEFAULT_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo.";

export const LEGACY_BIKINI_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in a black bikini, plain white studio background, facing camera, fashion photo.";

export function isStockPortraitPrompt(prompt: string): boolean {
  const stripped = prompt.trim();
  return !stripped || stripped === DEFAULT_PORTRAIT_PROMPT || stripped === LEGACY_BIKINI_PORTRAIT_PROMPT;
}

export type StoredVideoFlowDraft = {
  image: string;
  backgroundMotionPrompt: string;
  foregroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  writeWebm: boolean;
  resolution: string;
  tracker: "bootstapir" | "cotracker" | "blend" | "all";
  meshTune: MeshTuneSettings;
  sourceMode: SourceImageMode;
  sourcePrompt: string;
  faceImage: string;
  baseImage: string;
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
      backgroundMotionPrompt: parsed.backgroundMotionPrompt ?? "",
      foregroundMotionPrompt: parsed.foregroundMotionPrompt ?? "",
      dressPrompt: parsed.dressPrompt ?? "",
      dressReferenceImage: parsed.dressReferenceImage ?? "",
      cardId: parsed.cardId ?? "",
      cardLabel: parsed.cardLabel ?? "",
      writeWebm: parsed.writeWebm ?? true,
      resolution: parsed.resolution ?? "720p",
      tracker: parsed.tracker ?? "all",
      meshTune: meshTuneFromApi(parsed.meshTune),
      sourceMode: parsed.sourceMode ?? "upload",
      sourcePrompt: isStockPortraitPrompt(parsed.sourcePrompt ?? "")
        ? DEFAULT_PORTRAIT_PROMPT
        : (parsed.sourcePrompt ?? DEFAULT_PORTRAIT_PROMPT),
      faceImage: parsed.faceImage ?? "",
      baseImage: parsed.baseImage ?? "",
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
  write_webm?: boolean;
  resolution?: string;
  tracker?: string;
  source_mode?: string;
  source_prompt?: string;
  face_image?: string;
  base_image?: string;
  mesh_tune?: unknown;
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
    writeWebm: draft.write_webm ?? true,
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
  };
}
