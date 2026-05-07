/**
 * Ethereum RPC Provider Helper
 * Handles multi-RPC fallback and connection management
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { ethers } = require('ethers')

// RPC endpoints - Alchemy first (premium), then free fallbacks
const RPC_ENDPOINTS = [
  process.env.ALCHEMY_RPC,
  'https://eth.meowrpc.com',
  'https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net'
].filter(Boolean)

// Cache working provider to avoid repeated tests
let cachedProvider = null
let cacheTime = 0
const CACHE_TTL = 60000 // 1 minute

/**
 * Get a working Ethereum provider
 * Tests endpoints in order, returns first working one
 * Caches result to avoid repeated tests
 */
async function getProvider() {
  // Return cached if still valid
  if (cachedProvider && (Date.now() - cacheTime) < CACHE_TTL) {
    return cachedProvider
  }

  for (const url of RPC_ENDPOINTS) {
    try {
      console.log(`🔍 Testing RPC: ${url.substring(0, 40)}...`)
      
      const provider = new ethers.JsonRpcProvider(url, 1, {
        staticNetwork: true
      })
      
      // Test with timeout
      const blockPromise = provider.getBlockNumber()
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 5000)
      )
      
      const block = await Promise.race([blockPromise, timeoutPromise])
      console.log(`✅ Using RPC: ${url.substring(0, 35)}... (block ${block})`)
      
      // Cache it
      cachedProvider = provider
      cacheTime = Date.now()
      
      return provider
    } catch (e) {
      console.log(`⚠️ RPC failed: ${url.substring(0, 30)}... - ${e.message?.substring(0, 30)}`)
      continue
    }
  }
  
  throw new Error('All RPC endpoints failed - check ALCHEMY_RPC in .env')
}

/**
 * Create multiple providers for parallel broadcasting
 * Used for FCFS minting to maximize speed
 */
function createAllProviders() {
  return RPC_ENDPOINTS.map(url => {
    try {
      return new ethers.JsonRpcProvider(url, 1, { staticNetwork: true })
    } catch {
      return null
    }
  }).filter(Boolean)
}

/**
 * Broadcast transaction to all providers simultaneously
 * Returns first successful response
 */
async function broadcastToAll(signedTx) {
  const providers = createAllProviders()
  
  console.log(`📡 Broadcasting to ${providers.length} endpoints...`)
  
  const results = await Promise.allSettled(
    providers.map(p => p.broadcastTransaction(signedTx))
  )
  
  // Find first success
  for (const result of results) {
    if (result.status === 'fulfilled') {
      console.log(`✅ TX broadcast success: ${result.value.hash}`)
      return result.value
    }
  }
  
  // All failed
  const errors = results.map(r => r.reason?.message || 'unknown').join(', ')
  throw new Error(`All broadcasts failed: ${errors}`)
}

/**
 * Send transaction via Flashbots Protect RPC
 * Goes direct to block builders, skips public mempool
 * MEV protected - no front-running
 */
async function sendViaFlashbots(signedTx) {
  const flashbotsRpc = 'https://rpc.flashbots.net'
  
  console.log('⚡ Sending via Flashbots Protect...')
  
  try {
    const provider = new ethers.JsonRpcProvider(flashbotsRpc, 1, { staticNetwork: true })
    const tx = await provider.broadcastTransaction(signedTx)
    console.log(`⚡ Flashbots TX submitted: ${tx.hash}`)
    return tx
  } catch (e) {
    console.log(`⚠️ Flashbots failed: ${e.message}, falling back to regular broadcast`)
    return broadcastToAll(signedTx)
  }
}

/**
 * FCFS Broadcast - Maximum speed
 * Sends to both Flashbots AND all regular RPCs simultaneously
 */
async function fcfsBroadcast(signedTx) {
  console.log('🚀 FCFS BROADCAST - Flashbots + All RPCs...')
  
  const providers = createAllProviders()
  const flashbotsProvider = new ethers.JsonRpcProvider('https://rpc.flashbots.net', 1, { staticNetwork: true })
  
  // Add Flashbots to the mix
  const allProviders = [flashbotsProvider, ...providers]
  
  console.log(`📡 Broadcasting to ${allProviders.length} endpoints (including Flashbots)...`)
  
  const results = await Promise.allSettled(
    allProviders.map(p => p.broadcastTransaction(signedTx))
  )
  
  // Find first success
  for (const result of results) {
    if (result.status === 'fulfilled') {
      console.log(`✅ TX broadcast success: ${result.value.hash}`)
      return result.value
    }
  }
  
  // All failed
  const errors = results.map(r => r.reason?.message || 'unknown').join(', ')
  throw new Error(`All broadcasts failed: ${errors}`)
}

/**
 * Clear cached provider (use after errors)
 */
function clearCache() {
  cachedProvider = null
  cacheTime = 0
}

module.exports = {
  getProvider,
  createAllProviders,
  broadcastToAll,
  sendViaFlashbots,
  fcfsBroadcast,
  clearCache,
  RPC_ENDPOINTS
}
