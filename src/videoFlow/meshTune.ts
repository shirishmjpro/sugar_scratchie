export type MeshSilhouetteSource = "person" | "chroma";

export type MeshTuneSettings = {
  loopClose: boolean;
  pruneSpeedMadK: number;
  pruneMinMeanVis: number;
  fieldNeighbors: number;
  fieldPower: number;
  silhouetteSource: MeshSilhouetteSource;
  perFrameMask: boolean;
  refFrame: number | null;
};

/** Tighter defaults for Grok / reflective clips — less field smearing and drift. */
export const DEFAULT_MESH_TUNE: MeshTuneSettings = {
  loopClose: false,
  pruneSpeedMadK: 4,
  pruneMinMeanVis: 0.25,
  fieldNeighbors: 4,
  fieldPower: 2.5,
  silhouetteSource: "person",
  perFrameMask: false,
  refFrame: null,
};

/** Original script defaults before quality tuning. */
export const LEGACY_MESH_TUNE: MeshTuneSettings = {
  loopClose: true,
  pruneSpeedMadK: 6,
  pruneMinMeanVis: 0.15,
  fieldNeighbors: 8,
  fieldPower: 2,
  silhouetteSource: "person",
  perFrameMask: false,
  refFrame: null,
};

export function meshTuneToApi(settings: MeshTuneSettings) {
  return {
    loop_close: settings.loopClose,
    prune_speed_mad_k: settings.pruneSpeedMadK,
    prune_min_mean_vis: settings.pruneMinMeanVis,
    field_neighbors: settings.fieldNeighbors,
    field_power: settings.fieldPower,
    silhouette_source: settings.silhouetteSource,
    per_frame_mask: settings.perFrameMask,
    ref_frame: settings.refFrame,
  };
}

export function meshTuneFromApi(raw: unknown): MeshTuneSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MESH_TUNE };
  const entry = raw as Record<string, unknown>;
  const ref = entry.ref_frame;
  return {
    loopClose: entry.loop_close === true,
    pruneSpeedMadK: clampNumber(entry.prune_speed_mad_k, 1, 12, DEFAULT_MESH_TUNE.pruneSpeedMadK),
    pruneMinMeanVis: clampNumber(entry.prune_min_mean_vis, 0.05, 0.9, DEFAULT_MESH_TUNE.pruneMinMeanVis),
    fieldNeighbors: clampInt(entry.field_neighbors, 1, 16, DEFAULT_MESH_TUNE.fieldNeighbors),
    fieldPower: clampNumber(entry.field_power, 0.5, 4, DEFAULT_MESH_TUNE.fieldPower),
    silhouetteSource: entry.silhouette_source === "chroma" ? "chroma" : "person",
    perFrameMask: entry.per_frame_mask === true,
    refFrame:
      typeof ref === "number" && Number.isFinite(ref) && ref >= 0 ? Math.floor(ref) : null,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  return Math.round(clampNumber(value, min, max, fallback));
}
