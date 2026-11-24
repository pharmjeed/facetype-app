/**
 * Whether this build runs a field study at all.
 *
 * TWO CONDITIONS, BOTH REQUIRED.
 *
 *  1. `FACETYPE_FIELD_STUDY` is explicitly on. A research collection is not
 *     something an ordinary consumer build should be one tap away from, so it
 *     is a build-time decision inlined into the bundle (`babel/inlineBuildEnv.
 *     js`) rather than a runtime toggle a stray state change could flip.
 *  2. `FACETYPE_FIELD_STUDY_CONFIG` parses into a complete study configuration.
 *     The consent copy has to state a retention period, a custodian, an access
 *     restriction and a deletion route; a build that supplied none of those
 *     cannot obtain an informed consent, so it does not get to collect.
 *
 * The second condition is the interesting one. It would have been easier to
 * default the missing values and show the mode anyway — and the result would
 * have been an app telling participants a retention period nobody had decided
 * on. Off is the honest state.
 */

import { parseFieldStudyConfig, type FieldStudyConfig } from './config.ts';

/** Accepts the same spellings as the cleartext opt-in, and nothing else. */
function flagOn(flag: string | null | undefined): boolean {
  return flag === '1' || flag === 'true';
}

export function fieldStudyEnabled(
  flag: string | null | undefined,
  rawConfig: string | null | undefined,
): boolean {
  return flagOn(flag) && parseFieldStudyConfig(rawConfig) !== null;
}

/**
 * The configuration this build will run the study under, or `null`.
 *
 * One function rather than a flag plus a parse at each call site: the mode
 * being on and the configuration being present are the same fact, and two
 * places deciding it separately is how they come to disagree.
 */
export function fieldStudyConfig(
  flag: string | null | undefined,
  rawConfig: string | null | undefined,
): FieldStudyConfig | null {
  return flagOn(flag) ? parseFieldStudyConfig(rawConfig) : null;
}
