/**
 * Tests for the guarded execution path (src/security/gate.ts): webhook
 * confirmation, USD→sats cap enforcement, and budget reservation around a
 * payment. Also covers the ledger's locking / atomicity / fail-closed reads.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadSecurityConfig } from "../src/security/config.ts";
import {
  ApprovalCodeStore,
  extractSpendIntent,
  evaluateSpend,
  describeSpend,
  type GuardContext,
} from "../src/security/guard.ts";
import { runGuarded, type GateDeps } from "../src/security/gate.ts";
import { SpendLedger, LedgerCorruptError } from "../src/security/ledger.ts";

function tmpLedgerFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-gate-"));
  return path.join(dir, "spend-ledger.json");
}

function ctx(
  overrides: Partial<ReturnType<typeof loadSecurityConfig>> = {},
  extra: Partial<GuardContext> = {},
): GuardContext {
  const config = { ...loadSecurityConfig({} as NodeJS.ProcessEnv), ...overrides };
  return { config, ledger: new SpendLedger(tmpLedgerFile()), ...extra };
}

function gateDeps(guardCtx: GuardContext, overrides: Partial<GateDeps> = {}) {
  const printed: string[] = [];
  const deps: GateDeps = {
    guardCtx,
    approvals: new ApprovalCodeStore(),
    printToStderr: (line) => printed.push(line),
    approvalMode: "fail-closed",
    elicit: null,
    ...overrides,
  };
  return { deps, printed };
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

/** An execute() stub that records whether it ran. */
function executor(result: unknown = { success: true }) {
  const calls = { n: 0 };
  return {
    calls,
    run: async () => {
      calls.n++;
      return result;
    },
  };
}

// ── webhook confirmation (#1098 residual) ─────────────────────────────────

describe("runGuarded: webhooks", () => {
  const args = { url: "https://hooks.example.com/cb" };

  test("add_webhook asks for approval via elicitation and runs on approve", async () => {
    const seen: Array<[string, string]> = [];
    const { deps } = gateDeps(ctx(), {
      elicit: async (summary, kind) => {
        seen.push([summary, kind]);
        return true;
      },
    });
    const exec = executor();
    const res = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(res.isError, undefined);
    assert.equal(exec.calls.n, 1);
    assert.equal(seen[0][1], "account-change");
    assert.match(seen[0][0], /hooks\.example\.com/);
  });

  test("add_webhook does not run when the human declines", async () => {
    const { deps } = gateDeps(ctx(), { elicit: async () => false });
    const exec = executor();
    const res = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(res.isError, true);
    assert.equal(exec.calls.n, 0);
  });

  test("add_webhook fails closed without elicitation (default mode)", async () => {
    const { deps } = gateDeps(ctx());
    const exec = executor();
    const res = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(res.isError, true);
    assert.match(String(parse(res).error), /fail-closed/);
    assert.equal(exec.calls.n, 0);
  });

  test("add_webhook stderr-code round trip; the code never reaches tool output", async () => {
    const { deps, printed } = gateDeps(ctx(), { approvalMode: "stderr-code" });
    const exec = executor();

    const first = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(parse(first).requires_approval, true);
    assert.equal(exec.calls.n, 0);
    const code = printed.join("").match(/approval_code="([0-9a-f]+)"/)?.[1];
    assert.ok(code);
    assert.ok(!first.content[0].text.includes(code));

    const wrong = await runGuarded("add_webhook", args, { ...args, approval_code: "00000000" }, deps, exec.run);
    assert.equal(parse(wrong).requires_approval, true);
    assert.equal(exec.calls.n, 0);

    const code2 = printed.join("").match(/approval_code="([0-9a-f]+)"/g)!.pop()!.slice(15, -1);
    const ok = await runGuarded("add_webhook", args, { ...args, approval_code: code2 }, deps, exec.run);
    assert.equal(ok.isError, undefined);
    assert.equal(exec.calls.n, 1);
  });

  test("webhook allowlist denies before any confirmation prompt", async () => {
    let prompted = false;
    const { deps } = gateDeps(ctx({ webhookAllowlist: new Set(["mine.example"]) }), {
      elicit: async () => {
        prompted = true;
        return true;
      },
    });
    const exec = executor();
    const res = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(res.isError, true);
    assert.equal(prompted, false);
    assert.equal(exec.calls.n, 0);
  });

  test("IP-literal webhook host is denied", async () => {
    const { deps } = gateDeps(ctx(), { elicit: async () => true });
    const exec = executor();
    const a = { url: "https://169.254.169.254/cb" };
    const res = await runGuarded("add_webhook", a, a, deps, exec.run);
    assert.equal(res.isError, true);
    assert.equal(exec.calls.n, 0);
  });

  test("remove_webhook is gated too", async () => {
    const { deps } = gateDeps(ctx());
    const exec = executor();
    const a = { id: "cb-1" };
    const res = await runGuarded("remove_webhook", a, a, deps, exec.run);
    assert.equal(res.isError, true);
    assert.equal(exec.calls.n, 0);
  });

  test("list_webhooks and other read tools are not gated", async () => {
    const { deps } = gateDeps(ctx());
    const exec = executor({ success: true, data: [] });
    const res = await runGuarded("list_webhooks", {}, {}, deps, exec.run);
    assert.equal(res.isError, undefined);
    assert.equal(exec.calls.n, 1);
  });
});

