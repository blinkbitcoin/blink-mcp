/**
 * Tests for MCP tool definitions across all modules.
 *
 * Verifies that every tool has:
 *   - A unique name (no duplicates)
 *   - A non-empty description
 *   - A valid Zod object schema (inputSchema)
 *
 * Does NOT make any network calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { walletTools } from "../src/tools/wallet.js";
import { lightningTools } from "../src/tools/lightning.js";
import { onchainTools } from "../src/tools/onchain.js";
import { intraledgerTools } from "../src/tools/intraledger.js";
import { webhookTools } from "../src/tools/webhooks.js";
import { l402Tools } from "../src/tools/l402.js";

// Combine all tools (mirrors src/index.ts)
const allTools = {
  ...walletTools,
  ...lightningTools,
  ...onchainTools,
  ...intraledgerTools,
  ...webhookTools,
  ...l402Tools,
};

type ToolDef = {
  description: string;
  inputSchema: z.ZodType;
};

describe("tool registry", () => {
  test("all tools have unique names", () => {
    // Check that spreading didn't silently overwrite any tool
    const counts: Record<string, number> = {};
    for (const module of [
      walletTools,
      lightningTools,
      onchainTools,
      intraledgerTools,
      webhookTools,
      l402Tools,
    ]) {
      for (const name of Object.keys(module)) {
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    const duplicates = Object.entries(counts)
      .filter(([, n]) => n > 1)
      .map(([k]) => k);
    assert.deepEqual(
      duplicates,
      [],
      `Duplicate tool names: ${duplicates.join(", ")}`,
    );
  });

  test("all tools have non-empty descriptions", () => {
    for (const [name, def] of Object.entries(allTools) as [string, ToolDef][]) {
      assert.ok(
        typeof def.description === "string" &&
          def.description.trim().length > 0,
        `Tool "${name}" is missing a description`,
      );
    }
  });

  test("all tools have a ZodObject inputSchema", () => {
    for (const [name, def] of Object.entries(allTools) as [string, ToolDef][]) {
      assert.ok(
        def.inputSchema instanceof z.ZodObject,
        `Tool "${name}" inputSchema must be z.object(...)`,
      );
    }
  });

  test("inputSchema parses empty object for tools with no required fields", () => {
    const noRequiredFields = Object.entries(allTools).filter(([, def]) => {
      const schema = (def as ToolDef).inputSchema as z.ZodObject<z.ZodRawShape>;
      const required = Object.entries(schema.shape).filter(([, v]) => {
        const field = v as z.ZodType;
        return (
          !(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)
        );
      });
      return required.length === 0;
    });

    for (const [name, def] of noRequiredFields as [string, ToolDef][]) {
      const result = def.inputSchema.safeParse({});
      assert.ok(
        result.success,
        `Tool "${name}" should accept empty input: ${JSON.stringify(result)}`,
      );
    }
  });

  test("total tool count matches expected", () => {
    const count = Object.keys(allTools).length;
    // 49 original + 3 L402 consumer + 3 L402 producer/search = 55
    assert.equal(count, 55, `Expected 55 tools, got ${count}`);
  });
});

describe("wallet tools", () => {
  test("get_wallets has no required fields", () => {
    const result = walletTools.get_wallets.inputSchema.safeParse({});
    assert.ok(result.success);
  });

  test("get_wallet_balance requires wallet_id", () => {
    const schema = walletTools.get_wallet_balance.inputSchema;
    const fail = schema.safeParse({});
    assert.ok(!fail.success, "Should fail without wallet_id");
    const ok = schema.safeParse({ wallet_id: "abc123" });
    assert.ok(ok.success, "Should succeed with wallet_id");
  });

  test("get_transactions limit defaults to 20", () => {
    const schema = walletTools.get_transactions.inputSchema;
    const result = schema.safeParse({});
    assert.ok(result.success);
    const parsed = result.data as { limit: number };
    assert.equal(parsed.limit, 20);
  });

  test("get_transactions rejects limit over 100", () => {
    const schema = walletTools.get_transactions.inputSchema;
    const result = schema.safeParse({ limit: 101 });
    assert.ok(!result.success);
  });
});

describe("lightning tools", () => {
  test("create_invoice requires wallet_id and amount", () => {
    const schema = lightningTools.create_invoice.inputSchema;
    assert.ok(!schema.safeParse({}).success, "Should fail with no args");
    assert.ok(
      !schema.safeParse({ wallet_id: "abc" }).success,
      "Should fail without amount",
    );
    assert.ok(
      !schema.safeParse({ amount: 1000 }).success,
      "Should fail without wallet_id",
    );
    assert.ok(
      schema.safeParse({ wallet_id: "abc", amount: 1000 }).success,
      "Should succeed",
    );
  });

  test("create_invoice rejects zero amount", () => {
    const schema = lightningTools.create_invoice.inputSchema;
    const result = schema.safeParse({ wallet_id: "abc", amount: 0 });
    assert.ok(!result.success);
  });

  test("create_invoice_usd requires wallet_id and amount", () => {
    const schema = lightningTools.create_invoice_usd.inputSchema;
    assert.ok(schema.safeParse({ wallet_id: "abc", amount: 100 }).success);
  });
});

describe("onchain tools", () => {
  test("create_onchain_address requires wallet_id", () => {
    const schema = onchainTools.create_onchain_address.inputSchema;
    assert.ok(!schema.safeParse({}).success);
    assert.ok(schema.safeParse({ wallet_id: "abc" }).success);
  });

  test("send_onchain requires wallet_id, address, amount", () => {
    const schema = onchainTools.send_onchain.inputSchema;
    assert.ok(
      schema.safeParse({ wallet_id: "abc", address: "bc1q...", amount: 10000 })
        .success,
    );
    assert.ok(
      !schema.safeParse({ wallet_id: "abc", address: "bc1q..." }).success,
      "needs amount",
    );
  });
});

describe("intraledger tools", () => {
  test("send_to_wallet requires wallet_id, recipient_wallet_id, amount", () => {
    const schema = intraledgerTools.send_to_wallet.inputSchema;
    assert.ok(
      schema.safeParse({
        wallet_id: "a",
        recipient_wallet_id: "b",
        amount: 100,
      }).success,
    );
    assert.ok(!schema.safeParse({ wallet_id: "a", amount: 100 }).success);
  });
});
