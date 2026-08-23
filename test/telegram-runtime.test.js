const test = require('node:test')
const assert = require('node:assert/strict')
const { TelegramBotAdapter } = require('../src/telegram-adapter')

function createFakeApi() {
  const calls = []
  return {
    calls,
    getMe: async () => ({ id: 1, username: 'mint_hunter_test_bot' }),
    sendMessage: async (params) => { calls.push(['sendMessage', params]); return params },
    editMessageText: async (params) => { calls.push(['editMessageText', params]); return params },
    answerCallbackQuery: async (params) => { calls.push(['answerCallbackQuery', params]); return true },
    deleteMessage: async (params) => { calls.push(['deleteMessage', params]); return true },
  }
}

test('Telegram adapter preserves the bot operations used by Mint Hunter', async () => {
  const api = createFakeApi()
  const bot = new TelegramBotAdapter('test-token', { polling: false, api })

  assert.equal((await bot.getMe()).username, 'mint_hunter_test_bot')
  await bot.sendMessage(7, 'hello', { parse_mode: 'Markdown' })
  await bot.editMessageText('updated', { chat_id: 7, message_id: 9 })
  await bot.answerCallbackQuery('callback-id', { text: 'done' })
  await bot.deleteMessage(7, 9)

  assert.deepEqual(api.calls, [
    ['sendMessage', { chat_id: 7, text: 'hello', parse_mode: 'Markdown' }],
    ['editMessageText', { chat_id: 7, message_id: 9, text: 'updated' }],
    ['answerCallbackQuery', { callback_query_id: 'callback-id', text: 'done' }],
    ['deleteMessage', { chat_id: 7, message_id: 9 }],
  ])
})

test('Telegram adapter dispatches legacy message, command, and callback handlers', async () => {
  const bot = new TelegramBotAdapter('test-token', { polling: false, api: createFakeApi() })
  const received = []

  bot.onText(/^\/start$/, (message, match) => received.push(['command', message.chat.id, match[0]]))
  bot.on('message', (message) => received.push(['message', message.text]))
  bot.on('callback_query', (query) => received.push(['callback', query.data]))

  bot.dispatchUpdate({ message: { chat: { id: 7 }, text: '/start' } })
  bot.dispatchUpdate({ callback_query: { data: 'menu_main' } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(received, [
    ['command', 7, '/start'],
    ['message', '/start'],
    ['callback', 'menu_main'],
  ])
})
