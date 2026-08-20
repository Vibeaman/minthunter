/**
 * Database module using sql.js (pure JS SQLite)
 * No native compilation needed
 */

const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', 'minthunter.db')

let db = null
let initialized = false

async function initDb() {
  if (initialized) return db

  const SQL = await initSqlJs()

  // Load existing db or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
    console.log('💾 Database loaded from disk')
  } else {
    db = new SQL.Database()
    console.log('💾 Creating new database')
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS floor_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      collection_address TEXT NOT NULL,
      collection_name TEXT,
      target_price REAL NOT NULL,
      condition TEXT DEFAULT 'below',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS mint_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      wallet_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      mint_function TEXT,
      mint_price TEXT DEFAULT '0',
      gas_limit INTEGER DEFAULT 250000,
      max_gas_price TEXT,
      mint_mode TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      tx_hash TEXT,
      scheduled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME
    )
  `)

  // Add scheduled_at column if it doesn't exist (migration)
  try {
    db.run('ALTER TABLE mint_jobs ADD COLUMN scheduled_at DATETIME')
  } catch (e) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS whale_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      label TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Access codes table
  db.run(`
    CREATE TABLE IF NOT EXISTS access_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      used_by INTEGER,
      used_at DATETIME,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Add is_authorized column to users (migration)
  try {
    db.run('ALTER TABLE users ADD COLUMN is_authorized INTEGER DEFAULT 0')
  } catch (e) {
    // Column already exists
  }

  // Add slippage_enabled column to users (migration) - default OFF
  try {
    db.run('ALTER TABLE users ADD COLUMN slippage_enabled INTEGER DEFAULT 0')
  } catch (e) {
    // Column already exists
  }

  // Add access_expires column to users (migration)
  try {
    db.run('ALTER TABLE users ADD COLUMN access_expires DATETIME')
  } catch (e) {
    // Column already exists
  }

  // Add gas_boost column to users (migration) - default 2x
  try {
    db.run('ALTER TABLE users ADD COLUMN gas_boost INTEGER DEFAULT 2')
  } catch (e) {
    // Column already exists
  }

  // Add skip_simulation column to users (migration) - default OFF
  try {
    db.run('ALTER TABLE users ADD COLUMN skip_simulation INTEGER DEFAULT 0')
  } catch (e) {
    // Column already exists
  }

  // Keep existing authorization state across restarts. Expiry is checked at use time.
  try {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_address ON wallets(telegram_id, address)')
  } catch (error) {
    console.error(`Wallet uniqueness migration skipped: ${error.message}`)
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_alerts_active_collection ON floor_alerts(is_active, collection_address)')
  db.run('CREATE INDEX IF NOT EXISTS idx_mint_jobs_status_schedule ON mint_jobs(status, scheduled_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_mint_jobs_user_status ON mint_jobs(telegram_id, status)')

  save()

  initialized = true
  console.log('✅ Database initialized')
  return db
}

// Save to disk
function save() {
  if (db) {
    const data = db.export()
    const buffer = Buffer.from(data)
    const tempPath = `${DB_PATH}.tmp`
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, DB_PATH)
  }
}

// Wrapper for sync-style API (matches better-sqlite3 style)
const dbWrapper = {
  prepare: (sql) => ({
    run: (...params) => {
      if (!db) throw new Error('DB not initialized - call initDb() first')
      
      // For INSERTs, we need to get the ID after
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT')
      
      db.run(sql, params)
      save()
      
      let lastId = 0
      if (isInsert) {
        const result = db.exec('SELECT last_insert_rowid() AS id')
        lastId = result[0]?.values?.[0]?.[0] || 0
      }
      
      return { lastInsertRowid: lastId, changes: db.getRowsModified() }
    },
    get: (...params) => {
      if (!db) throw new Error('DB not initialized - call initDb() first')
      const stmt = db.prepare(sql)
      stmt.bind(params)
      if (stmt.step()) {
        const row = stmt.getAsObject()
        stmt.free()
        return row
      }
      stmt.free()
      return undefined
    },
    all: (...params) => {
      if (!db) throw new Error('DB not initialized - call initDb() first')
      const stmt = db.prepare(sql)
      stmt.bind(params)
      const results = []
      while (stmt.step()) {
        results.push(stmt.getAsObject())
      }
      stmt.free()
      return results
    }
  }),
  // Direct exec for raw SQL
  exec: (sql) => {
    if (!db) throw new Error('DB not initialized - call initDb() first')
    db.run(sql)
    save()
  }
}

module.exports = dbWrapper
module.exports.initDb = initDb
module.exports.save = save
