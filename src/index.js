/**
 * MintHunter - NFT Floor Alerts + Auto-Mint Bot
 * Part 6a: Bot setup + /start
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const TelegramBot = require('node-telegram-bot-api')
const { initDb } = require('./db')
const db = require('./db')
const { mainMenu, settingsMenu, gasBoostMenu, walletsMenu, mintMenu, mintModeMenu, gasOptions, alertsMenu, alertCondition, backToMain } = require('./keyboards')
const { encryptPrivateKey, decryptPrivateKey } = require('./crypto')
const { getProvider, broadcastToAll, fcfsBroadcast } = require('./provider')
const { getFloorPrice, checkAlerts, getTrending, getEthPrice } = require('./services/floor')
const { analyzeContract, buildMintData } = require('./services/contract')
const { ethers } = require('ethers')
const {
  isPrivateChat,
  normalizeAccessCode,
  parseCallbackId,
  parseEthAmount,
  parseUtcDateTime,
  validateAddress,
  validatePrivateKey,
} = require('./security')

// Fee config must be explicit and valid; never silently fall back to a wallet.
const configuredFeeWallet = validateAddress(process.env.FEE_WALLET)
const FEE_WALLET = configuredFeeWallet && configuredFeeWallet !== ethers.ZeroAddress ? configuredFeeWallet : null
const FCFS_FEE = parseEthAmount(process.env.FCFS_FEE_ETH, { allowZero: false })?.text
if (!FEE_WALLET || !FCFS_FEE) {
  throw new Error('FEE_WALLET and FCFS_FEE_ETH must be configured with valid values')
}

// Common error messages decoder
function decodeError(error) {
  const msg = error?.message?.toLowerCase() || error?.toString()?.toLowerCase() || ''
  const reason = error?.reason?.toLowerCase() || ''
  
  // Sold out / max supply
  if (msg.includes('sold out') || msg.includes('max supply') || msg.includes('exceeds max') || reason.includes('sold out')) {
    return '🚨 SOLD OUT - Collection minted out'
  }
  
  // Not live / paused
  if (msg.includes('not active') || msg.includes('sale not') || msg.includes('paused') || msg.includes('not started') || msg.includes('not live')) {
    return '⏸️ NOT LIVE - Mint not active yet'
  }
  
  // Whitelist / allowlist
  if (msg.includes('whitelist') || msg.includes('allowlist') || msg.includes('not eligible') || msg.includes('proof') || msg.includes('merkle')) {
    return '🚫 NOT WHITELISTED - Address not on allowlist'
  }
  
  // Max per wallet
  if (msg.includes('max per') || msg.includes('limit reached') || msg.includes('already minted') || msg.includes('exceeds limit')) {
    return '👛 MAX REACHED - Wallet already minted max allowed'
  }
  
  // Insufficient funds
  if (msg.includes('insufficient') || msg.includes('not enough') || msg.includes('balance')) {
    return '💸 INSUFFICIENT FUNDS - Not enough ETH'
  }
  
  // Wrong price
  if (msg.includes('incorrect') || msg.includes('wrong') || msg.includes('price')) {
    return '💰 WRONG PRICE - Mint price changed'
  }
  
  // Gas issues
  if (msg.includes('gas') || msg.includes('underpriced')) {
    return '⛽ GAS ERROR - Try higher gas boost'
  }
  
  // Nonce
  if (msg.includes('nonce')) {
    return '🔄 NONCE ERROR - Transaction conflict, retry'
  }
  
  // Generic revert
  if (msg.includes('revert') || msg.includes('execution reverted')) {
    return '❌ REVERTED - Contract rejected transaction'
  }
  
  // Unknown
  return `❓ ERROR: ${error?.reason || error?.message?.slice(0, 100) || 'Unknown error'}`
}

// Validate env
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set in .env')
  process.exit(1)
}

// Create bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
console.log('🎯 MintHunter starting...')

// Track user state for multi-step flows
const userState = new Map()
const executingJobs = new Set()
const walletLocks = new Set()
const accessAttempts = new Map()
const ACCESS_WINDOW_MS = 15 * 60 * 1000
const ACCESS_ATTEMPT_LIMIT = 5

function getAuthorizedUser(userId) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
  const isExpired = user?.access_expires && new Date(user.access_expires) <= new Date()
  if (isExpired) {
    db.prepare('UPDATE users SET is_authorized = 0 WHERE telegram_id = ?').run(userId)
    return null
  }
  return user?.is_authorized ? user : null
}

function requirePrivateChat(msg) {
  if (!isPrivateChat(msg)) {
    throw new Error('MintHunter only accepts sensitive commands in a private chat.')
  }
}

// Initialize database then start bot
initDb().then(() => {
  console.log('💾 Database ready')
  
  // /start command
  bot.onText(/^\/start(?:@\w+)?(?:\s.*)?$/, async (msg) => {
    if (!isPrivateChat(msg)) {
      await bot.sendMessage(msg.chat.id, '🔐 Please message MintHunter privately before using it.')
      return
    }
    const chatId = msg.chat.id
    const userId = msg.from.id
    const username = msg.from.username || msg.from.first_name
    
    console.log(`👋 /start from ${username} (${userId})`)
    
    // Ensure user exists
    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
    if (!user) {
      db.prepare('INSERT INTO users (telegram_id, username, is_authorized) VALUES (?, ?, 0)').run(userId, username)
      user = { is_authorized: 0 }
      console.log(`✨ New user: ${username}`)
    }
    
    // Clear any pending state
    userState.delete(userId)
    
    // Check if authorized and not expired
    const isExpired = user.access_expires && new Date(user.access_expires) < new Date()
    if (!user.is_authorized || isExpired) {
      // Reset authorization if expired
      if (isExpired) {
        db.prepare('UPDATE users SET is_authorized = 0 WHERE telegram_id = ?').run(userId)
      }
      userState.set(userId, { step: 'enter_code' })
      await bot.sendMessage(chatId,
        `🎯 *MintHunter*\n\n` +
        `🔐 ${isExpired ? 'Your access has expired.' : 'This bot requires an access code.'}\n\n` +
        `Enter your access code:`,
        { parse_mode: 'Markdown' }
      )
      return
    }
    
    await bot.sendMessage(chatId, 
      `🎯 *MintHunter*\n\n` +
      `Hi Grindoor! 👋\n\n` +
      `• 🔔 Set floor price alerts\n` +
      `• ⚡ FCFS competitive minting\n` +
      `• 👛 Secure wallet management\n` +
      `• 🔥 Trending collections\n\n` +
      `What would you like to do?`,
      { parse_mode: 'Markdown', reply_markup: mainMenu }
    )
  })

  // Handle menu navigation
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id
    const userId = query.from?.id
    const data = query.data
    if (!chatId || !userId || query.message?.chat?.type !== 'private') {
      await bot.answerCallbackQuery(query.id, { text: 'Use MintHunter in a private chat.' })
      return
    }
    
    console.log(`📥 Button: ${data} from ${userId}`)
    
    // Acknowledge button press
    await bot.answerCallbackQuery(query.id)
    
    // Re-check authorization and expiry on every callback.
    const user = getAuthorizedUser(userId)
    if (!user) {
      await bot.sendMessage(chatId,
        '🔐 Your access is not active. Send /start to begin.',
        { parse_mode: 'Markdown' }
      )
      return
    }
    
    // Main menu navigation
    if (data === 'menu_main') {
      userState.delete(userId)
      await bot.editMessageText(
        '🎯 *MintHunter*\n\nWhat would you like to do?',
        { 
          chat_id: chatId, 
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: mainMenu 
        }
      )
      return
    }
    
    // ========== WALLETS MENU ==========
    if (data === 'menu_wallets') {
      userState.delete(userId)
      await bot.editMessageText(
        '👛 *Wallet Management*\n\nYour wallets are encrypted and secure.',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: walletsMenu
        }
      )
      return
    }

    // Add wallet - ask for private key
    if (data === 'wallet_add') {
      userState.set(userId, { step: 'wallet_key' })
      await bot.sendMessage(chatId,
        '🔐 *Add Wallet*\n\n' +
        'Send your private key (starts with 0x).\n\n' +
        '⚠️ Your key is encrypted with AES-256 and never stored in plain text.\n\n' +
        '_Send /cancel to abort_',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // List wallets
    if (data === 'wallet_list') {
      const wallets = db.prepare('SELECT * FROM wallets WHERE telegram_id = ?').all(userId)
      
      if (wallets.length === 0) {
        await bot.sendMessage(chatId,
          '👛 No wallets yet.\n\nAdd one to start minting!',
          { reply_markup: walletsMenu }
        )
        return
      }
      
      let text = '👛 *Your Wallets*\n\n'
      const buttons = []
      
      for (const w of wallets) {
        const short = w.address.slice(0, 6) + '...' + w.address.slice(-4)
        text += `• ${w.label || 'Wallet'}: \`${short}\`\n`
        buttons.push([{ text: `🗑 Delete ${short}`, callback_data: `wallet_delete_${w.id}` }])
      }
      
      buttons.push([{ text: '🔙 Back', callback_data: 'menu_wallets' }])
      
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
      return
    }

    // Delete wallet
    if (data.startsWith('wallet_delete_')) {
      const walletId = parseCallbackId(data, 'wallet_delete_')
      if (!walletId) {
        await bot.sendMessage(chatId, '❌ Invalid wallet action.', { reply_markup: walletsMenu })
        return
      }
      const activeJobs = db.prepare(`
        SELECT COUNT(*) AS count FROM mint_jobs
        WHERE wallet_id = ? AND telegram_id = ? AND status IN ('pending', 'scheduled', 'executing')
      `).get(walletId, userId)
      if (activeJobs?.count > 0) {
        await bot.sendMessage(chatId, '❌ Cancel the wallet’s pending or scheduled jobs before deleting it.', { reply_markup: mintMenu })
        return
      }
      const deleted = db.prepare('DELETE FROM wallets WHERE id = ? AND telegram_id = ?').run(walletId, userId)
      await bot.sendMessage(chatId, deleted.changes === 1 ? '✅ Wallet deleted.' : '❌ Wallet not found.', { reply_markup: walletsMenu })
      return
    }

    // ========== MINT MENU ==========
    if (data === 'menu_mint') {
      userState.delete(userId)
      await bot.editMessageText(
        '⚡ *Minting*\n\n' +
        'Create mint jobs to auto-mint NFTs.\n\n' +
        '• *FCFS* - Broadcast through configured RPCs\n' +
        '• *Normal* - Standard verified transaction',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: mintMenu
        }
      )
      return
    }

    // New mint job - check for wallets first
    if (data === 'mint_new') {
      const wallets = db.prepare('SELECT * FROM wallets WHERE telegram_id = ?').all(userId)
      
      if (wallets.length === 0) {
        await bot.sendMessage(chatId,
          '❌ No wallets found.\n\nAdd a wallet first before creating mint jobs.',
          { reply_markup: walletsMenu }
        )
        return
      }
      
      // Ask to select wallet
      const buttons = wallets.map(w => {
        const short = w.address.slice(0, 6) + '...' + w.address.slice(-4)
        return [{ text: `👛 ${short}`, callback_data: `mint_wallet_${w.id}` }]
      })
      buttons.push([{ text: '🔙 Back', callback_data: 'menu_mint' }])
      
      await bot.sendMessage(chatId,
        '⚡ *New Mint Job*\n\nSelect a wallet to use:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      )
      return
    }

    // Wallet selected for mint
    if (data.startsWith('mint_wallet_')) {
      const walletId = parseCallbackId(data, 'mint_wallet_')
      if (!walletId) {
        await bot.sendMessage(chatId, '❌ Invalid wallet selection.', { reply_markup: mintMenu })
        return
      }
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND telegram_id = ?').get(walletId, userId)
      
      if (!wallet) {
        await bot.sendMessage(chatId, '❌ Wallet not found.', { reply_markup: mintMenu })
        return
      }
      
      userState.set(userId, { 
        step: 'mint_contract', 
        walletId: wallet.id,
        walletAddress: wallet.address
      })
      
      const short = wallet.address.slice(0, 6) + '...' + wallet.address.slice(-4)
      await bot.sendMessage(chatId,
        `⚡ *New Mint Job*\n\n` +
        `Wallet: \`${short}\`\n\n` +
        `Send the NFT contract address:`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // Select mint mode
    if (data.startsWith('mode_')) {
      const state = userState.get(userId)
      if (!state || !state.contract) {
        await bot.sendMessage(chatId, '❌ Session expired. Start over.', { reply_markup: mintMenu })
        return
      }
      
      const mode = data.replace('mode_', '')
      if (!['fcfs', 'normal'].includes(mode)) {
        await bot.sendMessage(chatId, '❌ That mint mode is not available.', { reply_markup: mintMenu })
        return
      }
      state.mode = mode
      state.step = 'mint_price'
      userState.set(userId, state)
      
      const modeText = mode === 'fcfs' ? '⚡ FCFS' : '🐢 Normal'
      
      // Check if we detected a price
      let pricePrompt = `⚡ *Mint Mode: ${modeText}*\n\n`
      
      if (state.detectedPrice !== undefined && state.detectedPrice !== null) {
        pricePrompt += `💰 Detected price: *${state.detectedPrice} ETH*\n\n`
        pricePrompt += `Press Enter or send the price to confirm, or enter a different price.\n\n`
      }
      
      pricePrompt += `Send the mint price in ETH (e.g., 0.05)\n`
      pricePrompt += `Send \`0\` for free mints.`
      
      await bot.sendMessage(chatId, pricePrompt, { parse_mode: 'Markdown' })
      return
    }

    // Select gas option
    if (data.startsWith('gas_')) {
      const state = userState.get(userId)
      if (!state || !state.mintPrice) {
        await bot.sendMessage(chatId, '❌ Session expired. Start over.', { reply_markup: mintMenu })
        return
      }
      
      const gasLevel = data.replace('gas_', '') // aggressive, fast, normal
      state.gasLevel = gasLevel
      userState.set(userId, state)
      
      // Create the mint job
      const gasMultiplier = gasLevel === 'aggressive' ? 1.5 : gasLevel === 'fast' ? 1.2 : 1.0
      
      // Store detected mint function if available
      const mintFunctionJson = state.detectedMintFn ? JSON.stringify(state.detectedMintFn) : null
      
      const result = db.prepare(`
        INSERT INTO mint_jobs 
        (telegram_id, wallet_id, contract_address, mint_function, mint_price, mint_mode, gas_limit, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        userId,
        state.walletId,
        state.contract,
        mintFunctionJson,
        state.mintPrice,
        state.mode,
        Math.floor(250000 * gasMultiplier)
      )
      
      const jobId = result.lastInsertRowid
      console.log(`✨ Created mint job #${jobId} for user ${userId}`)
      
      userState.delete(userId)
      
      // Get ETH price for USD conversion
      const ethPrice = await getEthPrice()
      const mintPriceUsd = ethPrice ? (parseFloat(state.mintPrice) * ethPrice).toFixed(2) : 'unavailable'
      const feeUsd = ethPrice ? (parseFloat(FCFS_FEE) * ethPrice).toFixed(2) : 'unavailable'
      
      const feeNote = state.mode !== 'normal' 
        ? `\n\n💰 Fee: ${FCFS_FEE} ETH (~$${feeUsd})`
        : ''
      
      // Check if user wants to skip simulation
      const userSettings = db.prepare('SELECT skip_simulation FROM users WHERE telegram_id = ?').get(userId)
      const skipSim = userSettings?.skip_simulation === 1
      
      if (skipSim) {
        await bot.sendMessage(chatId,
          `⚠️ *Simulation skipped*\n\n` +
          `📋 Job #${jobId}\n` +
          `📍 Contract: \`${state.contract.slice(0, 10)}...\`\n` +
          `💎 Price: ${state.mintPrice} ETH (~$${mintPriceUsd})\n` +
          `⚡ Mode: ${state.mode.toUpperCase()}\n` +
          `⛽ Gas: ${gasLevel}${feeNote}\n\n` +
          `Review the details and tap Execute when you are ready.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🚀 EXECUTE NOW', callback_data: `mint_execute_${jobId}` }],
                [{ text: '❌ Cancel Job', callback_data: `mint_cancel_${jobId}` }],
                [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
              ]
            }
          }
        )
      } else {
        // Normal mode - show options
        await bot.sendMessage(chatId,
          `✅ *Mint Job Created*\n\n` +
          `📋 Job #${jobId}\n` +
          `📍 Contract: \`${state.contract.slice(0, 10)}...\`\n` +
          `💎 Price: ${state.mintPrice} ETH (~$${mintPriceUsd})\n` +
          `⚡ Mode: ${state.mode.toUpperCase()}\n` +
          `⛽ Gas: ${gasLevel}${feeNote}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 SIMULATE', callback_data: `mint_simulate_${jobId}` }],
                [{ text: '🚀 EXECUTE NOW', callback_data: `mint_execute_${jobId}` }],
                [{ text: '❌ Cancel Job', callback_data: `mint_cancel_${jobId}` }],
                [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
              ]
            }
          }
        )
      }
      return
    }

    // Execute mint
    // ========== SIMULATE MINT ==========
    if (data.startsWith('mint_simulate_')) {
      const jobId = parseCallbackId(data, 'mint_simulate_')
      if (!jobId) {
        await bot.sendMessage(chatId, '❌ Invalid job.', { reply_markup: mintMenu })
        return
      }
      const job = db.prepare('SELECT * FROM mint_jobs WHERE id = ? AND telegram_id = ?').get(jobId, userId)
      
      if (!job) {
        await bot.sendMessage(chatId, '❌ Job not found.', { reply_markup: mintMenu })
        return
      }
      
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND telegram_id = ?').get(job.wallet_id, userId)
      if (!wallet) {
        await bot.sendMessage(chatId, '❌ Wallet not found.', { reply_markup: mintMenu })
        return
      }
      
      await bot.sendMessage(chatId, '🔍 Simulating transaction...')
      
      try {
        const provider = await getProvider()
        const network = await provider.getNetwork()
        if (network.chainId !== 1n) throw new Error('MintHunter currently supports Ethereum mainnet only')
        const ethPrice = await getEthPrice()
        const detectedFn = job.mint_function ? JSON.parse(job.mint_function) : null
        if (!detectedFn) throw new Error('No verified mint function is available for this job')
        const mintData = buildMintData(detectedFn, 1, wallet.address)
        if (!mintData || mintData === '0x') throw new Error('Mint calldata could not be built safely')
        const userSettings = db.prepare('SELECT slippage_enabled, gas_boost FROM users WHERE telegram_id = ?').get(job.telegram_id)
        const baseMintCost = ethers.parseEther(job.mint_price || '0')
        const mintCost = userSettings?.slippage_enabled === 1
          ? baseMintCost + (baseMintCost * 5n / 100n)
          : baseMintCost
        const callRequest = { to: job.contract_address, from: wallet.address, value: mintCost, data: mintData }
        const estimatedGas = await provider.estimateGas(callRequest)
        await provider.call(callRequest)
        const feeData = await provider.getFeeData()
        const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('20', 'gwei')
        const gasLimit = estimatedGas
        const fee = job.mint_mode !== 'normal' ? ethers.parseEther(FCFS_FEE) : 0n
        const totalCost = mintCost + estimatedGas + fee
        
        // Get wallet balance
        const balance = await provider.getBalance(wallet.address)
        
        // Format values
        const mintEth = ethers.formatEther(mintCost)
        const gasEth = ethers.formatEther(estimatedGas)
        const feeEth = ethers.formatEther(fee)
        const totalEth = ethers.formatEther(totalCost)
        const balanceEth = ethers.formatEther(balance)
        
        const mintUsd = ethPrice ? (parseFloat(mintEth) * ethPrice).toFixed(2) : 'unavailable'
        const gasUsd = ethPrice ? (parseFloat(gasEth) * ethPrice).toFixed(2) : 'unavailable'
        const feeUsd = ethPrice ? (parseFloat(feeEth) * ethPrice).toFixed(2) : 'unavailable'
        const totalUsd = ethPrice ? (parseFloat(totalEth) * ethPrice).toFixed(2) : 'unavailable'
        const balanceUsd = ethPrice ? (parseFloat(balanceEth) * ethPrice).toFixed(2) : 'unavailable'
        
        const hasEnough = balance >= totalCost
        const statusEmoji = hasEnough ? '✅' : '❌'
        const statusText = hasEnough ? 'Ready to mint!' : 'Insufficient balance'
        
        // Gas price in gwei
        const gasPriceGwei = (Number(gasPrice) / 1e9).toFixed(2)
        
        await bot.sendMessage(chatId,
          `🔍 *Simulation Results*\n\n` +
          `📝 *Contract:* \`${job.contract_address.slice(0,10)}...\`\n` +
          `⛓ *Chain:* Ethereum\n` +
          `⚡ *Mode:* ${job.mint_mode.toUpperCase()}\n\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `💰 *Mint Price:* ${mintEth} ETH (~$${mintUsd})\n` +
          `⛽ *Gas Fee:* ${gasEth} ETH (~$${gasUsd})\n` +
          `   └ ${gasPriceGwei} gwei \u00d7 ${gasLimit} limit\n` +
          (fee > 0n ? `🎯 *Bot Fee:* ${feeEth} ETH (~$${feeUsd})\n` : '') +
          `\n━━━━━━━━━━━━━━━\n\n` +
          `💳 *Total Cost:* ${totalEth} ETH (~$${totalUsd})\n` +
          `👛 *Your Balance:* ${parseFloat(balanceEth).toFixed(4)} ETH (~$${balanceUsd})\n\n` +
          `${statusEmoji} *${statusText}*`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                hasEnough ? [{ text: '🚀 EXECUTE NOW', callback_data: `mint_execute_${jobId}` }] : [],
                [{ text: '🔄 Refresh', callback_data: `mint_simulate_${jobId}` }],
                [{ text: '❌ Cancel Job', callback_data: `mint_cancel_${jobId}` }],
                [{ text: '🔙 Back', callback_data: 'mint_pending' }]
              ].filter(row => row.length > 0)
            }
          }
        )
      } catch (e) {
        console.error('Simulation error:', e)
        await bot.sendMessage(chatId,
          `❌ Simulation failed: ${e.message?.slice(0, 100)}`,
          { reply_markup: mintMenu }
        )
      }
      return
    }

    // ========== EXECUTE MINT ==========
    if (data.startsWith('mint_execute_')) {
      const jobId = parseCallbackId(data, 'mint_execute_')
      if (!jobId) {
        await bot.sendMessage(chatId, '❌ Invalid job.', { reply_markup: mintMenu })
        return
      }
      const job = db.prepare('SELECT * FROM mint_jobs WHERE id = ? AND telegram_id = ?').get(jobId, userId)
      
      if (!job) {
        await bot.sendMessage(chatId, '❌ Job not found.', { reply_markup: mintMenu })
        return
      }
      
      if (job.status !== 'pending' || executingJobs.has(jobId)) {
        await bot.sendMessage(chatId, `❌ Job already ${job.status}.`, { reply_markup: mintMenu })
        return
      }
      const claimed = db.prepare(`
        UPDATE mint_jobs SET status = 'executing', executed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND telegram_id = ? AND status = 'pending'
      `).run(jobId, userId)
      if (claimed.changes !== 1) {
        await bot.sendMessage(chatId, '❌ This job is already being processed.', { reply_markup: mintMenu })
        return
      }
      executingJobs.add(jobId)
      
      // Get only the current user's wallet.
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND telegram_id = ?').get(job.wallet_id, userId)
      if (!wallet) {
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', jobId)
        executingJobs.delete(jobId)
        await bot.sendMessage(chatId, '❌ Wallet not found.', { reply_markup: mintMenu })
        return
      }
      if (walletLocks.has(wallet.id)) {
        db.prepare("UPDATE mint_jobs SET status = 'pending' WHERE id = ?").run(jobId)
        executingJobs.delete(jobId)
        await bot.sendMessage(chatId, '⏳ Another transaction is already using this wallet. Please wait.', { reply_markup: mintMenu })
        return
      }
      walletLocks.add(wallet.id)
      
      bot.sendMessage(chatId, '⏳ Executing mint...').catch((error) => console.error('Execution status notification failed:', error.message))
      
      try {
        // Decrypt private key
        const privateKey = decryptPrivateKey(wallet.encrypted_key, userId.toString())
        
        // Get provider
        // getProvider validates mainnet when selecting or refreshing the cached provider.
        const provider = await getProvider()
        const signer = new ethers.Wallet(privateKey, provider)
        
        // Start independent RPC reads immediately; local cost/settings work runs in parallel.
        const balancePromise = provider.getBalance(wallet.address)
        const noncePromise = provider.getTransactionCount(wallet.address, 'pending')
        const feeDataPromise = provider.getFeeData()
        const baseMintCost = ethers.parseEther(job.mint_price || '0')
        
        // Check user's slippage and gas boost settings
        const userSettings = db.prepare('SELECT slippage_enabled, gas_boost FROM users WHERE telegram_id = ?').get(job.telegram_id)
        const slippageEnabled = userSettings?.slippage_enabled === 1
        
        // Add 5% slippage buffer if enabled
        const mintCost = slippageEnabled 
          ? baseMintCost + (baseMintCost * 5n / 100n)
          : baseMintCost
        
        const fee = job.mint_mode !== 'normal' ? ethers.parseEther(FCFS_FEE) : 0n
        
        const [balance, nonce, feeData] = await Promise.all([
          balancePromise,
          noncePromise,
          feeDataPromise,
        ])

        // Get actual gas price from network
        const currentGasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei')
        const gasBoostMultiplier = BigInt(userSettings?.gas_boost || 2)
        const boostedGasPrice = currentGasPrice * gasBoostMultiplier
        const gasEstimate = BigInt(job.gas_limit) * boostedGasPrice
        const totalNeeded = mintCost + fee + gasEstimate
        
        if (balance < totalNeeded) {
          const shortfall = ethers.formatEther(totalNeeded - balance)
          const ethPrice = await getEthPrice()
          const needUsd = ethPrice ? (parseFloat(ethers.formatEther(totalNeeded)) * ethPrice).toFixed(2) : 'unavailable'
          const haveUsd = ethPrice ? (parseFloat(ethers.formatEther(balance)) * ethPrice).toFixed(2) : 'unavailable'
          const shortUsd = ethPrice ? (parseFloat(shortfall) * ethPrice).toFixed(2) : 'unavailable'
          
          db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('pending', jobId)
          executingJobs.delete(jobId)
          await bot.sendMessage(chatId,
            `❌ *Insufficient Balance*\n\n` +
            `Need: ~${ethers.formatEther(totalNeeded)} ETH (~$${needUsd})\n` +
            `Have: ${ethers.formatEther(balance)} ETH (~$${haveUsd})\n` +
            `Short: ${shortfall} ETH (~$${shortUsd})`,
            { parse_mode: 'Markdown', reply_markup: mintMenu }
          )
          return
        }
        
        // Only execute calldata produced from a verified ABI. Never send value with empty data.
        bot.sendMessage(chatId, '🔨 Building and simulating mint transaction...').catch((error) => console.error('Build status notification failed:', error.message))
        const detectedFn = job.mint_function ? JSON.parse(job.mint_function) : null
        if (!detectedFn) throw new Error('No verified mint function is available for this job')
        const mintData = buildMintData(detectedFn, 1, wallet.address)
        if (!mintData || mintData === '0x') throw new Error('Mint calldata could not be built safely')

        const gasBoost = BigInt(Math.min(Math.max(Number(userSettings?.gas_boost || 2), 1), 20))
        const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei')) * gasBoost
        const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei')) * gasBoost
        const txRequest = {
          to: job.contract_address,
          from: wallet.address,
          value: mintCost,
          data: mintData,
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
        }
        const [estimatedGas] = await Promise.all([
          provider.estimateGas(txRequest),
          provider.call(txRequest),
        ])
        txRequest.gasLimit = estimatedGas > BigInt(job.gas_limit) ? estimatedGas : BigInt(job.gas_limit)

        const tx = job.mint_mode === 'fcfs'
          ? await fcfsBroadcast(await signer.signTransaction(txRequest))
          : await signer.sendTransaction(txRequest)
        // Update job
        db.prepare(`
          UPDATE mint_jobs 
          SET status = 'executing', tx_hash = ?, executed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(tx.hash, jobId)
        
        await bot.sendMessage(chatId,
          `🚀 *Transaction Sent!*\n\n` +
          `TX: \`${tx.hash}\`\n\n` +
          `⏳ Waiting for confirmation...`,
          { parse_mode: 'Markdown' }
        )
        
        // Wait for confirmation
        const receipt = await tx.wait()
        
        if (receipt.status === 1) {
          let feeTxHash = null
          if (job.mint_mode !== 'normal' && fee > 0n) {
            try {
              const feeTx = await signer.sendTransaction({ to: FEE_WALLET, value: fee })
              await feeTx.wait(1)
              feeTxHash = feeTx.hash
            } catch (feeError) {
              console.error(`Fee collection failed for job #${jobId}:`, feeError.message)
            }
          }
          db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('completed', jobId)
          
          // Generate sell links
          const openseaLink = `https://opensea.io/assets/ethereum/${job.contract_address}`
          const blurLink = `https://blur.io/eth/collection/${job.contract_address}`
          
          await bot.sendMessage(chatId,
            `✅ *Mint Successful!*\n\n` +
            `TX: \`${tx.hash}\`\n` +
            `${feeTxHash ? `Fee TX: \`${feeTxHash}\`\n` : ''}` +
            `Gas Used: ${receipt.gasUsed.toString()}\n\n` +
            `🎉 *List it for sale:*`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🟠 Sell on OpenSea', url: openseaLink }],
                  [{ text: '🟣 Sell on Blur', url: blurLink }],
                  [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
                ]
              }
            }
          )
        } else {
          db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', jobId)
          await bot.sendMessage(chatId,
            `❌ *Mint Failed*\n\n` +
            `Transaction reverted.\n` +
            `TX: \`${tx.hash}\``,
            { parse_mode: 'Markdown', reply_markup: mintMenu }
          )
        }
        
      } catch (err) {
        console.error('Mint error:', err)
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', jobId)
        
        const errorMsg = decodeError(err)
        
        await bot.sendMessage(chatId,
          `❌ *Mint Failed*\n\n` +
          `${errorMsg}\n\n` +
          `_Raw: ${err.message?.slice(0, 100) || 'Unknown'}_`,
          { parse_mode: 'Markdown', reply_markup: mintMenu }
        )
      } finally {
        executingJobs.delete(jobId)
        walletLocks.delete(job.wallet_id)
      }
      return
    }

    // Cancel mint job
    if (data.startsWith('mint_cancel_')) {
      const jobId = parseCallbackId(data, 'mint_cancel_')
      if (!jobId) {
        await bot.sendMessage(chatId, '❌ Invalid job.', { reply_markup: mintMenu })
        return
      }
      const cancelled = db.prepare(`
        UPDATE mint_jobs SET status = 'cancelled'
        WHERE id = ? AND telegram_id = ? AND status IN ('pending', 'scheduled')
      `).run(jobId, userId)
      await bot.sendMessage(chatId, cancelled.changes === 1 ? '✅ Job cancelled.' : '❌ Only pending or scheduled jobs can be cancelled.', { reply_markup: mintMenu })
      return
    }

    // ========== SCHEDULED MINT ==========
    if (data === 'mint_schedule') {
      const wallets = db.prepare('SELECT * FROM wallets WHERE telegram_id = ?').all(userId)
      
      if (wallets.length === 0) {
        await bot.sendMessage(chatId,
          '❌ No wallets found.\n\nAdd a wallet first.',
          { reply_markup: walletsMenu }
        )
        return
      }
      
      const buttons = wallets.map(w => {
        const short = w.address.slice(0, 6) + '...' + w.address.slice(-4)
        return [{ text: `👛 ${short}`, callback_data: `sched_wallet_${w.id}` }]
      })
      buttons.push([{ text: '🔙 Back', callback_data: 'menu_mint' }])
      
      await bot.sendMessage(chatId,
        '⏰ *Schedule FCFS Mint*\n\n' +
        'Bot will auto-mint at your scheduled time.\n' +
        '⚡ Uses aggressive gas + multi-RPC broadcast for max speed.\n\n' +
        'Select wallet:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      )
      return
    }

    // Scheduled mint - wallet selected
    if (data.startsWith('sched_wallet_')) {
      const walletId = parseCallbackId(data, 'sched_wallet_')
      if (!walletId) {
        await bot.sendMessage(chatId, '❌ Invalid wallet selection.', { reply_markup: mintMenu })
        return
      }
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND telegram_id = ?').get(walletId, userId)
      
      if (!wallet) {
        await bot.sendMessage(chatId, '❌ Wallet not found.', { reply_markup: mintMenu })
        return
      }
      
      userState.set(userId, {
        step: 'sched_contract',
        walletId: wallet.id,
        walletAddress: wallet.address,
        isScheduled: true
      })
      
      await bot.sendMessage(chatId,
        '⏰ *Schedule FCFS Mint*\n\n' +
        'Send the NFT contract address:',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // List pending jobs
    if (data === 'mint_pending') {
      const jobs = db.prepare(`
        SELECT * FROM mint_jobs 
        WHERE telegram_id = ? AND status = 'pending'
        ORDER BY created_at DESC
      `).all(userId)
      
      if (jobs.length === 0) {
        await bot.sendMessage(chatId, '📋 No pending mint jobs.', { reply_markup: mintMenu })
        return
      }
      
      let text = '⏳ *Pending Mint Jobs*\n\n'
      const buttons = []
      
      for (const job of jobs) {
        text += `#${job.id} - \`${job.contract_address.slice(0, 10)}...\` (${job.mint_mode})\n`
        buttons.push([
          { text: `🔍 Simulate #${job.id}`, callback_data: `mint_simulate_${job.id}` },
          { text: `❌ Cancel`, callback_data: `mint_cancel_${job.id}` }
        ])
      }
      
      buttons.push([{ text: '🔙 Back', callback_data: 'menu_mint' }])
      
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
      return
    }

    // List completed jobs
    if (data === 'mint_completed') {
      const jobs = db.prepare(`
        SELECT * FROM mint_jobs 
        WHERE telegram_id = ? AND status IN ('completed', 'failed', 'cancelled')
        ORDER BY executed_at DESC
        LIMIT 10
      `).all(userId)
      
      if (jobs.length === 0) {
        await bot.sendMessage(chatId, '📋 No completed mint jobs yet.', { reply_markup: mintMenu })
        return
      }
      
      let text = '✅ *Completed Mint Jobs*\n\n'
      
      for (const job of jobs) {
        const status = job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '🚫'
        text += `${status} #${job.id} - \`${job.contract_address.slice(0, 10)}...\`\n`
        if (job.tx_hash) {
          text += `   TX: \`${job.tx_hash.slice(0, 15)}...\`\n`
        }
      }
      
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_mint' }]] }
      })
      return
    }

    // ========== FLOOR ALERTS MENU ==========
    if (data === 'menu_alerts') {
      userState.delete(userId)
      await bot.editMessageText(
        '🔔 *Floor Price Alerts*\n\n' +
        'Get notified when NFT collections hit your target price.\n\n' +
        '• Set alerts for any collection\n' +
        '• Trigger when price goes above/below target\n' +
        '• Auto-checked every 5 minutes',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: alertsMenu
        }
      )
      return
    }

    // New alert - ask for collection address
    if (data === 'alert_new') {
      userState.set(userId, { step: 'alert_collection' })
      await bot.sendMessage(chatId,
        '🔔 *New Floor Alert*\n\n' +
        'Send the NFT collection contract address:\n\n' +
        '_Example: 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d (BAYC)_\n\n' +
        '_Send /cancel to abort_',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // Select alert condition (above/below)
    if (data.startsWith('condition_')) {
      const state = userState.get(userId)
      if (!state || !state.alertPrice) {
        await bot.sendMessage(chatId, '❌ Session expired. Start over.', { reply_markup: alertsMenu })
        return
      }
      
      const condition = data.replace('condition_', '') // 'above' or 'below'
      
      // Create the alert
      const result = db.prepare(`
        INSERT INTO floor_alerts 
        (telegram_id, collection_address, collection_name, target_price, condition, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(
        userId,
        state.collection,
        state.collectionName || 'Unknown',
        state.alertPrice,
        condition
      )
      
      const alertId = result.lastInsertRowid
      console.log(`🔔 Created alert #${alertId} for user ${userId}`)
      
      userState.delete(userId)
      
      const symbol = condition === 'below' ? '📉' : '📈'
      await bot.sendMessage(chatId,
        `✅ *Alert Created*\n\n` +
        `📋 Alert #${alertId}\n` +
        `📍 Collection: \`${state.collection.slice(0, 10)}...\`\n` +
        `${symbol} Trigger: ${condition} ${state.alertPrice} ETH\n\n` +
        `You'll be notified when the floor price goes ${condition} ${state.alertPrice} ETH.`,
        { parse_mode: 'Markdown', reply_markup: alertsMenu }
      )
      return
    }

    // List alerts
    if (data === 'alert_list') {
      const alerts = db.prepare(`
        SELECT * FROM floor_alerts 
        WHERE telegram_id = ? AND is_active = 1
        ORDER BY created_at DESC
      `).all(userId)
      
      if (alerts.length === 0) {
        await bot.sendMessage(chatId,
          '🔔 No active alerts.\n\nCreate one to get notified when floors move!',
          { reply_markup: alertsMenu }
        )
        return
      }
      
      let text = '🔔 *Your Floor Alerts*\n\n'
      const buttons = []
      
      for (const alert of alerts) {
        const symbol = alert.condition === 'below' ? '📉' : '📈'
        const short = alert.collection_address.slice(0, 8) + '...'
        text += `#${alert.id} - \`${short}\`\n`
        text += `   ${symbol} ${alert.condition} ${alert.target_price} ETH\n\n`
        buttons.push([{ text: `🗑 Delete #${alert.id}`, callback_data: `alert_delete_${alert.id}` }])
      }
      
      buttons.push([{ text: '🔙 Back', callback_data: 'menu_alerts' }])
      
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
      return
    }

    // Delete alert
    if (data.startsWith('alert_delete_')) {
      const alertId = parseCallbackId(data, 'alert_delete_')
      if (!alertId) {
        await bot.sendMessage(chatId, '❌ Invalid alert.', { reply_markup: alertsMenu })
        return
      }
      db.prepare('UPDATE floor_alerts SET is_active = 0 WHERE id = ? AND telegram_id = ?').run(alertId, userId)
      await bot.sendMessage(chatId, '✅ Alert deleted.', { reply_markup: alertsMenu })
      return
    }

    // ========== SETTINGS MENU ==========
    if (data === 'menu_settings') {
      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const slippageStatus = user?.slippage_enabled ? 'ON' : 'OFF'
      const slippageEmoji = user?.slippage_enabled ? '✅' : '❌'
      const gasBoost = user?.gas_boost || 2
      const skipSimStatus = user?.skip_simulation ? 'ON' : 'OFF'
      const skipSimEmoji = user?.skip_simulation ? '⚡' : '🔍'
      
      await bot.sendMessage(chatId,
        `⚙️ *Settings*\n\n` +
        `📉 *Slippage:* ${slippageEmoji} ${slippageStatus}\n` +
        `⛽ *Gas Boost:* ${gasBoost}x\n` +
        `⏩ *Skip Simulation:* ${skipSimEmoji} ${skipSimStatus}\n\n` +
        `_Slippage: sends 5% extra ETH._\n` +
        `_Gas Boost: multiplies gas for speed._\n` +
        `_Skip Sim: instant mint, no preview._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `📉 Slippage: ${slippageStatus}`, callback_data: 'toggle_slippage' }],
              [{ text: `⛽ Gas Boost: ${gasBoost}x`, callback_data: 'menu_gas_boost' }],
              [{ text: `⏩ Skip Sim: ${skipSimStatus}`, callback_data: 'toggle_skip_sim' }],
              [{ text: '🔙 Back', callback_data: 'menu_main' }]
            ]
          }
        }
      )
      return
    }

    // Gas boost menu
    if (data === 'menu_gas_boost') {
      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const currentBoost = user?.gas_boost || 2
      
      await bot.sendMessage(chatId,
        `⛽ *Gas Boost Settings*\n\n` +
        `Current: *${currentBoost}x*\n\n` +
        `Higher boost = faster inclusion = higher gas cost\n\n` +
        `• 2x - Default, good for most mints\n` +
        `• 5x - Fast, competitive FCFS\n` +
        `• 10x - Turbo, high priority\n` +
        `• 20x - YOLO, max speed`,
        {
          parse_mode: 'Markdown',
          reply_markup: gasBoostMenu
        }
      )
      return
    }

    // Handle gas boost selection
    if (data.startsWith('gas_boost_')) {
      const boost = Number(data.replace('gas_boost_', ''))
      if (![2, 5, 10, 20].includes(boost)) {
        await bot.sendMessage(chatId, '❌ Invalid gas boost option.', { reply_markup: gasBoostMenu })
        return
      }
      db.prepare('UPDATE users SET gas_boost = ? WHERE telegram_id = ?').run(boost, userId)
      
      await bot.sendMessage(chatId,
        `✅ *Gas Boost set to ${boost}x*\n\n` +
        `Your FCFS mints will now use ${boost}x gas price for faster inclusion.\n\n` +
        `⚠️ Higher boost = higher gas fees!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Settings', callback_data: 'menu_settings' }]
            ]
          }
        }
      )
      return
    }

    // Toggle slippage
    if (data === 'toggle_slippage') {
      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const newValue = user?.slippage_enabled ? 0 : 1
      
      db.prepare('UPDATE users SET slippage_enabled = ? WHERE telegram_id = ?').run(newValue, userId)
      
      // Refresh settings menu
      const updatedUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const slippageStatus = updatedUser?.slippage_enabled ? 'ON' : 'OFF'
      const slippageEmoji = updatedUser?.slippage_enabled ? '✅' : '❌'
      const gasBoost = updatedUser?.gas_boost || 2
      const skipSimStatus = updatedUser?.skip_simulation ? 'ON' : 'OFF'
      const skipSimEmoji = updatedUser?.skip_simulation ? '⚡' : '🔍'
      
      await bot.sendMessage(chatId,
        `⚙️ *Settings*\n\n` +
        `📉 *Slippage:* ${slippageEmoji} ${slippageStatus}\n` +
        `⛽ *Gas Boost:* ${gasBoost}x\n` +
        `⏩ *Skip Simulation:* ${skipSimEmoji} ${skipSimStatus}\n\n` +
        `_Slippage: sends 5% extra ETH._\n` +
        `_Gas Boost: multiplies gas for speed._\n` +
        `_Skip Sim: instant mint, no preview._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `📉 Slippage: ${slippageStatus}`, callback_data: 'toggle_slippage' }],
              [{ text: `⛽ Gas Boost: ${gasBoost}x`, callback_data: 'menu_gas_boost' }],
              [{ text: `⏩ Skip Sim: ${skipSimStatus}`, callback_data: 'toggle_skip_sim' }],
              [{ text: '🔙 Back', callback_data: 'menu_main' }]
            ]
          }
        }
      )
      return
    }

    // Toggle skip simulation
    if (data === 'toggle_skip_sim') {
      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const newValue = user?.skip_simulation ? 0 : 1
      
      db.prepare('UPDATE users SET skip_simulation = ? WHERE telegram_id = ?').run(newValue, userId)
      
      // Refresh settings menu
      const updatedUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
      const slippageStatus = updatedUser?.slippage_enabled ? 'ON' : 'OFF'
      const slippageEmoji = updatedUser?.slippage_enabled ? '✅' : '❌'
      const gasBoost = updatedUser?.gas_boost || 2
      const skipSimStatus = updatedUser?.skip_simulation ? 'ON' : 'OFF'
      const skipSimEmoji = updatedUser?.skip_simulation ? '⚡' : '🔍'
      
      const warning = newValue ? '\n\n⚠️ *YOLO MODE ENABLED*\nMints will execute instantly without preview!' : ''
      
      await bot.sendMessage(chatId,
        `⚙️ *Settings*${warning}\n\n` +
        `📉 *Slippage:* ${slippageEmoji} ${slippageStatus}\n` +
        `⛽ *Gas Boost:* ${gasBoost}x\n` +
        `⏩ *Skip Simulation:* ${skipSimEmoji} ${skipSimStatus}\n\n` +
        `_Slippage: sends 5% extra ETH._\n` +
        `_Gas Boost: multiplies gas for speed._\n` +
        `_Skip Sim: instant mint, no preview._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `📉 Slippage: ${slippageStatus}`, callback_data: 'toggle_slippage' }],
              [{ text: `⛽ Gas Boost: ${gasBoost}x`, callback_data: 'menu_gas_boost' }],
              [{ text: `⏩ Skip Sim: ${skipSimStatus}`, callback_data: 'toggle_skip_sim' }],
              [{ text: '🔙 Back', callback_data: 'menu_main' }]
            ]
          }
        }
      )
      return
    }

    // ========== TRENDING MENU ==========
    if (data === 'menu_trending') {
      await bot.sendMessage(chatId, '🔥 Fetching trending collections...')
      
      try {
        const trending = await getTrending()
        
        if (!trending || trending.length === 0) {
          await bot.sendMessage(chatId,
            '⚠️ Could not fetch trending data right now.',
            { reply_markup: mainMenu }
          )
          return
        }
        
        let text = '🔥 *Trending Collections (24h)*\n\n'
        
        for (let i = 0; i < Math.min(trending.length, 10); i++) {
          const c = trending[i]
          const change = c.change24h !== 0 
            ? (c.change24h > 0 ? `+${c.change24h.toFixed(1)}%` : `${c.change24h.toFixed(1)}%`)
            : '0%'
          const changeEmoji = c.change24h > 0 ? '🟢' : c.change24h < 0 ? '🔴' : '⚪'
          
          const floorDisplay = c.floor ? c.floor.toFixed(4) : '?'
          const floorUsdDisplay = c.floorUsd ? ` ($${c.floorUsd.toFixed(0)})` : ''
          const volDisplay = c.volume24h ? c.volume24h.toFixed(2) : '?'
          
          text += `${i + 1}. *${c.name}*\n`
          text += `   Floor: ${floorDisplay} ETH${floorUsdDisplay} ${changeEmoji} ${change}\n`
          text += `   Vol: ${volDisplay} ETH\n\n`
        }
        
        await bot.sendMessage(chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: mainMenu
        })
      } catch (e) {
        console.error('Trending error:', e)
        await bot.sendMessage(chatId,
          '❌ Error fetching trending data.',
          { reply_markup: mainMenu }
        )
      }
      return
    }

    if (data.startsWith('menu_')) {
      await bot.sendMessage(chatId, '❌ That menu action is unavailable. Please return to the main menu.', { reply_markup: mainMenu })
    }
  })
  
  // ========== TEXT MESSAGE HANDLER ==========
  bot.on('message', async (msg) => {
    // Skip commands
    if (msg.text?.startsWith('/')) {
      if (msg.text === '/cancel') {
        userState.delete(msg.from.id)
        await bot.sendMessage(msg.chat.id, 'Cancelled.', { reply_markup: mainMenu })
      }
      return
    }
    
    const userId = msg.from.id
    const chatId = msg.chat.id
    const state = userState.get(userId)
    
    if (!state) return // No active flow
    if (!isPrivateChat(msg)) {
      userState.delete(userId)
      await bot.sendMessage(chatId, '🔐 Sensitive flows are only available in a private chat.')
      return
    }
    if (state.step !== 'enter_code' && !getAuthorizedUser(userId)) {
      userState.delete(userId)
      await bot.sendMessage(chatId, '🔐 Your access has expired. Send /start to request new access.')
      return
    }
    
    // ACCESS CODE: Validate code
    if (state.step === 'enter_code') {
      const now = Date.now()
      const attempt = accessAttempts.get(userId)
      if (attempt && now - attempt.startedAt < ACCESS_WINDOW_MS && attempt.count >= ACCESS_ATTEMPT_LIMIT) {
        await bot.sendMessage(chatId, '⏳ Too many invalid attempts. Try again in 15 minutes.')
        return
      }
      const code = normalizeAccessCode(msg.text)
      
      // Check if code exists, NOT already used, and not expired
      const accessCode = db.prepare(`
        SELECT * FROM access_codes 
        WHERE code = ? AND used_by IS NULL AND expires_at > datetime('now')
      `).get(code)
      
      if (!accessCode) {
        const current = accessAttempts.get(userId)
        const next = current && now - current.startedAt < ACCESS_WINDOW_MS
          ? { startedAt: current.startedAt, count: current.count + 1 }
          : { startedAt: now, count: 1 }
        accessAttempts.set(userId, next)
        await bot.sendMessage(chatId,
          '❌ Invalid, already used, or expired code.\n\n' +
          'Enter a valid access code:',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      // Mark code as used by this user (one-time use)
      const claimed = db.prepare(`
        UPDATE access_codes
        SET used_by = ?, used_at = datetime('now')
        WHERE id = ? AND used_by IS NULL AND expires_at > datetime('now')
      `).run(userId, accessCode.id)
      if (claimed.changes !== 1) {
        await bot.sendMessage(chatId, '❌ That access code was just used or expired. Enter another code:')
        return
      }
      
      // Grant 30 days access from NOW (not code expiry)
      const accessExpires = new Date()
      accessExpires.setDate(accessExpires.getDate() + 30)
      
      db.prepare('UPDATE users SET is_authorized = 1, access_expires = ? WHERE telegram_id = ?').run(accessExpires.toISOString(), userId)
      
      userState.delete(userId)
      accessAttempts.delete(userId)
      
      console.log(`✅ User ${userId} authorized with code ${code}`)
      
      await bot.sendMessage(chatId,
        `✅ *Access Granted!*\n\n` +
        `Welcome to MintHunter, Grindoor! 👋\n\n` +
        `• 🔔 Set floor price alerts\n` +
        `• ⚡ FCFS competitive minting\n` +
        `• 👛 Secure wallet management\n` +
        `• 🔥 Trending collections\n\n` +
        `What would you like to do?`,
        { parse_mode: 'Markdown', reply_markup: mainMenu }
      )
      return
    }
    
    // ALERT: Receiving collection address
    if (state.step === 'alert_collection') {
      const collection = validateAddress(msg.text)
      
      // Validate address
      if (!collection) {
        await bot.sendMessage(chatId,
          '❌ Invalid contract address.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.collection = collection
      state.step = 'alert_price'
      userState.set(userId, state)
      
      // Get ETH price for USD example
      const ethPrice = await getEthPrice()
      const usdExample = ethPrice ? (0.5 * ethPrice).toFixed(0) : 'unavailable'
      
      await bot.sendMessage(chatId,
        '🔔 *Set Target Price*\n\n' +
        'Enter the floor price target:\n\n' +
        '_ETH: 0.5 or 1.25_\n' +
        `_USD: $${usdExample} or $500_\n\n` +
        '_Send /cancel to abort_',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // ALERT: Receiving target price
    if (state.step === 'alert_price') {
      const priceText = msg.text?.trim()
      let price
      let isUsd = false
      
      // Check if USD format ($100 or 100$)
      if (priceText.startsWith('$') || priceText.endsWith('$')) {
        const usdText = priceText.replace(/\$/g, '').trim()
        const usdValue = /^\d+(?:\.\d{1,2})?$/.test(usdText) ? Number(usdText) : NaN
        if (Number.isFinite(usdValue) && usdValue > 0) {
          const ethPrice = await getEthPrice()
          if (ethPrice) price = usdValue / ethPrice
          isUsd = true
        }
      } else {
        const parsedEth = parseEthAmount(priceText, { allowZero: false })
        price = parsedEth ? Number(parsedEth.text) : NaN
      }
      
      if (!Number.isFinite(price) || price <= 0) {
        await bot.sendMessage(chatId,
          '❌ Invalid price. Enter a number (e.g., 0.5 or $500).\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      // Get ETH price for display
      const ethPrice = await getEthPrice()
      const ethDisplay = price.toFixed(4)
      const usdDisplay = ethPrice ? (price * ethPrice).toFixed(2) : 'unavailable'
      
      state.alertPrice = ethDisplay
      state.step = 'alert_condition'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '🔔 *Alert Condition*\n\n' +
        `Target: ${ethDisplay} ETH (~$${usdDisplay})\n\n` +
        'When should you be notified?',
        { parse_mode: 'Markdown', reply_markup: alertCondition }
      )
      return
    }

    // SCHEDULED MINT: Receiving contract address
    if (state.step === 'sched_contract') {
      const contract = validateAddress(msg.text)
      
      if (!contract) {
        await bot.sendMessage(chatId,
          '❌ Invalid contract address.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.contract = contract
      state.step = 'sched_price'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '⏰ *Mint Price*\n\n' +
        'Enter the mint price in ETH (e.g., 0.05)\n\n' +
        'Send `0` for free mints.',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // SCHEDULED MINT: Receiving price
    if (state.step === 'sched_price') {
      const priceText = msg.text?.trim()
      const parsedPrice = parseEthAmount(priceText)
      
      if (!parsedPrice) {
        await bot.sendMessage(chatId,
          '❌ Invalid price. Enter a decimal ETH amount from 0 to 18 decimal places.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.mintPrice = parsedPrice.text
      state.step = 'sched_datetime'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '⏰ *Schedule Time*\n\n' +
        'When should the mint execute?\n\n' +
        'Format: `YYYY-MM-DD HH:MM` (UTC)\n\n' +
        'Examples:\n' +
        '• `2026-05-07 12:00` - May 7th at 12pm UTC\n' +
        '• `2026-05-06 23:30` - Today at 11:30pm UTC\n\n' +
        '_Bot will fire at EXACTLY this time with max speed_',
        { parse_mode: 'Markdown' }
      )
      return
    }

    // SCHEDULED MINT: Receiving datetime
    if (state.step === 'sched_datetime') {
      const datetimeText = msg.text?.trim()
      
      const scheduledDate = parseUtcDateTime(datetimeText)
      if (!scheduledDate) {
        await bot.sendMessage(chatId,
          '❌ Invalid UTC date or format. Use: `YYYY-MM-DD HH:MM`\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      // Check if in the past
      if (scheduledDate <= new Date()) {
        await bot.sendMessage(chatId,
          '❌ Time is in the past. Enter a future time.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      let analysis
      try {
        const provider = await getProvider()
        analysis = await analyzeContract(state.contract, provider)
      } catch (error) {
        await bot.sendMessage(chatId, '❌ Could not verify the contract for safe scheduling. No job was created.', { reply_markup: mintMenu })
        return
      }
      if (!analysis.verified || !analysis.recommendedMint) {
        await bot.sendMessage(chatId, '❌ This contract has no verified, supported mint function. No job was created.', { reply_markup: mintMenu })
        return
      }

      // Create a scheduled FCFS job with the verified ABI function attached.
      const result = db.prepare(`
        INSERT INTO mint_jobs
        (telegram_id, wallet_id, contract_address, mint_function, mint_price, mint_mode, gas_limit, status, scheduled_at)
        VALUES (?, ?, ?, ?, ?, 'fcfs', ?, 'scheduled', ?)
      `).run(
        userId,
        state.walletId,
        state.contract,
        JSON.stringify(analysis.recommendedMint),
        state.mintPrice,
        375000,
        scheduledDate.toISOString()
      )
      
      const jobId = result.lastInsertRowid
      console.log(`⏰ Scheduled mint #${jobId} for ${scheduledDate.toISOString()}`)
      
      userState.delete(userId)
      
      // Get ETH price for USD
      const ethPrice = await getEthPrice()
      const priceUsd = ethPrice ? (parseFloat(state.mintPrice) * ethPrice).toFixed(2) : 'unavailable'
      const feeUsd = ethPrice ? (parseFloat(FCFS_FEE) * ethPrice).toFixed(2) : 'unavailable'
      
      // Format display time
      const displayTime = scheduledDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      const msUntil = scheduledDate - new Date()
      const minsUntil = Math.floor(msUntil / 60000)
      const hoursUntil = Math.floor(minsUntil / 60)
      const timeUntil = hoursUntil > 0 
        ? `${hoursUntil}h ${minsUntil % 60}m`
        : `${minsUntil}m`
      
      await bot.sendMessage(chatId,
        `✅ *Scheduled Mint Created*\n\n` +
        `📋 Job #${jobId}\n` +
        `📍 Contract: \`${state.contract.slice(0, 10)}...\`\n` +
        `💎 Price: ${state.mintPrice} ETH (~$${priceUsd})\n` +
        `⏰ Time: ${displayTime}\n` +
        `⏱ In: ${timeUntil}\n\n` +
        `⚡ Mode: FCFS (Max Speed)\n` +
        `🚀 Gas: Aggressive\n` +
        `💰 Fee: ${FCFS_FEE} ETH (~$${feeUsd})\n\n` +
        `_Bot will fire at EXACTLY the scheduled time._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Cancel Job', callback_data: `mint_cancel_${jobId}` }],
              [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
            ]
          }
        }
      )
      return
    }

    // MINT: Receiving contract address
    if (state.step === 'mint_contract') {
      const contract = validateAddress(msg.text)
      
      // Validate address
      if (!contract) {
        await bot.sendMessage(chatId,
          '❌ Invalid contract address.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.contract = contract
      
      // Analyze contract for mint functions and price
      await bot.sendMessage(chatId, '🔍 Analyzing contract...')
      
      try {
        const provider = await getProvider()
        const analysis = await analyzeContract(contract, provider)
        
        state.contractAnalysis = analysis
        
        let analysisMsg = ''
        if (analysis.verified) {
          analysisMsg = '✅ *Contract Verified*\n\n'
          
          if (analysis.recommendedMint) {
            analysisMsg += `🎯 Detected mint: \`${analysis.recommendedMint.signature}\`\n`
            state.detectedMintFn = analysis.recommendedMint
          }
          
          if (analysis.detectedPrice !== null) {
            const priceEth = ethers.formatEther(analysis.detectedPrice)
            analysisMsg += `💰 Detected price: ${priceEth} ETH\n`
            state.detectedPrice = priceEth
          }
          
          if (analysis.mintFunctions.length > 1) {
            analysisMsg += `\n📋 Found ${analysis.mintFunctions.length} mint functions`
          }
        } else {
          analysisMsg = '❌ *Contract Not Verified*\n\nSafe auto-mint is unavailable for this contract.'
        }
        
        await bot.sendMessage(chatId, analysisMsg, { parse_mode: 'Markdown' })
        if (!analysis.verified || !analysis.recommendedMint) {
          userState.delete(userId)
          await bot.sendMessage(chatId, '❌ Minting was stopped because a verified supported function was not found.', { reply_markup: mintMenu })
          return
        }
        
      } catch (e) {
        console.error('Contract analysis error:', e.message)
        await bot.sendMessage(chatId, '❌ Could not analyze the contract safely. Mint setup has been stopped.', { reply_markup: mintMenu })
        userState.delete(userId)
        return
      }
      
      state.step = 'mint_mode'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '⚡ *Select Mint Mode*\n\n' +
        '• *FCFS* - Broadcast through configured RPCs\n' +
        '• *Normal* - Standard verified transaction',
        { parse_mode: 'Markdown', reply_markup: mintModeMenu }
      )
      return
    }

    // MINT: Receiving mint price
    if (state.step === 'mint_price') {
      const priceText = msg.text?.trim()
      const parsedPrice = parseEthAmount(priceText)
      
      if (!parsedPrice) {
        await bot.sendMessage(chatId,
          '❌ Invalid price. Enter a decimal ETH amount from 0 to 18 decimal places.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.mintPrice = parsedPrice.text
      state.step = 'mint_gas'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '⛽ *Select Gas Priority*\n\n' +
        '• *Aggressive* - +50% gas (fastest)\n' +
        '• *Fast* - +20% gas\n' +
        '• *Normal* - Standard gas',
        { parse_mode: 'Markdown', reply_markup: gasOptions }
      )
      return
    }

    // WALLET: Receiving private key
    if (state.step === 'wallet_key') {
      const wallet = validatePrivateKey(msg.text)
      if (!wallet) {
        await bot.sendMessage(chatId,
          '❌ Invalid private key format.\n\nMust be a valid 64-hex-character key starting with 0x.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      const key = wallet.privateKey
      const address = wallet.address
      
      try {
        // Encrypt and store the validated key
        
        // Encrypt and store
        const encrypted = encryptPrivateKey(key, userId.toString())
        try {
          db.prepare(
            'INSERT INTO wallets (telegram_id, address, encrypted_key, label) VALUES (?, ?, ?, ?)'
          ).run(userId, address, encrypted, 'Wallet')
        } catch (insertError) {
          if (String(insertError.message).toLowerCase().includes('unique')) {
            await bot.sendMessage(chatId, '❌ That wallet is already added.', { reply_markup: walletsMenu })
            return
          }
          throw insertError
        }
        
        // Delete the message with the key for security
        try {
          await bot.deleteMessage(chatId, msg.message_id)
        } catch (e) {
          // May not have permission
        }
        
        userState.delete(userId)
        
        const short = address.slice(0, 6) + '...' + address.slice(-4)
        await bot.sendMessage(chatId,
          `✅ *Wallet Added*\n\n` +
          `Address: \`${short}\`\n\n` +
          `Your key is encrypted and secure.`,
          { parse_mode: 'Markdown', reply_markup: walletsMenu }
        )
      } catch (e) {
        await bot.sendMessage(chatId,
          `❌ Invalid private key: ${e.message}\n\n_Send /cancel to abort_`,
          { parse_mode: 'Markdown' }
        )
      }
      return
    }
  })

  // ========== BACKGROUND SERVICES ==========
  
  // Check floor alerts every 5 minutes
  const ALERT_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
  
  async function runAlertCheck() {
    try {
      const triggered = await checkAlerts(db, bot)
      if (triggered.length > 0) {
        console.log(`🚨 ${triggered.length} alerts triggered`)
      }
    } catch (e) {
      console.error('Alert check error:', e.message)
    }
  }
  
  // Initial check after 30 seconds
  setTimeout(runAlertCheck, 30000)
  
  // Then check every 5 minutes
  setInterval(runAlertCheck, ALERT_CHECK_INTERVAL)

  // ========== SCHEDULED MINT EXECUTOR ==========
  // Check every second for scheduled mints (need precision!)
  const SCHEDULE_CHECK_INTERVAL = 1000 // 1 second
  
  async function executeScheduledMint(job) {
    const chatId = job.telegram_id
    console.log(`🚀 EXECUTING SCHEDULED MINT #${job.id} NOW!`)
    walletLocks.add(job.wallet_id)
    
    try {
      // Get wallet
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND telegram_id = ?').get(job.wallet_id, job.telegram_id)
      if (!wallet) {
        await bot.sendMessage(chatId, `❌ Scheduled mint #${job.id} failed: Wallet not found`)
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', job.id)
        return
      }
      
      bot.sendMessage(chatId, `🚀 *SCHEDULED MINT FIRING NOW!*\n\nJob #${job.id}`, { parse_mode: 'Markdown' }).catch((error) => console.error('Scheduled status notification failed:', error.message))
      
      // Decrypt key
      const privateKey = decryptPrivateKey(wallet.encrypted_key, job.telegram_id.toString())
      
      // Get provider
      // getProvider validates mainnet when selecting or refreshing the cached provider.
      const provider = await getProvider()
      const signer = new ethers.Wallet(privateKey, provider)
      
      // Parallelize network data fetching for minimum latency.
      const [balance, nonce, feeData] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getTransactionCount(wallet.address, 'pending'),
        provider.getFeeData(),
      ])

      const baseMintCost = ethers.parseEther(job.mint_price || '0')
      const userSettings = db.prepare('SELECT slippage_enabled, gas_boost FROM users WHERE telegram_id = ?').get(job.telegram_id)
      const slippageEnabled = userSettings?.slippage_enabled === 1
      const mintCost = slippageEnabled ? baseMintCost + (baseMintCost * 5n / 100n) : baseMintCost
      const fee = ethers.parseEther(FCFS_FEE)
      
      const gasBoost = BigInt(Math.min(Math.max(Number(userSettings?.gas_boost || 2), 1), 20))
      const currentGasPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei')
      const boostedGasPrice = currentGasPrice * gasBoost
      const gasEstimate = BigInt(job.gas_limit) * boostedGasPrice
      const totalNeeded = mintCost + fee + gasEstimate
      
      if (balance < totalNeeded) {
        const ethPrice = await getEthPrice()
        const shortfall = ethers.formatEther(totalNeeded - balance)
        const shortUsd = ethPrice ? (parseFloat(shortfall) * ethPrice).toFixed(2) : 'unavailable'
        const balanceUsd = ethPrice ? (parseFloat(ethers.formatEther(balance)) * ethPrice).toFixed(2) : 'unavailable'
        const neededUsd = ethPrice ? (parseFloat(ethers.formatEther(totalNeeded)) * ethPrice).toFixed(2) : 'unavailable'
        await bot.sendMessage(chatId,
          `❌ *Scheduled Mint #${job.id} Failed*\n\n` +
          `Insufficient balance!\n\n` +
          `💰 Need: ${parseFloat(ethers.formatEther(totalNeeded)).toFixed(4)} ETH (~$${neededUsd})\n` +
          `👛 Have: ${parseFloat(ethers.formatEther(balance)).toFixed(4)} ETH (~$${balanceUsd})\n` +
          `📉 Short: ${parseFloat(shortfall).toFixed(4)} ETH (~$${shortUsd})`,
          { parse_mode: 'Markdown' }
        )
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', job.id)
        return
      }
      
      // Execute mint with max speed.
      bot.sendMessage(chatId, `⚡ Broadcasting mint to all RPCs...`).catch((error) => console.error('Broadcast status notification failed:', error.message))
      
      const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei')) * gasBoost
      const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei')) * gasBoost
      
      // Scheduled jobs must carry verified ABI data created at scheduling time.
      const detectedFn = job.mint_function ? JSON.parse(job.mint_function) : null
      if (!detectedFn) throw new Error('Scheduled job has no verified mint function')
      const mintData = buildMintData(detectedFn, 1, wallet.address)
      if (!mintData || mintData === '0x') throw new Error('Scheduled mint calldata could not be built safely')

      const txData = {
        to: job.contract_address,
        value: mintCost,
        data: mintData,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      }

      // Final on-chain validation before broadcast.
      const [estimatedMintGas] = await Promise.all([
        provider.estimateGas({ ...txData, from: wallet.address }),
        provider.call({ ...txData, from: wallet.address }),
      ])
      txData.gasLimit = estimatedMintGas > BigInt(job.gas_limit) ? estimatedMintGas : BigInt(job.gas_limit)

      const signedTx = await signer.signTransaction(txData)
      const tx = job.mint_mode === 'fcfs'
        ? await fcfsBroadcast(signedTx)
        : await signer.sendTransaction(txData)

      
      db.prepare(`
        UPDATE mint_jobs SET status = 'executing', tx_hash = ?, executed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(tx.hash, job.id)
      
      await bot.sendMessage(chatId,
        `🚀 *TX Broadcast!*\n\n` +
        `TX: \`${tx.hash}\`\n\n` +
        `Waiting for confirmation...`,
        { parse_mode: 'Markdown' }
      )
      
      // Wait for confirmation
      const receipt = await tx.wait()
      
      if (receipt.status === 1) {
        let feeTxHash = null
        if (fee > 0n) {
          try {
            const feeTx = await signer.sendTransaction({ to: FEE_WALLET, value: fee })
            await feeTx.wait(1)
            feeTxHash = feeTx.hash
          } catch (feeError) {
            console.error(`Scheduled fee collection failed for job #${job.id}:`, feeError.message)
          }
        }
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('completed', job.id)
        
        // Generate sell links
        const contractAddr = job.contract_address
        const openseaLink = `https://opensea.io/assets/ethereum/${contractAddr}`
        const blurLink = `https://blur.io/eth/collection/${contractAddr}`
        
        await bot.sendMessage(chatId,
          `✅ *SCHEDULED MINT SUCCESS!*\n\n` +
          `Job #${job.id}\n` +
          `TX: \`${tx.hash}\`\n` +
          `${feeTxHash ? `Fee TX: \`${feeTxHash}\`\n` : ''}` +
          `Gas: ${receipt.gasUsed.toString()}\n\n` +
          `🎉 *List it for sale:*`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🟠 Sell on OpenSea', url: openseaLink }],
                [{ text: '🟣 Sell on Blur', url: blurLink }],
                [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
              ]
            }
          }
        )
      } else {
        db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', job.id)
        await bot.sendMessage(chatId,
          `❌ *Scheduled Mint Failed*\n\n` +
          `TX reverted: \`${tx.hash}\``,
          { parse_mode: 'Markdown' }
        )
      }
      
    } catch (err) {
      console.error(`Scheduled mint #${job.id} error:`, err.message)
      db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('failed', job.id)
      await bot.sendMessage(chatId,
        `❌ *Scheduled Mint #${job.id} Error*\n\n` +
        `${err.message?.slice(0, 200)}`,
        { parse_mode: 'Markdown' }
      )
    } finally {
      walletLocks.delete(job.wallet_id)
    }
  }
  
  async function checkScheduledMints() {
    try {
      const now = new Date()
      
      // Find jobs that should execute now (within 2 second window)
      const jobs = db.prepare(`
        SELECT * FROM mint_jobs 
        WHERE status = 'scheduled' 
        AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at) <= datetime(?)
      `).all(now.toISOString())
      
      for (const job of jobs) {
        // Atomically claim the job before starting asynchronous execution.
        const claimed = db.prepare(`
          UPDATE mint_jobs SET status = 'executing'
          WHERE id = ? AND status = 'scheduled'
        `).run(job.id)
        if (claimed.changes !== 1) continue
        if (walletLocks.has(job.wallet_id)) {
          console.log(`⏳ Skipping scheduled job #${job.id}: Wallet ${job.wallet_id} is locked`)
          db.prepare("UPDATE mint_jobs SET status = 'scheduled' WHERE id = ?").run(job.id)
          continue
        }
        
        // Execute async (don't block the loop)
        executeScheduledMint(job).catch(e => {
          console.error(`Failed to execute scheduled mint #${job.id}:`, e)
        })
      }
      
    } catch (e) {
      console.error('Schedule check error:', e.message)
    }
  }
  
  // Check every second for scheduled mints
  setInterval(checkScheduledMints, SCHEDULE_CHECK_INTERVAL)
  
  console.log('✅ MintHunter ready!')
  console.log('🔔 Floor alerts checking every 5 minutes')
  console.log('⏰ Scheduled mints checking every 1 second')
  
}).catch(err => {
  console.error('❌ Failed to start:', err)
  process.exit(1)
})

// Centralized process and Telegram error handling.
bot.on('polling_error', (error) => console.error('Telegram polling error:', error.message))
bot.on('error', (error) => console.error('Telegram bot error:', error.message))
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error))
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
  process.exitCode = 1
})

// Graceful shutdown
async function shutdown(signal) {
  console.log(`👋 Shutting down after ${signal}...`)
  bot.stopPolling()
  try { db.save() } catch (error) { console.error('Database flush failed:', error.message) }
  process.exit(0)
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
