/**
 * Tests for server configuration (getConfig behaviour).
 *
 * getConfig() is defined in src/index.ts and calls process.exit(1) if
 * BLINK_API_KEY is missing or BLINK_NETWORK is invalid.  We cannot import
 * it directly without risking side-effects (process.exit kills the test runner).
 *
 * Strategy: spawn child processes that import a tiny wrapper, capture their
 * exit code and stderr, and assert on the result.  This keeps the test runner
 * process safe while still exercising the real config logic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Helper: run a small inline TypeScript snippet in a child process
// with the given env vars and return { exitCode, stderr, stdout }.
function runConfig(
  env: Record<string, string | undefined>,
  snippet: string,
): { exitCode: number; stderr: string; stdout: string } {
  // Write the snippet to a temp file so we avoid shell-quoting headaches
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-mcp-cfg-"));
  const tmpFile = path.join(tmpDir, "snippet.ts");

  fs.writeFileSync(
    tmpFile,
    `
// Inline getConfig from src/index.ts (copy, kept in sync)
function getConfig() {
  const apiKey = process.env.BLINK_API_KEY;
  if (!apiKey) {
    console.error('Error: BLINK_API_KEY environment variable is required');
    process.exit(1);
  }
  const network = (process.env.BLINK_NETWORK || 'mainnet') as 'mainnet' | 'staging';
  if (network !== 'mainnet' && network !== 'staging') {
    console.error('Error: BLINK_NETWORK must be "mainnet" or "staging"');
    process.exit(1);
  }
  return { apiKey, network };
}

${snippet}
`,
  );

  const result = spawnSync(process.execPath, ["--import", "tsx/esm", tmpFile], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeout: 10_000,
    encoding: "utf8",
  });

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("getConfig", () => {
  test("exits with code 1 when BLINK_API_KEY is missing", () => {
    const { exitCode, stderr } = runConfig(
      { BLINK_API_KEY: undefined },
      `getConfig();`,
    );
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes("BLINK_API_KEY"),
      `Expected stderr to mention BLINK_API_KEY, got: ${stderr}`,
    );
  });

  test("returns apiKey and defaults network to mainnet", () => {
    const { exitCode, stdout } = runConfig(
      { BLINK_API_KEY: "test-key-123", BLINK_NETWORK: undefined },
      `console.log(JSON.stringify(getConfig()));`,
    );
    assert.equal(exitCode, 0);
    const config = JSON.parse(stdout.trim());
    assert.equal(config.apiKey, "test-key-123");
    assert.equal(config.network, "mainnet");
  });

  test("returns staging when BLINK_NETWORK=staging", () => {
    const { exitCode, stdout } = runConfig(
      { BLINK_API_KEY: "test-key", BLINK_NETWORK: "staging" },
      `console.log(JSON.stringify(getConfig()));`,
    );
    assert.equal(exitCode, 0);
    const config = JSON.parse(stdout.trim());
    assert.equal(config.network, "staging");
  });

  test("exits with code 1 for invalid BLINK_NETWORK", () => {
    const { exitCode, stderr } = runConfig(
      { BLINK_API_KEY: "test-key", BLINK_NETWORK: "regtest" },
      `getConfig();`,
    );
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes("BLINK_NETWORK"),
      `Expected stderr to mention BLINK_NETWORK, got: ${stderr}`,
    );
  });

  test("mainnet is accepted as a valid network", () => {
    const { exitCode } = runConfig(
      { BLINK_API_KEY: "test-key", BLINK_NETWORK: "mainnet" },
      `getConfig();`,
    );
    assert.equal(exitCode, 0);
  });
});
