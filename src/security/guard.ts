// Spend guard
//
// Central control point for every money-moving tool. Sits between Zod
// validation and tool dispatch (see src/index.ts). Enforces, in order:
//   1. recipient allowlist
//   2. per-transaction cap (BLINK_MAX_PAYMENT_SATS)
//   3. rolling 24h daily budget (durable, BLINK_DAILY_BUDGET_SATS)
//   4. human confirmation (via MCP elicitation; otherwise fail-closed, or an
//      out-of-band stderr approval code the model cannot read)
//
// USD-wallet amounts (cents) are converted to sats before the cap and budget
// checks. Right before a payment executes, its sats are reserved in the ledger
// under a lock (reserveSpend) and committed only if the payment succeeds.
// For tools whose amount is unknown up front (l402_pay), the amount checks are
// re-run post-decode via enforceAmount()/reserveSpend() inside the handler.
//
// Webhook-changing tools (CONFIRM_TOOLS) pass the webhook URL policy and the
// same human confirmation step.
//
// Any failed check returns a structured refusal and executes NOTHING.

import crypto from "node:crypto";
import net from "node:net";
import type { SecurityConfig } from "./config.js";
import { LedgerCorruptError, type SpendLedger } from "./ledger.js";
import { decodeBolt11AmountSats } from "../bolt11.js";

// ── Spend tool classification ──────────────────────────────────────────────

/** Tools that move funds and therefore pass through the guard. */
export const SPEND_TOOLS = new Set<string>([
  // lightning
  "pay_invoice",
  "pay_invoice_with_amount",
  "pay_lightning_address",
  "pay_lnurl",
  // onchain
  "send_onchain",
  "send_onchain_all",
  "send_onchain_usd",
  // intraledger
  "send_to_wallet",
  "send_to_wallet_usd",
  "send_to_username",
  // l402
  "l402_pay",
]);

export function isSpendTool(toolName: string): boolean {
  return SPEND_TOOLS.has(toolName);
}

/**
 * Non-spend tools that change where account data goes and therefore need the
 * same human confirmation as spends. A prompt-injected add_webhook would turn
 * the account callback into a persistent payment-metadata exfiltration channel;
 * remove_webhook silently cuts the operator's own notifications.
 */
export const CONFIRM_TOOLS = new Set<string>(["add_webhook", "remove_webhook"]);

/** True for every tool that must pass through the guard before executing. */
export function requiresGuard(toolName: string): boolean {
  return SPEND_TOOLS.has(toolName) || CONFIRM_TOOLS.has(toolName);
}

export type SpendCurrency = "BTC" | "USD";

export interface SpendIntent {
  /**
   * Amount in the unit of `currency` (sats for BTC, cents for USD), or null
   * when it cannot be known up front.
   */
  amount: number | null;
  /** Unit of `amount`. Defaults to BTC (sats) when omitted. */
  currency?: SpendCurrency;
  /** Best-effort recipient identifier for allowlist checks, or null. */
  recipient: string | null;
  /** True when the tool sweeps the whole balance (unbounded amount). */
  isSweep: boolean;
  /**
   * True when the amount SHOULD be knowable up front but could not be derived
   * (e.g. an undecodable / amountless bolt11 passed to pay_invoice). Signals
   * evaluateSpend to refuse rather than pay past an unenforceable cap. Distinct
   * from tools whose amount is legitimately discovered mid-call (l402_pay).
   */
  undecodable?: boolean;
}

/**
 * Extract the spend intent from validated tool args. Amount is null when the
 * tool cannot express one up front (open invoices, LNURL, sweeps, l402_pay) —
 * those are treated as unbounded and always require confirmation.
 */
