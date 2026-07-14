import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type ParallaxOffset = { x: number; y: number };

/** Live offsets in CSS pixels for the photo-scratch stage. */
export type ParallaxState = {
  /** Foreground / group pan (bikini + clothes share this). */
  fg: ParallaxOffset;
  /** Background pan (written to --bg-parallax-* CSS vars). */
  bg: ParallaxOffset;
  /** Alias of fg — shared mid+front camera. */
  group: ParallaxOffset;
};

type MotionStatus =
  | "idle"
  | "pending"
  | "active"
  | "denied"
  | "insecure"
  | "unsupported";

type UseDeviceParallaxOptions = {
  stageRef: RefObject<HTMLElement | null>;
  /** Smooth lerp factor per frame (0..1). */
  smooth?: number;
  /** Degrees of tilt that map to max parallax. */
  rangeDeg?: number;
  /** Max pan in CSS pixels on X / Y. */
  maxX?: number;
  maxY?: number;
  /** Strength multiplier applied after mapping. */
  strength?: number;
  /** Background tilt gain relative to the group (usually ~1). */
  bgGain?: number;
  /** Finger-drag gain applied on top of tilt. */
  fingerGain?: number;
  /** Cap on finger contribution in CSS pixels. */
  fingerMax?: number;
  /**
   * When false (photo-scratch), finger drag does not pan the girl layers —
   * only the background moves, in the opposite direction.
   */
  fingerMovesGroup?: boolean;
  /** Expose live state for the rAF render loop. */
  stateOutRef?: RefObject<ParallaxState | null> | { current: ParallaxState | null };
  /** Legacy single-offset out ref (clip-space callers). */
  cameraOutRef?: RefObject<ParallaxOffset | null> | { current: ParallaxOffset | null };
  /** Desktop mouse-move fallback strength (0 disables). */
  mouseGain?: number;
};

function clamp(n: number, min: number, max: number) {
  return n < min ? min : n > max ? max : n;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function isSecure() {
  return typeof window !== "undefined" && window.isSecureContext;
}

function needsOrientationPermission() {
  return (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof (
      DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<PermissionState>;
      }
    ).requestPermission === "function"
  );
}

