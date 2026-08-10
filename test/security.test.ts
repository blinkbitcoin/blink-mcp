/**
 * Tests for the spend guard, security config, durable budget ledger, webhook
 * validation, and SSRF containment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSecurityConfig } from "../src/security/config.ts";
import {
  isSpendTool,
  extractSpendIntent,
  evaluateSpend,
  enforceAmount,
  confirmSpend,
  checkWebhookUrl,
  hashArgs,
  ApprovalCodeStore,
  type GuardContext,
} from "../src/security/guard.ts";
import { SpendLedger } from "../src/security/ledger.ts";
import { assertSafeUrl, SsrfError } from "../src/security/ssrf.ts";

// ── config ──────────────────────────────────────────────────────────────────

describe("loadSecurityConfig", () => {
  test("defaults: confirmation ON, fail-closed, no caps", () => {
    const c = loadSecurityConfig({} as NodeJS.ProcessEnv);
    assert.equal(c.requireConfirmation, true);
    assert.equal(c.approvalMode, "fail-closed");
    assert.equal(c.maxPaymentSats, null);
    assert.equal(c.dailyBudgetSats, null);
    assert.equal(c.recipientAllowlist.size, 0);
    assert.equal(c.l402HostAllowlist.size, 0);
    assert.equal(c.l402MaxSats, 1000);
  });

  test("parses caps, lists, booleans, approval mode", () => {
    const c = loadSecurityConfig({
      BLINK_REQUIRE_CONFIRMATION: "false",
      BLINK_APPROVAL_MODE: "stderr-code",
      BLINK_MAX_PAYMENT_SATS: "5000",
      BLINK_DAILY_BUDGET_SATS: "20000",
      BLINK_RECIPIENT_ALLOWLIST: "user@blink.sv, bc1qxyz",
      BLINK_L402_HOST_ALLOWLIST: "api.example.com",
      BLINK_L402_MAX_SATS: "250",
    } as NodeJS.ProcessEnv);
    assert.equal(c.requireConfirmation, false);
    assert.equal(c.approvalMode, "stderr-code");
    assert.equal(c.maxPaymentSats, 5000);
    assert.equal(c.dailyBudgetSats, 20000);
    assert.ok(c.recipientAllowlist.has("user@blink.sv"));
    assert.ok(c.l402HostAllowlist.has("api.example.com"));
    assert.equal(c.l402MaxSats, 250);
  });

  test("rejects invalid numeric settings", () => {
    assert.throws(
      () => loadSecurityConfig({ BLINK_MAX_PAYMENT_SATS: "-1" } as NodeJS.ProcessEnv),
      /positive integer/,
    );
  });

  test("rejects invalid approval mode", () => {
    assert.throws(
      () => loadSecurityConfig({ BLINK_APPROVAL_MODE: "bearer" } as NodeJS.ProcessEnv),
      /BLINK_APPROVAL_MODE/,
    );
  });
});

// ── spend classification ──────────────────────────────────────────────────

describe("spend classification", () => {
  test("identifies spend tools", () => {
    assert.equal(isSpendTool("send_onchain_all"), true);
    assert.equal(isSpendTool("pay_lightning_address"), true);
    assert.equal(isSpendTool("l402_pay"), true);
    assert.equal(isSpendTool("get_wallets"), false);
    assert.equal(isSpendTool("create_invoice"), false);
  });

  test("send_onchain_all is an unbounded sweep with null amount", () => {
    const i = extractSpendIntent("send_onchain_all", { address: "bc1q", wallet_id: "w" });
    assert.equal(i.isSweep, true);
    assert.equal(i.amount, null);
    assert.equal(i.recipient, "bc1q");
  });

  test("l402_pay has null amount up front (decoded later)", () => {
    const i = extractSpendIntent("l402_pay", { url: "https://x", wallet_id: "w" });
    assert.equal(i.amount, null);
    assert.equal(i.recipient, "https://x");
  });

  test("pay_invoice decodes the fixed amount from the bolt11", () => {
    // lnbc10u... = 10 micro-BTC = 1000 sats.
    const i = extractSpendIntent("pay_invoice", {
      wallet_id: "w",
      payment_request: "lnbc10u1pexampledata",
    });
    assert.equal(i.amount, 1000);
    assert.equal(i.isSweep, false);
    assert.equal(i.undecodable, false);
  });

  test("pay_invoice flags undecodable/amountless invoices", () => {
    const i = extractSpendIntent("pay_invoice", {
      wallet_id: "w",
      payment_request: "not-a-bolt11",
    });
    assert.equal(i.amount, null);
    assert.equal(i.undecodable, true);
  });
});

// ── enforceAmount (shared authoritative amount gate) ───────────────────────

function ctx(
  overrides: Partial<ReturnType<typeof loadSecurityConfig>> = {},
  ledger?: SpendLedger,
): GuardContext {
  const config = { ...loadSecurityConfig({} as NodeJS.ProcessEnv), ...overrides };
  return { config, ledger: ledger ?? new SpendLedger(memLedgerFile()) };
}

// A per-test temp ledger file.
function memLedgerFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-ledger-"));
  return path.join(dir, "spend-ledger.json");
}

describe("enforceAmount", () => {
  test("denies over per-tx cap", () => {
    const c = ctx({ maxPaymentSats: 500 });
    assert.equal(enforceAmount(c, 900).ok, false);
    assert.equal(enforceAmount(c, 500).ok, true);
  });

  test("denies over daily budget including prior spend", () => {
    const c = ctx({ dailyBudgetSats: 1000 });
    c.ledger.record(800);
    assert.equal(enforceAmount(c, 300).ok, false);
    assert.equal(enforceAmount(c, 200).ok, true);
  });
});

// ── evaluateSpend ──────────────────────────────────────────────────────────

describe("evaluateSpend", () => {
  test("denies recipient not in allowlist", () => {
    const c = ctx({ recipientAllowlist: new Set(["good@blink.sv"]) });
    const d = evaluateSpend(c, "pay_lightning_address", {
      amount: 100,
      recipient: "evil@attacker.com",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("allowlisted recipient still requires confirmation", () => {
    const c = ctx({ recipientAllowlist: new Set(["good@blink.sv"]) });
    const d = evaluateSpend(c, "pay_lightning_address", {
      amount: 100,
      recipient: "GOOD@blink.sv",
      isSweep: false,
    });
    assert.equal(d.action, "confirm");
  });

  test("denies known amount over cap even with confirmation off", () => {
    const c = ctx({ maxPaymentSats: 500, requireConfirmation: false });
    const d = evaluateSpend(c, "send_onchain", {
      amount: 900,
      recipient: "bc1q",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("unknown amount + cap + no confirmation => deny (never bypass)", () => {
    const c = ctx({ maxPaymentSats: 500, requireConfirmation: false });
    const d = evaluateSpend(c, "l402_pay", {
      amount: null,
      recipient: "https://x",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("pay_invoice: decoded amount over cap => deny (even with confirmation)", () => {
    const c = ctx({ maxPaymentSats: 500 });
    const d = evaluateSpend(c, "pay_invoice", {
      amount: 900,
      recipient: "lnbc9u1p...",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("pay_invoice: decoded amount within cap => confirm", () => {
    const c = ctx({ maxPaymentSats: 5000 });
    const d = evaluateSpend(c, "pay_invoice", {
      amount: 1000,
      recipient: "lnbc10u1p...",
      isSweep: false,
    });
    assert.equal(d.action, "confirm");
  });

  test("pay_invoice: undecodable amount + cap => deny (never bypass)", () => {
    const c = ctx({ maxPaymentSats: 500 });
    const d = evaluateSpend(c, "pay_invoice", {
      amount: null,
      recipient: "bad-invoice",
      isSweep: false,
      undecodable: true,
    });
    assert.equal(d.action, "deny");
  });

  test("send_onchain_all sweep + cap => deny (cannot verify)", () => {
    const c = ctx({ maxPaymentSats: 100000 });
    const d = evaluateSpend(c, "send_onchain_all", {
      amount: null,
      recipient: "bc1q",
      isSweep: true,
    });
    assert.equal(d.action, "deny");
  });

  test("send_onchain_all sweep + daily budget => deny", () => {
    const c = ctx({ dailyBudgetSats: 100000 });
    const d = evaluateSpend(c, "send_onchain_all", {
      amount: null,
      recipient: "bc1q",
      isSweep: true,
    });
    assert.equal(d.action, "deny");
  });

  test("send_onchain_all sweep + NO caps => confirm (unchanged)", () => {
    const c = ctx({});
    const d = evaluateSpend(c, "send_onchain_all", {
      amount: null,
      recipient: "bc1q",
      isSweep: true,
    });
    assert.equal(d.action, "confirm");
  });

  test("allows when confirmation disabled and within caps", () => {
    const c = ctx({ requireConfirmation: false, maxPaymentSats: 1000 });
    const d = evaluateSpend(c, "send_onchain", {
      amount: 500,
      recipient: "bc1q",
      isSweep: false,
    });
    assert.equal(d.action, "allow");
  });
});

// ── confirmSpend: fail-closed + stderr-code ────────────────────────────────

function deps(overrides: Record<string, unknown> = {}) {
  const printed: string[] = [];
  const base = {
    elicit: null,
    approvals: new ApprovalCodeStore(),
    printToStderr: (line: string) => printed.push(line),
    approvalMode: "fail-closed" as const,
  };
  return { deps: { ...base, ...overrides }, printed };
}

describe("confirmSpend", () => {
  test("elicitation accept => approved", async () => {
    const { deps: d } = deps({ elicit: async () => true });
    const r = await confirmSpend(d, "send_onchain", { amount: 100 }, "s");
    assert.equal(r.status, "approved");
  });

  test("elicitation decline => rejected", async () => {
    const { deps: d } = deps({ elicit: async () => false });
    const r = await confirmSpend(d, "send_onchain", { amount: 100 }, "s");
    assert.equal(r.status, "rejected");
  });

  test("no elicitation + fail-closed => rejected (never pending token)", async () => {
    const { deps: d } = deps({ approvalMode: "fail-closed" });
    const r = await confirmSpend(d, "send_onchain", { amount: 100 }, "s");
    assert.equal(r.status, "rejected");
  });

  test("stderr-code: first call prints code to stderr, returns pending WITHOUT code", async () => {
    const { deps: d, printed } = deps({ approvalMode: "stderr-code" });
    const r = await confirmSpend(d, "send_onchain", { amount: 100 }, "summary");
    assert.equal(r.status, "pending");
    // The code must NOT appear in the model-visible payload.
    const payloadStr = JSON.stringify(
      r.status === "pending" ? r.payload : {},
    );
    assert.equal(/[0-9a-f]{8}/.test(payloadStr), false);
    // The code IS printed to stderr.
    assert.ok(printed.join("").includes("approval_code="));
  });

  test("stderr-code: correct code approves; wrong code re-prompts", async () => {
    const store = new ApprovalCodeStore();
    const { deps: d, printed } = deps({
      approvalMode: "stderr-code",
      approvals: store,
    });
    await confirmSpend(d, "send_onchain", { amount: 100 }, "s");
    const match = printed.join("").match(/approval_code="([0-9a-f]+)"/);
    assert.ok(match, "code should be printed to stderr");
    const code = match![1];

    const wrong = await confirmSpend(
      d,
      "send_onchain",
      { amount: 100, approval_code: "deadbeef" },
      "s",
    );
    assert.equal(wrong.status, "pending");

    // Re-issue a fresh code (previous consumed by wrong attempt), then approve.
    const printed2: string[] = [];
    const d2 = { ...d, printToStderr: (l: string) => printed2.push(l) };
    await confirmSpend(d2, "send_onchain", { amount: 100 }, "s");
    const code2 = printed2.join("").match(/approval_code="([0-9a-f]+)"/)![1];
    const ok = await confirmSpend(
      d2,
      "send_onchain",
      { amount: 100, approval_code: code2 },
      "s",
    );
    assert.equal(ok.status, "approved");
    assert.ok(code.length > 0);
  });

  test("stderr-code: code does not approve a different request", async () => {
    const store = new ApprovalCodeStore();
    const { deps: d, printed } = deps({
      approvalMode: "stderr-code",
      approvals: store,
    });
    await confirmSpend(d, "send_onchain", { amount: 100 }, "s");
    const code = printed.join("").match(/approval_code="([0-9a-f]+)"/)![1];
    const tampered = await confirmSpend(
      d,
      "send_onchain",
      { amount: 999999, approval_code: code },
      "s",
    );
    assert.equal(tampered.status, "pending");
  });
});

describe("hashArgs", () => {
  test("ignores approval_code and is order-independent", () => {
    const a = hashArgs({ amount: 1, address: "x", approval_code: "aaa" });
    const b = hashArgs({ address: "x", amount: 1 });
    assert.equal(a, b);
  });
});

// ── durable ledger ──────────────────────────────────────────────────────────

describe("SpendLedger", () => {
  test("persists across instances (survives restart)", () => {
    const file = memLedgerFile();
    const l1 = new SpendLedger(file);
    l1.record(300);
    l1.record(200);
    // New instance simulates a server restart.
    const l2 = new SpendLedger(file);
    assert.equal(l2.spentLast24h(), 500);
  });

  test("prunes entries older than 24h", () => {
    const file = memLedgerFile();
    let now = 1_000_000_000_000;
    const l = new SpendLedger(file, () => now);
    l.record(1000);
    now += 25 * 60 * 60 * 1000; // +25h
    assert.equal(l.spentLast24h(), 0);
  });

  test("writes a 0600 file", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX perms n/a on Windows");
      return;
    }
    const file = memLedgerFile();
    new SpendLedger(file).record(10);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

// ── webhook validation ─────────────────────────────────────────────────────

describe("checkWebhookUrl", () => {
  test("rejects non-https", () => {
    assert.equal(checkWebhookUrl("http://evil.com/cb", new Set()).ok, false);
  });
  test("rejects host not in allowlist", () => {
    assert.equal(
      checkWebhookUrl("https://evil.com/cb", new Set(["mysite.com"])).ok,
      false,
    );
  });
  test("accepts https host in allowlist", () => {
    assert.equal(
      checkWebhookUrl("https://mysite.com/cb", new Set(["mysite.com"])).ok,
      true,
    );
  });
  test("accepts any https host when allowlist empty", () => {
    assert.equal(checkWebhookUrl("https://anywhere.example/cb", new Set()).ok, true);
  });
});

// ── SSRF containment (fail-closed) ─────────────────────────────────────────

describe("assertSafeUrl", () => {
  test("fails closed when host allowlist is empty", async () => {
    await assert.rejects(() => assertSafeUrl("https://example.com"), SsrfError);
  });

  test("rejects non-https even if host allowlisted", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://example.com", new Set(["example.com"])),
      SsrfError,
    );
  });

  test("rejects host not in allowlist", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://evil.com/x", new Set(["good.com"])),
      SsrfError,
    );
  });

  test("rejects allowlisted host that is a private literal IP", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://127.0.0.1/x", new Set(["127.0.0.1"])),
      SsrfError,
    );
  });

  test("accepts allowlisted public host", async () => {
    // 8.8.8.8 is public; allowlisting the literal IP avoids DNS in the test.
    await assert.doesNotReject(() =>
      assertSafeUrl("https://8.8.8.8/x", new Set(["8.8.8.8"])),
    );
  });
});

// ── L402 token store permissions ───────────────────────────────────────────

describe("L402 token store permissions", () => {
  test("writeStore creates a 0600 file", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX permissions not applicable on Windows");
      return;
    }
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "blink-l402-"));
    const origHome = os.homedir;
    (os as unknown as { homedir: () => string }).homedir = () => tmpHome;
    try {
      const mod = await import("../src/tools/l402.ts?perm=" + Date.now());
      mod.saveToken("example.com", {
        macaroon: "mac",
        preimage: "pre",
        satoshis: 10,
      });
      const file = path.join(tmpHome, ".blink", "l402-tokens.json");
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      (os as unknown as { homedir: () => string }).homedir = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
