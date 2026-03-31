# MyKinGuard — M0 Pilot Validation

End-to-end BLE presence detection system: **Theengs Bridge → MQTT → Node.js backend → Live dashboard**

## Architecture

```
[iBeacon Tags] ──BLE──▶ [Theengs Bridge] ──WiFi/MQTT──▶ [Mosquitto] ──▶ [Backend] ──WebSocket──▶ [Dashboard]
  (7 people)              (ESP32 gateway)                                 (Node.js)              (Web browser)
```

## What You Need

| Item | Cost | Where |
|------|------|-------|
| 1x Theengs Bridge (ESP32 BLE/WiFi gateway) | ~$30 | shop.theengs.io |
| 7x iBeacon BLE tags | ~$3-5 each | Amazon |
| PC/laptop for backend | $0 | Already have |
| WiFi network | $0 | Already have |

## Quick Start

### 1. Start the Backend

**Option A: Docker (recommended)**
```bash
cd backend
docker-compose up -d
```

**Option B: Without Docker**
```bash
# Install & start Mosquitto MQTT broker
# macOS: brew install mosquitto && mosquitto -c backend/mosquitto/config/mosquitto.conf
# Ubuntu: sudo apt install mosquitto
# Windows: download from https://mosquitto.org/download/

# Start backend
cd backend
npm install
npm run seed      # Register 7 pilot beacons
npm start         # Server on http://localhost:3000
```

Dashboard: **http://localhost:3000**

### 2. Test Without Hardware (Simulator)

```bash
cd backend
npm run simulate
```

This simulates 7 iBeacon devices (2 kids + 5 adults) sending data as if a real Theengs Bridge were present. Beacons randomly appear/disappear.

### 3. Configure Theengs Bridge (when hardware arrives)

1. Power on the bridge — it creates WiFi AP: `OpenMQTTGateway`
2. Connect to the AP, configure in the captive portal:
   - **WiFi**: Your network SSID + password
   - **MQTT broker**: IP of the machine running Mosquitto (port 1883)
   - **Base topic**: `home/` (default)
3. Bridge starts publishing BLE scans to `home/OpenMQTTGateway/BTtoMQTT/{MAC}`

#### Useful MQTT config commands

Send to `home/OpenMQTTGateway/commands/MQTTtoBT/config`:

| Command | Purpose |
|---------|---------|
| `{"minrssi": -80}` | Filter weak signals |
| `{"pubuuid4topic": true}` | Use UUID instead of MAC in topic |
| `{"interval": 3000}` | Scan interval in ms |

### 4. Register People in the Dashboard

1. Open http://localhost:3000
2. Detected beacons appear automatically
3. Use the registration form: enter MAC address, name, role (student/staff)
4. Click **+ Register**

Or pre-register using: `npm run seed`

### 5. Watch it Work!

- **Green dot** = person is present (detected in last 60 seconds)
- **Red dot** = person is absent (not detected for 60+ seconds)
- **Event log** shows enter/exit events in real-time
- **RSSI bar** shows signal strength (closer = stronger)
- **Distance** estimated from RSSI + TX power

## Project Structure

```
esp32/
├── backend/
│   ├── src/
│   │   ├── server.js       # Express + MQTT + WebSocket server
│   │   ├── database.js     # SQLite schema and connection
│   │   ├── presence.js     # Presence detection engine (Theengs format)
│   │   ├── simulator.js    # BLE beacon simulator (no hardware needed)
│   │   └── seed.js         # Pre-register 7 pilot beacons
│   ├── public/
│   │   └── index.html      # MyKinGuard live dashboard
│   ├── mosquitto/config/
│   │   └── mosquitto.conf  # MQTT broker config
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── package.json
├── firmware/                # (Reserved for future custom firmware)
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/presence` | Current presence snapshot |
| GET | `/api/beacons` | List registered beacons |
| POST | `/api/beacons` | Register beacon `{mac, uuid, name, role}` |
| DELETE | `/api/beacons/:id` | Remove beacon by MAC or UUID |
| GET | `/api/events?limit=50` | Recent presence events |
| GET | `/api/scans/:id?limit=100` | Scan history for a device |
| GET | `/api/gateway` | Gateway connection status |
| GET | `/api/health` | System health check |
| WS | `/ws` | Real-time WebSocket stream |

## MQTT Topics (Theengs Bridge / OpenMQTTGateway)

| Topic | Direction | Description |
|-------|-----------|-------------|
| `home/OpenMQTTGateway/BTtoMQTT/+` | Bridge → Backend | BLE device detected (iBeacon JSON) |
| `home/OpenMQTTGateway/SYStoMQTT/+` | Bridge → Backend | System info (IP, memory, uptime) |
| `home/OpenMQTTGateway/LWT` | Bridge → Backend | Online/Offline status |
| `home/OpenMQTTGateway/commands/MQTTtoBT/config` | Backend → Bridge | Configuration commands |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_BASE_TOPIC` | `home/` | Theengs Bridge base topic |
| `GATEWAY_NAME` | `OpenMQTTGateway` | Gateway name in MQTT topic |
| `DB_PATH` | `./data/mykinguard.db` | SQLite database path |
| `ABSENCE_TIMEOUT` | `60` | Seconds before marking absent |
| `MIN_RSSI` | `-90` | Minimum RSSI to accept |

## Verification Checklist (M0)

- [ ] Docker/backend starts successfully
- [ ] Dashboard shows "Live" WebSocket connection
- [ ] Simulator shows 7 beacons appearing in dashboard
- [ ] Presence events (enter/exit) recorded in event log
- [ ] Beacon registration works (name + role)
- [ ] RSSI signal strength and distance displayed
- [ ] Gateway status indicator works (online/offline)
- [ ] Theengs Bridge connects to MQTT and publishes data
- [ ] Real iBeacon tags detected and displayed
- [ ] All 7 people visible in the dashboard simultaneously
