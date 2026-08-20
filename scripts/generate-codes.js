/**
 * Generate MintHunter access codes.
 * Usage: node scripts/generate-codes.js [count] [days]
 * Codes are printed to stdout only; they are never written into the repository.
 */

const crypto = require('crypto')
const { initDb } = require('../src/db')
const db = require('../src/db')

async function generateCodes(count = 30, days = 30) {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new Error('count must be an integer between 1 and 10000')
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('days must be an integer between 1 and 3650')
  }

  await initDb()
  const codes = []
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  while (codes.length < count) {
    const code = `MH-${crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`
    try {
      db.prepare('INSERT INTO access_codes (code, expires_at) VALUES (?, ?)').run(code, expiresAt.toISOString())
      codes.push(code)
    } catch (error) {
      if (!String(error.message).toLowerCase().includes('unique')) throw error
    }
  }

  console.log(`Expires: ${expiresAt.toISOString()}`)
  console.log(codes.join('\n'))
  return codes
}

const count = Number(process.argv[2] || 30)
const days = Number(process.argv[3] || 30)
generateCodes(count, days).catch((error) => {
  console.error(`Code generation failed: ${error.message}`)
  process.exitCode = 1
})
