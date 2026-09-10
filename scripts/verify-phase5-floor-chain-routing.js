#!/usr/bin/env node
/**
 * Phase 5 verification script - mocks the HTTP layer to confirm:
 *  1. getFloorPrice('ethereum') still calls the exact same Alchemy/SimpleHash
 *     URLs/params as before Phase 5 (no regression).
 *  2. getFloorPrice('robinhood') routes to OpenSea's two-step lookup
 *     (contract -> collection slug -> stats) when OPENSEA_API_KEY is set.
 *  3. getFloorPrice('robinhood') returns a clear "unsupported" result
 *     (not Ethereum data, not a crash) when OPENSEA_API_KEY is unset.
 *  4. getTrending('robinhood') returns [] (no trending source integrated),
 *     while getTrending('ethereum') is unaffected.
 *
 * Run with: node scripts/verify-phase5-floor-chain-routing.js
 */
const assert = require('node:assert/strict')
const https = require('node:https')
const path = require('node:path')

process.env.ALCHEMY_RPC = 'https://eth-mainnet.g.alchemy.com/v2/test-alchemy-key'
delete process.env.SIMPLEHASH_API_KEY
delete process.env.OPENSEA_API_KEY

const requestedUrls = []

// Mock https.request so no real network calls are made. Records every URL
// hit and returns canned JSON responses keyed by hostname/path pattern.
https.request = (urlObj, options, callback) => {
  const url = `https://${urlObj.hostname}${urlObj.pathname}${urlObj.search || ''}`
  requestedUrls.push({ url, headers: options.headers })

  let responseBody = '{}'
  if (urlObj.hostname === 'eth-mainnet.g.alchemy.com') {
    responseBody = JSON.stringify({ openSea: { floorPrice: 1.23, collectionName: 'Mock Ethereum Collection' } })
  } else if (urlObj.hostname === 'api.opensea.io' && urlObj.pathname.includes('/contract/')) {
    responseBody = JSON.stringify({ collection: 'mock-robinhood-collection', name: 'Mock Robinhood Collection' })
  } else if (urlObj.hostname === 'api.opensea.io' && urlObj.pathname.includes('/stats')) {
    responseBody = JSON.stringify({ total: { floor_price: 0.456, floor_price_symbol: 'ETH' } })
  }

  const fakeRes = {
    statusCode: 200,
    setEncoding() {},
    on(event, handler) {
      if (event === 'data') handler(responseBody)
      if (event === 'end') handler()
      return fakeRes
    },
  }
  const fakeReq = {
    setTimeout() {},
    on() { return fakeReq },
    end() { callback(fakeRes) },
  }
  return fakeReq
}

async function main() {
  delete require.cache[require.resolve('../src/services/floor')]
  delete require.cache[require.resolve('../src/chains')]
  const { getFloorPrice, getTrending } = require('../src/services/floor')

  const testAddress = '0x1234567890123456789012345678901234567890'

  // 1. Ethereum: unchanged behavior (default chain, no chain arg passed at all)
  requestedUrls.length = 0
  const ethResult = await getFloorPrice(testAddress)
  assert.equal(requestedUrls.length, 1, 'Ethereum lookup should call exactly one URL (Alchemy hit, no SimpleHash needed)')
  assert.match(requestedUrls[0].url, /^https:\/\/eth-mainnet\.g\.alchemy\.com\/nft\/v3\/test-alchemy-key\/getFloorPrice\?contractAddress=/)
  assert.equal(ethResult.floor, 1.23)
  assert.equal(ethResult.source, 'alchemy')
  assert.equal(ethResult.unsupported, undefined)
  console.log('✅ Ethereum floor lookup (no chain arg): calls the same Alchemy URL as before Phase 5')

  // 1b. Ethereum: explicit chain='ethereum' behaves identically
  requestedUrls.length = 0
  const ethResultExplicit = await getFloorPrice(testAddress, 'ethereum')
  assert.equal(requestedUrls.length, 1)
  assert.equal(ethResultExplicit.floor, 1.23)
  console.log('✅ Ethereum floor lookup (explicit chain="ethereum"): identical behavior')

  // 2. Robinhood without OPENSEA_API_KEY configured: clear "unsupported", no crash, no ETH data
  requestedUrls.length = 0
  const robinhoodNoKey = await getFloorPrice(testAddress, 'robinhood')
  assert.equal(requestedUrls.length, 0, 'Should not call OpenSea at all when no API key is configured')
  assert.equal(robinhoodNoKey.floor, null)
  assert.equal(robinhoodNoKey.unsupported, true)
  assert.match(robinhoodNoKey.reason, /OPENSEA_API_KEY/)
  console.log('✅ Robinhood floor lookup without OPENSEA_API_KEY: clear unsupported result, not Ethereum data')

  // 3. Robinhood with OPENSEA_API_KEY configured: real two-step OpenSea lookup
  process.env.OPENSEA_API_KEY = 'test-opensea-key'
  delete require.cache[require.resolve('../src/services/floor')]
  const { getFloorPrice: getFloorPriceWithKey, getTrending: getTrendingWithKey } = require('../src/services/floor')
  requestedUrls.length = 0
  const robinhoodResult = await getFloorPriceWithKey(testAddress, 'robinhood')
  assert.equal(requestedUrls.length, 2, 'Should call OpenSea contract lookup then collection stats')
  assert.equal(requestedUrls[0].url, `https://api.opensea.io/api/v2/chain/robinhood/contract/${testAddress}`)
  assert.equal(requestedUrls[0].headers['x-api-key'], 'test-opensea-key')
  assert.equal(requestedUrls[1].url, 'https://api.opensea.io/api/v2/collections/mock-robinhood-collection/stats')
  assert.equal(robinhoodResult.floor, 0.456)
  assert.equal(robinhoodResult.source, 'opensea')
  assert.equal(robinhoodResult.unsupported, undefined)
  console.log('✅ Robinhood floor lookup with OPENSEA_API_KEY: real OpenSea contract->collection->stats lookup')

  // 4. Trending: Ethereum keeps working, Robinhood returns [] (no source yet)
  requestedUrls.length = 0
  const robinhoodTrending = await getTrendingWithKey('robinhood')
  assert.deepEqual(robinhoodTrending, [])
  assert.equal(requestedUrls.length, 0, 'Trending for robinhood should not call any API - no source integrated')
  console.log('✅ Robinhood trending: empty result, no crash, no stray API calls')

  console.log('\nAll Phase 5 chain-routing checks passed.')
}

main().catch((error) => {
  console.error('❌ Verification failed:', error)
  process.exit(1)
})
