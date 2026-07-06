import { DEFAULT_VIDEO_FLOW_JSON, stringifyVideoFlowJson, type VideoFlowJson } from "./schema";

export type StoredVideoFlowDraft = {
  image: string;
  backgroundMotionPrompt: string;
  foregroundMotionPrompt: string;
  dressPrompt: string;
  cardId: string;
  cardLabel: string;
  writeWebm: boolean;
  resolution: string;
  tracker: "bootstapir" | "cotracker" | "blend";
};

const DRAFT_STORAGE_KEY = "sugar-scratchie:video-flow-draft";
const FLOW_JSON_STORAGE_KEY = "sugar-scratchie:video-flow-json";
const ACTIVE_PROJECT_STORAGE_KEY = "sugar-scratchie:video-flow-active-project";

export function readStoredVideoFlowDraft(): StoredVideoFlowDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredVideoFlowDraft;
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
  card_id?: string;
  card_label?: string;
  write_webm?: boolean;
  resolution?: string;
  tracker?: string;
}): StoredVideoFlowDraft | null {
  if (!draft?.card_id) return null;
  return {
    image: draft.image ?? "",
    backgroundMotionPrompt: draft.background_motion_prompt ?? "",
    foregroundMotionPrompt: draft.foreground_motion_prompt ?? "",
    dressPrompt: draft.dress_prompt ?? "",
    cardId: draft.card_id,
    cardLabel: draft.card_label ?? "",
    writeWebm: draft.write_webm ?? true,
    resolution: draft.resolution ?? "720p",
    tracker: (draft.tracker as StoredVideoFlowDraft["tracker"]) ?? "bootstapir",
  };
}
