// Guarded tool execution
//
// The single choke point between Zod validation and tool dispatch (wired up in
// src/index.ts). Kept free of MCP SDK types so the whole flow — policy checks,
// human confirmation, budget reservation, debit-on-success — is unit-testable.

import {
  isSpendTool,
  requiresGuard,
  extractSpendIntent,
  evaluateSpend,
  evaluateWebhook,
  confirmSpend,
  reserveSpend,
  type ApprovalCodeStore,
  type GuardContext,
  type GuardDecision,
} from "./guard.js";
import type { SecurityConfig } from "./config.js";

/** What the human is being asked to approve; shapes the elicitation prompt. */
export type ApprovalKind = "payment" | "account-change";

export interface GateDeps {
  guardCtx: GuardContext;
  approvals: ApprovalCodeStore;
  /** Writes a line to the server's stderr (not visible to the model). */
  printToStderr: (line: string) => void;
  approvalMode: SecurityConfig["approvalMode"];
  /** Inline MCP elicitation when the client supports it, else null. */
  elicit: ((summary: string, kind: ApprovalKind) => Promise<boolean>) | null;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function errorResponse(error: string): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error }) }],
    isError: true,
  };
}

function jsonResponse(value: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// A handler result counts as successful when it returns { success: true }.
// Used to decide whether a reserved spend is committed or released (never debit
// on a failed/rejected payment).
export function isSuccessfulSpend(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === true
  );
}

/**
 * Run a tool through the guard. Spend tools pass allowlist + caps + budget +
 * confirmation; webhook-changing tools pass the webhook policy + confirmation;
 * everything else executes directly. Fails closed: any refusal executes nothing.
 *
 * `rawArgs` is the unvalidated request; approval_code (stderr-code mode) is
 * read from it because Zod strips unknown keys.
 */
export async function runGuarded(
  name: string,
  validatedArgs: Record<string, unknown>,
  rawArgs: Record<string, unknown>,
  deps: GateDeps,
  execute: () => Promise<unknown>,
): Promise<ToolResponse> {
  if (!requiresGuard(name)) return jsonResponse(await execute());

  const spend = isSpendTool(name);
  const decision: GuardDecision = spend
    ? await evaluateSpend(deps.guardCtx, name, extractSpendIntent(name, validatedArgs))
    : evaluateWebhook(deps.guardCtx, name, validatedArgs);

  if (decision.action === "deny") return errorResponse(decision.reason);

  if (decision.action === "confirm") {
    const kind: ApprovalKind = spend ? "payment" : "account-change";
    const elicit = deps.elicit;
    const confirmation = await confirmSpend(
      {
        elicit: elicit ? (summary) => elicit(summary, kind) : null,
        approvals: deps.approvals,
        printToStderr: deps.printToStderr,
        approvalMode: deps.approvalMode,
      },
      name,
      {
        ...validatedArgs,
        approval_code: validatedArgs.approval_code ?? rawArgs.approval_code,
      },
      decision.summary,
    );
    if (confirmation.status === "rejected") return errorResponse(confirmation.reason);
    if (confirmation.status === "pending") return jsonResponse(confirmation.payload);
    // approved → fall through to execution
  }

  // Known-amount spends reserve their sats right before executing. l402_pay
  // reserves its own decoded amount inside the handler; sweeps and webhook
  // tools have no amount to reserve.
  const amountSats = name === "l402_pay" ? null : decision.amountSats;
  if (amountSats === null) return jsonResponse(await execute());

  const reservation = reserveSpend(deps.guardCtx, amountSats, deps.printToStderr);
  if (!reservation.ok) return errorResponse(reservation.reason);

  let succeeded = false;
  try {
    const result = await execute();
    succeeded = isSuccessfulSpend(result);
    return jsonResponse(result);
  } finally {
    if (succeeded) reservation.commit();
    else reservation.release();
  }
}
