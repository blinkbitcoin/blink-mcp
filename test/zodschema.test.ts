/**
 * Tests for toolInputJsonSchema (src/schema.ts): the JSON Schema the server
 * advertises to MCP clients in tools/list.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { toolInputJsonSchema } from "../src/schema.js";
import { walletTools } from "../src/tools/wallet.js";
import { lightningTools } from "../src/tools/lightning.js";
import { onchainTools } from "../src/tools/onchain.js";
import { intraledgerTools } from "../src/tools/intraledger.js";
import { webhookTools } from "../src/tools/webhooks.js";
import { l402Tools } from "../src/tools/l402.js";

const props = (s: Record<string, unknown>) =>
  s.properties as Record<string, Record<string, unknown>>;

describe("toolInputJsonSchema", () => {
  test("empty object schema", () => {
    assert.deepEqual(toolInputJsonSchema(z.object({})), {
      type: "object",
      properties: {},
    });
  });

  test("drops the $schema keyword", () => {
    assert.equal(toolInputJsonSchema(z.object({})).$schema, undefined);
  });

  test("required string field with description", () => {
    const result = toolInputJsonSchema(
      z.object({ name: z.string().describe("a wallet id") }),
    );
    assert.deepEqual(result.required, ["name"]);
    assert.deepEqual(props(result).name, {
      type: "string",
      description: "a wallet id",
    });
  });

  test("optional field is NOT required", () => {
    const result = toolInputJsonSchema(
      z.object({ name: z.string(), cursor: z.string().optional() }),
    );
    assert.deepEqual(result.required, ["name"]);
    assert.deepEqual(props(result).cursor, { type: "string" });
  });

  test("field with .default() is NOT required and carries the default", () => {
    const result = toolInputJsonSchema(
      z.object({ limit: z.number().min(1).max(100).default(20) }),
    );
    assert.equal(result.required, undefined);
    assert.equal(props(result).limit.type, "number");
    assert.equal(props(result).limit.default, 20);
    assert.equal(props(result).limit.minimum, 1);
    assert.equal(props(result).limit.maximum, 100);
  });

  test("boolean, enum and array fields", () => {
    const result = toolInputJsonSchema(
      z.object({
        flag: z.boolean(),
        currency: z.enum(["BTC", "USD"]),
        ids: z.array(z.string()),
      }),
    );
    assert.equal(props(result).flag.type, "boolean");
    assert.equal(props(result).currency.type, "string");
    assert.deepEqual(props(result).currency.enum, ["BTC", "USD"]);
    assert.equal(props(result).ids.type, "array");
    assert.deepEqual(props(result).ids.items, { type: "string" });
  });

  test("does not forbid additional properties (approval_code is injected)", () => {
    const result = toolInputJsonSchema(z.object({ a: z.string() }));
    assert.equal(result.additionalProperties, undefined);
  });
});

describe("every registered tool converts to an object schema", () => {
  const allTools = {
    ...walletTools,
    ...lightningTools,
    ...onchainTools,
    ...intraledgerTools,
    ...webhookTools,
    ...l402Tools,
  };

  for (const [name, def] of Object.entries(allTools)) {
    test(name, () => {
      const result = toolInputJsonSchema(def.inputSchema);
      assert.equal(result.type, "object");
      assert.equal(typeof result.properties, "object");
      const required = (result.required as string[] | undefined) ?? [];
      for (const key of required) {
        assert.ok(key in props(result), `${name}: required ${key} missing`);
      }
    });
  }
});
