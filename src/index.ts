#!/usr/bin/env node

// Blink MCP Server - Main Entry Point
// A Model Context Protocol server for the Blink Bitcoin/Lightning API

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createBlinkClient, BlinkClient } from "./client.js";
import { walletTools, handleWalletTool } from "./tools/wallet.js";
import { lightningTools, handleLightningTool } from "./tools/lightning.js";
import { onchainTools, handleOnchainTool } from "./tools/onchain.js";
import {
  intraledgerTools,
  handleIntraledgerTool,
} from "./tools/intraledger.js";
import {
  webhookTools,
  handleWebhookTool,
  setSubscriptionCallback,
} from "./tools/webhooks.js";
import { l402Tools, handleL402Tool } from "./tools/l402.js";
import { loadSecurityConfig } from "./security/config.js";
import {
  isSpendTool,
  extractSpendIntent,
  evaluateSpend,
  confirmSpend,
  DailyBudgetTracker,
  ConfirmTokenStore,
  type GuardContext,
} from "./security/guard.js";
import { createRequire } from "node:module";

// Server configuration
const SERVER_NAME = "blink-mcp";
const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require("../package.json") as {
  version: string;
};

// Environment configuration
interface ServerConfig {
  apiKey: string;
  network: "mainnet" | "staging";
}

function getConfig(): ServerConfig {
  const apiKey = process.env.BLINK_API_KEY;

  if (!apiKey) {
    console.error("Error: BLINK_API_KEY environment variable is required");
    console.error("");
    console.error("To get an API key:");
    console.error(
      "1. Log in to your Blink wallet at https://dashboard.blink.sv",
    );
    console.error("2. Go to Settings > API Keys");
    console.error("3. Create a new API key with the desired permissions");
    console.error("");
    console.error("Set the environment variable:");
    console.error("  export BLINK_API_KEY=your_api_key_here");
    process.exit(1);
  }

  const network = (process.env.BLINK_NETWORK || "mainnet") as
    | "mainnet"
    | "staging";

  if (network !== "mainnet" && network !== "staging") {
    console.error('Error: BLINK_NETWORK must be "mainnet" or "staging"');
    process.exit(1);
  }

  return { apiKey, network };
}

// Combine all tools from different modules
const allTools = {
  ...walletTools,
  ...lightningTools,
  ...onchainTools,
  ...intraledgerTools,
  ...webhookTools,
  ...l402Tools,
};

// Convert Zod schema to JSON Schema for MCP
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      properties[key] = zodFieldToJsonSchema(zodValue);

      // Check if field is required (not optional)
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

function zodFieldToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Handle optional
  if (schema instanceof z.ZodOptional) {
    return zodFieldToJsonSchema(schema.unwrap());
  }

  // Handle default
  if (schema instanceof z.ZodDefault) {
    const inner = zodFieldToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }

  // Handle string
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // Handle number
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // Handle boolean
  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // Handle enum
  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: schema._def.values,
      description: schema.description,
    };
  }

  // Handle array
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodFieldToJsonSchema(schema._def.type),
      description: schema.description,
    };
  }

  // Default
  return { type: "string" };
}

