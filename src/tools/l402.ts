// L402 Consumer Tools
//
// Ported from blink-skills/blink/scripts/l402_discover.js, l402_pay.js, l402_store.js
// Key differences from the JS originals:
//   - TypeScript; uses BlinkClient.payLnInvoice() for payments
//   - Zod input validation; returns structured responses (no process.exit)
//   - Token store path: ~/.blink/l402-tokens.json (same as blink-skills for cross-tool compatibility)

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { BlinkClient } from "../client.js";

// ── Token store ───────────────────────────────────────────────────────────────

const STORE_DIR = path.join(os.homedir(), ".blink");
const STORE_FILE = path.join(STORE_DIR, "l402-tokens.json");

interface TokenEntry {
  macaroon: string;
  preimage: string;
  invoice?: string;
  satoshis?: number | null;
  expiresAt?: number;
  savedAt?: number;
}

function readStore(): Record<string, TokenEntry> {
  try {
    const content = fs.readFileSync(STORE_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, TokenEntry>): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    throw new Error(`Failed to write token store: ${(err as Error).message}`);
  }
}

export function saveToken(
  domain: string,
  tokenData: Omit<TokenEntry, "savedAt">,
): void {
  const store = readStore();
  store[domain] = { ...tokenData, savedAt: Date.now() };
  writeStore(store);
}

export function getToken(domain: string): TokenEntry | null {
  const store = readStore();
  const entry = store[domain];
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) return null;
  return entry;
}

export function listTokens(): object[] {
  const store = readStore();
  return Object.entries(store).map(([domain, entry]) => {
    const now = Date.now();
    const expired = entry.expiresAt ? now > entry.expiresAt : false;
    const expiresInMs = entry.expiresAt ? entry.expiresAt - now : null;
    return {
      domain,
      macaroon: entry.macaroon
        ? entry.macaroon.slice(0, 12) + "…" + entry.macaroon.slice(-6)
        : null,
      preimage: entry.preimage ? entry.preimage.slice(0, 8) + "…" : null,
      satoshis: entry.satoshis ?? null,
      savedAt: entry.savedAt ? new Date(entry.savedAt).toISOString() : null,
      expiresAt: entry.expiresAt
        ? new Date(entry.expiresAt).toISOString()
        : null,
      expired,
      expiresIn:
        !expired && expiresInMs !== null
          ? `${Math.round(expiresInMs / 1000)}s`
          : null,
    };
  });
}

export function clearTokens({
  expiredOnly = false,
}: { expiredOnly?: boolean } = {}): number {
  const store = readStore();
  const now = Date.now();
  let removed = 0;
  if (!expiredOnly) {
    removed = Object.keys(store).length;
    writeStore({});
    return removed;
  }
  for (const [domain, entry] of Object.entries(store)) {
    if (entry.expiresAt && now > entry.expiresAt) {
      delete store[domain];
      removed++;
    }
  }
  writeStore(store);
  return removed;
}

// ── L402 parsing helpers ──────────────────────────────────────────────────────

export function parseLightningLabsHeader(
  header: string,
): { macaroon: string; invoice: string } | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^l402\s/i.test(trimmed)) return null;
  const macaroonMatch = trimmed.match(/macaroon\s*=\s*"([^"]+)"/i);
  const invoiceMatch = trimmed.match(/invoice\s*=\s*"([^"]+)"/i);
  if (!macaroonMatch || !invoiceMatch) return null;
  return { macaroon: macaroonMatch[1], invoice: invoiceMatch[1] };
}

export function parseL402ProtocolBody(body: unknown): {
  paymentRequestUrl: string | null;
  version: string | null;
  offers: object[];
} | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!b.payment_request_url && !Array.isArray(b.offers)) return null;
  return {
    paymentRequestUrl: (b.payment_request_url as string) || null,
    version: (b.version as string) || null,
    offers: Array.isArray(b.offers) ? (b.offers as object[]) : [],
  };
}

