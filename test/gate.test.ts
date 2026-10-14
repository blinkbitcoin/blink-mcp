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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadSecurityConfig } from "../src/security/config.ts";
import {
  ApprovalCodeStore,
  extractSpendIntent,
  evaluateSpend,
  describeSpend,
  reserveSpend,
  enforceAmount,
  evaluateWebhook,
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
    assert.equal(parse(res).error, "The request was not approved by the user.");
    assert.equal(exec.calls.n, 0);
  });

  test("add_webhook fails closed without elicitation (default mode)", async () => {
    const { deps } = gateDeps(ctx());
    const exec = executor();
    const res = await runGuarded("add_webhook", args, args, deps, exec.run);
    assert.equal(res.isError, true);
    assert.match(String(parse(res).error), /fail-closed/);
    assert.doesNotMatch(String(parse(res).error), /payment/i);
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

  test("no price lookup is made when no cap or budget needs it", async () => {
    let lookups = 0;
    const c = ctx({}, {
      toSats: async (cents) => {
        lookups++;
        return cents * 10;
      },
    });
    const d = await evaluateSpend(c, "send_onchain_usd", extractSpendIntent("send_onchain_usd", { amount: 5, address: "bc1q" }));
    assert.equal(d.action, "confirm");
    assert.equal(lookups, 0);
    assert.match((d as { summary: string }).summary, /5 USD cents to/);
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

  test("keeps the reservation pending when the handler throws (outcome unknown)", async () => {
    const c = ctx(noConfirm);
    await assert.rejects(() =>
      runGuarded("send_to_wallet", a, a, gateDeps(c).deps, async () => {
        throw new Error("network timeout");
      }),
    );
    assert.equal(c.ledger.spentLast24h(), 400);
  });

  test("a ledger failure after a successful payment does not report an error", async () => {
    for (const budget of [1000, null]) {
      const c = ctx({ requireConfirmation: false, dailyBudgetSats: budget });
      (c.ledger as unknown as { commit: () => Promise<never> }).commit = async () => {
        throw new Error("Timed out waiting for spend ledger lock");
      };
      const { deps, printed } = gateDeps(c);
      const res = await runGuarded("send_to_wallet", a, a, deps, executor({ success: true }).run);
      assert.equal(res.isError, undefined);
      assert.equal(parse(res).success, true);
      assert.match(printed.join(""), /could not settle reservation/);
      assert.equal(c.ledger.spentLast24h(), 400); // still pending → still counted
    }
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
  test("reserve respects the budget across instances sharing a file", async () => {
    const file = tmpLedgerFile();
    const l1 = new SpendLedger(file);
    const l2 = new SpendLedger(file);
    assert.equal((await l1.reserve(600, 1000)).ok, true);
    assert.equal((await l2.reserve(600, 1000)).ok, false);
    assert.equal((await l2.reserve(400, 1000)).ok, true);
    assert.equal(l1.spentLast24h(), 1000);
  });

  test("release frees a reservation; commit keeps it", async () => {
    const l = new SpendLedger(tmpLedgerFile());
    const a = await l.reserve(100, null);
    const b = await l.reserve(200, null);
    assert.ok(a.ok && b.ok);
    await l.release(a.id);
    await l.commit(b.id);
    assert.equal(l.spentLast24h(), 200);
  });

  test("a corrupt file throws instead of resetting the budget", () => {
    const file = tmpLedgerFile();
    fs.writeFileSync(file, "[{\"at\":1");
    assert.throws(() => new SpendLedger(file).spentLast24h(), LedgerCorruptError);
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.throws(() => new SpendLedger(file).spentLast24h(), LedgerCorruptError);
  });

  test("legacy records without status still count", async () => {
    const file = tmpLedgerFile();
    fs.writeFileSync(file, JSON.stringify([{ at: Date.now(), amount: 700 }]));
    const l = new SpendLedger(file);
    assert.equal(l.spentLast24h(), 700);
    assert.equal((await l.reserve(400, 1000)).ok, false);
  });

  test("writes via rename: 0600 file, no temp or lock files left behind", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX perms n/a on Windows");
      return;
    }
    const file = tmpLedgerFile();
    await new SpendLedger(file).record(10);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["spend-ledger.json"]);
  });

  test("an unreadable lock is broken only once it is old", async () => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const l = new SpendLedger(file);
    await l.record(5);
    assert.equal(l.spentLast24h(), 5);

    fs.writeFileSync(lock, ""); // fresh, owner may still be writing it
    await assert.rejects(() => l.record(5), /Timed out waiting for spend ledger lock/);
    fs.rmSync(lock);
  });

  test("a lock whose owner process is gone is broken immediately", async () => {
    const file = tmpLedgerFile();
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(`${file}.lock`, `${deadPid}:tok`);
    const l = new SpendLedger(file);
    await l.record(7);
    assert.equal(l.spentLast24h(), 7);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });

  test("a live owner's lock is never broken, however old", async () => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, `${process.pid}:someone-else`);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    await assert.rejects(() => new SpendLedger(file).record(1), /Timed out/);
    assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}:someone-else`);
    fs.rmSync(lock);
  });

  test("breaking a stale lock restores a live lock created in the meantime", async (t) => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(lock, `${deadPid}:stale`);
    // Another waiter breaks the stale lock and takes its own just before our
    // rename: our rename then moves THEIR lock, which must be put back.
    const realRename = fs.renameSync;
    let raced = false;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (!raced && from === lock) {
        raced = true;
        fs.writeFileSync(lock, `${process.pid}:winner`);
      }
      return realRename(from, to);
    });
    await assert.rejects(() => new SpendLedger(file).record(1), /Timed out/);
    assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}:winner`);
    fs.rmSync(lock);
  });

  test("a stale lock that vanishes before it is moved aside is simply retried", async (t) => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(lock, `${deadPid}:stale`);
    const realRename = fs.renameSync;
    let raced = false;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (!raced && from === lock) {
        raced = true;
        fs.rmSync(lock); // another waiter removed it first
      }
      return realRename(from, to);
    });
    const l = new SpendLedger(file);
    await l.record(3);
    assert.equal(l.spentLast24h(), 3);
  });

  test("when a third lock appears during the restore, it is left in place", async (t) => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(lock, `${deadPid}:stale`);
    const realRename = fs.renameSync;
    const realLink = fs.linkSync;
    let raced = false;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (!raced && from === lock) {
        raced = true;
        fs.writeFileSync(lock, `${process.pid}:second`); // moved aside by our rename
      }
      return realRename(from, to);
    });
    t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(lock, `${process.pid}:third`); // created before we restore
      return realLink(from, to);
    });
    await assert.rejects(() => new SpendLedger(file).record(1), /Timed out/);
    assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}:third`);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["spend-ledger.json.lock"]);
    fs.rmSync(lock);
  });

  test("a holder whose lock was already removed finishes cleanly", async () => {
    const file = tmpLedgerFile();
    const l = new SpendLedger(file);
    (l as unknown as { pruned: () => unknown[] }).pruned = () => {
      fs.rmSync(`${file}.lock`);
      return [];
    };
    await l.release("x");
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });

  test("a holder never removes a lock it no longer owns", async () => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    const l = new SpendLedger(file);
    // Swap the lock under the holder mid-critical-section.
    (l as unknown as { pruned: () => unknown[] }).pruned = () => {
      fs.writeFileSync(lock, "999999:other");
      return [];
    };
    await l.release("x");
    assert.equal(fs.readFileSync(lock, "utf8"), "999999:other");
    fs.rmSync(lock);
  });

  test("waiting for the lock does not block the event loop", async () => {
    const file = tmpLedgerFile();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, `${process.pid}:held`);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const release = setTimeout(() => fs.rmSync(lock, { force: true }), 200);
    try {
      await new SpendLedger(file).record(1);
    } finally {
      clearInterval(timer);
      clearTimeout(release);
      fs.rmSync(lock, { force: true });
    }
    assert.ok(ticks >= 10, `event loop ran only ${ticks} ticks while waiting`);
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
        const r = await l.reserve(100, 1000);
        if (r.ok) { await l.commit(r.id); ok++; }
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

// ── remaining gate / guard branches ───────────────────────────────────────

describe("runGuarded: spend paths", () => {
  const a = { amount: 400, recipient_wallet_id: "w2", wallet_id: "w1" };

  test("spends are confirmed with the payment prompt", async () => {
    const kinds: string[] = [];
    const c = ctx();
    const { deps } = gateDeps(c, {
      elicit: async (_s, kind) => {
        kinds.push(kind);
        return true;
      },
    });
    const res = await runGuarded("send_to_wallet", a, a, deps, executor().run);
    assert.equal(res.isError, undefined);
    assert.deepEqual(kinds, ["payment"]);
    assert.equal(c.ledger.spentLast24h(), 400);
  });

  test("l402_pay is confirmed but reserves inside its handler, not the gate", async () => {
    const c = ctx();
    const { deps } = gateDeps(c, { elicit: async () => true });
    const exec = executor();
    const args = { url: "https://x", wallet_id: "w" };
    await runGuarded("l402_pay", args, args, deps, exec.run);
    assert.equal(exec.calls.n, 1);
    assert.equal(c.ledger.spentLast24h(), 0);
  });

  test("a spend that lands during confirmation can push the reservation over budget", async () => {
    const c = ctx({ dailyBudgetSats: 1000 });
    const { deps } = gateDeps(c, {
      elicit: async () => {
        await c.ledger.record(900); // concurrent spend while the human decides
        return true;
      },
    });
    const exec = executor();
    const res = await runGuarded("send_to_wallet", a, a, deps, exec.run);
    assert.equal(res.isError, true);
    assert.match(String(parse(res).error), /already spent 900/);
    assert.equal(exec.calls.n, 0);
  });
});

describe("guard helpers: edge cases", () => {
  test("non-numeric amounts, missing invoices and unknown tools have no amount", () => {
    assert.equal(extractSpendIntent("send_onchain", { amount: "5" }).amount, null);
    const inv = extractSpendIntent("pay_invoice", {});
    assert.equal(inv.amount, null);
    assert.equal(inv.undecodable, true);
    assert.deepEqual(extractSpendIntent("get_balance", {}), { amount: null, recipient: null, isSweep: false });
  });

  test("allowlist with no resolvable recipient is denied", async () => {
    const c = ctx({ recipientAllowlist: new Set(["a@b.c"]) });
    const d = await evaluateSpend(c, "send_onchain", { amount: 1, recipient: null, isSweep: false });
    assert.equal(d.action, "deny");
  });

  test("a USD amount with no converter is denied when a cap is set", async () => {
    const c = ctx({ maxPaymentSats: 1000 });
    const d = await evaluateSpend(c, "send_onchain_usd", { amount: 1, currency: "USD", recipient: "bc1q", isSweep: false });
    assert.equal(d.action, "deny");
  });

  test("an unreadable ledger blocks enforceAmount when a budget is set", () => {
    const c = ctx({ dailyBudgetSats: 1000 });
    (c.ledger as unknown as { spentLast24h: () => number }).spentLast24h = () => {
      throw new Error("lock timeout");
    };
    const r = enforceAmount(c, 1);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Spend ledger unavailable \(lock timeout\)/);
  });

  test("reserveSpend: over budget, ledger failure with and without a budget", async () => {
    const over = ctx({ dailyBudgetSats: 100 });
    assert.equal((await reserveSpend(over, 200)).ok, false);

    const broken = (budget: number | null) => {
      const c = ctx({ dailyBudgetSats: budget });
      (c.ledger as unknown as { reserve: () => Promise<never> }).reserve = async () => {
        throw new Error("disk full");
      };
      return c;
    };
    const denied = await reserveSpend(broken(1000), 10);
    assert.equal(denied.ok, false);
    assert.match((denied as { reason: string }).reason, /disk full/);

    const warnings: string[] = [];
    const allowed = await reserveSpend(broken(null), 10, (l) => warnings.push(l));
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      await allowed.commit();
      await allowed.release();
    }
    assert.match(warnings[0], /\[spend-ledger\] disk full/);
    assert.equal((await reserveSpend(broken(null), 10)).ok, true); // default warn is a no-op
  });

  test("evaluateWebhook: missing URL is denied; confirmation off allows", () => {
    const d = evaluateWebhook(ctx(), "add_webhook", {});
    assert.equal(d.action, "deny");
    assert.match((d as { reason: string }).reason, /Invalid webhook URL/);
    const off = evaluateWebhook(ctx({ requireConfirmation: false }), "remove_webhook", { id: "x" });
    assert.deepEqual(off, { action: "allow", amountSats: null });
  });

  test("describeSpend covers unknown amounts, sweeps and missing recipients", () => {
    assert.match(
      describeSpend("l402_pay", { amount: null, recipient: null, isSweep: false }),
      /an amount determined during execution to an unspecified recipient/,
    );
    assert.match(describeSpend("send_onchain_all", { amount: null, recipient: "bc1q", isSweep: true }), /ENTIRE WALLET/);
    assert.match(
      describeSpend("send_onchain_usd", { amount: 5, currency: "USD", recipient: "bc1q", isSweep: false }),
      /5 USD cents to/,
    );
  });

  test("pay_invoice_with_amount carries its amount as sats", () => {
    const i = extractSpendIntent("pay_invoice_with_amount", { amount: 21, payment_request: "lnbc1p" });
    assert.deepEqual(i, { amount: 21, recipient: "lnbc1p", isSweep: false });
  });

  test("a code that expires between pruning and checking is refused", () => {
    // Each clock read advances time, so the entry survives prune() but is
    // expired by the time consume() checks it.
    let now = 0;
    const store = new ApprovalCodeStore(() => now);
    const code = store.issue("t", "h");
    const reads = [5 * 60 * 1000 - 1, 5 * 60 * 1000];
    (store as unknown as { now: () => number }).now = () => reads.shift() ?? now;
    assert.equal(store.consume(code, "t", "h"), false);
  });

  test("approval codes expire and must match in length", () => {
    let now = 0;
    const store = new ApprovalCodeStore(() => now);
    const code = store.issue("t", "h");
    assert.equal(store.consume(code.slice(1), "t", "h"), false); // wrong length, and single-use
    const code2 = store.issue("t", "h");
    store.issue("t", "other");
    now += 6 * 60 * 1000; // past the 5-minute TTL; prune drops both
    assert.equal(store.consume(code2, "t", "h"), false);
  });
});

describe("SpendLedger: unreadable and unwritable files", () => {
  test("malformed records are rejected", () => {
    for (const bad of [[null], [{ at: "x", amount: 1 }], [{ at: 1, amount: "1" }], [{ at: 1, amount: null }]]) {
      const file = tmpLedgerFile();
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => new SpendLedger(file).spentLast24h(), /malformed record/);
    }
  });

  test("a read error other than ENOENT is treated as corrupt", () => {
    const file = tmpLedgerFile();
    fs.mkdirSync(file); // a directory where the file should be → EISDIR
    assert.throws(() => new SpendLedger(file).spentLast24h(), LedgerCorruptError);
  });

  test("a failed write cleans up its temp file and propagates", async (t) => {
    const file = tmpLedgerFile();
    t.mock.method(fs, "renameSync", () => {
      throw new Error("EXDEV");
    });
    await assert.rejects(() => new SpendLedger(file).record(1), /EXDEV/);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
  });
});

describe("loadSecurityConfig: boolean parsing", () => {
  test("accepts truthy spellings and rejects nonsense", () => {
    assert.equal(loadSecurityConfig({ BLINK_REQUIRE_CONFIRMATION: "Yes" } as NodeJS.ProcessEnv).requireConfirmation, true);
    assert.throws(
      () => loadSecurityConfig({ BLINK_REQUIRE_CONFIRMATION: "maybe" } as NodeJS.ProcessEnv),
      /Invalid boolean security setting/,
    );
  });
});