export function useDeviceParallax({
  stageRef,
  smooth = 0.12,
  rangeDeg = 18,
  maxX = 22,
  maxY = 16,
  strength = 1,
  bgGain = 1,
  fingerGain = 0.2,
  fingerMax = 20,
  fingerMovesGroup = true,
  stateOutRef,
  cameraOutRef,
  mouseGain = 0,
}: UseDeviceParallaxOptions) {
  const [status, setStatus] = useState<MotionStatus>(() => {
    if (typeof window === "undefined") return "idle";
    if (!isSecure()) return "insecure";
    if (typeof DeviceOrientationEvent === "undefined") return "unsupported";
    return "idle";
  });

  const tiltTargetRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const fingerTargetRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const groupCurrentRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const bgCurrentRef = useRef<ParallaxOffset>({ x: 0, y: 0 });
  const calRef = useRef<ParallaxOffset | null>(null);
  const optsRef = useRef({
    smooth,
    rangeDeg,
    maxX,
    maxY,
    strength,
    bgGain,
    fingerGain,
    fingerMax,
    fingerMovesGroup,
    mouseGain,
  });
  optsRef.current = {
    smooth,
    rangeDeg,
    maxX,
    maxY,
    strength,
    bgGain,
    fingerGain,
    fingerMax,
    fingerMovesGroup,
    mouseGain,
  };

  const publish = useCallback(() => {
    const group = { ...groupCurrentRef.current };
    const bg = { ...bgCurrentRef.current };
    if (stateOutRef) {
      stateOutRef.current = { fg: group, bg, group };
    }
    if (cameraOutRef) {
      cameraOutRef.current = group;
    }
    const stage = stageRef.current;
    if (stage) {
      stage.style.setProperty("--bg-parallax-x", `${bg.x.toFixed(2)}px`);
      stage.style.setProperty("--bg-parallax-y", `${bg.y.toFixed(2)}px`);
    }
  }, [cameraOutRef, stageRef, stateOutRef]);

  useEffect(() => {
    let frameId = 0;
    const tick = () => {
      const { smooth: s, bgGain: bgG, fingerMovesGroup: fingerOnGroup } =
        optsRef.current;
      const tilt = tiltTargetRef.current;
      const finger = fingerTargetRef.current;
      // Girl layers: tilt only (optional). Finger never drags the girl when
      // fingerMovesGroup is false — bg pans the opposite way instead.
      const groupTarget = {
        x: tilt.x + (fingerOnGroup ? finger.x : 0),
        y: tilt.y + (fingerOnGroup ? finger.y : 0),
      };
      const bgTarget = {
        x: tilt.x * bgG + (fingerOnGroup ? finger.x : -finger.x),
        y: tilt.y * bgG + (fingerOnGroup ? finger.y : -finger.y),
      };
      const group = groupCurrentRef.current;
      const bg = bgCurrentRef.current;
      group.x = lerp(group.x, groupTarget.x, s);
      group.y = lerp(group.y, groupTarget.y, s);
      bg.x = lerp(bg.x, bgTarget.x, s);
      bg.y = lerp(bg.y, bgTarget.y, s);
      publish();
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [publish]);

  const setFromTilt = useCallback((gamma: number, beta: number) => {
    const { rangeDeg: rd, maxX: mx, maxY: my, strength: st } = optsRef.current;
    if (!calRef.current) {
      calRef.current = { x: gamma, y: beta };
    }
    const cal = calRef.current;
    const nx = clamp(((gamma - cal.x) / rd) * mx * st, -mx, mx);
    const ny = clamp(((beta - cal.y) / rd) * my * st, -my, my);
    // gamma+ -> device tilted right -> pan content left.
    tiltTargetRef.current = { x: -nx, y: ny };
  }, []);

  const onOrientation = useCallback(
    (event: DeviceOrientationEvent) => {
      if (event.gamma == null || event.beta == null) return;
      setFromTilt(event.gamma, event.beta);
      setStatus((prev) => (prev === "active" ? prev : "active"));
    },
    [setFromTilt],
  );

  useEffect(() => {
    if (status !== "active") return;
    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  }, [status, onOrientation]);

  // Desktop mouse fallback across the stage (disabled by default for photo-scratch).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onMove = (event: MouseEvent) => {
      if (status === "active") return;
      const { mouseGain: gain, maxX: mx, maxY: my } = optsRef.current;
      if (gain <= 0) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      tiltTargetRef.current = {
        x: clamp(-nx * mx * gain * 8, -mx, mx),
        y: clamp(ny * my * gain * 8, -my, my),
      };
    };
    const onLeave = () => {
      if (status === "active") return;
      if (optsRef.current.mouseGain <= 0) return;
      tiltTargetRef.current = { x: 0, y: 0 };
    };
    stage.addEventListener("mousemove", onMove);
    stage.addEventListener("mouseleave", onLeave);
    return () => {
      stage.removeEventListener("mousemove", onMove);
      stage.removeEventListener("mouseleave", onLeave);
    };
  }, [stageRef, status]);

  const addFingerDelta = useCallback((dx: number, dy: number) => {
    const { fingerGain: gain, fingerMax: fMax } = optsRef.current;
    const finger = fingerTargetRef.current;
    finger.x = clamp(finger.x + dx * gain, -fMax, fMax);
    finger.y = clamp(finger.y + dy * gain, -fMax, fMax);
  }, []);

  const releaseFinger = useCallback(() => {
    fingerTargetRef.current = { x: 0, y: 0 };
  }, []);

  const requestPermission = useCallback(async () => {
    if (!isSecure()) {
      setStatus("insecure");
      return false;
    }
    if (typeof DeviceOrientationEvent === "undefined") {
      setStatus("unsupported");
      return false;
    }
    setStatus("pending");
    try {
      if (needsOrientationPermission()) {
        const request = (
          DeviceOrientationEvent as unknown as {
            requestPermission: () => Promise<PermissionState>;
          }
        ).requestPermission;
        const result = await request();
        if (result !== "granted") {
          setStatus("denied");
          return false;
        }
      }
      calRef.current = null;
      setStatus("active");
      return true;
    } catch {
      setStatus("denied");
      return false;
    }
  }, []);

  const recalibrate = useCallback(() => {
    calRef.current = null;
    tiltTargetRef.current = { x: 0, y: 0 };
    fingerTargetRef.current = { x: 0, y: 0 };
  }, []);

  return {
    status,
    requestPermission,
    recalibrate,
    addFingerDelta,
    releaseFinger,
    isActive: status === "active",
    isPending: status === "pending",
    isDenied: status === "denied",
    isInsecure: status === "insecure",
    showEnableButton:
      status === "idle" ||
      status === "denied" ||
      status === "insecure" ||
      status === "unsupported" ||
      status === "pending",
  };
}
