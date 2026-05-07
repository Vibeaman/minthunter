/**
 * Generate access codes for MintHunter
 * Usage: node scripts/generate-codes.js [count] [days]
 */

const { initDb } = require('../src/db')
const db = require('../src/db')
const crypto = require('crypto')

async function generateCodes(count = 30, days = 30) {
  await initDb()
  
  const codes = []
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + days)
  
  console.log(`\n🔑 Generating ${count} access codes (valid for ${days} days)\n`)
  console.log(`Expires: ${expiresAt.toISOString().split('T')[0]}\n`)
  console.log('─'.repeat(40))
  
  for (let i = 0; i < count; i++) {
    // Generate code: MH-XXXXXX (6 chars)
    const random = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
    const code = `MH-${random}`
    
    try {
      db.prepare(`
        INSERT INTO access_codes (code, expires_at) VALUES (?, ?)
      `).run(code, expiresAt.toISOString())
      
      codes.push(code)
      console.log(`${i + 1}. ${code}`)
    } catch (e) {
      // Code collision, try again
      i--
      continue
    }
  }
  
  console.log('─'.repeat(40))
  console.log(`\n✅ Generated ${codes.length} codes\n`)
  
  // Save to file too
  const fs = require('fs')
  const path = require('path')
  const filename = `access-codes-${Date.now()}.txt`
  const filepath = path.join(__dirname, '..', filename)
  
  const content = [
    `MintHunter Access Codes`,
    `Generated: ${new Date().toISOString()}`,
    `Expires: ${expiresAt.toISOString()}`,
    ``,
    ...codes,
    ``
  ].join('\n')
  
  fs.writeFileSync(filepath, content)
  console.log(`📁 Saved to: ${filename}\n`)
  
  return codes
}

// Run
const count = parseInt(process.argv[2]) || 30
const days = parseInt(process.argv[3]) || 30
generateCodes(count, days)
