// Intraledger (Blink-to-Blink) Payment Tools

import { z } from 'zod';
import type { BlinkClient } from '../client.js';

// Tool definitions
export const intraledgerTools = {
  send_to_wallet: {
    description: 'Send Bitcoin directly to another Blink wallet (free, instant, intraledger transfer). Amount is in satoshis for BTC wallets.',
    inputSchema: z.object({
      wallet_id: z.string().describe('Your BTC wallet ID to send from'),
      recipient_wallet_id: z.string().describe('The recipient\'s Blink wallet ID'),
      amount: z.number().int().positive().describe('Amount in satoshis to send'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
    }),
  },

  send_to_wallet_usd: {
    description: 'Send USD (Stablesats) directly to another Blink wallet (free, instant, intraledger transfer). Amount is in cents.',
    inputSchema: z.object({
      wallet_id: z.string().describe('Your USD wallet ID to send from'),
      recipient_wallet_id: z.string().describe('The recipient\'s Blink wallet ID'),
      amount: z.number().int().positive().describe('Amount in cents (USD) to send'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
    }),
  },

  send_to_username: {
    description: 'Send Bitcoin to a Blink user by their username. This looks up their wallet and does an intraledger transfer (free, instant).',
    inputSchema: z.object({
      wallet_id: z.string().describe('Your wallet ID to send from'),
      username: z.string().describe('The recipient\'s Blink username'),
      amount: z.number().int().positive().describe('Amount to send (satoshis for BTC, cents for USD)'),
      wallet_currency: z.enum(['BTC', 'USD']).default('BTC').describe('Which wallet currency to use'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
    }),
  },
};

// Tool handlers
export async function handleIntraledgerTool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'send_to_wallet': {
      const { wallet_id, recipient_wallet_id, amount, memo } = args as {
        wallet_id: string;
        recipient_wallet_id: string;
        amount: number;
        memo?: string;
      };
      const result = await client.sendIntraledgerPayment({
        walletId: wallet_id,
        recipientWalletId: recipient_wallet_id,
        amount,
        memo,
      });
      const response = result.intraLedgerPaymentSend;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          status: response.status,
          transaction: response.transaction,
          note: 'Intraledger transfer completed instantly with no fees',
        },
      };
    }

    case 'send_to_wallet_usd': {
      const { wallet_id, recipient_wallet_id, amount, memo } = args as {
        wallet_id: string;
        recipient_wallet_id: string;
        amount: number;
        memo?: string;
      };
      const result = await client.sendIntraledgerUsdPayment({
        walletId: wallet_id,
        recipientWalletId: recipient_wallet_id,
        amount,
        memo,
      });
      const response = result.intraLedgerUsdPaymentSend;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          status: response.status,
          transaction: response.transaction,
          note: 'USD intraledger transfer completed instantly with no fees',
        },
      };
    }

    case 'send_to_username': {
      const { wallet_id, username, amount, wallet_currency, memo } = args as {
        wallet_id: string;
        username: string;
        amount: number;
        wallet_currency?: string;
        memo?: string;
      };
      
      // First, look up the recipient's wallet
      const lookupResult = await client.getAccountDefaultWallet(username, wallet_currency);
      const recipientWallet = lookupResult.accountDefaultWallet as { id: string };
      
      if (!recipientWallet?.id) {
        return {
          success: false,
          error: `Could not find wallet for username: ${username}`,
        };
      }

      // Then send the payment
      const currency = wallet_currency || 'BTC';
      let result;
      
      if (currency === 'USD') {
        result = await client.sendIntraledgerUsdPayment({
          walletId: wallet_id,
          recipientWalletId: recipientWallet.id,
          amount,
          memo,
        });
        const response = result.intraLedgerUsdPaymentSend;
        if (response.errors?.length > 0) {
          return {
            success: false,
            errors: response.errors,
          };
        }
        return {
          success: true,
          data: {
            status: response.status,
            transaction: response.transaction,
            recipient_username: username,
            recipient_wallet_id: recipientWallet.id,
            note: 'USD payment to username completed instantly with no fees',
          },
        };
      } else {
        result = await client.sendIntraledgerPayment({
          walletId: wallet_id,
          recipientWalletId: recipientWallet.id,
          amount,
          memo,
        });
        const response = result.intraLedgerPaymentSend;
        if (response.errors?.length > 0) {
          return {
            success: false,
            errors: response.errors,
          };
        }
        return {
          success: true,
          data: {
            status: response.status,
            transaction: response.transaction,
            recipient_username: username,
            recipient_wallet_id: recipientWallet.id,
            note: 'BTC payment to username completed instantly with no fees',
          },
        };
      }
    }

    default:
      throw new Error(`Unknown intraledger tool: ${toolName}`);
  }
}
