// Spend guard
//
// Central control point for every money-moving tool. Sits between Zod
// validation and tool dispatch (see src/index.ts). Enforces, in order:
//   1. recipient allowlist
//   2. per-transaction cap
//   3. rolling 24h daily budget
//   4. human confirmation (via MCP elicitation, or a two-step confirm-token
//      fallback for clients that don't support elicitation)
//
// Any failed check returns a structured refusal and executes NOTHING.

import crypto from "node:crypto";
import type { SecurityConfig } from "./config.js";

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

export interface SpendIntent {
  /** Amount in sats/cents, or null when it cannot be known up front. */
  amount: number | null;
  /** Best-effort recipient identifier for allowlist checks, or null. */
  recipient: string | null;
  /** True when the tool sweeps the whole balance (unbounded amount). */
  isSweep: boolean;
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
    case "pay_invoice":
      // Amount is embedded in the bolt11; not known without decoding.
      return { amount: null, recipient: str(args.payment_request), isSweep: false };
    case "pay_invoice_with_amount":
      return { amount: num(args.amount), recipient: str(args.payment_request), isSweep: false };
    case "pay_lightning_address":
      return { amount: num(args.amount), recipient: str(args.ln_address), isSweep: false };
    case "pay_lnurl":
      return { amount: num(args.amount), recipient: str(args.lnurl), isSweep: false };
    case "send_onchain":
    case "send_onchain_usd":
      return { amount: num(args.amount), recipient: str(args.address), isSweep: false };
    case "send_onchain_all":
      return { amount: null, recipient: str(args.address), isSweep: true };
    case "send_to_wallet":
    case "send_to_wallet_usd":
      return { amount: num(args.amount), recipient: str(args.recipient_wallet_id), isSweep: false };
    case "send_to_username":
      return { amount: num(args.amount), recipient: str(args.username), isSweep: false };
    case "l402_pay":
      // Price is discovered during the call; unknown up front.
      return { amount: null, recipient: str(args.url), isSweep: false };
    default:
      return { amount: null, recipient: null, isSweep: false };
  }
}

// ── Rolling 24h budget tracker ─────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export class DailyBudgetTracker {
  private spends: Array<{ at: number; amount: number }> = [];

  constructor(private now: () => number = Date.now) {}

  private prune(): void {
    const cutoff = this.now() - DAY_MS;
    this.spends = this.spends.filter((s) => s.at >= cutoff);
  }

  spentLast24h(): number {
    this.prune();
    return this.spends.reduce((sum, s) => sum + s.amount, 0);
  }

  record(amount: number): void {
    this.spends.push({ at: this.now(), amount });
  }
}

// ── Confirm-token store (two-step fallback) ────────────────────────────────

interface PendingConfirmation {
  toolName: string;
  argsHash: string;
  expiresAt: number;
}

const CONFIRM_TTL_MS = 5 * 60 * 1000;

export class ConfirmTokenStore {
  private pending = new Map<string, PendingConfirmation>();

  constructor(private now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt <= t) this.pending.delete(token);
    }
  }

  issue(toolName: string, argsHash: string): string {
    this.prune();
    const token = crypto.randomBytes(16).toString("hex");
    this.pending.set(token, {
      toolName,
      argsHash,
      expiresAt: this.now() + CONFIRM_TTL_MS,
    });
    return token;
  }

  /** Single-use: consumes the token. Returns true only on an exact, live match. */
  consume(token: string, toolName: string, argsHash: string): boolean {
    this.prune();
    const p = this.pending.get(token);
    if (!p) return false;
    this.pending.delete(token);
    if (p.expiresAt <= this.now()) return false;
    return p.toolName === toolName && p.argsHash === argsHash;
  }
}

