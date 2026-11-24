/**
 * Sign-in provider interface (docs/client-app-v1.md §2).
 *
 * A provider only obtains a credential from Google or Apple; exchanging it for
 * a FaceType session is the API client's job, and verifying it is the
 * server's. A provider that is not configured in this build reports
 * `unconfigured` and is drawn disabled with «غير مُعد بعد» — it never fakes a
 * success and never fails silently.
 */

export type ProviderId = 'apple' | 'google' | 'mock';

export type ProviderAvailability = 'ready' | 'unconfigured' | 'unsupported';

export type ProviderCredential =
  | { provider: 'google'; idToken: string }
  | { provider: 'apple'; identityToken: string; nonce: string; fullName: string | null }
  | { provider: 'mock'; subject: string };

export type SignInOutcome =
  | { kind: 'credential'; credential: ProviderCredential }
  | { kind: 'cancelled' }
  | { kind: 'error'; reason: 'unconfigured' | 'unsupported' | 'failed'; detail?: string };

export interface SignInContext {
  /** A one-time server nonce (POST /auth/nonce); Apple only. */
  getNonce(): Promise<string>;
}

export interface AuthProvider {
  readonly id: ProviderId;
  availability(): ProviderAvailability;
  signIn(context: SignInContext): Promise<SignInOutcome>;
  /** Forget the provider-side session (best effort). */
  signOut?(): Promise<void>;
}
