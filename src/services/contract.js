/**
 * MintHunter - Contract Analysis Service
 * Auto-detects mint functions and prices from contract ABI
 */

const axios = require('axios')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const { getChain, DEFAULT_CHAIN } = require('../chains')

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || ''

// Robinhood Chain's Blockscout sits behind Cloudflare. Requests without a
// browser-like User-Agent (axios's default is "axios/1.x") get a 403
// challenge page instead of JSON. Etherscan is fine either way; send the
// same headers on both so explorer calls stay consistent.
const EXPLORER_HTTP_HEADERS = {
  // Cloudflare on robinhoodchain.blockscout.com challenges non-browser UAs
  // (including axios's default and custom bot strings) with HTTP 403.
  'User-Agent': 'Mozilla/5.0 (compatible; MintHunter/1.0)',
  Accept: 'application/json',
}

// Common mint function patterns to look for
const MINT_PATTERNS = [
  'mint', 'claim', 'buy', 'purchase', 'freemint', 'publicmint', 
  'presalemint', 'safemint', 'batchmint', 'minttoken', 'mintnft'
]

// Common price function patterns
const PRICE_PATTERNS = [
  'price', 'cost', 'mintprice', 'mintcost', 'tokenprice', 
  'publicprice', 'presaleprice', 'fee'
]

/**
 * Parse a raw Etherscan-shaped explorer response ({status, message, result})
 * into an ABI array, or throw a coded error. Both Etherscan v2 and
 * Blockscout's Etherscan-compat `/api` endpoint return this same shape for
 * `module=contract&action=getabi`, so a single parser covers both.
 */
function parseGetAbiResponse(response, explorerLabel) {
  if (response.data.status === '1' && response.data.result) {
    return JSON.parse(response.data.result)
  }

  const resultMsg = typeof response.data.result === 'string' ? response.data.result : ''

  if (/invalid api key/i.test(resultMsg) || /missing.*api key/i.test(resultMsg)) {
    const err = new Error(`${explorerLabel} rejected the configured API key`)
    err.code = 'INVALID_API_KEY'
    throw err
  }

  if (/rate limit/i.test(resultMsg)) {
    const err = new Error(`${explorerLabel} API rate limit reached, please retry shortly`)
    err.code = 'RATE_LIMITED'
    throw err
  }

  // Genuinely unverified/no ABI on record
  return null
}

/**
 * Fetch contract ABI from Etherscan v2. Etherscan's v2 API requires a valid
 * API key and a `chainid=` param on every request - there is no keyless
 * fallback. If the key is missing/invalid, Etherscan replies with
 * "Missing/Invalid API Key", which must NOT be confused with the contract
 * genuinely being unverified.
 */
async function fetchABIFromEtherscanV2(contractAddress, chainConfig) {
  const apiKey = process.env[chainConfig.explorer.apiKeyEnvKey] || ETHERSCAN_API_KEY

  if (!apiKey) {
    const err = new Error(`${chainConfig.explorer.apiKeyEnvKey} is not configured`)
    err.code = 'NO_API_KEY'
    throw err
  }

  try {
    const url = `${chainConfig.explorer.apiUrl}?chainid=${chainConfig.chainId}&module=contract&action=getabi&address=${contractAddress}&apikey=${apiKey}`
    const response = await axios.get(url, { timeout: 10000, headers: EXPLORER_HTTP_HEADERS })
    return parseGetAbiResponse(response, 'Etherscan')
  } catch (error) {
    if (error.code === 'INVALID_API_KEY' || error.code === 'RATE_LIMITED') {
      throw error
    }
    console.error('Etherscan ABI fetch error:', error.message)
    const err = new Error(`Etherscan request failed: ${error.message}`)
    err.code = 'REQUEST_FAILED'
    throw err
  }
}

/**
 * Fetch contract ABI from Blockscout's Etherscan-compatible `/api` endpoint
 * (module=contract&action=getabi - NOT the newer `/api/v2/...` REST style).
 * Blockscout works keyless at low volume, so a missing API key is NOT an
 * error here - it's only appended if configured, to raise rate limits.
 */
async function fetchABIFromBlockscoutCompat(contractAddress, chainConfig) {
  const apiKey = process.env[chainConfig.explorer.apiKeyEnvKey]
  const apiKeyParam = apiKey ? `&apikey=${apiKey}` : ''

  try {
    const url = `${chainConfig.explorer.apiUrl}?module=contract&action=getabi&address=${contractAddress}${apiKeyParam}`
    const response = await axios.get(url, { timeout: 10000, headers: EXPLORER_HTTP_HEADERS })
    return parseGetAbiResponse(response, 'Blockscout')
  } catch (error) {
    if (error.code === 'INVALID_API_KEY' || error.code === 'RATE_LIMITED') {
      throw error
    }
    console.error('Blockscout ABI fetch error:', error.message)
    const err = new Error(`Blockscout request failed: ${error.message}`)
    err.code = 'REQUEST_FAILED'
    throw err
  }
}

