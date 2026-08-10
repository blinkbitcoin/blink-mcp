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

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return false;
}

function ipIsPrivate(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return ipv4IsPrivate(ip);
  if (type === 6) return ipv6IsPrivate(ip);
  return true; // not a recognizable IP → treat as unsafe
}

/**
 * Validate a URL for outbound L402 fetches. Throws SsrfError when the URL is
 * not HTTPS, malformed, resolves to a non-public address, or is not on the
 * host allowlist.
 *
 * The allowlist is MANDATORY (fail-closed on empty). Node's global fetch
 * re-resolves DNS at request time, so a pre-flight IP check alone is subject to
 * a DNS-rebinding TOCTOU. Constraining which hostnames may be contacted at all
 * removes the attacker's ability to point the server at arbitrary internal
 * hosts. The public-IP check is retained as defence-in-depth for allowlisted
 * hosts and is re-run for every redirect hop by the caller.
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

  const host = url.hostname.toLowerCase();

  if (allowlist.size === 0) {
    throw new SsrfError(
      "L402 server-side fetches require BLINK_L402_HOST_ALLOWLIST to be set (fail-closed). No hosts are allowed by default.",
    );
  }
  if (!allowlist.has(host)) {
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
