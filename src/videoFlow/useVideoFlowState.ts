import { useCallback, useEffect, useState } from "react";
import { api } from "../shared/api";
import { labelFromProjectId } from "./projects";
import type { VideoFlowProject } from "./projects";
import { DEFAULT_VIDEO_FLOW_JSON, parseVideoFlowJson, stringifyVideoFlowJson, type VideoFlowJson } from "./schema";
import {
  DEFAULT_DRESS_VIDEO_MODEL,
  DEFAULT_PORTRAIT_PROMPT,
  DEFAULT_SOURCE_IMAGE_MODEL,
  DEFAULT_SOURCE_IMAGE_PROVIDER,
  isStockPortraitPrompt,
  readActiveProjectId,
  readFlowJsonText,
  readStoredFlowJson,
  readStoredVideoFlowDraft,
  storedDraftFromApi,
  writeActiveProjectId,
  writeStoredFlowJson,
  writeStoredVideoFlowDraft,
  type SourceImageMode,
  type StoredVideoFlowDraft,
  type AiProvider,
  type SourceImageModel,
  type BackgroundVideoModel,
  type DressVideoModel,
  canUseAiProvider,
} from "./storage";
import { DEFAULT_MESH_TUNE, meshTuneToApi } from "./meshTune";
import { MESH_TRACKER_MODES, type MeshTrackerMode } from "./ui";
import { parseCompressPreset, type CompressPreset } from "./schema";

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type HealthResponse = {
  ok: boolean;
  xai_key_loaded: boolean;
  wavespeed_key_loaded: boolean;
};

function draftPayload(
  draft: StoredVideoFlowDraft,
  flow: VideoFlowJson,
  enhancePrompt: boolean,
): Record<string, unknown> {
  return {
    image: draft.image,
    background_motion_prompt:
      draft.backgroundMotionPrompt || flow.defaults.background_motion_prompt,
    foreground_motion_prompt:
      draft.foregroundMotionPrompt || draft.backgroundMotionPrompt || flow.defaults.background_motion_prompt,
    dress_prompt: draft.dressPrompt || flow.defaults.dress_prompt,
    dress_reference_image: draft.dressReferenceImage || flow.defaults.dress_reference_image,
    card_id: draft.cardId,
    card_label: draft.cardLabel || labelFromProjectId(draft.cardId),
    resolution: draft.resolution || flow.defaults.resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker: draft.tracker || flow.defaults.tracker,
    mesh_tune: meshTuneToApi(draft.meshTune),
    write_webm: draft.writeWebm,
    compress_preset: draft.compressPreset,
    source_mode: draft.sourceMode,
    source_prompt: draft.sourcePrompt,
    face_image: draft.faceImage,
    base_image: draft.baseImage,
    provider: draft.aiProvider,
    image_model: draft.sourceImageModel,
    background_video_model: draft.backgroundVideoModel,
    dress_video_model: draft.dressVideoModel,
  };
}

