// Wallet and Account Tools

import { z } from 'zod';
import type { BlinkClient } from '../client.js';

// Tool definitions
export const walletTools = {
  get_account_info: {
    description: 'Get the current user account information including wallets, balances, and settings',
    inputSchema: z.object({}),
  },

  get_wallets: {
    description: 'Get all wallets (BTC and USD) with their current balances. Balance is in satoshis for BTC wallet and cents for USD wallet.',
    inputSchema: z.object({}),
  },

  get_wallet_balance: {
    description: 'Get the balance of a specific wallet by ID. Returns balance in satoshis (BTC) or cents (USD).',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to check balance for'),
    }),
  },

  get_transactions: {
    description: 'Get transaction history for one or more wallets. Supports pagination.',
    inputSchema: z.object({
      wallet_ids: z.array(z.string()).optional().describe('List of wallet IDs to get transactions for. If not provided, gets all wallets.'),
      limit: z.number().min(1).max(100).default(20).describe('Number of transactions to return (max 100)'),
      cursor: z.string().optional().describe('Pagination cursor for fetching next page'),
    }),
  },

  get_transaction_by_id: {
    description: 'Get details of a specific transaction by ID',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID the transaction belongs to'),
      transaction_id: z.string().describe('The transaction ID'),
    }),
  },

  get_account_limits: {
    description: 'Get the current account limits for withdrawals, internal sends, and currency conversion',
    inputSchema: z.object({}),
  },

  set_default_wallet: {
    description: 'Set the default wallet for the account (BTC or USD wallet)',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to set as default'),
    }),
  },

  set_display_currency: {
    description: 'Set the display currency for the account (e.g., USD, EUR, BTC)',
    inputSchema: z.object({
      currency: z.string().describe('The currency code (e.g., USD, EUR, GBP)'),
    }),
  },

  get_realtime_price: {
    description: 'Get the current real-time Bitcoin price in a specified currency',
    inputSchema: z.object({
      currency: z.string().default('USD').describe('The currency to get the price in (default: USD)'),
    }),
  },

  get_price_history: {
    description: 'Get Bitcoin price history for a specified time range',
    inputSchema: z.object({
      range: z.enum(['ONE_DAY', 'ONE_WEEK', 'ONE_MONTH', 'ONE_YEAR', 'FIVE_YEARS']).describe('Time range for price history'),
    }),
  },

  convert_currency: {
    description: 'Get currency conversion estimation between fiat and Bitcoin',
    inputSchema: z.object({
      amount: z.number().positive().describe('Amount to convert (in major units, e.g., dollars not cents)'),
      currency: z.string().describe('The fiat currency code (e.g., USD, EUR)'),
    }),
  },

  get_supported_currencies: {
    description: 'Get list of all supported display currencies',
    inputSchema: z.object({}),
  },

  lookup_user_wallet: {
    description: 'Look up a user\'s default wallet by their Blink username',
    inputSchema: z.object({
      username: z.string().describe('The Blink username to look up'),
      wallet_currency: z.enum(['BTC', 'USD']).optional().describe('Preferred wallet currency'),
    }),
  },

  check_username_available: {
    description: 'Check if a Blink username is available',
    inputSchema: z.object({
      username: z.string().describe('The username to check'),
    }),
  },

  set_username: {
    description: 'Set or update the username for the current user',
    inputSchema: z.object({
      username: z.string().describe('The new username'),
    }),
  },

  get_authorization_scopes: {
    description: 'Get the permission scopes available for the current API key',
    inputSchema: z.object({}),
  },

  get_network_info: {
    description: 'Get global network information including Lightning node details and fee information',
    inputSchema: z.object({}),
  },
};

