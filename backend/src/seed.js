// ============================================================
// MyKinGuard — Seed Database with 7 Pilot Beacons
// ============================================================

const { getDb } = require('./database');

const BEACONS = [
  { mac: 'aa:bb:cc:dd:01:01', uuid: 'mkg00001000000000000000000000001', major: 1, minor: 1, name: 'Sofia', role: 'student' },
  { mac: 'aa:bb:cc:dd:01:02', uuid: 'mkg00001000000000000000000000002', major: 1, minor: 2, name: 'Lucas', role: 'student' },
  { mac: 'aa:bb:cc:dd:02:01', uuid: 'mkg00001000000000000000000000003', major: 2, minor: 1, name: 'Angel', role: 'staff' },
  { mac: 'aa:bb:cc:dd:02:02', uuid: 'mkg00001000000000000000000000004', major: 2, minor: 2, name: 'Maria', role: 'staff' },
  { mac: 'aa:bb:cc:dd:02:03', uuid: 'mkg00001000000000000000000000005', major: 2, minor: 3, name: 'Carlos', role: 'staff' },
  { mac: 'aa:bb:cc:dd:02:04', uuid: 'mkg00001000000000000000000000006', major: 2, minor: 4, name: 'Laura', role: 'staff' },
  { mac: 'aa:bb:cc:dd:02:05', uuid: 'mkg00001000000000000000000000007', major: 2, minor: 5, name: 'Pedro', role: 'staff' },
];

const db = getDb();

const stmt = db.prepare(
  'INSERT OR REPLACE INTO beacons (mac, uuid, major, minor, name, role) VALUES (?, ?, ?, ?, ?, ?)'
);

const insertAll = db.transaction(() => {
  for (const b of BEACONS) {
    stmt.run(b.mac, b.uuid, b.major, b.minor, b.name, b.role);
    console.log(`  Registered: ${b.name} (${b.role}) — ${b.mac}`);
  }
});

console.log('Seeding 7 pilot beacons...\n');
insertAll();
console.log(`\nDone! ${BEACONS.length} beacons registered.`);
