// SSRF containment: private-range classification and per-hop redirect
// validation for every outbound L402 request. Uses literal public IPs in the
// allowlist and a stubbed global fetch, so no network or DNS is touched.

import { describe, test, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

import { ipIsPrivate, safeFetch, assertSafeUrl, SsrfError } from "../src/security/ssrf.ts";

// ── ipIsPrivate ───────────────────────────────────────────────────────────

describe("ipIsPrivate", () => {
  const privateIps = [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "198.18.0.1",
    "192.0.2.10",
    "203.0.113.5",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1", // IPv4-mapped, dotted
    "::ffff:7f00:1", // IPv4-mapped, hex
    "::7f00:1", // IPv4-compatible
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    "64:ff9b:1::1", // local-use NAT64
    "2002:7f00:1::", // 6to4 → 127.0.0.1
    "fe80::1",
    "fe90::1", // still inside fe80::/10
    "febf::1",
    "fec0::1", // site-local
    "fd12:3456::1", // ULA
    "ff02::1", // multicast
    "2001:db8::1", // documentation
    "fe80::1%eth0", // zone-scoped
    "not-an-ip",
  ];
  for (const ip of privateIps) {
    test(`${ip} is non-public`, () => assert.equal(ipIsPrivate(ip), true));
  }

  const publicIps = ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"];
  for (const ip of publicIps) {
    test(`${ip} is public`, () => assert.equal(ipIsPrivate(ip), false));
  }
});

describe("assertSafeUrl IPv6 literals", () => {
  test("rejects a bracketed loopback literal without DNS", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://[::1]/x", new Set(["[::1]"])),
      /non-public IP/,
    );
  });

  test("rejects a bracketed IPv4-mapped hex literal", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://[::ffff:7f00:1]/x", new Set(["::ffff:7f00:1"])),
      SsrfError,
    );
  });
});

// ── safeFetch ─────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

