# libPharosRTC Interactive Lossy Link Demo & Benchmark Design

## 1. Overview & Goal

The **libPharosRTC Interactive Lossy Link Demo** is a standalone, single-port web application and command-line server designed to:
1. **Demonstrate Resilient Transport**: Visually showcase how `libPharosRTC` maintains reliable, low-latency, lossless file transfers over simulated lossy IP links (up to 30%+ packet loss) without STUN/TURN servers.
2. **Provide Real-Time Telemetry**: Exhibit live ARQ (Automatic Repeat reQuest) and FEC (Forward Error Correction / XOR Parity) operational metrics, demonstrating frame retransmissions and loss recovery without ARQ retransmit requests.
3. **Serve as a Reference Integration**: Give developers an easy-to-read, end-to-end code example showing how to integrate `ResilientLinkClient` (TypeScript) in browser frontends and `ResilientLink` (Python) in embedded backends.

---

## 2. Execution & Server Interface

The Python server (`demo/demo_server.py`) serves both the web frontend static assets and the WebRTC SDP signaling WebSocket interface over a single HTTP port.

### Execution Command
```bash
./venv/bin/python3 demo/demo_server.py --port 2500
```

### CLI Parameters
- `--host` (default: `127.0.0.1`): Bind IP address.
- `--port` (default: `2500`): Port for HTTP static web serving and WebSocket signaling (`/ws/webrtc`).
- `--profile` (default: `terrestrial`): Link profile (`terrestrial` = 220B App-MTU, `starlink` = 900B App-MTU).
- `--static-dir` (default: `demo/static`): Directory containing built frontend web assets.

### Output on Launch
Upon starting, `demo_server.py` logs the connection URL clearly to `stdout`:

```text
====================================================================
 PharosRTC Interactive Lossy Link Demo Server
 Open Chrome or your web browser at:
   --> http://127.0.0.1:2500
====================================================================
[INFO] WebRTC Signaling Endpoint: ws://127.0.0.1:2500/ws/webrtc
[INFO] Profile: TERRESTRIAL | Static Dir: /path/to/libPharosRTC/demo/static
[READY] Server running. Press Ctrl+C to exit.
```

---

## 3. Architecture & Data Flow

```text
  +---------------------------------------------------------------------------------+
  |                             BROWSER (Chrome)                                    |
  |                                                                                 |
  |  +---------------------------+       +---------------------------------------+  |
  |  |   Demo UI Dashboard       |       |       ResilientLinkClient             |  |
  |  |  - Packet Loss Slider     |<----->|  - ChID 0: C2 / Impairment Control    |  |
  |  |  - File Transfer Controls |       |  - ChID 2: Bulk File Stream           |  |
  |  |  - Telemetry Cards        |       |  - ArqEngine & FecDecoder (WebWorker) |  |
  |  +---------------------------+       +---------------------------------------+  |
  |                                                          ^                      |
  +----------------------------------------------------------|----------------------+
                                                             | RTCDataChannel
                                                             | (unordered, unreliable)
                                                             | + Software Packet Drop
                                                             v Interceptor
  +---------------------------------------------------------------------------------+
  |                           PYTHON SERVER (demo_server.py)                        |
  |                                                                                 |
  |  +---------------------------+       +---------------------------------------+  |
  |  |   aiohttp Web Server      |       |       ResilientLink Backend           |  |
  |  |  - Port 2500              |       |  - WebRtcBackend (aiortc)             |  |
  |  |  - Static Asset Serving   |       |  - ArqEngine & FecEncoder/Decoder     |  |
  |  |  - /ws/webrtc Signaling   |       |  - Impairment Filter (Loss Simulator) |  |
  |  +---------------------------+       +---------------------------------------+  |
  +---------------------------------------------------------------------------------+
```

---

## 4. Key Demo Components

### 4.1 Software Packet Loss Simulator (Impairment Layer)
To allow testing lossy links anywhere without requiring Linux `sudo tc netem` root privileges, the demo incorporates an **in-memory software packet drop filter** in both the Python backend and TypeScript frontend:

- **Configurable Loss Rate**: 0% to 50% simulated datagram drop rate, adjusted in real time via a range slider on the web UI.
- **Bi-directional / Uni-directional Loss**: Allows applying loss to Outbound (TX), Inbound (RX), or Both directions independently.
- **Real-Time Control**: Adjusting the slider in the UI sends a JSON control payload over `ChID 0` (Command & Control channel) to immediately update the Python server's outbound drop probability.

### 4.2 Large File Transfer Engine (Upload & Download Tests)
The demo supports robust file transfer stress testing over high-BER / lossy environments:

