// ============================================================
// MyKinGuard — SQLite Database Layer
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mykinguard.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Registered beacons (the 7 pilot people)
    CREATE TABLE IF NOT EXISTS beacons (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      mac       TEXT,
      uuid      TEXT,
      major     INTEGER DEFAULT 0,
      minor     INTEGER DEFAULT 0,
      name      TEXT NOT NULL,
      role      TEXT DEFAULT 'student',
      created   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(mac, uuid)
    );

    -- Raw scan events from Theengs Bridge
    CREATE TABLE IF NOT EXISTS scan_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway   TEXT NOT NULL DEFAULT 'theengs-bridge',
      mac       TEXT NOT NULL,
      uuid      TEXT,
      major     INTEGER,
      minor     INTEGER,
      rssi      INTEGER,
      txpower   INTEGER,
      distance  REAL,
      model     TEXT,
      raw_data  TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Presence state changes (enter / exit)
    CREATE TABLE IF NOT EXISTS presence_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      mac       TEXT NOT NULL,
      uuid      TEXT,
      event     TEXT NOT NULL,
      rssi      INTEGER,
      distance  REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_scan_mac ON scan_events(mac);
    CREATE INDEX IF NOT EXISTS idx_scan_ts ON scan_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_presence_mac ON presence_events(mac);
    CREATE INDEX IF NOT EXISTS idx_presence_ts ON presence_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_beacons_uuid ON beacons(uuid);
  `);
}

module.exports = { getDb };
