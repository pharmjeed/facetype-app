/**
 * What a press on the field consent screen is allowed to mean.
 *
 * WHY THIS IS A MODULE AND NOT THREE INLINE CONDITIONS. The screen carries a
 * single affirmative action — the participant agrees and the capture starts in
 * one press — so the conditions that used to be spread across a required
 * checkbox, a disabled flag and a hint line are now the whole gate. A gate that
 * only exists inside a component can only be checked by rendering one, and the
 * thing being checked is whether a photograph of somebody's face may be asked
 * for.
 *
 * WHAT IT DOES NOT DECIDE. Nothing here records a consent, opens a camera or
 * speaks to the server: the container still makes both consent calls and only
 * then mounts the capture screen. These functions answer "is this press a
 * legitimate action, and what did the participant actually grant" and stop.
 *
 * THE PHOTOGRAPH GRANT IS NEVER IMPLIED. `photoGranted` is `true` only when the
 * deployment offers photographs at all *and* the participant ticked the
 * separate box. Pressing the affirmative button never turns it on, and a change
 * of participant reference turns it off, so the next person cannot inherit the
 * previous person's answer.
 *
 * Framework-free, no imports, unit-tested directly.
 */

export interface ConsentActionState {
  /** The server-allocated reference, or `null` before it has been asked for. */
  participantRef: string | null;
  /** A request is in flight; every consent action is closed while it is. */
  busy: boolean;
  /** Whether this deployment may ask the photograph question at all. */
  photosOfferable: boolean;
  /** The separate photograph opt-in, as currently ticked. */
  photoOptIn: boolean;
}

export type StartDecision =
  | { start: false; reason: 'NO_PARTICIPANT_REF' | 'BUSY' }
  | { start: true; photoGranted: boolean };

/**
 * Whether any consent control on the screen may be operated.
 *
 * Two gates. Without a server-allocated reference there is nothing to record a
 * consent against, and while a call is in flight a second press would record a
 * second consent for the same person.
 */
export function consentActionsEnabled(state: ConsentActionState): boolean {
  return (
    typeof state.participantRef === 'string' &&
    state.participantRef.length > 0 &&
    state.busy !== true
  );
}

/**
 * What the affirmative button's press means, including when it means nothing.
 *
 * The refusals are named rather than folded into a bare `false` so a caller —
 * and a test — can tell "nobody has been allocated yet" from "the previous
 * press is still in flight". Both leave the camera closed.
 */
export function resolveStartAction(state: ConsentActionState): StartDecision {
  if (typeof state.participantRef !== 'string' || state.participantRef.length === 0) {
    return { start: false, reason: 'NO_PARTICIPANT_REF' };
  }
  if (state.busy === true) return { start: false, reason: 'BUSY' };
  return {
    start: true,
    photoGranted: state.photosOfferable === true && state.photoOptIn === true,
  };
}

/**
 * The photograph opt-in after a toggle, which is a request and not a result.
 *
 * A deployment that retains no photograph cannot have the box ticked even if
 * something asks for it, and a toggle arriving while a consent is being
 * recorded is dropped rather than applied to a consent already on its way.
 */
export function resolvePhotoOptIn(state: ConsentActionState, requested: boolean): boolean {
  if (!consentActionsEnabled(state)) {
    return state.photosOfferable === true && state.photoOptIn === true;
  }
  if (state.photosOfferable !== true) return false;
  return requested === true;
}

/**
 * The photograph opt-in to carry when the participant reference changes.
 *
 * The container remounts this screen between participants, which clears the
 * answer by construction; this states the same guarantee where the state lives,
 * so a future caller that reuses the screen without remounting it still cannot
 * hand the next participant the previous one's tick.
 */
export function photoOptInForParticipant(
  previousRef: string | null,
  nextRef: string | null,
  current: boolean,
): boolean {
  if (previousRef !== nextRef) return false;
  return current === true;
}
