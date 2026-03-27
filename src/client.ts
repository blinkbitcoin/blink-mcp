// Blink GraphQL Client with HTTP and WebSocket support

import { GraphQLClient } from 'graphql-request';
import { createClient, Client as WsClient } from 'graphql-ws';
import WebSocket from 'ws';
import type { BlinkConfig, GraphQLError } from './types.js';
import { QUERIES, MUTATIONS, SUBSCRIPTIONS } from './graphql/operations.js';

export class BlinkClient {
  private httpClient: GraphQLClient;
  private wsClient: WsClient | null = null;
  private config: BlinkConfig;
  private activeSubscriptions: Map<string, () => void> = new Map();

  constructor(config: BlinkConfig) {
    this.config = config;
    
    this.httpClient = new GraphQLClient(config.endpoint, {
      headers: {
        'X-API-KEY': config.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  // Initialize WebSocket client for subscriptions
  private initWsClient(): WsClient {
    if (!this.wsClient) {
      this.wsClient = createClient({
        url: this.config.wsEndpoint,
        webSocketImpl: WebSocket,
        connectionParams: {
          'X-API-KEY': this.config.apiKey,
        },
        retryAttempts: 5,
        shouldRetry: () => true,
        on: {
          connected: () => console.error('[Blink WS] Connected'),
          closed: () => console.error('[Blink WS] Disconnected'),
          error: (err) => console.error('[Blink WS] Error:', err),
        },
      });
    }
    return this.wsClient;
  }

  // Generic query executor
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      const result = await this.httpClient.request<T>(query, variables);
      return result;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  // Generic mutation executor
  async mutate<T>(mutation: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      const result = await this.httpClient.request<T>(mutation, variables);
      return result;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  // Subscribe to real-time updates
  subscribe<T>(
    subscriptionQuery: string,
    variables: Record<string, unknown>,
    callbacks: {
      onData: (data: T) => void;
      onError?: (error: Error) => void;
      onComplete?: () => void;
    }
  ): string {
    const wsClient = this.initWsClient();
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const unsubscribe = wsClient.subscribe<T>(
      { query: subscriptionQuery, variables },
      {
        next: (data) => {
          if (data.data) {
            callbacks.onData(data.data);
          }
        },
        error: (err) => {
          console.error('[Blink WS] Subscription error:', err);
          callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
        },
        complete: () => {
          this.activeSubscriptions.delete(subscriptionId);
          callbacks.onComplete?.();
        },
      }
    );

    this.activeSubscriptions.set(subscriptionId, unsubscribe);
    return subscriptionId;
  }

  // Unsubscribe from a specific subscription
  unsubscribe(subscriptionId: string): boolean {
    const unsubscribeFn = this.activeSubscriptions.get(subscriptionId);
    if (unsubscribeFn) {
      unsubscribeFn();
      this.activeSubscriptions.delete(subscriptionId);
      return true;
    }
    return false;
  }

  // Unsubscribe from all subscriptions
  unsubscribeAll(): void {
    for (const [id, unsubscribeFn] of this.activeSubscriptions) {
      unsubscribeFn();
      this.activeSubscriptions.delete(id);
    }
  }

  // Close WebSocket connection
  async close(): Promise<void> {
    this.unsubscribeAll();
    if (this.wsClient) {
      await this.wsClient.dispose();
      this.wsClient = null;
    }
  }

  // Error handler
  private handleError(error: unknown): Error {
    if (error instanceof Error) {
      // Extract GraphQL errors if present
      const gqlError = error as Error & { response?: { errors?: GraphQLError[] } };
      if (gqlError.response?.errors?.length) {
        const messages = gqlError.response.errors.map(e => e.message).join('; ');
        return new Error(`GraphQL Error: ${messages}`);
      }
      return error;
    }
    return new Error(String(error));
  }

  // ==================== QUERY METHODS ====================

  async getMe() {
    return this.query<{ me: unknown }>(QUERIES.ME);
  }

  async getWallets() {
    return this.query<{ me: { defaultAccount: { wallets: unknown[] } } }>(QUERIES.GET_WALLETS);
  }

  async getWalletById(walletId: string) {
    return this.query<{ me: { defaultAccount: { walletById: unknown } } }>(
      QUERIES.GET_WALLET_BY_ID,
      { walletId }
    );
  }

  async getTransactions(params: { walletIds?: string[]; first?: number; after?: string }) {
    return this.query<{ me: { defaultAccount: { transactions: unknown } } }>(
      QUERIES.GET_TRANSACTIONS,
      params
    );
  }

  async getTransactionById(walletId: string, transactionId: string) {
    return this.query<{ me: { defaultAccount: { walletById: { transactionById: unknown } } } }>(
      QUERIES.GET_TRANSACTION_BY_ID,
      { walletId, transactionId }
    );
  }

  async getAccountLimits() {
    return this.query<{ me: { defaultAccount: { limits: unknown } } }>(QUERIES.GET_ACCOUNT_LIMITS);
  }

  async getInvoiceStatusByHash(paymentHash: string) {
    return this.query<{ lnInvoicePaymentStatusByHash: unknown }>(
      QUERIES.LN_INVOICE_PAYMENT_STATUS_BY_HASH,
      { paymentHash }
    );
  }

  async getInvoiceStatusByRequest(paymentRequest: string) {
    return this.query<{ lnInvoicePaymentStatusByPaymentRequest: unknown }>(
      QUERIES.LN_INVOICE_PAYMENT_STATUS_BY_REQUEST,
      { paymentRequest }
    );
  }

  async getRealtimePrice(currency?: string) {
    return this.query<{ realtimePrice: unknown }>(QUERIES.REALTIME_PRICE, { currency });
  }

  async getBtcPriceHistory(range: 'ONE_DAY' | 'ONE_WEEK' | 'ONE_MONTH' | 'ONE_YEAR' | 'FIVE_YEARS') {
    return this.query<{ btcPriceList: unknown[] }>(QUERIES.BTC_PRICE_LIST, { range });
  }

  async getOnChainTxFee(walletId: string, address: string, amount: number, speed?: string) {
    return this.query<{ onChainTxFee: { amount: number } }>(
      QUERIES.ON_CHAIN_TX_FEE,
      { walletId, address, amount, speed: speed || 'FAST' }
    );
  }

  async getOnChainUsdTxFee(walletId: string, address: string, amount: number, speed?: string) {
    return this.query<{ onChainUsdTxFee: { amount: number } }>(
      QUERIES.ON_CHAIN_USD_TX_FEE,
      { walletId, address, amount, speed: speed || 'FAST' }
    );
  }

  async getLnInvoiceFeeProbe(walletId: string, paymentRequest: string) {
    return this.mutate<{ lnInvoiceFeeProbe: { amount?: number; errors: unknown[] } }>(
      QUERIES.LN_INVOICE_FEE_PROBE,
      { walletId, paymentRequest }
    );
  }

  async getLnNoAmountInvoiceFeeProbe(walletId: string, paymentRequest: string, amount: number) {
    return this.mutate<{ lnNoAmountInvoiceFeeProbe: { amount?: number; errors: unknown[] } }>(
      QUERIES.LN_NO_AMOUNT_INVOICE_FEE_PROBE,
      { walletId, paymentRequest, amount }
    );
  }

  async getCallbackEndpoints() {
    return this.query<{ me: { defaultAccount: { callbackEndpoints: unknown[] } } }>(
      QUERIES.GET_CALLBACK_ENDPOINTS
    );
  }

  async getGlobals() {
    return this.query<{ globals: unknown }>(QUERIES.GLOBALS);
  }

  async getAccountDefaultWallet(username: string, walletCurrency?: string) {
    return this.query<{ accountDefaultWallet: unknown }>(
      QUERIES.ACCOUNT_DEFAULT_WALLET,
      { username, walletCurrency }
    );
  }

  async checkUsernameAvailable(username: string) {
    return this.query<{ usernameAvailable: boolean }>(
      QUERIES.USERNAME_AVAILABLE,
      { username }
    );
  }

  async getCurrencyConversion(amount: number, currency: string) {
    return this.query<{ currencyConversionEstimation: unknown }>(
      QUERIES.CURRENCY_CONVERSION_ESTIMATION,
      { amount, currency }
    );
  }

  async getCurrencyList() {
    return this.query<{ currencyList: unknown[] }>(QUERIES.CURRENCY_LIST);
  }

  async getAuthorization() {
    return this.query<{ authorization: { scopes: string[] } }>(QUERIES.AUTHORIZATION);
  }

  // ==================== MUTATION METHODS ====================

  // Lightning
  async createLnInvoice(input: {
    walletId: string;
    amount: number;
    memo?: string;
    expiresIn?: number;
    externalId?: string;
  }) {
    return this.mutate<{ lnInvoiceCreate: { invoice?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_INVOICE_CREATE,
      { input }
    );
  }

  async createLnNoAmountInvoice(input: {
    walletId: string;
    memo?: string;
    expiresIn?: number;
    externalId?: string;
  }) {
    return this.mutate<{ lnNoAmountInvoiceCreate: { invoice?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_NO_AMOUNT_INVOICE_CREATE,
      { input }
    );
  }

  async createLnUsdInvoice(input: {
    walletId: string;
    amount: number;
    memo?: string;
    expiresIn?: number;
    externalId?: string;
  }) {
    return this.mutate<{ lnUsdInvoiceCreate: { invoice?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_USD_INVOICE_CREATE,
      { input }
    );
  }

  async cancelLnInvoice(walletId: string, paymentHash: string) {
    return this.mutate<{ lnInvoiceCancel: { success?: boolean; errors: unknown[] } }>(
      MUTATIONS.LN_INVOICE_CANCEL,
      { input: { walletId, paymentHash } }
    );
  }

  async payLnInvoice(input: {
    walletId: string;
    paymentRequest: string;
    memo?: string;
  }) {
    return this.mutate<{ lnInvoicePaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_INVOICE_PAYMENT_SEND,
      { input }
    );
  }

  async payLnNoAmountInvoice(input: {
    walletId: string;
    paymentRequest: string;
    amount: number;
    memo?: string;
  }) {
    return this.mutate<{ lnNoAmountInvoicePaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_NO_AMOUNT_INVOICE_PAYMENT_SEND,
      { input }
    );
  }

  async payLnNoAmountUsdInvoice(input: {
    walletId: string;
    paymentRequest: string;
    amount: number;
    memo?: string;
  }) {
    return this.mutate<{ lnNoAmountUsdInvoicePaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_NO_AMOUNT_USD_INVOICE_PAYMENT_SEND,
      { input }
    );
  }

  async payLnAddress(input: {
    walletId: string;
    lnAddress: string;
    amount: number;
  }) {
    return this.mutate<{ lnAddressPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.LN_ADDRESS_PAYMENT_SEND,
      { input }
    );
  }

  async payLnurl(input: {
    walletId: string;
    lnurl: string;
    amount: number;
  }) {
    return this.mutate<{ lnurlPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.LNURL_PAYMENT_SEND,
      { input }
    );
  }

  // On-chain
  async createOnChainAddress(walletId: string) {
    return this.mutate<{ onChainAddressCreate: { address?: string; errors: unknown[] } }>(
      MUTATIONS.ON_CHAIN_ADDRESS_CREATE,
      { input: { walletId } }
    );
  }

  async getCurrentOnChainAddress(walletId: string) {
    return this.mutate<{ onChainAddressCurrent: { address?: string; errors: unknown[] } }>(
      MUTATIONS.ON_CHAIN_ADDRESS_CURRENT,
      { input: { walletId } }
    );
  }

  async sendOnChainPayment(input: {
    walletId: string;
    address: string;
    amount: number;
    memo?: string;
    speed?: string;
  }) {
    return this.mutate<{ onChainPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.ON_CHAIN_PAYMENT_SEND,
      { input: { ...input, speed: input.speed || 'FAST' } }
    );
  }

  async sendOnChainPaymentAll(input: {
    walletId: string;
    address: string;
    memo?: string;
    speed?: string;
  }) {
    return this.mutate<{ onChainPaymentSendAll: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.ON_CHAIN_PAYMENT_SEND_ALL,
      { input: { ...input, speed: input.speed || 'FAST' } }
    );
  }

  async sendOnChainUsdPayment(input: {
    walletId: string;
    address: string;
    amount: number;
    memo?: string;
    speed?: string;
  }) {
    return this.mutate<{ onChainUsdPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.ON_CHAIN_USD_PAYMENT_SEND,
      { input: { ...input, speed: input.speed || 'FAST' } }
    );
  }

  // Intraledger
  async sendIntraledgerPayment(input: {
    walletId: string;
    recipientWalletId: string;
    amount: number;
    memo?: string;
  }) {
    return this.mutate<{ intraLedgerPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.INTRA_LEDGER_PAYMENT_SEND,
      { input }
    );
  }

  async sendIntraledgerUsdPayment(input: {
    walletId: string;
    recipientWalletId: string;
    amount: number;
    memo?: string;
  }) {
    return this.mutate<{ intraLedgerUsdPaymentSend: { status?: string; transaction?: unknown; errors: unknown[] } }>(
      MUTATIONS.INTRA_LEDGER_USD_PAYMENT_SEND,
      { input }
    );
  }

  // Webhooks/Callbacks
  async addCallbackEndpoint(url: string) {
    return this.mutate<{ callbackEndpointAdd: { id?: string; errors: unknown[] } }>(
      MUTATIONS.CALLBACK_ENDPOINT_ADD,
      { input: { url } }
    );
  }

  async deleteCallbackEndpoint(id: string) {
    return this.mutate<{ callbackEndpointDelete: { success?: boolean; errors: unknown[] } }>(
      MUTATIONS.CALLBACK_ENDPOINT_DELETE,
      { input: { id } }
    );
  }

  // Account
  async updateDefaultWalletId(walletId: string) {
    return this.mutate<{ accountUpdateDefaultWalletId: { account?: unknown; errors: unknown[] } }>(
      MUTATIONS.ACCOUNT_UPDATE_DEFAULT_WALLET_ID,
      { input: { walletId } }
    );
  }

  async updateDisplayCurrency(currency: string) {
    return this.mutate<{ accountUpdateDisplayCurrency: { account?: unknown; errors: unknown[] } }>(
      MUTATIONS.ACCOUNT_UPDATE_DISPLAY_CURRENCY,
      { input: { currency } }
    );
  }

  // User
  async updateUsername(username: string) {
    return this.mutate<{ userUpdateUsername: { user?: unknown; errors: unknown[] } }>(
      MUTATIONS.USER_UPDATE_USERNAME,
      { input: { username } }
    );
  }

  async updateLanguage(language: string) {
    return this.mutate<{ userUpdateLanguage: { user?: unknown; errors: unknown[] } }>(
      MUTATIONS.USER_UPDATE_LANGUAGE,
      { input: { language } }
    );
  }

  // Push notifications
  async createDeviceNotificationToken(deviceToken: string) {
    return this.mutate<{ deviceNotificationTokenCreate: { success?: boolean; errors: unknown[] } }>(
      MUTATIONS.DEVICE_NOTIFICATION_TOKEN_CREATE,
      { input: { deviceToken } }
    );
  }

  // Feedback
  async submitFeedback(feedback: string) {
    return this.mutate<{ feedbackSubmit: { success?: boolean; errors: unknown[] } }>(
      MUTATIONS.FEEDBACK_SUBMIT,
      { input: { feedback } }
    );
  }

  // ==================== SUBSCRIPTION METHODS ====================

  subscribeToInvoiceStatus(
    paymentRequest: string,
    callbacks: {
      onData: (data: unknown) => void;
      onError?: (error: Error) => void;
      onComplete?: () => void;
    }
  ): string {
    return this.subscribe(
      SUBSCRIPTIONS.LN_INVOICE_PAYMENT_STATUS,
      { paymentRequest },
      callbacks
    );
  }

  subscribeToInvoiceStatusByHash(
    paymentHash: string,
    callbacks: {
      onData: (data: unknown) => void;
      onError?: (error: Error) => void;
      onComplete?: () => void;
    }
  ): string {
    return this.subscribe(
      SUBSCRIPTIONS.LN_INVOICE_PAYMENT_STATUS_BY_HASH,
      { paymentHash },
      callbacks
    );
  }

  subscribeToMyUpdates(callbacks: {
    onData: (data: unknown) => void;
    onError?: (error: Error) => void;
    onComplete?: () => void;
  }): string {
    return this.subscribe(SUBSCRIPTIONS.MY_UPDATES, {}, callbacks);
  }

  subscribeToRealtimePrice(
    currency: string,
    callbacks: {
      onData: (data: unknown) => void;
      onError?: (error: Error) => void;
      onComplete?: () => void;
    }
  ): string {
    return this.subscribe(
      SUBSCRIPTIONS.REALTIME_PRICE,
      { currency },
      callbacks
    );
  }
}

// Factory function to create a configured client
export function createBlinkClient(options: {
  apiKey: string;
  network?: 'mainnet' | 'staging';
}): BlinkClient {
  const network = options.network || 'mainnet';
  
  const config: BlinkConfig = {
    apiKey: options.apiKey,
    endpoint: network === 'mainnet' 
      ? 'https://api.blink.sv/graphql'
      : 'https://api.staging.blink.sv/graphql',
    wsEndpoint: network === 'mainnet'
      ? 'wss://api.blink.sv/graphql'
      : 'wss://api.staging.blink.sv/graphql',
    network,
  };

  return new BlinkClient(config);
}
