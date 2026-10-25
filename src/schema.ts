import { z } from "zod";

// Convert a tool's Zod input schema to JSON Schema for MCP tools/list.
// io: "input" keeps fields with defaults out of `required`; $schema is dropped
// for clients that reject unknown top-level keywords.
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete json.$schema;
  return json;
}
