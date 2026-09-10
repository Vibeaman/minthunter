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
  const code = String(value ?? '')
    .trim()
    .replace(/^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D]+$/g, '')
    .trim()
    .toUpperCase()
    // Access codes are generated as uppercase hexadecimal, so these mappings
    // cannot turn one valid generated code into another valid generated code.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  return /^MH-[A-F0-9]{6}$/.test(code) ? code : null
}

function isPrivateChat(msg) {
  return msg?.chat?.type === 'private'
}

function validatePrivateKey(value) {
  let key = String(value ?? '').trim()
  // Be forgiving of a missing "0x" prefix - a bare 64-hex-character key is
  // unambiguous and people commonly copy private keys without the prefix.
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    key = `0x${key}`
  }
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
  let text = String(value ?? '').trim()

  // Be forgiving of extra text people commonly paste alongside the value,
  // e.g. "2026-05-07 12:00 - May 7th at 12pm UTC" (copied from the bot's own
  // example wording) or a trailing "UTC"/"utc" marker. Only the leading
  // `YYYY-MM-DD HH:MM` is meaningful; strip anything after it before
  // validating strictly.
  const leading = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.exec(text)
  if (leading) {
    text = leading[1]
  }

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
