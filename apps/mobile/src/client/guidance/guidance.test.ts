/**
 * Guidance — capture spec v2 §3: priority, hysteresis, rolling median of 5,
 * ≥ 1.2 s message hold, and a 0.5 s hold that survives 1–2 bad frames.
 * Every measure here is synthetic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_GATE_CONFIG } from '@facetype/contracts';

import type { FrameMeasure } from '../native/types.ts';
import { syntheticMeasure } from '../native/simulator.ts';
import {
  guidanceView,
  initialGuidance,
  median,
  rearmGuidance,
  stepGuidance,
  type GuidanceState,
} from './guidance.ts';

const C = CLIENT_GATE_CONFIG;

/** A frame every guidance check accepts. */
function good(tsMs: number, overrides: Partial<FrameMeasure> = {}): FrameMeasure {
  return { ...syntheticMeasure(10_000), tsMs, ...overrides };
}

function feed(state: GuidanceState, frames: FrameMeasure[]): GuidanceState {
  return frames.reduce((current, frame) => stepGuidance(current, frame, C), state);
}

/** n frames at ~15 Hz starting at t0. */
function series(t0: number, n: number, make: (t: number, i: number) => FrameMeasure): FrameMeasure[] {
  return Array.from({ length: n }, (_, i) => make(t0 + i * 66, i));
}

test('median ignores non-finite values and returns null when none remain', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([Number.NaN, null, undefined, 5]), 5);
  assert.equal(median([null, Number.NaN]), null);
});

test('before any frame the screen says the camera is starting', () => {
  assert.equal(guidanceView(initialGuidance(0), C).message, 'camera_starting');
});

test('priority: one face beats distance beats centring beats facing beats light', () => {
  const bad = good(0, {
    faces: 0,
    distanceCm: 90,
    eyeMidX: 0.9,
    yaw: 30,
    clipFrac: 0.5,
  });
  let state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...bad, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'no_face');

  const multi = { ...bad, faces: 2 };
  state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...multi, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'multiple_faces');

  const far = { ...bad, faces: 1 };
  state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...far, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'move_closer');

  const offCentre = { ...far, distanceCm: 45 };
  state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...offCentre, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'centre');

  const turned = { ...offCentre, eyeMidX: 0.5 };
  state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...turned, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'look_straight');

  const dark = { ...turned, yaw: 1 };
  state = feed(initialGuidance(0), series(0, 5, (t) => ({ ...dark, tsMs: t })));
  assert.equal(guidanceView(state, C).message, 'light');
});

test('distance is judged only when native knows the focal length; size always', () => {
  // No distance estimate, face too small → size says «اقترب».
  let state = feed(
    initialGuidance(0),
    series(0, 5, (t) => good(t, { distanceCm: null, faceWidthPx: C.size.minFaceWidthPx - 30 })),
  );
  assert.equal(guidanceView(state, C).failing, 'size');
  assert.equal(guidanceView(state, C).message, 'move_closer');

  // Distance fine, but the face fills > 70% of the frame width → «ابتعد».
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { faceBox: [0.05, 0.1, 0.8, 0.8] })));
  assert.equal(guidanceView(state, C).message, 'move_back');

  // Too close by the estimate → «ابتعد».
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { distanceCm: 25 })));
  assert.equal(guidanceView(state, C).failing, 'distance');
  assert.equal(guidanceView(state, C).message, 'move_back');

  // No estimate and a large enough face: passes.
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { distanceCm: null })));
  assert.equal(guidanceView(state, C).failing, null);
});

test('hysteresis: a passing check survives values between the enter and exit limits', () => {
  // Enter at yaw ≤ 8°, then drift to 10° (inside the 12° exit): still facing.
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { yaw: 5 })));
  assert.equal(state.checks.facing.pass, true);
  state = feed(state, series(400, 5, (t) => good(t, { yaw: 10 })));
  assert.equal(state.checks.facing.pass, true);
  // Beyond the exit limit it fails …
  state = feed(state, series(800, 5, (t) => good(t, { yaw: 13 })));
  assert.equal(state.checks.facing.pass, false);
  // … and 10° is not enough to re-enter.
  state = feed(state, series(1200, 5, (t) => good(t, { yaw: 10 })));
  assert.equal(state.checks.facing.pass, false);
  state = feed(state, series(1600, 5, (t) => good(t, { yaw: 7 })));
  assert.equal(state.checks.facing.pass, true);
});

