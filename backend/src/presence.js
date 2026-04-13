// ============================================================
// MyKinGuard — Presence Detection Engine v2
// ============================================================
//
// Robust presence detection with:
// - RSSI smoothing (exponential moving average)
// - Hysteresis thresholds (separate enter/exit RSSI)
// - Multi-reading ENTER confirmation
// - Timeout-based EXIT
// - Registered-only presence events (raw detections stored separately)
//
// Theengs iBeacon payload format:
// {
//   "id": "AA:BB:CC:DD:EE:FF",
//   "rssi": -65,
//   "brand": "GENERIC",
//   "model": "iBeacon",
//   "model_id": "IBEACON",
//   "uuid": "1de4b189115e45f6b44e509352269977",
//   "major": 0, "minor": 0,
//   "txpower": -66,
//   "distance": 3.5
// }
// ============================================================

const { getDb } = require('./database');

// --- Tunable parameters ---
const ENTER_RSSI        = parseInt(process.env.ENTER_RSSI || '-75');
const STRONG_ENTER_RSSI = parseInt(process.env.STRONG_ENTER_RSSI || '-68');
const EXIT_RSSI         = parseInt(process.env.EXIT_RSSI || '-82');
const IGNORE_RSSI       = parseInt(process.env.IGNORE_RSSI || '-85');
const EXIT_TIMEOUT_MS   = parseInt(process.env.EXIT_TIMEOUT_MS || '20000');
const ENTER_WINDOW_MS   = parseInt(process.env.ENTER_WINDOW_MS || '8000');
const ENTER_MIN_HITS    = parseInt(process.env.ENTER_MIN_HITS || '2');
const SMOOTHING_FACTOR  = parseFloat(process.env.SMOOTHING_FACTOR || '0.4');

// In-memory state
// deviceKey -> { smoothedRssi, recentHits: [{ts, rssi}], present, lastSeen, ... }
const presenceState = new Map();

// Callback for presence change events
let onPresenceChange = null;

function setPresenceCallback(cb) {
  onPresenceChange = cb;
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
    if (b.mac) beaconCache.set(`mac:${b.mac.toLowerCase()}`, b);
    if (b.uuid) beaconCache.set(`uuid:${b.uuid}:${b.major || 0}:${b.minor || 0}`, b);
  }
  beaconCacheTime = now;
  return beaconCache;
}

function isRegistered(deviceKey) {
  return getRegisteredBeacons().has(deviceKey);
}

function lookupRegistered(deviceKey) {
  return getRegisteredBeacons().get(deviceKey) || null;
}

/**
 * Get a unique key for a device.
 */
function getDeviceKey(data) {
  if (data.uuid) {
    return `uuid:${data.uuid}:${data.major || 0}:${data.minor || 0}`;
  }
  const mac = (data.id || data.mac || '').toLowerCase();
  return `mac:${mac}`;
}

/**
 * Smooth RSSI using exponential moving average
 */
function smoothRssi(previous, current) {
  if (previous === null || previous === undefined) return current;
  return (1 - SMOOTHING_FACTOR) * previous + SMOOTHING_FACTOR * current;
}

/**
 * Process a single BLE device message from Theengs Bridge
 */
function processTheengsMessage(topicDeviceId, data) {
  const mac = (data.id || topicDeviceId || '').toLowerCase();
  const rawRssi = data.rssi;

  // Hard ignore: signal too weak to be meaningful
  if (rawRssi !== undefined && rawRssi !== null && rawRssi < IGNORE_RSSI) return;

  const deviceKey = getDeviceKey(data);
  const now = Date.now();
  const nowDate = new Date(now);
  const db = getDb();

  // --- Raw layer: store ALL detections (technical log) ---
  db.prepare(`
    INSERT INTO scan_events (gateway, mac, uuid, major, minor, rssi, txpower, distance, model, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'theengs-bridge', mac,
    data.uuid || null, data.major || null, data.minor || null,
    rawRssi || null, data.txpower || null, data.distance || null,
    data.model_id || data.model || 'unknown',
    JSON.stringify(data)
  );

  // --- Presence layer: only for registered beacons ---
  const registered = lookupRegistered(deviceKey);
  if (!registered) return; // Ignore unregistered devices for presence logic

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

  // Track recent valid hits (RSSI above enter threshold) within the window
  if (state.smoothedRssi >= ENTER_RSSI) {
    state.recentHits.push({ ts: now, rssi: state.smoothedRssi });
  }
  // Prune hits outside the enter window
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

  // --- While present: check hysteresis exit on weak signal ---
  // (actual timeout exit is handled by checkAbsence)
  // If smoothed RSSI drops below exit threshold, don't immediately exit
  // but stop resetting the "last valid" timer — let the timeout handle it
  if (state.present && state.smoothedRssi >= EXIT_RSSI) {
    state.lastValidSignal = now;
  }

  presenceState.set(deviceKey, state);
}

/**
 * Check for devices that should exit.
 * Uses hysteresis: exit when no valid signal (above EXIT_RSSI) for EXIT_TIMEOUT_MS.
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

module.exports = {
  processTheengsMessage,
  checkAbsence,
  getPresenceSnapshot,
  setPresenceCallback
};
