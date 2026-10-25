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
import { toolInputJsonSchema } from "./schema.js";
import { loadSecurityConfig } from "./security/config.js";
import {
  requiresGuard,
  ApprovalCodeStore,
  type GuardContext,
} from "./security/guard.js";
import { runGuarded, type ApprovalKind } from "./security/gate.js";
import { SpendLedger } from "./security/ledger.js";
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

// Route tool calls to appropriate handler
async function handleToolCall(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>,
  guard: GuardContext,
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
    // l402_pay's amount is discovered mid-call; pass the guard so it can
    // enforce the shared cap/budget post-decode and debit on success.
    return handleL402Tool(client, toolName, args, guard);
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

  // Security guard state.
  const securityConfig = loadSecurityConfig();
  const guardCtx: GuardContext = {
    config: securityConfig,
    ledger: new SpendLedger(), // durable, survives restarts
    // USD-wallet amounts are in cents; convert at Blink's current rate so they
    // are checked against the sat-denominated caps and budget.
    toSats: async (cents: number) => {
      const res = await blinkClient.getCurrencyConversion(cents / 100, "USD");
      const sats = (res.currencyConversionEstimation as { btcSatAmount?: unknown })
        ?.btcSatAmount;
      if (typeof sats !== "number") {
        throw new Error("currency conversion returned no btcSatAmount");
      }
      return sats;
    },
  };
  const approvals = new ApprovalCodeStore();
  // Approval codes are written to stderr (not the MCP stdout channel), so they
  // are visible to the human operator's console but never enter model context.
  const printToStderr = (line: string): void => console.error(line);

  // In stderr-code mode, advertise the optional approval_code field on guarded
  // tools so schema-validating clients can send it as part of the contract.
  const advertiseApprovalCode =
    securityConfig.requireConfirmation &&
    securityConfig.approvalMode === "stderr-code";

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Object.entries(allTools).map(([name, def]) => {
      const inputSchema = toolInputJsonSchema(def.inputSchema);
      if (advertiseApprovalCode && requiresGuard(name)) {
        const props =
          (inputSchema.properties as Record<string, unknown>) ?? {};
        props.approval_code = {
          type: "string",
          description:
            "One-time approval code printed to the server console (stderr) when confirmation is required. Ask the human operator for it; it cannot be read from tool output.",
        };
        inputSchema.properties = props;
      }
      return {
        name,
        description: def.description,
        inputSchema,
      };
    });

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

      // ── Guard ────────────────────────────────────────────────────────────
      // Every money-moving tool passes allowlist + caps + budget + confirmation,
      // and webhook-changing tools pass the webhook policy + confirmation,
      // before they can execute. Fails closed. See src/security/gate.ts.
      const caps = server.getClientCapabilities();
      const elicit = caps?.elicitation
        ? async (summary: string, kind: ApprovalKind): Promise<boolean> => {
            const res = await server.elicitInput({
              message:
                kind === "payment"
                  ? `Approve this payment?\n\n${summary}\n\nThis moves real funds and cannot be undone.`
                  : `Approve this account change?\n\n${summary}`,
              requestedSchema: {
                type: "object",
                properties: {
                  approve: {
                    type: "boolean",
                    description:
                      kind === "payment"
                        ? "Set true to authorize this payment."
                        : "Set true to authorize this change.",
                  },
                },
                required: ["approve"],
              },
            });
            return res.action === "accept" && res.content?.approve === true;
          }
        : null;

      return await runGuarded(
        name,
        validatedArgs,
        toolArgs,
        {
          guardCtx,
          approvals,
          printToStderr,
          approvalMode: securityConfig.approvalMode,
          elicit,
        },
        () => handleToolCall(blinkClient, name, validatedArgs, guardCtx),
      );
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        const messages = error.issues
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
