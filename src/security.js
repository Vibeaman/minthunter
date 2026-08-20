const { ethers } = require('ethers')

function parseCallbackId(data, prefix) {
  if (typeof data !== 'string' || !data.startsWith(prefix)) return null
  const raw = data.slice(prefix.length)
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseEthAmount(value, { allowZero = true } = {}) {
  const text = String(value ?? '').trim()
  if (!/^(?:\d+|\d+\.\d{1,18}|\.\d{1,18})$/.test(text)) return null
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) return null
  try {
    return { text, wei: ethers.parseEther(text) }
  } catch {
    return null
  }
}

function normalizeAccessCode(value) {
  const code = String(value ?? '').trim().toUpperCase()
  return /^MH-[A-F0-9]{6}$/.test(code) ? code : null
}

function isPrivateChat(msg) {
  return msg?.chat?.type === 'private'
}

function validatePrivateKey(value) {
  const key = String(value ?? '').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null
  try {
    return new ethers.Wallet(key)
  } catch {
    return null
  }
}

function validateAddress(value) {
  const address = String(value ?? '').trim()
  return ethers.isAddress(address) ? ethers.getAddress(address) : null
}

function parseUtcDateTime(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(text)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0))
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute)
  ) return null
  return date
}

module.exports = {
  isPrivateChat,
  normalizeAccessCode,
  parseCallbackId,
  parseEthAmount,
  parseUtcDateTime,
  validateAddress,
  validatePrivateKey,
}
