/**
 * Tests for L402 Producer Tools + Service Discovery (blink-mcp).
 *
 * Covers:
 *   - l402_challenge_create: macaroon generation, wallet resolution
 *   - l402_payment_verify: preimage/HMAC/caveat verification
 *   - l402_search: directory and 402index search
 *
 * Run: node --import tsx/esm --test test/l402_producer.test.ts
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// We test the exported functions directly from l402.ts
// For handleL402Tool tests, we mock the BlinkClient

const TEST_ROOT_KEY = Buffer.alloc(32, 0xab).toString("hex");

function makePaymentPair() {
  const preimage = crypto.randomBytes(32);
  const paymentHash = crypto
    .createHash("sha256")
    .update(preimage)
    .digest("hex");
  return { preimage: preimage.toString("hex"), paymentHash };
}

// ── l402_payment_verify via handleL402Tool ────────────────────────────────────

describe("l402_payment_verify", () => {
  let handleL402Tool: typeof import("../src/tools/l402.js").handleL402Tool;
  let origEnv: string | undefined;

  before(async () => {
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_L402_ROOT_KEY = TEST_ROOT_KEY;
    // Dynamic import to get fresh module with env set
    const mod = await import("../src/tools/l402.js");
    handleL402Tool = mod.handleL402Tool;
  });

  after(() => {
    if (origEnv !== undefined) process.env.BLINK_L402_ROOT_KEY = origEnv;
    else delete process.env.BLINK_L402_ROOT_KEY;
  });

  // Use a null client since verify doesn't need it
  const nullClient = {} as Parameters<typeof handleL402Tool>[0];

  it("returns error for missing token and macaroon", async () => {
    const result = (await handleL402Tool(nullClient, "l402_payment_verify", {
      preimage: "a".repeat(64),
    })) as Record<string, unknown>;
    assert.ok("error" in result);
  });

  it("returns error for invalid preimage format", async () => {
    const result = (await handleL402Tool(nullClient, "l402_payment_verify", {
      macaroon: "test",
      preimage: "tooshort",
    })) as Record<string, unknown>;
    assert.ok("error" in result);
    assert.ok((result.error as string).includes("64-character"));
  });

  it("returns error for token without colon", async () => {
    const result = (await handleL402Tool(nullClient, "l402_payment_verify", {
      token: "nocolon",
    })) as Record<string, unknown>;
    assert.ok("error" in result);
    assert.ok((result.error as string).includes("colon"));
  });

  it("returns valid=false for garbage macaroon with valid preimage format", async () => {
    const result = (await handleL402Tool(nullClient, "l402_payment_verify", {
      macaroon: "YQ",
      preimage: "0".repeat(64),
    })) as Record<string, unknown>;
    assert.equal(result.valid, false);
    assert.ok("error" in result);
  });
});

// ── l402_search via handleL402Tool ───────────────────────────────────────────

describe("l402_search", () => {
  let handleL402Tool: typeof import("../src/tools/l402.js").handleL402Tool;
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    origFetch = globalThis.fetch;
    const mod = await import("../src/tools/l402.js");
    handleL402Tool = mod.handleL402Tool;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const nullClient = {} as Parameters<typeof handleL402Tool>[0];

  it("searches l402.directory by default", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      assert.ok(urlStr.includes("l402.directory"));
      return {
        ok: true,
        json: async () => ({
          services: [
            { service_id: "abc", name: "Test", status: "live" },
          ],
        }),
      };
    }) as typeof fetch;

    const result = (await handleL402Tool(nullClient, "l402_search", {
      source: "directory",
      status: "live",
    })) as Record<string, unknown>;
    assert.equal(result.source, "l402.directory");
    assert.equal(result.count, 1);
  });

  it("searches 402index.io when source=402index", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      assert.ok(urlStr.includes("402index.io"));
      return {
        ok: true,
        json: async () => ({
          services: [
            {
              id: "uuid-1",
              name: "AI API",
              description: "LLM",
              price_sats: 10,
              health_status: "healthy",
            },
          ],
        }),
      };
    }) as typeof fetch;

    const result = (await handleL402Tool(nullClient, "l402_search", {
      source: "402index",
      status: "live",
    })) as Record<string, unknown>;
    assert.equal(result.source, "402index.io");
    assert.equal(result.count, 1);
  });

  it("filters 402index results by keyword", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        services: [
          { id: "1", name: "Video Streaming", description: "Watch", category: "video" },
          { id: "2", name: "Data API", description: "Get data", category: "data" },
        ],
      }),
    })) as typeof fetch;

    const result = (await handleL402Tool(nullClient, "l402_search", {
      query: "video",
      source: "402index",
      status: "live",
    })) as { count: number; services: Array<{ name: string }> };
    assert.equal(result.count, 1);
    assert.equal(result.services[0].name, "Video Streaming");
  });
});

// ── l402_challenge_create via handleL402Tool ──────────────────────────────────

describe("l402_challenge_create", () => {
  let handleL402Tool: typeof import("../src/tools/l402.js").handleL402Tool;
  let origEnv: string | undefined;

  before(async () => {
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_L402_ROOT_KEY = TEST_ROOT_KEY;
    const mod = await import("../src/tools/l402.js");
    handleL402Tool = mod.handleL402Tool;
  });

  after(() => {
    if (origEnv !== undefined) process.env.BLINK_L402_ROOT_KEY = origEnv;
    else delete process.env.BLINK_L402_ROOT_KEY;
  });

  it("creates a challenge with mocked client", async () => {
    const fakeHash = "a".repeat(64);
    const fakeInvoice = "lnbc100n1fakeinvoice";

    const mockClient = {
      getWallets: async () => ({
        me: {
          defaultAccount: {
            wallets: [
              { id: "btc-wallet-1", walletCurrency: "BTC", balance: 100000 },
            ],
          },
        },
      }),
      createLnInvoice: async () => ({
        lnInvoiceCreate: {
          invoice: {
            paymentRequest: fakeInvoice,
            paymentHash: fakeHash,
            satoshis: 100,
          },
          errors: [],
        },
      }),
    } as unknown as Parameters<typeof handleL402Tool>[0];

    const result = (await handleL402Tool(
      mockClient,
      "l402_challenge_create",
      { amount_sats: 100 },
    )) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.ok(typeof result.header === "string");
    assert.ok((result.header as string).startsWith("L402 macaroon="));
    assert.ok((result.header as string).includes(`invoice="${fakeInvoice}"`));
    assert.equal(result.paymentHash, fakeHash);
    assert.equal(result.satoshis, 100);
    assert.ok(typeof result.macaroon === "string");
  });

  it("includes expiry and resource when provided", async () => {
    const fakeHash = "b".repeat(64);
    const mockClient = {
      getWallets: async () => ({
        me: {
          defaultAccount: {
            wallets: [{ id: "w1", walletCurrency: "BTC" }],
          },
        },
      }),
      createLnInvoice: async () => ({
        lnInvoiceCreate: {
          invoice: {
            paymentRequest: "lnbc500n1fake",
            paymentHash: fakeHash,
            satoshis: 500,
          },
          errors: [],
        },
      }),
    } as unknown as Parameters<typeof handleL402Tool>[0];

    const result = (await handleL402Tool(
      mockClient,
      "l402_challenge_create",
      { amount_sats: 500, expiry_seconds: 3600, resource: "/api/data" },
    )) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.ok(typeof result.expiresAt === "number");
    assert.equal(result.resource, "/api/data");
  });
});
