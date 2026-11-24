/**
 * Regression cover for the device-reachability and cleartext defects.
 *
 * Before this module existed the shell read `process.env.FACETYPE_API_URL`,
 * which React Native's `process` shim never defines, so every build — release
 * included — silently used `http://localhost:8000`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiConfigurationError,
  LOOPBACK_API_URL,
  buildPolicy,
  resolveApiBaseUrl,
} from './endpoint.ts';

const DEV = { allowCleartext: true };
const SHIPPED = { allowCleartext: false };

test('a shipped build refuses to guess a backend when none was inlined', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.throws(
      () => resolveApiBaseUrl(missing, SHIPPED),
      (error: unknown) =>
        error instanceof ApiConfigurationError && error.code === 'API_URL_UNCONFIGURED',
      `${JSON.stringify(missing)} must fail closed, not fall back to loopback`,
    );
  }
});

test('a shipped build refuses cleartext even when a URL was inlined', () => {
  assert.throws(
    () => resolveApiBaseUrl('http://192.0.2.10:8000', SHIPPED),
    (error: unknown) => error instanceof ApiConfigurationError && error.code === 'API_URL_INSECURE',
  );
});

test('a shipped build accepts https', () => {
  assert.equal(resolveApiBaseUrl('https://api.facetype.ai', SHIPPED), 'https://api.facetype.ai');
});

test('a development build reaches a non-loopback address over plain HTTP', () => {
  // The address arrives from the bundler environment; nothing in the source
  // tree names a private network.
  assert.equal(resolveApiBaseUrl('http://192.0.2.10:8000', DEV), 'http://192.0.2.10:8000');
});

test('a development build with nothing configured still targets loopback', () => {
  assert.equal(resolveApiBaseUrl(undefined, DEV), LOOPBACK_API_URL);
});

test('trailing slashes are stripped so upload URL joining cannot double them', () => {
  assert.equal(resolveApiBaseUrl('https://api.facetype.ai///', SHIPPED), 'https://api.facetype.ai');
  assert.equal(
    resolveApiBaseUrl('https://api.facetype.ai/v2/', SHIPPED),
    'https://api.facetype.ai/v2',
  );
});

test('a relative or non-HTTP value is rejected rather than joined onto something', () => {
  for (const bad of ['/api', 'api.facetype.ai', 'ftp://api.facetype.ai', 'file:///etc/passwd']) {
    assert.throws(
      () => resolveApiBaseUrl(bad, DEV),
      (error: unknown) => error instanceof ApiConfigurationError && error.code === 'API_URL_INVALID',
      `${bad} must not be accepted as a base URL`,
    );
  }
});

test('credentials and query strings are rejected', () => {
  for (const bad of [
    'https://user:secret@api.facetype.ai',
    'https://api.facetype.ai?token=abc',
    'https://api.facetype.ai#fragment',
  ]) {
    assert.throws(
      () => resolveApiBaseUrl(bad, DEV),
      (error: unknown) => error instanceof ApiConfigurationError && error.code === 'API_URL_INVALID',
      `${bad} must not be accepted as a base URL`,
    );
  }
});

// Mirrored in tools/tests/test_build_android_apk.py
// (LOOPBACK_OR_UNSPECIFIED_HOSTS). Keep both lists in sync.
const LOOPBACK_OR_UNSPECIFIED_HOSTS = [
  'localhost',
  'localhost.',
  '127.0.0.1',
  '127.1',
  '127.0.1',
  '2130706433',
  '0.0.0.0',
  '0',
  '::1',
  '::',
  '0:0:0:0:0:0:0:1',
  '0:0:0:0:0:0:0:0',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
];

test('a shipped build refuses every spelling of a loopback backend, not just localhost:8000', () => {
  for (const host of LOOPBACK_OR_UNSPECIFIED_HOSTS) {
    const bracketed = host.includes(':') ? `[${host}]` : host;
    // http:// hits the pre-existing cleartext check first (API_URL_INSECURE);
    // https:// reaches the new loopback-alias check (API_URL_INVALID). Both
    // are ApiConfigurationError -- either way, a shipped build must refuse.
    for (const scheme of ['http', 'https']) {
      const url = `${scheme}://${bracketed}:8000`;
      assert.throws(
        () => resolveApiBaseUrl(url, SHIPPED),
        (error: unknown) => error instanceof ApiConfigurationError,
        `${url} must be refused as a loopback alias`,
      );
    }
  }
});

test('a development build is still allowed to point at a loopback alias', () => {
  assert.equal(resolveApiBaseUrl('http://127.1:8000', DEV), 'http://127.1:8000');
});

test('a non-loopback address that merely looks similar is not flagged', () => {
  assert.equal(resolveApiBaseUrl('https://128.0.0.1', SHIPPED), 'https://128.0.0.1');
});

test('cleartext is a build-time opt-in and is off by default', () => {
  assert.equal(buildPolicy(undefined, false).allowCleartext, false);
  assert.equal(buildPolicy('', false).allowCleartext, false);
  assert.equal(buildPolicy('0', false).allowCleartext, false);
  assert.equal(buildPolicy('yes', false).allowCleartext, false);

  assert.equal(buildPolicy('1', false).allowCleartext, true);
  assert.equal(buildPolicy('true', false).allowCleartext, true);
  // A Metro dev bundle needs no environment at all.
  assert.equal(buildPolicy(undefined, true).allowCleartext, true);
});

test('a device preview bundle is built with --dev false and still allows the LAN backend', () => {
  // The exact combination the install guide documents: __DEV__ is false because
  // the bundle is built for standalone use, so the opt-in flag is what carries
  // the cleartext decision.
  const policy = buildPolicy('1', false);
  assert.equal(resolveApiBaseUrl('http://198.51.100.7:8000', policy), 'http://198.51.100.7:8000');
});
