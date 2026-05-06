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
    fs.writeFileSync(DB_PATH, buffer)
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
        // Extract table name and query max id
        const match = sql.match(/INSERT\s+INTO\s+(\w+)/i)
        if (match) {
          const table = match[1]
          const stmt = db.prepare(`SELECT MAX(id) FROM ${table}`)
          if (stmt.step()) {
            lastId = stmt.get()[0] || 0
          }
          stmt.free()
        }
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
