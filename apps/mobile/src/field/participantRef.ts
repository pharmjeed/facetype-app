/**
 * The pseudonymous participant reference — recognised here, never minted here.
 *
 * WHAT CHANGED, AND WHY IT IS A DELETION RATHER THAN A FIX. This module used to
 * do two things: propose the next reference (`P-000001`, `P-000002`, …) and
 * validate one an operator typed. Both were defects dressed as features.
 *
 *  - A reference proposed on the handset is not unique to anything. Two devices
 *    collecting in the same room both offered `P-000001`, and the server — which
 *    had no field for the reference at all — could not tell the two participants
 *    apart, or find either one when a deletion request quoted the number they
 *    had been given. A cold restart re-proposed `P-000001` on the same device.
 *  - A text field an operator types a reference into is a text field an operator
 *    types a *name* into. The rejection rules were careful and they were still
 *    the wrong shape of defence: the strong version is not to ask.
 *
 * `POST /field-study/sessions/{id}/participants` now mints the reference. That
 * request carries no body at all, so there is nothing to type a name into, and
 * the reference is unique within the session because one authority allocates
 * it. What is left here is the guard on the way back: the one shape this app
 * will treat as a participant reference.
 *
 * THE GUARD IS NOT A FORMALITY. `isParticipantRef` is what stands between the
 * consent copy, the capture screen and the receipt on one side, and whatever a
 * response body actually contained on the other. Every name, email address and
 * phone number fails it, in every script, because the accepted alphabet is `P-`
 * plus six ASCII digits and contains nothing else. A reference that had to be
 * repaired to become opaque was not opaque, so nothing here repairs one.
 *
 * Framework-free: no React, no react-native, no network. Unit-tested directly.
 */

/** The one accepted shape. Opaque, fixed width, no free text of any kind. */
export const PARTICIPANT_REF_PATTERN = /^P-\d{6}$/;

/** True only for the exact shape the server allocates. */
export function isParticipantRef(value: unknown): value is string {
  return typeof value === 'string' && PARTICIPANT_REF_PATTERN.test(value);
}
