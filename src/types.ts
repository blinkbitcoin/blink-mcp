// Blink API Types - Generated from GraphQL Schema

export type WalletCurrency = 'BTC' | 'USD';

export type PaymentSendResult = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ALREADY_PAID';

export type InvoicePaymentStatus = 'PENDING' | 'PAID' | 'EXPIRED';

export type TxDirection = 'SEND' | 'RECEIVE';

export type TxStatus = 'SUCCESS' | 'FAILURE' | 'PENDING';

export type PayoutSpeed = 'FAST' | 'MEDIUM' | 'SLOW';

export type AccountLevel = 'ZERO' | 'ONE' | 'TWO' | 'THREE';

export type Network = 'mainnet' | 'testnet' | 'regtest' | 'signet';

export interface Wallet {
  id: string;
  walletCurrency: WalletCurrency;
  balance: number;
  pendingIncomingBalance: number;
}

export interface Account {
  id: string;
  defaultWalletId: string;
  level: AccountLevel;
  wallets: Wallet[];
  displayCurrency: string;
}

export interface User {
  id: string;
  username?: string;
  phone?: string;
  email?: {
    address?: string;
    verified?: boolean;
  };
  defaultAccount: Account;
  createdAt: number;
  language: string;
  totpEnabled: boolean;
}

export interface LnInvoice {
  paymentRequest: string;
  paymentHash: string;
  paymentSecret: string;
  satoshis: number;
  externalId?: string;
  createdAt: number;
  paymentStatus: InvoicePaymentStatus;
}

export interface LnNoAmountInvoice {
  paymentRequest: string;
  paymentHash: string;
  paymentSecret: string;
  externalId?: string;
  createdAt: number;
  paymentStatus: InvoicePaymentStatus;
}

export interface Transaction {
  id: string;
  direction: TxDirection;
  status: TxStatus;
  settlementAmount: number;
  settlementCurrency: WalletCurrency;
  settlementFee: number;
  settlementDisplayAmount: string;
  settlementDisplayCurrency: string;
  settlementDisplayFee: string;
  memo?: string;
  createdAt: number;
  initiationVia: InitiationVia;
  settlementVia: SettlementVia;
  externalId?: string;
}

export interface InitiationVia {
  __typename: 'InitiationViaLn' | 'InitiationViaOnChain' | 'InitiationViaIntraLedger';
  paymentHash?: string;
  paymentRequest?: string;
  address?: string;
  counterPartyUsername?: string;
  counterPartyWalletId?: string;
}

export interface SettlementVia {
  __typename: 'SettlementViaLn' | 'SettlementViaOnChain' | 'SettlementViaIntraLedger';
  preImage?: string;
  transactionHash?: string;
  vout?: number;
  counterPartyUsername?: string;
  counterPartyWalletId?: string;
}

export interface CallbackEndpoint {
  id: string;
  url: string;
}

export interface RealtimePrice {
  id: string;
  timestamp: number;
  btcSatPrice: {
    base: number;
    offset: number;
  };
  usdCentPrice: {
    base: number;
    offset: number;
  };
  denominatorCurrency: string;
}

export interface OnChainTxFee {
  amount: number;
}

export interface AccountLimits {
  withdrawal: AccountLimit[];
  internalSend: AccountLimit[];
  convert: AccountLimit[];
}

export interface AccountLimit {
  totalLimit: number;
  remainingLimit?: number;
  interval?: number;
}

export interface PaymentSendPayload {
  status: PaymentSendResult;
  errors: GraphQLError[];
  transaction?: Transaction;
}

export interface GraphQLError {
  message: string;
  code?: string;
  path?: string[];
}

// Input types
export interface LnInvoiceCreateInput {
  walletId: string;
  amount: number;
  memo?: string;
  expiresIn?: number;
  externalId?: string;
}

export interface LnNoAmountInvoiceCreateInput {
  walletId: string;
  memo?: string;
  expiresIn?: number;
  externalId?: string;
}

export interface LnInvoicePaymentInput {
  walletId: string;
  paymentRequest: string;
  memo?: string;
}

export interface LnNoAmountInvoicePaymentInput {
  walletId: string;
  paymentRequest: string;
  amount: number;
  memo?: string;
}

export interface LnAddressPaymentSendInput {
  walletId: string;
  lnAddress: string;
  amount: number;
}

export interface OnChainAddressCreateInput {
  walletId: string;
}

export interface OnChainPaymentSendInput {
  walletId: string;
  address: string;
  amount: number;
  memo?: string;
  speed?: PayoutSpeed;
}

export interface OnChainPaymentSendAllInput {
  walletId: string;
  address: string;
  memo?: string;
  speed?: PayoutSpeed;
}

export interface IntraLedgerPaymentSendInput {
  walletId: string;
  recipientWalletId: string;
  amount: number;
  memo?: string;
}

export interface CallbackEndpointAddInput {
  url: string;
}

export interface CallbackEndpointDeleteInput {
  id: string;
}

// MCP Tool Response types
export interface BlinkToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errors?: GraphQLError[];
}

// Subscription types
export interface LnInvoicePaymentStatusPayload {
  status: InvoicePaymentStatus;
  paymentHash?: string;
  paymentPreimage?: string;
  paymentRequest?: string;
  errors: GraphQLError[];
}

export interface MyUpdatesPayload {
  update?: UserUpdate;
  errors: GraphQLError[];
}

export type UserUpdate = 
  | { __typename: 'LnUpdate'; status: InvoicePaymentStatus; paymentHash: string; transaction: Transaction }
  | { __typename: 'OnChainUpdate'; txHash: string; transaction: Transaction }
  | { __typename: 'IntraLedgerUpdate'; transaction: Transaction }
  | { __typename: 'RealtimePrice' } & RealtimePrice
  | { __typename: 'Price'; base: number; offset: number; currencyUnit: string };

// Configuration
export interface BlinkConfig {
  apiKey: string;
  endpoint: string;
  wsEndpoint: string;
  network: 'mainnet' | 'staging';
}
