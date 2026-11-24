/**
 * What a failed capture is actually called.
 *
 * Both native bridges reject their promises with a real FT-* code:
 * `FT-SCAN-004` for a second face in the frame, `FT-SCAN-005` for no tracked
 * face, `FT-SCAN-014` for quality evidence that could not be measured,
 * `FT-REC-005` for a device that cannot produce geometry at all
 * (`ios/FaceTypeCapture.swift`, `android/.../FaceTypePreviewView.kt`). React
 * Native surfaces that code on the rejected error as `error.code`.
 *
 * `App.tsx` threw all of it away. Its capture handler read
 * `error instanceof FaceTypeApiError ? error.errorCode : 'FT-SYS-003'`, and a
 * native rejection is a plain `Error`, not a `FaceTypeApiError` — so every
 * local capture failure was reported as the generic `FT-SYS-003`. Two
 * user-visible consequences followed:
 *
 *  - `ScanScreen`'s `ERROR_HINT` table maps `FT-SCAN-004`/`005`/`006`/... to
 *    the one instruction that fixes each ("only one face in the frame", "hold
 *    still", "more light"). Because no native code ever reached it, that table
 *    was unreachable for native capture and the user was told nothing at all
 *    about why the pose failed.
 *  - the `pose_rejected` analytics event recorded `reason_code: FT-SYS-003`
 *    for every rejection, so the funnel could not distinguish "two faces in
 *    frame" from a bug.
 *
 * The same collapse applied to the camera-permission path. Android throws
 * `CAMERA_PERMISSION_DENIED` from `consent()`, iOS now rejects `start()` with
 * the identical code, and `runtimeErrorCode` mapped both to `FT-SYS-003` —
 * making a permission the user can fix in Settings indistinguishable from an
 * internal error.
 *
 * Framework-free on purpose: this is the mapping the contract tests exercise
 * directly, with no React Native, renderer or network in the way.
 */

/**
 * Server-issued and bridge-issued error codes share one shape
 * (`specs/facetype-error-codes.md`): a family and a three-digit number.
 * Matching the shape rather than an allow-list means a code added to a native
 * bridge reaches the UI without a second edit here — while anything that is
 * not a code (a message, a stack, an SDK string) still cannot impersonate one.
 */
export const FT_ERROR_CODE_PATTERN = /^FT-[A-Z]+-\d{3}$/;

/**
 * The same code at the head of a sentence.
 *
 * This is how the client's *own* guards report themselves, and there are more
 * of them than there are native rejections: `assertMeasuredQuality` in
 * `App.tsx` throws `FT-SCAN-014: unmeasured quality signals: blur,exposure`,
 * and `NativeGeometryProvider.capture` throws eight variants of
 * `FT-SCAN-014: …` / `FT-REC-006: …` while validating the bridge's numbers.
 * Matching only whole-string codes meant every one of those still collapsed
 * to FT-SYS-003 — the exact defect this module was added to fix, left in
 * place for the paths that fire most often (Codex review
 * 2026-08-26T13-14-11Z, item 3).
 *
 * Anchored, and the code must be followed by `: ` or end the string, so a
 * message that merely mentions a code somewhere in prose cannot impersonate
 * one.
 */
const FT_ERROR_CODE_PREFIX = /^(FT-[A-Z]+-\d{3})(?::\s|$)/;

/** Camera access refused or unavailable. Not an FT-* code: no server ever emits it. */
export const CAMERA_PERMISSION_DENIED = 'CAMERA_PERMISSION_DENIED';
export const CAMERA_PERMISSION_UNAVAILABLE = 'CAMERA_PERMISSION_UNAVAILABLE';
/** No usable capture provider on this device. Raised by `consent()`. */
export const CAPTURE_UNAVAILABLE = 'CAPTURE_UNAVAILABLE';

const CLIENT_CODES: readonly string[] = [
  CAMERA_PERMISSION_DENIED,
  CAMERA_PERMISSION_UNAVAILABLE,
  CAPTURE_UNAVAILABLE,
];

/** Used when nothing more specific is known. `FT-SYS-003` is INTERNAL_ERROR. */
export const UNKNOWN_ERROR_CODE = 'FT-SYS-003';

/**
 * A bare code, exactly as a native bridge supplies it on `error.code`.
 * No prefix parsing here: React Native passes the reject block's first
 * argument through verbatim, so anything other than an exact match is
 * something else entirely.
 */
function exactCode(value: string): boolean {
  return FT_ERROR_CODE_PATTERN.test(value) || CLIENT_CODES.includes(value);
}

/** The code an `Error.message` announces itself with, bare or prefixed. */
function codeFromMessage(message: string): string | null {
  if (CLIENT_CODES.includes(message)) return message;
  return FT_ERROR_CODE_PREFIX.exec(message)?.[1] ?? null;
}

/**
 * The code a native rejection carries, or `null` if this error did not come
 * from one.
 *
 * Two shapes are accepted, because the two platforms produce two:
 *
 *  - `error.code`, which is what React Native puts on the error it builds from
 *    a rejected native promise (`RCTPromiseRejectBlock`'s first argument on
 *    iOS, `Promise.reject(code, message)` on Android). Matched exactly.
 *  - `error.message`, which covers both the bare codes `App.tsx` raises on the
 *    Android consent path (`new Error('CAMERA_PERMISSION_DENIED')`) and the
 *    prefixed form every client-side quality and contract guard uses
 *    (`new Error('FT-SCAN-014: …')`).
 *
 * Anything else — a transport failure, a thrown string, a null — is not a
 * code and must not be reported as one.
 */
export function nativeCaptureErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && exactCode(code)) return code;
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') return codeFromMessage(message);
  return null;
}

/**
 * The code to record and show for a failed pose capture.
 *
 * `apiErrorCode` is the caller's already-narrowed `FaceTypeApiError.errorCode`
 * (or `null`). It is passed in rather than detected here so this module stays
 * free of the generated API client and can be tested without it; a server code
 * always wins, because it describes a decision the server actually made about
 * this observation.
 */
export function resolveCaptureErrorCode(error: unknown, apiErrorCode: string | null): string {
  if (apiErrorCode) return apiErrorCode;
  return nativeCaptureErrorCode(error) ?? UNKNOWN_ERROR_CODE;
}
