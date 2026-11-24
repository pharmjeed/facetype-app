/**
 * Inline a fixed allowlist of build-time variables into the device bundle.
 *
 * React Native's `process` shim exposes only `NODE_ENV`, and Metro inlines
 * nothing else for a bare (non-Expo) project. `process.env.FACETYPE_API_URL`
 * therefore survived into the shipped bundle as a lookup that was always
 * `undefined`, which is why every build fell through to its loopback default.
 *
 * The allowlist is closed on purpose. A blanket `process.env` inliner would
 * bake whatever happened to be exported on the build machine — tokens,
 * credentials, absolute paths — into an artifact that is handed to a device.
 *
 * Metro's transform cache does not key on the environment, so metro.config.js
 * folds the same values into `cacheVersion`. Changing FACETYPE_API_URL without
 * that would re-serve a cached bundle carrying the previous address.
 */

/** Every variable that may cross the bundle boundary. */
const INLINED = [
  'FACETYPE_API_URL',
  'FACETYPE_ALLOW_CLEARTEXT',
  // The field-study lane. Both are read at module scope in `src/App.tsx`, so
  // a build that does not set them produces a bundle in which the calibration
  // mode does not exist rather than one in which it is merely hidden.
  'FACETYPE_FIELD_STUDY',
  'FACETYPE_FIELD_STUDY_CONFIG',
  // The client app (src/client/env.ts). Public identifiers only — OAuth
  // client ids, the Apple Services ID and redirect URI, a support address —
  // never a secret: anything inlined here ships readable in the bundle. An
  // unset name inlines as `undefined`, which leaves that sign-in provider
  // shown disabled («غير مُعد بعد») rather than half-configured.
  'FACETYPE_GOOGLE_WEB_CLIENT_ID',
  'FACETYPE_GOOGLE_IOS_CLIENT_ID',
  'FACETYPE_APPLE_SERVICE_ID',
  'FACETYPE_APPLE_REDIRECT_URI',
  // Mock sign-in; honoured only in non-release builds (src/client/auth/config.ts).
  'FACETYPE_CLIENT_MOCK_AUTH',
  'FACETYPE_CLIENT_SUPPORT_CONTACT',
];

module.exports = function inlineBuildEnv({ types: t }) {
  return {
    name: 'facetype-inline-build-env',
    visitor: {
      MemberExpression(path) {
        const { node } = path;
        if (node.computed || !t.isIdentifier(node.property)) return;
        if (!INLINED.includes(node.property.name)) return;

        // Match `process.env.NAME` exactly; leave `foo.env.NAME` alone.
        const object = node.object;
        if (
          !t.isMemberExpression(object) ||
          object.computed ||
          !t.isIdentifier(object.object, { name: 'process' }) ||
          !t.isIdentifier(object.property, { name: 'env' })
        ) {
          return;
        }

        const value = process.env[node.property.name];
        path.replaceWith(
          value === undefined ? t.identifier('undefined') : t.stringLiteral(value),
        );
      },
    },
  };
};

module.exports.INLINED = INLINED;
