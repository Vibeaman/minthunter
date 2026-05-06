/**
 * Crypto utilities for encrypting/decrypting private keys
 * Uses AES-256-GCM for strong, authenticated encryption
 */

const crypto = require('crypto')

// Ensure an encryption key is set in .env
require('dotenv').config(); // Load .env here
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not set in .env! Please set it for crypto operations.')
  // Fallback for local dev, but MUST be set for production
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); 
}
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // Use buffer directly

/**
 * Encrypts a private key using AES-256-GCM
 * @param {string} privateKey - The private key to encrypt
 * @param {string} salt - A unique salt for each encryption (e.g., user ID or nonce)
 * @returns {string} The encrypted key (IV:Encrypted:Tag)
 */
function encryptPrivateKey(privateKey, salt) {
  // Use a fixed key length for AES-256
  const key = Buffer.from(ENCRYPTION_KEY).slice(0, 32); 
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  // Return IV, encrypted data, and tag, separated by colons
  return `${iv.toString('hex')}:${encrypted}:${tag.toString('hex')}`;
}

/**
 * Decrypts a private key using AES-256-GCM
 * @param {string} encryptedKey - The encrypted key (IV:Encrypted:Tag)
 * @param {string} salt - The unique salt used during encryption
 * @returns {string} The original private key
 */
function decryptPrivateKey(encryptedKey, salt) {
  // Use a fixed key length for AES-256
  const key = Buffer.from(ENCRYPTION_KEY).slice(0, 32);
  const [ivHex, encryptedHex, tagHex] = encryptedKey.split(':');
  
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedData = Buffer.from(encryptedHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

module.exports = {
  encryptPrivateKey,
  decryptPrivateKey
};