// Route tool calls to appropriate handler
async function handleToolCall(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Check which module the tool belongs to
  if (toolName in walletTools) {
    return handleWalletTool(client, toolName, args);
  }
  if (toolName in lightningTools) {
    return handleLightningTool(client, toolName, args);
  }
  if (toolName in onchainTools) {
    return handleOnchainTool(client, toolName, args);
  }
  if (toolName in intraledgerTools) {
    return handleIntraledgerTool(client, toolName, args);
  }
  if (toolName in webhookTools) {
    return handleWebhookTool(client, toolName, args);
  }
  if (toolName in l402Tools) {
    return handleL402Tool(client, toolName, args);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
}

// Main server setup
async function main() {
  // Get configuration
  const config = getConfig();

  // Create Blink client
  const blinkClient = createBlinkClient({
    apiKey: config.apiKey,
    network: config.network,
  });

  // Set up subscription callback (logs to stderr so it doesn't interfere with MCP)
  setSubscriptionCallback((subscriptionId, data) => {
    console.error(
      `[Subscription Update] ${subscriptionId}:`,
      JSON.stringify(data, null, 2),
    );
  });

  // Create MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Security guard state (Phase 1/2 remediation).
  const securityConfig = loadSecurityConfig();
  const guardCtx: GuardContext = {
    config: securityConfig,
    budget: new DailyBudgetTracker(),
  };
  const confirmTokens = new ConfirmTokenStore();

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Object.entries(allTools).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.inputSchema),
    }));

    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Validate args exist
      const toolArgs = (args || {}) as Record<string, unknown>;

      // Get the tool definition for validation
      const toolDef = allTools[name as keyof typeof allTools];
      if (!toolDef) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      // Validate input with Zod
      const validatedArgs = toolDef.inputSchema.parse(toolArgs) as Record<
        string,
        unknown
      >;

      // ── Spend guard (Phase 1/2 remediation) ──────────────────────────────
      // Every money-moving tool passes allowlist + caps + budget + confirmation
      // before it can execute. Fails closed.
      let spentThisCall: number | null = null;
      if (isSpendTool(name)) {
        const intent = extractSpendIntent(name, validatedArgs);
        const decision = evaluateSpend(guardCtx, name, intent);

        if (decision.action === "deny") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, error: decision.reason }),
              },
            ],
            isError: true,
          };
        }

        if (decision.action === "confirm") {
          // confirm_token travels alongside the validated args (Zod strips
          // unknown keys, so read it from the raw request).
          const confirmArgs = {
            ...validatedArgs,
            confirm_token: (toolArgs as Record<string, unknown>).confirm_token,
          };

          // Use inline elicitation when the client supports it; otherwise the
          // guard falls back to the two-step confirm-token flow.
          const caps = server.getClientCapabilities();
          const supportsElicitation = Boolean(caps?.elicitation);
          const elicit = supportsElicitation
            ? async (summary: string): Promise<boolean> => {
                const res = await server.elicitInput({
                  message: `Approve this payment?\n\n${summary}\n\nThis moves real funds and cannot be undone.`,
                  requestedSchema: {
                    type: "object",
                    properties: {
                      approve: {
                        type: "boolean",
                        description: "Set true to authorize this payment.",
                      },
                    },
                    required: ["approve"],
                  },
                });
                return res.action === "accept" && res.content?.approve === true;
              }
            : null;

          const confirmation = await confirmSpend(
            elicit,
            confirmTokens,
            name,
            confirmArgs,
            decision.summary,
          );

          if (confirmation.status === "rejected") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: confirmation.reason,
                  }),
                },
              ],
              isError: true,
            };
          }

          if (confirmation.status === "pending") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(confirmation.payload, null, 2),
                },
              ],
            };
          }
          // approved → fall through to execution
        }

        // Track known amounts against the rolling 24h budget on success.
        if (intent.amount !== null && !intent.isSweep) {
          spentThisCall = intent.amount;
        }
      }

      // Execute the tool
      const result = await handleToolCall(blinkClient, name, validatedArgs);

      // Record spend against the budget only after the call returns without
      // throwing. (Tool-level {success:false} responses still count as an
      // attempt is conservative; we only record on non-error return.)
      if (spentThisCall !== null) {
        guardCtx.budget.record(spentThisCall);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        const messages = error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Validation error: ${messages}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Handle MCP errors
      if (error instanceof McpError) {
        throw error;
      }

      // Handle other errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: errorMessage,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // Handle shutdown
  process.on("SIGINT", async () => {
    console.error("Shutting down...");
    await blinkClient.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("Shutting down...");
    await blinkClient.close();
    process.exit(0);
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`${SERVER_NAME} v${SERVER_VERSION} started`);
  console.error(`Network: ${config.network}`);
  console.error(`Available tools: ${Object.keys(allTools).length}`);
}

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
