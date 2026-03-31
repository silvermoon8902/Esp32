// ============================================================
// MyKinGuard — BLE Beacon Simulator
// ============================================================
//
// Simulates 7 iBeacon devices being detected by a Theengs Bridge.
// Publishes MQTT messages in OpenMQTTGateway format.
//
// Usage: node src/simulator.js
// ============================================================

const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const BASE_TOPIC = process.env.MQTT_BASE_TOPIC || 'home/';
const GATEWAY = process.env.GATEWAY_NAME || 'OpenMQTTGateway';

// 7 simulated beacons: 2 kids + 5 adults
const BEACONS = [
  { mac: 'AA:BB:CC:DD:01:01', uuid: 'mkg00001000000000000000000000001', major: 1, minor: 1, name: 'Sofia (Kid 1)', role: 'student' },
  { mac: 'AA:BB:CC:DD:01:02', uuid: 'mkg00001000000000000000000000002', major: 1, minor: 2, name: 'Lucas (Kid 2)', role: 'student' },
  { mac: 'AA:BB:CC:DD:02:01', uuid: 'mkg00001000000000000000000000003', major: 2, minor: 1, name: 'Angel (Adult 1)', role: 'staff' },
  { mac: 'AA:BB:CC:DD:02:02', uuid: 'mkg00001000000000000000000000004', major: 2, minor: 2, name: 'Maria (Adult 2)', role: 'staff' },
  { mac: 'AA:BB:CC:DD:02:03', uuid: 'mkg00001000000000000000000000005', major: 2, minor: 3, name: 'Carlos (Adult 3)', role: 'staff' },
  { mac: 'AA:BB:CC:DD:02:04', uuid: 'mkg00001000000000000000000000006', major: 2, minor: 4, name: 'Laura (Adult 4)', role: 'staff' },
  { mac: 'AA:BB:CC:DD:02:05', uuid: 'mkg00001000000000000000000000007', major: 2, minor: 5, name: 'Pedro (Adult 5)', role: 'staff' },
];

// Simulate presence: each beacon has a chance of being "away"
const beaconState = BEACONS.map(b => ({
  ...b,
  present: true,
  baseRssi: -55 - Math.random() * 20 // -55 to -75
}));

const client = mqtt.connect(MQTT_URL, {
  clientId: 'mykinguard-simulator'
});

client.on('connect', () => {
  console.log(`[Simulator] Connected to MQTT at ${MQTT_URL}`);
  console.log(`[Simulator] Publishing to: ${BASE_TOPIC}${GATEWAY}/BTtoMQTT/{mac}`);
  console.log(`[Simulator] Simulating ${BEACONS.length} beacons every 3 seconds\n`);

  // Publish LWT online
  client.publish(`${BASE_TOPIC}${GATEWAY}/LWT`, 'online');

  // Start simulation loop
  setInterval(simulateScan, 3000);
  simulateScan(); // first scan immediately
});

function simulateScan() {
  const now = new Date().toLocaleTimeString();

  for (const beacon of beaconState) {
    // 5% chance of toggling presence each cycle
    if (Math.random() < 0.05) {
      beacon.present = !beacon.present;
      console.log(`[Simulator] ${now} — ${beacon.name} ${beacon.present ? 'APPEARED' : 'DISAPPEARED'}`);
    }

    if (!beacon.present) continue;

    // Simulate RSSI fluctuation (±5 dBm)
    const rssi = Math.round(beacon.baseRssi + (Math.random() - 0.5) * 10);
    const txpower = -66;
    const distance = Math.round(Math.pow(10, (txpower - rssi) / 20) * 100) / 100;

    // OpenMQTTGateway iBeacon format
    const payload = {
      id: beacon.mac,
      mac_type: 1,
      rssi,
      brand: 'GENERIC',
      model: 'iBeacon',
      model_id: 'IBEACON',
      mfid: '4c00',
      uuid: beacon.uuid,
      major: beacon.major,
      minor: beacon.minor,
      txpower,
      distance
    };

    const topic = `${BASE_TOPIC}${GATEWAY}/BTtoMQTT/${beacon.mac}`;
    client.publish(topic, JSON.stringify(payload));
  }

  const presentCount = beaconState.filter(b => b.present).length;
  process.stdout.write(`\r[Simulator] ${now} — ${presentCount}/${BEACONS.length} beacons present    `);
}

client.on('error', (err) => {
  console.error('[Simulator] MQTT error:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Simulator] Shutting down...');
  client.publish(`${BASE_TOPIC}${GATEWAY}/LWT`, 'offline');
  setTimeout(() => {
    client.end();
    process.exit(0);
  }, 500);
});
