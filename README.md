
# libPharosRTC: Resilient Browser-to-Embedded Transport over High-BER IP Links

**libPharosRTC** is a reusable, zero-install browser-to-embedded
  transport protocol designed to operate reliably across degraded IP
  links—ranging from **high-BER, low-RTT terrestrial RF links** (no
  MAC-layer ARQ, tens of milliseconds RTT) to **variable-latency
  satellite links** (e.g., Starlink, ~25–80 ms nominal RTT with
  periodic weather/handover fades and spikes).

> **Pharos**:  The legendary lighthouse of Alexandria, built to guide travelers safely through treacherous, dark, or stormy waters. Symbolizes a steady, guiding signal cutting through high-noise, high-loss environments (like Starlink fades or high-BER radio links).

> **RTC**: Real Time Communication, where WebRTC is the web standard being used as the transport.

### Developer Guides
- [Web UI Developer Guide](docs/WEB_UI_DEVELOPER_GUIDE.md) - Integrating libPharosRTC into TypeScript/JavaScript browser applications.
- [Python Server-Side Developer Guide](docs/PYTHON_DEVELOPER_GUIDE.md) - Integrating libPharosRTC into Python / embedded Linux backends.

---

## Building & Running

### Prerequisites
- **Node.js**: v18 or newer and `npm`
- **Python**: Python 3.9+ with `venv` and `pip`

### 1. Environment Setup
Install Node dependencies and set up the Python virtual environment:

```bash
# Install Node/TypeScript dependencies
npm install

# Set up Python virtual environment and install dependencies
python3 -m venv venv
source venv/bin/activate
pip install aiortc aiohttp websockets cryptography pytest pytest-asyncio
```

### 2. Building the Library & Demo
```bash
# Build the TypeScript client library (outputs to dist/)
npm run build

# Build the interactive frontend demo application (outputs to demo/static/)
npm run build:demo
```

### 3. Running the Interactive Demo
Start the single-port demo server (serves both static web assets and WebRTC signaling):

```bash
# Run via active virtual environment:
python3 demo/demo_server.py --port 2500

# Or directly using the venv executable:
./venv/bin/python3 demo/demo_server.py --port 2500
```

Open Chrome or any modern web browser at **`http://localhost:2500`** to access the interactive dashboard.

#### Server CLI Options
- `--host` (default: `127.0.0.1`): Bind IP address.
- `--port` (default: `2500`): HTTP and WebSocket server port.
- `--profile` (default: `terrestrial`): Link configuration profile (`terrestrial` = 220B App-MTU, `starlink` = 900B App-MTU).
- `--static-dir` (default: `demo/static`): Path to built static web assets.

### 4. Running Tests
```bash
# Run TypeScript unit tests (Vitest)
npm test

# Run Python unit and cross-language tests (Pytest)
./venv/bin/pytest
```

---


### Core Architectural Decisions
1. **Zero-Install Browser Endpoint:** Uses standard browser
   `RTCPeerConnection` and `RTCDataChannel` configured in **unordered,
   unreliable** mode (`ordered: false, maxRetransmits: 0`) to pass raw
   datagrams without browser-level head-of-line blocking or TCP
   congestion collapse.
2. **Offline / Isolated IP Operation:** Operates without STUN or TURN
   servers (`iceServers: []`) using host ICE candidates and an
   embedded **ICE-Lite** responder. Signaling reuses the device's
   existing **NGINX + Python WebSocket** stack.
3. **Small-Frame Discipline:** Enforces a strict, configurable
   application Maximum Transmission Unit (**App-MTU**, default `220
   bytes`) so every frame fits inside a single unfragmented UDP/IP
   packet. This prevents catastrophic packet-loss amplification on
   high-BER links where $P(\text{success}) = (1 - \text{BER})^N$.
4. **Priority-Multiplexed Selective Repeat ARQ:** Implements a custom
   framing, priority scheduler, and Selective Repeat ARQ engine above
   the unreliable DataChannel, supporting multiple logical channels
   with distinct delivery guarantees (`RELIABLE_ORDERED` and
   `UNRELIABLE_UNORDERED`) and strict priority preemption so bulk file
   transfers never starve low-latency Command & Control (C2).

---

## 2. System Topology & Protocol Stack

```text
+-----------------------------------+               +-----------------------------------+
|         PC (Web Browser)          |               |    Embedded Device (Yocto ARM)    |
|                                   |               |                                   |
|  +-----------------------------+  |               |  +-----------------------------+  |
|  | App Logic (C2 / Bulk / Tel) |  |               |  | App Logic (C2 / Bulk / Tel) |  |
|  +--------------+--------------+  |               |  +--------------+--------------+  |
|                 |                 |               |                 |                 |
|  +--------------v--------------+  |               |  +--------------v--------------+  |
|  |   Priority Mux & ARQ Engine |  |               |  |   Priority Mux & ARQ Engine |  |
|  |   (TypeScript / WebWorker)  |  |               |  |     (Python 3 or C++17)     |  |
|  +--------------+--------------+  |               |  +--------------+--------------+  |
|                 |                 |               |                 |                 |
|  +--------------v--------------+  |  WebSocket    |  +--------------v--------------+  |
|  |     Browser WebRTC Stack    |<-+---Signaling-->|  |   NGINX -> Python WS / IPC  |  |
|  | (SCTP Unreliable / DTLS /   |  |  (SDP/ICE)    |  +--------------+--------------+  |
|  |  ICE / UDP)                 |  |               |                 |                 |
|  +--------------+--------------+  |               |  +--------------v--------------+  |
|                 |                 |               |  |  WebRTC Transport Backend   |  |
+-----------------|-----------------+               |  |  (aiortc OR mbedTLS + Shim) |  |
                  |                                 |  +--------------+--------------+  |
                  |                                 |                 |                 |
                  |                                 +-----------------|-----------------+
                  |         UDP / IPv4                                |
                  +===================================================+
                         Customer RF Link or Starlink (No STUN/TURN)
```

