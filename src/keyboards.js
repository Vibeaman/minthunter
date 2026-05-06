/**
 * Telegram inline keyboard layouts
 */

// Main menu
const mainMenu = {
  inline_keyboard: [
    [{ text: '🔔 Floor Alerts', callback_data: 'menu_alerts' }],
    [{ text: '⚡ Mint', callback_data: 'menu_mint' }],
    [{ text: '👛 Wallets', callback_data: 'menu_wallets' }],
    [{ text: '🐋 Whale Watch', callback_data: 'menu_whales' }],
    [{ text: '🔥 Trending', callback_data: 'menu_trending' }]
  ]
}

// Alerts menu
const alertsMenu = {
  inline_keyboard: [
    [{ text: '➕ New Alert', callback_data: 'alert_new' }],
    [{ text: '📋 My Alerts', callback_data: 'alert_list' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }]
  ]
}

// Mint menu
const mintMenu = {
  inline_keyboard: [
    [{ text: '➕ New Mint Job', callback_data: 'mint_new' }],
    [{ text: '⏳ Pending Jobs', callback_data: 'mint_pending' }],
    [{ text: '✅ Completed', callback_data: 'mint_completed' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }]
  ]
}

// Wallets menu
const walletsMenu = {
  inline_keyboard: [
    [{ text: '➕ Add Wallet', callback_data: 'wallet_add' }],
    [{ text: '📋 My Wallets', callback_data: 'wallet_list' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }]
  ]
}

// Whales menu
const whalesMenu = {
  inline_keyboard: [
    [{ text: '➕ Track Wallet', callback_data: 'whale_add' }],
    [{ text: '📋 Watching', callback_data: 'whale_list' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }]
  ]
}

// Mint mode selection
const mintModeMenu = {
  inline_keyboard: [
    [{ text: '⚡ FCFS (Fastest)', callback_data: 'mode_fcfs' }],
    [{ text: '🎯 Snipe (Auto-detect)', callback_data: 'mode_snipe' }],
    [{ text: '🐢 Normal', callback_data: 'mode_normal' }],
    [{ text: '🔙 Back', callback_data: 'menu_mint' }]
  ]
}

// Gas options
const gasOptions = {
  inline_keyboard: [
    [{ text: '🚀 Aggressive (+50%)', callback_data: 'gas_aggressive' }],
    [{ text: '⚡ Fast (+20%)', callback_data: 'gas_fast' }],
    [{ text: '🐢 Normal', callback_data: 'gas_normal' }],
    [{ text: '🔙 Back', callback_data: 'menu_mint' }]
  ]
}

// Alert condition
const alertCondition = {
  inline_keyboard: [
    [{ text: '📉 Below', callback_data: 'condition_below' }],
    [{ text: '📈 Above', callback_data: 'condition_above' }],
    [{ text: '🔙 Back', callback_data: 'menu_alerts' }]
  ]
}

// Confirm/Cancel
const confirmCancel = {
  inline_keyboard: [
    [
      { text: '✅ Confirm', callback_data: 'confirm' },
      { text: '❌ Cancel', callback_data: 'cancel' }
    ]
  ]
}

// Back to main
const backToMain = {
  inline_keyboard: [
    [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
  ]
}

module.exports = {
  mainMenu,
  alertsMenu,
  mintMenu,
  walletsMenu,
  whalesMenu,
  mintModeMenu,
  gasOptions,
  alertCondition,
  confirmCancel,
  backToMain
}
