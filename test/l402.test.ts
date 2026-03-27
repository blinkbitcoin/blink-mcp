/**
 * Tests for L402 consumer tools.
 *
 * Covers:
 *   - Tool schema validation (no network calls)
 *   - Pure helper functions: parseLightningLabsHeader, parseL402ProtocolBody,
 *     decodeBolt11AmountSats
 *   - Token store: saveToken, getToken, listTokens, clearTokens
 *     (uses a temp directory to avoid touching ~/.blink)
 *
 * Does NOT make real network calls or Blink API calls.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import {
  parseLightningLabsHeader,
  parseL402ProtocolBody,
  decodeBolt11AmountSats,
  saveToken,
  getToken,
  listTokens,
  clearTokens,
  l402Tools,
} from "../src/tools/l402.js";

// ── Token store tests (isolated to temp dir) ───────────────────────────────────

// We monkey-patch the STORE_FILE path by writing directly to a temp dir.
// Since l402.ts uses os.homedir() at module load, we override HOME.

let originalHome: string;
let tempHome: string;

before(() => {
  originalHome = os.homedir();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "blink-mcp-l402-test-"));
  // Override homedir for this test run
  // Node's os.homedir() reads HOME env var on Linux.
  process.env.HOME = tempHome;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ── Schema tests ──────────────────────────────────────────────────────────────

describe("l402 tool schemas", () => {
  test("l402_discover requires url", () => {
    const schema = l402Tools.l402_discover.inputSchema;
    assert.ok(!schema.safeParse({}).success, "Should fail without url");
    assert.ok(
      schema.safeParse({ url: "https://example.com" }).success,
      "Should succeed with url",
    );
  });

  test("l402_discover method defaults to GET", () => {
    const schema = l402Tools.l402_discover.inputSchema;
    const result = schema.safeParse({ url: "https://example.com" });
    assert.ok(result.success);
    assert.equal((result.data as { method: string }).method, "GET");
  });

  test("l402_discover rejects invalid method", () => {
    const schema = l402Tools.l402_discover.inputSchema;
    const result = schema.safeParse({
      url: "https://example.com",
      method: "PUT",
    });
    assert.ok(!result.success);
  });

  test("l402_pay requires url and wallet_id", () => {
    const schema = l402Tools.l402_pay.inputSchema;
    assert.ok(!schema.safeParse({}).success, "Empty should fail");
    assert.ok(
      !schema.safeParse({ url: "https://example.com" }).success,
      "Missing wallet_id should fail",
    );
    assert.ok(
      schema.safeParse({ url: "https://example.com", wallet_id: "abc123" })
        .success,
      "With both should succeed",
    );
  });

  test("l402_pay dry_run defaults to false", () => {
    const schema = l402Tools.l402_pay.inputSchema;
    const result = schema.safeParse({
      url: "https://example.com",
      wallet_id: "abc123",
    });
    assert.ok(result.success);
    assert.equal((result.data as { dry_run: boolean }).dry_run, false);
  });

  test("l402_pay force defaults to false", () => {
    const schema = l402Tools.l402_pay.inputSchema;
    const result = schema.safeParse({
      url: "https://example.com",
      wallet_id: "abc123",
    });
    assert.ok(result.success);
    assert.equal((result.data as { force: boolean }).force, false);
  });

  test("l402_store requires command", () => {
    const schema = l402Tools.l402_store.inputSchema;
    assert.ok(!schema.safeParse({}).success, "Should fail without command");
    assert.ok(
      schema.safeParse({ command: "list" }).success,
      "Should succeed with list",
    );
  });

  test("l402_store rejects unknown command", () => {
    const schema = l402Tools.l402_store.inputSchema;
    const result = schema.safeParse({ command: "delete" });
    assert.ok(!result.success);
  });

  test("l402_store expired_only defaults to false", () => {
    const schema = l402Tools.l402_store.inputSchema;
    const result = schema.safeParse({ command: "clear" });
    assert.ok(result.success);
    assert.equal(
      (result.data as { expired_only: boolean }).expired_only,
      false,
    );
  });

  test("all l402 tools have non-empty descriptions", () => {
    for (const [name, def] of Object.entries(l402Tools)) {
      assert.ok(
        typeof def.description === "string" &&
          def.description.trim().length > 0,
        `l402 tool "${name}" is missing a description`,
      );
    }
  });

  test("all l402 tools have ZodObject inputSchema", () => {
    for (const [name, def] of Object.entries(l402Tools)) {
      assert.ok(
        def.inputSchema instanceof z.ZodObject,
        `l402 tool "${name}" inputSchema must be z.object(...)`,
      );
    }
  });
});

// ── parseLightningLabsHeader ───────────────────────────────────────────────────

describe("parseLightningLabsHeader", () => {
  test("returns null for empty string", () => {
    assert.equal(parseLightningLabsHeader(""), null);
  });

  test("returns null for non-L402 header", () => {
    assert.equal(parseLightningLabsHeader('Bearer token="abc"'), null);
  });

  test("parses valid Lightning Labs header", () => {
    const header = 'L402 macaroon="abc123", invoice="lnbc500n1abc"';
    const result = parseLightningLabsHeader(header);
    assert.ok(result !== null);
    assert.equal(result!.macaroon, "abc123");
    assert.equal(result!.invoice, "lnbc500n1abc");
  });

  test("is case-insensitive on L402 prefix", () => {
    const header = 'l402 macaroon="abc", invoice="lnbc1"';
    const result = parseLightningLabsHeader(header);
    assert.ok(result !== null);
  });

  test("returns null if macaroon missing", () => {
    const header = 'L402 invoice="lnbc500n1abc"';
    assert.equal(parseLightningLabsHeader(header), null);
  });

  test("returns null if invoice missing", () => {
    const header = 'L402 macaroon="abc123"';
    assert.equal(parseLightningLabsHeader(header), null);
  });
});

// ── parseL402ProtocolBody ──────────────────────────────────────────────────────

describe("parseL402ProtocolBody", () => {
  test("returns null for null input", () => {
    assert.equal(parseL402ProtocolBody(null), null);
  });

  test("returns null for non-object", () => {
    assert.equal(parseL402ProtocolBody("string"), null);
  });

  test("returns null if neither payment_request_url nor offers present", () => {
    assert.equal(parseL402ProtocolBody({ version: "0.2" }), null);
  });

  test("parses valid l402-protocol body with payment_request_url", () => {
    const body = {
      version: "0.2.1",
      payment_request_url: "https://example.com/pay",
      offers: [{ title: "Basic", amount: 100, currency: "SAT" }],
    };
    const result = parseL402ProtocolBody(body);
    assert.ok(result !== null);
    assert.equal(result!.paymentRequestUrl, "https://example.com/pay");
    assert.equal(result!.version, "0.2.1");
    assert.equal(result!.offers.length, 1);
  });

  test("parses body with only offers array (no payment_request_url)", () => {
    const body = { offers: [{ title: "Pro" }] };
    const result = parseL402ProtocolBody(body);
    assert.ok(result !== null);
    assert.equal(result!.paymentRequestUrl, null);
  });
});

// ── decodeBolt11AmountSats ─────────────────────────────────────────────────────

describe("decodeBolt11AmountSats", () => {
  test("returns null for empty string", () => {
    assert.equal(decodeBolt11AmountSats(""), null);
  });

  test("returns null for non-invoice string", () => {
    assert.equal(decodeBolt11AmountSats("not-an-invoice"), null);
  });

  // 500n = 500 * 1e-9 BTC = 500 * 100 sats = 50000 msat = 50 sats
  // lnbc500n: 500 nano-BTC = 500 * 1e-9 * 1e8 = 50 sats
  test("decodes nano multiplier (n) — 500n = 50 sats", () => {
    // lnbc500n1... — 500 nano-BTC
    const invoice =
      "lnbc500n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztx";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 50);
  });

  // 1m = 1 milli-BTC = 0.001 * 1e8 = 100000 sats
  test("decodes milli multiplier (m) — 1m = 100000 sats", () => {
    const invoice = "lnbc1m1pvjluezpp5abc1";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 100_000);
  });

  // 1u = 1 micro-BTC = 0.000001 * 1e8 = 100 sats
  test("decodes micro multiplier (u) — 1u = 100 sats", () => {
    const invoice = "lnbc1u1pvjluezpp5abc1";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 100);
  });

  // No multiplier: 1 BTC = 1e8 sats
  test("decodes no multiplier — 1 = 1e8 sats", () => {
    const invoice = "lnbc11pvjluezpp5abc1";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 100_000_000);
  });

  test("handles testnet invoices (lntb)", () => {
    const invoice = "lntb500n1pvjluezabc1";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 50);
  });

  test("handles signet invoices (lntbs)", () => {
    const invoice = "lntbs500n1pvjluezabc1";
    const sats = decodeBolt11AmountSats(invoice);
    assert.equal(sats, 50);
  });
});

// ── Token store ───────────────────────────────────────────────────────────────
// Note: the store module uses os.homedir() at call time (not import time),
// so overriding HOME in before() is sufficient.

describe("token store", () => {
  test("getToken returns null for unknown domain", () => {
    assert.equal(getToken("unknown.example.com"), null);
  });

  test("saveToken and getToken round-trip", () => {
    saveToken("test.example.com", {
      macaroon: "mac123",
      preimage: "pre456",
      satoshis: 100,
    });
    const entry = getToken("test.example.com");
    assert.ok(entry !== null);
    assert.equal(entry!.macaroon, "mac123");
    assert.equal(entry!.preimage, "pre456");
    assert.equal(entry!.satoshis, 100);
  });

  test("listTokens includes saved domain", () => {
    saveToken("list.example.com", { macaroon: "m1", preimage: "p1" });
    const tokens = listTokens();
    const domains = tokens.map((t) => (t as { domain: string }).domain);
    assert.ok(domains.includes("list.example.com"));
  });

  test("listTokens masks preimage", () => {
    saveToken("mask.example.com", {
      macaroon: "longmacaroonvalue",
      preimage: "abcdef1234567890",
    });
    const tokens = listTokens();
    const entry = tokens.find(
      (t) => (t as { domain: string }).domain === "mask.example.com",
    ) as { preimage: string } | undefined;
    assert.ok(entry !== undefined);
    assert.ok(entry.preimage.includes("…"), "Preimage should be masked");
    assert.ok(
      !entry.preimage.includes("abcdef1234567890"),
      "Full preimage should not appear",
    );
  });

  test("getToken returns null for expired token", () => {
    saveToken("expired.example.com", {
      macaroon: "m",
      preimage: "p",
      expiresAt: Date.now() - 1000, // already expired
    });
    assert.equal(getToken("expired.example.com"), null);
  });

  test("getToken returns entry for non-expired token", () => {
    saveToken("valid.example.com", {
      macaroon: "m",
      preimage: "p",
      expiresAt: Date.now() + 60_000, // 1 min from now
    });
    const entry = getToken("valid.example.com");
    assert.ok(entry !== null);
  });

  test("clearTokens removes all tokens", () => {
    saveToken("clear1.example.com", { macaroon: "m", preimage: "p" });
    saveToken("clear2.example.com", { macaroon: "m", preimage: "p" });
    const removed = clearTokens();
    assert.ok(removed >= 2);
    assert.equal(listTokens().length, 0);
  });

  test("clearTokens with expiredOnly only removes expired", () => {
    saveToken("keep.example.com", {
      macaroon: "m",
      preimage: "p",
      expiresAt: Date.now() + 60_000,
    });
    saveToken("remove.example.com", {
      macaroon: "m",
      preimage: "p",
      expiresAt: Date.now() - 1000,
    });
    const removed = clearTokens({ expiredOnly: true });
    assert.equal(removed, 1);
    const tokens = listTokens();
    const domains = tokens.map((t) => (t as { domain: string }).domain);
    assert.ok(domains.includes("keep.example.com"));
    assert.ok(!domains.includes("remove.example.com"));
  });
});