// Tool handlers
export async function handleWalletTool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'get_account_info': {
      const result = await client.getMe();
      return {
        success: true,
        data: result.me,
      };
    }

    case 'get_wallets': {
      const result = await client.getWallets();
      const wallets = result.me.defaultAccount.wallets as Array<{
        id: string;
        walletCurrency: string;
        balance: number;
        pendingIncomingBalance: number;
      }>;
      return {
        success: true,
        data: {
          wallets,
          summary: wallets.map((w) => ({
            id: w.id,
            currency: w.walletCurrency,
            balance: w.balance,
            balance_formatted: w.walletCurrency === 'BTC' 
              ? `${w.balance} sats`
              : `$${(w.balance / 100).toFixed(2)}`,
          })),
        },
      };
    }

    case 'get_wallet_balance': {
      const { wallet_id } = args as { wallet_id: string };
      const result = await client.getWalletById(wallet_id);
      const wallet = result.me.defaultAccount.walletById as {
        walletCurrency: string;
        balance: number;
        pendingIncomingBalance: number;
      };
      return {
        success: true,
        data: {
          ...wallet,
          balance_formatted: wallet.walletCurrency === 'BTC'
            ? `${wallet.balance} sats`
            : `$${(wallet.balance / 100).toFixed(2)}`,
          pending_formatted: wallet.walletCurrency === 'BTC'
            ? `${wallet.pendingIncomingBalance} sats`
            : `$${(wallet.pendingIncomingBalance / 100).toFixed(2)}`,
        },
      };
    }

    case 'get_transactions': {
      const { wallet_ids, limit, cursor } = args as {
        wallet_ids?: string[];
        limit?: number;
        cursor?: string;
      };
      const result = await client.getTransactions({
        walletIds: wallet_ids,
        first: limit || 20,
        after: cursor,
      });
      const txData = result.me.defaultAccount.transactions as {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{ node: unknown; cursor: string }>;
      };
      return {
        success: true,
        data: {
          transactions: txData.edges.map(e => e.node),
          pagination: {
            has_next_page: txData.pageInfo.hasNextPage,
            next_cursor: txData.pageInfo.endCursor,
          },
        },
      };
    }

    case 'get_transaction_by_id': {
      const { wallet_id, transaction_id } = args as {
        wallet_id: string;
        transaction_id: string;
      };
      const result = await client.getTransactionById(wallet_id, transaction_id);
      return {
        success: true,
        data: result.me.defaultAccount.walletById.transactionById,
      };
    }

    case 'get_account_limits': {
      const result = await client.getAccountLimits();
      return {
        success: true,
        data: result.me.defaultAccount.limits,
      };
    }

    case 'set_default_wallet': {
      const { wallet_id } = args as { wallet_id: string };
      const result = await client.updateDefaultWalletId(wallet_id);
      const response = result.accountUpdateDefaultWalletId;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: response.account,
      };
    }

    case 'set_display_currency': {
      const { currency } = args as { currency: string };
      const result = await client.updateDisplayCurrency(currency);
      const response = result.accountUpdateDisplayCurrency;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: response.account,
      };
    }

    case 'get_realtime_price': {
      const { currency } = args as { currency?: string };
      const result = await client.getRealtimePrice(currency || 'USD');
      const price = result.realtimePrice as {
        btcSatPrice: { base: number; offset: number };
        usdCentPrice: { base: number; offset: number };
        timestamp: number;
      };
      return {
        success: true,
        data: {
          ...price,
          btc_price_per_sat: price.btcSatPrice.base / Math.pow(10, price.btcSatPrice.offset),
          usd_price_per_cent: price.usdCentPrice.base / Math.pow(10, price.usdCentPrice.offset),
        },
      };
    }

    case 'get_price_history': {
      const { range } = args as { range: string };
      const result = await client.getBtcPriceHistory(range as 'ONE_DAY' | 'ONE_WEEK' | 'ONE_MONTH' | 'ONE_YEAR' | 'FIVE_YEARS');
      return {
        success: true,
        data: result.btcPriceList,
      };
    }

    case 'convert_currency': {
      const { amount, currency } = args as { amount: number; currency: string };
      const result = await client.getCurrencyConversion(amount, currency);
      return {
        success: true,
        data: result.currencyConversionEstimation,
      };
    }

    case 'get_supported_currencies': {
      const result = await client.getCurrencyList();
      return {
        success: true,
        data: result.currencyList,
      };
    }

    case 'lookup_user_wallet': {
      const { username, wallet_currency } = args as {
        username: string;
        wallet_currency?: string;
      };
      const result = await client.getAccountDefaultWallet(username, wallet_currency);
      return {
        success: true,
        data: result.accountDefaultWallet,
      };
    }

    case 'check_username_available': {
      const { username } = args as { username: string };
      const result = await client.checkUsernameAvailable(username);
      return {
        success: true,
        data: {
          username,
          available: result.usernameAvailable,
        },
      };
    }

    case 'set_username': {
      const { username } = args as { username: string };
      const result = await client.updateUsername(username);
      const response = result.userUpdateUsername;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: response.user,
      };
    }

    case 'get_authorization_scopes': {
      const result = await client.getAuthorization();
      return {
        success: true,
        data: {
          scopes: result.authorization.scopes,
          permissions: {
            can_read: result.authorization.scopes.includes('READ'),
            can_receive: result.authorization.scopes.includes('RECEIVE'),
            can_write: result.authorization.scopes.includes('WRITE'),
          },
        },
      };
    }

    case 'get_network_info': {
      const result = await client.getGlobals();
      return {
        success: true,
        data: result.globals,
      };
    }

    default:
      throw new Error(`Unknown wallet tool: ${toolName}`);
  }
}