function stubFetch(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect,
    });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch to ${url}`);
    return route();
  }) as typeof fetch;
  return calls;
}

const redirect = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });
const ok = (body = "ok") => () => new Response(body, { status: 200 });

const ALLOW = new Set(["8.8.8.8", "1.1.1.1"]);

describe("safeFetch", () => {
  let origFetch: typeof globalThis.fetch;
  before(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("never lets fetch follow redirects itself", async () => {
    const calls = stubFetch({ "https://8.8.8.8/r": ok() });
    await safeFetch("https://8.8.8.8/r", {}, { allowlist: ALLOW });
    assert.equal(calls[0].redirect, "manual");
  });

  test("rejects a redirect to a loopback address before requesting it", async () => {
    const calls = stubFetch({
      "https://8.8.8.8/r": redirect(302, "https://127.0.0.1/admin"),
    });
    await assert.rejects(
      () => safeFetch("https://8.8.8.8/r", {}, { allowlist: new Set([...ALLOW, "127.0.0.1"]) }),
      SsrfError,
    );
    assert.equal(calls.length, 1);
  });

  test("rejects a redirect to a non-allowlisted host", async () => {
    const calls = stubFetch({
      "https://8.8.8.8/r": redirect(302, "https://evil.example/x"),
    });
    await assert.rejects(() => safeFetch("https://8.8.8.8/r", {}, { allowlist: ALLOW }), /not in BLINK_L402_HOST_ALLOWLIST/);
    assert.equal(calls.length, 1);
  });

  test("rejects a redirect downgrade to http", async () => {
    stubFetch({ "https://8.8.8.8/r": redirect(301, "http://8.8.8.8/x") });
    await assert.rejects(() => safeFetch("https://8.8.8.8/r", {}, { allowlist: ALLOW }), /non-HTTPS/);
  });

  test("follows a redirect to an allowlisted public host", async () => {
    const calls = stubFetch({
      "https://8.8.8.8/r": redirect(302, "/next"),
      "https://8.8.8.8/next": ok("final"),
    });
    const res = await safeFetch("https://8.8.8.8/r", {}, { allowlist: ALLOW });
    assert.equal(await res.text(), "final");
    assert.equal(calls.length, 2);
  });

  test("drops Authorization on a cross-origin hop, keeps it same-origin", async () => {
    const calls = stubFetch({
      "https://8.8.8.8/a": redirect(307, "https://8.8.8.8/b"),
      "https://8.8.8.8/b": redirect(307, "https://1.1.1.1/c"),
      "https://1.1.1.1/c": ok(),
    });
    await safeFetch(
      "https://8.8.8.8/a",
      { headers: { Authorization: "L402 mac:pre", Accept: "application/json" } },
      { allowlist: ALLOW },
    );
    assert.equal(calls[1].headers.get("authorization"), "L402 mac:pre");
    assert.equal(calls[2].headers.get("authorization"), null);
    assert.equal(calls[2].headers.get("accept"), "application/json");
  });

  test("throws after too many hops", async () => {
    stubFetch({
      "https://8.8.8.8/a": redirect(302, "https://8.8.8.8/b"),
      "https://8.8.8.8/b": redirect(302, "https://8.8.8.8/a"),
    });
    await assert.rejects(
      () => safeFetch("https://8.8.8.8/a", {}, { allowlist: ALLOW, maxHops: 3 }),
      /Too many redirects/,
    );
  });

  test("POST + 303 becomes a bodyless GET; 307 preserves method and body", async () => {
    const calls = stubFetch({
      "https://8.8.8.8/p": redirect(307, "https://8.8.8.8/q"),
      "https://8.8.8.8/q": redirect(303, "https://8.8.8.8/r"),
      "https://8.8.8.8/r": ok(),
    });
    await safeFetch(
      "https://8.8.8.8/p",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
      { allowlist: ALLOW },
    );
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].body, "{}");
    assert.equal(calls[2].method, "GET");
    assert.equal(calls[2].body, undefined);
    assert.equal(calls[2].headers.get("content-type"), null);
  });
});

// ── L402 flows use safeFetch end-to-end ───────────────────────────────────

describe("L402 requests re-validate redirects", () => {
  let handleL402Tool: typeof import("../src/tools/l402.js").handleL402Tool;
  let origFetch: typeof globalThis.fetch;
  let origAllow: string | undefined;

  before(async () => {
    origFetch = globalThis.fetch;
    origAllow = process.env.BLINK_L402_HOST_ALLOWLIST;
    handleL402Tool = (await import("../src/tools/l402.js")).handleL402Tool;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origAllow === undefined) delete process.env.BLINK_L402_HOST_ALLOWLIST;
    else process.env.BLINK_L402_HOST_ALLOWLIST = origAllow;
  });

  const nullClient = {} as Parameters<typeof handleL402Tool>[0];

  test("l402_discover GET redirected to an internal host is blocked (HEAD said 200)", async () => {
    process.env.BLINK_L402_HOST_ALLOWLIST = "8.8.8.8,127.0.0.1";
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${input}`);
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
    }) as typeof fetch;

    const result = (await handleL402Tool(nullClient, "l402_discover", {
      url: "https://8.8.8.8/res",
      method: "GET",
    })) as Record<string, unknown>;
    assert.equal(result.success, false);
    assert.match(String(result.error), /Blocked unsafe URL/);
    assert.ok(!calls.some((c) => c.includes("127.0.0.1")));
  });

  test("l402-protocol invoice POST redirected (307) to loopback is never requested", async () => {
    process.env.BLINK_L402_HOST_ALLOWLIST = "8.8.8.8,127.0.0.1";
    const calls: string[] = [];
    let internalBodyRead = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method} ${url}`);
      if (url.includes("127.0.0.1")) {
        internalBodyRead = true;
        return new Response(JSON.stringify({ invoice: "lnbc-internal" }), { status: 200 });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      if (url === "https://8.8.8.8/res") {
        return new Response(
          JSON.stringify({ version: "0.2", payment_request_url: "https://8.8.8.8/pay", offers: [] }),
          { status: 402 },
        );
      }
      if (url === "https://8.8.8.8/pay") {
        return new Response(null, { status: 307, headers: { location: "https://127.0.0.1/pay" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const result = (await handleL402Tool(nullClient, "l402_discover", {
      url: "https://8.8.8.8/res",
      method: "GET",
    })) as Record<string, unknown>;
    assert.equal(result.l402_detected, true);
    assert.equal(result.invoice, null);
    assert.equal(internalBodyRead, false);
    assert.ok(!calls.some((c) => c.includes("127.0.0.1")));
  });
});

// ── remaining ssrf branches ───────────────────────────────────────────────

describe("ipIsPrivate: more shapes", () => {
  test("full-form addresses and colon-bearing garbage", () => {
    assert.equal(ipIsPrivate("fe80:0:0:0:0:0:0:1"), true);
    assert.equal(ipIsPrivate("2606:4700:0:0:0:0:0:1111"), false);
    assert.equal(ipIsPrivate("foo:bar"), true);
  });
});

describe("assertSafeUrl: parsing and DNS", () => {
  const allow = new Set(["api.example.com"]);

  test("rejects a malformed URL", async () => {
    await assert.rejects(() => assertSafeUrl("not a url", allow), /Invalid URL/);
  });

  test("accepts a host that resolves only to public addresses", async (t) => {
    t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    await assert.doesNotReject(() => assertSafeUrl("https://api.example.com/x", allow));
  });

  test("rejects a host with any private address", async (t) => {
    t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await assert.rejects(() => assertSafeUrl("https://api.example.com/x", allow), /non-public address 10\.0\.0\.5/);
  });

  test("rejects unresolvable hosts and empty answers", async (t) => {
    const lookup = t.mock.method(dns, "lookup", async () => {
      throw new Error("ENOTFOUND");
    });
    await assert.rejects(() => assertSafeUrl("https://api.example.com/x", allow), /Could not resolve/);
    lookup.mock.mockImplementation(async () => []);
    await assert.rejects(() => assertSafeUrl("https://api.example.com/x", allow), /no addresses/);
  });
});

describe("safeFetch: redirect bodies", () => {
  let origFetch: typeof globalThis.fetch;
  before(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("discards a redirect's body before following it", async () => {
    let cancelled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (input.toString() === "https://8.8.8.8/a") {
        const body = new ReadableStream({ cancel: () => void (cancelled = true) });
        return new Response(body, { status: 302, headers: { location: "/b" } });
      }
      return new Response("done", { status: 200 });
    }) as typeof fetch;
    const res = await safeFetch("https://8.8.8.8/a", {}, { allowlist: ALLOW });
    assert.equal(await res.text(), "done");
    assert.equal(cancelled, true);
  });

  test("a 3xx without Location is returned as-is", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
    const res = await safeFetch("https://8.8.8.8/a", {}, { allowlist: ALLOW });
    assert.equal(res.status, 304);
  });
});
