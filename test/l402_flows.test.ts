/**
 * End-to-end tests for the l402_pay and l402_discover handlers with a stubbed
 * global fetch and a fake Blink client: SSRF re-validation on every request,
 * budget reservation around the payment, cached-token reuse, and both L402
 * challenge formats. No network or Blink API calls.
 */

import { describe, test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSecurityConfig } from "../src/security/config.ts";
import { SpendLedger } from "../src/security/ledger.ts";
import type { GuardContext } from "../src/security/guard.ts";

type L402Module = typeof import("../src/tools/l402.ts");
type Client = Parameters<L402Module["handleL402Tool"]>[0];

const INVOICE = "lnbc10u1pexampledata"; // 1000 sats
const PREIMAGE = "ab".repeat(32);
const ORIGIN = "https://8.8.8.8";

let mod: L402Module;
let tmpHome: string;
let origHomedir: typeof os.homedir;
let origFetch: typeof globalThis.fetch;
let origAllow: string | undefined;

before(async () => {
  // The token store path is fixed at module load from os.homedir(), so point
  // it at a temp dir before importing a fresh module instance.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "blink-l402-flows-"));
  origHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => tmpHome;
  mod = await import("../src/tools/l402.ts?flows");
  origFetch = globalThis.fetch;
  origAllow = process.env.BLINK_L402_HOST_ALLOWLIST;
});

after(() => {
  (os as unknown as { homedir: typeof os.homedir }).homedir = origHomedir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.BLINK_L402_HOST_ALLOWLIST = "8.8.8.8,1.1.1.1,127.0.0.1";
  mod.clearTokens();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origAllow === undefined) delete process.env.BLINK_L402_HOST_ALLOWLIST;
  else process.env.BLINK_L402_HOST_ALLOWLIST = origAllow;
});

interface Seen {
  method: string;
  url: string;
  auth: string | null;
}

/**
 * Route fetches by "METHOD url" (or "METHOD url auth" when an Authorization
 * header is present). HEAD defaults to 200 so canonicalisation is a no-op.
 */
function route(table: Record<string, () => Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ method, url, auth });
    const handler =
      (auth && table[`${method} ${url} auth`]) ||
      table[`${method} ${url}`] ||
      (method === "HEAD" ? () => new Response(null, { status: 200 }) : undefined);
    if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
    return handler();
  }) as typeof fetch;
  return seen;
}

const challenge402 = () =>
  new Response("", {
    status: 402,
    headers: { "www-authenticate": `L402 macaroon="mac123", invoice="${INVOICE}"` },
  });
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status });
const redirectTo = (location: string, status = 302) => () =>
  new Response(null, { status, headers: { location } });

function fakeClient(
  status = "SUCCESS",
  opts: { throws?: boolean; errors?: unknown[]; preImage?: string | null } = {},
) {
  const calls = { pay: 0 };
  const client = {
    payLnInvoice: async () => {
      calls.pay++;
      if (opts.throws) throw new Error("blink api down");
      return {
        lnInvoicePaymentSend: {
          status,
          errors: opts.errors ?? [],
          transaction:
            opts.preImage === null
              ? undefined
              : { settlementVia: { preImage: opts.preImage ?? PREIMAGE } },
        },
      };
    },
  } as unknown as Client;
  return { client, calls };
}

function guard(overrides: Partial<ReturnType<typeof loadSecurityConfig>> = {}): GuardContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-l402-ledger-"));
  return {
    config: { ...loadSecurityConfig({} as NodeJS.ProcessEnv), ...overrides },
    ledger: new SpendLedger(path.join(dir, "spend-ledger.json")),
  };
}

const payArgs = (extra: Record<string, unknown> = {}) => ({
  url: `${ORIGIN}/res`,
  wallet_id: "w1",
  dry_run: false,
  force: false,
  method: "GET",
  ...extra,
});

async function pay(client: Client, g?: GuardContext, extra: Record<string, unknown> = {}) {
  return (await mod.handleL402Tool(client, "l402_pay", payArgs(extra), g)) as Record<string, unknown>;
}

// ── l402_pay ──────────────────────────────────────────────────────────────

