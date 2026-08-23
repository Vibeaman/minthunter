const { EventEmitter } = require('node:events')
const { Api, longPoll } = require('node-telegram-bot-api')

class TelegramBotAdapter extends EventEmitter {
  constructor(token, { polling = true, api, longPollFn } = {}) {
    super()
    this.api = api || new Api(token)
    this.longPollFn = longPollFn || longPoll
    this.abortController = null
    this.pollingPromise = null
    this.textHandlers = []

    if (polling) void this.startPolling()
  }

  async getMe() {
    return this.api.getMe()
  }

  async sendMessage(chatId, text, options = {}) {
    return this.api.sendMessage({ chat_id: chatId, text, ...options })
  }

  async editMessageText(text, options = {}) {
    return this.api.editMessageText({ text, ...options })
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.api.answerCallbackQuery({ callback_query_id: callbackQueryId, ...options })
  }

  async deleteMessage(chatId, messageId) {
    return this.api.deleteMessage({ chat_id: chatId, message_id: messageId })
  }

  onText(pattern, handler) {
    if (!(pattern instanceof RegExp) || typeof handler !== 'function') {
      throw new TypeError('onText requires a regular expression and a handler function')
    }
    this.textHandlers.push({ pattern, handler })
    return this
  }

  startPolling() {
    if (this.pollingPromise) return this.pollingPromise

    this.abortController = new AbortController()
    const signal = this.abortController.signal
    this.pollingPromise = (async () => {
      try {
        for await (const update of this.longPollFn(
          this.api,
          {
            timeout: 30,
            retry: true,
            onError: (error) => this.emit('polling_error', error),
          },
          signal,
        )) {
          this.dispatchUpdate(update)
        }
      } catch (error) {
        if (!signal.aborted) {
          this.emit('polling_error', error)
          this.emitError(error)
        }
      } finally {
        this.pollingPromise = null
        this.abortController = null
      }
    })()

    return this.pollingPromise
  }

  async stopPolling() {
    if (!this.abortController) return
    this.abortController.abort()
    try {
      await this.pollingPromise
    } catch (error) {
      if (!this.abortController?.signal.aborted) throw error
    }
  }

  dispatchUpdate(update) {
    if (update?.message) {
      const message = update.message
      for (const { pattern, handler } of this.textHandlers) {
        pattern.lastIndex = 0
        const match = pattern.exec(message.text || '')
        if (match) this.callHandler(handler, message, match)
      }
      this.dispatchEvent('message', message)
      return
    }

    if (update?.callback_query) {
      this.dispatchEvent('callback_query', update.callback_query)
    }
  }

  dispatchEvent(eventName, payload) {
    for (const handler of this.listeners(eventName)) {
      this.callHandler(handler, payload)
    }
  }

  callHandler(handler, ...args) {
    Promise.resolve()
      .then(() => handler(...args))
      .catch((error) => this.emitError(error))
  }

  emitError(error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      console.error('Telegram handler error:', error.message)
    }
  }
}

module.exports = { TelegramBotAdapter }
