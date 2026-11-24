/** Which providers a build offers; a missing config is «غير مُعد بعد», never a fake success. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { authConfigFromEnv } from './config.ts';
import { mockProvider } from './mockProvider.ts';

test('Google needs the web client id on Android and the iOS client id on iOS', () => {
  assert.equal(authConfigFromEnv({ googleWebClientId: 'web' }, 'android', false).google.configured, true);
  assert.equal(authConfigFromEnv({ googleWebClientId: 'web' }, 'ios', false).google.configured, false);
  assert.equal(authConfigFromEnv({ googleIosClientId: 'ios' }, 'ios', false).google.configured, true);
  assert.equal(authConfigFromEnv({ googleWebClientId: '   ' }, 'android', false).google.configured, false);
});

test('Apple on Android needs a Services ID and an https redirect on a real domain', () => {
  const ok = authConfigFromEnv({ appleServiceId: 'org.example.web', appleRedirectUri: 'https://example.org/cb' }, 'android', false);
  assert.equal(ok.apple.androidConfigured, true);
  for (const redirect of ['http://example.org/cb', 'https://localhost/cb', 'https://10.0.0.2/cb', 'not a url']) {
    assert.equal(
      authConfigFromEnv({ appleServiceId: 'org.example.web', appleRedirectUri: redirect }, 'android', false).apple.androidConfigured,
      false,
      redirect,
    );
  }
  assert.equal(authConfigFromEnv({ appleRedirectUri: 'https://example.org/cb' }, 'android', false).apple.androidConfigured, false);
});

test('mock sign-in needs the flag AND a non-release build', () => {
  assert.equal(authConfigFromEnv({ mockAuth: 'true' }, 'android', true).mockEnabled, true);
  assert.equal(authConfigFromEnv({ mockAuth: 'true' }, 'android', false).mockEnabled, false);
  assert.equal(authConfigFromEnv({ mockAuth: 'yes' }, 'android', true).mockEnabled, false);
  assert.equal(authConfigFromEnv({}, 'android', true).mockEnabled, false);
});

test('a disabled mock provider reports unconfigured and never yields a credential', async () => {
  const off = mockProvider(false, async () => 'dev-1');
  assert.equal(off.availability(), 'unconfigured');
  assert.deepEqual(await off.signIn({ getNonce: async () => 'n' }), { kind: 'error', reason: 'unconfigured' });
  const on = mockProvider(true, async () => 'dev-1');
  assert.deepEqual(await on.signIn({ getNonce: async () => 'n' }), {
    kind: 'credential',
    credential: { provider: 'mock', subject: 'dev-1' },
  });
});
