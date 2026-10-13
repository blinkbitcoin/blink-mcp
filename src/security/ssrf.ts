// SSRF containment for outbound fetches (L402 flows).
//
// L402 tools fetch attacker-influenced URLs server-side (redirects are
// followed, and a challenge-supplied payment_request_url is POSTed to). This
// module rejects non-HTTPS URLs and URLs that resolve to private, loopback,
// link-local, or otherwise non-public IP ranges before any request is made.

import dns from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// Non-public IPv4 ranges (RFC 6890 special-purpose + multicast/reserved).
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

// Non-public IPv6 ranges. Ranges that embed an IPv4 address (mapped, compat,
// NAT64, 6to4) are NOT listed here — they are unwrapped and the embedded IPv4
// is checked against V4_BLOCKED instead.
const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (embeds an obfuscated IPv4)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const blocked = new net.BlockList();
for (const [addr, prefix] of V4_BLOCKED) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of V6_BLOCKED) blocked.addSubnet(addr, prefix, "ipv6");

function ipv4IsPrivate(ip: string): boolean {
  if (!net.isIPv4(ip)) return true;
  return blocked.check(ip, "ipv4");
}

/** Expand an IPv6 address into its eight 16-bit groups, or null if invalid. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!net.isIPv6(addr)) return null;

  // Replace a trailing dotted IPv4 with two hex groups.
  const dotted = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    addr =
      dotted[1] +
      ((o[0] << 8) | o[1]).toString(16) +
      ":" +
      ((o[2] << 8) | o[3]).toString(16);
  }

  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, null];
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((h) => parseInt(h, 16));
  const headGroups = parse(head);
  if (tail === null) return headGroups.length === 8 ? headGroups : null;
  const tailGroups = parse(tail);
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 1) return null;
  return [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/**
 * Return the IPv4 address embedded in an IPv6 address that routes to (or is
 * translated into) IPv4, or null when there is none.
 */
function embeddedIpv4(g: number[]): string | null {
  const zero = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated)
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
    return v4FromGroups(g[6], g[7]);
  }
  // 64:ff9b::a.b.c.d (well-known NAT64 prefix)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) {
    return v4FromGroups(g[6], g[7]);
  }
  // 2002:aabb:ccdd::/48 (6to4)
  if (g[0] === 0x2002) {
    return v4FromGroups(g[1], g[2]);
  }
  return null;
}

function ipv6IsPrivate(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return true; // unparseable → unsafe
  const canonical = groups.map((x) => x.toString(16)).join(":");
  if (blocked.check(canonical, "ipv6")) return true;
  const v4 = embeddedIpv4(groups);
  if (v4 !== null) return ipv4IsPrivate(v4);
  return false;
}

export function ipIsPrivate(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return ipv4IsPrivate(ip);
  if (type === 6) return ipv6IsPrivate(ip);
  // Zone-scoped IPv6 (fe80::1%eth0) fails net.isIP; it is never public.
  if (ip.includes(":")) return ipv6IsPrivate(ip);
  return true; // not a recognizable IP → treat as unsafe
}

/**
 * Validate a URL for outbound L402 fetches. Throws SsrfError when the URL is
 * not HTTPS, malformed, resolves to a non-public address, or is not on the
 * host allowlist.
 *
 * The allowlist is MANDATORY (fail-closed on empty). Node's global fetch
 * re-resolves DNS at request time, so a pre-flight IP check alone is subject to
 * a DNS-rebinding TOCTOU. The allowlist narrows that exposure to hosts the
 * operator trusts — it does not eliminate it, since sockets are not pinned to
 * the checked address. The public-IP check is retained as defence-in-depth for
 * allowlisted hosts and is re-run for every redirect hop by safeFetch().
 */
export async function assertSafeUrl(
  rawUrl: string,
  allowlist: Set<string> = new Set(),
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:") {
    throw new SsrfError(
      `Refusing non-HTTPS L402 URL (${url.protocol}). Only https is allowed.`,
    );
  }

  // URL.hostname keeps IPv6 literals bracketed ("[::1]"); strip the brackets so
  // the literal is checked as an IP rather than handed to DNS.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");

  if (allowlist.size === 0) {
    throw new SsrfError(
      "L402 server-side fetches require BLINK_L402_HOST_ALLOWLIST to be set (fail-closed). No hosts are allowed by default.",
    );
  }
  if (!allowlist.has(host) && !allowlist.has(`[${host}]`)) {
    throw new SsrfError(`Host "${host}" is not in BLINK_L402_HOST_ALLOWLIST.`);
  }

  // If the host is already a literal IP, check it directly.
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) {
      throw new SsrfError(`Refusing L402 URL to non-public IP: ${host}`);
    }
    return;
  }

  // Resolve DNS and reject if ANY resolved address is private.
  let addresses: string[];
  try {
    const results = await dns.lookup(host, { all: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }

  if (addresses.length === 0) {
    throw new SsrfError(`Host resolved to no addresses: ${host}`);
  }
  for (const addr of addresses) {
    if (ipIsPrivate(addr)) {
      throw new SsrfError(
        `Refusing L402 URL: host ${host} resolves to non-public address ${addr}.`,
      );
    }
  }
}

const MAX_REDIRECT_HOPS = 5;

// Headers that carry credentials and must not follow a redirect to another origin.
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

export interface SafeFetchOptions {
  allowlist: Set<string>;
  timeoutMs?: number;
  maxHops?: number;
}

/**
 * fetch() for untrusted L402 endpoints. Redirects are followed manually so
 * every hop is re-validated with assertSafeUrl (HTTPS, host allowlist, public
 * address) before any request is sent to it. Credential headers are dropped
 * when a redirect changes origin, so an L402 token is never replayed to a host
 * it was not issued for. Throws SsrfError on an unsafe hop or too many hops.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  { allowlist, timeoutMs = 15_000, maxHops = MAX_REDIRECT_HOPS }: SafeFetchOptions,
): Promise<Response> {
  await assertSafeUrl(rawUrl, allowlist);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = rawUrl;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res;

      await res.body?.cancel().catch(() => {});
      if (hop >= maxHops) {
        throw new SsrfError(`Too many redirects (more than ${maxHops}) from ${rawUrl}.`);
      }

      const next = new URL(location, current).toString();
      await assertSafeUrl(next, allowlist);

      if (new URL(next).origin !== new URL(current).origin) {
        for (const h of CREDENTIAL_HEADERS) headers.delete(h);
      }
      // Per the Fetch spec: 303 always, and 301/302 on POST, become a bodyless
      // GET; 307/308 preserve method and body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      current = next;
    }
  } finally {
    clearTimeout(timer);
  }
}
