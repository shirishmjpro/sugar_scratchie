import {
  Award,
  Clover,
  Coins,
  Gem,
  Heart,
  Sparkles,
  Star,
  Ticket,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { GarmentGLRenderer, PRESENT_ZOOM } from "./glRenderer";

// On-screen diagnostics (FPS, layer drift, raw video state) shown only when the
// page is opened with ?debug=1. Self-contained: it polls the DOM/video elements
// directly so it adds no coupling to the render loop. Used to debug Safari, which
// can't be driven from the dev tooling here.
function DebugHud() {
  const [lines, setLines] = useState<string[]>(["debug: starting…"]);

  useEffect(() => {
    let frames = 0;
    let rafId = 0;
    // Per-video: how many distinct currentTime values we saw (= delivered video
    // frames) and the last value, so we can report the *effective* playback fps
    // separately from the render fps. A low video fps while render fps stays high
    // is the signature of decode stutter (the canvas redraws fine, but it's
    // showing the same decoded frame repeatedly).
    const vstate = new Map<HTMLVideoElement, { last: number; count: number }>();
    const tick = () => {
      frames += 1;
      for (const v of document.querySelectorAll<HTMLVideoElement>(
        ".source-video",
      )) {
        const s = vstate.get(v);
        if (!s) {
          vstate.set(v, { last: v.currentTime, count: 0 });
        } else if (v.currentTime !== s.last) {
          s.last = v.currentTime;
          s.count += 1;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    let last = performance.now();
    let peakHeap = 0;
    const intervalId = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(1, now - last);
      const fps = Math.round((frames * 1000) / elapsed);
      frames = 0;
      last = now;

      const vids = Array.from(
        document.querySelectorAll<HTMLVideoElement>(".source-video"),
      );
      const [bottom, foreground] = vids;
      const out: string[] = [`render ${fps}fps`];

      // JS heap usage. performance.memory is non-standard (Chromium only) but
      // works on plain http/localhost — unlike measureUserAgentSpecificMemory,
      // which needs cross-origin isolation. Safari exposes neither, so we note
      // it as unavailable there.
      const mem = (
        performance as Performance & {
          memory?: {
            usedJSHeapSize: number;
            totalJSHeapSize: number;
            jsHeapSizeLimit: number;
          };
        }
      ).memory;
      const mb = (n: number) => (n / 1048576).toFixed(1);
      if (mem) {
        // Show one decimal + running peak so small allocations are visible; the
        // whole-MB rounding before made it look frozen. NOTE: this is only the JS
        // heap — GPU textures and video decode buffers (what actually grows while
        // scratching) live outside it, so use Chrome's Task Manager for true RAM.
        if (mem.usedJSHeapSize > peakHeap) peakHeap = mem.usedJSHeapSize;
        out.push(
          `heap ${mb(mem.usedJSHeapSize)}MB peak ${mb(peakHeap)} (lim ${mb(mem.jsHeapSizeLimit)})`,
        );
      } else {
        out.push("heap n/a (no perf.memory)");
      }
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
        .deviceMemory;
      if (deviceMemory) out.push(`devMem ~${deviceMemory}GB`);

      if (bottom && foreground) {
        const drift = bottom.currentTime - foreground.currentTime;
        out.push(
          `drift ${drift.toFixed(3)}s  fgRate ${foreground.playbackRate.toFixed(3)}`,
        );
      }
      vids.forEach((v, i) => {
        const tag = i === 0 ? "btm" : "fg ";
        const s = vstate.get(v);
        const vfps = s ? Math.round((s.count * 1000) / elapsed) : 0;
        if (s) s.count = 0;
        out.push(
          `${tag} ${vfps}vfps rs${v.readyState} ${v.paused ? "PAUSED" : "play"}${v.seeking ? " SEEK" : ""} t${v.currentTime.toFixed(2)}${v.error ? ` ERR${v.error.code}` : ""}`,
        );
      });
      setLines(out);
    }, 500);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        zIndex: 50,
        padding: "6px 8px",
        background: "rgba(0,0,0,0.72)",
        color: "#7CFC00",
        font: "11px/1.35 ui-monospace, Menlo, monospace",
        whiteSpace: "pre",
        borderRadius: 6,
        pointerEvents: "none",
        maxWidth: "92%",
      }}
    >
      {lines.join("\n")}
    </div>
  );
}

type Vec2 = {
  x: number;
  y: number;
};

type ScratchMark = {
  u: number;
  v: number;
  radius: number;
};

// A coin that animates from the scratch origin up to a symbol slot in the top
// bar each time a new symbol ("coin") is earned. Positions are stage-relative
// pixels; the CSS keyframe arcs the coin from `from*` to `to*`.
type FlyingCoin = {
  id: number;
  typeId: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  midX: number;
  midY: number;
  delayMs: number;
};

const COIN_FLIGHT_DURATION_MS = 620;
const COIN_FLIGHT_STAGGER_MS = 80;

const CANVAS_WIDTH = 390;
const CANVAS_HEIGHT = 672;
// A card pairs the reveal (bottom) video, the green-screen foreground video, and
// the tracked mesh generated from that foreground. Switching cards swaps all
// three together so the scratch holes line up with the right clip.
type Card = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
  mesh: string;
};

const CARDS: Card[] = [
  {
    id: "original",
    label: "Original",
    bottom: "/cards/ai%20girl%202.mp4",
    foreground: "/cards/Green%20bg%20sample%202%20swap.mp4",
    mesh: "tracked-mesh.json",
  },
  {
    id: "girl_1",
    label: "Girl 1",
    bottom: "/cards/girl_1/background.mp4",
    foreground: "/cards/girl_1/foreground.mp4",
    mesh: "girl_1.json",
  },
  {
    id: "girl_2",
    label: "Girl 2",
    bottom: "/cards/girl_2/background.mp4",
    foreground: "/cards/girl_2/foreground.mp4",
    mesh: "girl_2.json",
  },
  {
    id: "juliana_1",
    label: "Juliana 1",
    bottom: "/cards/juliana_1/background.mp4",
    foreground: "/cards/juliana_1/foreground.mp4",
    mesh: "juliana_1.json",
  },
  {
    id: "juliana_2",
    label: "Juliana 2",
    bottom: "/cards/juliana_2/background.mp4",
    foreground: "/cards/juliana_2/foreground.mp4",
    mesh: "juliana_2.json",
  },
  {
    id: "chinese_1",
    label: "Chinese 1",
    bottom: "/cards/chinese_1/background.mp4",
    foreground: "/cards/chinese_1/foreground.mp4",
    mesh: "chinese_1.json",
  },
];

const MESH_INDEX_SRC = "/mesh/index.json";
const MESH_DIRECTORY_SRC = "/mesh";
const DEFAULT_MESH_FILE = "tracked-mesh.json";
const SYMBOL_TYPE_COUNT = 8;
const SYMBOL_SLOT_COUNT = 12;
const SYMBOL_REVEAL_STEP_MANUAL = 0.056;
const SYMBOL_REVEAL_STEP_AUTO = 0.083;
const FULL_REVEAL_MANUAL_THRESHOLD = 0.7;
const WIN_MATCH_COUNT = 3;
const GAME_OUTCOME_OVERLAY_PAD_MS = 300;
const GAME_OUTCOME_SILENT_DELAY_MS = 1500;
const UI_STATE_UPDATE_INTERVAL_MS = 250;
const SCRATCH_ZOOM_STORAGE_KEY = "sugar-scratchie:scratch-zoom";
const SOUND_STORAGE_KEY = "sugar-scratchie:sound";

type ScratchZoomSettings = {
  enabled: boolean;
  scale: number;
  durationMs: number;
  bounce: boolean;
};

const SCRATCH_ZOOM_DEFAULTS: ScratchZoomSettings = {
  enabled: true,
  scale: 1.35,
  durationMs: 180,
  bounce: false,
};

const SYMBOL_TYPES: { icon: LucideIcon; label: string; color: string }[] = [
  { icon: Star, label: "Star", color: "#ffd54a" },
  { icon: Coins, label: "Coin", color: "#ffb74a" },
  { icon: Gem, label: "Gem", color: "#7ec8ff" },
  { icon: Clover, label: "Lucky", color: "#6ddf8a" },
  { icon: Award, label: "Badge", color: "#c9a0ff" },
  { icon: Ticket, label: "Ticket", color: "#ff9eb8" },
  { icon: Heart, label: "Heart", color: "#ff6b8a" },
  { icon: Sparkles, label: "Sparkle", color: "#fff4a8" },
];

function buildSessionSymbols(): number[] {
  return Array.from({ length: SYMBOL_SLOT_COUNT }, () =>
    Math.floor(Math.random() * SYMBOL_TYPE_COUNT),
  );
}

function revealedSymbolCount(progress: number, autoMode: boolean) {
  const step = autoMode ? SYMBOL_REVEAL_STEP_AUTO : SYMBOL_REVEAL_STEP_MANUAL;
  return Math.min(SYMBOL_SLOT_COUNT, Math.floor(progress / step));
}

