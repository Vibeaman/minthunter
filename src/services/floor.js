/**
 * Floor Price Service
 * Fetches NFT collection floor prices and checks alerts
 */

const https = require('https')

/**
 * Fetch floor price from Reservoir API (free, no key needed for basic)
 * Falls back to OpenSea if needed
 */
async function getFloorPrice(contractAddress) {
  // Try Reservoir first (free tier)
  try {
    const data = await fetchJson(
      `https://api.reservoir.tools/collections/v6?contract=${contractAddress}`
    )
    
    if (data?.collections?.[0]) {
      const collection = data.collections[0]
      return {
        floor: collection.floorAsk?.price?.amount?.native || 0,
        name: collection.name || 'Unknown',
        symbol: collection.symbol || '',
        source: 'reservoir'
      }
    }
  } catch (e) {
    console.log(`Reservoir error for ${contractAddress}: ${e.message}`)
  }
  
  // Fallback: try to scrape from OpenSea public API
  try {
    const data = await fetchJson(
      `https://api.opensea.io/api/v2/collections?chain=ethereum&contract_addresses=${contractAddress}`,
      { 'X-API-KEY': '' } // Works without key for basic requests
    )
    
    if (data?.collections?.[0]) {
      const collection = data.collections[0]
      return {
        floor: collection.stats?.floor_price || 0,
        name: collection.name || 'Unknown',
        symbol: collection.symbol || '',
        source: 'opensea'
      }
    }
  } catch (e) {
    console.log(`OpenSea error for ${contractAddress}: ${e.message}`)
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
 * Get trending collections (top by volume)
 * Uses CoinGecko NFT API as primary (more reliable)
 */
async function getTrending() {
  // Try CoinGecko first (more reliable)
  try {
    const data = await fetchJson(
      'https://api.coingecko.com/api/v3/nfts/markets?order=volume_24h_desc&per_page=10'
    )
    
    if (data && Array.isArray(data) && data.length > 0) {
      return data.map(c => ({
        name: c.name || 'Unknown',
        floor: c.floor_price?.native_currency || 0,
        floorUsd: c.floor_price?.usd || 0,
        volume24h: c.volume_24h?.native_currency || 0,
        change24h: c.floor_price_24h_percentage_change || 0,
        address: c.contract_address
      }))
    }
  } catch (e) {
    console.log('CoinGecko trending error:', e.message)
  }
  
  // Fallback to Reservoir
  try {
    const data = await fetchJson(
      'https://api.reservoir.tools/collections/v6?sortBy=1DayVolume&limit=10'
    )
    
    if (data?.collections) {
      return data.collections.map(c => ({
        name: c.name || 'Unknown',
        floor: c.floorAsk?.price?.amount?.native || 0,
        floorUsd: c.floorAsk?.price?.amount?.usd || 0,
        volume24h: c.volume?.['1day'] || 0,
        change24h: c.floorSaleChange?.['1day'] || 0,
        address: c.primaryContract || c.id
      }))
    }
  } catch (e) {
    console.log('Reservoir trending error:', e.message)
  }
  
  return []
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
