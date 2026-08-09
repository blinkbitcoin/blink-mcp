// Security configuration
//
// Parses the security-related environment variables in one place so the guard
// layer has a single, well-typed source of truth. All controls are
// safe-by-default: absent env vars produce the most restrictive sane behaviour
// (confirmation ON), never an open door.

export interface SecurityConfig {
  /** Require human confirmation before executing any spend tool. */
  requireConfirmation: boolean;
  /** Per-transaction cap in sats. null = no per-tx cap (confirmation still applies). */
  maxPaymentSats: number | null;
  /** Rolling 24h spend cap in sats. null = no daily cap. */
  dailyBudgetSats: number | null;
  /**
   * Allowed recipients (ln addresses, usernames, btc addresses, wallet ids).
   * Empty set = no allowlist restriction (confirmation + caps still apply).
   * Matching is exact and case-insensitive.
   */
  recipientAllowlist: Set<string>;
  /**
   * Allowed webhook hostnames (exact, case-insensitive).
   * Empty set = no domain restriction (confirmation still applies).
   */
  webhookAllowlist: Set<string>;
  /** Mandatory default max for l402_pay in sats when the caller omits one. */
  l402MaxSats: number;
  /**
   * Allowed hostnames for L402 outbound fetches (exact, case-insensitive).
   * Empty set = any public host allowed (HTTPS + non-private-IP still enforced).
   */
  l402HostAllowlist: Set<string>;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid numeric security setting "${raw}": must be a positive integer.`,
    );
  }
  return n;
}

function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(
    `Invalid boolean security setting "${raw}": use true/false.`,
  );
}

const DEFAULT_L402_MAX_SATS = 1000;

export function loadSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecurityConfig {
  const l402MaxSats =
    parsePositiveInt(env.BLINK_L402_MAX_SATS) ?? DEFAULT_L402_MAX_SATS;

  return {
    requireConfirmation: parseBool(env.BLINK_REQUIRE_CONFIRMATION, true),
    maxPaymentSats: parsePositiveInt(env.BLINK_MAX_PAYMENT_SATS),
    dailyBudgetSats: parsePositiveInt(env.BLINK_DAILY_BUDGET_SATS),
    recipientAllowlist: parseList(env.BLINK_RECIPIENT_ALLOWLIST),
    webhookAllowlist: parseList(env.BLINK_WEBHOOK_ALLOWLIST),
    l402MaxSats,
    l402HostAllowlist: parseList(env.BLINK_L402_HOST_ALLOWLIST),
  };
}