function isGarmentFullyRevealed(
  progress: number,
  revealedCount: number,
  sampleCount: number,
  autoMode: boolean,
) {
  if (sampleCount === 0) return false;
  if (autoMode) {
    return revealedCount >= sampleCount;
  }
  return (
    progress >= FULL_REVEAL_MANUAL_THRESHOLD ||
    revealedCount >= Math.ceil(sampleCount * FULL_REVEAL_MANUAL_THRESHOLD)
  );
}

function evaluateSessionWin(symbolIds: number[]) {
  const counts = new Array(SYMBOL_TYPE_COUNT).fill(0);
  for (const id of symbolIds) {
    counts[id] += 1;
    if (counts[id] >= WIN_MATCH_COUNT) return true;
  }
  return false;
}

type GameResult = "win" | "lose";

const DESKTOP_SETTINGS_TABS = [
  { id: "scratch-zoom", label: "Scratch zoom" },
  { id: "sound", label: "Sound" },
  { id: "auto-scratch", label: "Auto scratch" },
] as const;

type DesktopSettingsTab = (typeof DESKTOP_SETTINGS_TABS)[number]["id"];

// One chromatic note per symbol slot (C5 → B5); slot index always maps to the same pitch.
const SYMBOL_NOTE_BASE_HZ = 523.25;
const SYMBOL_NOTE_DURATION_S = 0.32;

type SymbolAudioState = {
  ctx: AudioContext | null;
};

function ensureSymbolAudio(state: SymbolAudioState) {
  if (typeof window === "undefined") return null;
  if (!state.ctx) {
    const AudioCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor) return null;
    state.ctx = new AudioCtor();
  }
  if (state.ctx.state === "suspended") void state.ctx.resume();
  return state.ctx;
}

function symbolSlotFrequency(slotIndex: number) {
  return SYMBOL_NOTE_BASE_HZ * 2 ** (slotIndex / SYMBOL_SLOT_COUNT);
}

function playSymbolSlotNote(state: SymbolAudioState, slotIndex: number) {
  const ctx = ensureSymbolAudio(state);
  if (!ctx || slotIndex < 0 || slotIndex >= SYMBOL_SLOT_COUNT) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(symbolSlotFrequency(slotIndex), now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + SYMBOL_NOTE_DURATION_S);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + SYMBOL_NOTE_DURATION_S + 0.02);
}

function playNewSymbolNotes(
  state: SymbolAudioState,
  prevCount: number,
  nextCount: number,
  enabled: boolean,
) {
  if (!enabled) return;
  for (let slot = prevCount; slot < nextCount; slot += 1) {
    playSymbolSlotNote(state, slot);
  }
}

function scheduleTone(
  ctx: AudioContext,
  startAt: number,
  frequency: number,
  durationS: number,
  volume: number,
  type: OscillatorType = "triangle",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS + 0.02);
}

function scheduleSlide(
  ctx: AudioContext,
  startAt: number,
  fromHz: number,
  toHz: number,
  durationS: number,
  volume: number,
  type: OscillatorType = "triangle",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, startAt);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(toHz, 1),
    startAt + durationS,
  );
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS + 0.02);
}

function playGameOutcomeSound(
  state: SymbolAudioState,
  outcome: GameResult,
  enabled: boolean,
): number {
  if (!enabled) return GAME_OUTCOME_SILENT_DELAY_MS;

  const ctx = ensureSymbolAudio(state);
  if (!ctx) return 1800;

  const now = ctx.currentTime;

  if (outcome === "win") {
    const sparkle = [
      523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77, 1174.66, 1318.51,
      1567.98, 1760, 2093,
    ];
    const sparkleStep = 0.048;
    sparkle.forEach((freq, index) => {
      scheduleTone(ctx, now + index * sparkleStep, freq, 0.09, 0.17, "sine");
      if (index % 2 === 0) {
        scheduleTone(
          ctx,
          now + index * sparkleStep + 0.012,
          freq * 2,
          0.055,
          0.09,
          "triangle",
        );
      }
    });

    const fanfareStart = now + sparkle.length * sparkleStep + 0.06;
    const fanfare = [523.25, 659.25, 783.99, 987.77, 1174.66];
    fanfare.forEach((freq, index) => {
      const t = fanfareStart + index * 0.1;
      scheduleTone(ctx, t, freq, 0.15, 0.3, "square");
      scheduleTone(ctx, t, freq * 0.5, 0.15, 0.14, "sawtooth");
      scheduleTone(ctx, t + 0.04, freq * 1.5, 0.08, 0.08, "triangle");
    });

    const chordAt = fanfareStart + fanfare.length * 0.1 + 0.1;
    const chord = [261.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.51];
    chord.forEach((freq, index) => {
      const type: OscillatorType = index < 2 ? "sawtooth" : "triangle";
      scheduleTone(ctx, chordAt, freq, 0.78, index < 2 ? 0.11 : 0.13, type);
    });

    const glitterStart = chordAt + 0.12;
    const glitter = [2093, 2349, 2637, 2793, 3136, 3520];
    glitter.forEach((freq, index) => {
      scheduleTone(ctx, glitterStart + index * 0.045, freq, 0.11, 0.11, "sine");
    });

    const shimmerStart = glitterStart + glitter.length * 0.045 + 0.08;
    for (let i = 0; i < 6; i += 1) {
      scheduleTone(
        ctx,
        shimmerStart + i * 0.06,
        1760 + i * 110,
        0.07,
        0.09,
        "sine",
      );
    }

    const endTime = shimmerStart + 6 * 0.06 + 0.35;
    return (endTime - now) * 1000 + GAME_OUTCOME_OVERLAY_PAD_MS;
  }

  // Sad descending "wah wah" for a loss.
  scheduleSlide(ctx, now, 340, 190, 0.52, 0.2, "sawtooth");
  scheduleSlide(ctx, now + 0.62, 290, 130, 0.58, 0.18, "sawtooth");
  scheduleSlide(ctx, now + 1.28, 220, 95, 0.72, 0.16, "triangle");
  return 2.05 * 1000 + GAME_OUTCOME_OVERLAY_PAD_MS;
}

function GameSymbolIcon({ typeId }: { typeId: number }) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  const Icon = entry.icon;
  return (
    <Icon aria-hidden="true" color={entry.color} size={16} strokeWidth={2.2} />
  );
}

function scratchZoomEasing(bounce: boolean) {
  return bounce ? "cubic-bezier(0.34, 1.56, 0.64, 1)" : "ease-out";
}

function loadSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed.enabled ?? true;
  } catch {
    return true;
  }
}

function loadScratchZoomSettings(): ScratchZoomSettings {
  if (typeof window === "undefined") return SCRATCH_ZOOM_DEFAULTS;
  try {
    const raw = localStorage.getItem(SCRATCH_ZOOM_STORAGE_KEY);
    if (!raw) return SCRATCH_ZOOM_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ScratchZoomSettings>;
    return {
      enabled: parsed.enabled ?? SCRATCH_ZOOM_DEFAULTS.enabled,
      scale: clampValue(
        Number(parsed.scale) || SCRATCH_ZOOM_DEFAULTS.scale,
        1,
        2,
      ),
      durationMs: clampValue(
        Number(parsed.durationMs) || SCRATCH_ZOOM_DEFAULTS.durationMs,
        50,
        800,
      ),
      bounce: parsed.bounce ?? SCRATCH_ZOOM_DEFAULTS.bounce,
    };
  } catch {
    return SCRATCH_ZOOM_DEFAULTS;
  }
}

const AUTO_SCRATCH_STORAGE_KEY = "sugar-scratchie:auto-scratch";
const SCRATCH_RADIUS = 0.045;
const AUTO_SCRATCH_RADIUS = 0.092;
const AUTO_SCRATCH_DIAGONAL_LINES = 18;
// Step along each ↘ stroke (top-left → bottom-right) so brush circles overlap.
const AUTO_SCRATCH_PATH_STEP_UV = AUTO_SCRATCH_RADIUS * 0.72;
const AUTO_SCRATCH_FILL_BATCH = 36;
const AUTO_SCRATCH_MAX_PER_FRAME = 32;

type AutoScratchSettings = {
  enabled: boolean;
  speed: number;
  flakes: boolean;
};

const AUTO_SCRATCH_DEFAULTS: AutoScratchSettings = {
  enabled: false,
  speed: 58,
  flakes: true,
};

function loadAutoScratchSettings(): AutoScratchSettings {
  if (typeof window === "undefined") return AUTO_SCRATCH_DEFAULTS;
  try {
    const raw = localStorage.getItem(AUTO_SCRATCH_STORAGE_KEY);
    if (!raw) return AUTO_SCRATCH_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AutoScratchSettings>;
    return {
      enabled: parsed.enabled ?? AUTO_SCRATCH_DEFAULTS.enabled,
      speed: clampValue(
        Number(parsed.speed) || AUTO_SCRATCH_DEFAULTS.speed,
        1,
        120,
      ),
      flakes: parsed.flakes ?? AUTO_SCRATCH_DEFAULTS.flakes,
    };
  } catch {
    return AUTO_SCRATCH_DEFAULTS;
  }
}

