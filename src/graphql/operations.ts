// GraphQL Queries for Blink API

export const QUERIES = {
  // User and Account queries
  ME: `
    query Me {
      me {
        id
        username
        phone
        email {
          address
          verified
        }
        language
        totpEnabled
        createdAt
        defaultAccount {
          id
          defaultWalletId
          level
          displayCurrency
          wallets {
            id
            walletCurrency
            balance
            pendingIncomingBalance
          }
        }
      }
    }
  `,

  GET_WALLETS: `
    query GetWallets {
      me {
        defaultAccount {
          wallets {
            id
            walletCurrency
            balance
            pendingIncomingBalance
          }
        }
      }
    }
  `,

  GET_WALLET_BY_ID: `
    query GetWalletById($walletId: WalletId!) {
      me {
        defaultAccount {
          walletById(walletId: $walletId) {
            id
            walletCurrency
            balance
            pendingIncomingBalance
          }
        }
      }
    }
  `,

  GET_TRANSACTIONS: `
    query GetTransactions($walletIds: [WalletId], $first: Int, $after: String) {
      me {
        defaultAccount {
          transactions(walletIds: $walletIds, first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              cursor
              node {
                id
                direction
                status
                settlementAmount
                settlementCurrency
                settlementFee
                settlementDisplayAmount
                settlementDisplayCurrency
                settlementDisplayFee
                memo
                createdAt
                externalId
                initiationVia {
                  __typename
                  ... on InitiationViaLn {
                    paymentHash
                    paymentRequest
                  }
                  ... on InitiationViaOnChain {
                    address
                  }
                  ... on InitiationViaIntraLedger {
                    counterPartyUsername
                    counterPartyWalletId
                  }
                }
                settlementVia {
                  __typename
                  ... on SettlementViaLn {
                    preImage
                  }
                  ... on SettlementViaOnChain {
                    transactionHash
                    vout
                  }
                  ... on SettlementViaIntraLedger {
                    counterPartyUsername
                    counterPartyWalletId
                  }
                }
              }
            }
          }
        }
      }
    }
  `,

  GET_TRANSACTION_BY_ID: `
    query GetTransactionById($walletId: WalletId!, $transactionId: ID!) {
      me {
        defaultAccount {
          walletById(walletId: $walletId) {
            transactionById(transactionId: $transactionId) {
              id
              direction
              status
              settlementAmount
              settlementCurrency
              settlementFee
              settlementDisplayAmount
              settlementDisplayCurrency
              settlementDisplayFee
              memo
              createdAt
              externalId
              initiationVia {
                __typename
                ... on InitiationViaLn {
                  paymentHash
                  paymentRequest
                }
                ... on InitiationViaOnChain {
                  address
                }
                ... on InitiationViaIntraLedger {
                  counterPartyUsername
                  counterPartyWalletId
                }
              }
              settlementVia {
                __typename
                ... on SettlementViaLn {
                  preImage
                }
                ... on SettlementViaOnChain {
                  transactionHash
                  vout
                }
                ... on SettlementViaIntraLedger {
                  counterPartyUsername
                  counterPartyWalletId
                }
              }
            }
          }
        }
      }
    }
  `,

  GET_ACCOUNT_LIMITS: `
    query GetAccountLimits {
      me {
        defaultAccount {
          limits {
            withdrawal {
              totalLimit
              remainingLimit
              interval
            }
            internalSend {
              totalLimit
              remainingLimit
              interval
            }
            convert {
              totalLimit
              remainingLimit
              interval
            }
          }
        }
      }
    }
  `,

  // Invoice status queries
  LN_INVOICE_PAYMENT_STATUS_BY_HASH: `
    query LnInvoicePaymentStatusByHash($paymentHash: PaymentHash!) {
      lnInvoicePaymentStatusByHash(input: { paymentHash: $paymentHash }) {
        status
        paymentHash
        paymentPreimage
        paymentRequest
      }
    }
  `,

  LN_INVOICE_PAYMENT_STATUS_BY_REQUEST: `
    query LnInvoicePaymentStatusByRequest($paymentRequest: LnPaymentRequest!) {
      lnInvoicePaymentStatusByPaymentRequest(input: { paymentRequest: $paymentRequest }) {
        status
        paymentHash
        paymentPreimage
        paymentRequest
      }
    }
  `,

  // Price queries
  REALTIME_PRICE: `
    query RealtimePrice($currency: DisplayCurrency) {
      realtimePrice(currency: $currency) {
        id
        timestamp
        btcSatPrice {
          base
          offset
        }
        usdCentPrice {
          base
          offset
        }
        denominatorCurrency
      }
    }
  `,

  BTC_PRICE_LIST: `
    query BtcPriceList($range: PriceGraphRange!) {
      btcPriceList(range: $range) {
        timestamp
        price {
          base
          offset
          currencyUnit
          formattedAmount
        }
      }
    }
  `,

  // Fee estimation queries
  ON_CHAIN_TX_FEE: `
    query OnChainTxFee($walletId: WalletId!, $address: OnChainAddress!, $amount: SatAmount!, $speed: PayoutSpeed) {
      onChainTxFee(walletId: $walletId, address: $address, amount: $amount, speed: $speed) {
        amount
      }
    }
  `,

  ON_CHAIN_USD_TX_FEE: `
    query OnChainUsdTxFee($walletId: WalletId!, $address: OnChainAddress!, $amount: CentAmount!, $speed: PayoutSpeed) {
      onChainUsdTxFee(walletId: $walletId, address: $address, amount: $amount, speed: $speed) {
        amount
      }
    }
  `,

  LN_INVOICE_FEE_PROBE: `
    mutation LnInvoiceFeeProbe($walletId: WalletId!, $paymentRequest: LnPaymentRequest!) {
      lnInvoiceFeeProbe(input: { walletId: $walletId, paymentRequest: $paymentRequest }) {
        amount
        errors {
          message
          code
        }
      }
    }
  `,

  LN_NO_AMOUNT_INVOICE_FEE_PROBE: `
    mutation LnNoAmountInvoiceFeeProbe($walletId: WalletId!, $paymentRequest: LnPaymentRequest!, $amount: SatAmount!) {
      lnNoAmountInvoiceFeeProbe(input: { walletId: $walletId, paymentRequest: $paymentRequest, amount: $amount }) {
        amount
        errors {
          message
          code
        }
      }
    }
  `,

  // Callback/Webhook queries
  GET_CALLBACK_ENDPOINTS: `
    query GetCallbackEndpoints {
      me {
        defaultAccount {
          callbackEndpoints {
            id
            url
          }
        }
      }
    }
  `,

  // Global info
  GLOBALS: `
    query Globals {
      globals {
        network
        lightningAddressDomain
        lightningAddressDomainAliases
        nodesIds
        buildInformation {
          commitHash
          helmRevision
        }
        feesInformation {
          deposit {
            minBankFee
            minBankFeeThreshold
            ratio
          }
        }
      }
    }
  `,

  // Username lookup
  ACCOUNT_DEFAULT_WALLET: `
    query AccountDefaultWallet($username: Username!, $walletCurrency: WalletCurrency) {
      accountDefaultWallet(username: $username, walletCurrency: $walletCurrency) {
        id
        currency
      }
    }
  `,

  USERNAME_AVAILABLE: `
    query UsernameAvailable($username: Username!) {
      usernameAvailable(username: $username)
    }
  `,

  // Currency conversion
  CURRENCY_CONVERSION_ESTIMATION: `
    query CurrencyConversionEstimation($amount: Float!, $currency: DisplayCurrency!) {
      currencyConversionEstimation(amount: $amount, currency: $currency) {
        id
        timestamp
        btcSatAmount
        usdCentAmount
      }
    }
  `,

  CURRENCY_LIST: `
    query CurrencyList {
      currencyList {
        id
        name
        symbol
        flag
        fractionDigits
      }
    }
  `,

  // Authorization scopes
  AUTHORIZATION: `
    query Authorization {
      authorization {
        scopes
      }
    }
  `,
};

