/**
 * MintHunter - Supported Chain Configuration
 *
 * Each entry fully describes one chain MintHunter can operate on: chain ID,
 * the environment variable names holding its RPC endpoints, its block
 * explorer API details (for verified-ABI lookups), native currency symbol,
 * and the URL format used to build explorer links.
 *
 * Adding a new chain means adding an entry here. No other module should
 * hardcode a chain ID, an explorer host, or an RPC env var name.
 */

const CHAINS = {
  ethereum: {
    id: 'ethereum',
    chainId: 1,
    name: 'Ethereum',
    shortLabel: 'ETH',
    nativeSymbol: 'ETH',
    // At least one of these (or an entry in BROADCAST_RPCS) must be configured.
    rpcEnvKeys: ['ALCHEMY_RPC', 'INFURA_RPC', 'QUICKNODE_RPC'],
    broadcastRpcsEnvKey: 'BROADCAST_RPCS',
    flashbotsRpcEnvKey: 'FLASHBOTS_RPC',
    explorer: {
      // Etherscan v2 API: requires chainid= on every call plus an API key.
      apiUrl: 'https://api.etherscan.io/v2/api',
      apiKeyEnvKey: 'ETHERSCAN_API_KEY',
      apiStyle: 'etherscan-v2',
      baseUrl: 'https://etherscan.io',
    },
    // Floor price / trending data source (Phase 5). Ethereum keeps its
    // original provider chain: Alchemy NFT API first, SimpleHash as a
    // fallback, CoinGecko for the trending list. `trendingSupported` tells
    // callers whether src/services/floor.js has a real trending
    // implementation wired up for this chain at all.
    floorPriceProvider: {
      type: 'alchemy-simplehash-ethereum',
      trendingSupported: true,
    },
    // Used only as a hint for FCFS timing; not authoritative.
    approxBlockTimeMs: 12_000,
  },
  robinhood: {
    id: 'robinhood',
    chainId: 4663,
    name: 'Robinhood Chain',
    shortLabel: 'Robinhood',
    nativeSymbol: 'ETH',
    rpcEnvKeys: ['ROBINHOOD_ALCHEMY_RPC', 'ROBINHOOD_QUICKNODE_RPC'],
    broadcastRpcsEnvKey: 'ROBINHOOD_BROADCAST_RPCS',
    // Robinhood Chain has no Flashbots-style private relay at this time.
    flashbotsRpcEnvKey: null,
    // Informational only - MintHunter never falls back to a public RPC
    // automatically. An operator can still put this URL into
    // ROBINHOOD_BROADCAST_RPCS explicitly if they choose to trust it.
    publicRpcFallback: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: {
      // Blockscout's Etherscan-compatible API. Works keyless at low volume;
      // set ROBINHOOD_BLOCKSCOUT_API_KEY to raise rate limits if needed.
      apiUrl: 'https://robinhoodchain.blockscout.com/api',
      apiKeyEnvKey: 'ROBINHOOD_BLOCKSCOUT_API_KEY',
      apiStyle: 'blockscout-etherscan-compat',
      baseUrl: 'https://robinhoodchain.blockscout.com',
    },
    // Floor price / trending data source (Phase 5). As of this writing,
    // neither Alchemy's NFT API nor SimpleHash (SimpleHash's public API was
    // discontinued in March 2025 after its acquisition by Phantom) list
    // Robinhood Chain support. OpenSea, however, launched full marketplace
    // support for Robinhood Chain at chain launch, and its v2 REST API
    // accepts "robinhood" as a first-class `chain` slug (see
    // https://docs.opensea.io/reference/get_chains and
    // https://opensea.io/blog/articles/robinhood-chain-is-live-on-opensea).
    // src/services/floor.js routes Robinhood Chain floor lookups through
    // OpenSea's `/v2/chain/{chain}/contract/{address}` (address -> slug) and
    // `/v2/collections/{slug}/stats` (slug -> floor_price) endpoints, gated
    // on OPENSEA_API_KEY being configured. There is no confirmed, documented
    // "trending collections on chain X" endpoint, so `trendingSupported` is
    // false here - getTrending() returns an empty list for this chain until
    // a real trending data source is integrated.
    floorPriceProvider: {
      type: 'opensea',
      openseaChainSlug: 'robinhood',
      apiKeyEnvKey: 'OPENSEA_API_KEY',
      trendingSupported: false,
    },
    // Rough placeholder - Robinhood Chain batches to Ethereum via EIP-4844
    // blobs and runs a fast L2 execution layer. Tune this in Phase 6/7 once
    // real block times are measured against production RPCs.
    approxBlockTimeMs: 2_000,
  },
}

const DEFAULT_CHAIN = 'ethereum'

function listChains() {
  return Object.values(CHAINS)
}

function normalizeChainKey(chainKey) {
  return String(chainKey || DEFAULT_CHAIN).toLowerCase()
}

function isSupportedChain(chainKey) {
  return Object.prototype.hasOwnProperty.call(CHAINS, normalizeChainKey(chainKey))
}

function getChain(chainKey) {
  const key = normalizeChainKey(chainKey)
  const chain = CHAINS[key]
  if (!chain) {
    throw new Error(`Unsupported chain "${chainKey}". Supported chains: ${Object.keys(CHAINS).join(', ')}`)
  }
  return chain
}

function txUrl(chainKey, txHash) {
  return `${getChain(chainKey).explorer.baseUrl}/tx/${txHash}`
}

function addressUrl(chainKey, address) {
  return `${getChain(chainKey).explorer.baseUrl}/address/${address}`
}

module.exports = {
  CHAINS,
  DEFAULT_CHAIN,
  listChains,
  normalizeChainKey,
  isSupportedChain,
  getChain,
  txUrl,
  addressUrl,
}
