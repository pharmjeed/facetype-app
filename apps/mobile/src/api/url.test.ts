/**
 * The device-versus-Node gap.
 *
 * Node ships a complete WHATWG `URL`. React Native replaces the global with a
 * stub whose accessors throw, so URL-based code passes every unit test and then
 * fails on the first handset. These tests install a stand-in for that stub while
 * they run, which is the only way a Node test can observe device behaviour.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiBaseUrl } from './endpoint.ts';
import { resolveUploadUrl } from './runtime.ts';
import { isLoopbackHost, parseHttpUrl, resolveAgainst } from './url.ts';

/**
 * React Native's `Libraries/Blob/URL.js`, reduced to the part that matters:
 * every accessor throws.
 */
class ReactNativeUrlStub {
  private readonly value: string;

  constructor(url: string, base?: string) {
    this.value = base === undefined ? url : `${base}${url}`;
  }

  get protocol(): string {
    throw new Error('URL.protocol is not implemented');
  }
  get origin(): string {
    throw new Error('URL.origin is not implemented');
  }
  get pathname(): string {
    throw new Error('URL.pathname not implemented');
  }
  get search(): string {
    throw new Error('URL.search is not implemented');
  }
  get hash(): string {
    throw new Error('URL.hash is not implemented');
  }
  get username(): string {
    throw new Error('URL.username is not implemented');
  }
  get password(): string {
    throw new Error('URL.password is not implemented');
  }
  toString(): string {
    return this.value;
  }
}

/**
 * The mobile tsconfig has no DOM lib, so `URL` is not a declared global here.
 * That is the point: device code must not reach for it.
 */
const globals = globalThis as unknown as { URL?: typeof ReactNativeUrlStub };

function onADevice<T>(body: () => T): T {
  const real = globals.URL;
  globals.URL = ReactNativeUrlStub;
  try {
    return body();
  } finally {
    globals.URL = real;
  }
}

test('the stand-in really does throw, or the tests below prove nothing', () => {
  onADevice(() => {
    const Installed = globals.URL!;
    assert.throws(() => new Installed('https://api.example').protocol, /not implemented/);
  });
});

test('resolving an upload URL works where React Native replaced the URL global', () => {
  onADevice(() => {
    assert.equal(
      resolveUploadUrl('/uploads/key', 'http://192.0.2.10:8000/api'),
      'http://192.0.2.10:8000/uploads/key',
    );
    const signed = 'https://objects.example/upload/key?signature=abc';
    assert.equal(resolveUploadUrl(signed, 'https://api.example/api'), signed);
  });
});

test('resolving the API base URL works where React Native replaced the URL global', () => {
  onADevice(() => {
    assert.equal(
      resolveApiBaseUrl('http://192.0.2.10:8000', { allowCleartext: true }),
      'http://192.0.2.10:8000',
    );
  });
});

test('an absolute http(s) URL is decomposed without the global', () => {
  const parsed = parseHttpUrl('HTTPS://API.Example.COM:8443/v2/scan?a=1#top');

  assert.ok(parsed);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, 'api.example.com:8443');
  assert.equal(parsed.origin, 'https://api.example.com:8443');
  assert.equal(parsed.pathname, '/v2/scan');
  assert.equal(parsed.search, '?a=1');
  assert.equal(parsed.hash, '#top');
  assert.equal(parsed.userinfo, null);
});

test('userinfo is separated rather than folded into the host', () => {
  const parsed = parseHttpUrl('https://user:secret@api.example/v2');

  assert.ok(parsed);
  assert.equal(parsed.userinfo, 'user:secret');
  assert.equal(parsed.host, 'api.example');
  assert.equal(parsed.origin, 'https://api.example');
});

test('non-http, relative and hostless inputs parse to null rather than throwing', () => {
  for (const bad of ['ftp://x/y', 'file:///etc/passwd', '/uploads/key', 'api.example', 'http://']) {
    assert.equal(parseHttpUrl(bad), null, `${bad} must not parse as an absolute http URL`);
  }
});

test('reference resolution covers the forms a signed upload URL takes', () => {
  const base = 'https://api.example/v2/scans/';

  assert.equal(resolveAgainst(base, 'https://objects.example/k'), 'https://objects.example/k');
  assert.equal(resolveAgainst(base, '//objects.example/k'), 'https://objects.example/k');
  assert.equal(resolveAgainst(base, '/uploads/k'), 'https://api.example/uploads/k');
  assert.equal(resolveAgainst(base, 'child'), 'https://api.example/v2/scans/child');
  assert.equal(
    resolveAgainst('https://api.example/v2/scans/item', 'sibling'),
    'https://api.example/v2/scans/sibling',
  );
});

test('a foreign scheme is refused instead of being joined onto the API origin', () => {
  const base = 'https://api.example/v2/';

  // Without the scheme guard these would become https://api.example/v2/file:...
  assert.equal(resolveAgainst(base, 'file:///etc/passwd'), null);
  assert.equal(resolveAgainst(base, 'javascript:alert(1)'), null);
  assert.equal(resolveAgainst('not-a-url', '/uploads/k'), null);
});

test('hostname is host without a bracketed IPv6 literal or the port', () => {
  assert.equal(parseHttpUrl('https://api.example.com:8443/v2')!.hostname, 'api.example.com');
  const withPort = parseHttpUrl('http://[::1]:8000/v2');
  assert.ok(withPort);
  assert.equal(withPort!.hostname, '::1');
  assert.equal(withPort!.host, '[::1]:8000');

  const withoutPort = parseHttpUrl('http://[::1]/v2');
  assert.ok(withoutPort);
  assert.equal(withoutPort!.hostname, '::1');
});

test('an ambiguous authority with two "@" is rejected rather than guessed', () => {
  assert.equal(parseHttpUrl('http://user@evil.example@api.example:8000'), null);
});

test('an unbracketed IPv6-shaped host is rejected rather than mis-split on a colon', () => {
  assert.equal(parseHttpUrl('http://::1:8000/v2'), null);
});

test('a malformed host (embedded whitespace) is rejected', () => {
  assert.equal(parseHttpUrl('http://exa mple.com:8000'), null);
});

test('an out-of-range port is rejected', () => {
  assert.equal(parseHttpUrl('http://api.example:99999'), null);
});

// Mirrored in tools/tests/test_build_android_apk.py
// (LOOPBACK_OR_UNSPECIFIED_HOSTS / NON_LOOPBACK_HOSTS). Keep both in sync.
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

const NON_LOOPBACK_HOSTS = ['192.168.1.4', 'api.facetype.ai', '10.0.0.5', 'example.com', '128.0.0.1', '::2'];

test('every documented loopback/unspecified alias is detected', () => {
  for (const host of LOOPBACK_OR_UNSPECIFIED_HOSTS) {
    assert.equal(isLoopbackHost(host), true, `${host} should be flagged as loopback/unspecified`);
  }
});

test('a non-loopback host is never flagged, even when it looks similar', () => {
  for (const host of NON_LOOPBACK_HOSTS) {
    assert.equal(isLoopbackHost(host), false, `${host} must not be flagged as loopback`);
  }
});