/**
 * Fetch contract ABI from the verified-source explorer configured for the
 * given chain. Routes to the correct API style per chains.js's
 * `explorer.apiStyle` - Etherscan v2 (chainid + mandatory API key) for
 * Ethereum, Blockscout's Etherscan-compat API (keyless-capable) for
 * Robinhood Chain and any future Blockscout-based chain.
 */
async function fetchABI(contractAddress, chain = DEFAULT_CHAIN) {
  const chainConfig = getChain(chain)
  const apiStyle = chainConfig.explorer.apiStyle

  if (apiStyle === 'etherscan-v2') {
    return fetchABIFromEtherscanV2(contractAddress, chainConfig)
  }

  if (apiStyle === 'blockscout-etherscan-compat') {
    return fetchABIFromBlockscoutCompat(contractAddress, chainConfig)
  }

  const err = new Error(`Unsupported explorer API style "${apiStyle}" for chain ${chainConfig.name}`)
  err.code = 'UNSUPPORTED_EXPLORER'
  throw err
}

/**
 * Find mint functions from ABI
 */
function findMintFunctions(abi) {
  if (!abi || !Array.isArray(abi)) return []
  
  const mintFunctions = []
  
  for (const item of abi) {
    if (item.type !== 'function') continue
    if (!item.name || ['view', 'pure'].includes(item.stateMutability)) continue
    
    const nameLower = item.name.toLowerCase()
    
    // Check if function name matches mint patterns
    const isMintLike = MINT_PATTERNS.some(pattern => nameLower.includes(pattern))
    
    // Also check if it's payable (can receive ETH)
    const isPayable = item.stateMutability === 'payable'
    
    // Only retain argument types that the safe calldata builder can represent.
    const hasSupportedParams = item.inputs.length <= 3 && item.inputs.every((input) => (
      /^uint(8|16|32|64|128|256)?$/.test(input.type.toLowerCase()) || input.type.toLowerCase() === 'address'
    ))
    
    if (isMintLike && hasSupportedParams) {
      // Build function signature
      const inputTypes = item.inputs.map(i => i.type).join(',')
      const signature = `${item.name}(${inputTypes})`
      const selector = ethers.id(signature).slice(0, 10)
      
      mintFunctions.push({
        name: item.name,
        signature,
        selector,
        inputs: item.inputs,
        isPayable,
        // Score for sorting - prefer simpler functions
        score: calculateMintScore(item)
      })
    }
  }
  
  // Sort by score (higher = better candidate)
  return mintFunctions.sort((a, b) => b.score - a.score)
}

/**
 * Calculate how likely this is the main mint function
 */
function calculateMintScore(fn) {
  let score = 0
  const name = fn.name.toLowerCase()
  
  // Prefer functions with "mint" in name
  if (name === 'mint') score += 100
  if (name === 'publicmint') score += 90
  if (name === 'freemint') score += 85
  if (name.startsWith('mint')) score += 50
  if (name.includes('public')) score += 30
  if (name.includes('free')) score += 25
  
  // Prefer payable functions
  if (fn.stateMutability === 'payable') score += 40
  
  // Prefer fewer parameters
  if (fn.inputs.length === 0) score += 20
  if (fn.inputs.length === 1) score += 15
  
  // Prefer uint256 quantity parameter
  if (fn.inputs.some(i => i.type === 'uint256' && ['quantity', 'amount', 'count', 'num', '_quantity', '_amount'].includes(i.name?.toLowerCase()))) {
    score += 25
  }
  
  // Simple uint256 param (likely quantity)
  if (fn.inputs.length === 1 && fn.inputs[0].type === 'uint256') {
    score += 20
  }
  
  // Penalize functions that look like admin/internal
  if (name.includes('owner')) score -= 50
  if (name.includes('admin')) score -= 50
  if (name.includes('internal')) score -= 50
  if (name.includes('_')) score -= 10 // internal convention
  
  return score
}

/**
 * Find price functions from ABI
 */
function findPriceFunctions(abi) {
  if (!abi || !Array.isArray(abi)) return []
  
  const priceFunctions = []
  
  for (const item of abi) {
    if (item.type !== 'function') continue
    if (!item.name) continue
    
    const nameLower = item.name.toLowerCase()
    
    // Check if it's a view/pure function that returns uint256
    const isView = ['view', 'pure'].includes(item.stateMutability)
    const returnsUint = item.outputs?.some(o => o.type === 'uint256')
    const noInputs = item.inputs.length === 0
    
    // Check if name matches price patterns
    const isPriceLike = PRICE_PATTERNS.some(pattern => nameLower.includes(pattern))
    
    if (isPriceLike && isView && returnsUint && noInputs) {
      const signature = `${item.name}()`
      priceFunctions.push({
        name: item.name,
        signature,
        selector: ethers.id(signature).slice(0, 10)
      })
    }
  }
  
  return priceFunctions
}

/**
 * Get mint price from contract
 */
