/**
 * The field study's *governance* parameters — and nothing the server can state
 * for itself.
 *
 * WHAT THIS FILE USED TO CARRY, AND WHY IT NO LONGER DOES. It used to supply
 * the consent policy version and two retention periods to the build. That was
 * wrong in a specific way: a number inlined into a bundle is a promise made on
 * a laptop, months before, about a deployment it has never contacted. The app
 * told participants a retention period, the server enforced its own, and
 * neither side could notice the disagreement. Those three values now come from
 * `GET /api/v1/field-study/policy`, narrowed to the joined session, and there
 * is no build-time fallback for them at all — see `policy.ts`.
 *
 * WHAT REMAINS IS WHAT THE API GENUINELY DOES NOT DEFINE. Who is accountable
 * for the collection, who may open the records, and where a participant goes to
 * ask for deletion. Those are ethics-approval facts about a particular study
 * rather than deployment configuration; the platform has no endpoint that
 * states them, and inventing one in the client would be the same mistake as the
 * retention period. So they stay build-supplied and required.
 *
 * FAIL-CLOSED. `parseFieldStudyConfig` returns `null` for anything it cannot
 * fully validate, and `null` disables field-study mode entirely rather than
 * showing consent copy with a blank custodian or an unnamed deletion route. An
 * uninformed consent is not a consent, so a build that did not supply this
 * cannot collect.
 */

export interface FieldStudyConfig {
  /** The named body accountable for the collection. */
  custodian: string;
  /** Who may open the collected records, in one plain clause. */
  accessRestriction: string;
  /**
   * The authorized operator a participant asks for deletion through.
   *
   * The route, not a promise about what happens at the end of it: the device
   * cannot erase a participant (that is `field_study:admin`, held by the
   * operator console), so the receipt tells the participant where to go and
   * which reference to quote rather than offering a button that would claim an
   * erasure the server never performed.
   */
  deletionContact: string;
}

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the build-supplied study governance document.
 *
 * Returns `null` — meaning "this build does not run a field study" — for an
 * absent, unparseable or incomplete document. There is no partial acceptance
 * and no default: every field below appears verbatim in the consent copy, so a
 * missing one is a sentence the app would otherwise have to invent.
 *
 * Unknown keys are ignored rather than refused, because the retention and
 * policy-version keys this document used to carry are now the server's and a
 * study configuration written for the previous build must not silently disable
 * the lane — it must keep working, with the deployment's own numbers.
 */
export function parseFieldStudyConfig(raw: string | null | undefined): FieldStudyConfig | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;

  const custodian = requiredString(source, 'custodian');
  const accessRestriction = requiredString(source, 'access_restriction');
  const deletionContact = requiredString(source, 'deletion_contact');

  if (custodian === null || accessRestriction === null || deletionContact === null) {
    return null;
  }

  return { custodian, accessRestriction, deletionContact };
}
