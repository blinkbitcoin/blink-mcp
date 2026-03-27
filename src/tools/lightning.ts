// Lightning Network Tools

import { z } from 'zod';
import type { BlinkClient } from '../client.js';

// Tool definitions
export const lightningTools = {
  create_invoice: {
    description: 'Create a Lightning invoice to receive a specific amount of Bitcoin. Amount is in satoshis for BTC wallet.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The BTC wallet ID to receive funds'),
      amount: z.number().int().positive().describe('Amount in satoshis to receive'),
      memo: z.string().optional().describe('Optional memo/description for the invoice'),
      expires_in: z.number().int().positive().optional().describe('Invoice expiration time in minutes (default: 24 hours)'),
      external_id: z.string().optional().describe('Optional external reference ID for tracking'),
    }),
  },

  create_invoice_usd: {
    description: 'Create a Lightning invoice to receive a specific amount in USD cents (Stablesats). The invoice will be denominated in satoshis but credited as USD.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The USD wallet ID to receive funds'),
      amount: z.number().int().positive().describe('Amount in cents (USD) to receive'),
      memo: z.string().optional().describe('Optional memo/description for the invoice'),
      expires_in: z.number().int().positive().optional().describe('Invoice expiration time in minutes (default: 5 minutes for USD)'),
      external_id: z.string().optional().describe('Optional external reference ID for tracking'),
    }),
  },

  create_invoice_no_amount: {
    description: 'Create a Lightning invoice without a specified amount (open invoice). The payer can choose how much to send.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to receive funds (BTC or USD)'),
      memo: z.string().optional().describe('Optional memo/description for the invoice'),
      expires_in: z.number().int().positive().optional().describe('Invoice expiration time in minutes'),
      external_id: z.string().optional().describe('Optional external reference ID for tracking'),
    }),
  },

  cancel_invoice: {
    description: 'Cancel an unpaid Lightning invoice',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID the invoice belongs to'),
      payment_hash: z.string().describe('The payment hash of the invoice to cancel'),
    }),
  },

  get_invoice_status: {
    description: 'Check the payment status of a Lightning invoice by payment hash',
    inputSchema: z.object({
      payment_hash: z.string().describe('The payment hash of the invoice'),
    }),
  },

  get_invoice_status_by_request: {
    description: 'Check the payment status of a Lightning invoice by payment request (bolt11)',
    inputSchema: z.object({
      payment_request: z.string().describe('The bolt11 payment request string'),
    }),
  },

  pay_invoice: {
    description: 'Pay a Lightning invoice. The invoice amount must be specified in the invoice.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to pay from (BTC or USD)'),
      payment_request: z.string().describe('The bolt11 payment request to pay'),
      memo: z.string().optional().describe('Optional memo to attach to the payment'),
    }),
  },

  pay_invoice_with_amount: {
    description: 'Pay a Lightning invoice that has no amount specified (open invoice). You specify the amount to send.',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to pay from'),
      payment_request: z.string().describe('The bolt11 payment request to pay'),
      amount: z.number().int().positive().describe('Amount in satoshis (BTC wallet) or cents (USD wallet)'),
      memo: z.string().optional().describe('Optional memo to attach to the payment'),
    }),
  },

  pay_lightning_address: {
    description: 'Send Bitcoin to a Lightning Address (e.g., user@blink.sv)',
    inputSchema: z.object({
      wallet_id: z.string().describe('The BTC wallet ID to send from'),
      ln_address: z.string().describe('The Lightning address to send to (e.g., user@blink.sv)'),
      amount: z.number().int().positive().describe('Amount in satoshis to send'),
    }),
  },

  pay_lnurl: {
    description: 'Pay using an LNURL (Lightning URL)',
    inputSchema: z.object({
      wallet_id: z.string().describe('The BTC wallet ID to send from'),
      lnurl: z.string().describe('The LNURL string to pay'),
      amount: z.number().int().positive().describe('Amount in satoshis to send'),
    }),
  },

  estimate_lightning_fee: {
    description: 'Estimate the Lightning network fee for paying an invoice',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to pay from'),
      payment_request: z.string().describe('The bolt11 payment request to estimate fees for'),
    }),
  },

  estimate_lightning_fee_no_amount: {
    description: 'Estimate the Lightning network fee for paying an open (no-amount) invoice',
    inputSchema: z.object({
      wallet_id: z.string().describe('The wallet ID to pay from'),
      payment_request: z.string().describe('The bolt11 payment request'),
      amount: z.number().int().positive().describe('The amount you want to send in satoshis'),
    }),
  },
};

