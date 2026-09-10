/**
 * Database module using sql.js (pure JS SQLite)
 * No native compilation needed
 */

const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
const { DEFAULT_CHAIN } = require('./chains')

function resolveDbPath(env = process.env) {
  const directory = env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..')
  return path.join(directory, 'minthunter.db')
}

const DB_PATH = resolveDbPath()

let db = null
let SQL = null
let initialized = false
let diskFingerprint = null

function getDiskFingerprint() {
  try {
    const stat = fs.statSync(DB_PATH)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

function refreshFromDiskIfChanged() {
  if (!db || !SQL || !fs.existsSync(DB_PATH)) return false

  const currentFingerprint = getDiskFingerprint()
  if (!currentFingerprint || currentFingerprint === diskFingerprint) return false

  const buffer = fs.readFileSync(DB_PATH)
  db.close?.()
  db = new SQL.Database(buffer)
  diskFingerprint = currentFingerprint
  console.log('💾 Database refreshed from disk')
  return true
}

function reconcileInterruptedAccessCodeClaims() {
  if (!db) return 0

  db.run(`
    UPDATE users
    SET
      is_authorized = 1,
      access_expires = (
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime(access_codes.used_at, '+30 days'))
        FROM access_codes
        WHERE access_codes.used_by = users.telegram_id
        ORDER BY access_codes.used_at DESC
        LIMIT 1
      )
    WHERE (users.is_authorized IS NULL OR users.is_authorized = 0)
      AND EXISTS (
        SELECT 1
        FROM access_codes
        WHERE access_codes.used_by = users.telegram_id
      )
  `)

  return db.getRowsModified()
}

async function initDb() {
  if (initialized) return db

  SQL = await initSqlJs()
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

  // Load existing db or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
    diskFingerprint = getDiskFingerprint()
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

  // Multi-chain support (Phase 2): every wallet, alert, and mint job belongs
  // to a chain from src/chains.js. Existing rows predate chain selection, so
  // they migrate to 'ethereum' - MintHunter's only chain before this change.
  try {
    db.run(`ALTER TABLE wallets ADD COLUMN chain TEXT NOT NULL DEFAULT '${DEFAULT_CHAIN}'`)
  } catch (e) {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE floor_alerts ADD COLUMN chain TEXT NOT NULL DEFAULT '${DEFAULT_CHAIN}'`)
  } catch (e) {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE mint_jobs ADD COLUMN chain TEXT NOT NULL DEFAULT '${DEFAULT_CHAIN}'`)
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
  db.run('CREATE INDEX IF NOT EXISTS idx_wallets_user_chain ON wallets(telegram_id, chain)')
  db.run('CREATE INDEX IF NOT EXISTS idx_alerts_user_chain ON floor_alerts(telegram_id, chain)')
  db.run('CREATE INDEX IF NOT EXISTS idx_mint_jobs_user_chain ON mint_jobs(telegram_id, chain)')

  const recoveredClaims = reconcileInterruptedAccessCodeClaims()
  if (recoveredClaims > 0) {
    console.log(`🔐 Restored ${recoveredClaims} access-code authorization(s) after an interrupted claim response`)
  }

  save()

  initialized = true
  console.log('✅ Database initialized')
  return db
}

// Save to disk
function save() {
  if (db) {
    refreshFromDiskIfChanged()
    const data = db.export()
    const buffer = Buffer.from(data)
    const tempPath = `${DB_PATH}.tmp`
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, DB_PATH)
    diskFingerprint = getDiskFingerprint()
  }
}

// Wrapper for sync-style API (matches better-sqlite3 style)
const dbWrapper = {
  prepare: (sql) => ({
    run: (...params) => {
      if (!db) throw new Error('DB not initialized - call initDb() first')
      refreshFromDiskIfChanged()
      
      // For INSERTs, we need to get the ID after
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT')
      
      db.run(sql, params)
      const changes = db.getRowsModified()
      save()
      
      let lastId = 0
      if (isInsert) {
        const result = db.exec('SELECT last_insert_rowid() AS id')
        lastId = result[0]?.values?.[0]?.[0] || 0
      }
      
      return { lastInsertRowid: lastId, changes }
    },
    get: (...params) => {
      if (!db) throw new Error('DB not initialized - call initDb() first')
      refreshFromDiskIfChanged()
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
      refreshFromDiskIfChanged()
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
    refreshFromDiskIfChanged()
    db.run(sql)
    save()
  }
}

module.exports = dbWrapper
module.exports.initDb = initDb
module.exports.save = save
module.exports.resolveDbPath = resolveDbPath
module.exports.refreshFromDiskIfChanged = refreshFromDiskIfChanged
module.exports.reconcileInterruptedAccessCodeClaims = reconcileInterruptedAccessCodeClaims
