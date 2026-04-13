// ============================================================
// MyKinGuard — Backend Server (M0 Pilot)
// ============================================================
//
// - MQTT consumer: receives BLE data from Theengs Bridge
//   (OpenMQTTGateway format)
// - REST API: serves data to dashboard
// - WebSocket: pushes real-time updates to dashboard
// ============================================================

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const path = require('path');
const { getDb } = require('./database');
const { processTheengsMessage, checkAbsence, getPresenceSnapshot, getDiscoverySnapshot, setPresenceCallback, normalizeMac } = require('./presence');

// --- Config ---
const PORT     = process.env.PORT || 3000;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_BASE_TOPIC = process.env.MQTT_BASE_TOPIC || 'home/';
const GATEWAY_NAME = process.env.GATEWAY_NAME || 'OpenMQTTGateway';

// --- Express + HTTP ---
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- WebSocket ---
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected (${wsClients.size} total)`);

  // Send current state immediately
  ws.send(JSON.stringify({
    type: 'snapshot',
    data: getPresenceSnapshot()
  }));
  ws.send(JSON.stringify({
    type: 'gateway_status',
    data: { connected: gatewayStatus.connected, lastSeen: gatewayStatus.lastSeen }
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} total)`);
  });
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

// --- Presence change callback ---
setPresenceCallback((event) => {
  console.log(`[Presence] ${event.event.toUpperCase()}: ${event.name || event.mac} (rssi: ${event.rssi})`);
  broadcast({ type: 'presence_event', data: event });
  broadcast({ type: 'snapshot', data: getPresenceSnapshot() });
});

// --- MQTT ---
console.log(`[MQTT] Connecting to ${MQTT_URL}...`);
const mqttClient = mqtt.connect(MQTT_URL, {
  reconnectPeriod: 3000,
  clientId: 'mykinguard-backend'
});

// Track gateway status
const gatewayStatus = {
  lastSeen: null,
  connected: false
};

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected!');

  // Subscribe to Theengs Bridge / OpenMQTTGateway topics
  // Use wildcard '+' for gateway name to accept any name (OpenMQTTGateway, TheengsBridge, etc.)
  const btTopic = `${MQTT_BASE_TOPIC}+/BTtoMQTT/+`;
  const sysTopic = `${MQTT_BASE_TOPIC}+/SYStoMQTT/+`;
  const lwTopic = `${MQTT_BASE_TOPIC}+/LWT`;

  mqttClient.subscribe(btTopic, (err) => {
    if (!err) console.log(`[MQTT] Subscribed to: ${btTopic}`);
  });
  mqttClient.subscribe(sysTopic, (err) => {
    if (!err) console.log(`[MQTT] Subscribed to: ${sysTopic}`);
  });
  mqttClient.subscribe(lwTopic, (err) => {
    if (!err) console.log(`[MQTT] Subscribed to: ${lwTopic}`);
  });

  // Also subscribe to simulator topic for testing
  mqttClient.subscribe('mykinguard/simulator/+', (err) => {
    if (!err) console.log('[MQTT] Subscribed to: mykinguard/simulator/+');
  });
});