export function decodeBolt11AmountSats(invoice: string): number | null {
  if (!invoice) return null;
  const lower = invoice.toLowerCase();
  let amountStr: string;
  if (lower.startsWith("lntbs")) amountStr = lower.slice(5);
  else if (lower.startsWith("lntb")) amountStr = lower.slice(4);
  else if (lower.startsWith("lnbc")) amountStr = lower.slice(4);
  else return null;

  const match = amountStr.match(/^(\d+)([munp]?)1/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const multiplier = match[2];
  if (isNaN(amount)) return null;

  const BTC_TO_SAT = 100_000_000;
  switch (multiplier) {
    case "":
      return amount * BTC_TO_SAT;
    case "m":
      return Math.round(amount * BTC_TO_SAT * 0.001);
    case "u":
      return Math.round(amount * BTC_TO_SAT * 0.000_001);
    case "n":
      return Math.round(amount * BTC_TO_SAT * 0.000_000_001);
    case "p":
      return Math.round(amount * BTC_TO_SAT * 0.000_000_000_001);
    default:
      return null;
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCanonicalUrl(
  url: string,
  timeoutMs = 10_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function fetchL402ProtocolInvoice(
  paymentRequestUrl: string,
  timeoutMs = 15_000,
): Promise<{ invoice: string; offerId: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(paymentRequestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const invoice = (data.invoice || data.payment_request || null) as
      | string
      | null;
    return invoice
      ? { invoice, offerId: (data.offer_id as string | null) || null }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface L402Challenge {
  invoice: string;
  macaroon: string;
  format: string;
  offerId?: string | null;
  paymentRequestUrl?: string;
  offers?: object[];
}

async function resolveL402Challenge(
  res: Response,
): Promise<L402Challenge | null> {
  const wwwAuth = res.headers.get("www-authenticate") || "";
  const lightningLabs = parseLightningLabsHeader(wwwAuth);
  if (lightningLabs) {
    return {
      invoice: lightningLabs.invoice,
      macaroon: lightningLabs.macaroon,
      format: "lightning-labs",
    };
  }

  let bodyJson: unknown = null;
  try {
    const text = await res.text();
    bodyJson = JSON.parse(text);
  } catch {
    return null;
  }

  const l402proto = parseL402ProtocolBody(bodyJson);
  if (!l402proto || !l402proto.paymentRequestUrl) return null;

  const fetched = await fetchL402ProtocolInvoice(l402proto.paymentRequestUrl);
  if (!fetched) return null;

  return {
    invoice: fetched.invoice,
    macaroon: fetched.offerId || "",
    format: "l402-protocol",
    offerId: fetched.offerId,
    paymentRequestUrl: l402proto.paymentRequestUrl,
    offers: l402proto.offers,
  };
}

function derivePreimageFromInvoice(invoice: string): string {
  return crypto.createHash("sha256").update(invoice).digest("hex");
}

// ── Macaroon crypto (L402 Producer) ───────────────────────────────────────────
// Port of blink-skills/blink/scripts/_l402_macaroon.js to TypeScript.
// HMAC-SHA256 macaroons with TLV caveats — zero external crypto deps.

const MACAROON_VERSION = 0x01;
const CAVEAT_TYPE_EXPIRY = 0x01;
const CAVEAT_TYPE_RESOURCE = 0x02;

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function encodeCaveats(
  caveats: Array<{ type: number; value: Buffer }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const c of caveats) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(c.value.length);
    parts.push(Buffer.from([c.type]), len, c.value);
  }
  return Buffer.concat(parts);
}

function decodeCaveats(
  buf: Buffer,
): Array<{ type: number; value: Buffer }> {
  const caveats: Array<{ type: number; value: Buffer }> = [];
  let offset = 0;
  while (offset < buf.length) {
    const type = buf[offset];
    const len = buf.readUInt16BE(offset + 1);
    const value = buf.subarray(offset + 3, offset + 3 + len);
    caveats.push({ type, value });
    offset += 3 + len;
  }
  return caveats;
}

function encodeExpiryValue(ts: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(ts));
  return buf;
}

function decodeExpiryValue(buf: Buffer): number {
  return Number(buf.readBigUInt64BE(0));
}

function createMacaroon(opts: {
  paymentHash: string;
  rootKey: Buffer;
  expirySeconds?: number | null;
  resource?: string | null;
}): string {
  if (!/^[0-9a-fA-F]{64}$/.test(opts.paymentHash)) {
    throw new Error("paymentHash must be a 64-character hex string");
  }
  if (!Buffer.isBuffer(opts.rootKey) || opts.rootKey.length !== 32) {
    throw new Error("rootKey must be a 32-byte Buffer");
  }

  const paymentHashBuf = Buffer.from(opts.paymentHash, "hex");
  const caveats: Array<{ type: number; value: Buffer }> = [];
  if (opts.expirySeconds != null) {
    caveats.push({
      type: CAVEAT_TYPE_EXPIRY,
      value: encodeExpiryValue(opts.expirySeconds),
    });
  }
  if (opts.resource) {
    caveats.push({
      type: CAVEAT_TYPE_RESOURCE,
      value: Buffer.from(opts.resource, "utf8"),
    });
  }

  const caveatsBuf = encodeCaveats(caveats);
  const body = Buffer.concat([
    Buffer.from([MACAROON_VERSION]),
    paymentHashBuf,
    caveatsBuf,
  ]);
  const sig = hmacSha256(opts.rootKey, body);
  return Buffer.concat([body, sig]).toString("base64url");
}

function decodeMacaroon(opts: {
  macaroon: string;
  rootKey: Buffer;
}): {
  signatureValid: boolean;
  paymentHash: string;
  expiresAt: number | null;
  resource: string | null;
} {
  const raw = Buffer.from(opts.macaroon, "base64url");
  if (raw.length < 1 + 32 + 32) {
    throw new Error("Macaroon too short to be valid.");
  }
  const version = raw[0];
  if (version !== MACAROON_VERSION) {
    throw new Error(`Unsupported macaroon version: ${version}`);
  }

  const paymentHash = raw.subarray(1, 33).toString("hex");
  const body = raw.subarray(0, raw.length - 32);
  const embeddedSig = raw.subarray(raw.length - 32);
  const expectedSig = hmacSha256(opts.rootKey, body);
  const signatureValid = crypto.timingSafeEqual(embeddedSig, expectedSig);

  const caveatsBuf = raw.subarray(33, raw.length - 32);
  const caveats = decodeCaveats(caveatsBuf);

  let expiresAt: number | null = null;
  let resource: string | null = null;
  for (const c of caveats) {
    if (c.type === CAVEAT_TYPE_EXPIRY) expiresAt = decodeExpiryValue(c.value);
    if (c.type === CAVEAT_TYPE_RESOURCE) resource = c.value.toString("utf8");
  }

  return { signatureValid, paymentHash, expiresAt, resource };
}

function verifyPreimage(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(preimage)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) return false;
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  return hash.toLowerCase() === paymentHash.toLowerCase();
}

function checkCaveats(opts: {
  expiresAt: number | null;
  resource: string | null;
  checkResource?: string | null;
  nowSeconds?: number;
}): { expired: boolean; resourceMismatch: boolean; caveatsValid: boolean } {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expired = opts.expiresAt !== null && now > opts.expiresAt;
  const resourceMismatch =
    opts.checkResource != null &&
    opts.resource !== null &&
    opts.resource !== opts.checkResource;
  return {
    expired,
    resourceMismatch,
    caveatsValid: !expired && !resourceMismatch,
  };
}

// ── Root key management ──────────────────────────────────────────────────────

const ROOT_KEY_FILE = path.join(os.homedir(), ".blink", "l402-root-key");

function getRootKey(): Buffer {
  // 1. Environment variable
  const envKey = process.env.BLINK_L402_ROOT_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error(
        "BLINK_L402_ROOT_KEY must be a 64-character hex string (32 bytes).",
      );
    }
    return Buffer.from(envKey, "hex");
  }

  // 2. File
  try {
    const hex = fs.readFileSync(ROOT_KEY_FILE, "utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return Buffer.from(hex, "hex");
    }
  } catch {
    // File doesn't exist — generate
  }

  // 3. Auto-generate
  const newKey = crypto.randomBytes(32);
  const dir = path.dirname(ROOT_KEY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROOT_KEY_FILE, newKey.toString("hex"), "utf8");
  fs.chmodSync(ROOT_KEY_FILE, 0o600);
  console.error(
    `Generated new L402 root key at ${ROOT_KEY_FILE}. Keep this file stable.`,
  );
  return newKey;
}

