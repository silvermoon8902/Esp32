// ============================================================
// MyKinGuard — Presence Detection Engine v2.1
// ============================================================
//
// Fixes from real-world testing:
// - Increased EXIT_TIMEOUT to 90s (Theengs Bridge scan gaps)
// - MAC normalization (strip spaces, ensure colons)
// - Lookup by both MAC and UUID for flexible registration
// - Discovery mode: track ALL recent devices for registration UI
// - Null RSSI handling
// ============================================================

const { getDb } = require('./database');

// --- Tunable parameters ---
const ENTER_RSSI        = parseInt(process.env.ENTER_RSSI || '-75');
const STRONG_ENTER_RSSI = parseInt(process.env.STRONG_ENTER_RSSI || '-68');
const EXIT_RSSI         = parseInt(process.env.EXIT_RSSI || '-82');
const IGNORE_RSSI       = parseInt(process.env.IGNORE_RSSI || '-85');
const EXIT_TIMEOUT_MS   = parseInt(process.env.EXIT_TIMEOUT_MS || '180000');
const ENTER_WINDOW_MS   = parseInt(process.env.ENTER_WINDOW_MS || '8000');
const ENTER_MIN_HITS    = parseInt(process.env.ENTER_MIN_HITS || '2');
const SMOOTHING_FACTOR  = parseFloat(process.env.SMOOTHING_FACTOR || '0.4');

// In-memory state
const presenceState = new Map();

// Discovery: track ALL recently seen devices (for registration UI)
// mac -> { lastSeen, rssi, uuid, model, count }
const discoveryState = new Map();
const DISCOVERY_TTL_MS = 300000; // 5 minutes

// Callback for presence change events
let onPresenceChange = null;

function setPresenceCallback(cb) {
  onPresenceChange = cb;
}

// --- MAC normalization ---
function normalizeMac(raw) {
  if (!raw) return '';
  // Strip all non-hex characters, lowercase, then format as xx:xx:xx:xx:xx:xx
  const hex = raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (hex.length !== 12) return hex; // return as-is if not valid MAC length
  return hex.match(/.{2}/g).join(':');
}

// --- Registered beacons cache ---
let beaconCache = null;
let beaconCacheTime = 0;
const CACHE_TTL_MS = 5000;

function getRegisteredBeacons() {
  const now = Date.now();
  if (beaconCache && (now - beaconCacheTime) < CACHE_TTL_MS) return beaconCache;
  const db = getDb();
  const rows = db.prepare('SELECT * FROM beacons').all();
  beaconCache = new Map();
  for (const b of rows) {
    if (b.mac) {
      const normalizedMac = normalizeMac(b.mac);
      beaconCache.set(`mac:${normalizedMac}`, b);
    }
    if (b.uuid) {
      beaconCache.set(`uuid:${b.uuid.toLowerCase()}:${b.major || 0}:${b.minor || 0}`, b);
    }
  }
  beaconCacheTime = now;
  return beaconCache;
}

/**
 * Look up registered beacon by trying multiple key strategies.
 * IMPORTANT: Always returns MAC-based key when registered by MAC,
 * even if the beacon also broadcasts UUID. This prevents dual-key
 * flapping when Feasycom beacons alternate between iBeacon and
 * generic BLE advertisements.
 */
function lookupRegistered(mac, data) {
  const beacons = getRegisteredBeacons();

  // Try MAC first — this is the primary identifier for our registered beacons
  const macKey = `mac:${mac}`;
  const byMac = beacons.get(macKey);
  if (byMac) return { beacon: byMac, key: macKey };

  // Fall back to UUID key (for beacons registered by UUID)
  if (data.uuid) {
    const uuidKey = `uuid:${data.uuid.toLowerCase()}:${data.major || 0}:${data.minor || 0}`;
    const byUuid = beacons.get(uuidKey);
    if (byUuid) return { beacon: byUuid, key: uuidKey };
  }

  return null;
}

/**
 * Get device key — prefer UUID for iBeacon, fall back to MAC
 */
function getDeviceKey(mac, data) {
  if (data.uuid) {
    return `uuid:${data.uuid.toLowerCase()}:${data.major || 0}:${data.minor || 0}`;
  }
  return `mac:${mac}`;
}

