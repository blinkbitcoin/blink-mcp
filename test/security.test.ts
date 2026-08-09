/**
 * Tests for the spend guard, security config, webhook validation, and SSRF
 * containment added as part of the security-findings remediation.
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
  confirmSpend,
  checkWebhookUrl,
  hashArgs,
  DailyBudgetTracker,
  ConfirmTokenStore,
  type GuardContext,
} from "../src/security/guard.ts";
import { assertSafeUrl, SsrfError } from "../src/security/ssrf.ts";

// ── config ──────────────────────────────────────────────────────────────────

describe("loadSecurityConfig", () => {
  test("defaults to confirmation ON and no caps", () => {
    const c = loadSecurityConfig({} as NodeJS.ProcessEnv);
    assert.equal(c.requireConfirmation, true);
    assert.equal(c.maxPaymentSats, null);
    assert.equal(c.dailyBudgetSats, null);
    assert.equal(c.recipientAllowlist.size, 0);
    assert.equal(c.l402MaxSats, 1000);
  });

  test("parses caps, lists, and booleans", () => {
    const c = loadSecurityConfig({
      BLINK_REQUIRE_CONFIRMATION: "false",
      BLINK_MAX_PAYMENT_SATS: "5000",
      BLINK_DAILY_BUDGET_SATS: "20000",
      BLINK_RECIPIENT_ALLOWLIST: "user@blink.sv, bc1qxyz",
      BLINK_L402_MAX_SATS: "250",
    } as NodeJS.ProcessEnv);
    assert.equal(c.requireConfirmation, false);
    assert.equal(c.maxPaymentSats, 5000);
    assert.equal(c.dailyBudgetSats, 20000);
    assert.ok(c.recipientAllowlist.has("user@blink.sv"));
    assert.ok(c.recipientAllowlist.has("bc1qxyz"));
    assert.equal(c.l402MaxSats, 250);
  });

  test("rejects invalid numeric settings", () => {
    assert.throws(
      () => loadSecurityConfig({ BLINK_MAX_PAYMENT_SATS: "-1" } as NodeJS.ProcessEnv),
      /positive integer/,
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

  test("extracts amount and recipient for a lightning address send", () => {
    const i = extractSpendIntent("pay_lightning_address", {
      ln_address: "a@b.sv",
      amount: 1000,
      wallet_id: "w",
    });
    assert.equal(i.amount, 1000);
    assert.equal(i.recipient, "a@b.sv");
    assert.equal(i.isSweep, false);
  });
});

// ── evaluateSpend: allowlist / caps / budget ───────────────────────────────

function ctx(overrides: Partial<ReturnType<typeof loadSecurityConfig>> = {}): GuardContext {
  const config = { ...loadSecurityConfig({} as NodeJS.ProcessEnv), ...overrides };
  return { config, budget: new DailyBudgetTracker() };
}

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

  test("allows recipient in allowlist (then requires confirm)", () => {
    const c = ctx({ recipientAllowlist: new Set(["good@blink.sv"]) });
    const d = evaluateSpend(c, "pay_lightning_address", {
      amount: 100,
      recipient: "GOOD@blink.sv",
      isSweep: false,
    });
    assert.equal(d.action, "confirm");
  });

  test("denies amount over per-tx cap", () => {
    const c = ctx({ maxPaymentSats: 500, requireConfirmation: false });
    const d = evaluateSpend(c, "send_onchain", {
      amount: 900,
      recipient: "bc1q",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("denies when daily budget would be exceeded", () => {
    const c = ctx({ dailyBudgetSats: 1000, requireConfirmation: false });
    c.budget.record(800);
    const d = evaluateSpend(c, "send_onchain", {
      amount: 300,
      recipient: "bc1q",
      isSweep: false,
    });
    assert.equal(d.action, "deny");
  });

  test("unknown amount + configured cap + no confirmation => deny (never bypass)", () => {
    const c = ctx({ maxPaymentSats: 500, requireConfirmation: false });
    const d = evaluateSpend(c, "send_onchain_all", {
      amount: null,
      recipient: "bc1q",
      isSweep: true,
    });
    assert.equal(d.action, "deny");
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

// ── confirm-token fallback ─────────────────────────────────────────────────

describe("confirmSpend two-step confirm-token", () => {
  test("first call issues a token (pending); second call with token approves", async () => {
    const tokens = new ConfirmTokenStore();
    const args = { amount: 100, address: "bc1q" };

    const first = await confirmSpend(null, tokens, "send_onchain", args, "summary");
    assert.equal(first.status, "pending");
    const token =
      first.status === "pending" ? (first.payload.confirm_token as string) : "";
    assert.ok(token.length > 0);

    const second = await confirmSpend(
      null,
      tokens,
      "send_onchain",
      { ...args, confirm_token: token },
      "summary",
    );
    assert.equal(second.status, "approved");
  });

  test("token is single-use", async () => {
    const tokens = new ConfirmTokenStore();
    const args = { amount: 100, address: "bc1q" };
    const first = await confirmSpend(null, tokens, "send_onchain", args, "s");
    const token =
      first.status === "pending" ? (first.payload.confirm_token as string) : "";
    await confirmSpend(null, tokens, "send_onchain", { ...args, confirm_token: token }, "s");
    const third = await confirmSpend(
      null,
      tokens,
      "send_onchain",
      { ...args, confirm_token: token },
      "s",
    );
    assert.equal(third.status, "pending"); // reissued, not approved
  });

  test("token does not approve a different request", async () => {
    const tokens = new ConfirmTokenStore();
    const first = await confirmSpend(null, tokens, "send_onchain", { amount: 100 }, "s");
    const token =
      first.status === "pending" ? (first.payload.confirm_token as string) : "";
    const tampered = await confirmSpend(
      null,
      tokens,
      "send_onchain",
      { amount: 999999, confirm_token: token },
      "s",
    );
    assert.equal(tampered.status, "pending");
  });

  test("expired token is rejected", async () => {
    let now = 1000;
    const tokens = new ConfirmTokenStore(() => now);
    const args = { amount: 100 };
    const first = await confirmSpend(null, tokens, "send_onchain", args, "s");
    const token =
      first.status === "pending" ? (first.payload.confirm_token as string) : "";
    now += 6 * 60 * 1000; // 6 min > 5 min TTL
    const late = await confirmSpend(
      null,
      tokens,
      "send_onchain",
      { ...args, confirm_token: token },
      "s",
    );
    assert.equal(late.status, "pending");
  });

  test("elicitation path approves when user accepts", async () => {
    const tokens = new ConfirmTokenStore();
    const res = await confirmSpend(
      async () => true,
      tokens,
      "send_onchain",
      { amount: 100 },
      "s",
    );
    assert.equal(res.status, "approved");
  });

  test("elicitation path rejects when user declines", async () => {
    const tokens = new ConfirmTokenStore();
    const res = await confirmSpend(
      async () => false,
      tokens,
      "send_onchain",
      { amount: 100 },
      "s",
    );
    assert.equal(res.status, "rejected");
  });
});

describe("hashArgs", () => {
  test("ignores confirm_token and is order-independent", () => {
    const a = hashArgs({ amount: 1, address: "x", confirm_token: "aaa" });
    const b = hashArgs({ address: "x", amount: 1 });
    assert.equal(a, b);
  });
});

// ── webhook validation ─────────────────────────────────────────────────────

describe("checkWebhookUrl", () => {
  test("rejects non-https", () => {
    const r = checkWebhookUrl("http://evil.com/cb", new Set());
    assert.equal(r.ok, false);
  });

  test("rejects host not in allowlist", () => {
    const r = checkWebhookUrl("https://evil.com/cb", new Set(["mysite.com"]));
    assert.equal(r.ok, false);
  });

  test("accepts https host in allowlist", () => {
    const r = checkWebhookUrl("https://mysite.com/cb", new Set(["mysite.com"]));
    assert.equal(r.ok, true);
  });

  test("accepts any https host when allowlist empty", () => {
    const r = checkWebhookUrl("https://anywhere.example/cb", new Set());
    assert.equal(r.ok, true);
  });
});

// ── SSRF containment ────────────────────────────────────────────────────────

describe("assertSafeUrl", () => {
  test("rejects non-https", async () => {
    await assert.rejects(() => assertSafeUrl("http://example.com"), SsrfError);
  });

  test("rejects loopback literal IP", async () => {
    await assert.rejects(() => assertSafeUrl("https://127.0.0.1/x"), SsrfError);
  });

  test("rejects private literal IP", async () => {
    await assert.rejects(() => assertSafeUrl("https://192.168.1.5/x"), SsrfError);
  });

  test("rejects link-local", async () => {
    await assert.rejects(() => assertSafeUrl("https://169.254.169.254/latest"), SsrfError);
  });

  test("enforces host allowlist", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://8.8.8.8/x", new Set(["allowed.com"])),
      SsrfError,
    );
  });
});

// ── token store file permissions ───────────────────────────────────────────

describe("L402 token store permissions", () => {
  test("writeStore creates a 0600 file", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX permissions not applicable on Windows");
      return;
    }
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "blink-l402-"));
    const origHome = os.homedir;
    // Redirect homedir so the store writes into the temp dir.
    (os as unknown as { homedir: () => string }).homedir = () => tmpHome;
    try {
      // Import fresh so STORE_DIR/STORE_FILE resolve against the temp home.
      const mod = await import(
        "../src/tools/l402.ts?perm=" + Date.now()
      );
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