export const MUTATIONS = {
  // Lightning Invoice mutations
  LN_INVOICE_CREATE: `
    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        invoice {
          paymentRequest
          paymentHash
          paymentSecret
          satoshis
          externalId
          createdAt
          paymentStatus
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  LN_NO_AMOUNT_INVOICE_CREATE: `
    mutation LnNoAmountInvoiceCreate($input: LnNoAmountInvoiceCreateInput!) {
      lnNoAmountInvoiceCreate(input: $input) {
        invoice {
          paymentRequest
          paymentHash
          paymentSecret
          externalId
          createdAt
          paymentStatus
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  LN_USD_INVOICE_CREATE: `
    mutation LnUsdInvoiceCreate($input: LnUsdInvoiceCreateInput!) {
      lnUsdInvoiceCreate(input: $input) {
        invoice {
          paymentRequest
          paymentHash
          paymentSecret
          satoshis
          externalId
          createdAt
          paymentStatus
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  LN_INVOICE_CANCEL: `
    mutation LnInvoiceCancel($input: LnInvoiceCancelInput!) {
      lnInvoiceCancel(input: $input) {
        success
        errors {
          message
          code
        }
      }
    }
  `,

  // Lightning Payment mutations
  LN_INVOICE_PAYMENT_SEND: `
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  LN_NO_AMOUNT_INVOICE_PAYMENT_SEND: `
    mutation LnNoAmountInvoicePaymentSend($input: LnNoAmountInvoicePaymentInput!) {
      lnNoAmountInvoicePaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  LN_NO_AMOUNT_USD_INVOICE_PAYMENT_SEND: `
    mutation LnNoAmountUsdInvoicePaymentSend($input: LnNoAmountUsdInvoicePaymentInput!) {
      lnNoAmountUsdInvoicePaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  LN_ADDRESS_PAYMENT_SEND: `
    mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
      lnAddressPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  LNURL_PAYMENT_SEND: `
    mutation LnurlPaymentSend($input: LnurlPaymentSendInput!) {
      lnurlPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  // On-chain mutations
  ON_CHAIN_ADDRESS_CREATE: `
    mutation OnChainAddressCreate($input: OnChainAddressCreateInput!) {
      onChainAddressCreate(input: $input) {
        address
        errors {
          message
          code
          path
        }
      }
    }
  `,

  ON_CHAIN_ADDRESS_CURRENT: `
    mutation OnChainAddressCurrent($input: OnChainAddressCurrentInput!) {
      onChainAddressCurrent(input: $input) {
        address
        errors {
          message
          code
          path
        }
      }
    }
  `,

  ON_CHAIN_PAYMENT_SEND: `
    mutation OnChainPaymentSend($input: OnChainPaymentSendInput!) {
      onChainPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  ON_CHAIN_PAYMENT_SEND_ALL: `
    mutation OnChainPaymentSendAll($input: OnChainPaymentSendAllInput!) {
      onChainPaymentSendAll(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  ON_CHAIN_USD_PAYMENT_SEND: `
    mutation OnChainUsdPaymentSend($input: OnChainUsdPaymentSendInput!) {
      onChainUsdPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  // Intraledger mutations
  INTRA_LEDGER_PAYMENT_SEND: `
    mutation IntraLedgerPaymentSend($input: IntraLedgerPaymentSendInput!) {
      intraLedgerPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  INTRA_LEDGER_USD_PAYMENT_SEND: `
    mutation IntraLedgerUsdPaymentSend($input: IntraLedgerUsdPaymentSendInput!) {
      intraLedgerUsdPaymentSend(input: $input) {
        status
        errors {
          message
          code
          path
        }
        transaction {
          id
          direction
          status
          settlementAmount
          settlementCurrency
          settlementFee
          memo
          createdAt
        }
      }
    }
  `,

  // Callback/Webhook mutations
  CALLBACK_ENDPOINT_ADD: `
    mutation CallbackEndpointAdd($input: CallbackEndpointAddInput!) {
      callbackEndpointAdd(input: $input) {
        id
        errors {
          message
          code
          path
        }
      }
    }
  `,

  CALLBACK_ENDPOINT_DELETE: `
    mutation CallbackEndpointDelete($input: CallbackEndpointDeleteInput!) {
      callbackEndpointDelete(input: $input) {
        success
        errors {
          message
          code
          path
        }
      }
    }
  `,

  // Account mutations
  ACCOUNT_UPDATE_DEFAULT_WALLET_ID: `
    mutation AccountUpdateDefaultWalletId($input: AccountUpdateDefaultWalletIdInput!) {
      accountUpdateDefaultWalletId(input: $input) {
        account {
          id
          defaultWalletId
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  ACCOUNT_UPDATE_DISPLAY_CURRENCY: `
    mutation AccountUpdateDisplayCurrency($input: AccountUpdateDisplayCurrencyInput!) {
      accountUpdateDisplayCurrency(input: $input) {
        account {
          id
          displayCurrency
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  // User mutations
  USER_UPDATE_USERNAME: `
    mutation UserUpdateUsername($input: UserUpdateUsernameInput!) {
      userUpdateUsername(input: $input) {
        user {
          id
          username
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  USER_UPDATE_LANGUAGE: `
    mutation UserUpdateLanguage($input: UserUpdateLanguageInput!) {
      userUpdateLanguage(input: $input) {
        user {
          id
          language
        }
        errors {
          message
          code
          path
        }
      }
    }
  `,

  // Device token for push notifications
  DEVICE_NOTIFICATION_TOKEN_CREATE: `
    mutation DeviceNotificationTokenCreate($input: DeviceNotificationTokenCreateInput!) {
      deviceNotificationTokenCreate(input: $input) {
        success
        errors {
          message
          code
        }
      }
    }
  `,

  // Feedback
  FEEDBACK_SUBMIT: `
    mutation FeedbackSubmit($input: FeedbackSubmitInput!) {
      feedbackSubmit(input: $input) {
        success
        errors {
          message
          code
        }
      }
    }
  `,
};

export const SUBSCRIPTIONS = {
  // Real-time invoice payment status
  LN_INVOICE_PAYMENT_STATUS: `
    subscription LnInvoicePaymentStatus($paymentRequest: LnPaymentRequest!) {
      lnInvoicePaymentStatusByPaymentRequest(input: { paymentRequest: $paymentRequest }) {
        status
        paymentHash
        paymentPreimage
        paymentRequest
        errors {
          message
          code
        }
      }
    }
  `,

  LN_INVOICE_PAYMENT_STATUS_BY_HASH: `
    subscription LnInvoicePaymentStatusByHash($paymentHash: PaymentHash!) {
      lnInvoicePaymentStatusByHash(input: { paymentHash: $paymentHash }) {
        status
        paymentHash
        paymentPreimage
        paymentRequest
        errors {
          message
          code
        }
      }
    }
  `,

  // Real-time account updates (transactions, prices)
  MY_UPDATES: `
    subscription MyUpdates {
      myUpdates {
        errors {
          message
          code
        }
        update {
          __typename
          ... on LnUpdate {
            status
            paymentHash
            transaction {
              id
              direction
              status
              settlementAmount
              settlementCurrency
              settlementFee
              memo
              createdAt
            }
          }
          ... on OnChainUpdate {
            txHash
            transaction {
              id
              direction
              status
              settlementAmount
              settlementCurrency
              settlementFee
              memo
              createdAt
            }
          }
          ... on IntraLedgerUpdate {
            transaction {
              id
              direction
              status
              settlementAmount
              settlementCurrency
              settlementFee
              memo
              createdAt
            }
          }
          ... on RealtimePrice {
            id
            timestamp
            btcSatPrice {
              base
              offset
            }
            usdCentPrice {
              base
              offset
            }
            denominatorCurrency
          }
        }
      }
    }
  `,

  // Real-time price updates
  REALTIME_PRICE: `
    subscription RealtimePrice($currency: DisplayCurrency) {
      realtimePrice(input: { currency: $currency }) {
        realtimePrice {
          id
          timestamp
          btcSatPrice {
            base
            offset
          }
          usdCentPrice {
            base
            offset
          }
          denominatorCurrency
        }
        errors {
          message
          code
        }
      }
    }
  `,

  // Price subscription (legacy)
  PRICE: `
    subscription Price($amount: SatAmount!, $amountCurrencyUnit: ExchangeCurrencyUnit!, $priceCurrencyUnit: ExchangeCurrencyUnit!) {
      price(input: { amount: $amount, amountCurrencyUnit: $amountCurrencyUnit, priceCurrencyUnit: $priceCurrencyUnit }) {
        price {
          base
          offset
          currencyUnit
          formattedAmount
        }
        errors {
          message
          code
        }
      }
    }
  `,
};