- **Synthetic Presets**:
  - `1 MB Test`: Fast benchmark for quick validation.
  - `5 MB Test`: Medium transfer to observe sustained throughput and RTT stability.
  - `10 MB Test`: Heavy transfer test under high packet loss.
- **Custom Local File Upload**: Select any local file from disk via a browser file picker.
- **Data Integrity Verification**:
  - Each file transfer begins with a metadata frame containing the total file size and computed **SHA-256 / MD5 digest**.
  - Upon transfer completion on `ChID 2` (Bulk Channel), the receiving end recalculates the hash of the reassembled byte array.
  - The UI displays a green **"PASS - SHA-256 Verified"** badge upon byte-exact reconstruction, proving 100% loss-free ARQ recovery over lossy datagrams.

### 4.3 ARQ & FEC Parity Telemetry Dashboard
The browser client polls local WebWorker stats every **100ms** and receives periodic out-of-band server telemetry every **250ms** over WebSocket (`type: "server_telemetry"`). The UI renders two side-by-side telemetry panels for the **Browser Client (TypeScript)** and **Embedded Server (Python)**:

| Metric | Description |
| :--- | :--- |
| **TX / RX Frames** | Count of wire datagrams sent and received across channels. |
| **Retransmissions** | Total ARQ retransmission requests fulfilled due to lost frames. |
| **Retransmit Ratio (%)** | Percentage of sent frames that were retransmissions (`Retx / TX * 100`). |
| **Smoothed RTT (SRTT)** | Jacobson/Karels smoothed round-trip time calculated from SACK ACKs. |
| **Adaptive RTO** | Adaptive Retransmission Timeout value dynamically computed by ARQ. |
| **Est. Loss / Outbound Loss** | Client estimated ARQ loss rate (%) or Server outbound loss rate configuration (%). |
| **Parity Frames (FEC)** | Total 1-in-N XOR parity frames transmitted and received (`TX / RX`). |
| **FEC Parity Recoveries** | **Key Metric**: Counter indicating how many lost data frames were successfully reconstructed via XOR parity calculations *without requiring an ARQ retransmission request*. |
| **App-MTU Config** | Configured App-MTU setting displayed in the card header badge (e.g. `220 B`). |

---

## 5. User Interface (UI) Wireframe & Layout

```text
+-----------------------------------------------------------------------------------+
|  libPharosRTC Resilient WebRTC Transport Demo & Benchmarking     [ Disconnected ] |
|  [ Connect WebRTC ]  [ Disconnect ]                                               |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ SIMULATED LINK IMPAIRMENT (SOFTWARE PACKET LOSS) ]                             |
|  Packet Loss Rate: 15%                                                            |
|  [====================|====================]                                      |
|  Apply Loss To: (*) Both (TX + RX)   ( ) Client TX Only   ( ) Server TX Only      |
|                                                                                   |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ FILE TRANSFER STRESS BENCH ]                                                   |
|  Mode: [ Upload (Client -> Server) v ]   Presets: [ 1 MB ]  [ 5 MB ]  [ 10 MB ]   |
|  Custom Local File: [ Choose File ] no file selected                              |
|  Selected Payload: 1 MB Synthetic Preset                                          |
|                                                                                   |
|  [ Start Transfer ]   [ Cancel ]                                                  |
|                                                                                   |
|  Progress: Transferring...                                                        |
|  52.0% (545,250 / 1,048,576 B)                                                     |
|  [=========================>                    ]                                 |
|  Speed: 184.2 KB/s  |  Elapsed: 2.8s  |  Integrity Hash: [ PASS - SHA-256 Verified ]|
|                                                                                   |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ REAL-TIME ARQ & FEC TELEMETRY DASHBOARD ]                App-MTU Config: 220 B |
|  +----------------------------------+  +----------------------------------+       |
|  | Browser Client (TypeScript)      |  | Embedded Server (Python)         |       |
|  | TX Frames:                 2,840 |  | TX Frames:                 2,810 |       |
|  | RX Frames:                 2,810 |  | RX Frames:                 2,840 |       |
|  | Retransmissions:             382 |  | Retransmissions:             350 |       |
|  | Retransmit Ratio:           13.4%|  | Retransmit Ratio:           12.5%|       |
|  | Smoothed RTT:             42.1 ms|  | Smoothed RTT:             41.8 ms|       |
|  | Adaptive RTO:            168.4 ms|  | Adaptive RTO:            165.2 ms|       |
|  | Est. ARQ Loss Rate:         14.8%|  | Outbound Loss Rate: 15.0% (both) |       |
|  | Parity Frames TX / RX:   284 / 281|  | Parity Frames TX / RX:   281 / 284|       |
|  | XOR Parity Recoveries:       112 |  | XOR Parity Recoveries:       108 |       |
|  +----------------------------------+  +----------------------------------+       |
|                                                                                   |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ COMMAND & CONTROL (ChID 0) PRIORITY PREEMPTION TEST ]                          |
|  Send high-priority C2 messages during active file transfers on ChID 2 to         |
|  demonstrate zero C2 starvation.                                                  |
|                                                                                   |
|  [ Enter command message...                          ] [ Send High-Priority C2 ]  |
|  Log:                                                                             |
|   14:02:11 [System] Ready to test priority preemption on ChID 0.                  |
|   14:02:11 [C2 TX] Ping / C2 Test                                                 |
|   14:02:11 [C2 RX] ACK: Ping / C2 Test                                            |
|                                                                                   |
+-----------------------------------------------------------------------------------+
```

