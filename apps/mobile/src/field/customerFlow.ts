/** Small, testable customer-facing gates kept outside the React component. */

export async function attachBeforeCamera<T>({
  attach,
  startCamera,
}: {
  attach: () => Promise<T>;
  startCamera: () => Promise<void>;
}): Promise<T> {
  const attached = await attach();
  await startCamera();
  return attached;
}

export async function recordDeclineBeforeRelease({
  recordDecline,
  release,
}: {
  recordDecline: () => Promise<void>;
  release: () => Promise<void>;
}): Promise<void> {
  await recordDecline();
  await release();
}