async function getMintPrice(contractAddress, provider, priceFunctions) {
  if (!priceFunctions || priceFunctions.length === 0) {
    return null
  }
  
  for (const priceFn of priceFunctions) {
    try {
      const contract = new ethers.Contract(
        contractAddress,
        [`function ${priceFn.signature} view returns (uint256)`],
        provider
      )
      
      const price = await contract[priceFn.name]()
      console.log(`Found price via ${priceFn.name}(): ${ethers.formatEther(price)} ETH`)
      return price
    } catch (e) {
      // Try next price function
      continue
    }
  }
  
  return null
}

/**
 * Analyze contract and return mint details.
 * `chain` selects which explorer (Etherscan v2, Blockscout compat, ...) is
 * used to fetch the ABI, per chains.js. Defaults to DEFAULT_CHAIN so
 * existing Ethereum-only call sites keep working unchanged.
 */
async function analyzeContract(contractAddress, provider, chain = DEFAULT_CHAIN) {
  console.log(`🔍 Analyzing contract: ${contractAddress}`)

  const chainConfig = getChain(chain)
  const explorerLabel = chainConfig.explorer.apiStyle === 'etherscan-v2' ? 'Etherscan' : 'Blockscout'

  const result = {
    address: contractAddress,
    chain: chainConfig.id,
    verified: false,
    mintFunctions: [],
    priceFunctions: [],
    recommendedMint: null,
    detectedPrice: null,
    error: null
  }
  
  try {
    // Fetch ABI
    let abi
    try {
      abi = await fetchABI(contractAddress, chain)
    } catch (fetchError) {
      // Distinguish infrastructure/config failures from a genuinely unverified contract
      if (fetchError.code === 'NO_API_KEY') {
        result.error = `MintHunter is missing its ${explorerLabel} API key (contact the bot admin) - unable to check verification status`
      } else if (fetchError.code === 'INVALID_API_KEY') {
        result.error = `MintHunter's ${explorerLabel} API key was rejected (contact the bot admin) - unable to check verification status`
      } else if (fetchError.code === 'RATE_LIMITED') {
        result.error = `${explorerLabel} is rate-limiting requests right now, please try again in a moment`
      } else {
        result.error = `Could not reach ${explorerLabel} to check verification status: ${fetchError.message}`
      }
      console.log(`⚠️ ${result.error}`)
      return result
    }

    if (!abi) {
      result.error = `Contract not verified on ${explorerLabel}`
      console.log('⚠️ Contract not verified; safe auto-mint is unavailable')
      return result
    }
    
    result.verified = true
    
    // Find mint functions
    result.mintFunctions = findMintFunctions(abi)
    console.log(`Found ${result.mintFunctions.length} mint-like functions`)
    
    // Find price functions
    result.priceFunctions = findPriceFunctions(abi)
    console.log(`Found ${result.priceFunctions.length} price-like functions`)
    
    // Get recommended mint function
    if (result.mintFunctions.length > 0) {
      result.recommendedMint = result.mintFunctions[0]
      console.log(`Recommended mint: ${result.recommendedMint.signature}`)
    } else {
      result.error = 'No supported external mint function found in the verified ABI'
    }
    
    // Try to get price
    if (provider && result.priceFunctions.length > 0) {
      result.detectedPrice = await getMintPrice(contractAddress, provider, result.priceFunctions)
    }
    
    return result
    
  } catch (error) {
    result.error = error.message
    console.error('Contract analysis error:', error.message)
    return result
  }
}

/**
 * Build mint transaction data
 */
function buildMintData(mintFunction, quantity = 1, walletAddress = null) {
  if (!mintFunction || !Array.isArray(mintFunction.inputs)) return null
  if (!walletAddress || !ethers.isAddress(walletAddress)) return null

  try {
    const iface = new ethers.Interface([`function ${mintFunction.signature}`])
    const inputs = mintFunction.inputs
    const integerInputs = inputs.filter((input) => /^uint(8|16|32|64|128|256)?$/.test(input.type.toLowerCase()))
    const addressInputs = inputs.filter((input) => input.type.toLowerCase() === 'address')

    const args = inputs.map((input) => {
      const type = input.type.toLowerCase()
      const name = (input.name || '').toLowerCase()

      if (/^uint(8|16|32|64|128|256)?$/.test(type)) {
        const quantityName = /(^|_)(quantity|amount|count|number|num|qty)($|_)/.test(name)
        if (integerInputs.length > 1 && !quantityName) {
          throw new Error(`Unsupported ambiguous integer argument: ${input.name || type}`)
        }
        return quantity
      }

      if (type === 'address') {
        const recipientName = /(^|_)(to|recipient|receiver|wallet|account|owner)($|_)/.test(name)
        if (addressInputs.length > 1 && !recipientName) {
          throw new Error(`Unsupported ambiguous address argument: ${input.name || type}`)
        }
        return walletAddress
      }

      throw new Error(`Unsupported mint argument type: ${input.type}`)
    })

    return iface.encodeFunctionData(mintFunction.name, args)
  } catch (error) {
    console.error('Error building mint data:', error.message)
    return null
  }
}

module.exports = {
  fetchABI,
  findMintFunctions,
  findPriceFunctions,
  getMintPrice,
  analyzeContract,
  buildMintData
}
