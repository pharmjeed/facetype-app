/**
 * One typed carrier for FT error codes across the JS/native boundary.
 *
 * THE BUG THIS EXISTS TO PREVENT (Codex M2 requirement C). `promise.reject(code,
 * message)` in Kotlin and `reject(code, message, error)` in Swift both arrive
 * in JavaScript as an `Error` carrying a `code` property. The capture flow used
 * to inspect only `FaceTypeApiError` and collapse everything else to
 * `FT-SYS-003`, so `FT-SCAN-004` ("more than one face"), `FT-SCAN-005` ("no
 * face") and `FT-SCAN-014` ("not measured") — the three the native side works
 * hardest to distinguish — all reached the user as the same generic system
 * error, with no way to tell them what to do differently.
 *
 * The other half of the rule is that codes are *carried*, never *parsed*. A
 * normalizer that scanned message text would make every user-facing string a
 * load-bearing part of the error contract, and would silently start
 * misclassifying the moment one was translated — which, for an Arabic-first
 * product, is the expected case rather than the edge case.
 */

/** Shape of an FT error code: `FT-<AREA>-<NNN>`. */
const FT_ERROR_CODE = /^FT-[A-Z]+-\d{3}$/;

export function isFaceTypeErrorCode(value: unknown): value is string {
  return typeof value === 'string' && FT_ERROR_CODE.test(value);
}

/** An error that knows which FT code it is, without anyone reading its text. */
export class CaptureError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    if (options && 'cause' in options) {
      // `Error.cause` is ES2022; React Native's Hermes build does not always
      // honour the constructor option, so it is attached explicitly.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Builds a rejection that carries [code] rather than describing it in prose. */
export function captureError(
  code: string,
  message: string,
  options?: { cause?: unknown },
): CaptureError {
  return new CaptureError(code, message, options);
}

/**
 * Recovers the FT code an arbitrary thrown value is carrying.
 *
 * Recognised, in order:
 *  1. a `CaptureError` — already typed, returned unchanged;
 *  2. anything with a well-formed `code` property — this is the React Native
 *     native-module rejection shape, and covers both Kotlin and Swift;
 *  3. anything with a well-formed `errorCode` property — the generated API
 *     client's `FaceTypeApiError`.
 *
 * Anything else is genuinely unclassified and becomes [fallbackCode]. That is
 * a real answer, not a shrug: an error with no code did not come from a gate
 * that had something specific to say.
 */
export function normalizeCaptureError(
  error: unknown,
  fallbackCode = 'FT-SYS-003',
): CaptureError {
  if (error instanceof CaptureError) return error;

  const candidate = error as { code?: unknown; errorCode?: unknown; message?: unknown } | null;
  const carried = candidate?.code ?? candidate?.errorCode;
  const message =
    typeof candidate?.message === 'string' && candidate.message.length > 0
      ? candidate.message
      : 'Capture failed.';

  if (isFaceTypeErrorCode(carried)) {
    return new CaptureError(carried, message, { cause: error });
  }
  return new CaptureError(fallbackCode, message, { cause: error });
}
