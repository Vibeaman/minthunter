/**
 * MintHunter - Contract Analysis Service
 * Auto-detects mint functions and prices from contract ABI
 */

const axios = require('axios')
const { ethers } = require('ethers')

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || ''

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
 * Fetch contract ABI from Etherscan
 */
async function fetchABI(contractAddress) {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${contractAddress}${ETHERSCAN_API_KEY ? `&apikey=${ETHERSCAN_API_KEY}` : ''}`
    
    const response = await axios.get(url, { timeout: 10000 })
    
    if (response.data.status === '1' && response.data.result) {
      return JSON.parse(response.data.result)
    }
    
    // Try without API key if it failed
    if (ETHERSCAN_API_KEY) {
      const fallbackUrl = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${contractAddress}`
      const fallback = await axios.get(fallbackUrl, { timeout: 10000 })
      if (fallback.data.status === '1' && fallback.data.result) {
        return JSON.parse(fallback.data.result)
      }
    }
    
    return null
  } catch (error) {
    console.error('Etherscan ABI fetch error:', error.message)
    return null
  }
}

/**
 * Find mint functions from ABI
 */
function findMintFunctions(abi) {
  if (!abi || !Array.isArray(abi)) return []
  
  const mintFunctions = []
  
  for (const item of abi) {
    if (item.type !== 'function') continue
    if (!item.name) continue
    
    const nameLower = item.name.toLowerCase()
    
    // Check if function name matches mint patterns
    const isMintLike = MINT_PATTERNS.some(pattern => nameLower.includes(pattern))
    
    // Also check if it's payable (can receive ETH)
    const isPayable = item.stateMutability === 'payable'
    
    // Check inputs - mint functions typically have 0-2 params
    const hasReasonableParams = item.inputs.length <= 3
    
    if (isMintLike && hasReasonableParams) {
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
 * Analyze contract and return mint details
 */
async function analyzeContract(contractAddress, provider) {
  console.log(`🔍 Analyzing contract: ${contractAddress}`)
  
  const result = {
    address: contractAddress,
    verified: false,
    mintFunctions: [],
    priceFunctions: [],
    recommendedMint: null,
    detectedPrice: null,
    error: null
  }
  
  try {
    // Fetch ABI
    const abi = await fetchABI(contractAddress)
    
    if (!abi) {
      result.error = 'Contract not verified on Etherscan'
      console.log('⚠️ Contract not verified, will use fallback mint functions')
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
  if (!mintFunction) return null
  
  try {
    const iface = new ethers.Interface([`function ${mintFunction.signature}`])
    
    // Build args based on input types
    const args = mintFunction.inputs.map(input => {
      const typeLower = input.type.toLowerCase()
      const nameLower = (input.name || '').toLowerCase()
      
      if (typeLower === 'uint256') {
        // Likely quantity
        return quantity
      } else if (typeLower === 'address') {
        // Likely recipient
        return walletAddress
      } else if (typeLower.startsWith('bytes32')) {
        // Likely merkle proof - return empty for public mint
        return ethers.ZeroHash
      } else if (typeLower === 'bytes32[]') {
        // Merkle proof array
        return []
      }
      
      // Default
      return quantity
    })
    
    const data = iface.encodeFunctionData(mintFunction.name, args)
    return data
    
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