test('size hysteresis: 10% band below the validated 220 px floor', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { faceWidthPx: 225 })));
  assert.equal(state.checks.size.pass, true);
  state = feed(state, series(400, 5, (t) => good(t, { faceWidthPx: 205 })));
  assert.equal(state.checks.size.pass, true, '205 px is inside the exit band (≥ 198)');
  state = feed(state, series(800, 5, (t) => good(t, { faceWidthPx: 190 })));
  assert.equal(state.checks.size.pass, false);
  state = feed(state, series(1200, 5, (t) => good(t, { faceWidthPx: 210 })));
  assert.equal(state.checks.size.pass, false, 're-entry needs ≥ 220 px');
});

test('light: exposure longer than 1/30 s asks for light; unknown exposure is ignored', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { exposureTimeNs: 1e9 / 15 })));
  assert.equal(guidanceView(state, C).failing, 'light');
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { exposureTimeNs: 33_333_333 })));
  assert.equal(guidanceView(state, C).failing, null, 'exactly 1/30 s is allowed');
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { exposureTimeNs: 33_333_334 })));
  assert.equal(guidanceView(state, C).failing, 'light');
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { exposureTimeNs: 1e9 / 60 })));
  assert.equal(guidanceView(state, C).failing, null);
  state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { exposureTimeNs: null })));
  assert.equal(guidanceView(state, C).failing, null, 'unknown exposure time is ignored');
});

test('rolling median of 5: one or two outlier frames do not flip a check', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t)));
  assert.equal(state.checks.oneFace.pass, true);
  state = feed(state, [good(400, { faces: 0 }), good(466, { faces: 0 })]);
  assert.equal(state.checks.oneFace.pass, true, 'median of [1,1,1,0,0] is 1');
  state = feed(state, [good(532, { faces: 0 })]);
  assert.equal(state.checks.oneFace.pass, false, 'median of [1,1,0,0,0] is 0');
});

test('a message stays at least 1.2 s before another replaces it', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t, { eyeMidX: 0.9 })));
  assert.equal(guidanceView(state, C).message, 'centre');
  const since = state.shownSinceMs;
  // Fix centring, break facing 300 ms later: the message must not switch yet.
  state = feed(state, series(since + 300, 6, (t) => good(t, { yaw: 30 })));
  assert.equal(guidanceView(state, C).message, 'centre');
  state = feed(state, [good(since + 1150, { yaw: 30 })]);
  assert.equal(guidanceView(state, C).message, 'centre');
  state = feed(state, [good(since + 1250, { yaw: 30 })]);
  assert.equal(guidanceView(state, C).message, 'look_straight');
});

test('the 0.5 s hold completes on passing frames and then reports ready', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t)));
  const start = state.holdStartMs!;
  assert.notEqual(start, null);
  assert.equal(guidanceView(state, C).ready, false);
  state = feed(state, series(start + 100, 8, (t) => good(t))); // last frame at start + 562 ms
  assert.equal(guidanceView(state, C).ready, true);
  assert.equal(guidanceView(state, C).holdProgress, 1);
  assert.equal(guidanceView(state, C).message, 'hold_still');
});

test('1–2 bad frames inside the hold do not reset it; a third consecutive one does', () => {
  let state = feed(initialGuidance(0), series(0, 5, (t) => good(t)));
  const start = state.holdStartMs!;
  // Two smoothed failures (5 bad raw frames flip the median, so feed many bad ones).
  const bad = (t: number) => good(t, { yaw: 40 });
  state = feed(state, series(start + 66, 3, bad)); // median flips after the 3rd
  assert.equal(state.holdStartMs, start);
  state = feed(state, [bad(start + 300)]);
  assert.equal(state.holdStartMs, start, 'two failing smoothed frames tolerated');
  state = feed(state, [bad(start + 366)]);
  assert.equal(state.holdStartMs, null, 'the third consecutive failure resets the hold');
  assert.equal(guidanceView(state, C).ready, false);
});

test('rearm clears readiness but keeps the smoothing window', () => {
  let state = feed(initialGuidance(0), series(0, 15, (t) => good(t)));
  assert.equal(state.ready, true);
  state = rearmGuidance(state);
  assert.equal(state.ready, false);
  assert.equal(state.window.length, 5);
});

test('the simulator script walks through no face → closer → centre → ready', () => {
  let state = initialGuidance(0);
  const seen = new Set<string>();
  for (let t = 0; t <= 7000; t += 66) {
    state = stepGuidance(state, syntheticMeasure(t), C);
    seen.add(guidanceView(state, C).message);
  }
  for (const message of ['no_face', 'move_closer', 'centre', 'hold_still']) assert.ok(seen.has(message), message);
  assert.equal(guidanceView(state, C).ready, true);
});
