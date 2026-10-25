/**
 * Tests for the add_webhook / remove_webhook handlers with a fake Blink
 * client. (The guard in front of them is covered in gate.test.ts.)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { handleWebhookTool } from "../src/tools/webhooks.ts";

type Client = Parameters<typeof handleWebhookTool>[0];

function client(response: Record<string, unknown>) {
  const calls: unknown[] = [];
  const c = {
    addCallbackEndpoint: async (url: string) => {
      calls.push(["add", url]);
      return { callbackEndpointAdd: response };
    },
    deleteCallbackEndpoint: async (id: string) => {
      calls.push(["delete", id]);
      return { callbackEndpointDelete: response };
    },
  } as unknown as Client;
  return { c, calls };
}

describe("add_webhook handler", () => {
  test("registers an allowed endpoint", async () => {
    const { c, calls } = client({ id: "cb-1", errors: [] });
    const r = (await handleWebhookTool(c, "add_webhook", { url: "https://hooks.example.com/cb" })) as {
      success: boolean;
      data: { id: string };
    };
    assert.equal(r.success, true);
    assert.equal(r.data.id, "cb-1");
    assert.deepEqual(calls, [["add", "https://hooks.example.com/cb"]]);
  });

  test("re-checks the URL policy defensively and never calls the API", async () => {
    const { c, calls } = client({ id: "x", errors: [] });
    const r = (await handleWebhookTool(c, "add_webhook", { url: "https://127.0.0.1/cb" })) as { success: boolean };
    assert.equal(r.success, false);
    assert.equal(calls.length, 0);
  });

  test("surfaces API errors", async () => {
    const { c } = client({ errors: [{ message: "limit reached" }] });
    const r = (await handleWebhookTool(c, "add_webhook", { url: "https://hooks.example.com/cb" })) as {
      success: boolean;
      errors: unknown[];
    };
    assert.equal(r.success, false);
    assert.equal(r.errors.length, 1);
  });
});

describe("remove_webhook handler", () => {
  test("removes an endpoint", async () => {
    const { c, calls } = client({ success: true, errors: [] });
    const r = (await handleWebhookTool(c, "remove_webhook", { id: "cb-1" })) as {
      success: boolean;
      data: { removed: boolean };
    };
    assert.equal(r.success, true);
    assert.equal(r.data.removed, true);
    assert.deepEqual(calls, [["delete", "cb-1"]]);
  });

  test("surfaces API errors", async () => {
    const { c } = client({ success: false, errors: [{ message: "not found" }] });
    const r = (await handleWebhookTool(c, "remove_webhook", { id: "nope" })) as { success: boolean };
    assert.equal(r.success, false);
  });
});