/**
 * Smooth RSSI using exponential moving average
 */
function smoothRssi(previous, current) {
  if (previous === null || previous === undefined || isNaN(previous)) return current;
  if (current === null || current === undefined || isNaN(current)) return previous;
  return (1 - SMOOTHING_FACTOR) * previous + SMOOTHING_FACTOR * current;
}

/**
 * Process a single BLE device message from Theengs Bridge
 */
function processTheengsMessage(topicDeviceId, data) {
  const mac = normalizeMac(data.id || topicDeviceId || '');
  const rawRssi = typeof data.rssi === 'number' ? data.rssi : null;

  // Hard ignore: no RSSI or too weak
  if (rawRssi === null || rawRssi < IGNORE_RSSI) return;

  const now = Date.now();
  const nowDate = new Date(now);
  const db = getDb();

  // --- Discovery layer: track ALL devices ---
  const discoveryKey = mac;
  const prevDiscovery = discoveryState.get(discoveryKey);
  discoveryState.set(discoveryKey, {
    mac,
    uuid: data.uuid || (prevDiscovery ? prevDiscovery.uuid : ''),
    major: data.major || 0,
    minor: data.minor || 0,
    rssi: rawRssi,
    model: data.model_id || data.model || 'unknown',
    brand: data.brand || '',
    lastSeen: now,
    count: (prevDiscovery ? prevDiscovery.count : 0) + 1
  });

  // --- Raw layer: store scan (throttled — max 1 per device per 10s) ---
  const scanKey = `scan:${mac}`;
  const lastScanWrite = discoveryState.get(scanKey);
  if (!lastScanWrite || (now - lastScanWrite) > 10000) {
    discoveryState.set(scanKey, now);
    db.prepare(`
      INSERT INTO scan_events (gateway, mac, uuid, major, minor, rssi, txpower, distance, model, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'theengs-bridge', mac,
      data.uuid || null, data.major || null, data.minor || null,
      rawRssi, data.txpower || null, data.distance || null,
      data.model_id || data.model || 'unknown',
      JSON.stringify(data)
    );
  }

  // --- Presence layer: only for registered beacons ---
  const match = lookupRegistered(mac, data);
  if (!match) return;

  const { beacon: registered, key: deviceKey } = match;

  // Get or create state
  let state = presenceState.get(deviceKey);
  if (!state) {
    state = {
      mac,
      uuid: data.uuid || '',
      major: data.major || 0,
      minor: data.minor || 0,
      name: registered.name,
      role: registered.role,
      smoothedRssi: rawRssi,
      rawRssi,
      txpower: data.txpower || null,
      distance: data.distance || null,
      model: data.model_id || data.model || 'unknown',
      brand: data.brand || '',
      present: false,
      lastSeen: now,
      lastValidSignal: now,
      recentHits: [],
      deviceKey
    };
  }

  // Update smoothed RSSI
  state.smoothedRssi = smoothRssi(state.smoothedRssi, rawRssi);
  state.rawRssi = rawRssi;
  state.lastSeen = now;
  state.txpower = data.txpower || state.txpower;
  state.distance = data.distance || state.distance;
  state.name = registered.name;
  state.role = registered.role;
  if (data.uuid) state.uuid = data.uuid;

  // Track recent valid hits within the enter window
  if (state.smoothedRssi >= ENTER_RSSI) {
    state.recentHits.push({ ts: now, rssi: state.smoothedRssi });
  }
  state.recentHits = state.recentHits.filter(h => (now - h.ts) <= ENTER_WINDOW_MS);

  // --- ENTER logic ---
  if (!state.present) {
    let shouldEnter = false;

    // Rule 1: strong single reading
    if (state.smoothedRssi >= STRONG_ENTER_RSSI) {
      shouldEnter = true;
    }

    // Rule 2: multiple valid readings within the window
    if (state.recentHits.length >= ENTER_MIN_HITS) {
      shouldEnter = true;
    }

    if (shouldEnter) {
      state.present = true;
      state.recentHits = [];
      state.lastValidSignal = now;

      db.prepare(
        'INSERT INTO presence_events (mac, uuid, event, rssi, distance) VALUES (?, ?, ?, ?, ?)'
      ).run(mac, data.uuid || null, 'enter', Math.round(state.smoothedRssi), state.distance);

      if (onPresenceChange) {
        onPresenceChange({
          event: 'enter',
          mac,
          uuid: data.uuid || '',
          name: state.name,
          role: state.role,
          rssi: Math.round(state.smoothedRssi),
          distance: state.distance,
          model: state.model,
          timestamp: nowDate.toISOString()
        });
      }
    }
  }

  // --- While present: update last valid signal time ---
  if (state.present && state.smoothedRssi >= EXIT_RSSI) {
    state.lastValidSignal = now;
  }

  presenceState.set(deviceKey, state);
}

/**
 * Check for devices that should exit.
 * Exit when no valid signal (above EXIT_RSSI) for EXIT_TIMEOUT_MS.
 */
function checkAbsence() {
  const db = getDb();
  const now = Date.now();

  for (const [deviceKey, state] of presenceState.entries()) {
    if (!state.present) continue;

    const lastValid = state.lastValidSignal || state.lastSeen;
    const elapsed = now - lastValid;

    if (elapsed >= EXIT_TIMEOUT_MS) {
      state.present = false;
      state.recentHits = [];
      presenceState.set(deviceKey, state);

      db.prepare(
        'INSERT INTO presence_events (mac, uuid, event, rssi, distance) VALUES (?, ?, ?, ?, ?)'
      ).run(state.mac, state.uuid || null, 'exit', Math.round(state.smoothedRssi), state.distance);

      if (onPresenceChange) {
        onPresenceChange({
          event: 'exit',
          mac: state.mac,
          uuid: state.uuid || '',
          name: state.name,
          role: state.role,
          rssi: Math.round(state.smoothedRssi),
          distance: state.distance,
          model: state.model,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  // Clean up old discovery entries
  for (const [key, entry] of discoveryState.entries()) {
    if (typeof entry === 'object' && entry.lastSeen && (now - entry.lastSeen) > DISCOVERY_TTL_MS) {
      discoveryState.delete(key);
    }
  }
}

/**
 * Get current presence snapshot — registered beacons only
 */
function getPresenceSnapshot() {
  const result = [];
  for (const [deviceKey, state] of presenceState.entries()) {
    result.push({
      deviceKey,
      mac: state.mac,
      uuid: state.uuid,
      major: state.major,
      minor: state.minor,
      name: state.name,
      role: state.role,
      rssi: Math.round(state.smoothedRssi),
      rawRssi: state.rawRssi,
      txpower: state.txpower,
      distance: state.distance,
      model: state.model,
      brand: state.brand,
      present: state.present,
      lastSeen: new Date(state.lastSeen).toISOString()
    });
  }
  return result.sort((a, b) => (a.present === b.present ? 0 : a.present ? -1 : 1));
}

/**
 * Get all recently discovered BLE devices (for registration)
 */
function getDiscoverySnapshot() {
  const result = [];
  const beacons = getRegisteredBeacons();
  for (const [key, entry] of discoveryState.entries()) {
    if (typeof entry !== 'object' || !entry.mac) continue;
    // Check if already registered
    const isReg = beacons.has(`mac:${entry.mac}`) ||
      (entry.uuid && beacons.has(`uuid:${entry.uuid.toLowerCase()}:${entry.major || 0}:${entry.minor || 0}`));
    result.push({
      mac: entry.mac,
      uuid: entry.uuid || '',
      major: entry.major || 0,
      minor: entry.minor || 0,
      rssi: entry.rssi,
      model: entry.model,
      brand: entry.brand,
      lastSeen: new Date(entry.lastSeen).toISOString(),
      count: entry.count,
      registered: isReg
    });
  }
  return result.sort((a, b) => b.rssi - a.rssi); // strongest signal first
}

module.exports = {
  processTheengsMessage,
  checkAbsence,
  getPresenceSnapshot,
  getDiscoverySnapshot,
  setPresenceCallback,
  normalizeMac
};
