/**
 * Which sign-in providers this build can offer, decided from build-time env
 * (inlined by `babel/inlineBuildEnv.js`, so it is a property of the artifact).
 *
 *  - Google: `FACETYPE_GOOGLE_WEB_CLIENT_ID` (Android needs it to receive an ID
 *    token) and, on iOS, `FACETYPE_GOOGLE_IOS_CLIENT_ID`.
 *  - Apple: native on iOS (the bundle id is the client id); on Android the web
 *    flow needs `FACETYPE_APPLE_SERVICE_ID` + `FACETYPE_APPLE_REDIRECT_URI`
 *    (https, a real domain — Apple refuses IPs and localhost).
 *  - Mock: only when `FACETYPE_CLIENT_MOCK_AUTH=true` AND the build is not a
 *    release (a Metro dev bundle or an explicitly flagged cleartext preview
 *    build, the same test `api/endpoint.ts` uses). The server refuses
 *    `/auth/mock` in production as well; this is the client half.
 */

import { parseHttpUrl } from '../../api/url.ts';

export interface ClientBuildEnv {
  googleWebClientId?: string | null;
  googleIosClientId?: string | null;
  appleServiceId?: string | null;
  appleRedirectUri?: string | null;
  mockAuth?: string | null;
  supportContact?: string | null;
}

export interface AuthConfig {
  google: { configured: boolean; webClientId: string | null; iosClientId: string | null };
  apple: { androidConfigured: boolean; serviceId: string | null; redirectUri: string | null };
  mockEnabled: boolean;
  supportContact: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validRedirect(value: string | null): string | null {
  if (!value) return null;
  const parsed = parseHttpUrl(value);
  if (!parsed || parsed.protocol !== 'https:' || parsed.userinfo !== null) return null;
  if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(parsed.hostname)) return null;
  return value;
}

export function authConfigFromEnv(
  env: ClientBuildEnv,
  platform: 'ios' | 'android' | string,
  nonRelease: boolean,
): AuthConfig {
  const webClientId = clean(env.googleWebClientId);
  const iosClientId = clean(env.googleIosClientId);
  const serviceId = clean(env.appleServiceId);
  const redirectUri = validRedirect(clean(env.appleRedirectUri));
  const googleConfigured = platform === 'ios' ? iosClientId !== null : webClientId !== null;
  return {
    google: { configured: googleConfigured, webClientId, iosClientId },
    apple: {
      androidConfigured: serviceId !== null && redirectUri !== null,
      serviceId,
      redirectUri,
    },
    mockEnabled: nonRelease && (env.mockAuth === 'true' || env.mockAuth === '1'),
    supportContact: clean(env.supportContact),
  };
}