// Tool handlers
export async function handleLightningTool(
  client: BlinkClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'create_invoice': {
      const { wallet_id, amount, memo, expires_in, external_id } = args as {
        wallet_id: string;
        amount: number;
        memo?: string;
        expires_in?: number;
        external_id?: string;
      };
      const result = await client.createLnInvoice({
        walletId: wallet_id,
        amount,
        memo,
        expiresIn: expires_in,
        externalId: external_id,
      });
      const response = result.lnInvoiceCreate;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          invoice: response.invoice,
          note: 'Share the payment_request (bolt11 invoice) with the payer',
        },
      };
    }

    case 'create_invoice_usd': {
      const { wallet_id, amount, memo, expires_in, external_id } = args as {
        wallet_id: string;
        amount: number;
        memo?: string;
        expires_in?: number;
        external_id?: string;
      };
      const result = await client.createLnUsdInvoice({
        walletId: wallet_id,
        amount,
        memo,
        expiresIn: expires_in,
        externalId: external_id,
      });
      const response = result.lnUsdInvoiceCreate;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          invoice: response.invoice,
          note: 'USD invoice - amount will be locked at current BTC/USD rate',
        },
      };
    }

    case 'create_invoice_no_amount': {
      const { wallet_id, memo, expires_in, external_id } = args as {
        wallet_id: string;
        memo?: string;
        expires_in?: number;
        external_id?: string;
      };
      const result = await client.createLnNoAmountInvoice({
        walletId: wallet_id,
        memo,
        expiresIn: expires_in,
        externalId: external_id,
      });
      const response = result.lnNoAmountInvoiceCreate;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          invoice: response.invoice,
          note: 'Open invoice - payer can choose the amount to send',
        },
      };
    }

    case 'cancel_invoice': {
      const { wallet_id, payment_hash } = args as {
        wallet_id: string;
        payment_hash: string;
      };
      const result = await client.cancelLnInvoice(wallet_id, payment_hash);
      const response = result.lnInvoiceCancel;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          cancelled: response.success,
          payment_hash,
        },
      };
    }

    case 'get_invoice_status': {
      const { payment_hash } = args as { payment_hash: string };
      const result = await client.getInvoiceStatusByHash(payment_hash);
      return {
        success: true,
        data: result.lnInvoicePaymentStatusByHash,
      };
    }

    case 'get_invoice_status_by_request': {
      const { payment_request } = args as { payment_request: string };
      const result = await client.getInvoiceStatusByRequest(payment_request);
      return {
        success: true,
        data: result.lnInvoicePaymentStatusByPaymentRequest,
      };
    }

    case 'pay_invoice': {
      const { wallet_id, payment_request, memo } = args as {
        wallet_id: string;
        payment_request: string;
        memo?: string;
      };
      const result = await client.payLnInvoice({
        walletId: wallet_id,
        paymentRequest: payment_request,
        memo,
      });
      const response = result.lnInvoicePaymentSend;
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
        },
      };
    }

    case 'pay_invoice_with_amount': {
      const { wallet_id, payment_request, amount, memo } = args as {
        wallet_id: string;
        payment_request: string;
        amount: number;
        memo?: string;
      };
      // Determine if BTC or USD wallet based on amount context
      // For now, we'll use the standard BTC no-amount payment
      const result = await client.payLnNoAmountInvoice({
        walletId: wallet_id,
        paymentRequest: payment_request,
        amount,
        memo,
      });
      const response = result.lnNoAmountInvoicePaymentSend;
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
        },
      };
    }

    case 'pay_lightning_address': {
      const { wallet_id, ln_address, amount } = args as {
        wallet_id: string;
        ln_address: string;
        amount: number;
      };
      const result = await client.payLnAddress({
        walletId: wallet_id,
        lnAddress: ln_address,
        amount,
      });
      const response = result.lnAddressPaymentSend;
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
          recipient: ln_address,
        },
      };
    }

    case 'pay_lnurl': {
      const { wallet_id, lnurl, amount } = args as {
        wallet_id: string;
        lnurl: string;
        amount: number;
      };
      const result = await client.payLnurl({
        walletId: wallet_id,
        lnurl,
        amount,
      });
      const response = result.lnurlPaymentSend;
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
        },
      };
    }

    case 'estimate_lightning_fee': {
      const { wallet_id, payment_request } = args as {
        wallet_id: string;
        payment_request: string;
      };
      const result = await client.getLnInvoiceFeeProbe(wallet_id, payment_request);
      const response = result.lnInvoiceFeeProbe;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          estimated_fee_sats: response.amount,
          note: 'Fee estimate may vary based on network conditions',
        },
      };
    }

    case 'estimate_lightning_fee_no_amount': {
      const { wallet_id, payment_request, amount } = args as {
        wallet_id: string;
        payment_request: string;
        amount: number;
      };
      const result = await client.getLnNoAmountInvoiceFeeProbe(wallet_id, payment_request, amount);
      const response = result.lnNoAmountInvoiceFeeProbe;
      if (response.errors?.length > 0) {
        return {
          success: false,
          errors: response.errors,
        };
      }
      return {
        success: true,
        data: {
          estimated_fee_sats: response.amount,
          amount_to_send: amount,
          note: 'Fee estimate may vary based on network conditions',
        },
      };
    }

    default:
      throw new Error(`Unknown lightning tool: ${toolName}`);
  }
}
