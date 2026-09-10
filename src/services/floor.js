const https = require('https')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const { getChain, DEFAULT_CHAIN, normalizeChainKey } = require('../chains')

const ALCHEMY_API_KEY = (() => {
  try {
    const url = new URL(process.env.ALCHEMY_RPC || '')
    return url.hostname.endsWith('alchemy.com') ? url.pathname.split('/').pop() : ''
  } catch {
    return ''
  }
})()
const SIMPLEHASH_API_KEY = process.env.SIMPLEHASH_API_KEY || ''
const ETH_PRICE_CACHE_TTL = 5 * 60 * 1000
const TRENDING_CACHE_TTL = 10 * 60 * 1000
const TOP_ETHEREUM_COLLECTIONS = [
  'bored-ape-yacht-club',
  'cryptopunks',
  'mutant-ape-yacht-club',
  'azuki',
  'pudgy-penguins',
  'milady-maker',
  'doodles-official',
  'clonex',
  'moonbirds',
]

let cachedEthPrice = null
let ethPriceCacheTime = 0
let trendingCache = null
let trendingCacheTime = 0

/**
 * Get floor-price data for a collection on the given chain. `chain`
 * defaults to DEFAULT_CHAIN (ethereum) so existing callers keep working
 * unchanged. Routes to the provider configured in chains.js's
 * `floorPriceProvider.type` for the chain - no chain-specific branching
 * lives outside chains.js + this dispatcher.
 *
 * Returns `null` when a normal "no data found" case occurs (matches the
 * original Ethereum-only behavior exactly, so existing callers that check
 * `!priceData` keep working). When a chain's provider is unsupported,
 * unconfigured, or the data genuinely isn't available yet, returns an
 * object with `floor: null` and `unsupported: true` plus a human-readable
 * `reason`, so callers can show a clear message instead of silently
 * treating it like "no alert should fire" or crashing.
 */
async function getFloorPrice(contractAddress, chain = DEFAULT_CHAIN) {
  if (!ethers.isAddress(contractAddress)) return null
  const address = ethers.getAddress(contractAddress)
  const chainConfig = getChain(chain)
  const provider = chainConfig.floorPriceProvider

  if (provider?.type === 'alchemy-simplehash-ethereum') {
    return getFloorPriceEthereumLegacy(address)
  }

  if (provider?.type === 'opensea') {
    return getFloorPriceFromOpenSea(address, chainConfig, provider)
  }

  console.error(`No floor-price provider configured for chain ${chainConfig.id}`)
  return {
    floor: null,
    name: null,
    symbol: '',
    source: 'none',
    unsupported: true,
    reason: `Floor price lookups aren't configured yet for ${chainConfig.name}.`,
  }
}

/**
 * Original Ethereum-only floor lookup: Alchemy NFT API first, SimpleHash as
 * a fallback. Left byte-for-byte equivalent to the pre-Phase-5 behavior.
 */
async function getFloorPriceEthereumLegacy(address) {
  if (ALCHEMY_API_KEY) {
    try {
      const data = await fetchJson(
        `https://eth-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(ALCHEMY_API_KEY)}/getFloorPrice?contractAddress=${address}`,
      )
      const floor = data?.openSea?.floorPrice ?? data?.looksRare?.floorPrice
      if (typeof floor === 'number' && Number.isFinite(floor)) {
        return { floor, name: data.openSea?.collectionName || 'Unknown', symbol: '', source: 'alchemy' }
      }
    } catch (error) {
      console.error(`Alchemy floor error for ${address}: ${error.message}`)
    }
  }

  if (!SIMPLEHASH_API_KEY) return null
  try {
    const data = await fetchJson(
      `https://api.simplehash.com/api/v0/nfts/collections/ethereum/${address}`,
      { 'X-API-KEY': SIMPLEHASH_API_KEY },
    )
    const floor = data?.floor_prices?.[0]?.value
    if (typeof floor === 'number' && Number.isFinite(floor)) {
      return {
        floor: floor / 1e18,
        name: data.name || 'Unknown',
        symbol: data.symbol || '',
        source: 'simplehash',
      }
    }
  } catch (error) {
    console.error(`SimpleHash floor error for ${address}: ${error.message}`)
  }

  return null
}

