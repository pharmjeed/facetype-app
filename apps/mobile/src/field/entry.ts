/** A research-enabled update must not trap an operator in a restored scan or
 * silently open its camera. The saved scan and its credentials remain intact. */
export function needsResumeChoice(fieldEnabled: boolean, screen: string): boolean {
  return fieldEnabled && screen === 'scan';
}

export async function prepareFieldEntry(deps: {
  stopCamera: () => Promise<void>;
  hasToken: () => boolean;
  createSession: () => Promise<void>;
}): Promise<void> {
  await deps.stopCamera();
  // Replacing the token would orphan a resumable production scan. A field
  // participant still gets its own reference and consent after joining.
  if (!deps.hasToken()) await deps.createSession();
}