mqttClient.on('message', (topic, message) => {
  try {
    const raw = message.toString();

    // Handle LWT (Last Will and Testament) — gateway online/offline
    if (topic.endsWith('/LWT')) {
      const isOnline = raw === 'online';
      gatewayStatus.connected = isOnline;
      gatewayStatus.lastSeen = new Date().toISOString();
      console.log(`[MQTT] Gateway ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
      broadcast({
        type: 'gateway_status',
        data: { connected: isOnline, lastSeen: gatewayStatus.lastSeen }
      });
      return;
    }

    const data = JSON.parse(raw);

    // Handle SYS messages (system info from gateway)
    if (topic.includes('/SYStoMQTT/')) {
      gatewayStatus.lastSeen = new Date().toISOString();
      gatewayStatus.connected = true;
      broadcast({ type: 'gateway_status', data: { ...data, connected: true, lastSeen: gatewayStatus.lastSeen } });
      return;
    }

    // Handle BLE device messages (BTtoMQTT)
    if (topic.includes('/BTtoMQTT/')) {
      // Extract device ID from topic (last segment = MAC or UUID)
      const topicParts = topic.split('/');
      const topicDeviceId = topicParts[topicParts.length - 1];

      const wasConnected = gatewayStatus.connected;
      gatewayStatus.lastSeen = new Date().toISOString();
      gatewayStatus.connected = true;

      // Broadcast gateway online status if this is the first detection
      if (!wasConnected) {
        broadcast({
          type: 'gateway_status',
          data: { connected: true, lastSeen: gatewayStatus.lastSeen }
        });
      }

      processTheengsMessage(topicDeviceId, data);

      broadcast({
        type: 'scan',
        data: {
          gateway: GATEWAY_NAME,
          device_id: topicDeviceId,
          timestamp: new Date().toISOString()
        }
      });
    }

    // Handle simulator messages
    if (topic.startsWith('mykinguard/simulator/')) {
      const topicParts = topic.split('/');
      const topicDeviceId = topicParts[topicParts.length - 1];
      processTheengsMessage(topicDeviceId, data);
      broadcast({
        type: 'scan',
        data: {
          gateway: 'simulator',
          device_id: topicDeviceId,
          timestamp: new Date().toISOString()
        }
      });
    }

  } catch (err) {
    console.error('[MQTT] Parse error:', err.message);
  }
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Error:', err.message);
});

// --- Absence checker (every 5 seconds for responsive exit detection) ---
setInterval(checkAbsence, 5000);

// ============================================================
// REST API
// ============================================================

// Current presence state
app.get('/api/presence', (req, res) => {
  res.json(getPresenceSnapshot());
});

// Gateway status
app.get('/api/gateway', (req, res) => {
  res.json(gatewayStatus);
});

// Registered beacons
app.get('/api/beacons', (req, res) => {
  const db = getDb();
  const beacons = db.prepare('SELECT * FROM beacons ORDER BY name').all();
  res.json(beacons);
});

// Register a new beacon (MAC is normalized automatically)
app.post('/api/beacons', (req, res) => {
  const { mac, uuid, major, minor, name, role } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const normalizedMac = mac ? normalizeMac(mac) : '';
  if (!normalizedMac && !uuid) {
    return res.status(400).json({ error: 'mac or uuid is required' });
  }
  const db = getDb();
  try {
    db.prepare(
      'INSERT OR REPLACE INTO beacons (mac, uuid, major, minor, name, role) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      normalizedMac,
      uuid ? uuid.toLowerCase() : '',
      major || 0,
      minor || 0,
      name,
      role || 'student'
    );
    res.json({ success: true, mac: normalizedMac });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a beacon
app.delete('/api/beacons/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id.toLowerCase();
  db.prepare('DELETE FROM beacons WHERE mac = ? OR uuid = ?').run(id, id);
  res.json({ success: true });
});

// Recent events
app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const db = getDb();
  const events = db.prepare(`
    SELECT pe.*, b.name as beacon_name
    FROM presence_events pe
    LEFT JOIN beacons b ON pe.mac = b.mac OR pe.uuid = b.uuid
    ORDER BY pe.timestamp DESC
    LIMIT ?
  `).all(limit);
  res.json(events);
});

// Scan history for a specific device
app.get('/api/scans/:id', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const id = req.params.id.toLowerCase();
  const db = getDb();
  const scans = db.prepare(`
    SELECT * FROM scan_events
    WHERE mac = ? OR uuid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(id, id, limit);
  res.json(scans);
});

// Discovery: all recently detected BLE devices (for finding and registering beacons)
app.get('/api/discovery', (req, res) => {
  res.json(getDiscoverySnapshot());
});

// Presence engine configuration (read-only)
app.get('/api/config', (req, res) => {
  res.json({
    ENTER_RSSI: process.env.ENTER_RSSI || '-75',
    STRONG_ENTER_RSSI: process.env.STRONG_ENTER_RSSI || '-68',
    EXIT_RSSI: process.env.EXIT_RSSI || '-82',
    IGNORE_RSSI: process.env.IGNORE_RSSI || '-85',
    EXIT_TIMEOUT_MS: process.env.EXIT_TIMEOUT_MS || '90000',
    ENTER_WINDOW_MS: process.env.ENTER_WINDOW_MS || '8000',
    ENTER_MIN_HITS: process.env.ENTER_MIN_HITS || '2',
    SMOOTHING_FACTOR: process.env.SMOOTHING_FACTOR || '0.4'
  });
});

// Raw scan stats (how many total BLE devices seen vs registered)
app.get('/api/stats', (req, res) => {
  const db = getDb();
  const totalScans = db.prepare('SELECT COUNT(*) as count FROM scan_events').get();
  const uniqueDevices = db.prepare('SELECT COUNT(DISTINCT mac) as count FROM scan_events').get();
  const registeredCount = db.prepare('SELECT COUNT(*) as count FROM beacons').get();
  const last5min = db.prepare(
    "SELECT COUNT(DISTINCT mac) as count FROM scan_events WHERE timestamp > datetime('now', '-5 minutes')"
  ).get();
  res.json({
    totalScans: totalScans.count,
    uniqueDevices: uniqueDevices.count,
    registeredBeacons: registeredCount.count,
    activeDevicesLast5min: last5min.count
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    gateway: gatewayStatus,
    wsClients: wsClients.size,
    uptime: process.uptime()
  });
});

// --- Start ---
server.listen(PORT, () => {
  console.log('========================================');
  console.log('  MyKinGuard — M0 Pilot Backend');
  console.log(`  HTTP/WS: http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  MQTT: ${MQTT_URL}`);
  console.log(`  Gateway topic: ${MQTT_BASE_TOPIC}${GATEWAY_NAME}/BTtoMQTT/+`);
  console.log('========================================');
});
