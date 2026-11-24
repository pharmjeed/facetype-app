/**
 * HTTP URL parsing that works on a device.
 *
 * React Native replaces `globalThis.URL` with its own stub
 * (`react-native/Libraries/Blob/URL.js`, installed by `setUpXHR.js`). That stub
 * implements `toString()` and nothing else: every accessor this codebase needs
 * — `protocol`, `origin`, `pathname`, `search`, `hash`, `username`, `password`
 * — is a getter whose body is `throw new Error('URL.x is not implemented')`.
 *
 * Node has a real `URL`, so code written against it passes every unit test and
 * then throws on the first handset that runs it. That is not hypothetical: the
 * shipped bundle contains both `"URL.protocol is not implemented"` and
 * `"URL.origin is not implemented"`, and `resolveUploadUrl` read `.protocol` on
 * every upload.
 *
 * So: no `URL` here. Only the absolute-http subset the app actually needs, and
 * enough of RFC 3986 §5.3 reference resolution to join a relative signed upload
 * path onto the API origin.
 */

export interface ParsedUrl {
  /** Lowercased, including the colon: `'http:'` or `'https:'`. */
  protocol: 'http:' | 'https:';
  /** Anything before `@` in the authority, without the `@`. */
  userinfo: string | null;
  /** `hostname[:port]`, lowercased. */
  host: string;
  /** Just the host, without a bracketed IPv6 literal's brackets or the port. */
  hostname: string;
  /** `protocol//host`. */
  origin: string;
  /** Empty, or begins with `/`. */
  pathname: string;
  /** Empty, or begins with `?`. */
  search: string;
  /** Empty, or begins with `#`. */
  hash: string;
}

// scheme "://" [userinfo "@"] host [path] [query] [fragment]
const ABSOLUTE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;

const HOSTNAME_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isValidPort(port: string): boolean {
  if (port === '') return true;
  if (!/^\d+$/.test(port)) return false;
  return Number(port) <= 65535;
}

/** A DNS-style hostname (labels separated by dots, an optional trailing root
 * dot) or a bare IP literal. Does not itself decide whether the address is
 * usable -- `isLoopbackHost` does that. */