/**
 * Floor lookup via OpenSea's v2 API for chains that don't have Alchemy/
 * SimpleHash coverage (Robinhood Chain as of Phase 5). OpenSea assigns each
 * NFT contract to a "collection" slug, so this is a two-step lookup:
 * `/v2/chain/{chain}/contract/{address}` resolves the address to a slug,
 * then `/v2/collections/{slug}/stats` returns `total.floor_price`.
 * Requires `providerConfig.apiKeyEnvKey` (OPENSEA_API_KEY) to be configured;
 * OpenSea's public API is not usable keyless.
 */
async function getFloorPriceFromOpenSea(address, chainConfig, providerConfig) {
  const apiKey = process.env[providerConfig.apiKeyEnvKey] || ''
  if (!apiKey) {
    console.error(`OpenSea floor price unavailable for ${chainConfig.name}: ${providerConfig.apiKeyEnvKey} is not configured`)
    return {
      floor: null,
      name: null,
      symbol: '',
      source: 'opensea',
      unsupported: true,
      reason: `Floor price lookups for ${chainConfig.name} need an OpenSea API key (${providerConfig.apiKeyEnvKey}) that isn't configured yet.`,
    }
  }

  const headers = { 'x-api-key': apiKey }

  try {
    const contractInfo = await fetchJson(
      `https://api.opensea.io/api/v2/chain/${providerConfig.openseaChainSlug}/contract/${address}`,
      headers,
    )
    const slug = contractInfo?.collection
    if (!slug) {
      return {
        floor: null,
        name: null,
        symbol: '',
        source: 'opensea',
        unsupported: true,
        reason: `OpenSea doesn't have this contract catalogued as a collection on ${chainConfig.name} yet.`,
      }
    }

    const stats = await fetchJson(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`,
      headers,
    )
    const floor = stats?.total?.floor_price
    if (typeof floor !== 'number' || !Number.isFinite(floor)) {
      return {
        floor: null,
        name: contractInfo?.name || slug,
        symbol: stats?.total?.floor_price_symbol || '',
        source: 'opensea',
        unsupported: true,
        reason: `OpenSea has no floor price listed yet for "${slug}" on ${chainConfig.name}.`,
      }
    }

    return {
      floor,
      name: contractInfo?.name || slug,
      symbol: stats.total.floor_price_symbol || '',
      source: 'opensea',
    }
  } catch (error) {
    console.error(`OpenSea floor error for ${address} on ${chainConfig.name}: ${error.message}`)
    return {
      floor: null,
      name: null,
      symbol: '',
      source: 'opensea',
      unsupported: true,
      reason: `Couldn't reach OpenSea for ${chainConfig.name}: ${error.message}`,
    }
  }
}

async function checkAlerts(db, bot) {
  const alerts = db.prepare(`
    SELECT fa.*, u.telegram_id
    FROM floor_alerts fa
    JOIN users u ON fa.telegram_id = u.telegram_id
    WHERE fa.is_active = 1
      AND u.is_authorized = 1
      AND (u.access_expires IS NULL OR datetime(u.access_expires) > datetime('now'))
  `).all()
  if (alerts.length === 0) return []

  const triggered = []
  // Group by chain *and* address - the same contract address is a
  // different collection on each chain, and each alert carries its own
  // `chain` column (Phase 2), so the floor lookup must be per-chain rather
  // than assuming every alert is on Ethereum.
  const collections = new Map()
  for (const alert of alerts) {
    if (!ethers.isAddress(alert.collection_address)) {
      console.error(`Skipping invalid alert address for alert #${alert.id}`)
      continue
    }
    const address = ethers.getAddress(alert.collection_address)
    const chain = normalizeChainKey(alert.chain)
    const key = `${chain}:${address}`
    if (!collections.has(key)) collections.set(key, { chain, address, alerts: [] })
    collections.get(key).alerts.push(alert)
  }

  for (const { chain, address, alerts: collectionAlerts } of collections.values()) {
    try {
      const priceData = await getFloorPrice(address, chain)
      if (!priceData || priceData.floor == null) {
        if (priceData?.unsupported) {
          console.log(`Skipping alert check for ${address} on ${chain}: ${priceData.reason}`)
        }
        continue
      }
      const currentFloor = Number(priceData.floor)
      if (!Number.isFinite(currentFloor)) continue

      for (const alert of collectionAlerts) {
        const target = Number(alert.target_price)
        const shouldTrigger = alert.condition === 'below'
          ? currentFloor <= target
          : alert.condition === 'above' && currentFloor >= target
        if (!shouldTrigger) continue

        const symbol = alert.condition === 'below' ? '📉' : '📈'
        const nativeSymbol = getChain(chain).nativeSymbol
        await bot.sendMessage(alert.telegram_id,
          `🚨 *Floor Alert Triggered!*\n\n` +
          `${symbol} *${collectionName(priceData.name)}* (${getChain(chain).name})\n\n` +
          `Current floor: *${currentFloor.toFixed(4)} ${nativeSymbol}*\n` +
          `Your target: ${alert.condition} ${alert.target_price} ${nativeSymbol}\n\n` +
          `Contract: \`${address.slice(0, 10)}...\``,
          { parse_mode: 'Markdown' },
        )
        db.prepare('UPDATE floor_alerts SET is_active = 0 WHERE id = ? AND is_active = 1').run(alert.id)
        triggered.push({ alert, currentFloor, collectionName: priceData.name })
      }
      await sleep(500)
    } catch (error) {
      console.error(`Alert check error for ${address} on ${chain}: ${error.message}`)
    }
  }

  return triggered
}

