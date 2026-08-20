const https = require('https')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })

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

async function getFloorPrice(contractAddress) {
  if (!ethers.isAddress(contractAddress)) return null
  const address = ethers.getAddress(contractAddress)

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
  const collections = new Map()
  for (const alert of alerts) {
    if (!ethers.isAddress(alert.collection_address)) {
      console.error(`Skipping invalid alert address for alert #${alert.id}`)
      continue
    }
    const address = ethers.getAddress(alert.collection_address)
    if (!collections.has(address)) collections.set(address, [])
    collections.get(address).push(alert)
  }

  for (const [address, collectionAlerts] of collections) {
    try {
      const priceData = await getFloorPrice(address)
      if (!priceData || priceData.floor == null) continue
      const currentFloor = Number(priceData.floor)
      if (!Number.isFinite(currentFloor)) continue

      for (const alert of collectionAlerts) {
        const target = Number(alert.target_price)
        const shouldTrigger = alert.condition === 'below'
          ? currentFloor <= target
          : alert.condition === 'above' && currentFloor >= target
        if (!shouldTrigger) continue

        const symbol = alert.condition === 'below' ? '📉' : '📈'
        await bot.sendMessage(alert.telegram_id,
          `🚨 *Floor Alert Triggered!*\n\n` +
          `${symbol} *${collectionName(priceData.name)}*\n\n` +
          `Current floor: *${currentFloor.toFixed(4)} ETH*\n` +
          `Your target: ${alert.condition} ${alert.target_price} ETH\n\n` +
          `Contract: \`${address.slice(0, 10)}...\``,
          { parse_mode: 'Markdown' },
        )
        db.prepare('UPDATE floor_alerts SET is_active = 0 WHERE id = ? AND is_active = 1').run(alert.id)
        triggered.push({ alert, currentFloor, collectionName: priceData.name })
      }
      await sleep(500)
    } catch (error) {
      console.error(`Alert check error for ${address}: ${error.message}`)
    }
  }

  return triggered
}

async function getTrending() {
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
