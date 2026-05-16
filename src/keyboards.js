/**
 * Telegram inline keyboard layouts
 */

// Main menu
const mainMenu = {
  inline_keyboard: [
    [{ text: '🔔 Floor Alerts', callback_data: 'menu_alerts' }],
    [{ text: '⚡ Mint', callback_data: 'menu_mint' }],
    [{ text: '👛 Wallets', callback_data: 'menu_wallets' }],
    [{ text: '🔥 Trending', callback_data: 'menu_trending' }],
    [{ text: '⚙️ Settings', callback_data: 'menu_settings' }]
  ]
}

// Settings menu
const settingsMenu = {
  inline_keyboard: [
    [{ text: '📉 Slippage: OFF', callback_data: 'toggle_slippage' }],
    [{ text: '⛽ Gas Boost: 2x', callback_data: 'menu_gas_boost' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }]
  ]
}

// Gas boost menu
const gasBoostMenu = {
  inline_keyboard: [
    [{ text: '2x (Default)', callback_data: 'gas_boost_2' }],
    [{ text: '5x (Fast)', callback_data: 'gas_boost_5' }],
    [{ text: '10x (Turbo)', callback_data: 'gas_boost_10' }],
    [{ text: '20x (YOLO)', callback_data: 'gas_boost_20' }],
    [{ text: '🔙 Back', callback_data: 'menu_settings' }]
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
    [{ text: '⏰ Schedule Mint', callback_data: 'mint_schedule' }],
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
  settingsMenu,
  gasBoostMenu,
  alertsMenu,
  mintMenu,
  walletsMenu,
  mintModeMenu,
  gasOptions,
  alertCondition,
  confirmCancel,
  backToMain
}