/**
 * Get trending collections for the given chain. `chain` defaults to
 * DEFAULT_CHAIN (ethereum) for backward compatibility. Routes on chains.js's
 * `floorPriceProvider.trendingSupported` flag - only Ethereum has a real
 * trending data source wired up as of Phase 5 (CoinGecko's NFT endpoint).
 * Chains without one (Robinhood Chain: no confirmed, documented
 * "trending"/"top movers" API from OpenSea or anyone else yet) get an empty
 * list back rather than Ethereum data or a crash.
 */
async function getTrending(chain = DEFAULT_CHAIN) {
  const chainConfig = getChain(chain)
  if (!chainConfig.floorPriceProvider?.trendingSupported) {
    console.log(`Trending collections not yet supported for chain ${chainConfig.id}`)
    return []
  }
  return getTrendingEthereumLegacy()
}

/**
 * Original Ethereum-only trending implementation (CoinGecko), left
 * byte-for-byte equivalent to the pre-Phase-5 behavior.
 */
async function getTrendingEthereumLegacy() {
  if (trendingCache && Date.now() - trendingCacheTime < TRENDING_CACHE_TTL) return trendingCache
  const results = []
  for (const id of TOP_ETHEREUM_COLLECTIONS) {
    try {
      const data = await fetchJson(`https://api.coingecko.com/api/v3/nfts/${id}`)
      if (data?.name) {
        results.push({
          name: data.name,
          floor: data.floor_price?.native_currency || 0,
          floorUsd: data.floor_price?.usd || 0,
          volume24h: data.volume_24h?.native_currency || 0,
          change24h: data.floor_price_24h_percentage_change?.native_currency || 0,
          address: data.contract_address,
        })
      }
      await sleep(500)
    } catch (error) {
      console.error(`Trending fetch failed for ${id}: ${error.message}`)
    }
  }
  results.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
  trendingCache = results
  trendingCacheTime = Date.now()
  return results
}

async function getEthPrice() {
  if (cachedEthPrice && Date.now() - ethPriceCacheTime < ETH_PRICE_CACHE_TTL) return cachedEthPrice
  try {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    const price = Number(data?.ethereum?.usd)
    if (Number.isFinite(price) && price > 0) {
      cachedEthPrice = price
      ethPriceCacheTime = Date.now()
      return price
    }
  } catch (error) {
    console.error(`ETH price fetch error: ${error.message}`)
  }
  return cachedEthPrice
}

function collectionName(value) {
  return String(value || 'Unknown').replace(/[\\*_`]/g, '')
}

function fetchJson(url, headers = {}, attempts = 3) {
  return new Promise((resolve, reject) => {
    const request = () => {
      const urlObj = new URL(url)
      const req = https.request(urlObj, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'MintHunter/1.0', ...headers },
      }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`HTTP ${res.statusCode}`)
            if (attempts > 1 && res.statusCode >= 500) return setTimeout(() => fetchJson(url, headers, attempts - 1).then(resolve, reject), 500)
            return reject(error)
          }
          try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON response')) }
        })
      })
      req.setTimeout(10_000, () => req.destroy(new Error('Request timeout')))
      req.on('error', (error) => {
        if (attempts > 1) return setTimeout(() => fetchJson(url, headers, attempts - 1).then(resolve, reject), 500)
        reject(error)
      })
      req.end()
    }
    request()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { checkAlerts, getEthPrice, getFloorPrice, getTrending }