describe("l402_pay", () => {
  test("pays a Lightning Labs challenge, retries with the token, commits the budget", async () => {
    const seen = route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, { data: "paid content" }),
    });
    const { client, calls } = fakeClient();
    const g = guard({ dailyBudgetSats: 5000 });
    const r = await pay(client, g);
    assert.equal(r.success, true);
    assert.equal(r.event, "l402_paid");
    assert.equal(r.satoshis, 1000);
    assert.deepEqual(r.data, { data: "paid content" });
    assert.equal(calls.pay, 1);
    assert.equal(g.ledger.spentLast24h(), 1000);
    assert.equal(seen.at(-1)!.auth, `L402 mac123:${PREIMAGE}`);
    assert.ok(mod.getToken("8.8.8.8"));
  });

  test("reuses a cached token without paying", async () => {
    mod.saveToken("8.8.8.8", { macaroon: "m", preimage: "p", satoshis: 7 });
    route({ [`GET ${ORIGIN}/res auth`]: () => new Response("plain text", { status: 200 }) });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard());
    assert.equal(r.success, true);
    assert.equal(r.tokenReused, true);
    assert.equal(r.data, "plain text");
    assert.equal(calls.pay, 0);
  });

  test("a cached token rejected by the server is reported, not paid", async () => {
    mod.saveToken("8.8.8.8", { macaroon: "m", preimage: "p" });
    route({ [`GET ${ORIGIN}/res auth`]: json(401, { error: "expired" }) });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard());
    assert.equal(r.success, false);
    assert.equal(r.event, "l402_error");
    assert.equal(r.satoshis, null);
    assert.equal(calls.pay, 0);
  });

  test("a cached-token request redirected to an internal host is blocked", async () => {
    mod.saveToken("8.8.8.8", { macaroon: "m", preimage: "p" });
    const seen = route({ [`GET ${ORIGIN}/res auth`]: redirectTo("https://127.0.0.1/admin") });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.success, false);
    assert.match(String(r.error), /Blocked unsafe URL/);
    assert.ok(!seen.some((s) => s.url.includes("127.0.0.1")));
  });

  test("the initial request redirected to an internal host is blocked", async () => {
    const seen = route({ [`GET ${ORIGIN}/res`]: redirectTo("https://127.0.0.1/meta") });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard());
    assert.match(String(r.error), /Blocked unsafe URL/);
    assert.equal(calls.pay, 0);
    assert.ok(!seen.some((s) => s.url.includes("127.0.0.1")));
  });

  test("a network error on the initial request is reported", async () => {
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const r = await pay(fakeClient().client, guard());
    assert.match(String(r.error), /Request failed: ECONNRESET/);
  });

  test("a resource that answers 200 needs no payment", async () => {
    route({ [`GET ${ORIGIN}/res`]: json(200, { free: true }) });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.event, "l402_not_required");
    assert.deepEqual(r.data, { free: true });
  });

  test("a 200 with a non-JSON body is returned as text", async () => {
    route({ [`GET ${ORIGIN}/res`]: () => new Response("hello", { status: 200 }) });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.data, "hello");
  });

  test("an unexpected status is reported (and explained on dry runs)", async () => {
    route({ [`GET ${ORIGIN}/res`]: () => new Response("nope", { status: 500 }) });
    assert.match(String((await pay(fakeClient().client, guard())).error), /Unexpected status 500/);
    const dry = await pay(fakeClient().client, guard(), { dry_run: true });
    assert.equal(dry.event, "l402_dry_run");
    assert.match(String(dry.error), /nope/);
  });

  test("an unparseable 402 challenge is refused", async () => {
    route({ [`GET ${ORIGIN}/res`]: () => new Response("not json", { status: 402 }) });
    const r = await pay(fakeClient().client, guard());
    assert.match(String(r.error), /Could not parse L402 challenge/);
  });

  test("an l402-protocol challenge with no usable invoice is refused", async () => {
    route({
      [`GET ${ORIGIN}/res`]: json(402, { payment_request_url: `${ORIGIN}/pay` }),
      [`POST ${ORIGIN}/pay`]: json(500, {}),
    });
    const r = await pay(fakeClient().client, guard());
    assert.match(String(r.error), /Could not parse L402 challenge/);
  });

  test("pays an l402-protocol challenge fetched via POST", async () => {
    const seen = route({
      [`GET ${ORIGIN}/res`]: json(402, {
        version: "0.2",
        payment_request_url: `${ORIGIN}/pay`,
        offers: [{ id: "o1" }],
      }),
      [`POST ${ORIGIN}/pay`]: json(200, { payment_request: INVOICE, offer_id: "o1" }),
      [`GET ${ORIGIN}/res auth`]: json(200, { ok: 1 }),
    });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.success, true);
    assert.equal(r.format, "l402-protocol");
    assert.equal(seen.at(-1)!.auth, `L402 o1:${PREIMAGE}`);
  });

  test("l402-protocol invoice without offer id uses an empty macaroon", async () => {
    route({
      [`GET ${ORIGIN}/res`]: json(402, { payment_request_url: `${ORIGIN}/pay` }),
      [`POST ${ORIGIN}/pay`]: json(200, { invoice: INVOICE }),
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.success, true);
  });

  test("an l402-protocol body with offers but no payment URL is refused", async () => {
    route({ [`GET ${ORIGIN}/res`]: json(402, { offers: [] }) });
    const r = await pay(fakeClient().client, guard());
    assert.match(String(r.error), /Could not parse L402 challenge/);
  });

  test("dry run reports the price and pays nothing", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const { client, calls } = fakeClient();
    const g = guard();
    const r = await pay(client, g, { dry_run: true });
    assert.equal(r.event, "l402_dry_run");
    assert.equal(r.satoshis, 1000);
    assert.equal(r.withinBudget, true);
    assert.equal(calls.pay, 0);
    assert.equal(g.ledger.spentLast24h(), 0);
  });

  test("dry run on an undecodable invoice explains it would refuse", async () => {
    route({
      [`GET ${ORIGIN}/res`]: () =>
        new Response("", {
          status: 402,
          headers: { "www-authenticate": 'L402 macaroon="m", invoice="garbage"' },
        }),
    });
    const r = await pay(fakeClient().client, guard(), { dry_run: true });
    assert.equal(r.satoshis, null);
    assert.equal(r.withinBudget, null);
    assert.match(String(r.message), /REFUSE/);
  });

  test("dry run on an l402-protocol challenge includes the offers", async () => {
    route({
      [`GET ${ORIGIN}/res`]: json(402, { payment_request_url: `${ORIGIN}/pay`, offers: [{ id: "x" }] }),
      [`POST ${ORIGIN}/pay`]: json(200, { invoice: INVOICE }),
    });
    const r = await pay(fakeClient().client, guard(), { dry_run: true });
    assert.deepEqual(r.offers, [{ id: "x" }]);
  });

  test("an undecodable invoice is refused for real payments", async () => {
    route({
      [`GET ${ORIGIN}/res`]: () =>
        new Response("", {
          status: 402,
          headers: { "www-authenticate": 'L402 macaroon="m", invoice="garbage"' },
        }),
    });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard());
    assert.equal(r.event, "l402_amount_undecodable");
    assert.equal(calls.pay, 0);
  });

  test("an invoice above max_amount_sats is refused", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard(), { max_amount_sats: 999 });
    assert.equal(r.event, "l402_budget_exceeded");
    assert.equal(calls.pay, 0);
  });

  test("the shared per-tx cap applies to the decoded amount", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const { client, calls } = fakeClient();
    const r = await pay(client, guard({ maxPaymentSats: 500 }));
    assert.equal(r.event, "l402_budget_exceeded");
    assert.match(String(r.message), /BLINK_MAX_PAYMENT_SATS/);
    assert.equal(calls.pay, 0);
  });

  test("a reservation refused at payment time pays nothing", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const g = guard({ dailyBudgetSats: 5000 });
    // Simulate a concurrent spend landing between the cap check and the
    // payment: the budget check passes, the atomic reservation does not.
    (g.ledger as unknown as { reserve: () => unknown }).reserve = () => ({ ok: false, spent: 4500 });
    const { client, calls } = fakeClient();
    const r = await pay(client, g);
    assert.equal(r.event, "l402_budget_exceeded");
    assert.match(String(r.message), /already spent 4500/);
    assert.equal(calls.pay, 0);
  });

  test("a failed payment releases the reservation", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const g = guard({ dailyBudgetSats: 5000 });
    const r = await pay(fakeClient("FAILURE").client, g);
    assert.match(String(r.error), /status=FAILURE/);
    assert.equal(g.ledger.spentLast24h(), 0);
  });

  test("payment errors release the reservation", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const g = guard({ dailyBudgetSats: 5000 });
    const r = await pay(fakeClient("FAILURE", { errors: [{ message: "no route" }] }).client, g);
    assert.match(String(r.error), /Payment failed/);
    assert.equal(g.ledger.spentLast24h(), 0);
  });

  test("ALREADY_PAID proceeds without debiting the budget", async () => {
    route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    const g = guard({ dailyBudgetSats: 5000 });
    const r = await pay(fakeClient("ALREADY_PAID").client, g);
    assert.equal(r.success, true);
    assert.equal(g.ledger.spentLast24h(), 0);
  });

  test("a throwing payment call releases the reservation", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const g = guard({ dailyBudgetSats: 5000 });
    await assert.rejects(() => pay(fakeClient("SUCCESS", { throws: true }).client, g), /blink api down/);
    assert.equal(g.ledger.spentLast24h(), 0);
  });

  test("without a settlement preimage, one is derived from the invoice", async () => {
    const seen = route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    await pay(fakeClient("SUCCESS", { preImage: null }).client, guard());
    assert.match(String(seen.at(-1)!.auth), /^L402 mac123:[0-9a-f]{64}$/);
    assert.notEqual(seen.at(-1)!.auth, `L402 mac123:${PREIMAGE}`);
  });

  test("a non-200 retry is reported as unsuccessful", async () => {
    route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: () => new Response("try later", { status: 503 }),
    });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.success, false);
    assert.equal(r.retryStatus, 503);
    assert.equal(r.data, "try later");
  });

  test("a paid retry redirected to an internal host is blocked; the spend stays recorded", async () => {
    const seen = route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: redirectTo("https://127.0.0.1/steal"),
    });
    const g = guard({ dailyBudgetSats: 5000 });
    const r = await pay(fakeClient().client, g);
    assert.equal(r.success, false);
    assert.equal(r.event, "l402_paid_fetch_failed");
    assert.equal(r.paymentStatus, "SUCCESS");
    assert.equal(g.ledger.spentLast24h(), 1000);
    assert.ok(!seen.some((s) => s.url.includes("127.0.0.1")));
  });

  test("works without a guard context (no budget tracking)", async () => {
    route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    const r = await pay(fakeClient().client);
    assert.equal(r.success, true);
  });

  test("a token-store write failure does not fail a completed payment", async (t) => {
    route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    t.mock.method(fs, "writeFileSync", () => {
      throw new Error("EROFS");
    });
    const r = await pay(fakeClient().client); // no guard: the ledger would also hit the mock
    assert.equal(r.success, true);
  });

  test("force skips the token cache", async () => {
    mod.saveToken("8.8.8.8", { macaroon: "m", preimage: "p" });
    route({
      [`GET ${ORIGIN}/res`]: challenge402,
      [`GET ${ORIGIN}/res auth`]: json(200, {}),
    });
    const { client, calls } = fakeClient();
    await pay(client, guard(), { force: true });
    assert.equal(calls.pay, 1);
  });
});

