/**
 * Floor Price Service
 * Fetches NFT collection floor prices and checks alerts
 */

const https = require('https')

// Load Alchemy API key from env
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') })
const ALCHEMY_API_KEY = process.env.ALCHEMY_RPC?.split('/').pop() || ''

/**
 * Fetch floor price from Alchemy NFT API
 * Falls back to SimpleHash if needed
 */
async function getFloorPrice(contractAddress) {
  // Try Alchemy NFT API first (you have a key)
  if (ALCHEMY_API_KEY) {
    try {
      const data = await fetchJson(
        `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getFloorPrice?contractAddress=${contractAddress}`
      )
      
      if (data?.openSea?.floorPrice || data?.looksRare?.floorPrice) {
        const floor = data.openSea?.floorPrice || data.looksRare?.floorPrice || 0
        return {
          floor: floor,
          name: data.openSea?.collectionName || 'Unknown',
          symbol: '',
          source: 'alchemy'
        }
      }
    } catch (e) {
      console.log(`Alchemy error for ${contractAddress}: ${e.message}`)
    }
  }
  
  // Fallback: SimpleHash free tier
  try {
    const data = await fetchJson(
      `https://api.simplehash.com/api/v0/nfts/collections/ethereum/${contractAddress}`,
      { 'X-API-KEY': '' }
    )
    
    if (data?.floor_prices?.[0]) {
      return {
        floor: data.floor_prices[0].value / 1e18 || 0,
        name: data.name || 'Unknown',
        symbol: data.symbol || '',
        source: 'simplehash'
      }
    }
  } catch (e) {
    console.log(`SimpleHash error for ${contractAddress}: ${e.message}`)
  }
  
  return null
}

/**
 * Check all active alerts against current floor prices
 * Returns array of triggered alerts
 */
async function checkAlerts(db, bot) {
  const alerts = db.prepare(`
    SELECT fa.*, u.telegram_id 
    FROM floor_alerts fa
    JOIN users u ON fa.telegram_id = u.telegram_id
    WHERE fa.is_active = 1
  `).all()
  
  if (alerts.length === 0) return []
  
  console.log(`🔔 Checking ${alerts.length} floor alerts...`)
  
  const triggered = []
  
  // Group by collection to avoid duplicate API calls
  const collections = {}
  for (const alert of alerts) {
    if (!collections[alert.collection_address]) {
      collections[alert.collection_address] = []
    }
    collections[alert.collection_address].push(alert)
  }
  
  for (const [address, alertsForCollection] of Object.entries(collections)) {
    try {
      const priceData = await getFloorPrice(address)
      
      if (!priceData || !priceData.floor) {
        console.log(`⚠️ Could not get floor for ${address}`)
        continue
      }
      
      const currentFloor = parseFloat(priceData.floor)
      
      for (const alert of alertsForCollection) {
        const target = parseFloat(alert.target_price)
        let shouldTrigger = false
        
        if (alert.condition === 'below' && currentFloor < target) {
          shouldTrigger = true
        } else if (alert.condition === 'above' && currentFloor > target) {
          shouldTrigger = true
        }
        
        if (shouldTrigger) {
          triggered.push({
            alert,
            currentFloor,
            collectionName: priceData.name
          })
          
          // Send notification
          const symbol = alert.condition === 'below' ? '📉' : '📈'
          await bot.sendMessage(alert.telegram_id,
            `🚨 *Floor Alert Triggered!*\n\n` +
            `${symbol} *${priceData.name}*\n\n` +
            `Current floor: *${currentFloor.toFixed(4)} ETH*\n` +
            `Your target: ${alert.condition} ${alert.target_price} ETH\n\n` +
            `Contract: \`${address.slice(0, 10)}...\``,
            { parse_mode: 'Markdown' }
          )
          
          // Deactivate alert after triggering (one-time)
          db.prepare('UPDATE floor_alerts SET is_active = 0 WHERE id = ?').run(alert.id)
          console.log(`🚨 Alert #${alert.id} triggered! Floor: ${currentFloor} ETH`)
        }
      }
      
      // Rate limit between collections
      await sleep(500)
      
    } catch (e) {
      console.error(`Error checking ${address}:`, e.message)
    }
  }
  
  return triggered
}

/**
 * Get trending collections (top NFTs)
 * Fetches individual popular collections from CoinGecko
 */
async function getTrending() {
  // Top NFT collection IDs on CoinGecko (curated list)
  const topCollections = [
    'bored-ape-yacht-club',
    'cryptopunks',
    'mutant-ape-yacht-club',
    'azuki',
    'pudgy-penguins',
    'milady-maker',
    'doodles-official',
    'clonex',
    'degods-solana', 
    'moonbirds'
  ]
  
  const results = []
  
  for (const id of topCollections) {
    try {
      const data = await fetchJson(
        `https://api.coingecko.com/api/v3/nfts/${id}`
      )
      
      if (data && data.name) {
        results.push({
          name: data.name || 'Unknown',
          floor: data.floor_price?.native_currency || 0,
          floorUsd: data.floor_price?.usd || 0,
          volume24h: data.volume_24h?.native_currency || 0,
          change24h: data.floor_price_24h_percentage_change?.native_currency || 0,
          address: data.contract_address
        })
      }
      
      // Rate limit - CoinGecko free tier is 10-30 req/min
      await sleep(350)
      
    } catch (e) {
      console.log(`Failed to fetch ${id}:`, e.message)
      continue
    }
  }
  
  // Sort by 24h volume descending
  results.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
  
  return results
}

// Helper: fetch JSON
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MintHunter/1.0',
        ...headers
      }
    }
    
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('Invalid JSON response'))
        }
      })
    })
    
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.end()
  })
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Cache ETH price (refresh every 5 min)
let cachedEthPrice = null
let ethPriceCacheTime = 0
const ETH_PRICE_CACHE_TTL = 5 * 60 * 1000

/**
 * Get current ETH price in USD
 */
async function getEthPrice() {
  // Return cached if fresh
  if (cachedEthPrice && (Date.now() - ethPriceCacheTime) < ETH_PRICE_CACHE_TTL) {
    return cachedEthPrice
  }
  
  try {
    const data = await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    )
    
    if (data?.ethereum?.usd) {
      cachedEthPrice = data.ethereum.usd
      ethPriceCacheTime = Date.now()
      return cachedEthPrice
    }
  } catch (e) {
    console.log('ETH price fetch error:', e.message)
  }
  
  // Fallback to cached or default
  return cachedEthPrice || 2500
}

module.exports = {
  getFloorPrice,
  checkAlerts,
  getTrending,
  getEthPrice
}