function clampValue(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

function foregroundTimeFromBottom(
  source: HTMLVideoElement,
  target: HTMLVideoElement,
) {
  const srcT = source.currentTime;
  const srcDur = source.duration;
  const tgtDur = target.duration;
  if (!Number.isFinite(srcT) || !Number.isFinite(tgtDur) || tgtDur <= 0)
    return srcT;
  if (
    Number.isFinite(srcDur) &&
    srcDur > 0 &&
    Math.abs(srcDur - tgtDur) <= 0.25
  ) {
    return Math.min(Math.max(0, srcT), tgtDur - 0.001);
  }
  return srcT % tgtDur;
}

// Subtle virtual camera that keeps the performer's chest near a fixed framing
// point. The chest anchor is a mesh-UV coordinate (roughly center, upper torso);
// each frame we sample where it lands and pan the presented shot toward the
// target. Pan is clamped small (and < PRESENT_ZOOM-1 so no edge shows) and
// smoothed so the move stays gentle.
const CHEST_ANCHOR_UV = { x: 0.5, y: 0.4 };
const CHEST_TARGET_UV = { x: 0.5, y: 0.4 };
const CHEST_FOLLOW_STRENGTH = 0.7;
const CHEST_CAM_MAX = Math.min(0.05, PRESENT_ZOOM - 1);
const CHEST_SMOOTH = 0.08;

// Bilinearly interpolate the deformed mesh at a fractional UV grid position to
// get its current canvas-pixel location (the mesh UV grid is regular 0..1).
function sampleMeshUvToWorld(
  sample: TrackedMeshSample,
  u: number,
  v: number,
): Vec2 {
  const { cols, rows, verts } = sample;
  const gx = clampValue(u * (cols - 1), 0, cols - 1);
  const gy = clampValue(v * (rows - 1), 0, rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const v00 = verts[y0 * cols + x0];
  const v10 = verts[y0 * cols + x1];
  const v01 = verts[y1 * cols + x0];
  const v11 = verts[y1 * cols + x1];
  const topX = v00.x + (v10.x - v00.x) * fx;
  const topY = v00.y + (v10.y - v00.y) * fx;
  const botX = v01.x + (v11.x - v01.x) * fx;
  const botY = v01.y + (v11.y - v01.y) * fx;
  return { x: topX + (botX - topX) * fy, y: topY + (botY - topY) * fy };
}

// Drift past this (seconds) is a genuine discontinuity (loop wrap) and is the
// only case we correct with a hard seek — seeks stall the decoder, and on
// Safari, whose currentTime is coarse, a low threshold makes us seek constantly
// (every stale reading crosses it) which reads as continuous lag. Keep it high:
// a normal startup offset is closed smoothly by the gentle rate steering below,
// not by seeking.
const HARD_SEEK_DRIFT = 0.45;

function syncVideoTime(source: HTMLVideoElement, target: HTMLVideoElement) {
  if (source.paused && !target.paused) {
    target.pause();
  }

  if (!source.paused && target.paused) {
    void target.play().catch(() => undefined);
  }

  if (
    !Number.isFinite(source.currentTime) ||
    !Number.isFinite(target.duration) ||
    target.duration <= 0
  ) {
    return;
  }

  // A seek hasn't landed yet (Safari resolves seeks asynchronously, and its
  // currentTime lags during one). Acting now would compare against a stale time
  // and pile on more seeks — a seek storm that looks like a hard stutter.
  if (target.seeking) return;

  // Let the foreground free-run at 1×. The two clips are near-identical length,
  // so left alone they stay visually locked. Actively steering the foreground
  // (changing playbackRate / seeking it) knocks Safari's video decoder off its
  // smooth-decode path, which starves the foreground to a few fps and makes it
  // fall behind — the opposite of what the steering is trying to do.
  if (target.playbackRate !== 1) target.playbackRate = 1;

  const targetTime = foregroundTimeFromBottom(source, target);
  const drift = targetTime - target.currentTime;

  // Only correct a genuine discontinuity (a loop wrap), with a single snap.
  if (Math.abs(drift) > HARD_SEEK_DRIFT) {
    target.currentTime = targetTime;
  }
}

function parseMeshIndex(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { files?: unknown }).files)
  ) {
    return [];
  }

  return (value as { files: unknown[] }).files
    .filter((file): file is string => {
      return (
        typeof file === "string" &&
        file.toLowerCase().endsWith(".json") &&
        !file.includes("/")
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

// The fixed UV grid used to measure reveal progress. With a garment mask we keep
// only samples that land on clothing, so progress means "how much of the dress is
// scratched" (and can reach 100%), not how much of the whole screen.
function buildRevealSamples(mesh: TrackedMesh | null): Vec2[] {
  const samplesAcross = 13;
  const samplesDown = 18;
  const garment = mesh?.garment ?? null;
  const cols = mesh?.cols ?? 0;
  const rows = mesh?.rows ?? 0;
  const points: Vec2[] = [];

  for (let yIndex = 0; yIndex <= samplesDown; yIndex += 1) {
    for (let xIndex = 0; xIndex <= samplesAcross; xIndex += 1) {
      const u = xIndex / samplesAcross;
      const v = yIndex / samplesDown;
      if (garment && cols > 0 && rows > 0) {
        const col = Math.round(u * (cols - 1));
        const row = Math.round(v * (rows - 1));
        if (!garment[row * cols + col]) continue;
      }
      points.push({ x: u, y: v });
    }
  }

  return points;
}

function densifyScratchPath(points: Vec2[], maxStep: number): Vec2[] {
  if (points.length === 0) return [];
  const out: Vec2[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxStep) {
      out.push(b);
      continue;
    }
    const steps = Math.ceil(dist / maxStep);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }
  return out;
}

function isGarmentUv(mesh: TrackedMesh | null, u: number, v: number) {
  const garment = mesh?.garment ?? null;
  const cols = mesh?.cols ?? 0;
  const rows = mesh?.rows ?? 0;
  if (!garment || cols <= 0 || rows <= 0) return true;
  const col = Math.round(clampValue(u, 0, 1) * (cols - 1));
  const row = Math.round(clampValue(v, 0, 1) * (rows - 1));
  return Boolean(garment[row * cols + col]);
}

// Parallel ↙ strokes (u+v = const): top → bottom on each line; lines sweep top-left → bottom-right.
function buildAutoScratchPath(mesh: TrackedMesh | null): Vec2[] {
  const lineCount = AUTO_SCRATCH_DIAGONAL_LINES;
  const lines: { startU: number; startV: number; points: Vec2[] }[] = [];

  for (let i = 0; i <= lineCount; i += 1) {
    const s = (i / lineCount) * 2;
    let startU: number;
    let startV: number;
    let endU: number;
    let endV: number;
    if (s <= 1) {
      // ↙ along u+v=s: top (high u, low v) → bottom (low u, high v)
      startU = s;
      startV = 0;
      endU = 0;
      endV = s;
    } else {
      const t = s - 1;
      startU = 1;
      startV = 1 - t;
      endU = 1 - t;
      endV = 1;
    }

    const span = Math.hypot(endU - startU, endV - startV);
    if (span < 1e-6) continue;

    const linePoints: Vec2[] = [];
    const stepsAlong = Math.max(
      2,
      Math.ceil(span / (AUTO_SCRATCH_PATH_STEP_UV * 1.8)),
    );
    for (let j = 0; j <= stepsAlong; j += 1) {
      const f = j / stepsAlong;
      const u = startU + (endU - startU) * f;
      const v = startV + (endV - startV) * f;
      if (!isGarmentUv(mesh, u, v)) continue;
      linePoints.push({ x: u, y: v });
    }
    if (linePoints.length === 0) continue;
    lines.push({
      startU: linePoints[0].x,
      startV: linePoints[0].y,
      points: linePoints,
    });
  }

  lines.sort((a, b) => {
    if (Math.abs(a.startV - b.startV) > 1e-4) return a.startV - b.startV;
    return a.startU - b.startU;
  });

  const sparse: Vec2[] = [];
  for (const line of lines) {
    sparse.push(...densifyScratchPath(line.points, AUTO_SCRATCH_PATH_STEP_UV));
  }
  return sparse;
}

type TrackedMeshFrame = {
  t: number;
  verts: Vec2[];
  vis: number[];
};

type TrackedMesh = {
  cols: number;
  rows: number;
  fps: number;
  uv: Vec2[];
  frames: TrackedMeshFrame[];
  // Static per-vertex clothing mask (1 = garment), or null when the mesh has no
  // garment data (then the whole screen is scratchable, legacy behavior).
  garment: number[] | null;
};

// A live mesh sampled at the current video time: per-vertex canvas positions
// plus visibility, sharing the static UV grid from the source TrackedMesh.
type TrackedMeshSample = {
  cols: number;
  rows: number;
  uv: Vec2[];
  verts: Vec2[];
  vis: number[];
};

function parseTrackedMesh(value: unknown): TrackedMesh | null {
  if (!value || typeof value !== "object") return null;
  const data = value as {
    mesh?: { cols?: unknown; rows?: unknown };
    fps?: unknown;
    uv?: unknown;
    frames?: unknown;
    garment?: unknown;
  };
  const cols = Number(data.mesh?.cols);
  const rows = Number(data.mesh?.rows);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 2
  )
    return null;
  if (
    !Array.isArray(data.uv) ||
    !Array.isArray(data.frames) ||
    data.frames.length === 0
  )
    return null;

  const expected = cols * rows;
  const uv = data.uv as unknown[];
  if (uv.length !== expected) return null;

  // Optional static per-vertex garment mask (1 = clothing). When present we fold
  // it into per-frame visibility so scratching, hole-punching, and the mesh
  // overlay are all confined to clothes (the gate is `cellVisible`). Scratches
  // live in UV space and the garment occupies a stable UV region, so a single
  // static mask is correct and flicker-free.
  const garmentSource = Array.isArray(data.garment)
    ? (data.garment as unknown[])
    : null;
  const garment =
    garmentSource && garmentSource.length === expected
      ? garmentSource.map((flag) => (Number(flag) ? 1 : 0))
      : null;
  const parsedUv = uv.map((pair) => {
    const point = pair as number[];
    return { x: Number(point?.[0]), y: Number(point?.[1]) };
  });
  if (
    parsedUv.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  )
    return null;

  const frames: TrackedMeshFrame[] = [];
  for (const rawFrame of data.frames as unknown[]) {
    const frame = rawFrame as { t?: unknown; verts?: unknown; vis?: unknown };
    if (
      typeof frame.t !== "number" ||
      !Array.isArray(frame.verts) ||
      frame.verts.length !== expected
    ) {
      return null;
    }
    const verts = (frame.verts as unknown[]).map((pair) => {
      const point = pair as number[];
      return { x: Number(point?.[0]), y: Number(point?.[1]) };
    });
    if (
      verts.some(
        (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
      )
    )
      return null;
    const visSource = Array.isArray(frame.vis) ? (frame.vis as unknown[]) : [];
    const vis = verts.map((_, index) => {
      if (garment && !garment[index]) return 0;
      return Number(visSource[index]) ? 1 : 0;
    });
    frames.push({ t: frame.t, verts, vis });
  }

  return {
    cols,
    rows,
    fps: Number(data.fps) || 10,
    uv: parsedUv,
    frames: frames.sort((a, b) => a.t - b.t),
    garment,
  };
}

// Interpolate vertex positions between the two source frames bracketing `time`.
function sampleTrackedMesh(mesh: TrackedMesh, time: number): TrackedMeshSample {
  const frames = mesh.frames;
  const loopTime =
    frames.length > 1 ? time % (frames[frames.length - 1].t || 1) : time;
  let previous = frames[0];
  let next = frames[frames.length - 1];
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index].t <= loopTime) previous = frames[index];
    if (frames[index].t >= loopTime) {
      next = frames[index];
      break;
    }
  }

  const span = next.t - previous.t;
  const blend = span > 0 ? (loopTime - previous.t) / span : 0;
  const verts = previous.verts.map((point, index) => {
    const target = next.verts[index] ?? point;
    return {
      x: point.x + (target.x - point.x) * blend,
      y: point.y + (target.y - point.y) * blend,
    };
  });
  const vis = previous.vis.map((value, index) =>
    value && next.vis[index] ? 1 : 0,
  );

  return { cols: mesh.cols, rows: mesh.rows, uv: mesh.uv, verts, vis };
}

