import { useCallback, useEffect, useRef, useState } from "react";

export type ParallaxOffset = {
  x: number;
  y: number;
};

export type ParallaxState = {
  fg: ParallaxOffset;
  bg: ParallaxOffset;
  /** Tilt + finger combined — use for linked layer stacks (WebGL / CSS). */
  group: ParallaxOffset;
};

export type MotionPermission =
  | "idle"
  | "pending"
  | "active"
  | "denied"
  | "unsupported"
  | "insecure";

type UseDeviceParallaxOptions = {
  maxX?: number;
  maxY?: number;
  rangeDeg?: number;
  smoothing?: number;
  enabled?: boolean;
  /** Foreground stack: --parallax-x/y, --shadow-dx/dy */
  cssTargetRef?: { current: HTMLElement | null };
  /** Optional stage for background vars: --bg-parallax-x/y */
  stageRef?: { current: HTMLElement | null };
  /** Updated every rAF tick for WebGL / canvas consumers (no React re-render). */
  stateOutRef?: { current: ParallaxState | null };
  bgGain?: number;
  shadowGain?: number;
  shadowBase?: ParallaxOffset;
  /** Finger-drag → background shift (px of bg per px of finger). Positive = opposite. */
  fingerGain?: number;
  /** Max extra bg offset from finger drag (CSS px) */
  fingerMax?: number;
};