/** Stable hash of the spend args, excluding the confirm_token field itself. */
export function hashArgs(args: Record<string, unknown>): string {
  const { confirm_token: _omit, ...rest } = args;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ── Guard decision ─────────────────────────────────────────────────────────

export type GuardDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | {
      action: "confirm";
      summary: string;
      intent: SpendIntent;
    };

export interface GuardContext {
  config: SecurityConfig;
  budget: DailyBudgetTracker;
}

function allowlistKey(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Evaluate allowlist + caps + budget for a spend. Does NOT handle confirmation
 * (that requires async client interaction) — returns "confirm" when the caller
 * must obtain human approval, or "allow"/"deny" for the synchronous checks.
 */
export function evaluateSpend(
  ctx: GuardContext,
  toolName: string,
  intent: SpendIntent,
): GuardDecision {
  const { config, budget } = ctx;

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

  // 2 & 3. Cap and budget checks only apply when the amount is known.
  if (intent.amount !== null) {
    if (config.maxPaymentSats !== null && intent.amount > config.maxPaymentSats) {
      return {
        action: "deny",
        reason: `Amount ${intent.amount} exceeds per-transaction cap BLINK_MAX_PAYMENT_SATS=${config.maxPaymentSats}. Refusing.`,
      };
    }
    if (config.dailyBudgetSats !== null) {
      const projected = budget.spentLast24h() + intent.amount;
      if (projected > config.dailyBudgetSats) {
        return {
          action: "deny",
          reason: `Amount ${intent.amount} would exceed the 24h budget BLINK_DAILY_BUDGET_SATS=${config.dailyBudgetSats} (already spent ${budget.spentLast24h()}). Refusing.`,
        };
      }
    }
  } else if (config.maxPaymentSats !== null || config.dailyBudgetSats !== null) {
    // Unknown amount + a configured cap: cannot verify, so force confirmation.
    // (Never silently bypass a budget on an undecodable amount.)
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
      summary: describeSpend(toolName, intent),
      intent,
    };
  }

  return { action: "allow" };
}

// ── Webhook validation ─────────────────────────────────────────────────────

export type WebhookCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a webhook callback URL: must be HTTPS, and (when an allowlist is
 * configured) its hostname must be allowlisted. Prevents prompt-injected
 * registration of an attacker endpoint as the account's payment callback.
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
  if (allowlist.size > 0 && !allowlist.has(host)) {
    return {
      ok: false,
      reason: `Webhook host "${host}" is not in BLINK_WEBHOOK_ALLOWLIST.`,
    };
  }
  return { ok: true };
}

export function describeSpend(toolName: string, intent: SpendIntent): string {
  const amount = intent.isSweep
    ? "ENTIRE WALLET BALANCE (sweep)"
    : intent.amount !== null
      ? `${intent.amount} (sats/cents)`
      : "an amount determined during execution";
  const recipient = intent.recipient ?? "an unspecified recipient";
  return `Tool "${toolName}" will send ${amount} to ${recipient}.`;
}

// ── Confirmation orchestration ─────────────────────────────────────────────

export type ConfirmationResult =
  | { status: "approved" }
  | { status: "rejected"; reason: string }
  | { status: "pending"; payload: Record<string, unknown> };

/**
 * Prompt the user inline via MCP elicitation. Returns true if approved.
 * Injected by the caller so the guard stays free of MCP SDK types.
 */
export type ElicitApproval = (summary: string) => Promise<boolean>;

/**
 * Obtain human confirmation for a spend.
 *
 * Path A — client supports elicitation (`elicit` provided): prompt inline and
 * block on the answer.
 * Path B — no elicitation (`elicit` null): two-step confirm-token. If the caller
 * supplied a valid confirm_token that matches this exact request, approve;
 * otherwise issue a fresh token and return a "pending" payload to echo back.
 */
export async function confirmSpend(
  elicit: ElicitApproval | null,
  tokens: ConfirmTokenStore,
  toolName: string,
  args: Record<string, unknown>,
  summary: string,
): Promise<ConfirmationResult> {
  if (elicit) {
    const approved = await elicit(summary);
    if (approved) return { status: "approved" };
    return {
      status: "rejected",
      reason: "Payment was not approved by the user.",
    };
  }

  // Two-step confirm-token fallback.
  const argsHash = hashArgs(args);
  const supplied = typeof args.confirm_token === "string" ? args.confirm_token : "";
  if (supplied && tokens.consume(supplied, toolName, argsHash)) {
    return { status: "approved" };
  }

  const token = tokens.issue(toolName, argsHash);
  return {
    status: "pending",
    payload: {
      success: false,
      requires_confirmation: true,
      summary,
      confirm_token: token,
      message:
        "This is a money-moving action. To proceed, call this tool again with the SAME arguments plus the provided confirm_token. The token is single-use and expires in 5 minutes. Only do this if the user explicitly authorized the payment.",
    },
  };
}
