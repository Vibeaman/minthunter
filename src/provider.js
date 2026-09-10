/**
 * Chain-aware provider and broadcast helpers.
 * Only explicitly configured RPC endpoints are used - MintHunter never
 * silently falls back to a public/unverified RPC for reads or broadcasts.
 */

const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { getChain, DEFAULT_CHAIN } = require('./chains')

const CACHE_TTL = 60_000
const RPC_TIMEOUT = 8_000

const providerCache = new Map() // rpc url -> ethers provider
const chainProviderCache = new Map() // chain id -> { provider, cacheTime }
const chainBlockTiming = new Map() // chain id -> { lastBlockTime, avgBlockInterval, samples }

function getConfiguredEndpoints(chainKey = DEFAULT_CHAIN) {
  const chain = getChain(chainKey)

  const fromEnvKeys = chain.rpcEnvKeys
    .map((key) => process.env[key])
    .filter(Boolean)

  const fromBroadcastList = chain.broadcastRpcsEnvKey
    ? (process.env[chain.broadcastRpcsEnvKey] || '').split(',').map((url) => url.trim()).filter(Boolean)
    : []

  const endpoints = [...new Set([...fromEnvKeys, ...fromBroadcastList])]

  if (endpoints.length === 0) {
    const envHint = [...chain.rpcEnvKeys, chain.broadcastRpcsEnvKey].filter(Boolean).join(', ')
    throw new Error(`Configure at least one RPC endpoint for ${chain.name} (${envHint})`)
  }

  return endpoints
}

function createProvider(url) {
  // Do not use staticNetwork here: the endpoint itself must prove which chain it serves.
  return new ethers.JsonRpcProvider(url)
}

function getOrCreateProvider(url) {
  if (!providerCache.has(url)) providerCache.set(url, createProvider(url))
  return providerCache.get(url)
}

async function withTimeout(promise, timeout = RPC_TIMEOUT) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC request timed out')), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Confirm a provider actually serves the expected chain ID. Replaces the old
 * Ethereum-only assertMainnet() so every chain gets the same protection.
 */
async function assertChain(provider, expectedChainId) {
  const network = await withTimeout(provider.getNetwork())
  const expected = BigInt(expectedChainId)
  if (network.chainId !== expected) {
    throw new Error(`Configured RPC is not chain ${expected} (got ${network.chainId})`)
  }
  return provider
}

async function getProvider(chainKey = DEFAULT_CHAIN) {
  const chain = getChain(chainKey)
  const cached = chainProviderCache.get(chain.id)
  if (cached && Date.now() - cached.cacheTime < CACHE_TTL) return cached.provider

  const attempts = getConfiguredEndpoints(chain.id).map(async (url) => {
    const provider = getOrCreateProvider(url)
    const block = await withTimeout(provider.getBlockNumber())
    await assertChain(provider, chain.chainId)
    return { provider, block, url }
  })

  try {
    const winner = await Promise.any(attempts)
    console.log(`✅ Using configured ${chain.name} RPC (block ${winner.block})`)
    chainProviderCache.set(chain.id, { provider: winner.provider, cacheTime: Date.now() })
    return winner.provider
  } catch (error) {
    const reasons = error.errors?.map((reason) => reason?.message || 'unknown RPC error').join('; ')
    throw new Error(`All configured ${chain.name} RPC endpoints failed${reasons ? `: ${reasons}` : ''}`)
  }
}

function createAllProviders(chainKey = DEFAULT_CHAIN) {
  return getConfiguredEndpoints(chainKey).map(getOrCreateProvider)
}

async function firstSuccessfulBroadcast(providers, signedTx, label) {
  const attempts = providers.map((provider) => (
    withTimeout(provider.broadcastTransaction(signedTx), RPC_TIMEOUT)
  ))

  try {
    // Return as soon as any trusted endpoint accepts the transaction. Promise.any
    // still observes every rejection, so no slow or failed RPC becomes unhandled.
    return await Promise.any(attempts)
  } catch (error) {
    const reasons = error.errors?.map((reason) => reason?.message || 'unknown RPC error').join('; ')
    throw new Error(`${label} failed on all configured endpoints${reasons ? `: ${reasons}` : ''}`)
  }
}