---

## 6. Project Directory Layout

```text
libPharosRTC/
├── vite.config.demo.ts         # Vite build configuration for bundling demo web app
└── demo/
    ├── DEMO_DESIGN.md          # Design specification (this document)
    ├── demo_server.py          # Main Python web server & signaling daemon
    ├── src/                    # Frontend TypeScript source for demo web app
    │   ├── index.ts            # Main application logic and UI event handlers
    │   ├── index.html          # Single-page HTML layout
    │   ├── style.css           # Styling for demo UI dashboard
    │   ├── ImpairmentController.ts # Software packet loss simulator wrapper
    │   ├── FileTransferEngine.ts   # Chunking, hashing, and reassembly manager
    │   └── TelemetryUI.ts      # Live dashboard metrics updating
    └── static/                 # Compiled frontend assets served by demo_server.py
        ├── index.html
        └── assets/
            ├── index-*.js
            └── index-*.css
```

---

## 7. Developer Code Examples

To serve as an educational example for programmers integrating `libPharosRTC`, the demo code illustrates standard usage patterns.

### 7.1 Browser Frontend Usage (TypeScript)
```typescript
import { ResilientLinkClient } from 'libpharosrtc';

// Initialize client with WebWorker for unthrottled background timers
const client = new ResilientLinkClient(undefined, undefined, true);

// Configure receive handlers
client.onReceive(0, (payload) => {
  console.log('Received C2 command:', new TextDecoder().decode(payload));
});

client.onReceive(2, (payload) => {
  console.log('Received bulk file chunk:', payload.byteLength, 'bytes');
});

// Connect to demo server WebRTC signaling endpoint
await client.connect('ws://127.0.0.1:2500/ws/webrtc');

// Send file over ChID 2 (Bulk channel)
client.sendBlob(2, fileBlob);

// Retrieve live ARQ and FEC statistics
const stats = client.getStats(2);
console.log(`SRTT: ${stats.smoothedRttMs}ms, Retx: ${stats.retransmissions}, FEC Recoveries: ${stats.fecRecoveries}`);
```

### 7.2 Embedded Backend Usage (Python)
```python
import asyncio
from link import ResilientLink

link = ResilientLink()

# Handle incoming commands on ChID 0 (C2)
def handle_c2(payload: bytes):
    print(f"Received C2: {payload.decode('utf-8')}")
    # Preemptively send response back
    link.send(0, b"C2_ACK")

# Handle bulk data transfer on ChID 2
def handle_bulk(payload: bytes):
    file_transfer_engine.process_chunk(payload)

link.on_receive(0, handle_c2)
link.on_receive(2, handle_bulk)

# Option A: Standalone signaling server
await link.start_signaling(host="127.0.0.1", port=2500)

# Option B: Direct SDP offer handling in an existing web server (as used in demo_server.py)
# answer_sdp = await link.accept_offer(offer_sdp, client_ip=client_ip)
```

---

## 8. Build & Implementation Steps

1. **Frontend Build Pipeline**:
   - Add `npm run build:demo` script to `package.json` using `vite.config.demo.ts`.
   - Bundles TS code in `demo/src/` into a lightweight, standalone static JS file in `demo/static/`.

2. **Server Implementation (`demo/demo_server.py`)**:
   - Uses `aiohttp` to serve static files from `demo/static/` at `http://127.0.0.1:<port>/`.
   - Handles WebSocket signaling at `ws://127.0.0.1:<port>/ws/webrtc`.
   - Integrates `ResilientLink` with loss simulation wrappers.

3. **Validation & Testing**:
   - Verify server launches and prints `http://127.0.0.1:2500`.
   - Open Chrome, connect, adjust packet loss slider to 20%, and run a 10 MB upload/download test.
   - Confirm real-time updates for ARQ retransmissions and XOR parity reconstitution counts.
