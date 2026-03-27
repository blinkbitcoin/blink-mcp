/**
 * Tests for zodToJsonSchema / zodFieldToJsonSchema converters.
 *
 * These functions live in src/index.ts as module-level helpers.
 * We re-implement them here as thin copies so they can be tested in isolation
 * without spinning up the MCP server (which calls process.exit if BLINK_API_KEY
 * is not set).
 *
 * The tests verify the JSON Schema output that the server sends to MCP clients.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// ── Inline re-implementation (must stay in sync with src/index.ts) ─────────────

function zodFieldToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodOptional) {
    return zodFieldToJsonSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    const inner = zodFieldToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (schema.description) result.description = schema.description;
    return result;
  }
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }
  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }
  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: schema._def.values,
      description: schema.description,
    };
  }
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodFieldToJsonSchema(schema._def.type),
      description: schema.description,
    };
  }
  return { type: "string" };
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      properties[key] = zodFieldToJsonSchema(zodValue);
      if (
        !(zodValue instanceof z.ZodOptional) &&
        !(zodValue instanceof z.ZodDefault)
      ) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }
  return { type: "object", properties: {} };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("zodToJsonSchema", () => {
  test("empty object schema", () => {
    const schema = z.object({});
    const result = zodToJsonSchema(schema);
    assert.equal(result.type, "object");
    assert.deepEqual(result.properties, {});
    assert.equal(result.required, undefined);
  });

  test("required string field appears in required array", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    assert.deepEqual(result.required, ["name"]);
    assert.deepEqual((result.properties as Record<string, unknown>).name, {
      type: "string",
    });
  });

  test("optional field is NOT in required array", () => {
    const schema = z.object({
      name: z.string(),
      memo: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    assert.deepEqual(result.required, ["name"]);
  });

  test("field with .default() is NOT in required array", () => {
    const schema = z.object({
      limit: z.number().int().default(20),
    });
    const result = zodToJsonSchema(schema);
    assert.equal(result.required, undefined);
    const limitField = (result.properties as Record<string, unknown>)
      .limit as Record<string, unknown>;
    assert.equal(limitField.default, 20);
    assert.equal(limitField.type, "number");
  });

  test("non-object schema falls back to {type: object, properties: {}}", () => {
    const result = zodToJsonSchema(z.string());
    assert.deepEqual(result, { type: "object", properties: {} });
  });
});

describe("zodFieldToJsonSchema", () => {
  test("string", () => {
    assert.deepEqual(zodFieldToJsonSchema(z.string()), { type: "string" });
  });

  test("string with description", () => {
    assert.deepEqual(zodFieldToJsonSchema(z.string().describe("a wallet id")), {
      type: "string",
      description: "a wallet id",
    });
  });

  test("number", () => {
    assert.deepEqual(zodFieldToJsonSchema(z.number()), { type: "number" });
  });

  test("boolean", () => {
    assert.deepEqual(zodFieldToJsonSchema(z.boolean()), { type: "boolean" });
  });

  test("enum", () => {
    const result = zodFieldToJsonSchema(z.enum(["BTC", "USD"]));
    assert.equal(result.type, "string");
    assert.deepEqual(result.enum, ["BTC", "USD"]);
  });

  test("array of strings", () => {
    const result = zodFieldToJsonSchema(z.array(z.string()));
    assert.equal(result.type, "array");
    assert.deepEqual(result.items, { type: "string" });
  });

  test("optional unwraps inner type", () => {
    assert.deepEqual(zodFieldToJsonSchema(z.string().optional()), {
      type: "string",
    });
  });

  test("default includes default value", () => {
    const result = zodFieldToJsonSchema(z.string().default("mainnet"));
    assert.equal(result.type, "string");
    assert.equal(result.default, "mainnet");
  });

  test("default with number", () => {
    const result = zodFieldToJsonSchema(z.number().default(10));
    assert.equal(result.type, "number");
    assert.equal(result.default, 10);
  });

  test("unknown type falls back to {type: string}", () => {
    // ZodNull is not handled — should fall through to default
    const result = zodFieldToJsonSchema(z.null() as unknown as z.ZodType);
    assert.deepEqual(result, { type: "string" });
  });
});