function meshVertexAt(sample: TrackedMeshSample, col: number, row: number) {
  return sample.verts[row * sample.cols + col];
}

// A cell is usable only if all four corners are visible this frame — this skips
// off-body cells (never seeded) and occluded ones (e.g. an arm crossing).
function cellVisible(sample: TrackedMeshSample, col: number, row: number) {
  const { cols, vis } = sample;
  return Boolean(
    vis[row * cols + col] &&
    vis[row * cols + col + 1] &&
    vis[(row + 1) * cols + col] &&
    vis[(row + 1) * cols + col + 1],
  );
}

function barycentric(point: Vec2, a: Vec2, b: Vec2, c: Vec2) {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v2x = point.x - a.x;
  const v2y = point.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-6) return null;
  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  const u = 1 - v - w;
  if (u < -0.001 || v < -0.001 || w < -0.001) return null;
  return { u, v, w };
}

// Map a canvas point to mesh-UV: find which deformed cell holds `point` and
// return its UV via barycentric interpolation across the cell triangles.
function trackedWorldToUv(sample: TrackedMeshSample, point: Vec2): Vec2 | null {
  for (let row = 0; row < sample.rows - 1; row += 1) {
    for (let col = 0; col < sample.cols - 1; col += 1) {
      if (!cellVisible(sample, col, row)) continue;
      const topLeft = meshVertexAt(sample, col, row);
      const topRight = meshVertexAt(sample, col + 1, row);
      const bottomLeft = meshVertexAt(sample, col, row + 1);
      const bottomRight = meshVertexAt(sample, col + 1, row + 1);
      const uvTL = sample.uv[row * sample.cols + col];
      const uvTR = sample.uv[row * sample.cols + col + 1];
      const uvBL = sample.uv[(row + 1) * sample.cols + col];
      const uvBR = sample.uv[(row + 1) * sample.cols + col + 1];

      const first = barycentric(point, topLeft, topRight, bottomRight);
      if (first) {
        return {
          x: uvTL.x * first.u + uvTR.x * first.v + uvBR.x * first.w,
          y: uvTL.y * first.u + uvTR.y * first.v + uvBR.y * first.w,
        };
      }
      const second = barycentric(point, topLeft, bottomRight, bottomLeft);
      if (second) {
        return {
          x: uvTL.x * second.u + uvBR.x * second.v + uvBL.x * second.w,
          y: uvTL.y * second.u + uvBR.y * second.v + uvBL.y * second.w,
        };
      }
    }
  }
  return null;
}