export function useVideoFlowState() {
  const storedFlow = readStoredFlowJson();
  const initialFlow = storedFlow
    ? parseVideoFlowJson(stringifyVideoFlowJson(storedFlow))
    : DEFAULT_VIDEO_FLOW_JSON;

  if (storedFlow && JSON.stringify(storedFlow.pipeline) !== JSON.stringify(initialFlow.pipeline)) {
    writeStoredFlowJson(initialFlow);
  }

  const [flow, setFlow] = useState<VideoFlowJson>(initialFlow);
  const storedDraft = readStoredVideoFlowDraft();

  const [flowJsonText, setFlowJsonText] = useState(readFlowJsonText());
  const [error, setError] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [projects, setProjects] = useState<VideoFlowProject[]>([]);
  const [enhancePrompt, setEnhancePrompt] = useState(flow.defaults.enhance_dress_prompt);

  const [image, setImage] = useState(storedDraft?.image ?? "");
  const [backgroundMotionPrompt, setBackgroundMotionPrompt] = useState(
    storedDraft?.backgroundMotionPrompt ?? flow.defaults.background_motion_prompt,
  );
  const [dressPrompt, setDressPrompt] = useState(storedDraft?.dressPrompt ?? flow.defaults.dress_prompt);
  const [dressReferenceImage, setDressReferenceImage] = useState(
    storedDraft?.dressReferenceImage ?? flow.defaults.dress_reference_image,
  );
  const [cardId, setCardId] = useState(storedDraft?.cardId ?? readActiveProjectId());
  const [cardLabel, setCardLabel] = useState(storedDraft?.cardLabel ?? "");
  const [writeWebm, setWriteWebm] = useState(storedDraft?.writeWebm ?? flow.defaults.write_webm);
  const [compressPreset, setCompressPreset] = useState<CompressPreset>(
    storedDraft?.compressPreset ?? parseCompressPreset(flow.defaults.compress_preset),
  );
  const [resolution, setResolution] = useState(storedDraft?.resolution ?? flow.defaults.resolution);
  const [tracker, setTracker] = useState<MeshTrackerMode>(
    storedDraft?.tracker ?? flow.defaults.tracker,
  );
  const [meshTune, setMeshTune] = useState(storedDraft?.meshTune ?? DEFAULT_MESH_TUNE);
  const [sourceMode, setSourceMode] = useState<SourceImageMode>(storedDraft?.sourceMode ?? "upload");
  const [sourcePrompt, setSourcePrompt] = useState(() => {
    const saved = storedDraft?.sourcePrompt || DEFAULT_PORTRAIT_PROMPT;
    return isStockPortraitPrompt(saved) ? DEFAULT_PORTRAIT_PROMPT : saved;
  });
  const [faceImage, setFaceImage] = useState(storedDraft?.faceImage ?? "");
  const [baseImage, setBaseImage] = useState(storedDraft?.baseImage ?? "");
  const [aiProvider, setAiProvider] = useState<AiProvider>(
    storedDraft?.aiProvider ?? DEFAULT_SOURCE_IMAGE_PROVIDER,
  );
  const [sourceImageModel, setSourceImageModel] = useState<SourceImageModel>(
    storedDraft?.sourceImageModel ?? DEFAULT_SOURCE_IMAGE_MODEL,
  );
  const [backgroundVideoModel, setBackgroundVideoModel] = useState<BackgroundVideoModel>(
    storedDraft?.backgroundVideoModel ?? "grok-imagine",
  );
  const [dressVideoModel, setDressVideoModel] = useState<DressVideoModel>(
    storedDraft?.dressVideoModel ?? DEFAULT_DRESS_VIDEO_MODEL,
  );

  const canUseGrok = Boolean(health?.xai_key_loaded);
  const canUseWavespeed = Boolean(health?.wavespeed_key_loaded);
  const canUseSourceAi = canUseAiProvider(aiProvider, health);
  const activeProjectId = cardId.trim();

  async function refreshHealth() {
    const data = await api<HealthResponse>("/api/health");
    setHealth(data);
  }

  async function refreshJobs() {
    const data = await api<{ jobs: JobInfo[] }>("/api/jobs");
    setJobs(data.jobs);
  }

  const refreshProjects = useCallback(async () => {
    try {
      const data = await api<{ flows: VideoFlowProject[] }>("/api/video-flow");
      setProjects(data.flows);
      return data.flows;
    } catch {
      setProjects([]);
      return [];
    }
  }, []);

  const applyVideoFlowDraft = useCallback((draft: StoredVideoFlowDraft) => {
    setImage(draft.image);
    setBackgroundMotionPrompt(draft.backgroundMotionPrompt || draft.foregroundMotionPrompt);
    setDressPrompt(draft.dressPrompt);
    setDressReferenceImage(draft.dressReferenceImage);
    setCardId(draft.cardId);
    setCardLabel(draft.cardLabel);
    setWriteWebm(draft.writeWebm);
    setCompressPreset(draft.compressPreset ?? "mobile");
    setResolution(draft.resolution);
    setTracker(draft.tracker);
    setMeshTune(draft.meshTune ?? DEFAULT_MESH_TUNE);
    setSourceMode(draft.sourceMode);
    setSourcePrompt(
      isStockPortraitPrompt(draft.sourcePrompt) ? DEFAULT_PORTRAIT_PROMPT : draft.sourcePrompt || DEFAULT_PORTRAIT_PROMPT,
    );
    setFaceImage(draft.faceImage);
    setBaseImage(draft.baseImage);
    setAiProvider(draft.aiProvider);
    setSourceImageModel(draft.sourceImageModel);
    setBackgroundVideoModel(draft.backgroundVideoModel);
    setDressVideoModel(draft.dressVideoModel ?? DEFAULT_DRESS_VIDEO_MODEL);
    writeStoredVideoFlowDraft(draft);
    writeActiveProjectId(draft.cardId);
  }, []);

  const selectProject = useCallback(
    async (projectId: string) => {
      const id = projectId.trim();
      if (!id) return;
      setError("");

      const listed = projects.find((entry) => entry.card_id === id);
      if (listed?.draft) {
        const parsed = storedDraftFromApi(listed.draft);
        if (parsed) {
          if (listed.steps.mesh.status !== "approved") {
            parsed.tracker = flow.defaults.tracker;
          }
          applyVideoFlowDraft(parsed);
          return;
        }
      }

      try {
        const data = await api<{ draft: NonNullable<VideoFlowProject["draft"]> }>(
          `/api/video-flow/${encodeURIComponent(id)}/draft`,
        );
        const parsed = storedDraftFromApi(data.draft);
        if (parsed) {
          try {
            const stateData = await api<{ steps: VideoFlowProject["steps"] }>(
              `/api/video-flow/${encodeURIComponent(id)}/state`,
            );
            if (stateData.steps.mesh.status !== "approved") {
              parsed.tracker = flow.defaults.tracker;
            }
          } catch {
            parsed.tracker = flow.defaults.tracker;
          }
          applyVideoFlowDraft(parsed);
          return;
        }
      } catch {
        // Fall through to minimal project shell.
      }

      applyVideoFlowDraft({
        image: "",
        backgroundMotionPrompt: flow.defaults.background_motion_prompt,
        foregroundMotionPrompt: flow.defaults.background_motion_prompt,
        dressPrompt: flow.defaults.dress_prompt,
        dressReferenceImage: flow.defaults.dress_reference_image,
        cardId: id,
        cardLabel: listed?.draft?.card_label?.trim() || labelFromProjectId(id),
        writeWebm: flow.defaults.write_webm,
        compressPreset: parseCompressPreset(flow.defaults.compress_preset),
        resolution: flow.defaults.resolution,
        tracker: flow.defaults.tracker,
        meshTune: DEFAULT_MESH_TUNE,
        sourceMode: "upload",
        sourcePrompt: DEFAULT_PORTRAIT_PROMPT,
        faceImage: "",
        baseImage: "",
        aiProvider: DEFAULT_SOURCE_IMAGE_PROVIDER,
        sourceImageModel: DEFAULT_SOURCE_IMAGE_MODEL,
        backgroundVideoModel: "grok-imagine",
        dressVideoModel: DEFAULT_DRESS_VIDEO_MODEL,
      });
    },
    [applyVideoFlowDraft, flow.defaults, projects],
  );

  const createProject = useCallback(
    async (projectId: string, label: string) => {
      const id = projectId.trim();
      const nextDraft: StoredVideoFlowDraft = {
        image: "",
        backgroundMotionPrompt: flow.defaults.background_motion_prompt,
        foregroundMotionPrompt: flow.defaults.background_motion_prompt,
        dressPrompt: flow.defaults.dress_prompt,
        dressReferenceImage: flow.defaults.dress_reference_image,
        cardId: id,
        cardLabel: label.trim() || labelFromProjectId(id),
        writeWebm: flow.defaults.write_webm,
        compressPreset: parseCompressPreset(flow.defaults.compress_preset),
        resolution: flow.defaults.resolution,
        tracker: flow.defaults.tracker,
        meshTune: DEFAULT_MESH_TUNE,
        sourceMode: "upload",
        sourcePrompt: DEFAULT_PORTRAIT_PROMPT,
        faceImage: "",
        baseImage: "",
        aiProvider: DEFAULT_SOURCE_IMAGE_PROVIDER,
        sourceImageModel: DEFAULT_SOURCE_IMAGE_MODEL,
        backgroundVideoModel: "grok-imagine",
        dressVideoModel: DEFAULT_DRESS_VIDEO_MODEL,
      };

      await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
        method: "POST",
        body: JSON.stringify(draftPayload(nextDraft, flow, enhancePrompt)),
      });
      applyVideoFlowDraft(nextDraft);
      await refreshProjects();
    },
    [applyVideoFlowDraft, enhancePrompt, flow, refreshProjects],
  );

  useEffect(() => {
    refreshHealth().catch((caught) => setError(String(caught)));
    refreshJobs().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshJobs().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshProjects()
      .then((list) => {
        if (cancelled) return;
        const storedId = storedDraft?.cardId?.trim() || readActiveProjectId();
        if (storedId) return;
        if (list.length > 0) {
          void selectProject(list[0].card_id);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshProjects, selectProject, storedDraft?.cardId]);

  useEffect(() => {
    writeStoredVideoFlowDraft({
      image,
      backgroundMotionPrompt,
      foregroundMotionPrompt: backgroundMotionPrompt,
      dressPrompt,
      dressReferenceImage,
      cardId,
      cardLabel,
      writeWebm,
      compressPreset,
      resolution,
      tracker,
      meshTune,
      sourceMode,
      sourcePrompt,
      faceImage,
      baseImage,
      aiProvider,
      sourceImageModel,
      backgroundVideoModel,
      dressVideoModel,
    });
    if (cardId.trim()) writeActiveProjectId(cardId.trim());
  }, [
    image,
    backgroundMotionPrompt,
    dressPrompt,
    dressReferenceImage,
    cardId,
    cardLabel,
    writeWebm,
    compressPreset,
    resolution,
    tracker,
    meshTune,
    sourceMode,
    sourcePrompt,
    faceImage,
    baseImage,
    aiProvider,
    sourceImageModel,
    backgroundVideoModel,
    dressVideoModel,
  ]);

  function applyFlowDefinition(next: VideoFlowJson) {
    setFlow(next);
    writeStoredFlowJson(next);
    setFlowJsonText(stringifyVideoFlowJson(next));
    setEnhancePrompt(next.defaults.enhance_dress_prompt);
    setBackgroundMotionPrompt(next.defaults.background_motion_prompt);
    setDressPrompt(next.defaults.dress_prompt);
    setDressReferenceImage(next.defaults.dress_reference_image);
    setResolution(next.defaults.resolution);
    setTracker(next.defaults.tracker);
    setWriteWebm(next.defaults.write_webm);
    setCompressPreset(parseCompressPreset(next.defaults.compress_preset));
  }

  function applyJsonFromDesigner() {
    applyFlowDefinition(parseVideoFlowJson(flowJsonText));
  }

  return {
    flow,
    flowJsonText,
    setFlowJsonText,
    error,
    setError,
    health,
    jobs,
    projects,
    activeProjectId,
    enhancePrompt,
    setEnhancePrompt,
    image,
    setImage,
    backgroundMotionPrompt,
    setBackgroundMotionPrompt,
    dressPrompt,
    setDressPrompt,
    dressReferenceImage,
    setDressReferenceImage,
    cardId,
    setCardId,
    cardLabel,
    setCardLabel,
    writeWebm,
    setWriteWebm,
    compressPreset,
    setCompressPreset,
    resolution,
    setResolution,
    tracker,
    setTracker,
    meshTune,
    setMeshTune,
    sourceMode,
    setSourceMode,
    sourcePrompt,
    setSourcePrompt,
    faceImage,
    setFaceImage,
    baseImage,
    setBaseImage,
    aiProvider,
    setAiProvider,
    sourceImageModel,
    setSourceImageModel,
    backgroundVideoModel,
    setBackgroundVideoModel,
    dressVideoModel,
    setDressVideoModel,
    canUseGrok,
    canUseWavespeed,
    canUseSourceAi,
    refreshHealth,
    refreshJobs,
    refreshProjects,
    selectProject,
    createProject,
    applyFlowDefinition,
    applyVideoFlowDraft,
    applyJsonFromDesigner,
  };
}

export type VideoFlowStateBundle = ReturnType<typeof useVideoFlowState>;