function isValidHostnameSyntax(hostname: string): boolean {
  if (hostname === '') return false;
  if (isIPv4Literal(hostname) || parseIPv6Groups(hostname) !== null) return true;
  const trimmed = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (trimmed === '') return false;
  return trimmed.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

/**
 * Split `hostname[:port]` into its parts, requiring RFC 3986 bracket
 * notation for an IPv6 literal so a bare `::1:8000` (ambiguous: is the last
 * group a port, or part of the address?) is rejected rather than silently
 * folded into one opaque host string.
 */
function splitHostPort(hostAndPort: string): { hostname: string; port: string } | null {
  if (hostAndPort.startsWith('[')) {
    const end = hostAndPort.indexOf(']');
    if (end === -1) return null;
    const hostname = hostAndPort.slice(1, end);
    if (!hostname) return null;
    const rest = hostAndPort.slice(end + 1);
    if (rest === '') return { hostname, port: '' };
    if (!rest.startsWith(':') || !isValidPort(rest.slice(1))) return null;
    return { hostname, port: rest.slice(1) };
  }
  if (hostAndPort.includes(':')) {
    const parts = hostAndPort.split(':');
    if (parts.length > 2) return null; // unbracketed IPv6, or garbage
    const [hostname, port] = parts;
    if (!hostname || !isValidPort(port!)) return null;
    return { hostname, port: port! };
  }
  return hostAndPort === '' ? null : { hostname: hostAndPort, port: '' };
}

/** Parse an absolute http(s) URL, or return null. No exceptions, no globals. */
export function parseHttpUrl(value: string): ParsedUrl | null {
  const match = ABSOLUTE.exec(value.trim());
  if (!match) return null;

  const protocol = `${match[1]!.toLowerCase()}:`;
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  const authority = match[2]!;
  // More than one unescaped '@' makes the userinfo/host split ambiguous
  // (`user@evil.example@real.example` reads as a host of `real.example` here
  // but some parsers disagree) -- reject rather than guess.
  if ((authority.match(/@/g) ?? []).length > 1) return null;
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? null : authority.slice(0, at);
  const hostAndPort = authority.slice(at + 1).toLowerCase();
  // `http://` with no authority at all is not a location.
  if (!hostAndPort) return null;

  const split = splitHostPort(hostAndPort);
  if (!split || !isValidHostnameSyntax(split.hostname)) return null;

  return {
    protocol,
    userinfo,
    host: hostAndPort,
    hostname: split.hostname,
    origin: `${protocol}//${hostAndPort}`,
    pathname: match[3] ?? '',
    search: match[4] ?? '',
    hash: match[5] ?? '',
  };
}

// ---------------------------------------------------------------------------
// Loopback-alias detection (mirrors tools/build_android_apk.py's
// `is_loopback_or_unspecified_host`; keep both in sync).
// ---------------------------------------------------------------------------

function isIPv4Literal(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * True for every historical dotted/decimal IPv4 spelling of loopback or "no
 * particular address" -- `127.1`, `127.0.1`, the 32-bit decimal form, and the
 * ordinary four-octet form.
 */
function ipv4ShortFormLoopbackOrUnspecified(host: string): boolean {
  if (!/^\d+(\.\d+){0,3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  let value: number;
  if (parts.length === 1) {
    value = parts[0]!;
  } else if (parts.length === 2) {
    if (parts[0]! > 0xff || parts[1]! > 0xffffff) return false;
    value = parts[0]! * 0x1000000 + parts[1]!;
  } else if (parts.length === 3) {
    if (parts[0]! > 0xff || parts[1]! > 0xff || parts[2]! > 0xffff) return false;
    value = parts[0]! * 0x1000000 + parts[1]! * 0x10000 + parts[2]!;
  } else {
    if (parts.some((part) => part > 0xff)) return false;
    value = parts[0]! * 0x1000000 + parts[1]! * 0x10000 + parts[2]! * 0x100 + parts[3]!;
  }
  if (!Number.isFinite(value) || value > 0xffffffff) return false;
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;
  const d = value & 0xff;
  return a === 127 || (a === 0 && b === 0 && c === 0 && d === 0);
}

/** Expand the last group of an IPv6 side into two hex groups if it is an
 * embedded IPv4 literal (`a.b.c.d`), otherwise return it unchanged. */
function expandTrailingIPv4(groups: string[]): string[] | null {
  if (groups.length === 0) return groups;
  const last = groups[groups.length - 1]!;
  if (!last.includes('.')) return groups;
  const octets = last.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
    return null;
  }
  const nums = octets.map(Number);
  const hi = ((nums[0]! << 8) | nums[1]!).toString(16);
  const lo = ((nums[2]! << 8) | nums[3]!).toString(16);
  return [...groups.slice(0, -1), hi, lo];
}

/** Expand a (possibly `::`-compressed, possibly IPv4-tailed) IPv6 literal
 * into its eight 16-bit groups, or return null if it does not parse. */
function parseIPv6Groups(host: string): number[] | null {
  const sides = host.split('::');
  if (sides.length > 2) return null; // more than one '::'
  const hasDouble = sides.length === 2;
  const HEX = /^[0-9a-f]{1,4}$/i;

  if (!hasDouble) {
    const groups = expandTrailingIPv4(sides[0] ? sides[0].split(':') : []);
    if (!groups || groups.length !== 8 || !groups.every((g) => HEX.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  }

  // With '::', an embedded IPv4 tail can only be the last group of the right
  // side (`::ffff:127.0.0.1`); the left side is always followed by '::'.
  const left = sides[0] ? sides[0].split(':') : [];
  const right = expandTrailingIPv4(sides[1] ? sides[1].split(':') : []);
  if (right === null) return null;
  if (!left.every((g) => HEX.test(g)) || !right.every((g) => HEX.test(g))) return null;
  const total = left.length + right.length;
  if (total > 8) return null;
  const middle: string[] = new Array(8 - total).fill('0');
  const all = [...left, ...middle, ...right];
  return all.map((g) => parseInt(g, 16));
}

function isIPv6LoopbackOrUnspecified(host: string): boolean {
  const groups = parseIPv6Groups(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every((v) => v === 0)) return groups[7] === 0 || groups[7] === 1;
  // IPv4-mapped: ::ffff:a.b.c.d -> groups[0..4] == 0, groups[5] == 0xffff.
  if (groups.slice(0, 5).every((v) => v === 0) && groups[5] === 0xffff) {
    const a = (groups[6]! >> 8) & 0xff;
    const b = groups[6]! & 0xff;
    const c = (groups[7]! >> 8) & 0xff;
    const d = groups[7]! & 0xff;
    return a === 127 || (a === 0 && b === 0 && c === 0 && d === 0);
  }
  return false;
}

/**
 * True for every spelling of "this device" or "no particular address" a
 * backend URL's hostname could take -- not just the exact strings `localhost`
 * and `127.0.0.1`. A build that inlines one of these as the API origin is
 * exactly the original defect: an app that can only ever reach itself.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!host) return false;
  if (host === 'localhost') return true;
  if (host.includes(':')) return isIPv6LoopbackOrUnspecified(host);
  return ipv4ShortFormLoopbackOrUnspecified(host);
}

/**
 * Resolve `reference` against `base`, following RFC 3986 §5.3 for the forms a
 * signed upload URL can take: absolute, protocol-relative, rooted, or relative.
 *
 * Returns null when `base` is not an absolute http(s) URL, so callers decide
 * how to fail rather than inheriting an exception from a polyfill.
 */
export function resolveAgainst(base: string, reference: string): string | null {
  const value = reference.trim();

  const absolute = parseHttpUrl(value);
  if (absolute) return value;
  // A scheme we do not serve (`ftp:`, `file:`, `javascript:`) must not be
  // silently treated as a relative path and joined onto the API origin.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;

  const parsedBase = parseHttpUrl(base);
  if (!parsedBase) return null;

  if (value.startsWith('//')) return `${parsedBase.protocol}${value}`;
  if (value.startsWith('/')) return `${parsedBase.origin}${value}`;
  if (value.startsWith('?')) return `${parsedBase.origin}${parsedBase.pathname}${value}`;
  if (value.startsWith('#')) {
    return `${parsedBase.origin}${parsedBase.pathname}${parsedBase.search}${value}`;
  }
  if (!value) return `${parsedBase.origin}${parsedBase.pathname}${parsedBase.search}`;

  // Relative: replace the last segment of the base path, per §5.3.
  const directory = parsedBase.pathname.slice(0, parsedBase.pathname.lastIndexOf('/') + 1);
  return `${parsedBase.origin}${directory || '/'}${value}`;
}
