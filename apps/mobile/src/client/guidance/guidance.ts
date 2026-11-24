/**
 * Live guidance — docs/capture-spec-v2.md §3 (TS owns guidance; native owns
 * the authoritative per-frame QA and the burst).
 *
 * PIPELINE, per `onFrameMeasure` event:
 *   1. rolling median of the last 5 analysed frames (numeric fields; NaN and
 *      missing values are skipped, never read as 0);
 *   2. each check keeps a pass/fail state with ENTER/EXIT hysteresis, so a
 *      value hovering at a limit does not flicker the message;
 *   3. the message is the highest-priority failing check
 *      (one face → distance → size → centred → facing → light), or «اثبت…»
 *      when everything passes;
 *   4. a shown message stays at least 1.2 s before another replaces it;
 *   5. once everything passes, a 0.5 s hold runs; 1–2 bad frames inside it do
 *      not reset it, a third consecutive one does. When the hold completes the
 *      burst may start.
 *
 * Expression, eyes and sharpness are not guidance checks: the only face
 * instruction is «بدون ابتسامة» on the tips card (natural-face capture), and
 * the native burst rejects smiling / blinking / blurred frames on its own.
 *
 * Every number used here comes from CLIENT_GATE_CONFIG or from
 * GUIDANCE_TIMING below (all labelled `default`: engineering defaults, not
 * validated).
 */

import type { ClientGateConfig } from '@facetype/contracts';

import type { FrameMeasure } from '../native/types.ts';

export type GuidanceMessage =
  | 'camera_starting'
  | 'no_face'
  | 'multiple_faces'
  | 'move_closer'
  | 'move_back'
  | 'centre'
  | 'look_straight'
  | 'light'
  | 'hold_still';

export type GuidanceCheck = 'oneFace' | 'distance' | 'size' | 'centred' | 'facing' | 'light';

/** Priority order, highest first (spec §3 rows 2–6). */
export const CHECK_PRIORITY: readonly GuidanceCheck[] = ['oneFace', 'distance', 'size', 'centred', 'facing', 'light'];

export const GUIDANCE_TIMING = {
  medianWindow: 5,
  messageHoldMs: 1200,
  /** Bad frames tolerated inside the hold before it resets (spec: 1–2). */
  holdTolerance: 2,
  /** Size exit band (spec: 10%). */
  sizeExitFrac: 0.1,
  /** Centre exit band (spec: 5% wider, absolute in normalised units). */
  centreExitWiden: 0.05,
  /** Light exit band (spec: 1.5× limits). */
  lightExitFactor: 1.5,
  /** «اجعل الضوء أمامك» when exposure time > 1/30 s (spec §1 row 11; contract §5.11). */
  maxExposureNs: 33_333_333,
} as const;

interface Smoothed {
  faces: number | null;
  yaw: number | null;
  pitch: number | null;
  roll: number | null;
  faceBox: [number, number, number, number] | null;
  eyeMidX: number | null;
  faceCentreY: number | null;
  faceWidthPx: number | null;
  distanceCm: number | null;
  clipFrac: number | null;
  crushFrac: number | null;
  cheekRatio: number | null;
  exposureTimeNs: number | null;
}

type CheckState = { pass: boolean; message: GuidanceMessage | null };

export interface GuidanceState {
  window: FrameMeasure[];
  checks: Record<GuidanceCheck, CheckState>;
  shown: GuidanceMessage;
  shownSinceMs: number;
  holdStartMs: number | null;
  badInHold: number;
  ready: boolean;
  lastTsMs: number | null;
}

export interface GuidanceView {
  message: GuidanceMessage;
  /** 0–1 progress of the 0.5 s hold, for the ring. */
  holdProgress: number;
  /** All checks pass and the hold completed: the burst may start. */
  ready: boolean;
  failing: GuidanceCheck | null;
}

function failing(message: GuidanceMessage | null): CheckState {
  return { pass: false, message };
}

