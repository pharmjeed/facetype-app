/**
 * Outcome of `selectProvider` (App.tsx), tracked explicitly rather than as a
 * single nullable `CaptureProvider`:
 *
 * - `pending`: the async `isAvailable()` probe per provider has not settled.
 * - `ready`: a usable provider was found (`provider` is non-null).
 * - `unavailable`: selection completed and no supported provider exists for
 *   this device (a legitimate `selectProvider` result of `null`, e.g. a
 *   Redmi with no supported ARCore front-face geometry) — or a disallowed
 *   result (the simulator, outside `__DEV__`) that release builds must
 *   reject rather than fall back to.
 * - `failed`: the selection promise itself rejected.
 *
 * A plain `CaptureProvider | null` cannot distinguish `pending` from
 * `unavailable`/`failed`: all three read as `null`. That conflation is what
 * let the auto-start gate below wait forever on an unsupported device — no
 * native preview would ever mount to fire `onPreviewReady`, so `previewReady`
 * never became true and the Start button stayed disabled with no error and
 * no way forward (audit R2 / M1 follow-up).
 */
export type ProviderSelectionStatus = 'pending' | 'ready' | 'unavailable' | 'failed';

/**
 * Whether `kind` has a real native `FaceTypePreviewView` to mount (Android's
 * ARCore GLSurfaceView or iOS's ARKit ARSCNView — see
 * `capture/NativeFaceTypePreview.tsx`). Both native geometry providers do;
 * `mediapipe` and `simulator` do not. Extracted as a pure function (rather
 * than left as an inline `provider?.kind === 'arcore' || ...` in App.tsx) so
 * this platform-parity fact is unit-testable and cannot silently regress to
 * an Android-only check the way it did before this file's `usingNativePreview`
 * consumer was audited (F1/F2).
 */
export function isNativePreviewProvider(kind: string | undefined): boolean {
  return kind === 'arcore' || kind === 'arkit';
}

/**
 * Auto-start gate for `startPreviewSequence` (App.tsx) — whether to run it
 * immediately for the current screen, or wait for the native
 * `onPreviewReady` event instead.
 *
 * Split out as a pure function (mirrors `previewReadySequence.ts`) so the
 * ordering bug it guards against is unit-testable without React Native.
 *
 * While selection is still `pending`, `usingNativePreview` reads
 * `provider?.kind === 'arcore' || provider?.kind === 'arkit'`, which is
 * `false` for a `null` provider whether or not the eventual provider turns
 * out to be native. Treating that transient `false` as "definitely not
 * native" used to let this gate return true and mark the sequence started
 * *before* a later-resolving native provider's preview had even mounted —
 * so the native `onPreviewReady` event that view eventually fires arrives to
 * find the guard already set, and is silently ignored forever (audit M1-F3,
 * reachable on cold restore straight to `screen === 'scan'`). This function
 * requires `providerSelection` explicitly so neither that mistake, nor the
 * pending/unavailable conflation above, can recur: it auto-starts only for
 * `ready`, and never silently hangs on `unavailable`/`failed` — those are
 * surfaced by the caller as a `shellError` instead (App.tsx), same as any
 * other fail-closed capture error.
 */
export function shouldAutoStartPreviewSequence(input: {
  screen: string;
  providerSelection: ProviderSelectionStatus;
  usingNativePreview: boolean;
  alreadyStarted: boolean;
}): boolean {
  if (input.screen !== 'scan') return false;
  if (input.providerSelection !== 'ready') return false;
  if (input.usingNativePreview) return false;
  if (input.alreadyStarted) return false;
  return true;
}
