/**
 * Ethereum RPC Provider Helper
 * Handles multi-RPC fallback and connection management
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { ethers } = require('ethers')

// RPC endpoints - premium first, then public fallbacks (more = faster FCFS)
const RPC_ENDPOINTS = [
  process.env.ALCHEMY_RPC,
  process.env.INFURA_RPC,
  process.env.QUICKNODE_RPC,
  'https://eth.meowrpc.com',
  'https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://1rpc.io/eth',
  'https://eth.llamarpc.com',
  'https://rpc.payload.de',
  'https://eth.blockrazor.xyz',
  'https://rpc.flashbots.net',
  'https://rpc.builder0x69.io',
  'https://rpc.titanbuilder.xyz'
].filter(Boolean)

// Block timing tracker
let lastBlockTime = 0
let avgBlockInterval = 12000 // 12 seconds default
let blockTimeSamples = []

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
 * Update block timing stats
 * Call this periodically to track block intervals
 */
async function updateBlockTiming(provider) {
  try {
    const block = await provider.getBlock('latest')
    const now = Date.now()
    
    if (lastBlockTime > 0 && block.timestamp * 1000 > lastBlockTime) {
      const interval = block.timestamp * 1000 - lastBlockTime
      blockTimeSamples.push(interval)
      
      // Keep last 10 samples
      if (blockTimeSamples.length > 10) blockTimeSamples.shift()
      
      // Calculate average
      avgBlockInterval = blockTimeSamples.reduce((a, b) => a + b, 0) / blockTimeSamples.length
      console.log(`⏱️ Block interval: ${(avgBlockInterval / 1000).toFixed(1)}s avg`)
    }
    
    lastBlockTime = block.timestamp * 1000
    return block
  } catch (e) {
    console.log('⚠️ Block timing update failed:', e.message)
    return null
  }
}

/**
 * Wait for optimal block timing
 * Submits tx right before next expected block for fastest inclusion
 */
async function waitForOptimalTiming(provider) {
  const block = await updateBlockTiming(provider)
  if (!block) return
  
  const now = Date.now()
  const blockAge = now - (block.timestamp * 1000)
  const timeToNextBlock = avgBlockInterval - blockAge
  
  // If next block is 1-3 seconds away, wait. Otherwise submit now.
  if (timeToNextBlock > 1000 && timeToNextBlock < 3000) {
    const waitTime = timeToNextBlock - 500 // Submit 500ms before expected block
    console.log(`⏳ Waiting ${waitTime}ms for optimal block timing...`)
    await new Promise(r => setTimeout(r, waitTime))
  } else if (timeToNextBlock > 3000) {
    // Block just happened, next one is far - submit now to get in mempool early
    console.log(`⚡ Block just mined, submitting immediately to mempool`)
  } else {
    // We're close to a block, submit immediately
    console.log(`🎯 Near block boundary, submitting now`)
  }
}

/**
 * FCFS Broadcast - Maximum speed
 * Uses block timing + sends to Flashbots AND all regular RPCs simultaneously
 */
async function fcfsBroadcast(signedTx, useBlockTiming = true) {
  console.log('🚀 FCFS BROADCAST - Maximum Speed Mode...')
  
  const providers = createAllProviders()
  
  // Optimal timing (if enabled)
  if (useBlockTiming && providers.length > 0) {
    await waitForOptimalTiming(providers[0])
  }
  
  // Builder RPCs for direct block inclusion
  const builderRpcs = [
    'https://rpc.flashbots.net',
    'https://rpc.builder0x69.io',
    'https://rpc.titanbuilder.xyz',
    'https://rsync-builder.xyz',
    'https://rpc.beaverbuild.org'
  ]
  
  const builderProviders = builderRpcs.map(url => {
    try {
      return new ethers.JsonRpcProvider(url, 1, { staticNetwork: true })
    } catch { return null }
  }).filter(Boolean)
  
  // All providers: builders + public RPCs
  const allProviders = [...builderProviders, ...providers]
  
  console.log(`📡 Broadcasting to ${allProviders.length} endpoints (${builderProviders.length} builders + ${providers.length} public)...`)
  
  const results = await Promise.allSettled(
    allProviders.map(p => p.broadcastTransaction(signedTx))
  )
  
  // Count successes
  const successes = results.filter(r => r.status === 'fulfilled')
  console.log(`✅ Broadcast to ${successes.length}/${allProviders.length} nodes`)
  
  // Return first success
  for (const result of results) {
    if (result.status === 'fulfilled') {
      console.log(`✅ TX hash: ${result.value.hash}`)
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
  updateBlockTiming,
  waitForOptimalTiming,
  clearCache,
  RPC_ENDPOINTS
}