// ── canonicalisation ──────────────────────────────────────────────────────

describe("resolveCanonicalUrl (via l402_pay)", () => {
  test("follows HEAD redirects and reports the canonical URL", async () => {
    route({
      [`HEAD ${ORIGIN}/res`]: redirectTo("https://1.1.1.1/res", 301),
      [`GET https://1.1.1.1/res`]: json(200, {}),
    });
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.canonicalUrl, "https://1.1.1.1/res");
  });

  test("a HEAD redirect to an internal host is blocked", async () => {
    route({ [`HEAD ${ORIGIN}/res`]: redirectTo("https://127.0.0.1/") });
    const r = await pay(fakeClient().client, guard());
    assert.match(String(r.error), /Blocked unsafe URL.*non-public/);
  });

  test("an endless HEAD redirect loop is refused", async () => {
    route({
      [`HEAD ${ORIGIN}/a`]: redirectTo(`${ORIGIN}/b`),
      [`HEAD ${ORIGIN}/b`]: redirectTo(`${ORIGIN}/a`),
    });
    const r = await pay(fakeClient().client, guard(), { url: `${ORIGIN}/a` });
    assert.match(String(r.error), /Too many redirects/);
  });

  test("a HEAD network error falls back to the original URL", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new Error("HEAD not allowed");
      assert.equal(input.toString(), `${ORIGIN}/res`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await pay(fakeClient().client, guard());
    assert.equal(r.event, "l402_not_required");
    assert.equal(r.canonicalUrl, undefined);
  });

  test("a URL off the allowlist is blocked before any request", async () => {
    const seen = route({});
    const r = await pay(fakeClient().client, guard(), { url: "https://evil.example/x" });
    assert.match(String(r.error), /Blocked unsafe URL/);
    assert.equal(seen.length, 0);
  });
});

