import type { VideoFlowStepKey } from "./schema";

export type VideoFlowStepState = {
  status: "locked" | "ready" | "review" | "approved";
  label: string;
  artifacts: string[];
};

export type VideoFlowProject = {
  card_id: string;
  approved: VideoFlowStepKey[];
  steps: Record<VideoFlowStepKey, VideoFlowStepState>;
  complete: boolean;
  updated_at?: number;
  draft?: {
    image?: string;
    background_motion_prompt?: string;
    foreground_motion_prompt?: string;
    dress_prompt?: string;
    card_id?: string;
    card_label?: string;
    model_id?: string;
    write_webm?: boolean;
    compress_preset?: string;
    resolution?: string;
    tracker?: string;
  };
  compress_report?: CompressReport | null;
};

export type CompressReportClip = {
  role?: string;
  path?: string;
  exists?: boolean;
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
  bytes?: number;
  size?: string;
};

export type CompressReport = {
  preset?: string;
  preset_label?: string;
  write_webm?: boolean;
  target_width?: number;
  target_height?: number;
  aspect?: string;
  fit?: string;
  crf?: number;
  duration_delta_before?: number;
  aspect_ok?: boolean;
  before?: Record<string, CompressReportClip>;
  after?: Record<string, CompressReportClip>;
  before_bytes?: number;
  after_bytes?: number;
  size_ratio?: number;
  saved_bytes?: number;
  saved?: string;
  webm_paths?: string[];
};

export const PROJECT_ID_PATTERN = /^[a-z0-9_]+$/;

export function slugifyProjectId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function labelFromProjectId(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function projectSummary(project: VideoFlowProject, pipelineLength: number): string {
  const reviewStep = (Object.entries(project.steps) as [VideoFlowStepKey, VideoFlowStepState][]).find(
    ([, step]) => step.status === "review",
  );
  if (project.complete) return "Complete";
  if (reviewStep) return `${reviewStep[1].label} — needs review`;
  if (project.approved.length === 0) return "Not started";
  return `${project.approved.length}/${pipelineLength} steps done`;
}
