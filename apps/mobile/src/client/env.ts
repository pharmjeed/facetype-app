/**
 * Build-time configuration of the client app.
 *
 * Every `process.env.FACETYPE_*` read below is rewritten to a string literal
 * (or `undefined`) at bundle time by `babel/inlineBuildEnv.js`, whose
 * allowlist is closed: adding a name here without adding it there leaves a
 * lookup that is always undefined on a device — the fail-closed direction.
 * None of these values is a secret: OAuth client ids, an Apple Services ID
 * and redirect URI, and a support address are all public by design.
 */

import type { ClientBuildEnv } from './auth/config.ts';

export const CLIENT_BUILD_ENV: ClientBuildEnv = {
  googleWebClientId: process.env.FACETYPE_GOOGLE_WEB_CLIENT_ID,
  googleIosClientId: process.env.FACETYPE_GOOGLE_IOS_CLIENT_ID,
  appleServiceId: process.env.FACETYPE_APPLE_SERVICE_ID,
  appleRedirectUri: process.env.FACETYPE_APPLE_REDIRECT_URI,
  mockAuth: process.env.FACETYPE_CLIENT_MOCK_AUTH,
  supportContact: process.env.FACETYPE_CLIENT_SUPPORT_CONTACT,
};
