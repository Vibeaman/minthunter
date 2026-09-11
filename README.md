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

## Read-only FCFS benchmark

Run the benchmark from the same Railway service or region where MintHunter will run. It measures configured RPC latency, parallel balance/nonce/fee-data reads, and the first-success provider race. It never reads private keys, signs transactions, or submits transactions.

The benchmark runs against every chain defined in `src/chains.js` (Ethereum and Robinhood Chain) using each chain's RPC env vars. Endpoints are verified against their expected chain ID,and a fastest-provider race is reported per chain.

```bash
npm run benchmark:fcfs
```

Useful options are available through environment variables:

```bash
BENCHMARK_ITERATIONS=30
BENCHMARK_TIMEOUT_MS=8000
BENCHMARK_INCLUDE_FLASHBOTS=false
BENCHMARK_OUTPUT_FILE=benchmark-results.json
```

To measure the real contract preparation path without broadcasting, additionally provide the contract address, verified calldata, and preferably the intended sender address. The calldata must be generated from the verified ABI; do not paste a private key or a signed transaction.

```bash
BENCHMARK_CONTRACT_ADDRESS=0x...
BENCHMARK_MINT_DATA=0x...
BENCHMARK_FROM_ADDRESS=0x...
BENCHMARK_VALUE_ETH=0
npm run benchmark:fcfs -- --json
```

The JSON report contains p50, p95, and p99 timings, success rates, timeout/error counts, endpoint health, and which provider won the read-only race. It intentionally omits full RPC URLs and sensitive transaction material.

Wallet imports must be performed in the bot’s private Telegram chat. The bot never executes a transaction from guessed empty calldata, and the Execute button remains an explicit user confirmation even when simulation is skipped.

## Railway deployment

MintHunter is a long-running Telegram polling bot. Deploy it as a **single service** from this repository; the included Dockerfile and `railway.json` configure the start process, `/health` readiness check, restart policy, and a short graceful-drain period.

Before the first production deployment, attach one Railway Volume to the service at `/data`. Railway makes its mount path available at runtime, and MintHunter automatically stores `minthunter.db` there. Without the volume, Railway’s deployment filesystem is ephemeral and user accounts, encrypted wallet records, alerts, scheduled jobs, and access codes would be lost on a restart or redeploy.

Set the following service variables in Railway. Enter values through Railway’s secret manager only; never add them to Git.

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | Yes | Telegram bot token. |
| `ENCRYPTION_KEY` | Yes | 64-character hex key used to encrypt wallet keys. Keep this stable after launch; changing it makes existing encrypted wallet records unreadable. |
| `FEE_WALLET` | Yes | Valid non-zero Ethereum address that receives confirmed FCFS service fees. |
| `FCFS_FEE_ETH` | Yes | Positive FCFS service-fee amount in ETH. |
| `ALCHEMY_RPC`, `INFURA_RPC`, `QUICKNODE_RPC`, or `BROADCAST_RPCS` | At least one | Trusted Ethereum mainnet RPC endpoint for reads and transaction broadcasting. |
| `ETHERSCAN_API_KEY` | Recommended | Verified ABI lookup for safe mint-function analysis. |
| `FLASHBOTS_RPC` | Optional | Additional configured FCFS broadcast endpoint. |
| `SIMPLEHASH_API_KEY` | Optional | Floor-price fallback data source. |

Railway supplies `PORT` and the volume mount path automatically. The bot exposes `GET /health`; it returns HTTP 200 only after the database, bot polling, and background workers are ready. Do not run multiple replicas of the same bot token, because Telegram polling and the SQLite-backed state require a single active process.

For an existing local database, back up `minthunter.db` before launch and upload or copy it into the attached volume before the first production start. A volume-backed service has brief downtime during redeploys, so avoid redeploying near an active scheduled mint.

## Fee

FCFS service fees are collected only after a mint transaction is confirmed successfully. Configure the fee wallet and amount through `.env`; there is no hard-coded fallback wallet.