export function extractSpendIntent(
  toolName: string,
  args: Record<string, unknown>,
): SpendIntent {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  switch (toolName) {
    case "pay_invoice": {
      // Amount is embedded in the bolt11 and IS knowable up front, so decode it
      // and subject it to the same caps/budget as any other spend. If decoding
      // fails (amountless/open invoice, unknown prefix), flag it undecodable so
      // the guard refuses rather than bypassing a configured cap.
      const paymentRequest = str(args.payment_request);
      const decoded = paymentRequest
        ? decodeBolt11AmountSats(paymentRequest)
        : null;
      return {
        amount: decoded,
        recipient: paymentRequest,
        isSweep: false,
        undecodable: decoded === null,
      };
    }
    // The handler always pays via the BTC no-amount mutation, so the amount is sats.
    case "pay_invoice_with_amount":
      return { amount: num(args.amount), recipient: str(args.payment_request), isSweep: false };
    case "pay_lightning_address":
      return { amount: num(args.amount), recipient: str(args.ln_address), isSweep: false };
    case "pay_lnurl":
      return { amount: num(args.amount), recipient: str(args.lnurl), isSweep: false };
    case "send_onchain":
      return { amount: num(args.amount), currency: "BTC", recipient: str(args.address), isSweep: false };
    case "send_onchain_usd":
      return { amount: num(args.amount), currency: "USD", recipient: str(args.address), isSweep: false };
    case "send_onchain_all":
      return { amount: null, recipient: str(args.address), isSweep: true };
    case "send_to_wallet":
      return { amount: num(args.amount), currency: "BTC", recipient: str(args.recipient_wallet_id), isSweep: false };
    case "send_to_wallet_usd":
      return { amount: num(args.amount), currency: "USD", recipient: str(args.recipient_wallet_id), isSweep: false };
    case "send_to_username":
      return {
        amount: num(args.amount),
        currency: args.wallet_currency === "USD" ? "USD" : "BTC",
        recipient: str(args.username),
        isSweep: false,
      };
    case "l402_pay":
      // Price is discovered during the call; unknown up front.
      return { amount: null, recipient: str(args.url), isSweep: false };
    default:
      return { amount: null, recipient: null, isSweep: false };
  }
}

// ── Out-of-band approval code store (stderr-code mode) ──────────────────────

interface PendingApproval {
  code: string;
  toolName: string;
  argsHash: string;
  expiresAt: number;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000;

/**
 * Holds one-time approval codes for the stderr-code fallback. The code is
 * printed to the server's stderr (NOT returned to the model), so an injected
 * agent loop cannot read it — only a human watching the server console can.
 */
export class ApprovalCodeStore {
  private pending = new Map<string, PendingApproval>();

  constructor(private now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [key, p] of this.pending) {
      if (p.expiresAt <= t) this.pending.delete(key);
    }
  }

  private key(toolName: string, argsHash: string): string {
    return `${toolName}:${argsHash}`;
  }

  /** Issue (or reissue) a code for this exact request. Returns the code. */
  issue(toolName: string, argsHash: string): string {
    this.prune();
    // 8 hex chars is enough entropy for a short-lived, human-typed code.
    const code = crypto.randomBytes(4).toString("hex");
    this.pending.set(this.key(toolName, argsHash), {
      code,
      toolName,
      argsHash,
      expiresAt: this.now() + APPROVAL_TTL_MS,
    });
    return code;
  }