// ── Service discovery URLs ───────────────────────────────────────────────────

const DIRECTORY_URL = "https://l402.directory/api/services";
const INDEX_URL = "https://402index.io/api/v1/services";

// ── Tool definitions ──────────────────────────────────────────────────────────

export const l402Tools = {
  l402_discover: {
    description:
      "Probe a URL for L402 payment requirements without paying. " +
      "Returns the invoice, price in sats, and format (lightning-labs or l402-protocol). " +
      "Use this before l402_pay to check the cost of accessing a resource.",
    inputSchema: z.object({
      url: z
        .string()
        .describe("The URL to probe for L402 payment requirements"),
      method: z
        .enum(["GET", "POST"])
        .default("GET")
        .describe("HTTP method to use for the probe request"),
    }),
  },

  l402_pay: {
    description:
      "Access an L402-protected URL by automatically paying the Lightning invoice. " +
      "Checks the token cache first to avoid re-paying. " +
      "Returns the response data from the protected resource after successful payment.",
    inputSchema: z.object({
      url: z.string().describe("The URL to access (will pay L402 if required)"),
      wallet_id: z.string().describe("Blink BTC wallet ID to pay from"),
      max_amount_sats: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum amount in sats to pay (safety limit). Aborts if price exceeds this.",
        ),
      dry_run: z
        .boolean()
        .default(false)
        .describe("If true, discover the price without actually paying"),
      force: z
        .boolean()
        .default(false)
        .describe("If true, ignore cached tokens and pay again"),
      method: z
        .enum(["GET", "POST"])
        .default("GET")
        .describe("HTTP method for the resource request"),
    }),
  },

  l402_challenge_create: {
    description:
      "Create an L402 payment challenge (invoice + signed macaroon) to protect " +
      "a resource behind a Lightning paywall. Returns a WWW-Authenticate header " +
      "that can be sent to clients with HTTP 402.",
    inputSchema: z.object({
      amount_sats: z
        .number()
        .int()
        .positive()
        .describe("Invoice amount in satoshis"),
      wallet_id: z
        .string()
        .optional()
        .describe("Blink BTC wallet ID (auto-resolved if omitted)"),
      memo: z.string().optional().describe("Invoice memo / description"),
      expiry_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Macaroon expiry in seconds from now (e.g. 3600 = 1 hour)",
        ),
      resource: z
        .string()
        .optional()
        .describe(
          "Resource identifier caveat (e.g. /api/v1/data). Token will only be valid for this path.",
        ),
    }),
  },

  l402_payment_verify: {
    description:
      "Verify an L402 payment token submitted by a client. Checks three layers: " +
      "1) preimage proves payment (SHA-256), 2) HMAC signature proves authenticity, " +
      "3) caveats (expiry, resource) are satisfied. Returns valid: true/false.",
    inputSchema: z.object({
      token: z
        .string()
        .optional()
        .describe(
          "L402 token in <macaroon>:<preimage> format (colon-separated)",
        ),
      macaroon: z
        .string()
        .optional()
        .describe("base64url-encoded macaroon (alternative to token)"),
      preimage: z
        .string()
        .optional()
        .describe("64-char hex preimage (alternative to token)"),
      resource: z
        .string()
        .optional()
        .describe(
          "Expected resource identifier to check against the macaroon caveat",
        ),
    }),
  },

  l402_search: {
    description:
      "Search L402 service directories to find paid APIs that can be accessed " +
      "with Lightning payments. Default source: l402.directory (curated, rich schema). " +
      "Alternative: 402index.io (broader coverage, 50+ services).",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Keyword to search across names and descriptions"),
      source: z
        .enum(["directory", "402index"])
        .default("directory")
        .describe(
          '"directory" (l402.directory, default) or "402index" (402index.io)',
        ),
      category: z
        .string()
        .optional()
        .describe("Filter by category (e.g. video, data, ai)"),
      status: z
        .enum(["live", "all"])
        .default("live")
        .describe('"live" (default) or "all" (include offline)'),
    }),
  },

  l402_store: {
    description:
      "Manage the local L402 token cache at ~/.blink/l402-tokens.json. " +
      "List cached tokens (with masked sensitive data), get a token for a domain, or clear tokens.",
    inputSchema: z.object({
      command: z
        .enum(["list", "get", "clear"])
        .describe(
          "Operation: list all tokens, get token for a domain, or clear tokens",
        ),
      domain: z
        .string()
        .optional()
        .describe(
          'Domain (hostname) for the "get" command, e.g. "stock.l402.org"',
        ),
      expired_only: z
        .boolean()
        .default(false)
        .describe('For "clear": if true, only remove expired tokens'),
    }),
  },
};

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function handleL402Tool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "l402_discover": {
      const { url, method } = args as { url: string; method: string };

      const canonicalUrl = await resolveCanonicalUrl(url);

      let res: Response;
      try {
        res = await fetchWithTimeout(canonicalUrl, {
          method,
          headers: { Accept: "application/json" },
        });
      } catch (err) {
        return {
          success: false,
          error: `Request failed: ${(err as Error).message}`,
          url,
        };
      }

      if (res.status !== 402) {
        const body = await res.text().catch(() => "");
        return {
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          l402_detected: false,
          status: res.status,
          message:
            res.status === 200
              ? "No L402 protection detected — resource returned 200 OK."
              : `Unexpected status ${res.status}. Not an L402 endpoint.`,
          body: body.length <= 500 ? body : body.slice(0, 500) + "…",
        };
      }

      // Try Lightning Labs format
      const wwwAuth = res.headers.get("www-authenticate") || "";
      const lightningLabs = parseLightningLabsHeader(wwwAuth);
      if (lightningLabs) {
        const satoshis = decodeBolt11AmountSats(lightningLabs.invoice);
        return {
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          l402_detected: true,
          format: "lightning-labs",
          macaroon: lightningLabs.macaroon,
          invoice: lightningLabs.invoice,
          satoshis,
          satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
        };
      }

      // Try l402-protocol.org format
      let bodyJson: unknown = null;
      try {
        const bodyText = await res.text();
        bodyJson = JSON.parse(bodyText);
      } catch {
        // not JSON
      }

      const l402proto = parseL402ProtocolBody(bodyJson);
      if (l402proto) {
        let invoice: string | null = null;
        let offerId: string | null = null;
        if (l402proto.paymentRequestUrl) {
          const fetched = await fetchL402ProtocolInvoice(
            l402proto.paymentRequestUrl,
          );
          if (fetched) {
            invoice = fetched.invoice;
            offerId = fetched.offerId;
          }
        }
        const satoshis = invoice ? decodeBolt11AmountSats(invoice) : null;
        return {
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          l402_detected: true,
          format: "l402-protocol",
          version: l402proto.version,
          paymentRequestUrl: l402proto.paymentRequestUrl,
          offers: l402proto.offers,
          invoice,
          offerId,
          satoshis,
          satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
        };
      }

      // Unknown 402 format
      return {
        url,
        canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
        l402_detected: true,
        format: "unknown",
        wwwAuthenticate: wwwAuth || null,
        body: bodyJson,
        message:
          "Received 402 but could not identify Lightning Labs or l402-protocol format.",
      };
    }

    case "l402_pay": {
      const { url, wallet_id, max_amount_sats, dry_run, force, method } =
        args as {
          url: string;
          wallet_id: string;
          max_amount_sats?: number;
          dry_run: boolean;
          force: boolean;
          method: string;
        };

      const canonicalUrl = await resolveCanonicalUrl(url);
      const domain = extractDomain(canonicalUrl);

      // Check token cache first (skip on dry_run or force)
      if (!force && !dry_run) {
        const cached = getToken(domain);
        if (cached) {
          const authHeader = `L402 ${cached.macaroon}:${cached.preimage}`;
          const res = await fetchWithTimeout(canonicalUrl, {
            method,
            headers: { Accept: "application/json", Authorization: authHeader },
          });
          const body = await res.text();
          let data: unknown;
          try {
            data = JSON.parse(body);
          } catch {
            data = body;
          }

          if (res.status !== 200) {
            return {
              success: false,
              event: "l402_error",
              url,
              canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
              status: res.status,
              tokenReused: true,
              satoshis: cached.satoshis ?? null,
              message: `Cached token returned status ${res.status}. Token may be expired or server is unreachable.`,
              data,
            };
          }

          return {
            success: true,
            event: "l402_paid",
            url,
            canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
            status: res.status,
            tokenReused: true,
            satoshis: cached.satoshis ?? null,
            data,
          };
        }
      }

      // Initial request
      let initialRes: Response;
      try {
        initialRes = await fetchWithTimeout(canonicalUrl, {
          method,
          headers: { Accept: "application/json" },
        });
      } catch (err) {
        return {
          success: false,
          error: `Request failed: ${(err as Error).message}`,
          url,
        };
      }

      if (initialRes.status === 200) {
        const body = await initialRes.text();
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          data = body;
        }
        return {
          success: true,
          event: "l402_not_required",
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          status: 200,
          message: "Resource returned 200 OK — no payment required.",
          data,
        };
      }

      if (initialRes.status !== 402) {
        if (dry_run) {
          const body = await initialRes.text().catch(() => "");
          return {
            success: false,
            event: "l402_dry_run",
            url,
            canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
            status: initialRes.status,
            error: `Unexpected status ${initialRes.status}: ${body.slice(0, 200)}`,
            message:
              "Dry-run: server did not return 402. No payment would be made.",
          };
        }
        return {
          success: false,
          error: `Unexpected status ${initialRes.status}`,
          url,
        };
      }

      // Resolve L402 challenge
      const challenge = await resolveL402Challenge(initialRes);
      if (!challenge) {
        return {
          success: false,
          error:
            "Could not parse L402 challenge from 402 response. Use l402_discover for diagnostics.",
          url,
        };
      }

      const satoshis = decodeBolt11AmountSats(challenge.invoice);

      // Budget check
      if (
        max_amount_sats !== undefined &&
        satoshis !== null &&
        satoshis > max_amount_sats
      ) {
        return {
          success: false,
          event: "l402_budget_exceeded",
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          satoshis,
          maxAmount: max_amount_sats,
          message: `Payment of ${satoshis} sats exceeds max_amount_sats of ${max_amount_sats}. Aborting.`,
        };
      }

      // Dry run — report price, no payment
      if (dry_run) {
        return {
          success: true,
          event: "l402_dry_run",
          url,
          canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
          format: challenge.format,
          invoice: challenge.invoice,
          satoshis,
          satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
          maxAmount: max_amount_sats ?? null,
          withinBudget:
            max_amount_sats !== undefined && satoshis !== null
              ? satoshis <= max_amount_sats
              : null,
          message:
            "Dry-run: would pay this invoice to access the resource. No payment made.",
          ...(challenge.offers ? { offers: challenge.offers } : {}),
        };
      }

      // Pay the invoice
      const payResult = await client.payLnInvoice({
        walletId: wallet_id,
        paymentRequest: challenge.invoice,
      });

      const payResponse = payResult.lnInvoicePaymentSend;

      if (payResponse.errors && (payResponse.errors as unknown[]).length > 0) {
        return {
          success: false,
          error: `Payment failed: ${JSON.stringify(payResponse.errors)}`,
          url,
        };
      }

      if (
        payResponse.status !== "SUCCESS" &&
        payResponse.status !== "ALREADY_PAID"
      ) {
        return {
          success: false,
          error: `Payment not successful: status=${payResponse.status}`,
          url,
        };
      }

      // Extract preimage
      const tx = payResponse.transaction as Record<string, unknown> | undefined;
      const settlementVia = tx?.settlementVia as
        | Record<string, unknown>
        | undefined;
      let preimage = (settlementVia?.preImage as string) || null;

      if (!preimage) {
        // Fallback: derive from invoice (non-strict servers only)
        preimage = derivePreimageFromInvoice(challenge.invoice);
      }

      const macaroon = challenge.macaroon;

      // Cache the token
      try {
        saveToken(domain, {
          macaroon,
          preimage,
          invoice: challenge.invoice,
          satoshis: satoshis ?? null,
        });
      } catch {
        // non-fatal
      }

      // Retry with payment proof
      const authHeader = `L402 ${macaroon}:${preimage}`;
      const retryRes = await fetchWithTimeout(canonicalUrl, {
        method,
        headers: { Accept: "application/json", Authorization: authHeader },
      });

      const retryBody = await retryRes.text();
      let retryData: unknown;
      try {
        retryData = JSON.parse(retryBody);
      } catch {
        retryData = retryBody;
      }

      return {
        success: retryRes.status === 200,
        event: "l402_paid",
        url,
        canonicalUrl: canonicalUrl !== url ? canonicalUrl : undefined,
        format: challenge.format,
        paymentStatus: payResponse.status,
        walletId: wallet_id,
        satoshis: satoshis ?? null,
        tokenReused: false,
        retryStatus: retryRes.status,
        data: retryData,
      };
    }

    case "l402_challenge_create": {
      const { amount_sats, wallet_id, memo, expiry_seconds, resource } =
        args as {
          amount_sats: number;
          wallet_id?: string;
          memo?: string;
          expiry_seconds?: number;
          resource?: string;
        };

      // Resolve wallet ID
      let walletId = wallet_id;
      if (!walletId) {
        const walletsResult = await client.getWallets();
        const wallets = walletsResult.me.defaultAccount.wallets as Array<{
          id: string;
          walletCurrency: string;
        }>;
        const btcWallet = wallets.find((w) => w.walletCurrency === "BTC");
        if (!btcWallet) {
          return { success: false, error: "No BTC wallet found on this account." };
        }
        walletId = btcWallet.id;
      }

      // Create invoice
      const invoiceResult = await client.createLnInvoice({
        walletId,
        amount: amount_sats,
        memo: memo || `L402 challenge: ${amount_sats} sats`,
      });

      const inv = invoiceResult.lnInvoiceCreate;
      if (inv.errors && (inv.errors as unknown[]).length > 0) {
        return {
          success: false,
          error: `Invoice creation failed: ${JSON.stringify(inv.errors)}`,
        };
      }

      const invoice = inv.invoice as {
        paymentRequest: string;
        paymentHash: string;
        satoshis: number;
      };

      // Compute expiry timestamp
      const expiryTs = expiry_seconds
        ? Math.floor(Date.now() / 1000) + expiry_seconds
        : null;

      // Create signed macaroon
      const rootKey = getRootKey();
      const macaroon = createMacaroon({
        paymentHash: invoice.paymentHash,
        rootKey,
        expirySeconds: expiryTs,
        resource: resource || null,
      });

      // Build WWW-Authenticate header
      const header = `L402 macaroon="${macaroon}", invoice="${invoice.paymentRequest}"`;

      return {
        success: true,
        header,
        macaroon,
        invoice: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        satoshis: invoice.satoshis,
        expiresAt: expiryTs,
        resource: resource || null,
      };
    }

    case "l402_payment_verify": {
      const { token, macaroon: macArg, preimage: preArg, resource } =
        args as {
          token?: string;
          macaroon?: string;
          preimage?: string;
          resource?: string;
        };

      // Resolve macaroon and preimage
      let mac = macArg || null;
      let pre = preArg || null;
      if (token) {
        const colonIdx = token.indexOf(":");
        if (colonIdx === -1) {
          return {
            success: false,
            error:
              "token must be in <macaroon>:<preimage> format (colon-separated).",
          };
        }
        mac = token.slice(0, colonIdx);
        pre = token.slice(colonIdx + 1);
      }

      if (!mac) {
        return {
          success: false,
          error: "Provide token or both macaroon and preimage.",
        };
      }
      if (!pre) {
        return { success: false, error: "preimage is required." };
      }
      if (!/^[0-9a-fA-F]{64}$/.test(pre)) {
        return {
          success: false,
          error: `preimage must be a 64-character hex string (got ${pre.length} characters).`,
        };
      }

      // Decode and verify macaroon
      const rootKey = getRootKey();
      let decoded;
      try {
        decoded = decodeMacaroon({ macaroon: mac, rootKey });
      } catch (e) {
        return {
          valid: false,
          preimageValid: false,
          signatureValid: false,
          caveatsValid: false,
          paymentHash: null,
          resource: null,
          expiresAt: null,
          expired: false,
          error: (e as Error).message,
        };
      }

      const preimageValid = verifyPreimage(pre, decoded.paymentHash);
      const caveatResult = checkCaveats({
        expiresAt: decoded.expiresAt,
        resource: decoded.resource,
        checkResource: resource || null,
      });

      const valid =
        preimageValid && decoded.signatureValid && caveatResult.caveatsValid;

      return {
        valid,
        preimageValid,
        signatureValid: decoded.signatureValid,
        caveatsValid: caveatResult.caveatsValid,
        paymentHash: decoded.paymentHash,
        resource: decoded.resource,
        expiresAt: decoded.expiresAt,
        expired: caveatResult.expired,
        ...(caveatResult.resourceMismatch ? { resourceMismatch: true } : {}),
      };
    }

    case "l402_search": {
      const { query, source, category, status } = args as {
        query?: string;
        source: string;
        category?: string;
        status: string;
      };

      if (source === "402index") {
        // 402index.io
        const params = new URLSearchParams();
        params.set("protocol", "l402");
        if (status !== "all") params.set("health", "healthy");
        if (category) params.set("category", category);

        const res = await fetch(`${INDEX_URL}?${params}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          return {
            success: false,
            error: `402index.io returned HTTP ${res.status}`,
          };
        }
        const data = (await res.json()) as { services: Array<Record<string, unknown>> };
        let services = data.services || [];

        // Client-side keyword filter
        if (query) {
          const q = query.toLowerCase();
          services = services.filter(
            (s) =>
              (typeof s.name === "string" && s.name.toLowerCase().includes(q)) ||
              (typeof s.description === "string" && s.description.toLowerCase().includes(q)) ||
              (typeof s.category === "string" && s.category.toLowerCase().includes(q)),
          );
        }

        const normalized = services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          url: s.url,
          priceSats: s.price_sats,
          category: s.category,
          provider: s.provider,
          status: s.health_status,
          uptime30d: s.uptime_30d,
          latencyP50ms: s.latency_p50_ms,
          reliabilityScore: s.reliability_score,
        }));

        return {
          source: "402index.io",
          query: query || null,
          category: category || null,
          count: normalized.length,
          services: normalized,
        };
      }

      // l402.directory (default)
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (category) params.set("category", category);
      if (status === "all") params.set("status", "all");

      const res = await fetch(`${DIRECTORY_URL}?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return {
          success: false,
          error: `l402.directory returned HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as { services: unknown[] };

      return {
        source: "l402.directory",
        query: query || null,
        category: category || null,
        count: (data.services || []).length,
        services: data.services || [],
      };
    }

    case "l402_store": {
      const { command, domain, expired_only } = args as {
        command: string;
        domain?: string;
        expired_only: boolean;
      };

      if (command === "list") {
        const tokens = listTokens();
        return {
          storePath: STORE_FILE,
          count: tokens.length,
          tokens,
        };
      }

      if (command === "get") {
        if (!domain) {
          return {
            success: false,
            error: 'domain is required for the "get" command',
          };
        }
        const entry = getToken(domain);
        if (!entry) {
          return {
            domain,
            found: false,
            message: `No valid token found for domain: ${domain}`,
          };
        }
        return {
          domain,
          found: true,
          macaroon: entry.macaroon,
          preimage: entry.preimage,
          satoshis: entry.satoshis ?? null,
          savedAt: entry.savedAt ? new Date(entry.savedAt).toISOString() : null,
          expiresAt: entry.expiresAt
            ? new Date(entry.expiresAt).toISOString()
            : null,
        };
      }

      if (command === "clear") {
        const removed = clearTokens({ expiredOnly: expired_only });
        return {
          removed,
          message: expired_only
            ? `Removed ${removed} expired token(s).`
            : `Removed all ${removed} token(s).`,
        };
      }

      return {
        success: false,
        error: `Unknown command: ${command}. Use list, get, or clear.`,
      };
    }

    default:
      throw new Error(`Unknown L402 tool: ${toolName}`);
  }
}