export function initialGuidance(nowMs = 0): GuidanceState {
  return {
    window: [],
    checks: {
      oneFace: failing('no_face'),
      distance: failing(null),
      size: failing('move_closer'),
      centred: failing('centre'),
      facing: failing('look_straight'),
      light: failing('light'),
    },
    shown: 'camera_starting',
    shownSinceMs: nowMs,
    holdStartMs: null,
    badInHold: 0,
    ready: false,
    lastTsMs: null,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Median of the finite values, or null when there are none. */
export function median(values: Array<number | null | undefined>): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function smooth(window: readonly FrameMeasure[]): Smoothed {
  const pick = (read: (m: FrameMeasure) => number | null | undefined) => median(window.map(read));
  const box = [0, 1, 2, 3].map((i) => pick((m) => (Array.isArray(m.faceBox) ? m.faceBox[i] : null)));
  return {
    faces: pick((m) => m.faces),
    yaw: pick((m) => m.yaw),
    pitch: pick((m) => m.pitch),
    roll: pick((m) => m.roll),
    faceBox: box.every(finite) ? (box as [number, number, number, number]) : null,
    eyeMidX: pick((m) => m.eyeMidX),
    faceCentreY: pick((m) => m.faceCentreY),
    faceWidthPx: pick((m) => m.faceWidthPx),
    // A distance exists only when native knows the focal length; the median
    // covers the frames that carried one.
    distanceCm: pick((m) => m.distanceCm),
    clipFrac: pick((m) => m.clipFrac),
    crushFrac: pick((m) => m.crushFrac),
    cheekRatio: pick((m) => m.cheekRatio),
    exposureTimeNs: pick((m) => m.exposureTimeNs),
  };
}

const within = (value: number, [lo, hi]: readonly [number, number]) => value >= lo && value <= hi;

/**
 * Hysteresis for one check: a failing check passes only inside the ENTER
 * limits; a passing check fails only outside the EXIT limits.
 */
function evaluate(
  check: GuidanceCheck,
  previous: CheckState,
  v: Smoothed,
  config: ClientGateConfig,
): CheckState {
  const was = previous.pass;
  switch (check) {
    case 'oneFace': {
      if (v.faces === null || Math.round(v.faces) === 0) return failing('no_face');
      if (Math.round(v.faces) > 1) return failing('multiple_faces');
      return { pass: true, message: null };
    }
    case 'distance': {
      // Only when the focal length is known; otherwise size alone decides.
      if (v.distanceCm === null) return { pass: true, message: null };
      const d = v.distanceCm;
      const [enterLo, enterHi] = config.distance.enterCm;
      const [exitLo, exitHi] = config.distance.exitCm;
      if (was ? d >= exitLo && d <= exitHi : d >= enterLo && d <= enterHi) return { pass: true, message: null };
      return failing(d > (was ? exitHi : enterHi) ? 'move_closer' : 'move_back');
    }
    case 'size': {
      const width = v.faceWidthPx;
      const frac = v.faceBox ? v.faceBox[2] : null;
      if (width === null || frac === null) return failing('move_closer');
      const band = GUIDANCE_TIMING.sizeExitFrac;
      const minPx = was ? config.size.minFaceWidthPx * (1 - band) : config.size.minFaceWidthPx;
      const maxFrac = was ? config.size.maxFaceWidthFrac * (1 + band) : config.size.maxFaceWidthFrac;
      if (frac > maxFrac) return failing('move_back');
      if (width < minPx) return failing('move_closer');
      return { pass: true, message: null };
    }
    case 'centred': {
      const box = v.faceBox;
      if (v.eyeMidX === null || v.faceCentreY === null || box === null) return failing('centre');
      const widen = was ? GUIDANCE_TIMING.centreExitWiden : 0;
      const [ex0, ex1] = config.centre.eyeMidX;
      const [cy0, cy1] = config.centre.faceCentreY;
      const margin = config.centre.edgeMarginFrac - widen;
      const [x, y, w, h] = box;
      const ok =
        within(v.eyeMidX, [ex0 - widen, ex1 + widen]) &&
        within(v.faceCentreY, [cy0 - widen, cy1 + widen]) &&
        x >= margin &&
        y >= margin &&
        x + w <= 1 - margin &&
        y + h <= 1 - margin;
      return ok ? { pass: true, message: null } : failing('centre');
    }
    case 'facing': {
      if (v.yaw === null || v.pitch === null) return failing('look_straight');
      const limit = was ? config.pose.exitDeg : config.pose.enterDeg;
      const rollOk = v.roll === null || Math.abs(v.roll) <= config.pose.rollMessageDeg;
      return Math.abs(v.yaw) <= limit && Math.abs(v.pitch) <= limit && rollOk
        ? { pass: true, message: null }
        : failing('look_straight');
    }
    case 'light': {
      if (v.clipFrac === null || v.crushFrac === null || v.cheekRatio === null) return failing('light');
      const k = was ? GUIDANCE_TIMING.lightExitFactor : 1;
      const [r0, r1] = config.light.cheekRatio;
      const exposureOk = v.exposureTimeNs === null || v.exposureTimeNs <= GUIDANCE_TIMING.maxExposureNs;
      const ok =
        v.clipFrac <= config.light.maxClipFrac * k &&
        v.crushFrac <= config.light.maxCrushFrac * k &&
        within(v.cheekRatio, [r0 / k, r1 * k]) &&
        exposureOk;
      return ok ? { pass: true, message: null } : failing('light');
    }
  }
}

/** Advance guidance by one measure. Pure: same inputs, same state. */
export function stepGuidance(
  state: GuidanceState,
  measure: FrameMeasure,
  config: ClientGateConfig,
): GuidanceState {
  const now = finite(measure.tsMs) ? measure.tsMs : (state.lastTsMs ?? 0);
  const window = [...state.window, measure].slice(-GUIDANCE_TIMING.medianWindow);
  const values = smooth(window);

  const checks = { ...state.checks };
  for (const check of CHECK_PRIORITY) checks[check] = evaluate(check, state.checks[check], values, config);
  const firstFailing = CHECK_PRIORITY.find((check) => !checks[check].pass) ?? null;
  const allPass = firstFailing === null;

  // Hold: starts when everything passes; tolerates `holdTolerance` bad frames.
  let holdStartMs = state.holdStartMs;
  let badInHold = state.badInHold;
  if (allPass) {
    if (holdStartMs === null) holdStartMs = now;
    badInHold = 0;
  } else if (holdStartMs !== null) {
    badInHold += 1;
    if (badInHold > GUIDANCE_TIMING.holdTolerance) {
      holdStartMs = null;
      badInHold = 0;
    }
  }
  const ready =
    state.ready || (allPass && holdStartMs !== null && now - holdStartMs >= config.burst.holdMs);

  // Message: «اثبت…» while the hold runs (including its tolerated bad
  // frames), otherwise the highest-priority failure; held ≥ 1.2 s once shown.
  const desired: GuidanceMessage =
    holdStartMs !== null || firstFailing === null
      ? 'hold_still'
      : (checks[firstFailing].message ?? 'centre');
  let shown = state.shown;
  let shownSinceMs = state.shownSinceMs;
  if (desired !== shown) {
    const mayChange = shown === 'camera_starting' || now - shownSinceMs >= GUIDANCE_TIMING.messageHoldMs;
    if (mayChange) {
      shown = desired;
      shownSinceMs = now;
    }
  }

  return {
    window,
    checks,
    shown,
    shownSinceMs,
    holdStartMs,
    badInHold,
    ready,
    lastTsMs: now,
  };
}

export function guidanceView(state: GuidanceState, config: ClientGateConfig): GuidanceView {
  const now = state.lastTsMs ?? 0;
  const holdProgress =
    state.ready ? 1 : state.holdStartMs === null ? 0 : Math.min(1, (now - state.holdStartMs) / config.burst.holdMs);
  return {
    message: state.shown,
    holdProgress,
    ready: state.ready,
    failing: CHECK_PRIORITY.find((check) => !state.checks[check].pass) ?? null,
  };
}

/** Restart the hold (e.g. after a partial burst) while keeping the smoothing window. */
export function rearmGuidance(state: GuidanceState): GuidanceState {
  return { ...state, ready: false, holdStartMs: null, badInHold: 0 };
}
