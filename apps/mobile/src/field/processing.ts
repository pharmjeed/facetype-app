import type { CaptureStateResponse } from '@facetype/contracts';

export const FIELD_PROCESSING_TIMEOUT = 'FIELD_PROCESSING_TIMEOUT';

type Wait = (milliseconds: number) => Promise<void>;

const wait: Wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function waitForFieldProcessing(
  read: () => Promise<CaptureStateResponse>,
  options: { attempts?: number; intervalMs?: number; wait?: Wait } = {},
): Promise<CaptureStateResponse> {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 1_000;
  const pause = options.wait ?? wait;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const state = await read();
    if (state.processing_state === 'READY' || state.processing_state === 'RETAKE_REQUIRED') {
      return state;
    }
    if (attempt < attempts) await pause(intervalMs);
  }
  const error = new Error('field processing did not reach a terminal state') as Error & {
    code: string;
  };
  error.code = FIELD_PROCESSING_TIMEOUT;
  throw error;
}
