/**
 * Tests for Lightning tool handlers (blink-mcp).
 *
 * Covers:
 *   - pay_invoice_with_amount: BTC wallets only (blink-wip#1821)
 *
 * Uses a fake BlinkClient; does NOT make any network calls.
 *
 * Run: node --import tsx/esm --test test/lightning.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleLightningTool, lightningTools } from "../src/tools/lightning.js";

type Client = Parameters<typeof handleLightningTool>[0];

function makeClient(walletCurrency: "BTC" | "USD") {
  const calls: string[] = [];
  const client = {
    async getWalletById(walletId: string) {
      calls.push("getWalletById");
      return { me: { defaultAccount: { walletById: { id: walletId, walletCurrency } } } };
    },
    async payLnNoAmountInvoice() {
      calls.push("payLnNoAmountInvoice");
      return { lnNoAmountInvoicePaymentSend: { status: "SUCCESS", transaction: { id: "tx1" }, errors: [] } };
    },
    async payLnNoAmountUsdInvoice() {
      calls.push("payLnNoAmountUsdInvoice");
      return { lnNoAmountUsdInvoicePaymentSend: { status: "SUCCESS", transaction: { id: "tx1" }, errors: [] } };
    },
  } as unknown as Client;
  return { client, calls };
}

const args = { wallet_id: "w1", payment_request: "lnbc1open", amount: 500 };

describe("pay_invoice_with_amount", () => {
  it("pays from a BTC wallet with the BTC mutation", async () => {
    const { client, calls } = makeClient("BTC");
    const result = (await handleLightningTool(client, "pay_invoice_with_amount", args)) as {
      success: boolean;
    };
    assert.equal(result.success, true);
    assert.deepEqual(calls, ["getWalletById", "payLnNoAmountInvoice"]);
  });

  it("refuses a USD wallet without sending a payment", async () => {
    const { client, calls } = makeClient("USD");
    const result = (await handleLightningTool(client, "pay_invoice_with_amount", args)) as {
      success: boolean;
      error: string;
    };
    assert.equal(result.success, false);
    assert.match(result.error, /BTC wallet/);
    assert.deepEqual(calls, ["getWalletById"]);
  });

  it("describes the amount as satoshis only", () => {
    const schema = lightningTools.pay_invoice_with_amount.inputSchema;
    assert.doesNotMatch(schema.shape.amount.description ?? "", /cents|USD/);
  });
});
