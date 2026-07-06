import { useCallback, useEffect, useState } from "react";
import { api } from "../shared/api";
import { labelFromProjectId } from "./projects";
import type { VideoFlowProject } from "./projects";
import { DEFAULT_VIDEO_FLOW_JSON, parseVideoFlowJson, stringifyVideoFlowJson, type VideoFlowJson } from "./schema";
import {
  readActiveProjectId,
  readFlowJsonText,
  readStoredFlowJson,
  readStoredVideoFlowDraft,
  storedDraftFromApi,
  writeActiveProjectId,
  writeStoredFlowJson,
  writeStoredVideoFlowDraft,
  type StoredVideoFlowDraft,
} from "./storage";
import { TRACKERS } from "./ui";

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
    card_id: draft.cardId,
    card_label: draft.cardLabel || labelFromProjectId(draft.cardId),
    resolution: draft.resolution || flow.defaults.resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker: draft.tracker || flow.defaults.tracker,
    write_webm: draft.writeWebm,
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
  const [cardId, setCardId] = useState(storedDraft?.cardId ?? readActiveProjectId());
  const [cardLabel, setCardLabel] = useState(storedDraft?.cardLabel ?? "");
  const [writeWebm, setWriteWebm] = useState(storedDraft?.writeWebm ?? flow.defaults.write_webm);
  const [resolution, setResolution] = useState(storedDraft?.resolution ?? flow.defaults.resolution);
  const [tracker, setTracker] = useState<(typeof TRACKERS)[number]>(
    storedDraft?.tracker ?? flow.defaults.tracker,
  );

  const canUseGrok = Boolean(health?.xai_key_loaded);
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
    setCardId(draft.cardId);
    setCardLabel(draft.cardLabel);
    setWriteWebm(draft.writeWebm);
    setResolution(draft.resolution);
    setTracker(draft.tracker);
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
        cardId: id,
        cardLabel: listed?.draft?.card_label?.trim() || labelFromProjectId(id),
        writeWebm: flow.defaults.write_webm,
        resolution: flow.defaults.resolution,
        tracker: flow.defaults.tracker,
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
        cardId: id,
        cardLabel: label.trim() || labelFromProjectId(id),
        writeWebm: flow.defaults.write_webm,
        resolution: flow.defaults.resolution,
        tracker: flow.defaults.tracker,
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
      cardId,
      cardLabel,
      writeWebm,
      resolution,
      tracker,
    });
    if (cardId.trim()) writeActiveProjectId(cardId.trim());
  }, [image, backgroundMotionPrompt, dressPrompt, cardId, cardLabel, writeWebm, resolution, tracker]);

  function applyFlowDefinition(next: VideoFlowJson) {
    setFlow(next);
    writeStoredFlowJson(next);
    setFlowJsonText(stringifyVideoFlowJson(next));
    setEnhancePrompt(next.defaults.enhance_dress_prompt);
    setBackgroundMotionPrompt(next.defaults.background_motion_prompt);
    setDressPrompt(next.defaults.dress_prompt);
    setResolution(next.defaults.resolution);
    setTracker(next.defaults.tracker);
    setWriteWebm(next.defaults.write_webm);
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
    image,
    setImage,
    backgroundMotionPrompt,
    setBackgroundMotionPrompt,
    dressPrompt,
    setDressPrompt,
    cardId,
    setCardId,
    cardLabel,
    setCardLabel,
    writeWebm,
    setWriteWebm,
    resolution,
    setResolution,
    tracker,
    setTracker,
    canUseGrok,
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