async function broadcastToAll(signedTx, chainKey = DEFAULT_CHAIN) {
  return firstSuccessfulBroadcast(createAllProviders(chainKey), signedTx, 'Broadcast')
}

async function sendViaFlashbots(signedTx, chainKey = DEFAULT_CHAIN) {
  const chain = getChain(chainKey)
  const flashbotsUrl = chain.flashbotsRpcEnvKey ? process.env[chain.flashbotsRpcEnvKey] : null

  if (!flashbotsUrl) return broadcastToAll(signedTx, chainKey)

  try {
    const provider = await assertChain(getOrCreateProvider(flashbotsUrl), chain.chainId)
    return await withTimeout(provider.broadcastTransaction(signedTx))
  } catch (error) {
    console.error(`⚠️ Configured Flashbots RPC failed: ${error.message}`)
    return broadcastToAll(signedTx, chainKey)
  }
}

function getBlockTimingState(chainKey) {
  const chain = getChain(chainKey)
  if (!chainBlockTiming.has(chain.id)) {
    chainBlockTiming.set(chain.id, {
      lastBlockTime: 0,
      avgBlockInterval: chain.approxBlockTimeMs,
      samples: [],
    })
  }
  return chainBlockTiming.get(chain.id)
}

async function updateBlockTiming(provider, chainKey = DEFAULT_CHAIN) {
  const state = getBlockTimingState(chainKey)
  try {
    const block = await withTimeout(provider.getBlock('latest'))
    const now = Number(block.timestamp) * 1000
    if (state.lastBlockTime > 0 && now > state.lastBlockTime) {
      state.samples.push(now - state.lastBlockTime)
      if (state.samples.length > 10) state.samples.shift()
      state.avgBlockInterval = state.samples.reduce((sum, value) => sum + value, 0) / state.samples.length
    }
    state.lastBlockTime = now
    return block
  } catch (error) {
    console.error(`⚠️ Block timing update failed: ${error.message}`)
    return null
  }
}

async function waitForOptimalTiming(provider, chainKey = DEFAULT_CHAIN) {
  const block = await updateBlockTiming(provider, chainKey)
  if (!block) return
  const state = getBlockTimingState(chainKey)
  const blockAge = Date.now() - Number(block.timestamp) * 1000
  const timeToNextBlock = state.avgBlockInterval - blockAge
  if (timeToNextBlock > 1_000 && timeToNextBlock < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, timeToNextBlock - 500)))
  }
}

async function fcfsBroadcast(signedTx, chainKey = DEFAULT_CHAIN, useBlockTiming = false) {
  const chain = getChain(chainKey)
  const flashbotsUrl = chain.flashbotsRpcEnvKey ? process.env[chain.flashbotsRpcEnvKey] : null
  const endpoints = flashbotsUrl
    ? [flashbotsUrl, ...getConfiguredEndpoints(chainKey)]
    : getConfiguredEndpoints(chainKey)
  const uniqueEndpoints = [...new Set(endpoints)]
  const providers = uniqueEndpoints.map(getOrCreateProvider)

  // Disabled by default because waiting for a block edge is slower than immediate
  // propagation. It remains opt-in for controlled experiments.
  if (useBlockTiming && providers.length > 0) await waitForOptimalTiming(providers[0], chainKey)

  return firstSuccessfulBroadcast(providers, signedTx, 'FCFS broadcast')
}

function clearCache() {
  chainProviderCache.clear()
  providerCache.clear()
  chainBlockTiming.clear()
}

module.exports = {
  getConfiguredEndpoints,
  assertChain,
  broadcastToAll,
  clearCache,
  createAllProviders,
  fcfsBroadcast,
  firstSuccessfulBroadcast,
  getProvider,
  sendViaFlashbots,
  updateBlockTiming,
  waitForOptimalTiming,
}
