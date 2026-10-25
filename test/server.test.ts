/**
 * End-to-end test: spawn the real server (src/index.ts) over stdio, connect an
 * MCP SDK client, and check tools/list plus the Zod validation-error path of
 * tools/call. No Blink API request is made: invalid input is rejected first.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("server over stdio", () => {
  let client: Client;
  let home: string;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-mcp-server-"));
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx/esm", path.join(ROOT, "src/index.ts")],
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          BLINK_API_KEY: "test-key",
          BLINK_NETWORK: "staging",
          HOME: home,
        },
        stderr: "ignore",
      }),
    );
  });

  after(async () => {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("tools/list advertises object schemas without $schema", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    const tx = tools.find((t) => t.name === "get_transactions");
    assert.ok(tx);
    assert.equal(tx.inputSchema.type, "object");
    assert.equal((tx.inputSchema as Record<string, unknown>).$schema, undefined);
  });

  test("out-of-range argument returns a validation error", async () => {
    const result = await client.callTool({
      name: "get_transactions",
      arguments: { limit: 500 },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    const body = JSON.parse(text);
    assert.equal(body.success, false);
    assert.match(body.error, /^Validation error: limit: /);
  });

  test("missing required argument names the field", async () => {
    const result = await client.callTool({
      name: "get_wallet_balance",
      arguments: {},
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    const body = JSON.parse(text);
    assert.equal(body.success, false);
    assert.match(body.error, /^Validation error: wallet_id: /);
  });
});
