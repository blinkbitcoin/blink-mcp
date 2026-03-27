// Webhook and Subscription Management Tools

import { z } from 'zod';
import type { BlinkClient } from '../client.js';

// Store for active subscriptions (in-memory)
const activeSubscriptions = new Map<string, {
  type: string;
  params: Record<string, unknown>;
  startedAt: number;
}>();

// Tool definitions
export const webhookTools = {
  // Webhook (Callback) Management
  list_webhooks: {
    description: 'List all registered webhook callback endpoints for the account',
    inputSchema: z.object({}),
  },

  add_webhook: {
    description: 'Register a new webhook callback endpoint to receive payment notifications',
    inputSchema: z.object({
      url: z.string().url().describe('The webhook URL to call when events occur'),
    }),
  },

  remove_webhook: {
    description: 'Remove a registered webhook callback endpoint',
    inputSchema: z.object({
      id: z.string().describe('The webhook endpoint ID to remove'),
    }),
  },

  // Real-time Subscriptions
  subscribe_invoice_status: {
    description: 'Subscribe to real-time updates for a Lightning invoice payment status. Returns a subscription ID to track or cancel.',
    inputSchema: z.object({
      payment_request: z.string().describe('The bolt11 payment request to monitor'),
    }),
  },

  subscribe_invoice_status_by_hash: {
    description: 'Subscribe to real-time updates for a Lightning invoice by payment hash',
    inputSchema: z.object({
      payment_hash: z.string().describe('The payment hash to monitor'),
    }),
  },

  subscribe_account_updates: {
    description: 'Subscribe to all real-time account updates including incoming/outgoing transactions and price updates',
    inputSchema: z.object({}),
  },

  subscribe_price_updates: {
    description: 'Subscribe to real-time Bitcoin price updates in a specified currency',
    inputSchema: z.object({
      currency: z.string().default('USD').describe('The currency to get price updates in'),
    }),
  },

  list_subscriptions: {
    description: 'List all active real-time subscriptions',
    inputSchema: z.object({}),
  },

  cancel_subscription: {
    description: 'Cancel an active real-time subscription',
    inputSchema: z.object({
      subscription_id: z.string().describe('The subscription ID to cancel'),
    }),
  },

  cancel_all_subscriptions: {
    description: 'Cancel all active real-time subscriptions',
    inputSchema: z.object({}),
  },
};

// Callback to handle subscription data (will be called by the MCP server)
let subscriptionDataCallback: ((subscriptionId: string, data: unknown) => void) | null = null;

export function setSubscriptionCallback(callback: (subscriptionId: string, data: unknown) => void) {
  subscriptionDataCallback = callback;
}

