# MintHunter

MintHunter is an Ethereum-mainnet Telegram bot for floor-price alerts and user-confirmed NFT mint transactions.

## Features

- Floor-price alerts with above, below, and equality threshold handling.
- Verified-ABI mint transaction preparation and on-chain simulation.
- Normal and configured-RPC FCFS broadcast modes.
- AES-256-GCM encrypted wallet storage with per-user key derivation.
- Ethereum-mainnet-only transaction validation.
- Trending Ethereum NFT collection data with bounded caching and retries.

## Setup

Create a private environment file from the template and provide every required secret. The bot fails closed if `BOT_TOKEN`, `ENCRYPTION_KEY`, `FEE_WALLET`, `FCFS_FEE_ETH`, or a trusted Ethereum RPC endpoint is missing or invalid.

```bash
cp .env.example .env
# Edit .env with the private runtime values
npm install
npm test
npm start
```

Sensitive files such as `.env`, SQLite databases, and generated access-code lists are intentionally ignored and must be managed outside Git. The access-code generator prints codes to standard output only:

```bash
node scripts/generate-codes.js 30 30
```

Wallet imports must be performed in the bot’s private Telegram chat. The bot never executes a transaction from guessed empty calldata, and the Execute button remains an explicit user confirmation even when simulation is skipped.

## Fee

FCFS service fees are collected only after a mint transaction is confirmed successfully. Configure the fee wallet and amount through `.env`; there is no hard-coded fallback wallet.
