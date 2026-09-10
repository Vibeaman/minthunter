/**
 * Standalone verification script for Phase 4 - Contract & ABI Service.
 * Mocks axios.get so no real network access is required, and asserts that
 * fetchABI() builds the correct request URL for each chain's explorer API
 * style: etherscan-v2 (Ethereum) vs blockscout-etherscan-compat (Robinhood).
 *
 * Run with: node scripts/verify-phase4-fetchabi.js
 */

const path = require('path')
const Module = require('module')

const capturedRequests = []

// Stub axios before contract.js requires it, so no real HTTP calls happen.
const axiosStub = {
  get: async (url) => {
    capturedRequests.push(url)
    const parsed = new URL(url)

    // Simulate a verified contract with a trivial ABI for both explorers -
    // both use the exact same {status, message, result} response shape.
    const fakeAbi = [{ type: 'function', name: 'mint', inputs: [], stateMutability: 'payable' }]

    return {
      data: {
        status: '1',
        message: 'OK',
        result: JSON.stringify(fakeAbi),
      },
    }
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return axiosStub
  return originalLoad.apply(this, arguments)
}

const { fetchABI } = require(path.join(__dirname, '..', 'src', 'services', 'contract.js'))

async function main() {
  let failed = false

  // --- Ethereum: expect etherscan-v2 URL shape with chainid=1 ---
  process.env.ETHERSCAN_API_KEY = 'test-eth-key'
  capturedRequests.length = 0
  await fetchABI('0x1111111111111111111111111111111111111111', 'ethereum')
  const ethUrl = capturedRequests[0]
  console.log('Ethereum request URL:', ethUrl)

  const ethChecks = [
    ['hits api.etherscan.io/v2/api', ethUrl.startsWith('https://api.etherscan.io/v2/api')],
    ['has chainid=1', /[?&]chainid=1(&|$)/.test(ethUrl)],
    ['has module=contract', /[?&]module=contract(&|$)/.test(ethUrl)],
    ['has action=getabi', /[?&]action=getabi(&|$)/.test(ethUrl)],
    ['has apikey=', /[?&]apikey=test-eth-key(&|$)/.test(ethUrl)],
  ]
  for (const [label, ok] of ethChecks) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
    if (!ok) failed = true
  }

  // --- Robinhood: expect blockscout-etherscan-compat URL shape, module/action style ---
  delete process.env.ROBINHOOD_BLOCKSCOUT_API_KEY
  capturedRequests.length = 0
  await fetchABI('0x2222222222222222222222222222222222222222', 'robinhood')
  const rhUrlNoKey = capturedRequests[0]
  console.log('\nRobinhood request URL (no key configured):', rhUrlNoKey)

  const rhChecksNoKey = [
    ['hits robinhoodchain.blockscout.com/api (not /api/v2/...)', rhUrlNoKey.startsWith('https://robinhoodchain.blockscout.com/api?')],
    ['has module=contract', /[?&]module=contract(&|$)/.test(rhUrlNoKey)],
    ['has action=getabi', /[?&]action=getabi(&|$)/.test(rhUrlNoKey)],
    ['has NO chainid= param', !/[?&]chainid=/.test(rhUrlNoKey)],
    ['proceeds keyless (no apikey= param)', !/[?&]apikey=/.test(rhUrlNoKey)],
  ]
  for (const [label, ok] of rhChecksNoKey) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
    if (!ok) failed = true
  }

  // --- Robinhood with API key configured: expect apikey= appended ---
  process.env.ROBINHOOD_BLOCKSCOUT_API_KEY = 'test-rh-key'
  capturedRequests.length = 0
  await fetchABI('0x3333333333333333333333333333333333333333', 'robinhood')
  const rhUrlWithKey = capturedRequests[0]
  console.log('\nRobinhood request URL (key configured):', rhUrlWithKey)
  const keyOk = /[?&]apikey=test-rh-key(&|$)/.test(rhUrlWithKey)
  console.log(`  [${keyOk ? 'PASS' : 'FAIL'}] has apikey=test-rh-key when configured`)
  if (!keyOk) failed = true

  // --- Default chain param backward compatibility (no chain passed -> ethereum) ---
  capturedRequests.length = 0
  await fetchABI('0x4444444444444444444444444444444444444444')
  const defaultUrl = capturedRequests[0]
  const defaultOk = defaultUrl.startsWith('https://api.etherscan.io/v2/api') && /[?&]chainid=1(&|$)/.test(defaultUrl)
  console.log('\nDefault (no chain arg) request URL:', defaultUrl)
  console.log(`  [${defaultOk ? 'PASS' : 'FAIL'}] defaults to Ethereum/etherscan-v2 when chain omitted`)
  if (!defaultOk) failed = true

  Module._load = originalLoad

  if (failed) {
    console.error('\n❌ Phase 4 fetchABI verification FAILED')
    process.exit(1)
  }
  console.log('\n✅ Phase 4 fetchABI verification PASSED')
}

main().catch((error) => {
  console.error('Verification script error:', error)
  process.exit(1)
})
