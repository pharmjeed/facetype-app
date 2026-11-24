/**
 * The capture screen as a pure reducer (docs/client-app-v1.md §1 row 4,
 * docs/capture-spec-v2.md §3–§4).
 *
 *   tips ─▶ guiding ─▶ bursting ─▶ (partial → frames deleted → guiding → a fresh burst)
 *                                  (complete → uploading ─▶ checking ─▶ received | done | retake)
 *   side states: permission_denied, interrupted, camera_error, help (60 s),
 *                lost (app closed before upload finished), failed (server refused)
 *
 * ONE BURST IS ONE CAPTURE (native contract §5.16, Codex round 2 A7). Native
 * judges the relative rules (sharpness max, eye median) over the candidates of
 * a single `startBurst` call, so frames of different calls are never combined:
 * a `partial` result is deleted (`burstDisposition`), its top reason shown, and
 * the next burst starts from zero. The 60 s help card counts guidance time
 * across those retries.
 *
 * There is no photo review state by design. The upload/verdict phases are
 * projections of the durable spool manifest (`SPOOL_STATUS`), so they look the
 * same after an app restart as before it. `received` (frames verified, quality
 * checks later) is its own phase: it never says «تم».
 */

import { CLIENT_GATE_CONFIG } from '@facetype/contracts';

import type { BurstFrame, BurstOptions, BurstProgress, BurstResult, CameraErrorCode } from './native/types.ts';
import type { SpoolOutcome } from './spool/spool.ts';
import { SPOOL_TIMING } from './spool/spool.ts';
import type { SpoolManifest } from './spool/manifest.ts';

/** Total guidance time before the help card (spec §4). */
export const GUIDANCE_LIMIT_MS = 60_000;

export type CapturePhase =
  | { name: 'tips' }
  /** `retrying`: the previous burst was partial and was discarded; `partialReason` = its top reason. */
  | { name: 'guiding'; partialReason: string | null; retrying: boolean }
  | { name: 'bursting'; accepted: number; target: number; topRejectReason: string | null }
  | { name: 'help' }
  | { name: 'permission_denied' }
  | { name: 'interrupted' }
  | { name: 'camera_error'; code: CameraErrorCode }
  | { name: 'uploading'; done: number; total: number; offline: boolean }
  | { name: 'checking'; slow: boolean }
  | { name: 'received' }
  | { name: 'done' }
  | { name: 'retake'; reasons: string[] }
  | { name: 'lost' }
  | { name: 'failed'; code: string };

export interface CaptureFlowState {
  phase: CapturePhase;
  /** The frames of the one complete burst, until the spool owns them (memory only). */
  kept: BurstFrame[];
  attempts: number;
  reasonCounts: Record<string, number>;
  guidanceStartedAtMs: number | null;
  sessionStartedAtMs: number;
  helpShown: boolean;
}

export type CaptureEvent =
  | { type: 'START'; nowMs: number }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'CAMERA_ERROR'; code: CameraErrorCode }
  | { type: 'RESUME'; nowMs: number }
  | { type: 'TICK'; nowMs: number }
  | { type: 'BURST_STARTED'; target: number }
  | { type: 'BURST_PROGRESS'; progress: BurstProgress }
  | { type: 'BURST_RESULT'; result: BurstResult; nowMs: number }
  | { type: 'BURST_FAILED'; nowMs: number }
  | { type: 'ENQUEUED' }
  | { type: 'SPOOL_STATUS'; outcome: SpoolOutcome; nowMs: number }
  | { type: 'RETAKE' };

export function initialCaptureFlow(nowMs: number): CaptureFlowState {
  return {
    phase: { name: 'tips' },
    kept: [],
    attempts: 0,
    reasonCounts: {},
    guidanceStartedAtMs: null,
    sessionStartedAtMs: nowMs,
    helpShown: false,
  };
}

/** Every burst asks for the full set: frames are never carried over from an earlier burst. */
export function nextBurstOptions(): BurstOptions {
  const { targetFrames, maxDurationMs, minSpacingMs, minCoverageMs } = CLIENT_GATE_CONFIG.burst;
  return { targetFrames, maxDurationMs, minSpacingMs, minCoverageMs };
}

/**
 * What to do with a burst's frames. Only a `complete` burst of exactly the
 * target count is kept; anything else (partial, cancelled, a count that does
 * not match) is deleted from the native spool by the caller — never kept for
 * a later burst.
 */
export function burstDisposition(result: BurstResult): { keep: BurstFrame[]; discard: string[] } {
  const target = CLIENT_GATE_CONFIG.burst.targetFrames;
  if (result.status === 'complete' && result.frames.length === target) return { keep: result.frames, discard: [] };
  return { keep: [], discard: result.frames.map((frame) => frame.id) };
}

