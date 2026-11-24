/** Runtime network policy shared by uploads and processing polling. */

import { resolveAgainst } from './url.ts';

export interface RetryPolicy {
  /** Total calls, including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

type Sleep = (delayMs: number) => Promise<void>;

const sleep: Sleep = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/** A non-successful direct-to-storage response. */
export class UploadHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterHeader: string | null = null) {
    super(`Signed upload failed with HTTP ${status}`);
    this.name = 'UploadHttpError';
    this.status = status;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    this.retryAfterMs = parseRetryAfter(retryAfterHeader);
  }
}

/** Polling stopped locally, but the server job may still be running. */
export class ProcessingTimeoutError extends Error {
  readonly code = 'PROCESSING_TIMEOUT';
  readonly recoverable = true;
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Processing is still pending after ${attempts} polls`);
    this.name = 'ProcessingTimeoutError';
    this.attempts = attempts;
  }
}

/**
 * Preserve an absolute signed URL; resolve only relative development URLs.
 *
 * Parsing goes through `./url.ts`, not the `URL` global. React Native swaps in
 * a stub whose `protocol` getter throws `URL.protocol is not implemented`, so
 * the previous implementation passed under Node and failed on the first upload
 * from an actual handset.
 */
export function resolveUploadUrl(uploadUrl: string, apiUrl: string): string {
  const value = uploadUrl.trim();
  if (!value) throw new Error('The signed upload URL is empty');

  const resolved = resolveAgainst(`${apiUrl.replace(/\/+$/, '')}/`, value);
  if (resolved === null) {
    throw new Error(`Unsupported upload URL: ${value}`);
  }
  return resolved;
}

export function uploadHttpError(response: Pick<Response, 'status' | 'headers'>): UploadHttpError {
  return new UploadHttpError(response.status, response.headers.get('Retry-After'));
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof UploadHttpError) return error.retryable;
  if (error instanceof TypeError) return true; // fetch uses TypeError for transport failures.
  if (typeof error !== 'object' || error === null) return false;
  return (error as { retryable?: unknown }).retryable === true;
}

function retryAfterFrom(error: unknown): number | null {
  if (error instanceof UploadHttpError) return error.retryAfterMs;
  if (typeof error !== 'object' || error === null) return null;
  const seconds = (error as { problem?: { retry_after_seconds?: unknown } }).problem
    ?.retry_after_seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : null;
}

export function backoffDelay(
  failedAttempt: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
  retryAfterMs: number | null = null,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  const requested = retryAfterMs ?? exponential;
  return Math.min(policy.maxDelayMs, Math.max(0, requested));
}

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  wait: Sleep = sleep,
): Promise<T> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error('maxAttempts must be at least one');
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === policy.maxAttempts || !isRetryableError(error)) throw error;
      await wait(backoffDelay(attempt, policy, retryAfterFrom(error)));
    }
  }
  throw new Error('unreachable retry state');
}

export interface PollStatus {
  status: string;
  stage?: string | null;
}

export interface PollOptions<T extends PollStatus> extends RetryPolicy {
  pollIntervalMs: number;
  wait?: Sleep;
  onStatus?: (status: T) => void;
}

/**
 * Poll with a single total attempt budget. Network failures consume that
 * budget and use exponential backoff, so an offline device cannot loop forever.
 */
export async function pollUntilTerminal<T extends PollStatus>(
  getStatus: () => Promise<T>,
  options: PollOptions<T>,
): Promise<T> {
  const wait = options.wait ?? sleep;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const status = await getStatus();
      options.onStatus?.(status);
      if (status.status === 'SUCCEEDED' || status.status === 'FAILED') return status;
      if (attempt < options.maxAttempts) await wait(options.pollIntervalMs);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      if (attempt < options.maxAttempts) {
        await wait(backoffDelay(attempt, options, retryAfterFrom(error)));
      }
    }
  }
  throw new ProcessingTimeoutError(options.maxAttempts);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