type PermissionAPI = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function isSecure() {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

function hasOrientationAPI() {
  return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
}

function hasMotionAPI() {
  return typeof window !== "undefined" && "DeviceMotionEvent" in window;
}

async function requestSensorPermission(
  eventName: "DeviceOrientationEvent" | "DeviceMotionEvent",
): Promise<"granted" | "denied" | "na"> {
  const Ctor = window[eventName] as unknown as PermissionAPI | undefined;
  if (!Ctor || typeof Ctor.requestPermission !== "function") return "na";
  try {
    const result = await Ctor.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/**
 * Motion + finger parallax — CSS vars and/or stateOutRef (no React re-render while moving).
 * Background = tilt * bgGain + finger offset (finger moves bg opposite the drag).
 */
export function useDeviceParallax({
  maxX = 18,
  maxY = 12,
  rangeDeg = 18,
  smoothing = 0.09,
  enabled = true,
  cssTargetRef,
  stageRef,
  stateOutRef,
  bgGain = -1.7,
  shadowGain = 0.58,
  shadowBase = { x: 0, y: 10 },
  fingerGain = 0.17,
  fingerMax = 17,
}: UseDeviceParallaxOptions = {}) {
  const [status, setStatus] = useState<MotionPermission>(() => {
    if (typeof window === "undefined") return "idle";
    if (!isSecure()) return "insecure";
    if (!hasOrientationAPI() && !hasMotionAPI()) return "unsupported";
    return "idle";
  });

  const targetRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const currentRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const fingerRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const fingerTargetRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const fingerDraggingRef = useRef(false);
  const baselineOriRef = useRef<{ beta: number; gamma: number } | null>(null);
  const baselineMotionRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const gotSampleRef = useRef(false);
  const lastSensorAtRef = useRef(0);
  const optsRef = useRef({
    bgGain,
    shadowGain,
    shadowBase,
    maxX,
    maxY,
    rangeDeg,
    smoothing,
    fingerGain,
    fingerMax,
  });
  optsRef.current = {
    bgGain,
    shadowGain,
    shadowBase,
    maxX,
    maxY,
    rangeDeg,
    smoothing,
    fingerGain,
    fingerMax,
  };

  const applyCss = useCallback(() => {
    const {
      bgGain: bg,
      shadowGain: sg,
      shadowBase: base,
    } = optsRef.current;
    const t = currentRef.current;
    const f = fingerRef.current;

    const bx = t.x * bg + f.x;
    const by = t.y * bg + f.y;
    const group = { x: t.x + f.x, y: t.y + f.y };

    if (stateOutRef) {
      stateOutRef.current = {
        fg: { x: t.x, y: t.y },
        bg: { x: bx, y: by },
        group,
      };
    }

    const fg = cssTargetRef?.current;
    if (fg) {
      const sx = base.x + t.x * sg;
      const sy = base.y + t.y * sg;
      fg.style.setProperty("--parallax-x", `${t.x.toFixed(1)}px`);
      fg.style.setProperty("--parallax-y", `${t.y.toFixed(1)}px`);
      fg.style.setProperty("--shadow-dx", `${sx.toFixed(1)}px`);
      fg.style.setProperty("--shadow-dy", `${sy.toFixed(1)}px`);
    }

    const stage = stageRef?.current;
    if (stage) {
      stage.style.setProperty("--bg-parallax-x", `${bx.toFixed(1)}px`);
      stage.style.setProperty("--bg-parallax-y", `${by.toFixed(1)}px`);
    }
  }, [cssTargetRef, stageRef, stateOutRef]);

  const tick = useCallback(() => {
    const { smoothing: s } = optsRef.current;
    const cur = currentRef.current;
    const target = targetRef.current;
    const nx = cur.x + (target.x - cur.x) * s;
    const ny = cur.y + (target.y - cur.y) * s;
    currentRef.current = { x: nx, y: ny };

    const fCur = fingerRef.current;
    const fTarget = fingerDraggingRef.current
      ? fingerTargetRef.current
      : { x: 0, y: 0 };
    const fingerSmooth = fingerDraggingRef.current ? 0.052 : 0.026;
    const fx = fCur.x + (fTarget.x - fCur.x) * fingerSmooth;
    const fy = fCur.y + (fTarget.y - fCur.y) * fingerSmooth;
    fingerRef.current = { x: fx, y: fy };

    applyCss();

    const tiltDone = Math.hypot(target.x - nx, target.y - ny) <= 0.08;
    const fingerDone = Math.hypot(fTarget.x - fx, fTarget.y - fy) <= 0.15;
    if (!tiltDone || !fingerDone) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
      currentRef.current = { ...target };
      fingerRef.current = { ...fTarget };
      applyCss();
    }
  }, [applyCss]);

  const scheduleTick = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const pushTarget = useCallback(
    (x: number, y: number) => {
      if (!gotSampleRef.current) {
        gotSampleRef.current = true;
        setStatus("active");
      }
      const { maxX: mx, maxY: my } = optsRef.current;
      targetRef.current = {
        x: clamp(x, -mx, mx),
        y: clamp(y, -my, my),
      };
      scheduleTick();
    },
    [scheduleTick],
  );

  const addFingerDelta = useCallback(
    (dx: number, dy: number) => {
      const { fingerGain: g, fingerMax: max } = optsRef.current;
      fingerDraggingRef.current = true;
      const nextX = clamp(fingerTargetRef.current.x - dx * g, -max, max);
      const nextY = clamp(fingerTargetRef.current.y - dy * g, -max, max);
      fingerTargetRef.current = { x: nextX, y: nextY };
      scheduleTick();
    },
    [scheduleTick],
  );

  const releaseFinger = useCallback(() => {
    fingerDraggingRef.current = false;
    fingerTargetRef.current = { x: 0, y: 0 };
    scheduleTick();
  }, [scheduleTick]);

  const onOrientation = useCallback(
    (event: DeviceOrientationEvent) => {
      if (!enabled) return;
      const now = performance.now();
      if (now - lastSensorAtRef.current < 32) return;
      lastSensorAtRef.current = now;

      const gamma = event.gamma;
      const beta = event.beta;
      if (gamma == null || beta == null) return;

      if (!baselineOriRef.current) {
        baselineOriRef.current = { beta, gamma };
      }

      const { rangeDeg: rd, maxX: mx, maxY: my } = optsRef.current;
      const dGamma = gamma - baselineOriRef.current.gamma;
      const dBeta = beta - baselineOriRef.current.beta;
      pushTarget((dGamma / rd) * mx, (dBeta / rd) * my);
    },
    [enabled, pushTarget],
  );

  const onMotion = useCallback(
    (event: DeviceMotionEvent) => {
      if (!enabled) return;
      if (gotSampleRef.current && baselineOriRef.current) return;

      const now = performance.now();
      if (now - lastSensorAtRef.current < 32) return;
      lastSensorAtRef.current = now;

      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x == null || acc.y == null) return;

      if (!baselineMotionRef.current) {
        baselineMotionRef.current = { x: acc.x, y: acc.y };
      }

      const { maxX: mx, maxY: my } = optsRef.current;
      const dx = acc.x - baselineMotionRef.current.x;
      const dy = acc.y - baselineMotionRef.current.y;
      pushTarget((dx / 4.5) * mx, (-dy / 4.5) * my);
    },
    [enabled, pushTarget],
  );

  const startListening = useCallback(() => {
    if (listeningRef.current || typeof window === "undefined") return;
    listeningRef.current = true;
    window.addEventListener("deviceorientation", onOrientation, { passive: true });
    window.addEventListener("devicemotion", onMotion, { passive: true });
  }, [onMotion, onOrientation]);

  const stopListening = useCallback(() => {
    if (!listeningRef.current || typeof window === "undefined") return;
    listeningRef.current = false;
    window.removeEventListener("deviceorientation", onOrientation);
    window.removeEventListener("devicemotion", onMotion);
  }, [onMotion, onOrientation]);

  const requestPermission = useCallback(async () => {
    if (typeof window === "undefined") return false;
    if (!isSecure()) {
      setStatus("insecure");
      return false;
    }
    if (!hasOrientationAPI() && !hasMotionAPI()) {
      setStatus("unsupported");
      return false;
    }

    setStatus("pending");
    gotSampleRef.current = false;
    baselineOriRef.current = null;
    baselineMotionRef.current = null;

    const ori = await requestSensorPermission("DeviceOrientationEvent");
    const mot = await requestSensorPermission("DeviceMotionEvent");

    if (ori === "denied" && mot === "denied") {
      setStatus("denied");
      return false;
    }

    startListening();
    setStatus("active");
    applyCss();
    return true;
  }, [applyCss, startListening]);

  const recalibrate = useCallback(() => {
    baselineOriRef.current = null;
    baselineMotionRef.current = null;
    targetRef.current = { x: 0, y: 0 };
    scheduleTick();
  }, [scheduleTick]);

  useEffect(() => {
    applyCss();
  }, [applyCss]);

  useEffect(() => {
    if (!enabled) {
      stopListening();
      targetRef.current = { x: 0, y: 0 };
      scheduleTick();
    }
  }, [enabled, scheduleTick, stopListening]);

  useEffect(() => {
    return () => {
      stopListening();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [stopListening]);

  return {
    status,
    showEnableButton: status !== "active" && status !== "unsupported",
    isActive: status === "active",
    isPending: status === "pending",
    isDenied: status === "denied",
    isUnsupported: status === "unsupported",
    isInsecure: status === "insecure",
    requestPermission,
    recalibrate,
    addFingerDelta,
    releaseFinger,
  };
}
