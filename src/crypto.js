/**
 * Private-key encryption helpers.
 *
 * New records use a versioned AES-256-GCM format with a per-user derived key
 * and authenticated user salt. Legacy three-part records remain decryptable
 * so an existing database can be migrated safely.
 */

const crypto = require('crypto')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const rawEncryptionKey = process.env.ENCRYPTION_KEY || ''
if (!/^[0-9a-fA-F]{64}$/.test(rawEncryptionKey)) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters')
}

const MASTER_KEY = Buffer.from(rawEncryptionKey, 'hex')
const VERSION = 'v2'

function getDerivedKey(salt) {
  const normalizedSalt = String(salt || '')
  if (!normalizedSalt) throw new Error('A user-specific encryption salt is required')
  return crypto.scryptSync(MASTER_KEY, Buffer.from(`minthunter:${normalizedSalt}`), 32, {
    N: 16_384,
    r: 8,
    p: 1,
  })
}

function encryptPrivateKey(privateKey, salt) {
  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    throw new Error('A private key is required')
  }

  const iv = crypto.randomBytes(12)
  const aad = Buffer.from(`minthunter:${String(salt || '')}`)
  const cipher = crypto.createCipheriv('aes-256-gcm', getDerivedKey(salt), iv)
  cipher.setAAD(aad)

  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [VERSION, iv.toString('hex'), encrypted.toString('hex'), tag.toString('hex')].join(':')
}

function decryptPrivateKey(encryptedKey, salt) {
  if (typeof encryptedKey !== 'string') throw new Error('Encrypted key is invalid')

  const parts = encryptedKey.split(':')
  const isVersioned = parts[0] === VERSION
  const [ivHex, encryptedHex, tagHex] = isVersioned ? parts.slice(1) : parts

  if (!ivHex || !encryptedHex || !tagHex) throw new Error('Encrypted key format is invalid')

  const iv = Buffer.from(ivHex, 'hex')
  const encryptedData = Buffer.from(encryptedHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Encrypted key parameters are invalid')

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    isVersioned ? getDerivedKey(salt) : MASTER_KEY,
    iv,
  )
  if (isVersioned) decipher.setAAD(Buffer.from(`minthunter:${String(salt || '')}`))
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8')
}

module.exports = { encryptPrivateKey, decryptPrivateKey }