/** Map the durable spool state onto the screen. */
export function phaseFromSpool(outcome: SpoolOutcome, nowMs: number): CapturePhase | null {
  if (outcome.kind === 'idle' || outcome.kind === 'blocked') return null;
  const m: SpoolManifest = outcome.manifest;
  switch (m.stage) {
    case 'pending_create':
    case 'uploading':
      return {
        name: 'uploading',
        done: m.frames.filter((f) => f.completed).length,
        total: m.frames.length,
        offline: outcome.kind === 'waiting' && outcome.reason === 'offline',
      };
    case 'finalizing':
    case 'checking':
      return {
        name: 'checking',
        slow: m.checkingSinceMs !== null && nowMs - m.checkingSinceMs >= SPOOL_TIMING.checkingNoticeMs,
      };
    case 'received':
      return { name: 'received' };
    case 'stored':
      return { name: 'done' };
    case 'needs_retake':
      return { name: 'retake', reasons: m.verdict?.reasons ?? [] };
    case 'abandoned':
      return { name: 'lost' };
    case 'failed':
      return { name: 'failed', code: m.error ?? 'unknown' };
  }
}

const AFTER_CAMERA: readonly CapturePhase['name'][] = [
  'uploading',
  'checking',
  'received',
  'done',
  'retake',
  'lost',
  'failed',
];

export function isCameraPhase(phase: CapturePhase): boolean {
  return phase.name === 'guiding' || phase.name === 'bursting';
}

function count(counts: Record<string, number>, reason: string | null): Record<string, number> {
  if (!reason) return counts;
  return { ...counts, [reason]: (counts[reason] ?? 0) + 1 };
}

export function reduceCapture(state: CaptureFlowState, event: CaptureEvent): CaptureFlowState {
  const phase = state.phase;
  switch (event.type) {
    case 'START':
      if (phase.name !== 'tips') return state;
      return {
        ...state,
        phase: { name: 'guiding', partialReason: null, retrying: false },
        guidanceStartedAtMs: event.nowMs,
      };
    case 'PERMISSION_DENIED':
      return AFTER_CAMERA.includes(phase.name) ? state : { ...state, phase: { name: 'permission_denied' } };
    case 'CAMERA_ERROR':
      if (AFTER_CAMERA.includes(phase.name) || phase.name === 'tips') return state;
      if (event.code === 'permission_denied') return { ...state, phase: { name: 'permission_denied' } };
      if (event.code === 'camera_interrupted') return { ...state, phase: { name: 'interrupted' } };
      return { ...state, phase: { name: 'camera_error', code: event.code } };
    case 'RESUME':
      if (
        phase.name !== 'interrupted' &&
        phase.name !== 'help' &&
        phase.name !== 'camera_error' &&
        phase.name !== 'permission_denied'
      ) {
        return state;
      }
      return {
        ...state,
        phase: { name: 'guiding', partialReason: null, retrying: false },
        guidanceStartedAtMs: event.nowMs,
      };
    case 'TICK':
      if (
        phase.name === 'guiding' &&
        state.guidanceStartedAtMs !== null &&
        event.nowMs - state.guidanceStartedAtMs >= GUIDANCE_LIMIT_MS
      ) {
        return { ...state, phase: { name: 'help' }, helpShown: true };
      }
      return state;
    case 'BURST_STARTED':
      if (phase.name !== 'guiding') return state;
      return {
        ...state,
        phase: { name: 'bursting', accepted: 0, target: CLIENT_GATE_CONFIG.burst.targetFrames, topRejectReason: null },
        attempts: state.attempts + 1,
      };
    case 'BURST_PROGRESS':
      if (phase.name !== 'bursting') return state;
      return {
        ...state,
        phase: {
          ...phase,
          accepted: event.progress.accepted,
          topRejectReason: event.progress.topRejectReason,
        },
      };
    case 'BURST_RESULT': {
      if (phase.name !== 'bursting') return state;
      if (event.result.status === 'cancelled') {
        return { ...state, kept: [], phase: { name: 'guiding', partialReason: null, retrying: false } };
      }
      const { keep } = burstDisposition(event.result);
      const reasonCounts = count(state.reasonCounts, event.result.topRejectReason);
      if (keep.length > 0) {
        return {
          ...state,
          kept: keep,
          reasonCounts,
          phase: { name: 'uploading', done: 0, total: keep.length, offline: false },
        };
      }
      // Partial: the caller deletes its frames; the next burst starts from zero.
      const overTime =
        state.guidanceStartedAtMs !== null && event.nowMs - state.guidanceStartedAtMs >= GUIDANCE_LIMIT_MS;
      return {
        ...state,
        kept: [],
        reasonCounts,
        helpShown: state.helpShown || overTime,
        phase: overTime
          ? { name: 'help' }
          : { name: 'guiding', partialReason: event.result.topRejectReason, retrying: true },
      };
    }
    case 'BURST_FAILED':
      return phase.name === 'bursting'
        ? { ...state, phase: { name: 'guiding', partialReason: null, retrying: false } }
        : state;
    case 'ENQUEUED':
      // The frames now belong to the spool; the screen follows the manifest.
      return { ...state, kept: [] };
    case 'SPOOL_STATUS': {
      const next = phaseFromSpool(event.outcome, event.nowMs);
      if (!next) return state;
      // A live camera session is never interrupted by an older manifest's status.
      if (phase.name === 'tips' || isCameraPhase(phase) || phase.name === 'help') {
        return next.name === 'uploading' || next.name === 'checking' ? { ...state, phase: next } : state;
      }
      return { ...state, phase: next };
    }
    case 'RETAKE':
      return { ...initialCaptureFlow(state.sessionStartedAtMs), reasonCounts: state.reasonCounts };
  }
}
