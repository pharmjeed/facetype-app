/**
 * The inliner is the reason the device bundle contains a usable address at all,
 * so it is tested against Babel rather than by reading the plugin source.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFromHere = createRequire(import.meta.url);
const babel = requireFromHere('@babel/core');
const plugin = requireFromHere('./inlineBuildEnv.js');

function transform(code: string, env: Record<string, string | undefined>): string {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return babel.transformSync(code, {
      babelrc: false,
      configFile: false,
      plugins: [plugin],
    }).code;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the API base URL becomes a literal instead of a runtime lookup', () => {
  const output = transform('const url = process.env.FACETYPE_API_URL;', {
    FACETYPE_API_URL: 'http://198.51.100.7:8000',
  });

  assert.match(output, /"http:\/\/198\.51\.100\.7:8000"/);
  assert.doesNotMatch(
    output,
    /process\.env/,
    'React Native only shims process.env.NODE_ENV, so any surviving lookup reads undefined on device',
  );
});

test('an unset variable inlines as undefined so the fail-closed path runs', () => {
  const output = transform('const url = process.env.FACETYPE_API_URL;', {
    FACETYPE_API_URL: undefined,
  });

  assert.match(output, /undefined/);
  assert.doesNotMatch(output, /process\.env/);
});

test('the allowlist is closed: unrelated build-machine variables are not baked in', () => {
  const output = transform('const secret = process.env.AWS_SECRET_ACCESS_KEY;', {
    AWS_SECRET_ACCESS_KEY: 'must-not-appear',
  });

  assert.doesNotMatch(output, /must-not-appear/);
  assert.match(output, /process\.env\.AWS_SECRET_ACCESS_KEY/);
});

test('only a real process.env member expression is rewritten', () => {
  const output = transform('const a = shell.env.FACETYPE_API_URL;', {
    FACETYPE_API_URL: 'http://198.51.100.7:8000',
  });

  assert.match(output, /shell\.env\.FACETYPE_API_URL/);
  assert.doesNotMatch(output, /198\.51\.100\.7/);
});

test('the cleartext opt-in is inlined too, or the policy could never be true', () => {
  const output = transform('const flag = process.env.FACETYPE_ALLOW_CLEARTEXT;', {
    FACETYPE_ALLOW_CLEARTEXT: '1',
  });

  assert.match(output, /"1"/);
});

test('the field-study flag and its configuration document are inlined together', () => {
  const config = '{"retention_days":30}';
  const output = transform(
    'const on = process.env.FACETYPE_FIELD_STUDY; const cfg = process.env.FACETYPE_FIELD_STUDY_CONFIG;',
    { FACETYPE_FIELD_STUDY: '1', FACETYPE_FIELD_STUDY_CONFIG: config },
  );

  assert.match(output, /"1"/);
  assert.match(output, /retention_days/);
  assert.doesNotMatch(output, /process\.env/);
});

test('the client sign-in configuration is inlined, and an unset provider stays undefined', () => {
  const output = transform(
    [
      'const g = process.env.FACETYPE_GOOGLE_WEB_CLIENT_ID;',
      'const gi = process.env.FACETYPE_GOOGLE_IOS_CLIENT_ID;',
      'const a = process.env.FACETYPE_APPLE_SERVICE_ID;',
      'const ar = process.env.FACETYPE_APPLE_REDIRECT_URI;',
      'const m = process.env.FACETYPE_CLIENT_MOCK_AUTH;',
      'const c = process.env.FACETYPE_CLIENT_SUPPORT_CONTACT;',
    ].join(' '),
    {
      FACETYPE_GOOGLE_WEB_CLIENT_ID: 'web-id.apps.googleusercontent.com',
      FACETYPE_GOOGLE_IOS_CLIENT_ID: undefined,
      FACETYPE_APPLE_SERVICE_ID: 'org.example.client.web',
      FACETYPE_APPLE_REDIRECT_URI: 'https://example.org/apple/callback',
      FACETYPE_CLIENT_MOCK_AUTH: 'true',
      FACETYPE_CLIENT_SUPPORT_CONTACT: undefined,
    },
  );

  assert.match(output, /"web-id\.apps\.googleusercontent\.com"/);
  assert.match(output, /const gi = undefined/);
  assert.match(output, /"org\.example\.client\.web"/);
  assert.match(output, /"https:\/\/example\.org\/apple\/callback"/);
  assert.match(output, /const m = "true"/);
  assert.match(output, /const c = undefined/);
  assert.doesNotMatch(output, /process\.env/);
});

test('a build that sets neither produces a bundle with no field study in it', () => {
  const output = transform(
    'const on = process.env.FACETYPE_FIELD_STUDY; const cfg = process.env.FACETYPE_FIELD_STUDY_CONFIG;',
    { FACETYPE_FIELD_STUDY: undefined, FACETYPE_FIELD_STUDY_CONFIG: undefined },
  );

  assert.match(output, /const on = undefined/);
  assert.match(output, /const cfg = undefined/);
});
