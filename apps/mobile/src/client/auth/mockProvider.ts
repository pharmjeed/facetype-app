/**
 * «دخول تجريبي» — development sign-in, never part of a release build.
 *
 * `enabled` comes from `authConfigFromEnv` (flag on AND non-release). The
 * subject is a stable per-install random id so a developer returns to the same
 * test account; it carries no personal data.
 */

import type { AuthProvider, ProviderAvailability, SignInOutcome } from './types.ts';

export function mockProvider(enabled: boolean, subject: () => Promise<string>): AuthProvider {
  return {
    id: 'mock',
    availability(): ProviderAvailability {
      return enabled ? 'ready' : 'unconfigured';
    },
    async signIn(): Promise<SignInOutcome> {
      if (!enabled) return { kind: 'error', reason: 'unconfigured' };
      return { kind: 'credential', credential: { provider: 'mock', subject: await subject() } };
    },
  };
}
