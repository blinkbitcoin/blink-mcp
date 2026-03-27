# Blink MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI assistants with access to the [Blink](https://blink.sv) Bitcoin and Lightning Network API.

## Features

- **Lightning Network**: Create and pay invoices, send to Lightning addresses
- **On-Chain Bitcoin**: Generate addresses, send transactions, estimate fees
- **Stablesats (USD)**: Full support for USD-denominated wallets
- **Intraledger Transfers**: Free instant transfers between Blink users
- **Webhooks**: Register callbacks for payment notifications
- **Real-time Subscriptions**: Monitor invoice status and account updates
- **Price Data**: Get real-time and historical Bitcoin prices
- **L402 Consumer**: Discover, pay for, and cache tokens for L402-gated APIs
- **L402 Producer**: Create Lightning paywalls and verify payment tokens
- **L402 Discovery**: Search l402.directory and 402index.io for paid APIs

## Prerequisites

- Node.js 18+
- A Blink wallet account ([dashboard.blink.sv](https://dashboard.blink.sv))
- A Blink API key

## Installation

### From Source

```bash
git clone https://github.com/yourusername/blink-mcp.git
cd blink-mcp
npm install
npm run build
```

### Getting an API Key

1. Log in to your Blink wallet at [dashboard.blink.sv](https://dashboard.blink.sv)
2. Go to **Settings** > **API Keys**
3. Click **Create API Key**
4. Select the permissions you need:
   - **Read**: View balances, transactions, and account info
   - **Receive**: Create invoices and addresses to receive payments
   - **Write**: Send payments and modify account settings
5. Copy the generated API key

## Configuration

Set the following environment variables:

```bash
# Required: Your Blink API key
export BLINK_API_KEY=blink_xxxxxxxxxxxxx

# Optional: Network to use (default: mainnet)
export BLINK_NETWORK=mainnet  # or 'staging' for testnet
```

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`~/.config/claude/claude_desktop_config.json` on Linux/Mac or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "blink": {
      "command": "node",
      "args": ["/path/to/blink-mcp/dist/index.js"],
      "env": {
        "BLINK_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Or if installed globally via npm:

```json
{
  "mcpServers": {
    "blink": {
      "command": "blink-mcp",
      "env": {
        "BLINK_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Usage with Other MCP Clients

The server uses stdio transport. Run it with:

```bash
BLINK_API_KEY=your_key node dist/index.js
```

## Available Tools

### Wallet & Account (17 tools)

| Tool                       | Description                          |
| -------------------------- | ------------------------------------ |
| `get_account_info`         | Get current user account information |
| `get_wallets`              | List all wallets with balances       |
| `get_wallet_balance`       | Get balance of a specific wallet     |
| `get_transactions`         | Get transaction history (paginated)  |
| `get_transaction_by_id`    | Get specific transaction details     |
| `get_account_limits`       | View withdrawal and transfer limits  |
| `set_default_wallet`       | Set default wallet (BTC or USD)      |
| `set_display_currency`     | Set display currency preference      |
| `get_realtime_price`       | Get current Bitcoin price            |
| `get_price_history`        | Get historical price data            |
| `convert_currency`         | Convert between fiat and Bitcoin     |
| `get_supported_currencies` | List supported currencies            |
| `lookup_user_wallet`       | Find wallet by Blink username        |
| `check_username_available` | Check username availability          |
| `set_username`             | Set/update your username             |
| `get_authorization_scopes` | View API key permissions             |
| `get_network_info`         | Get Lightning node info              |

### Lightning Network (12 tools)

| Tool                               | Description                      |
| ---------------------------------- | -------------------------------- |
| `create_invoice`                   | Create BTC Lightning invoice     |
| `create_invoice_usd`               | Create USD-denominated invoice   |
| `create_invoice_no_amount`         | Create open (any amount) invoice |
| `cancel_invoice`                   | Cancel unpaid invoice            |
| `get_invoice_status`               | Check invoice status by hash     |
| `get_invoice_status_by_request`    | Check status by bolt11           |
| `pay_invoice`                      | Pay a Lightning invoice          |
| `pay_invoice_with_amount`          | Pay open invoice with amount     |
| `pay_lightning_address`            | Send to Lightning address        |
| `pay_lnurl`                        | Pay via LNURL                    |
| `estimate_lightning_fee`           | Estimate payment fee             |
| `estimate_lightning_fee_no_amount` | Estimate fee for open invoice    |

### On-Chain Bitcoin (7 tools)

| Tool                          | Description                    |
| ----------------------------- | ------------------------------ |
| `create_onchain_address`      | Generate new receiving address |
| `get_current_onchain_address` | Get current address            |
| `send_onchain`                | Send BTC on-chain              |
| `send_onchain_all`            | Sweep entire balance           |
| `send_onchain_usd`            | Send from USD wallet on-chain  |
| `estimate_onchain_fee`        | Estimate BTC transaction fee   |
| `estimate_onchain_fee_usd`    | Estimate USD wallet fee        |

### Intraledger (Blink-to-Blink) (3 tools)

| Tool                 | Description                           |
| -------------------- | ------------------------------------- |
| `send_to_wallet`     | Send BTC to wallet ID (free, instant) |
| `send_to_wallet_usd` | Send USD to wallet ID                 |
| `send_to_username`   | Send to Blink username                |

### Webhooks & Subscriptions (9 tools)

| Tool                               | Description                     |
| ---------------------------------- | ------------------------------- |
| `list_webhooks`                    | List registered webhooks        |
| `add_webhook`                      | Register webhook endpoint       |
| `remove_webhook`                   | Remove webhook                  |
| `subscribe_invoice_status`         | Subscribe to invoice updates    |
| `subscribe_invoice_status_by_hash` | Subscribe by payment hash       |
| `subscribe_account_updates`        | Subscribe to all account events |
| `subscribe_price_updates`          | Subscribe to price changes      |
| `list_subscriptions`               | List active subscriptions       |
| `cancel_subscription`              | Cancel a subscription           |
| `cancel_all_subscriptions`         | Cancel all subscriptions        |

### L402 Protocol (6 tools)

| Tool                     | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `l402_discover`          | Probe a URL for L402 payment requirements (no payment)             |
| `l402_pay`               | Access an L402-protected URL, paying automatically via Blink       |
| `l402_store`             | Manage the L402 token cache (~/.blink/l402-tokens.json)            |
| `l402_challenge_create`  | Create an L402 payment challenge (invoice + signed macaroon)       |
| `l402_payment_verify`    | Verify an L402 payment token (preimage + HMAC signature + caveats) |
| `l402_search`            | Search L402 service directories (l402.directory or 402index.io)    |

## Example Conversations

### Check Balance

```
User: What's my Bitcoin balance?
Assistant: [Uses get_wallets tool]
Your BTC wallet has 50,000 sats and your USD wallet has $12.50.
```

### Create Invoice

```
User: Create an invoice for 10,000 sats
Assistant: [Uses create_invoice tool]
Here's your Lightning invoice for 10,000 sats:
lnbc100u1p...
```

### Send Payment

```
User: Send 1000 sats to user@blink.sv
Assistant: [Uses pay_lightning_address tool]
Payment of 1,000 sats sent successfully to user@blink.sv!
```

### Monitor Invoice

```
User: Let me know when invoice lnbc... is paid
Assistant: [Uses subscribe_invoice_status tool]
I'm now monitoring the invoice. I'll notify you when it's paid.
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Architecture

```
src/
├── index.ts              # MCP server entry point
├── client.ts             # Blink GraphQL client
├── types.ts              # TypeScript type definitions
├── graphql/
│   └── operations.ts     # GraphQL queries, mutations, subscriptions
└── tools/
    ├── wallet.ts         # Wallet and account tools
    ├── lightning.ts      # Lightning Network tools
    ├── onchain.ts        # On-chain Bitcoin tools
    ├── intraledger.ts    # Blink-to-Blink transfer tools
    ├── webhooks.ts       # Webhook and subscription tools
    └── l402.ts           # L402 consumer, producer, and discovery tools
```

## API Reference

This MCP server wraps the [Blink GraphQL API](https://dev.blink.sv/). For detailed API documentation, visit:

- [Blink Agent Playbook](https://dev.blink.sv/api/agent-playbook): Canonical AI agent API reference — order of operations, safety constraints, and verification checklist.
- [Blink Developer Docs](https://dev.blink.sv/)
- [Blink API Playground](https://api.blink.sv/)
- [llms.txt](https://dev.blink.sv/llms.txt): Machine-readable discovery metadata for AI agents.

## Security Considerations

- **API Key Security**: Never commit your API key to version control
- **Permission Scoping**: Use the minimum required permissions for your use case
- **Write Operations**: Be cautious with write permissions as they allow sending funds
- **Environment Variables**: Store API keys in environment variables, not in config files

## Troubleshooting

### "BLINK_API_KEY environment variable is required"

Make sure you've set the `BLINK_API_KEY` environment variable with your API key.

### "GraphQL Error: Not authorized"

Your API key may not have the required permissions. Check your key's scopes in the Blink wallet settings.

### WebSocket connection issues

Real-time subscriptions require a stable connection. Check your network and firewall settings.

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Links

- [Blink Wallet](https://blink.sv)
- [Blink Developer Docs](https://dev.blink.sv/)
- [Blink Agent Playbook](https://dev.blink.sv/api/agent-playbook)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
