// Minimal BOLT11 amount decoder.
//
// Shared leaf module (imported by both the spend guard and the L402 tools) so
// the guard can enforce spend caps on fixed-amount Lightning invoices before
// paying, without creating a circular import between guard.ts and l402.ts.
//
// Parses only the amount field from the human-readable prefix; it does not
// validate the invoice signature or checksum. Returns null when no amount is
// present (open/amountless invoices) or the prefix is unrecognized.

export function decodeBolt11AmountSats(invoice: string): number | null {
  if (!invoice) return null;
  const lower = invoice.toLowerCase();
  let amountStr: string;
  if (lower.startsWith("lntbs")) amountStr = lower.slice(5);
  else if (lower.startsWith("lntb")) amountStr = lower.slice(4);
  else if (lower.startsWith("lnbc")) amountStr = lower.slice(4);
  else return null;

  const match = amountStr.match(/^(\d+)([munp]?)1/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const multiplier = match[2];
  if (isNaN(amount)) return null;

  const BTC_TO_SAT = 100_000_000;
  switch (multiplier) {
    case "":
      return amount * BTC_TO_SAT;
    case "m":
      return Math.round(amount * BTC_TO_SAT * 0.001);
    case "u":
      return Math.round(amount * BTC_TO_SAT * 0.000_001);
    case "n":
      return Math.round(amount * BTC_TO_SAT * 0.000_000_001);
    case "p":
      return Math.round(amount * BTC_TO_SAT * 0.000_000_000_001);
    default:
      return null;
  }
}
