// ============================================================
// MyKinGuard — Presence Detection Engine
// ============================================================
//
// Processes Theengs Bridge / OpenMQTTGateway BLE messages.
// Tracks which beacons are "present" vs "absent".
// Generates enter/exit events.
//
// Theengs iBeacon payload format:
// {
//   "id": "AA:BB:CC:DD:EE:FF",
//   "rssi": -65,
//   "brand": "GENERIC",
//   "model": "iBeacon",
//   "model_id": "IBEACON",
//   "uuid": "1de4b189115e45f6b44e509352269977",
//   "major": 0,
//   "minor": 0,
//   "txpower": -66,
//   "distance": 3.5
// }
// ============================================================

const { getDb } = require('./database');

// In-memory presence state: deviceKey -> { lastSeen, rssi, present, ... }
const presenceState = new Map();

// How many seconds without detection before marking "absent"
const ABSENCE_TIMEOUT_SEC = parseInt(process.env.ABSENCE_TIMEOUT || '60');

// Minimum RSSI to consider a detection valid (filter weak/distant signals)
const MIN_RSSI = parseInt(process.env.MIN_RSSI || '-90');

// Callback for presence change events
let onPresenceChange = null;

function setPresenceCallback(cb) {
  onPresenceChange = cb;
}

/**
 * Get a unique key for a device.
 * Prefers UUID (for iBeacon tags) over MAC (for generic BLE).
 */
function getDeviceKey(data) {
  if (data.uuid) {
    return `uuid:${data.uuid}:${data.major || 0}:${data.minor || 0}`;
  }
  const mac = (data.id || data.mac || '').toLowerCase();
  return `mac:${mac}`;
}

/**
 * Look up the registered name for a device
 */
function lookupName(data) {
  const db = getDb();
  const mac = (data.id || data.mac || '').toLowerCase();

  if (data.uuid) {
    const byUuid = db.prepare('SELECT name, role FROM beacons WHERE uuid = ?').get(data.uuid);
    if (byUuid) return byUuid;
  }

  if (mac) {
    const byMac = db.prepare('SELECT name, role FROM beacons WHERE mac = ?').get(mac);
    if (byMac) return byMac;
  }

  return null;
}

/**
 * Process a single BLE device message from Theengs Bridge
 */
function processTheengsMessage(topicDeviceId, data) {
  const mac = (data.id || topicDeviceId || '').toLowerCase();
  const rssi = data.rssi;

  // Filter out weak signals
  if (rssi && rssi < MIN_RSSI) return;

  const deviceKey = getDeviceKey(data);
  const now = new Date();

  const db = getDb();

  // Store raw scan
  db.prepare(`
    INSERT INTO scan_events (gateway, mac, uuid, major, minor, rssi, txpower, distance, model, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'theengs-bridge',
    mac,
    data.uuid || null,
    data.major || null,
    data.minor || null,
    rssi || null,
    data.txpower || null,
    data.distance || null,
    data.model_id || data.model || 'unknown',
    JSON.stringify(data)
  );

  // Lookup registered name
  const registered = lookupName(data);

  // Update presence state
  const prev = presenceState.get(deviceKey);
  const wasPresent = prev ? prev.present : false;

  presenceState.set(deviceKey, {
    lastSeen: now,
    mac,
    uuid: data.uuid || (prev ? prev.uuid : ''),
    major: data.major || 0,
    minor: data.minor || 0,
    rssi: rssi || -100,
    txpower: data.txpower || null,
    distance: data.distance || null,
    model: data.model_id || data.model || 'unknown',
    brand: data.brand || '',
    name: registered ? registered.name : (prev ? prev.name : ''),
    role: registered ? registered.role : (prev ? prev.role : ''),
    present: true,
    deviceKey
  });

  // Emit "enter" event if newly detected
  if (!wasPresent) {
    const displayName = registered ? registered.name : mac;

    db.prepare(
      'INSERT INTO presence_events (mac, uuid, event, rssi, distance) VALUES (?, ?, ?, ?, ?)'
    ).run(mac, data.uuid || null, 'enter', rssi, data.distance || null);

    if (onPresenceChange) {
      onPresenceChange({
        event: 'enter',
        mac,
        uuid: data.uuid || '',
        name: displayName,
        role: registered ? registered.role : '',
        rssi,
        distance: data.distance || null,
        model: data.model_id || data.model || 'unknown',
        timestamp: now.toISOString()
      });
    }
  }
}

/**
 * Check for devices that have gone absent
 */
function checkAbsence() {
  const db = getDb();
  const now = Date.now();

  for (const [deviceKey, state] of presenceState.entries()) {
    if (!state.present) continue;

    const elapsed = (now - state.lastSeen.getTime()) / 1000;
    if (elapsed > ABSENCE_TIMEOUT_SEC) {
      state.present = false;
      presenceState.set(deviceKey, state);

      db.prepare(
        'INSERT INTO presence_events (mac, uuid, event, rssi, distance) VALUES (?, ?, ?, ?, ?)'
      ).run(state.mac, state.uuid || null, 'exit', state.rssi, state.distance);

      if (onPresenceChange) {
        onPresenceChange({
          event: 'exit',
          mac: state.mac,
          uuid: state.uuid || '',
          name: state.name,
          role: state.role,
          rssi: state.rssi,
          distance: state.distance,
          model: state.model,
          timestamp: new Date().toISOString()
        });
      }
    }
  }
}

/**
 * Get current presence snapshot
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
      rssi: state.rssi,
      txpower: state.txpower,
      distance: state.distance,
      model: state.model,
      brand: state.brand,
      present: state.present,
      lastSeen: state.lastSeen.toISOString()
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