// Tool handlers
export async function handleWebhookTool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    // Webhook Management
    case 'list_webhooks': {
      const result = await client.getCallbackEndpoints();
      const endpoints = result.me.defaultAccount.callbackEndpoints;
      return {
        success: true,
        data: {
          webhooks: endpoints,
          count: (endpoints as unknown[]).length,
          note: 'Webhooks receive POST requests when payment events occur',
        },
      };
    }

    case 'add_webhook': {
      const { url } = args as { url: string };
      const result = await client.addCallbackEndpoint(url);
      const response = result.callbackEndpointAdd;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          id: response.id,
          url,
          note: 'Webhook registered. You will receive POST requests for payment events.',
          events: [
            'receive.lightning - Incoming Lightning payment',
            'send.lightning - Outgoing Lightning payment',
            'receive.intraledger - Blink-to-Blink receive',
            'send.intraledger - Blink-to-Blink send',
            'receive.onchain - Incoming on-chain transaction',
            'send.onchain - Outgoing on-chain transaction',
          ],
        },
      };
    }

    case 'remove_webhook': {
      const { id } = args as { id: string };
      const result = await client.deleteCallbackEndpoint(id);
      const response = result.callbackEndpointDelete;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          removed: response.success,
          id,
        },
      };
    }

    // Real-time Subscriptions
    case 'subscribe_invoice_status': {
      const { payment_request } = args as { payment_request: string };
      const subscriptionId = client.subscribeToInvoiceStatus(payment_request, {
        onData: (data) => {
          if (subscriptionDataCallback) {
            subscriptionDataCallback(subscriptionId, data);
          }
          console.error(`[Subscription ${subscriptionId}] Invoice status update:`, JSON.stringify(data));
        },
        onError: (error) => {
          console.error(`[Subscription ${subscriptionId}] Error:`, error.message);
        },
        onComplete: () => {
          activeSubscriptions.delete(subscriptionId);
          console.error(`[Subscription ${subscriptionId}] Completed`);
        },
      });

      activeSubscriptions.set(subscriptionId, {
        type: 'invoice_status',
        params: { payment_request },
        startedAt: Date.now(),
      });

      return {
        success: true,
        data: {
          subscription_id: subscriptionId,
          type: 'invoice_status',
          payment_request,
          note: 'Subscribed to real-time invoice status updates. Updates will be logged.',
        },
      };
    }

    case 'subscribe_invoice_status_by_hash': {
      const { payment_hash } = args as { payment_hash: string };
      const subscriptionId = client.subscribeToInvoiceStatusByHash(payment_hash, {
        onData: (data) => {
          if (subscriptionDataCallback) {
            subscriptionDataCallback(subscriptionId, data);
          }
          console.error(`[Subscription ${subscriptionId}] Invoice status update:`, JSON.stringify(data));
        },
        onError: (error) => {
          console.error(`[Subscription ${subscriptionId}] Error:`, error.message);
        },
        onComplete: () => {
          activeSubscriptions.delete(subscriptionId);
          console.error(`[Subscription ${subscriptionId}] Completed`);
        },
      });

      activeSubscriptions.set(subscriptionId, {
        type: 'invoice_status_by_hash',
        params: { payment_hash },
        startedAt: Date.now(),
      });

      return {
        success: true,
        data: {
          subscription_id: subscriptionId,
          type: 'invoice_status_by_hash',
          payment_hash,
          note: 'Subscribed to real-time invoice status updates by hash.',
        },
      };
    }

    case 'subscribe_account_updates': {
      const subscriptionId = client.subscribeToMyUpdates({
        onData: (data) => {
          if (subscriptionDataCallback) {
            subscriptionDataCallback(subscriptionId, data);
          }
          console.error(`[Subscription ${subscriptionId}] Account update:`, JSON.stringify(data));
        },
        onError: (error) => {
          console.error(`[Subscription ${subscriptionId}] Error:`, error.message);
        },
        onComplete: () => {
          activeSubscriptions.delete(subscriptionId);
          console.error(`[Subscription ${subscriptionId}] Completed`);
        },
      });

      activeSubscriptions.set(subscriptionId, {
        type: 'account_updates',
        params: {},
        startedAt: Date.now(),
      });

      return {
        success: true,
        data: {
          subscription_id: subscriptionId,
          type: 'account_updates',
          note: 'Subscribed to all account updates including transactions and price changes.',
          events: [
            'LnUpdate - Lightning payment updates',
            'OnChainUpdate - On-chain transaction updates',
            'IntraLedgerUpdate - Intraledger transfer updates',
            'RealtimePrice - Price updates',
          ],
        },
      };
    }

    case 'subscribe_price_updates': {
      const { currency } = args as { currency?: string };
      const currencyCode = currency || 'USD';
      const subscriptionId = client.subscribeToRealtimePrice(currencyCode, {
        onData: (data) => {
          if (subscriptionDataCallback) {
            subscriptionDataCallback(subscriptionId, data);
          }
          console.error(`[Subscription ${subscriptionId}] Price update:`, JSON.stringify(data));
        },
        onError: (error) => {
          console.error(`[Subscription ${subscriptionId}] Error:`, error.message);
        },
        onComplete: () => {
          activeSubscriptions.delete(subscriptionId);
          console.error(`[Subscription ${subscriptionId}] Completed`);
        },
      });

      activeSubscriptions.set(subscriptionId, {
        type: 'price_updates',
        params: { currency: currencyCode },
        startedAt: Date.now(),
      });

      return {
        success: true,
        data: {
          subscription_id: subscriptionId,
          type: 'price_updates',
          currency: currencyCode,
          note: 'Subscribed to real-time price updates.',
        },
      };
    }

    case 'list_subscriptions': {
      const subscriptions = Array.from(activeSubscriptions.entries()).map(([id, info]) => ({
        subscription_id: id,
        type: info.type,
        params: info.params,
        started_at: new Date(info.startedAt).toISOString(),
        duration_seconds: Math.floor((Date.now() - info.startedAt) / 1000),
      }));

      return {
        success: true,
        data: {
          subscriptions,
          count: subscriptions.length,
        },
      };
    }

    case 'cancel_subscription': {
      const { subscription_id } = args as { subscription_id: string };
      const cancelled = client.unsubscribe(subscription_id);
      
      if (cancelled) {
        activeSubscriptions.delete(subscription_id);
        return {
          success: true,
          data: {
            cancelled: true,
            subscription_id,
          },
        };
      }

      return {
        success: false,
        error: `Subscription not found: ${subscription_id}`,
      };
    }

    case 'cancel_all_subscriptions': {
      const count = activeSubscriptions.size;
      client.unsubscribeAll();
      activeSubscriptions.clear();

      return {
        success: true,
        data: {
          cancelled_count: count,
          note: 'All subscriptions have been cancelled.',
        },
      };
    }

    default:
      throw new Error(`Unknown webhook tool: ${toolName}`);
  }
}