// ── USD cents vs sats caps (#1572.2) ──────────────────────────────────────

describe("USD amounts are converted to sats before cap checks", () => {
  const tenSatsPerCent = async (cents: number) => cents * 10;

  test("intents carry the right currency", () => {
    assert.equal(extractSpendIntent("send_to_wallet_usd", { amount: 5 }).currency, "USD");
    assert.equal(extractSpendIntent("send_onchain_usd", { amount: 5 }).currency, "USD");
    assert.equal(extractSpendIntent("send_to_username", { amount: 5, wallet_currency: "USD" }).currency, "USD");
    assert.equal(extractSpendIntent("send_to_username", { amount: 5 }).currency, "BTC");
    assert.equal(extractSpendIntent("send_to_wallet", { amount: 5 }).currency, "BTC");
  });

  test("500 cents ≈ 5000 sats is denied by a 1000-sat cap", async () => {
    const c = ctx({ maxPaymentSats: 1000 }, { toSats: tenSatsPerCent });
    const d = await evaluateSpend(c, "send_to_wallet_usd", extractSpendIntent("send_to_wallet_usd", { amount: 500, recipient_wallet_id: "w2" }));
    assert.equal(d.action, "deny");
    assert.match((d as { reason: string }).reason, /5000 sats/);
  });

  test("the same 500 as BTC sats passes the 1000-sat cap", async () => {
    const c = ctx({ maxPaymentSats: 1000 }, { toSats: tenSatsPerCent });
    const d = await evaluateSpend(c, "send_to_wallet", extractSpendIntent("send_to_wallet", { amount: 500, recipient_wallet_id: "w2" }));
    assert.equal(d.action, "confirm");
  });

  test("conversion failure with a cap configured is denied", async () => {
    const c = ctx({ dailyBudgetSats: 100_000 }, {
      toSats: async () => {
        throw new Error("price feed down");
      },
    });
    const d = await evaluateSpend(c, "send_onchain_usd", extractSpendIntent("send_onchain_usd", { amount: 1, address: "bc1q" }));
    assert.equal(d.action, "deny");
  });

  test("conversion failure without caps still asks for confirmation", async () => {
    const c = ctx({}, { toSats: async () => NaN });
    const d = await evaluateSpend(c, "send_onchain_usd", extractSpendIntent("send_onchain_usd", { amount: 1, address: "bc1q" }));
    assert.equal(d.action, "confirm");
  });

  test("confirmation text states the unit", () => {
    assert.match(
      describeSpend("send_to_wallet_usd", { amount: 500, currency: "USD", recipient: "w", isSweep: false }, 5000),
      /500 USD cents \(≈5000 sats\)/,
    );
    assert.match(describeSpend("send_to_wallet", { amount: 500, recipient: "w", isSweep: false }), /500 sats/);
  });

  test("the ledger records sats, not cents", async () => {
    const c = ctx({ requireConfirmation: false, dailyBudgetSats: 100_000 }, { toSats: tenSatsPerCent });
    const { deps } = gateDeps(c);
    const a = { amount: 500, recipient_wallet_id: "w2", wallet_id: "w1" };
    await runGuarded("send_to_wallet_usd", a, a, deps, executor().run);
    assert.equal(c.ledger.spentLast24h(), 5000);
  });
});

// ── reservation around execution ──────────────────────────────────────────