  /** Single-use, constant-time check that the supplied code matches. */
  consume(code: string, toolName: string, argsHash: string): boolean {
    this.prune();
    const k = this.key(toolName, argsHash);
    const p = this.pending.get(k);
    if (!p) return false;
    this.pending.delete(k);
    if (p.expiresAt <= this.now()) return false;
    const a = Buffer.from(p.code);
    const b = Buffer.from(code);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

/** Stable hash of the spend args, excluding the approval_code field itself. */
export function hashArgs(args: Record<string, unknown>): string {
  const { approval_code: _omit, ...rest } = args;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ── Guard decision ─────────────────────────────────────────────────────────

export type GuardDecision =
  | {
      action: "allow";
      /** The spend amount in sats, when known (null for non-spend tools). */
      amountSats: number | null;
    }
  | { action: "deny"; reason: string }
  | {
      action: "confirm";
      summary: string;
      amountSats: number | null;
    };

/** Converts a USD-cent amount to sats at the current rate. */
export type CentsToSats = (cents: number) => Promise<number>;

export interface GuardContext {
  config: SecurityConfig;
  ledger: SpendLedger;
  /**
   * Converts USD-wallet amounts so they are checked against the sat-denominated
   * caps and budget. When absent or failing, USD amounts are unknown in sats.
   */
  toSats?: CentsToSats;
}

function allowlistKey(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Enforce the per-transaction cap and rolling 24h budget for a KNOWN amount.
 * Used both pre-dispatch (for tools that carry an amount) and post-decode (for
 * l402_pay, whose amount is only known after fetching the invoice). This is the
 * single authoritative amount gate — no tool may bypass BLINK_MAX_PAYMENT_SATS
 * or BLINK_DAILY_BUDGET_SATS.
 */
export function enforceAmount(
  ctx: GuardContext,
  amount: number,
): { ok: true } | { ok: false; reason: string } {
  const { config, ledger } = ctx;
  if (config.maxPaymentSats !== null && amount > config.maxPaymentSats) {
    return {
      ok: false,
      reason: `Amount ${amount} sats exceeds per-transaction cap BLINK_MAX_PAYMENT_SATS=${config.maxPaymentSats}. Refusing.`,
    };
  }
  if (config.dailyBudgetSats !== null) {
    let already: number;
    try {
      already = ledger.spentLast24h();
    } catch (err) {
      return { ok: false, reason: ledgerFailureReason(err) };
    }
    if (already + amount > config.dailyBudgetSats) {
      return {
        ok: false,
        reason: budgetExceededReason(amount, config.dailyBudgetSats, already),
      };
    }
  }
  return { ok: true };
}

function budgetExceededReason(amount: number, budget: number, already: number): string {
  return `Amount ${amount} sats would exceed the 24h budget BLINK_DAILY_BUDGET_SATS=${budget} (already spent ${already}). Refusing.`;
}

function ledgerFailureReason(err: unknown): string {
  return err instanceof LedgerCorruptError
    ? err.message
    : `Spend ledger unavailable (${(err as Error).message}). Refusing.`;
}

export type Reserved =
  | { ok: true; commit: () => void; release: () => void }
  | { ok: false; reason: string };

/**
 * Atomically check the 24h budget and reserve `amountSats` in the ledger right
 * before a payment executes, so concurrent spends cannot both pass a stale
 * budget check. The caller must commit() on a successful payment and release()
 * otherwise. With no budget configured, ledger failures do not block the spend
 * (the ledger is then informational only) and are reported via `warn`.
 */
export function reserveSpend(
  ctx: GuardContext,
  amountSats: number,
  warn: (line: string) => void = () => {},
): Reserved {
  const budget = ctx.config.dailyBudgetSats;
  try {
    const res = ctx.ledger.reserve(amountSats, budget);
    if (!res.ok) {
      return { ok: false, reason: budgetExceededReason(amountSats, budget as number, res.spent) };
    }
    return {
      ok: true,
      commit: () => ctx.ledger.commit(res.id),
      release: () => ctx.ledger.release(res.id),
    };
  } catch (err) {
    if (budget !== null) return { ok: false, reason: ledgerFailureReason(err) };
    warn(`[spend-ledger] ${(err as Error).message}`);
    return { ok: true, commit: () => {}, release: () => {} };
  }
}

/**
 * Resolve an intent's amount in sats. BTC amounts pass through; USD cents are
 * converted via ctx.toSats (rounded up). Returns null when the amount is
 * unknown or the conversion is unavailable.
 */
async function amountInSats(
  ctx: GuardContext,
  intent: SpendIntent,
): Promise<number | null> {
  if (intent.amount === null) return null;
  if ((intent.currency ?? "BTC") === "BTC") return intent.amount;
  if (!ctx.toSats) return null;
  try {
    const sats = await ctx.toSats(intent.amount);
    return Number.isFinite(sats) && sats >= 0 ? Math.ceil(sats) : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate allowlist + caps + budget for a spend. Does NOT handle confirmation
 * (that requires client interaction) — returns "confirm" when the caller must
 * obtain human approval, or "allow"/"deny" otherwise. USD-cent amounts are
 * converted to sats before being compared with the sat-denominated caps.
 */
export async function evaluateSpend(
  ctx: GuardContext,
  toolName: string,
  intent: SpendIntent,
): Promise<GuardDecision> {
  const { config } = ctx;

  // 1. Recipient allowlist (all recipient types).
  if (config.recipientAllowlist.size > 0) {
    if (!intent.recipient) {
      return {
        action: "deny",
        reason:
          "Recipient allowlist is configured but this call has no resolvable recipient. Refusing.",
      };
    }
    if (!config.recipientAllowlist.has(allowlistKey(intent.recipient))) {
      return {
        action: "deny",
        reason: `Recipient "${intent.recipient}" is not in BLINK_RECIPIENT_ALLOWLIST. Refusing.`,
      };
    }
  }

  // 2 & 3. Cap and budget checks.
  const capsConfigured =
    config.maxPaymentSats !== null || config.dailyBudgetSats !== null;

  const amountSats = await amountInSats(ctx, intent);

  if (amountSats !== null) {
    // Amount known up front → enforce the cap/budget now (in sats).
    const amountCheck = enforceAmount(ctx, amountSats);
    if (!amountCheck.ok) {
      return { action: "deny", reason: amountCheck.reason };
    }
  } else if (intent.amount !== null && capsConfigured) {
    // A USD amount we could not convert: comparing cents to sat caps would
    // under-enforce them, so refuse.
    return {
      action: "deny",
      reason:
        "A spend cap is configured but this USD amount could not be converted to sats to check it. Refusing rather than bypassing the cap.",
    };
  } else if (capsConfigured) {
    // Amount is null with a cap configured. There are three cases:
    if (intent.undecodable) {
      // Should have been knowable (e.g. undecodable bolt11) but wasn't. We
      // cannot enforce the cap, so refuse rather than pay past it.
      return {
        action: "deny",
        reason:
          "A spend cap is configured but this invoice's amount could not be decoded. Refusing rather than bypassing the cap.",
      };
    }
    if (intent.isSweep) {
      // Full-balance sweep: amount is the entire wallet balance, which cannot
      // be verified against a per-tx cap or budget. Refuse when caps are set.
      return {
        action: "deny",
        reason:
          "A spend cap is configured, but a full-balance sweep cannot be verified against it. Refusing.",
      };
    }
    // Amount is legitimately discovered mid-call (l402_pay). enforceAmount() is
    // re-run post-decode inside the handler; require confirmation here so a
    // human is in the loop, and refuse if confirmation is disabled.
    if (!config.requireConfirmation) {
      return {
        action: "deny",
        reason:
          "Amount is unknown up front and a spend cap is configured, but confirmation is disabled. Refusing rather than bypassing the cap.",
      };
    }
  }

  // 4. Confirmation.
  if (config.requireConfirmation) {
    return {
      action: "confirm",
      summary: describeSpend(toolName, intent, amountSats),
      amountSats,
    };
  }

  return { action: "allow", amountSats };
}

/**
 * Evaluate a webhook-changing tool (CONFIRM_TOOLS). add_webhook must pass the
 * URL policy first; both then require human confirmation like a spend.
 */
export function evaluateWebhook(
  ctx: GuardContext,
  toolName: string,
  args: Record<string, unknown>,
): GuardDecision {
  let summary: string;
  if (toolName === "add_webhook") {
    const url = typeof args.url === "string" ? args.url : "";
    const check = checkWebhookUrl(url, ctx.config.webhookAllowlist);
    if (!check.ok) return { action: "deny", reason: check.reason };
    summary = `Tool "add_webhook" will register ${url} as a callback endpoint for this account. It will receive a notification for every payment sent or received.`;
  } else {
    summary = `Tool "remove_webhook" will delete webhook endpoint ${String(args.id)}; it will stop receiving payment notifications.`;
  }
  if (ctx.config.requireConfirmation) {
    return { action: "confirm", summary, amountSats: null };
  }
  return { action: "allow", amountSats: null };
}

// ── Webhook validation ─────────────────────────────────────────────────────

export type WebhookCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a webhook callback URL: must be HTTPS to a DNS hostname (no IP
 * literals or localhost), and (when an allowlist is configured) its hostname
 * must be allowlisted. Prevents prompt-injected registration of an attacker
 * endpoint as the account's payment callback.
 */
export function checkWebhookUrl(
  rawUrl: string,
  allowlist: Set<string>,
): WebhookCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid webhook URL: ${rawUrl}` };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Webhook URL must use https (got ${url.protocol}).`,
    };
  }
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(bare) || bare.includes(":")) {
    return {
      ok: false,
      reason: `Webhook URL must use a DNS hostname, not an IP address (got ${host}).`,
    };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Webhook URL must not point at localhost." };
  }
  if (allowlist.size > 0 && !allowlist.has(host)) {
    return {
      ok: false,
      reason: `Webhook host "${host}" is not in BLINK_WEBHOOK_ALLOWLIST.`,
    };
  }
  return { ok: true };
}

export function describeSpend(
  toolName: string,
  intent: SpendIntent,
  amountSats: number | null = null,
): string {
  const usd = (intent.currency ?? "BTC") === "USD";
  const amount = intent.isSweep
    ? "ENTIRE WALLET BALANCE (sweep)"
    : intent.amount === null
      ? "an amount determined during execution"
      : !usd
        ? `${intent.amount} sats`
        : amountSats !== null
          ? `${intent.amount} USD cents (≈${amountSats} sats)`
          : `${intent.amount} USD cents`;
  const recipient = intent.recipient ?? "an unspecified recipient";
  return `Tool "${toolName}" will send ${amount} to ${recipient}.`;
}

// ── Confirmation orchestration ─────────────────────────────────────────────

export type ConfirmationResult =
  | { status: "approved" }
  | { status: "rejected"; reason: string }
  // Awaiting an out-of-band approval code (stderr-code mode). The payload is
  // returned to the model; it deliberately does NOT contain the code.
  | { status: "pending"; payload: Record<string, unknown> };

/**
 * Prompt the user inline via MCP elicitation. Returns true if approved.
 * Injected by the caller so the guard stays free of MCP SDK types.
 */
export type ElicitApproval = (summary: string) => Promise<boolean>;

export interface ConfirmSpendDeps {
  /** Inline elicitation callback when the client supports it, else null. */
  elicit: ElicitApproval | null;
  /** Store for out-of-band approval codes (stderr-code mode). */
  approvals: ApprovalCodeStore;
  /** Writes a line to the server's stderr (not visible to the model). */
  printToStderr: (line: string) => void;
  approvalMode: SecurityConfig["approvalMode"];
}

/**
 * Obtain human confirmation for a spend.
 *
 * Path A — client supports elicitation (`elicit` provided): prompt inline and
 * block on the answer. This is the preferred, injection-safe path.
 *
 * Path B — no elicitation. A model-visible token is NOT a human boundary
 * (a prompt-injected loop could just echo it back), so:
 *   - approvalMode "fail-closed" (default): refuse.
 *   - approvalMode "stderr-code": print a one-time code to the SERVER STDERR
 *     (which the model cannot read) and require the human to echo it back via
 *     approval_code. The code never enters model context.
 */
export async function confirmSpend(
  deps: ConfirmSpendDeps,
  toolName: string,
  args: Record<string, unknown>,
  summary: string,
): Promise<ConfirmationResult> {
  if (deps.elicit) {
    const approved = await deps.elicit(summary);
    if (approved) return { status: "approved" };
    return {
      status: "rejected",
      reason: "Payment was not approved by the user.",
    };
  }

  if (deps.approvalMode === "fail-closed") {
    return {
      status: "rejected",
      reason:
        "This MCP client cannot obtain human approval (no elicitation support), and BLINK_APPROVAL_MODE is fail-closed. Refusing the payment. Use an elicitation-capable client, or set BLINK_APPROVAL_MODE=stderr-code to approve via the server console.",
    };
  }

  // stderr-code mode.
  const argsHash = hashArgs(args);
  const supplied =
    typeof args.approval_code === "string" ? args.approval_code : "";
  if (supplied && deps.approvals.consume(supplied, toolName, argsHash)) {
    return { status: "approved" };
  }

  const code = deps.approvals.issue(toolName, argsHash);
  deps.printToStderr(
    `\n[APPROVAL REQUIRED] ${summary}\n` +
      `[APPROVAL REQUIRED] To authorize, have the user re-issue this tool call with approval_code="${code}" (valid 5 min).\n`,
  );
  return {
    status: "pending",
    payload: {
      success: false,
      requires_approval: true,
      summary,
      message:
        "A one-time approval code was printed to the server console (stderr). Ask the human operator to read it from the console and re-issue this exact tool call with that approval_code. The code is NOT included in this response and cannot be obtained from tool output.",
    },
  };
}
