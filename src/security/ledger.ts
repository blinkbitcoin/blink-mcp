// Durable spend ledger
//
// The rolling 24h budget must survive server restarts, otherwise the cap is
// trivially bypassed by a crash/redeploy. Records are persisted to a
// mode-restricted file (same treatment as the L402 token store) and pruned to
// the trailing 24h window on every read.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SpendRecord {
  at: number;
  amount: number;
}

/**
 * File-backed rolling 24h spend tracker. Reads and prunes on each query so the
 * window is always current, and writes atomically-ish (write + chmod) on record.
 *
 * The ledger path defaults to ~/.blink/spend-ledger.json but is injectable for
 * tests. A custom clock is also injectable.
 */
export class SpendLedger {
  private readonly file: string;
  private readonly dir: string;

  constructor(
    filePath: string = path.join(os.homedir(), ".blink", "spend-ledger.json"),
    private readonly now: () => number = Date.now,
  ) {
    this.file = filePath;
    this.dir = path.dirname(filePath);
  }

  private read(): SpendRecord[] {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r): r is SpendRecord =>
          r &&
          typeof r.at === "number" &&
          typeof r.amount === "number" &&
          Number.isFinite(r.amount),
      );
    } catch {
      return [];
    }
  }

  private write(records: SpendRecord[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(records), {
      encoding: "utf8",
      mode: 0o600,
    });
    // writeFileSync only applies mode on creation; enforce on existing files.
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort (e.g. non-POSIX)
    }
  }

  private pruned(): SpendRecord[] {
    const cutoff = this.now() - DAY_MS;
    return this.read().filter((r) => r.at >= cutoff);
  }

  /** Total sats spent in the trailing 24h window. */
  spentLast24h(): number {
    return this.pruned().reduce((sum, r) => sum + r.amount, 0);
  }

  /** Persist a successful spend and prune the window. */
  record(amount: number): void {
    const records = this.pruned();
    records.push({ at: this.now(), amount });
    this.write(records);
  }
}
