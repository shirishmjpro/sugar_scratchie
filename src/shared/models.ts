import { api } from "./api";
import {
  DEFAULT_BACKGROUND_MOTION_PROMPT,
  DEFAULT_DRESS_PROMPT,
} from "../videoFlow/schema";

export type ModelInfo = {
  id: string;
  label: string;
  avatar: string | null;
  created_at?: number | null;
};

export type PhotoInfo = {
  id: string;
  src: string;
};

export type CardWithModel = {
  id: string;
  label: string;
  model_id?: string;
  photos?: PhotoInfo[];
};

export async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const data = await api<{ models: ModelInfo[] }>("/api/models");
    return data.models;
  } catch {
    try {
      const response = await fetch("/models/index.json", { cache: "no-store" });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: ModelInfo[] };
      return data.models ?? [];
    } catch {
      return [];
    }
  }
}

export async function createModel(id: string, label: string): Promise<ModelInfo> {
  return api<ModelInfo>("/api/models", {
    method: "POST",
    body: JSON.stringify({ id, label }),
  });
}

export async function updateModel(modelId: string, label: string): Promise<ModelInfo> {
  return api<ModelInfo>(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
}

export async function deleteModel(modelId: string): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

export async function assignCardToModel(cardId: string, modelId: string): Promise<void> {
  await api(`/api/cards/${encodeURIComponent(cardId)}`, {
    method: "PUT",
    body: JSON.stringify({ model_id: modelId }),
  });
}

/** Create an empty Video Flow draft for a new motion card, assigned to a model. */
export async function createMotionCardDraft(
  cardId: string,
  cardLabel: string,
  modelId: string,
): Promise<void> {
  const id = cardId.trim();
  const label = cardLabel.trim() || id;
  await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
    method: "POST",
    body: JSON.stringify({
      image: "",
      background_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
      foreground_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
      dress_prompt: DEFAULT_DRESS_PROMPT,
      dress_reference_image: "",
      card_id: id,
      card_label: label,
      model_id: modelId.trim(),
      resolution: "720p",
      enhance_dress_prompt: true,
      tracker: "all",
      write_webm: true,
      compress_preset: "mobile",
      source_mode: "upload",
      source_prompt: "",
      face_image: "",
      base_image: "",
    }),
  });
}

export async function reorderModelCards(modelId: string, cardIds: string[]): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}/cards/order`, {
    method: "PUT",
    body: JSON.stringify({ card_ids: cardIds }),
  });
}

export async function uploadModelAvatar(modelId: string, file: File): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/avatar`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function uploadCardPhoto(cardId: string, file: File): Promise<PhotoInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/photos`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<PhotoInfo>;
}

export async function deleteCardPhoto(cardId: string, photoId: string): Promise<void> {
  await api(`/api/cards/${encodeURIComponent(cardId)}/photos/${encodeURIComponent(photoId)}`, {
    method: "DELETE",
  });
}
