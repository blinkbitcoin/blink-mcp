// Durable spend ledger
//
// The rolling 24h budget must survive server restarts, otherwise the cap is
// trivially bypassed by a crash/redeploy. Records are persisted to a
// mode-restricted file (same treatment as the L402 token store) and pruned to
// the trailing 24h window on every read.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2_000;

interface SpendRecord {
  at: number;
  /** Amount in sats. */
  amount: number;
  /** Reservation id; present on entries written by reserve(). */
  id?: string;
  /**
   * "pending" while the payment is in flight. Pending entries count toward the
   * budget: if the process dies mid-payment the funds may well have moved, so
   * the reservation is kept until it ages out of the window. Committed entries
   * (and legacy entries without a status) are plain spends.
   */
  status?: "pending";
}

export class LedgerCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(
      `Spend ledger ${file} is unreadable (${detail}). Refusing to treat it as empty — inspect or remove the file to reset the 24h budget.`,
    );
    this.name = "LedgerCorruptError";
  }
}

export type Reservation =
  | { ok: true; id: string }
  | { ok: false; spent: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * File-backed rolling 24h spend tracker, safe to share between server
 * processes.
 *
 * - Every read-modify-write runs under an exclusive lock file
 *   (`<ledger>.lock`, created with O_EXCL and holding "<pid>:<token>"), so
 *   concurrent processes cannot lose each other's updates. A holder only ever
 *   removes its own lock. Waiting is async, so a contended lock never blocks
 *   the event loop.
 * - The lock is held only across synchronous code (create → read/write ledger
 *   → remove, with no await in between), so a lock outlives its owner only if
 *   the process was hard-killed inside that window. Such a lock is never broken
 *   automatically — any check-then-remove can race a live successor — and
 *   spends are refused until the operator removes it.
 * - Writes go to a temp file that is renamed into place, so a crash never
 *   leaves a truncated ledger.
 * - A missing ledger is empty; a ledger that exists but cannot be parsed throws
 *   LedgerCorruptError instead of silently resetting the budget.
 * - reserve() checks the budget and records a pending entry in one locked step,
 *   closing the check-then-debit race between concurrent spends.
 *
 * The ledger path defaults to ~/.blink/spend-ledger.json but is injectable for
 * tests. A custom clock is also injectable.
 */
export class SpendLedger {
  private readonly file: string;
  private readonly dir: string;
  private readonly lockFile: string;

  constructor(
    filePath: string = path.join(os.homedir(), ".blink", "spend-ledger.json"),
    private readonly now: () => number = Date.now,
  ) {
    this.file = filePath;
    this.dir = path.dirname(filePath);
    this.lockFile = `${filePath}.lock`;
  }

  private read(): SpendRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new LedgerCorruptError(this.file, (err as Error).message);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LedgerCorruptError(this.file, "invalid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new LedgerCorruptError(this.file, "not an array");
    }
    for (const r of parsed) {
      if (
        !r ||
        typeof r.at !== "number" ||
        typeof r.amount !== "number" ||
        !Number.isFinite(r.amount)
      ) {
        throw new LedgerCorruptError(this.file, "malformed record");
      }
    }
    return parsed as SpendRecord[];
  }

  private write(records: SpendRecord[]): void {
    // Write-then-rename so readers never observe a partially written file.
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(records), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Pid of the lock's owner, or null if the lock content is not "<pid>:<token>". */
  private static ownerPid(content: string): number | null {
    const pid = Number(content.split(":")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  /**
   * Lock content, or null if the lock vanished (released between open and
   * read). Any other read error (EISDIR, EACCES, …) is persistent: retrying
   * would never succeed, so it fails closed.
   */
  private readLock(): string | null {
    try {
      return fs.readFileSync(this.lockFile, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new Error(
        `Spend ledger lock ${this.lockFile} cannot be read (${code ?? (err as Error).message}). Refusing to spend; fix or remove it to resume.`,
      );
    }
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${crypto.randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const content = this.readLock();
        const pid = content === null ? null : SpendLedger.ownerPid(content);
        if (pid !== null && !pidAlive(pid)) {
          throw new Error(
            `Spend ledger lock ${this.lockFile} was left by a process that is no longer running (pid ${pid}). Refusing to spend; remove the lock file to resume.`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for spend ledger lock ${this.lockFile}. Refusing to spend; if no other blink-mcp process is running, remove the lock file to resume.`,
          );
        }
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
    try {
      return fn();
    } finally {
      // Only remove the lock if it is still ours.
      try {
        if (fs.readFileSync(this.lockFile, "utf8") === token) fs.rmSync(this.lockFile);
      } catch {
        // already gone
      }
    }
  }

  private pruned(): SpendRecord[] {
    const cutoff = this.now() - DAY_MS;
    return this.read().filter((r) => r.at >= cutoff);
  }

  /** Total sats spent or reserved in the trailing 24h window. */
  spentLast24h(): number {
    return this.pruned().reduce((sum, r) => sum + r.amount, 0);
  }

  /**
   * Atomically check the budget and reserve `amount` sats. With a null budget
   * the reservation always succeeds (it still records the spend).
   */
  reserve(amount: number, budget: number | null): Promise<Reservation> {
    return this.withLock((): Reservation => {
      const records = this.pruned();
      const spent = records.reduce((sum, r) => sum + r.amount, 0);
      if (budget !== null && spent + amount > budget) {
        return { ok: false, spent };
      }
      const id = crypto.randomUUID();
      records.push({ at: this.now(), amount, id, status: "pending" });
      this.write(records);
      return { ok: true, id };
    });
  }

  /** Mark a reservation as a completed spend. */
  commit(id: string): Promise<void> {
    return this.withLock(() => {
      const records = this.pruned();
      const r = records.find((x) => x.id === id);
      if (r) delete r.status;
      this.write(records);
    });
  }

  /** Drop a reservation whose payment did not go through. */
  release(id: string): Promise<void> {
    return this.withLock(() => {
      this.write(this.pruned().filter((x) => x.id !== id));
    });
  }

  /** Persist a completed spend (no budget check). */
  async record(amount: number): Promise<void> {
    const res = await this.reserve(amount, null);
    if (res.ok) await this.commit(res.id);
  }
}