export function ScratchPrototype() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const symbolSlotRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Most recent pointer position in viewport coords; used as the origin of the
  // flying-coin animation for manual scratches.
  const lastPointerClientRef = useRef<Vec2 | null>(null);
  const coinIdRef = useRef(0);
  const [flyingCoins, setFlyingCoins] = useState<FlyingCoin[]>([]);
  const bottomVideoRef = useRef<HTMLVideoElement | null>(null);
  const foregroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const glRendererRef = useRef<GarmentGLRenderer | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const hoverPointRef = useRef<Vec2 | null>(null);
  const drawingRef = useRef(false);
  // Reveal progress is measured against a fixed UV sample grid. We track which
  // samples have *ever* been scratched (monotonic), so the percentage matches
  // the permanent scratch texture and never drops — even after marksRef is
  // capped or the fabric moves.
  const revealSamplesRef = useRef<Vec2[]>([]);
  const revealedRef = useRef<boolean[]>([]);
  const revealedCountRef = useRef(0);
  const [trackedMesh, setTrackedMesh] = useState<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const trackedMeshRef = useRef<TrackedMesh | null>(null);
  trackedMeshRef.current = trackedMesh;
  // Smoothed chest-follow camera offset, in clip units. Read by getCanvasPoint
  // to invert the pan when mapping a tap back to fabric UV.
  const cameraRef = useRef({ x: 0, y: 0 });
  const [meshFiles, setMeshFiles] = useState<string[]>([]);
  const [selectedMeshFile, setSelectedMeshFile] = useState(CARDS[1].mesh);
  const [meshReloadToken, setMeshReloadToken] = useState(0);
  const [selectedCardId, setSelectedCardId] = useState(CARDS[1].id);
  const card = CARDS.find((entry) => entry.id === selectedCardId) ?? CARDS[1];
  // The mesh lattice is a dev overlay — default it off on phones (where the
  // toggle is hidden).
  const [showMesh, setShowMesh] = useState(
    () =>
      !(
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 700px)").matches
      ),
  );
  const showMeshRef = useRef(showMesh);
  showMeshRef.current = showMesh;
  const [progress, setProgress] = useState(0);
  const [claimed, setClaimed] = useState(false);
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [sessionSymbols, setSessionSymbols] = useState(buildSessionSymbols);
  const [revealedSymbols, setRevealedSymbols] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(18.8);
  const [isPaused, setIsPaused] = useState(false);
  const progressRef = useRef(progress);
  const claimedRef = useRef(claimed);
  const gameResultRef = useRef<GameResult | null>(gameResult);
  gameResultRef.current = gameResult;
  const gameResultPendingRef = useRef<GameResult | null>(null);
  const gameResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSymbolsRef = useRef(sessionSymbols);
  sessionSymbolsRef.current = sessionSymbols;
  const revealedSymbolsRef = useRef(revealedSymbols);
  revealedSymbolsRef.current = revealedSymbols;
  const uiStateRef = useRef({
    currentTime,
    duration,
    isPaused,
    lastUpdatedAt: 0,
  });
  const [scratchZoom, setScratchZoom] = useState<ScratchZoomSettings>(
    loadScratchZoomSettings,
  );
  const scratchZoomRef = useRef(scratchZoom);
  scratchZoomRef.current = scratchZoom;
  const [autoScratch, setAutoScratch] = useState<AutoScratchSettings>(
    loadAutoScratchSettings,
  );
  const autoScratchRef = useRef(autoScratch);
  autoScratchRef.current = autoScratch;
  const [soundEnabled, setSoundEnabled] = useState(loadSoundEnabled);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const autoPathRef = useRef<Vec2[]>([]);
  const autoPathIndexRef = useRef(0);
  const autoPathProgressRef = useRef(0);
  const applyScratchAtUvRef = useRef<
    (u: number, v: number, radius: number, worldPoint?: Vec2 | null) => void
  >(() => undefined);
  const tryResolveGameRef = useRef<() => void>(() => undefined);
  const resetScratchRef = useRef<() => void>(() => undefined);
  const symbolAudioRef = useRef<SymbolAudioState>({ ctx: null });
  // Phones hide the side panel, so the scratch-zoom config lives behind a gear
  // button that opens this sheet.
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [desktopSettingsTab, setDesktopSettingsTab] =
    useState<DesktopSettingsTab>("scratch-zoom");

  function clearGameResultTimer() {
    if (gameResultTimerRef.current !== null) {
      window.clearTimeout(gameResultTimerRef.current);
      gameResultTimerRef.current = null;
    }
  }

  function resetGameOutcome() {
    clearGameResultTimer();
    gameResultPendingRef.current = null;
    gameResultRef.current = null;
    setGameResult(null);
  }

  useEffect(() => () => clearGameResultTimer(), []);
  // / showMesh changes (those are read live via refs).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: GarmentGLRenderer;
    try {
      renderer = new GarmentGLRenderer(canvas, CANVAS_WIDTH, CANVAS_HEIGHT);
    } catch (error) {
      console.error("WebGL init failed", error);
      return;
    }
    glRendererRef.current = renderer;

    let animationId = 0;
    const startedAt = performance.now();
    let lastFrameTime = performance.now();

    const render = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      const time = (now - startedAt) / 1000;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      const trackedMeshNow = trackedMeshRef.current;
      // Sample the mesh on the FOREGROUND clock — the mesh was tracked from the
      // foreground (performer) clip, so this keeps scratch holes glued to the
      // body regardless of any residual drift between the two free-running
      // videos. The bottom video is just the revealed image underneath, where a
      // few frames of offset is invisible. Fall back to the bottom clock, then
      // wall-clock, before either video has a valid currentTime.
      const meshTime =
        foregroundVideo?.currentTime ?? bottomVideo?.currentTime ?? time;
      const trackedSample = trackedMeshNow
        ? sampleTrackedMesh(trackedMeshNow, meshTime)
        : null;
      trackedSampleRef.current = trackedSample;
      const videoTime = bottomVideo?.currentTime ?? time;

      // Subtle chest-follow camera: pan toward keeping the chest anchor at its
      // target framing point, clamped + smoothed.
      const camera = cameraRef.current;
      let targetCamX = 0;
      let targetCamY = 0;
      if (trackedSample) {
        const chest = sampleMeshUvToWorld(
          trackedSample,
          CHEST_ANCHOR_UV.x,
          CHEST_ANCHOR_UV.y,
        );
        const targetPx = CANVAS_WIDTH * CHEST_TARGET_UV.x;
        const targetPy = CANVAS_HEIGHT * CHEST_TARGET_UV.y;
        const shiftX = (targetPx - chest.x) * CHEST_FOLLOW_STRENGTH;
        const shiftY = (targetPy - chest.y) * CHEST_FOLLOW_STRENGTH;
        targetCamX = clampValue(
          shiftX / (CANVAS_WIDTH / 2),
          -CHEST_CAM_MAX,
          CHEST_CAM_MAX,
        );
        targetCamY = clampValue(
          -shiftY / (CANVAS_HEIGHT / 2),
          -CHEST_CAM_MAX,
          CHEST_CAM_MAX,
        );
      }
      camera.x += (targetCamX - camera.x) * CHEST_SMOOTH;
      camera.y += (targetCamY - camera.y) * CHEST_SMOOTH;

      const autoSettings = autoScratchRef.current;
      if (
        autoSettings.enabled &&
        trackedSample &&
        gameResultPendingRef.current === null
      ) {
        const path = autoPathRef.current;
        if (path.length > 0 && autoPathIndexRef.current < path.length) {
          autoPathProgressRef.current += autoSettings.speed * dt;
          let scratched = 0;
          while (
            autoPathProgressRef.current >= 1 &&
            autoPathIndexRef.current < path.length &&
            scratched < AUTO_SCRATCH_MAX_PER_FRAME
          ) {
            autoPathProgressRef.current -= 1;
            const pt = path[autoPathIndexRef.current];
            const worldPos = sampleMeshUvToWorld(trackedSample, pt.x, pt.y);
            applyScratchAtUvRef.current(
              pt.x,
              pt.y,
              AUTO_SCRATCH_RADIUS,
              worldPos,
            );
            autoPathIndexRef.current += 1;
            scratched += 1;
          }
        }

        const pathDone =
          path.length === 0 || autoPathIndexRef.current >= path.length;
        const sampleCount = revealSamplesRef.current.length;
        const garmentComplete = isGarmentFullyRevealed(
          progressRef.current,
          revealedCountRef.current,
          sampleCount,
          true,
        );
        if (!garmentComplete && sampleCount > 0 && pathDone) {
          const samples = revealSamplesRef.current;
          const revealed = revealedRef.current;
          let filled = 0;
          for (
            let i = 0;
            i < samples.length && filled < AUTO_SCRATCH_FILL_BATCH;
            i += 1
          ) {
            if (revealed[i]) continue;
            const pt = samples[i];
            const worldPos = sampleMeshUvToWorld(trackedSample, pt.x, pt.y);
            applyScratchAtUvRef.current(
              pt.x,
              pt.y,
              AUTO_SCRATCH_RADIUS,
              worldPos,
            );
            filled += 1;
          }
        }
      }

      if (
        bottomVideo &&
        foregroundVideo &&
        bottomVideo.readyState >= 2 &&
        foregroundVideo.readyState >= 1
      ) {
        syncVideoTime(bottomVideo, foregroundVideo);
      }

      if (bottomVideo) {
        const now = performance.now();
        const nextDuration =
          bottomVideo.duration || uiStateRef.current.duration;
        const nextPaused = bottomVideo.paused;
        const shouldUpdateUi =
          now - uiStateRef.current.lastUpdatedAt >=
            UI_STATE_UPDATE_INTERVAL_MS ||
          nextPaused !== uiStateRef.current.isPaused ||
          Math.abs(videoTime - uiStateRef.current.currentTime) > 1;

        if (shouldUpdateUi) {
          uiStateRef.current = {
            currentTime: videoTime,
            duration: nextDuration,
            isPaused: nextPaused,
            lastUpdatedAt: now,
          };
          setCurrentTime(videoTime);
          setDuration(nextDuration);
          setIsPaused(nextPaused);
        }
      }

      const sampleCount = revealSamplesRef.current.length;
      const autoMode = autoScratchRef.current.enabled;
      const hideForeground =
        claimedRef.current ||
        isGarmentFullyRevealed(
          progressRef.current,
          revealedCountRef.current,
          sampleCount,
          autoMode,
        );
      if (hideForeground && !claimedRef.current) {
        claimedRef.current = true;
        setClaimed(true);
        tryResolveGameRef.current();
      }

      renderer.render(
        bottomVideo,
        foregroundVideo,
        trackedSample,
        showMeshRef.current,
        camera,
        hideForeground,
      );
      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationId);
      glRendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    fetch(`${MESH_INDEX_SRC}?v=${meshReloadToken}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        const files = parseMeshIndex(data);
        setMeshFiles(files);
        setSelectedMeshFile(
          (currentFile) =>
            currentFile ||
            (files.includes(DEFAULT_MESH_FILE)
              ? DEFAULT_MESH_FILE
              : files[0]) ||
            "",
        );
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken]);

  useEffect(() => {
    if (!selectedMeshFile) {
      setTrackedMesh(null);
      return;
    }

    let isCancelled = false;

    fetch(
      `${MESH_DIRECTORY_SRC}/${encodeURIComponent(selectedMeshFile)}?v=${meshReloadToken}`,
      { cache: "no-store" },
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        setTrackedMesh(parseTrackedMesh(data));
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken, selectedMeshFile]);

  // Switching cards: load that card's mesh and clear scratches/progress so holes
  // from the previous clip don't carry over onto the new fabric.
  useEffect(() => {
    setSelectedMeshFile(card.mesh);
    marksRef.current = [];
    glRendererRef.current?.clearScratch();
    glRendererRef.current?.resetForeground();
    progressRef.current = 0;
    claimedRef.current = false;
    resetGameOutcome();
    revealedSymbolsRef.current = 0;
    setSessionSymbols(buildSessionSymbols());
    setProgress(0);
    setClaimed(false);
    setRevealedSymbols(0);
    setFlyingCoins([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId]);

  // Rebuild the reveal sample grid whenever the mesh changes, recomputing which
  // samples are already revealed from the current marks (usually empty after a
  // card switch / reset). Keeps the percentage consistent across mesh reloads.
  useEffect(() => {
    const samples = buildRevealSamples(trackedMesh);
    revealSamplesRef.current = samples;
    const revealed = samples.map((p) =>
      marksRef.current.some(
        (m) => Math.hypot((m.u - p.x) / m.radius, (m.v - p.y) / m.radius) <= 1,
      ),
    );
    revealedRef.current = revealed;
    revealedCountRef.current = revealed.reduce((n, r) => n + (r ? 1 : 0), 0);
    const next = samples.length ? revealedCountRef.current / samples.length : 0;
    progressRef.current = next;
    setProgress(next);
    const nextSymbolCount = revealedSymbolCount(
      next,
      autoScratchRef.current.enabled,
    );
    revealedSymbolsRef.current = nextSymbolCount;
    setRevealedSymbols(nextSymbolCount);
    const nextClaimed = isGarmentFullyRevealed(
      next,
      revealedCountRef.current,
      samples.length,
      autoScratchRef.current.enabled,
    );
    claimedRef.current = nextClaimed;
    setClaimed(nextClaimed);
    if (nextClaimed) tryResolveGameRef.current();
  }, [trackedMesh]);

  useEffect(() => {
    autoPathRef.current = buildAutoScratchPath(trackedMesh);
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
  }, [trackedMesh]);

  useEffect(() => {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;

    const onBottomCanPlay = () => {
      const nextDuration = bottomVideo.duration || uiStateRef.current.duration;
      uiStateRef.current = {
        ...uiStateRef.current,
        duration: nextDuration,
        isPaused: bottomVideo.paused,
      };
      setDuration(nextDuration);
      void bottomVideo.play().catch(() => undefined);
    };
    const onForegroundCanPlay = () => {
      void foregroundVideo.play().catch(() => undefined);
    };

    bottomVideo.addEventListener("canplay", onBottomCanPlay);
    foregroundVideo.addEventListener("canplay", onForegroundCanPlay);

    return () => {
      bottomVideo.removeEventListener("canplay", onBottomCanPlay);
      foregroundVideo.removeEventListener("canplay", onForegroundCanPlay);
    };
  }, []);

  // Mobile browsers (notably iOS Safari) will suspend a second, simultaneously
  // playing <video> after a few seconds to save power — which here drops the
  // foreground below readyState 2 and leaves only the bottom video on screen.
  // This watchdog nudges both clips back to playing whenever they get paused
  // out from under us (and on tab re-focus), as long as the user hasn't paused.
  useEffect(() => {
    const keepPlaying = () => {
      if (uiStateRef.current.isPaused) return;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      if (bottomVideo?.paused) void bottomVideo.play().catch(() => undefined);
      if (foregroundVideo?.paused)
        void foregroundVideo.play().catch(() => undefined);
    };

    const intervalId = window.setInterval(keepPlaying, 1000);
    document.addEventListener("visibilitychange", keepPlaying);
    window.addEventListener("focus", keepPlaying);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", keepPlaying);
      window.removeEventListener("focus", keepPlaying);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SCRATCH_ZOOM_STORAGE_KEY, JSON.stringify(scratchZoom));
  }, [scratchZoom]);

  useEffect(() => {
    localStorage.setItem(AUTO_SCRATCH_STORAGE_KEY, JSON.stringify(autoScratch));
  }, [autoScratch]);

  useEffect(() => {
    localStorage.setItem(
      SOUND_STORAGE_KEY,
      JSON.stringify({ enabled: soundEnabled }),
    );
  }, [soundEnabled]);

  function syncScratchZoomTransition(
    canvas: HTMLCanvasElement,
    settings = scratchZoomRef.current,
  ) {
    canvas.style.setProperty(
      "--scratch-zoom-duration",
      `${settings.durationMs}ms`,
    );
    canvas.style.setProperty(
      "--scratch-zoom-easing",
      scratchZoomEasing(settings.bounce),
    );
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) syncScratchZoomTransition(canvas);
  }, [scratchZoom]);

  function updateScratchZoom(patch: Partial<ScratchZoomSettings>) {
    setScratchZoom((current) => ({ ...current, ...patch }));
  }

  function updateAutoScratch(patch: Partial<AutoScratchSettings>) {
    if (patch.enabled && soundEnabledRef.current)
      ensureSymbolAudio(symbolAudioRef.current);
    setAutoScratch((current) => ({ ...current, ...patch }));
  }

  function updateSoundEnabled(enabled: boolean) {
    if (enabled) ensureSymbolAudio(symbolAudioRef.current);
    setSoundEnabled(enabled);
  }

  function isPhoneLayout() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 700px)").matches
    );
  }

  function resetScratch() {
    marksRef.current = [];
    glRendererRef.current?.clearScratch();
    glRendererRef.current?.clearFlakes();
    revealedRef.current = new Array(revealSamplesRef.current.length).fill(
      false,
    );
    revealedCountRef.current = 0;
    progressRef.current = 0;
    claimedRef.current = false;
    resetGameOutcome();
    revealedSymbolsRef.current = 0;
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    setSessionSymbols(buildSessionSymbols());
    setProgress(0);
    setClaimed(false);
    setRevealedSymbols(0);
    setFlyingCoins([]);
  }
  resetScratchRef.current = resetScratch;

  function tryResolveGame() {
    if (gameResultPendingRef.current !== null) return;
    if (revealedSymbolsRef.current < SYMBOL_SLOT_COUNT) return;
    const autoMode = autoScratchRef.current.enabled;
    const sampleCount = revealSamplesRef.current.length;
    if (
      !isGarmentFullyRevealed(
        progressRef.current,
        revealedCountRef.current,
        sampleCount,
        autoMode,
      )
    ) {
      return;
    }
    const outcome: GameResult = evaluateSessionWin(sessionSymbolsRef.current)
      ? "win"
      : "lose";
    gameResultPendingRef.current = outcome;
    setAutoScratch((current) =>
      current.enabled ? { ...current, enabled: false } : current,
    );
    const overlayDelayMs = playGameOutcomeSound(
      symbolAudioRef.current,
      outcome,
      soundEnabledRef.current,
    );
    clearGameResultTimer();
    gameResultTimerRef.current = window.setTimeout(() => {
      gameResultTimerRef.current = null;
      gameResultRef.current = outcome;
      setGameResult(outcome);
    }, overlayDelayMs);
  }
  tryResolveGameRef.current = tryResolveGame;

  // On phones the canvas is centered with a translate that fills the screen, so
  // the magnify scale has to be composed on top of it rather than replacing it.
  const canvasBaseTransform = () =>
    isPhoneLayout() ? "translate(-50%, -50%) " : "";

  function applyScratchZoom(point: Vec2) {
    const settings = scratchZoomRef.current;
    if (!settings.enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    syncScratchZoomTransition(canvas, settings);
    canvas.style.transformOrigin = `${(point.x / CANVAS_WIDTH) * 100}% ${(point.y / CANVAS_HEIGHT) * 100}%`;
    canvas.style.transform = `${canvasBaseTransform()}scale(${settings.scale})`;
  }

  function clearScratchZoom() {
    const settings = scratchZoomRef.current;
    if (!settings.enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    syncScratchZoomTransition(canvas, settings);
    canvas.style.transform = `${canvasBaseTransform()}scale(1)`;
  }

  function getCanvasPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    // Screen -> presented canvas pixels.
    const presentX = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const presentY = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    // Invert the chest-follow camera (overscan + clip-space pan) so a tap maps to
    // the reference-frame fabric coordinate the mesh/holes live in.
    const cam = cameraRef.current;
    const refClipX = ((presentX / CANVAS_WIDTH) * 2 - 1 - cam.x) / PRESENT_ZOOM;
    const refClipY =
      (1 - (presentY / CANVAS_HEIGHT) * 2 - cam.y) / PRESENT_ZOOM;
    return {
      x: ((refClipX + 1) / 2) * CANVAS_WIDTH,
      y: ((1 - refClipY) / 2) * CANVAS_HEIGHT,
    };
  }

  // Fly a coin from the scratch origin up to each newly revealed symbol slot.
  // Auto scratch starts the flight from the stage center; manual scratch starts
  // it from the user's finger. Coordinates are resolved against the live stage
  // and symbol-bar layout so the coins land on the correct slots.
  // Convert a canvas reference-frame point (the space scratches live in) to a
  // stage-relative pixel. Applies the same chest-follow camera + present-zoom
  // forward transform the GL renderer uses, then maps presented canvas pixels
  // through the live canvas rect so it lands where the point visually appears.
  function worldToStagePoint(worldPoint: Vec2): Vec2 | null {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const cam = cameraRef.current;
    const refClipX = (worldPoint.x / CANVAS_WIDTH) * 2 - 1;
    const refClipY = 1 - (worldPoint.y / CANVAS_HEIGHT) * 2;
    const presentX = ((refClipX * PRESENT_ZOOM + cam.x + 1) / 2) * CANVAS_WIDTH;
    const presentY =
      ((1 - (refClipY * PRESENT_ZOOM + cam.y)) / 2) * CANVAS_HEIGHT;
    const clientX =
      canvasRect.left + (presentX / CANVAS_WIDTH) * canvasRect.width;
    const clientY =
      canvasRect.top + (presentY / CANVAS_HEIGHT) * canvasRect.height;
    return { x: clientX - stageRect.left, y: clientY - stageRect.top };
  }

  function spawnSymbolCoins(
    prevCount: number,
    nextCount: number,
    worldPoint?: Vec2 | null,
  ) {
    const stage = stageRef.current;
    if (!stage || nextCount <= prevCount) return;
    const stageRect = stage.getBoundingClientRect();

    const autoMode = autoScratchRef.current.enabled;
    let originX: number;
    let originY: number;
    const autoOrigin =
      autoMode && worldPoint ? worldToStagePoint(worldPoint) : null;
    if (autoOrigin) {
      originX = autoOrigin.x;
      originY = autoOrigin.y;
    } else if (autoMode || !lastPointerClientRef.current) {
      originX = stageRect.width / 2;
      originY = stageRect.height / 2;
    } else {
      originX = lastPointerClientRef.current.x - stageRect.left;
      originY = lastPointerClientRef.current.y - stageRect.top;
    }

    const symbols = sessionSymbolsRef.current;
    const coins: FlyingCoin[] = [];
    for (let slot = prevCount; slot < nextCount; slot += 1) {
      const slotEl = symbolSlotRefs.current[slot];
      if (!slotEl) continue;
      const slotRect = slotEl.getBoundingClientRect();
      const toX = slotRect.left - stageRect.left + slotRect.width / 2;
      const toY = slotRect.top - stageRect.top + slotRect.height / 2;
      // Lift the midpoint above the straight line for a gentle arc toward the bar.
      const midX = (originX + toX) / 2;
      const midY = Math.min(originY, toY) - 56;
      coins.push({
        id: (coinIdRef.current += 1),
        typeId: symbols[slot] ?? 0,
        fromX: originX,
        fromY: originY,
        toX,
        toY,
        midX,
        midY,
        delayMs: (slot - prevCount) * COIN_FLIGHT_STAGGER_MS,
      });
    }
    if (coins.length > 0) {
      setFlyingCoins((current) => [...current, ...coins]);
    }
  }

  function removeFlyingCoin(id: number) {
    setFlyingCoins((current) => current.filter((coin) => coin.id !== id));
  }

  function applyScratchAtUv(
    u: number,
    v: number,
    radius: number,
    worldPoint?: Vec2 | null,
  ) {
    if (gameResultPendingRef.current !== null) return;

    marksRef.current = [...marksRef.current, { u, v, radius }].slice(-180);
    glRendererRef.current?.paintScratch(u, v, radius);

    if (autoScratchRef.current.flakes && worldPoint) {
      glRendererRef.current?.spawnFlakes(worldPoint.x, worldPoint.y);
    }

    const samples = revealSamplesRef.current;
    const revealed = revealedRef.current;
    for (let i = 0; i < samples.length; i += 1) {
      if (revealed[i]) continue;
      const distance = Math.hypot(
        (u - samples[i].x) / radius,
        (v - samples[i].y) / radius,
      );
      if (distance <= 1) {
        revealed[i] = true;
        revealedCountRef.current += 1;
      }
    }
    const nextProgress = samples.length
      ? revealedCountRef.current / samples.length
      : 0;
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    const autoMode = autoScratchRef.current.enabled;
    const nextSymbolCount = revealedSymbolCount(nextProgress, autoMode);
    if (nextSymbolCount !== revealedSymbolsRef.current) {
      const prevCount = revealedSymbolsRef.current;
      revealedSymbolsRef.current = nextSymbolCount;
      setRevealedSymbols(nextSymbolCount);
      playNewSymbolNotes(
        symbolAudioRef.current,
        prevCount,
        nextSymbolCount,
        soundEnabledRef.current,
      );
      spawnSymbolCoins(prevCount, nextSymbolCount, worldPoint);
    }
    if (
      isGarmentFullyRevealed(
        nextProgress,
        revealedCountRef.current,
        samples.length,
        autoMode,
      )
    ) {
      claimedRef.current = true;
      setClaimed(true);
    }
    tryResolveGame();
  }
  applyScratchAtUvRef.current = applyScratchAtUv;

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    if (!point) return;

    const trackedSample = trackedSampleRef.current;
    if (!trackedSample) return;
    const uv = trackedWorldToUv(trackedSample, point);
    if (!uv) return;

    applyScratchAtUv(uv.x, uv.y, SCRATCH_RADIUS, point);
  }

  function setVideoTime(time: number) {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    const nextTime = Math.max(0, Math.min(duration || 0, time));

    if (bottomVideo) bottomVideo.currentTime = nextTime;
    if (
      foregroundVideo &&
      Number.isFinite(foregroundVideo.duration) &&
      foregroundVideo.duration > 0 &&
      bottomVideo
    ) {
      foregroundVideo.currentTime = foregroundTimeFromBottom(
        bottomVideo,
        foregroundVideo,
      );
    }
    uiStateRef.current = {
      ...uiStateRef.current,
      currentTime: nextTime,
      lastUpdatedAt: performance.now(),
    };
    setCurrentTime(nextTime);
  }

  function togglePlayback() {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;

    if (bottomVideo.paused) {
      void bottomVideo.play();
      void foregroundVideo.play();
      uiStateRef.current = { ...uiStateRef.current, isPaused: false };
      setIsPaused(false);
    } else {
      bottomVideo.pause();
      foregroundVideo.pause();
      uiStateRef.current = { ...uiStateRef.current, isPaused: true };
      setIsPaused(true);
    }
  }

  const scratchZoomControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Scratch zoom</legend>
      <label className="checkbox-label">
        <input
          checked={scratchZoom.enabled}
          onChange={(event) =>
            updateScratchZoom({ enabled: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Enable zoom while scratching
      </label>
      <label>
        Range ({scratchZoom.scale.toFixed(2)}×)
        <input
          disabled={!scratchZoom.enabled}
          max={2}
          min={1}
          onChange={(event) =>
            updateScratchZoom({ scale: Number(event.currentTarget.value) })
          }
          step={0.05}
          type="range"
          value={scratchZoom.scale}
        />
      </label>
      <label>
        Animation ({scratchZoom.durationMs} ms)
        <input
          disabled={!scratchZoom.enabled}
          max={800}
          min={50}
          onChange={(event) =>
            updateScratchZoom({ durationMs: Number(event.currentTarget.value) })
          }
          step={10}
          type="range"
          value={scratchZoom.durationMs}
        />
      </label>
      <label className="checkbox-label">
        <input
          checked={scratchZoom.bounce}
          disabled={!scratchZoom.enabled}
          onChange={(event) =>
            updateScratchZoom({ bounce: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Bounce easing
      </label>
    </fieldset>
  );

  const soundControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Sound</legend>
      <label className="checkbox-label">
        <input
          checked={soundEnabled}
          onChange={(event) => updateSoundEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        Game sounds
      </label>
    </fieldset>
  );

  const autoScratchControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Auto scratch</legend>
      <label className="checkbox-label">
        <input
          checked={autoScratch.enabled}
          onChange={(event) =>
            updateAutoScratch({ enabled: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Enable auto scratch
      </label>
      <label>
        Speed ({autoScratch.speed.toFixed(0)} pts/s)
        <input
          disabled={!autoScratch.enabled}
          max={120}
          min={1}
          onChange={(event) =>
            updateAutoScratch({ speed: Number(event.currentTarget.value) })
          }
          step={1}
          type="range"
          value={autoScratch.speed}
        />
      </label>
      <label className="checkbox-label">
        <input
          checked={autoScratch.flakes}
          onChange={(event) =>
            updateAutoScratch({ flakes: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Flying flakes
      </label>
    </fieldset>
  );

  const desktopSettingsTabs = (
    <div className="panel-settings-tabs">
      <div
        className="panel-settings-tablist"
        role="tablist"
        aria-label="Settings"
      >
        {DESKTOP_SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`panel-tab-${tab.id}`}
            aria-selected={desktopSettingsTab === tab.id}
            aria-controls={`panel-tabpanel-${tab.id}`}
            className={`panel-settings-tab${desktopSettingsTab === tab.id ? " is-active" : ""}`}
            onClick={() => setDesktopSettingsTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="panel-tabpanel-scratch-zoom"
        role="tabpanel"
        aria-labelledby="panel-tab-scratch-zoom"
        hidden={desktopSettingsTab !== "scratch-zoom"}
        className="panel-settings-tabpanel"
      >
        {scratchZoomControls}
      </div>
      <div
        id="panel-tabpanel-sound"
        role="tabpanel"
        aria-labelledby="panel-tab-sound"
        hidden={desktopSettingsTab !== "sound"}
        className="panel-settings-tabpanel"
      >
        {soundControls}
      </div>
      <div
        id="panel-tabpanel-auto-scratch"
        role="tabpanel"
        aria-labelledby="panel-tab-auto-scratch"
        hidden={desktopSettingsTab !== "auto-scratch"}
        className="panel-settings-tabpanel"
      >
        {autoScratchControls}
      </div>
    </div>
  );

  return (
    <main className="app-shell">
      <section className="prototype">
        <div
          ref={stageRef}
          className={`stage${gameResult ? " is-game-over" : ""}`}
        >
          {typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).has("debug") ? (
            <DebugHud />
          ) : null}
          <div
            className={`symbol-bar${revealedSymbols >= SYMBOL_SLOT_COUNT ? " is-symbols-complete" : ""}${claimed ? " is-fully-revealed" : ""}`}
            aria-label="Game symbols"
          >
            {sessionSymbols.map((typeId, index) => (
              <div
                key={index}
                ref={(el) => {
                  symbolSlotRefs.current[index] = el;
                }}
                className={`symbol-slot${index < revealedSymbols ? " is-revealed" : ""}`}
                title={
                  index < revealedSymbols
                    ? SYMBOL_TYPES[typeId]?.label
                    : undefined
                }
              >
                {index < revealedSymbols ? (
                  <GameSymbolIcon typeId={typeId} />
                ) : null}
              </div>
            ))}
          </div>
          {flyingCoins.map((coin) => (
            <div
              key={coin.id}
              className="flying-coin"
              style={
                {
                  "--coin-from-x": `${coin.fromX}px`,
                  "--coin-from-y": `${coin.fromY}px`,
                  "--coin-mid-x": `${coin.midX}px`,
                  "--coin-mid-y": `${coin.midY}px`,
                  "--coin-to-x": `${coin.toX}px`,
                  "--coin-to-y": `${coin.toY}px`,
                  animationDuration: `${COIN_FLIGHT_DURATION_MS}ms`,
                  animationDelay: `${coin.delayMs}ms`,
                } as CSSProperties
              }
              onAnimationEnd={() => removeFlyingCoin(coin.id)}
              aria-hidden="true"
            >
              <GameSymbolIcon typeId={coin.typeId} />
            </div>
          ))}
          <video
            ref={bottomVideoRef}
            className="source-video"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            src={card.bottom}
          />
          <video
            ref={foregroundVideoRef}
            className="source-video"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            src={card.foreground}
          />
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={(event) => {
              if (soundEnabledRef.current)
                ensureSymbolAudio(symbolAudioRef.current);
              const bottomVideo = bottomVideoRef.current;
              const foregroundVideo = foregroundVideoRef.current;
              if (bottomVideo?.paused)
                void bottomVideo.play().catch(() => undefined);
              if (foregroundVideo?.paused)
                void foregroundVideo.play().catch(() => undefined);
              drawingRef.current = true;
              lastPointerClientRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              const point = getCanvasPoint(event.clientX, event.clientY);
              hoverPointRef.current = point;
              event.currentTarget.setPointerCapture(event.pointerId);
              if (point) applyScratchZoom(point);
              addScratch(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              lastPointerClientRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              hoverPointRef.current = getCanvasPoint(
                event.clientX,
                event.clientY,
              );
              if (!drawingRef.current) return;
              addScratch(event.clientX, event.clientY);
            }}
            onPointerUp={() => {
              drawingRef.current = false;
              clearScratchZoom();
            }}
            onPointerLeave={() => {
              drawingRef.current = false;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
            onPointerCancel={() => {
              drawingRef.current = false;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
          />
          <div className="mobile-sound-wrap">
            <button
              type="button"
              className={`mobile-reset mobile-sound-toggle${soundEnabled ? "" : " is-muted"}`}
              aria-label={soundEnabled ? "Mute sounds" : "Unmute sounds"}
              aria-pressed={soundEnabled}
              onClick={() => updateSoundEnabled(!soundEnabled)}
            >
              {soundEnabled ? (
                <Volume2 aria-hidden="true" size={20} strokeWidth={2.2} />
              ) : (
                <VolumeX aria-hidden="true" size={20} strokeWidth={2.2} />
              )}
            </button>
          </div>
          {/* Phones hide the dev panel, so surface compact controls on the stage
              itself. Hidden on desktop where the panel is used. */}
          <div className="mobile-controls-wrap">
            <button
              type="button"
              className={`mobile-reset mobile-controls-toggle${mobileControlsOpen ? " is-open" : ""}`}
              aria-label={
                mobileControlsOpen ? "Hide controls" : "Show controls"
              }
              aria-expanded={mobileControlsOpen}
              onClick={() => {
                setMobileControlsOpen((current) => {
                  if (current) setMobileSettingsOpen(false);
                  return !current;
                });
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {mobileControlsOpen && (
              <div className="mobile-controls">
                <label className="mobile-card-switch">
                  <span className="visually-hidden">Card</span>
                  <select
                    aria-label="Card clip"
                    onChange={(event) =>
                      setSelectedCardId(event.currentTarget.value)
                    }
                    value={selectedCardId}
                  >
                    {CARDS.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="mobile-reset"
                  aria-label="Reset scratch"
                  onClick={resetScratch}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`mobile-reset${autoScratch.enabled ? " is-active" : ""}`}
                  aria-label={
                    autoScratch.enabled
                      ? "Disable auto scratch"
                      : "Enable auto scratch"
                  }
                  aria-pressed={autoScratch.enabled}
                  onClick={() =>
                    updateAutoScratch({ enabled: !autoScratch.enabled })
                  }
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="mobile-reset mobile-settings-toggle"
                  aria-label="Animation settings"
                  aria-expanded={mobileSettingsOpen}
                  onClick={() => setMobileSettingsOpen((current) => !current)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </div>
            )}
            {mobileControlsOpen && mobileSettingsOpen && (
              <div
                className="mobile-settings-sheet"
                role="dialog"
                aria-label="Animation settings"
              >
                {scratchZoomControls}
                {autoScratchControls}
              </div>
            )}
          </div>
          {gameResult ? (
            <div
              className={`game-result game-result--${gameResult}`}
              role="status"
              aria-live="polite"
            >
              <p className="game-result-title">
                {gameResult === "win" ? "You win!" : "No luck this time"}
              </p>
              <p className="game-result-detail">
                {gameResult === "win"
                  ? "Three matching symbols — nice!"
                  : "No three-of-a-kind — try again."}
              </p>
              <button
                type="button"
                className="game-result-button"
                onClick={resetScratch}
              >
                Play again
              </button>
            </div>
          ) : null}
        </div>
        <aside className="panel">
          <div>
            <p className="eyebrow">Milestone 1</p>
            <h1>Full Dress Scratch Test</h1>
          </div>
          <label>
            Card
            <select
              aria-label="Card clip"
              onChange={(event) => setSelectedCardId(event.currentTarget.value)}
              value={selectedCardId}
            >
              {CARDS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mesh
            <select
              aria-label="Mesh keyframe JSON"
              disabled={meshFiles.length === 0}
              onChange={(event) =>
                setSelectedMeshFile(event.currentTarget.value)
              }
              value={selectedMeshFile}
            >
              {meshFiles.length === 0 ? (
                <option value="">No mesh JSON files</option>
              ) : (
                meshFiles.map((file) => (
                  <option key={file} value={file}>
                    {file}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="timeline-controls">
            <input
              aria-label="Video timeline"
              max={duration || 0}
              min={0}
              onChange={(event) =>
                setVideoTime(Number(event.currentTarget.value))
              }
              step={0.05}
              type="range"
              value={Math.min(currentTime, duration || currentTime)}
            />
          </div>
          <div className="button-row">
            <button type="button" onClick={togglePlayback}>
              {isPaused ? "Play video" : "Pause video"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={resetScratch}
            >
              Reset scratch
            </button>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowMesh((current) => !current)}
            >
              {showMesh ? "Hide mesh" : "Show mesh"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setMeshReloadToken((current) => current + 1)}
            >
              Reload mesh
            </button>
          </div>
          {desktopSettingsTabs}
        </aside>
      </section>
    </main>
  );
}
