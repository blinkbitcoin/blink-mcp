// On-Chain Bitcoin Tools

import { z } from 'zod';
import type { BlinkClient } from '../client.js';

// Tool definitions
export const onchainTools = {
  create_onchain_address: {
    description: 'Generate a new on-chain Bitcoin address to receive funds',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to generate an address for (BTC or USD wallet)'),
    }),
  },

  get_current_onchain_address: {
    description: 'Get the current (most recent) on-chain Bitcoin address for a wallet',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to get the current address for'),
    }),
  },

  send_onchain: {
    description: 'Send Bitcoin on-chain to a Bitcoin address. Amount is in satoshis for BTC wallet.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The BTC wallet ID to send from'),
      address: z.string().describe('The Bitcoin address to send to'),
      amount: z.number().int().positive().describe('Amount in satoshis to send'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
      speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).default('FAST').describe('Transaction speed/priority (affects fees)'),
    }),
  },

  send_onchain_all: {
    description: 'Send the entire wallet balance on-chain to a Bitcoin address (sweep)',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to sweep'),
      address: z.string().describe('The Bitcoin address to send to'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
      speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).default('FAST').describe('Transaction speed/priority (affects fees)'),
    }),
  },

  send_onchain_usd: {
    description: 'Send on-chain Bitcoin from a USD (Stablesats) wallet. Amount is in cents.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The USD wallet ID to send from'),
      address: z.string().describe('The Bitcoin address to send to'),
      amount: z.number().int().positive().describe('Amount in cents (USD) to send'),
      memo: z.string().optional().describe('Optional memo for the transaction'),
      speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).default('FAST').describe('Transaction speed/priority (affects fees)'),
    }),
  },

  estimate_onchain_fee: {
    description: 'Estimate the on-chain transaction fee for sending Bitcoin (BTC wallet)',
    inputSchema: z.object({
      wallet_id: z.string().describe('The BTC wallet ID to send from'),
      address: z.string().describe('The Bitcoin address to send to'),
      amount: z.number().int().positive().describe('Amount in satoshis to send'),
      speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).default('FAST').describe('Transaction speed/priority'),
    }),
  },

  estimate_onchain_fee_usd: {
    description: 'Estimate the on-chain transaction fee for sending from USD wallet',
    inputSchema: z.object({
      wallet_id: z.string().describe('The USD wallet ID to send from'),
      address: z.string().describe('The Bitcoin address to send to'),
      amount: z.number().int().positive().describe('Amount in cents (USD) to send'),
      speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).default('FAST').describe('Transaction speed/priority'),
    }),
  },
};

// Tool handlers
export async function handleOnchainTool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'create_onchain_address': {
      const { wallet_id } = args as { wallet_id: string };
      const result = await client.createOnChainAddress(wallet_id);
      const response = result.onChainAddressCreate;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          address: response.address,
          note: 'This is a new Bitcoin address. Funds sent to this address will be credited to your wallet after confirmation.',
        },
      };
    }

    case 'get_current_onchain_address': {
      const { wallet_id } = args as { wallet_id: string };
      const result = await client.getCurrentOnChainAddress(wallet_id);
      const response = result.onChainAddressCurrent;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          address: response.address,
          note: 'This is your current receiving address.',
        },
      };
    }

    case 'send_onchain': {
      const { wallet_id, address, amount, memo, speed } = args as {
        wallet_id: string;
        address: string;
        amount: number;
        memo?: string;
        speed?: string;
      };
      const result = await client.sendOnChainPayment({
        walletId: wallet_id,
        address,
        amount,
        memo,
        speed,
      });
      const response = result.onChainPaymentSend;
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
          note: 'On-chain transaction initiated. It may take some time to confirm on the Bitcoin network.',
        },
      };
    }

    case 'send_onchain_all': {
      const { wallet_id, address, memo, speed } = args as {
        wallet_id: string;
        address: string;
        memo?: string;
        speed?: string;
      };
      const result = await client.sendOnChainPaymentAll({
        walletId: wallet_id,
        address,
        memo,
        speed,
      });
      const response = result.onChainPaymentSendAll;
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
          note: 'Sweep transaction initiated. Entire wallet balance is being sent.',
        },
      };
    }

    case 'send_onchain_usd': {
      const { wallet_id, address, amount, memo, speed } = args as {
        wallet_id: string;
        address: string;
        amount: number;
        memo?: string;
        speed?: string;
      };
      const result = await client.sendOnChainUsdPayment({
        walletId: wallet_id,
        address,
        amount,
        memo,
        speed,
      });
      const response = result.onChainUsdPaymentSend;
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
          note: 'USD on-chain transaction initiated. Amount converted from USD to BTC at current rate.',
        },
      };
    }

    case 'estimate_onchain_fee': {
      const { wallet_id, address, amount, speed } = args as {
        wallet_id: string;
        address: string;
        amount: number;
        speed?: string;
      };
      const result = await client.getOnChainTxFee(wallet_id, address, amount, speed);
      return {
        success: true,
        data: {
          estimated_fee_sats: result.onChainTxFee.amount,
          speed: speed || 'FAST',
          note: 'Fee estimate based on current network conditions',
        },
      };
    }

    case 'estimate_onchain_fee_usd': {
      const { wallet_id, address, amount, speed } = args as {
        wallet_id: string;
        address: string;
        amount: number;
        speed?: string;
      };
      const result = await client.getOnChainUsdTxFee(wallet_id, address, amount, speed);
      return {
        success: true,
        data: {
          estimated_fee_cents: result.onChainUsdTxFee.amount,
          speed: speed || 'FAST',
          note: 'Fee estimate in USD cents based on current network conditions',
        },
      };
    }

    default:
      throw new Error(`Unknown onchain tool: ${toolName}`);
  }
}