describe("runGuarded: budget reservation", () => {
  const a = { amount: 400, recipient_wallet_id: "w2", wallet_id: "w1" };
  const noConfirm = { requireConfirmation: false, dailyBudgetSats: 1000 };

  test("commits on success", async () => {
    const c = ctx(noConfirm);
    await runGuarded("send_to_wallet", a, a, gateDeps(c).deps, executor({ success: true }).run);
    assert.equal(c.ledger.spentLast24h(), 400);
  });

  test("releases on a failed payment", async () => {
    const c = ctx(noConfirm);
    await runGuarded("send_to_wallet", a, a, gateDeps(c).deps, executor({ success: false }).run);
    assert.equal(c.ledger.spentLast24h(), 0);
  });

  test("releases when the handler throws", async () => {
    const c = ctx(noConfirm);
    await assert.rejects(() =>
      runGuarded("send_to_wallet", a, a, gateDeps(c).deps, async () => {
        throw new Error("network");
      }),
    );
    assert.equal(c.ledger.spentLast24h(), 0);
  });

  test("an in-flight spend counts against concurrent ones", async () => {
    const c = ctx(noConfirm);
    const { deps } = gateDeps(c);
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const slow = runGuarded("send_to_wallet", a, a, deps, async () => {
      await gate;
      return { success: true };
    });
    // 400 in flight; 400 more fits, the third 400 must not.
    const second = await runGuarded("send_to_wallet", a, a, deps, executor().run);
    const third = executor();
    const thirdRes = await runGuarded("send_to_wallet", a, a, deps, third.run);
    unblock();
    await slow;
    assert.equal(second.isError, undefined);
    assert.equal(thirdRes.isError, true);
    assert.equal(third.calls.n, 0);
    assert.equal(c.ledger.spentLast24h(), 800);
  });

  test("a corrupt ledger blocks spends when a budget is configured", async () => {
    const c = ctx(noConfirm);
    fs.mkdirSync(path.dirname((c.ledger as unknown as { file: string }).file), { recursive: true });
    fs.writeFileSync((c.ledger as unknown as { file: string }).file, "{not json");
    const exec = executor();
    const res = await runGuarded("send_to_wallet", a, a, gateDeps(c).deps, exec.run);
    assert.equal(res.isError, true);
    assert.match(String(parse(res).error), /unreadable/);
    assert.equal(exec.calls.n, 0);
  });
});

// ── SpendLedger: locking, atomic writes, fail-closed ──────────────────────

describe("SpendLedger hardening", () => {
  test("reserve respects the budget across instances sharing a file", () => {
    const file = tmpLedgerFile();
    const l1 = new SpendLedger(file);
    const l2 = new SpendLedger(file);
    assert.equal(l1.reserve(600, 1000).ok, true);
    assert.equal(l2.reserve(600, 1000).ok, false);
    assert.equal(l2.reserve(400, 1000).ok, true);
    assert.equal(l1.spentLast24h(), 1000);
  });

  test("release frees a reservation; commit keeps it", () => {
    const l = new SpendLedger(tmpLedgerFile());
    const a = l.reserve(100, null);
    const b = l.reserve(200, null);
    assert.ok(a.ok && b.ok);
    l.release(a.id);
    l.commit(b.id);
    assert.equal(l.spentLast24h(), 200);
  });

  test("a corrupt file throws instead of resetting the budget", () => {
    const file = tmpLedgerFile();
    fs.writeFileSync(file, "[{\"at\":1");
    assert.throws(() => new SpendLedger(file).spentLast24h(), LedgerCorruptError);
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.throws(() => new SpendLedger(file).spentLast24h(), LedgerCorruptError);
  });

  test("legacy records without status still count", () => {
    const file = tmpLedgerFile();
    fs.writeFileSync(file, JSON.stringify([{ at: Date.now(), amount: 700 }]));
    const l = new SpendLedger(file);
    assert.equal(l.spentLast24h(), 700);
    assert.equal(l.reserve(400, 1000).ok, false);
  });

  test("writes via rename: 0600 file, no temp or lock files left behind", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX perms n/a on Windows");
      return;
    }
    const file = tmpLedgerFile();
    new SpendLedger(file).record(10);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["spend-ledger.json"]);
  });

  test("a stale lock is broken; a live lock times out and refuses", () => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const l = new SpendLedger(file);
    l.record(5);
    assert.equal(l.spentLast24h(), 5);

    fs.writeFileSync(lock, ""); // fresh lock held by "another process"
    assert.throws(() => l.record(5), /Timed out waiting for spend ledger lock/);
    fs.rmSync(lock);
  });

  test("concurrent processes never overspend the budget", async () => {
    const file = tmpLedgerFile();
    const ledgerModule = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/security/ledger.ts",
    );
    const script = `
      import { SpendLedger } from ${JSON.stringify(ledgerModule)};
      const l = new SpendLedger(${JSON.stringify(file)});
      let ok = 0;
      for (let i = 0; i < 10; i++) {
        const r = l.reserve(100, 1000);
        if (r.ok) { l.commit(r.id); ok++; }
      }
      process.stdout.write(String(ok));
    `;
    const run = () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx/esm", "--input-type=module", "-e", script],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve(Number(out)) : reject(new Error(`exit ${code}`)),
        );
      });
    const results = await Promise.all([run(), run(), run(), run()]);
    assert.equal(results.reduce((x, y) => x + y, 0), 10);
    assert.equal(new SpendLedger(file).spentLast24h(), 1000);
  });
});
