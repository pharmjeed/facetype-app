/** Capture screen reducer: tips → guiding → burst → upload → verdict, plus side states. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_GATE_CONFIG } from '@facetype/contracts';

import {
  burstDisposition,
  GUIDANCE_LIMIT_MS,
  initialCaptureFlow,
  nextBurstOptions,
  phaseFromSpool,
  reduceCapture,
  type CaptureEvent,
  type CaptureFlowState,
} from './captureFlow.ts';
import type { BurstFrame } from './native/types.ts';
import type { SpoolManifest } from './spool/manifest.ts';

function frames(n: number, from = 0): BurstFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${from + i}`,
    width: 1920,
    height: 1080,
    sha256: 'a'.repeat(64),
    bytes: 100,
    meta: { frame_id: `f${from + i}` },
  }));
}

function run(events: CaptureEvent[], from: CaptureFlowState = initialCaptureFlow(0)): CaptureFlowState {
  return events.reduce(reduceCapture, from);
}

function manifest(stage: SpoolManifest['stage'], extra: Partial<SpoolManifest> = {}): SpoolManifest {
  return {
    version: 2,
    accountId: 'acc-synthetic',
    clientCaptureId: 'cid-00000000',
    createdAtMs: 0,
    updatedAtMs: 0,
    stage,
    captureId: 'cap-1',
    attempt: 1,
    protocolVersion: 'p',
    gateConfigHash: 'h',
    device: {},
    camera: {},
    frames: frames(10).map((f, index) => ({ index, nativeId: f.id, sha256: f.sha256, bytes: 100, width: 1, height: 1, uploaded: index < 4, completed: index < 4 })),
    verdict: null,
    checkingSinceMs: null,
    error: null,
    attemptTelemetry: null,
    ...extra,
  };
}

const GUIDING = [{ type: 'START', nowMs: 0 }] as CaptureEvent[];

test('tips first, then guiding; no shutter, no review', () => {
  assert.equal(initialCaptureFlow(0).phase.name, 'tips');
  assert.equal(run(GUIDING).phase.name, 'guiding');
});

test('a full burst goes straight to upload', () => {
  const state = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_PROGRESS', progress: { accepted: 6, target: 10, elapsedMs: 900, topRejectReason: null } },
    { type: 'BURST_RESULT', result: { status: 'complete', topRejectReason: null, frames: frames(10) }, nowMs: 2000 },
  ]);
  assert.equal(state.phase.name, 'uploading');
  assert.equal(state.kept.length, 10);
  assert.equal(state.attempts, 1);
});

test('a partial burst is discarded, not kept: its frames are deleted and the next burst starts from zero', () => {
  const partial = { status: 'partial' as const, topRejectReason: 'expression', frames: frames(6) };
  const state = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: partial, nowMs: 9000 },
  ]);
  // Native contract §5.16: the six frames go, the top reason is shown, a fresh burst follows.
  assert.deepEqual(burstDisposition(partial), { keep: [], discard: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'] });
  assert.deepEqual(state.phase, { name: 'guiding', partialReason: 'expression', retrying: true });
  assert.deepEqual(state.kept, []);
  assert.deepEqual(state.reasonCounts, { expression: 1 });
  // Every burst asks for the full set and the full coverage.
  assert.deepEqual(nextBurstOptions(), {
    targetFrames: CLIENT_GATE_CONFIG.burst.targetFrames,
    maxDurationMs: CLIENT_GATE_CONFIG.burst.maxDurationMs,
    minSpacingMs: CLIENT_GATE_CONFIG.burst.minSpacingMs,
    minCoverageMs: CLIENT_GATE_CONFIG.burst.minCoverageMs,
  });

  const second = run([{ type: 'BURST_STARTED', target: 10 }], state);
  assert.equal(second.phase.name === 'bursting' && second.phase.accepted, 0, 'progress restarts at zero');
  const progressed = reduceCapture(second, {
    type: 'BURST_PROGRESS',
    progress: { accepted: 3, target: 10, elapsedMs: 500, topRejectReason: null },
  });
  assert.equal(progressed.phase.name === 'bursting' && progressed.phase.accepted, 3, 'not 6 + 3');

  const done = run(
    [{ type: 'BURST_RESULT', result: { status: 'complete', topRejectReason: null, frames: frames(10, 6) }, nowMs: 12000 }],
    progressed,
  );
  assert.equal(done.phase.name, 'uploading');
  assert.deepEqual(
    done.kept.map((f) => f.id),
    ['f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15'],
    'only the frames of the one complete burst',
  );
  assert.equal(done.attempts, 2);
});

test('frames from two bursts are never combined, even if together they would reach the target', () => {
  const state = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'partial', topRejectReason: 'sharp', frames: frames(9) }, nowMs: 9000 },
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'partial', topRejectReason: 'eyes', frames: frames(1, 9) }, nowMs: 18000 },
  ]);
  assert.equal(state.phase.name, 'guiding');
  assert.deepEqual(state.kept, []);
  assert.deepEqual(state.reasonCounts, { sharp: 1, eyes: 1 });
  // A "complete" result with the wrong count is not trusted either.
  const odd = { status: 'complete' as const, topRejectReason: null, frames: frames(9) };
  assert.deepEqual(burstDisposition(odd).keep, []);
  assert.equal(burstDisposition(odd).discard.length, 9);
  const cancelled = { status: 'cancelled' as const, topRejectReason: null, frames: frames(2) };
  assert.equal(burstDisposition(cancelled).discard.length, 2);
  assert.equal(burstDisposition({ status: 'complete', topRejectReason: null, frames: frames(10) }).keep.length, 10);
});

test('60 s of guidance without a full burst shows the help card; «المحاولة مرة أخرى» resumes', () => {
  let state = run([...GUIDING, { type: 'TICK', nowMs: GUIDANCE_LIMIT_MS - 1 }]);
  assert.equal(state.phase.name, 'guiding');
  state = reduceCapture(state, { type: 'TICK', nowMs: GUIDANCE_LIMIT_MS });
  assert.equal(state.phase.name, 'help');
  assert.equal(state.helpShown, true);
  state = reduceCapture(state, { type: 'RESUME', nowMs: GUIDANCE_LIMIT_MS + 5 });
  assert.equal(state.phase.name, 'guiding');
  assert.equal(state.guidanceStartedAtMs, GUIDANCE_LIMIT_MS + 5);
});

test('a partial burst that ends past the 60 s limit also shows help', () => {
  const state = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'partial', topRejectReason: 'eyes', frames: frames(3) }, nowMs: GUIDANCE_LIMIT_MS + 1 },
  ]);
  assert.equal(state.phase.name, 'help');
  assert.equal(state.kept.length, 0, 'the partial frames are not kept for after the help card');
});

test('the 60 s limit counts guidance across partial-burst retries', () => {
  const state = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'partial', topRejectReason: 'light', frames: frames(4) }, nowMs: 20_000 },
    { type: 'TICK', nowMs: 40_000 },
  ]);
  assert.equal(state.phase.name, 'guiding', 'a retry does not restart the clock');
  assert.equal(state.guidanceStartedAtMs, 0);
  assert.equal(reduceCapture(state, { type: 'TICK', nowMs: GUIDANCE_LIMIT_MS }).phase.name, 'help');
});

test('camera errors: permission denied, interrupted, others', () => {
  assert.equal(run([...GUIDING, { type: 'CAMERA_ERROR', code: 'permission_denied' }]).phase.name, 'permission_denied');
  assert.equal(run([...GUIDING, { type: 'PERMISSION_DENIED' }]).phase.name, 'permission_denied');
  const interrupted = run([...GUIDING, { type: 'CAMERA_ERROR', code: 'camera_interrupted' }]);
  assert.equal(interrupted.phase.name, 'interrupted');
  assert.equal(reduceCapture(interrupted, { type: 'RESUME', nowMs: 1 }).phase.name, 'guiding');
  assert.deepEqual(run([...GUIDING, { type: 'CAMERA_ERROR', code: 'effects_active' }]).phase, {
    name: 'camera_error',
    code: 'effects_active',
  });
  // Once the frames are handed to the spool, a late camera error changes nothing.
  const uploading = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'complete', topRejectReason: null, frames: frames(10) }, nowMs: 1 },
    { type: 'CAMERA_ERROR', code: 'camera_interrupted' },
  ]);
  assert.equal(uploading.phase.name, 'uploading');
});

test('upload and verdict phases follow the durable spool', () => {
  assert.deepEqual(phaseFromSpool({ kind: 'waiting', manifest: manifest('uploading'), retryInMs: 1, reason: 'offline' }, 0), {
    name: 'uploading',
    done: 4,
    total: 10,
    offline: true,
  });
  assert.deepEqual(phaseFromSpool({ kind: 'waiting', manifest: manifest('checking', { checkingSinceMs: 0 }), retryInMs: 1, reason: 'checking' }, 29_000), {
    name: 'checking',
    slow: false,
  });
  assert.deepEqual(phaseFromSpool({ kind: 'waiting', manifest: manifest('checking', { checkingSinceMs: 0 }), retryInMs: 1, reason: 'checking' }, 30_000), {
    name: 'checking',
    slow: true,
  });
  assert.deepEqual(phaseFromSpool({ kind: 'terminal', manifest: manifest('stored') }, 0), { name: 'done' });
  // Integrity verified, quality checks pending: its own phase, never «تم».
  assert.deepEqual(phaseFromSpool({ kind: 'terminal', manifest: manifest('received') }, 0), { name: 'received' });
  assert.deepEqual(
    phaseFromSpool(
      {
        kind: 'terminal',
        manifest: manifest('needs_retake', { verdict: { id: 'cap-1', status: 'needs_retake', accepted_frames: 0, reasons: ['glasses'] } }),
      },
      0,
    ),
    { name: 'retake', reasons: ['glasses'] },
  );
  assert.deepEqual(phaseFromSpool({ kind: 'terminal', manifest: manifest('abandoned') }, 0), { name: 'lost' });
  assert.equal(phaseFromSpool({ kind: 'idle' }, 0), null);
});

test('opening the capture screen while a capture is still uploading shows the upload, not the camera', () => {
  const state = reduceCapture(initialCaptureFlow(0), {
    type: 'SPOOL_STATUS',
    outcome: { kind: 'waiting', manifest: manifest('uploading'), retryInMs: 1, reason: 'server' },
    nowMs: 0,
  });
  assert.equal(state.phase.name, 'uploading');
  // A finished old verdict does not replace the tips card of a new attempt.
  const fresh = reduceCapture(initialCaptureFlow(0), {
    type: 'SPOOL_STATUS',
    outcome: { kind: 'terminal', manifest: manifest('stored') },
    nowMs: 0,
  });
  assert.equal(fresh.phase.name, 'tips');
});

test('retake returns to the tips card with nothing kept', () => {
  const retake = run([
    ...GUIDING,
    { type: 'BURST_STARTED', target: 10 },
    { type: 'BURST_RESULT', result: { status: 'complete', topRejectReason: null, frames: frames(10) }, nowMs: 1 },
    { type: 'ENQUEUED' },
    { type: 'SPOOL_STATUS', outcome: { kind: 'terminal', manifest: manifest('needs_retake') }, nowMs: 2 },
    { type: 'RETAKE' },
  ]);
  assert.equal(retake.phase.name, 'tips');
  assert.equal(retake.kept.length, 0);
});
