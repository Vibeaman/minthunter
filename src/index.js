/**
 * MintHunter - NFT Floor Alerts + Auto-Mint Bot
 * Part 6a: Bot setup + /start
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const TelegramBot = require('node-telegram-bot-api')
const { initDb } = require('./db')
const db = require('./db')
const { mainMenu, walletsMenu, mintMenu, mintModeMenu, gasOptions, backToMain } = require('./keyboards')
const { encryptPrivateKey, decryptPrivateKey } = require('./crypto')
const { getProvider, broadcastToAll } = require('./provider')
const { ethers } = require('ethers')

// Fee config
const FEE_WALLET = process.env.FEE_WALLET || '0x1d5dfc070385e6d749707fc94c4af09207d311f9'
const FCFS_FEE = process.env.FCFS_FEE_ETH || '0.0002'

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

// Initialize database then start bot
initDb().then(() => {
  console.log('💾 Database ready')
  
  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    const username = msg.from.username || msg.from.first_name
    
    console.log(`👋 /start from ${username} (${userId})`)
    
    // Ensure user exists
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId)
    if (!existing) {
      db.prepare('INSERT INTO users (telegram_id, username) VALUES (?, ?)').run(userId, username)
      console.log(`✨ New user: ${username}`)
    }
    
    // Clear any pending state
    userState.delete(userId)
    
    await bot.sendMessage(chatId, 
      `🎯 *MintHunter*\n\n` +
      `Welcome ${username}!\n\n` +
      `• 🔔 Set floor price alerts\n` +
      `• ⚡ FCFS competitive minting\n` +
      `• 👛 Secure wallet management\n` +
      `• 🐋 Track whale wallets\n\n` +
      `What would you like to do?`,
      { parse_mode: 'Markdown', reply_markup: mainMenu }
    )
  })

  // Handle menu navigation
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id
    const userId = query.from.id
    const data = query.data
    
    console.log(`📥 Button: ${data} from ${userId}`)
    
    // Acknowledge button press
    await bot.answerCallbackQuery(query.id)
    
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
      const walletId = parseInt(data.split('_')[2])
      db.prepare('DELETE FROM wallets WHERE id = ? AND telegram_id = ?').run(walletId, userId)
      await bot.sendMessage(chatId, '✅ Wallet deleted.', { reply_markup: walletsMenu })
      return
    }

    // ========== MINT MENU ==========
    if (data === 'menu_mint') {
      userState.delete(userId)
      await bot.editMessageText(
        '⚡ *Minting*\n\n' +
        'Create mint jobs to auto-mint NFTs.\n\n' +
        '• *FCFS* - Fastest, multi-RPC broadcast\n' +
        '• *Snipe* - Watch mempool, auto-execute\n' +
        '• *Normal* - Standard mint',
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
      const walletId = parseInt(data.split('_')[2])
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
      
      const mode = data.replace('mode_', '') // fcfs, snipe, or normal
      state.mode = mode
      state.step = 'mint_price'
      userState.set(userId, state)
      
      let modeText = mode === 'fcfs' ? '⚡ FCFS' : mode === 'snipe' ? '🎯 Snipe' : '🐢 Normal'
      
      await bot.sendMessage(chatId,
        `⚡ *Mint Mode: ${modeText}*\n\n` +
        `Send the mint price in ETH (e.g., 0.05)\n\n` +
        `Send \`0\` for free mints.`,
        { parse_mode: 'Markdown' }
      )
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
      
      const result = db.prepare(`
        INSERT INTO mint_jobs 
        (telegram_id, wallet_id, contract_address, mint_price, mint_mode, gas_limit, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        userId,
        state.walletId,
        state.contract,
        state.mintPrice,
        state.mode,
        Math.floor(250000 * gasMultiplier)
      )
      
      const jobId = result.lastInsertRowid
      console.log(`✨ Created mint job #${jobId} for user ${userId}`)
      
      userState.delete(userId)
      
      const feeNote = state.mode !== 'normal' 
        ? `\n\n💰 Fee: ${FCFS_FEE} ETH (paid on execution)`
        : ''
      
      await bot.sendMessage(chatId,
        `✅ *Mint Job Created*\n\n` +
        `📋 Job #${jobId}\n` +
        `📍 Contract: \`${state.contract.slice(0, 10)}...\`\n` +
        `💎 Price: ${state.mintPrice} ETH\n` +
        `⚡ Mode: ${state.mode.toUpperCase()}\n` +
        `⛽ Gas: ${gasLevel}${feeNote}`,
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
      return
    }

    // Execute mint
    if (data.startsWith('mint_execute_')) {
      const jobId = parseInt(data.split('_')[2])
      const job = db.prepare('SELECT * FROM mint_jobs WHERE id = ? AND telegram_id = ?').get(jobId, userId)
      
      if (!job) {
        await bot.sendMessage(chatId, '❌ Job not found.', { reply_markup: mintMenu })
        return
      }
      
      if (job.status !== 'pending') {
        await bot.sendMessage(chatId, `❌ Job already ${job.status}.`, { reply_markup: mintMenu })
        return
      }
      
      // Get wallet
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(job.wallet_id)
      if (!wallet) {
        await bot.sendMessage(chatId, '❌ Wallet not found.', { reply_markup: mintMenu })
        return
      }
      
      await bot.sendMessage(chatId, '⏳ Preparing mint transaction...')
      
      try {
        // Decrypt private key
        const privateKey = decryptPrivateKey(wallet.encrypted_key, userId.toString())
        
        // Get provider
        const provider = await getProvider()
        const signer = new ethers.Wallet(privateKey, provider)
        
        // Check balance
        const balance = await provider.getBalance(wallet.address)
        const mintCost = ethers.parseEther(job.mint_price || '0')
        const fee = job.mint_mode !== 'normal' ? ethers.parseEther(FCFS_FEE) : 0n
        const gasEstimate = BigInt(job.gas_limit) * ethers.parseUnits('50', 'gwei') // rough estimate
        const totalNeeded = mintCost + fee + gasEstimate
        
        if (balance < totalNeeded) {
          const shortfall = ethers.formatEther(totalNeeded - balance)
          await bot.sendMessage(chatId,
            `❌ *Insufficient Balance*\n\n` +
            `Need: ~${ethers.formatEther(totalNeeded)} ETH\n` +
            `Have: ${ethers.formatEther(balance)} ETH\n` +
            `Short: ${shortfall} ETH`,
            { parse_mode: 'Markdown', reply_markup: mintMenu }
          )
          return
        }
        
        // Pay fee first if FCFS/Snipe
        if (job.mint_mode !== 'normal' && fee > 0n) {
          await bot.sendMessage(chatId, `💰 Paying ${FCFS_FEE} ETH fee...`)
          
          const feeTx = await signer.sendTransaction({
            to: FEE_WALLET,
            value: fee
          })
          await feeTx.wait()
          console.log(`💰 Fee paid: ${feeTx.hash}`)
        }
        
        // Build mint transaction
        await bot.sendMessage(chatId, '🔨 Building mint transaction...')
        
        // Try common mint functions
        const mintFunctions = [
          'mint()',
          'mint(uint256)',
          'publicMint()',
          'publicMint(uint256)',
          'mintNFT()',
          'mintNFT(uint256)'
        ]
        
        const contract = new ethers.Contract(
          job.contract_address,
          mintFunctions.map(fn => `function ${fn} payable`),
          signer
        )
        
        let tx
        let success = false
        
        for (const fn of mintFunctions) {
          try {
            const fnName = fn.split('(')[0]
            const hasParam = fn.includes('uint256')
            
            if (hasParam) {
              tx = await contract[fnName](1, { 
                value: mintCost,
                gasLimit: job.gas_limit
              })
            } else {
              tx = await contract[fnName]({ 
                value: mintCost,
                gasLimit: job.gas_limit
              })
            }
            success = true
            break
          } catch (e) {
            continue
          }
        }
        
        if (!success) {
          // Try raw call as fallback
          tx = await signer.sendTransaction({
            to: job.contract_address,
            value: mintCost,
            gasLimit: job.gas_limit,
            data: '0x' // empty data for fallback mint
          })
        }
        
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
          db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ?').run('completed', jobId)
          await bot.sendMessage(chatId,
            `✅ *Mint Successful!*\n\n` +
            `TX: \`${tx.hash}\`\n` +
            `Gas Used: ${receipt.gasUsed.toString()}\n\n` +
            `🎉 Check your wallet for the NFT!`,
            { parse_mode: 'Markdown', reply_markup: mainMenu }
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
        await bot.sendMessage(chatId,
          `❌ *Mint Error*\n\n` +
          `${err.message?.slice(0, 200) || 'Unknown error'}`,
          { parse_mode: 'Markdown', reply_markup: mintMenu }
        )
      }
      return
    }

    // Cancel mint job
    if (data.startsWith('mint_cancel_')) {
      const jobId = parseInt(data.split('_')[2])
      db.prepare('UPDATE mint_jobs SET status = ? WHERE id = ? AND telegram_id = ?').run('cancelled', jobId, userId)
      await bot.sendMessage(chatId, '✅ Job cancelled.', { reply_markup: mintMenu })
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
          { text: `🚀 Execute #${job.id}`, callback_data: `mint_execute_${job.id}` },
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

    // Placeholder for other menus
    if (data.startsWith('menu_')) {
      await bot.sendMessage(chatId, `📋 ${data} - Coming in next part!`)
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
    
    // MINT: Receiving contract address
    if (state.step === 'mint_contract') {
      const contract = msg.text?.trim()
      
      // Validate address
      if (!contract || !ethers.isAddress(contract)) {
        await bot.sendMessage(chatId,
          '❌ Invalid contract address.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.contract = contract
      state.step = 'mint_mode'
      userState.set(userId, state)
      
      await bot.sendMessage(chatId,
        '⚡ *Select Mint Mode*\n\n' +
        '• *FCFS* - Multi-RPC broadcast, fastest\n' +
        '• *Snipe* - Watch mempool, auto-execute\n' +
        '• *Normal* - Standard transaction',
        { parse_mode: 'Markdown', reply_markup: mintModeMenu }
      )
      return
    }

    // MINT: Receiving mint price
    if (state.step === 'mint_price') {
      const priceText = msg.text?.trim()
      const price = parseFloat(priceText)
      
      if (isNaN(price) || price < 0) {
        await bot.sendMessage(chatId,
          '❌ Invalid price. Enter a number (e.g., 0.05 or 0).\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      state.mintPrice = priceText
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
      const key = msg.text?.trim()
      
      // Validate private key
      if (!key || !key.startsWith('0x') || key.length !== 66) {
        await bot.sendMessage(chatId,
          '❌ Invalid private key format.\n\nMust be 64 hex chars starting with 0x.\n\n_Send /cancel to abort_',
          { parse_mode: 'Markdown' }
        )
        return
      }
      
      try {
        // Derive address from key
        const wallet = new ethers.Wallet(key)
        const address = wallet.address
        
        // Encrypt and store
        const encrypted = encryptPrivateKey(key, userId.toString())
        db.prepare(
          'INSERT INTO wallets (telegram_id, address, encrypted_key, label) VALUES (?, ?, ?, ?)'
        ).run(userId, address, encrypted, 'Wallet')
        
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

  console.log('✅ MintHunter ready!')
  
}).catch(err => {
  console.error('❌ Failed to start:', err)
  process.exit(1)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('👋 Shutting down...')
  bot.stopPolling()
  process.exit(0)
})
