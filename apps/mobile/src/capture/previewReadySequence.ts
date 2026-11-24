/**
 * Consent -> preview-ready -> scan-creation sequencing (FT-17 §14; design
 * review D3, mailbox message 2026-08-25T21-54-44Z_53356c299477).
 *
 * `consent()` used to call `provider.start()` and `api.createScan()` itself,
 * before `ScanScreen` — where a native preview would mount — had ever
 * rendered. That deadlocks a preview-owned ARCore session: `start()` has
 * nothing to attach a camera texture to yet. The fix is ordering, not a
 * timeout: `ScanScreen` always mounts its preview once `consent()` finishes,
 * and only the preview's own "I have a GL surface and a camera texture"
 * signal (the native `onPreviewReady` event, or an immediate synthetic one
 * for a provider with no native surface at all, e.g. the simulator) may
 * trigger this sequence. Camera access itself is still gated by consent:
 * this only ever runs after `consent()` has already dispatched `CONSENT`.
 *
 * Kept dependency-injected and framework-free so the ordering contract is
 * unit-testable without React Native, a renderer or a real native module.
 *
 * Audit R1A (review 2026-08-25T23-04-18Z_941258845708): the idempotency key
 * used to reach durable storage only via React's `useEffect([state])`, which
 * runs *after* `createScan` is already in flight and is best-effort (its
 * failure is swallowed). A process death between "request sent" and "effect
 * ran" left the server holding a committed scan with no local record of the
 * key that created it — a retry after restart would mint a new key and
 * create a duplicate/orphaned scan. `persistPendingCreate` closes that gap by
 * being a write-ahead barrier: it is awaited to completion before `createScan`
 * is ever called, and its rejection aborts the sequence — no network request
 * is sent for a key that was not first durably recorded.
 */

export interface CreatedScan {
  scanId: string;
  finalizeKey: string;
}

export interface PendingCreateKey {
  key: string;
  /** False when an existing in-flight key (e.g. from a prior retry) is being reused. */
  isNew: boolean;
}

export interface PreviewReadySequenceDeps {
  /** Starts the camera/AR session behind the now-mounted preview. */
  startProvider: () => Promise<void>;
  /** True if this scan already has an id — a retake reuses it, never a second scan. */
  hasExistingScan: () => boolean;
  /**
   * Returns the idempotency key for this logical createScan attempt: the
   * existing one if a prior attempt already minted it, otherwise a freshly
   * minted one. Pure/synchronous — no I/O.
   */
  resolveCreateKey: () => PendingCreateKey;
  /**
   * Synchronously records a newly minted key in in-memory state (e.g. a ref
   * and a reducer dispatch). Only called when `resolveCreateKey` returned
   * `isNew: true`. Never called for a reused key.
   */
  onKeyMinted: (key: string) => void;
  /**
   * Durably persists the pending-create record for `key` *before* the
   * network request it guards. Must be awaited; a rejection fails the whole
   * sequence closed — `createScan` is never reached — rather than risk an
   * unrecoverable orphaned scan on the server (audit R1A).
   */
  persistPendingCreate: (key: string) => Promise<void>;
  /** Creates the scan record. Only called when `hasExistingScan()` is false. */
  createScan: (key: string) => Promise<CreatedScan>;
}

/**
 * Runs once per preview-ready signal. Returns the newly created scan's ids,
 * or `null` when an existing scan was reused (nothing new to dispatch).
 *
 * `startProvider` always runs first and always runs, including on a retake:
 * the camera is stopped before `processing` (App.tsx) and has to be started
 * again for the next capture. `createScan` runs at most once per scan, and
 * only after its idempotency key has been durably persisted (audit R1A).
 */
export async function runPreviewReadySequence(
  deps: PreviewReadySequenceDeps,
): Promise<CreatedScan | null> {
  await deps.startProvider();
  if (deps.hasExistingScan()) return null;
  const { key, isNew } = deps.resolveCreateKey();
  if (isNew) {
    deps.onKeyMinted(key);
  }
  // Write-ahead barrier: durable storage of the pending-create record must
  // complete — and must succeed — before the createScan request it protects
  // is ever sent.
  await deps.persistPendingCreate(key);
  return await deps.createScan(key);
}