// ── l402_discover ─────────────────────────────────────────────────────────

describe("l402_discover", () => {
  const discover = async (url = `${ORIGIN}/res`) =>
    (await mod.handleL402Tool({} as Client, "l402_discover", { url, method: "GET" })) as Record<
      string,
      unknown
    >;

  test("blocks a URL off the allowlist", async () => {
    route({});
    assert.match(String((await discover("https://evil.example/")).error), /Blocked unsafe URL/);
  });

  test("reports non-L402 resources and truncates long bodies", async () => {
    route({ [`GET ${ORIGIN}/res`]: () => new Response("x".repeat(600), { status: 200 }) });
    const r = await discover();
    assert.equal(r.l402_detected, false);
    assert.match(String(r.message), /No L402 protection/);
    assert.equal(String(r.body).length, 501);
    route({ [`GET ${ORIGIN}/res`]: () => new Response("short", { status: 404 }) });
    const r2 = await discover();
    assert.match(String(r2.message), /Unexpected status 404/);
    assert.equal(r2.body, "short");
  });

  test("detects a Lightning Labs challenge", async () => {
    route({ [`GET ${ORIGIN}/res`]: challenge402 });
    const r = await discover();
    assert.equal(r.format, "lightning-labs");
    assert.equal(r.satoshis, 1000);
    assert.equal(r.macaroon, "mac123");
  });

  test("detects an l402-protocol challenge and fetches its invoice", async () => {
    route({
      [`GET ${ORIGIN}/res`]: json(402, { payment_request_url: `${ORIGIN}/pay` }),
      [`POST ${ORIGIN}/pay`]: json(200, { invoice: INVOICE, offer_id: "o9" }),
    });
    const r = await discover();
    assert.equal(r.format, "l402-protocol");
    assert.equal(r.invoice, INVOICE);
    assert.equal(r.offerId, "o9");
    assert.equal(r.satoshisFormatted, "1000 sats");
  });

  test("an l402-protocol challenge without a payment URL has no invoice", async () => {
    route({ [`GET ${ORIGIN}/res`]: json(402, { offers: [{ id: 1 }] }) });
    const r = await discover();
    assert.equal(r.format, "l402-protocol");
    assert.equal(r.invoice, null);
    assert.equal(r.satoshisFormatted, null);
  });

  test("an unknown 402 format is reported as such", async () => {
    route({ [`GET ${ORIGIN}/res`]: () => new Response("<html>", { status: 402 }) });
    const r = await discover();
    assert.equal(r.format, "unknown");
    assert.equal(r.wwwAuthenticate, null);
  });

  test("a network error is reported", async () => {
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      throw new Error("ETIMEDOUT");
    }) as typeof fetch;
    assert.match(String((await discover()).error), /Request failed: ETIMEDOUT/);
  });
});
