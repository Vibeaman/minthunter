/**
 * Ethereum mainnet provider and broadcast helpers.
 * Only explicitly configured RPC endpoints are used.
 */

const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const configuredRpcs = [
  process.env.ALCHEMY_RPC,
  process.env.INFURA_RPC,
  process.env.QUICKNODE_RPC,
  ...(process.env.BROADCAST_RPCS || '').split(',').map((url) => url.trim()).filter(Boolean),
].filter(Boolean)

const RPC_ENDPOINTS = [...new Set(configuredRpcs)]
const CACHE_TTL = 60_000
const RPC_TIMEOUT = 8_000
let cachedProvider = null
let cacheTime = 0
let lastBlockTime = 0
let avgBlockInterval = 12_000
const blockTimeSamples = []

function getConfiguredEndpoints() {
  if (RPC_ENDPOINTS.length === 0) {
    throw new Error('Configure ALCHEMY_RPC, INFURA_RPC, QUICKNODE_RPC, or BROADCAST_RPCS')
  }
  return RPC_ENDPOINTS
}

function createProvider(url) {
  return new ethers.JsonRpcProvider(url, 1, { staticNetwork: true })
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

async function assertMainnet(provider) {
  const network = await withTimeout(provider.getNetwork())
  if (network.chainId !== 1n) throw new Error('Configured RPC is not Ethereum mainnet')
  return provider
}

async function getProvider() {
  if (cachedProvider && Date.now() - cacheTime < CACHE_TTL) return cachedProvider

  for (const url of getConfiguredEndpoints()) {
    try {
      const provider = createProvider(url)
      const block = await withTimeout(provider.getBlockNumber())
      await assertMainnet(provider)
      console.log(`✅ Using configured Ethereum RPC (block ${block})`)
      cachedProvider = provider
      cacheTime = Date.now()
      return provider
    } catch (error) {
      console.error(`⚠️ Configured RPC failed: ${error.message}`)
    }
  }

  throw new Error('All configured Ethereum RPC endpoints failed')
}

function createAllProviders() {
  return getConfiguredEndpoints().map((url) => createProvider(url))
}

async function broadcastToAll(signedTx) {
  const providers = createAllProviders()
  const results = await Promise.allSettled(
    providers.map((provider) => withTimeout(provider.broadcastTransaction(signedTx), RPC_TIMEOUT)),
  )
  const successful = results.find((result) => result.status === 'fulfilled')
  if (successful) return successful.value
  const errors = results.map((result) => result.reason?.message || 'unknown RPC error').join('; ')
  throw new Error(`All configured broadcasts failed: ${errors}`)
}

async function sendViaFlashbots(signedTx) {
  if (!process.env.FLASHBOTS_RPC) return broadcastToAll(signedTx)
  try {
    const provider = await assertMainnet(createProvider(process.env.FLASHBOTS_RPC))
    return await withTimeout(provider.broadcastTransaction(signedTx))
  } catch (error) {
    console.error(`⚠️ Configured Flashbots RPC failed: ${error.message}`)
    return broadcastToAll(signedTx)
  }
}

async function updateBlockTiming(provider) {
  try {
    const block = await withTimeout(provider.getBlock('latest'))
    const now = Number(block.timestamp) * 1000
    if (lastBlockTime > 0 && now > lastBlockTime) {
      blockTimeSamples.push(now - lastBlockTime)
      if (blockTimeSamples.length > 10) blockTimeSamples.shift()
      avgBlockInterval = blockTimeSamples.reduce((sum, value) => sum + value, 0) / blockTimeSamples.length
    }
    lastBlockTime = now
    return block
  } catch (error) {
    console.error(`⚠️ Block timing update failed: ${error.message}`)
    return null
  }
}

async function waitForOptimalTiming(provider) {
  const block = await updateBlockTiming(provider)
  if (!block) return
  const blockAge = Date.now() - Number(block.timestamp) * 1000
  const timeToNextBlock = avgBlockInterval - blockAge
  if (timeToNextBlock > 1_000 && timeToNextBlock < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, timeToNextBlock - 500)))
  }
}

async function fcfsBroadcast(signedTx, useBlockTiming = false) {
  const providers = createAllProviders()
  if (useBlockTiming && providers.length > 0) await waitForOptimalTiming(providers[0])

  const endpoints = process.env.FLASHBOTS_RPC
    ? [process.env.FLASHBOTS_RPC, ...getConfiguredEndpoints()]
    : getConfiguredEndpoints()
  const allProviders = [...new Map(endpoints.map((url) => [url, createProvider(url)])).values()]
  const results = await Promise.allSettled(
    allProviders.map((provider) => withTimeout(provider.broadcastTransaction(signedTx), RPC_TIMEOUT)),
  )
  const successful = results.find((result) => result.status === 'fulfilled')
  if (successful) return successful.value
  const errors = results.map((result) => result.reason?.message || 'unknown RPC error').join('; ')
  throw new Error(`FCFS broadcast failed on all configured endpoints: ${errors}`)
}

function clearCache() {
  cachedProvider = null
  cacheTime = 0
}

module.exports = {
  RPC_ENDPOINTS,
  assertMainnet,
  broadcastToAll,
  clearCache,
  createAllProviders,
  fcfsBroadcast,
  getProvider,
  sendViaFlashbots,
  updateBlockTiming,
  waitForOptimalTiming,
}
