# libPharosRTC: Resilient Browser-to-Embedded Transport over High-BER IP Links

## 1. System Overview & Goals

This document specifies a reusable, zero-install browser-to-embedded transport protocol designed to operate reliably across degraded IP links—ranging from **high-BER, low-RTT terrestrial RF links** (no MAC-layer ARQ, tens of milliseconds RTT) to **variable-latency satellite links** (e.g., Starlink, ~25–80 ms nominal RTT with periodic weather/handover fades and spikes).

### Core Architectural Decisions
1. **Zero-Install Browser Endpoint:** Uses standard browser `RTCPeerConnection` and `RTCDataChannel` configured in **unordered, unreliable** mode (`ordered: false, maxRetransmits: 0`) to pass raw datagrams without browser-level head-of-line blocking or TCP congestion collapse.
2. **Offline / Isolated IP Operation:** Operates without STUN or TURN servers (`iceServers: []`) using host ICE candidates and an embedded **ICE-Lite** responder. Signaling reuses the device's existing **NGINX + Python WebSocket** stack.
3. **Small-Frame Discipline:** Enforces a strict, configurable application Maximum Transmission Unit (**App-MTU**, default `220 bytes`) so every frame fits inside a single unfragmented UDP/IP packet. This prevents catastrophic packet-loss amplification on high-BER links where $P(\text{success}) = (1 - \text{BER})^N$.
4. **Priority-Multiplexed Selective Repeat ARQ & In-band FEC:** Implements custom framing, a priority scheduler (`PriorityScheduler`), a Selective Repeat ARQ engine (`ArqEngine`), and an optional XOR-based Forward Error Correction engine (`FecEngine`) above the unreliable DataChannel. Supports multiple logical channels with distinct delivery guarantees (`RELIABLE_ORDERED` and `UNRELIABLE_UNORDERED`) and strict priority preemption so bulk file transfers never starve low-latency Command & Control (C2).

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
|  | Priority Scheduler & ARQ    |  |               |  | Priority Scheduler & ARQ    |  |
|  | Engine + FEC Engine         |  |               |  | Engine + FEC Engine         |  |
|  | (TS / WebWorker / Main)     |  |               |  | (Python 3 asyncio or C++17) |  |
|  +--------------+--------------+  |               |  +--------------+--------------+  |
|                 |                 |               |                 |                 |
|  +--------------v--------------+  |  WebSocket    |  +--------------v--------------+  |
|  |     Browser WebRTC Stack    |<-+---Signaling-->|  |   NGINX -> Python WS Server |  |
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

### Session Lifecycle & Preemption

* **Single Active Session & Session Preemption:** The embedded server enforces a single active control session. If a new browser client completes a WebSocket signaling handshake while a previous session is active (or stale due to an RF blackout), the server tears down the old `RTCPeerConnection`, resets the ARQ state, and binds to the new peer.
* **Signaling Flow:**
   1. Browser loads static Web app from `NGINX` (`HTTP/HTTPS`).
   2. Browser opens WebSocket to `ws://<device-ip>:8765/ws/webrtc` (or via NGINX proxy), connected to Python `SignalingServer`.
   3. Browser creates `RTCPeerConnection({ iceServers: [] })`, opens a single `RTCDataChannel("link", { ordered: false, maxRetransmits: 0 })`, generates an SDP Offer, gathers ICE host candidates, and sends `{"type": "offer", "sdp": "..."}` over WebSocket.
   4. Embedded device replies with `{"type": "answer", "sdp": "..."}` containing its host IP/UDP port, ICE-Lite credentials, and persistent ECDSA P-256 certificate SHA-256 fingerprint.
   5. Browser performs STUN Binding connectivity check -> DTLS 1.2 handshake -> SCTP `INIT`/`COOKIE-ECHO` -> DataChannel `OPEN`.

---

## 3. Configurable Link Profiles

All timing, MTU, and FEC parameters are driven by a runtime `LinkConfig` structure (snake_case in Python, camelCase in TypeScript):

| Parameter (Python / TS) | Description | Terrestrial High-BER Profile | Starlink Profile |
| --- | --- | --- | --- |
| `app_mtu_bytes` / `appMtuBytes` | Max total wire frame size (header + payload) | `220` B | `900` B |
| `window_size_pkts` / `windowSizePkts` | Max unacknowledged packets per reliable channel | `32` | `64` |
| `initial_rto_ms` / `initialRtoMs` | Initial Retransmission Timeout | `60` ms | `180` ms |
| `min_rto_ms` / `minRtoMs` | Minimum clamped RTO | `30` ms | `100` ms |
| `max_rto_ms` / `maxRtoMs` | Maximum clamped RTO | `1000` ms | `3000` ms |
| `ack_delay_ms` / `ackDelayMs` | Max hold time before sending standalone ACK | `10` ms | `25` ms |
| `keepalive_ms` / `keepaliveMs` | Heartbeat interval when idle | `200` ms | `500` ms |
| `fec_xor_group` / `fecXorGroup` | XOR parity packet every $K$ data frames (`0`=off) | `4` | `0` (off) |

---

## 4. Wire Protocol Specification

Every message passed to `RTCDataChannel.send()` is a single binary frame strictly bounded by `app_mtu_bytes` (default `220 bytes`). All multi-byte integers are **Big-Endian (network byte order)**.

### 4.1 Frame Header Layout (14 Bytes Fixed)

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Ver|Flags| ChID|    AckChID    |         Payload Length        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Sequence Number                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Cumulative ACK Sequence                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Selective ACK (SACK) Bitmask (16b)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Payload (0..N bytes)                    |
~                               ...                             ~
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

* **`Ver` (2 bits):** Protocol version (`0x1`).
* **`Flags` (3 bits):**
  * `0x1` (`FLAG_SYN`): Channel state reset / epoch synchronization.
  * `0x2` (`FLAG_ACK_ONLY`): Frame carries no application payload (`Payload Length == 0`), used solely to advance ACKs/SACKs or carry FEC parity payloads.
  * `0x4` (`FLAG_MSG_END`): Marks the final fragment of a multi-frame application message or bulk file chunk.
* **`ChID` (3 bits):** Logical Channel ID (`0..7`). Lower numeric `ChID` = higher scheduling priority (`ChID 0` is highest).
* **`AckChID` (8 bits):** Target channel ID (`0..7`) to which the piggybacked `Cumulative ACK Sequence` and `SACK Bitmask` apply. For FEC parity frames, bit 7 (`0x80`) is set to `FLAG_FEC_PARITY`.
* **`Payload Length` (16 bits):** Byte length of frame payload (`0` to `app_mtu_bytes - 14`).
* **`Sequence Number` (32 bits):** Monotonically increasing packet sequence number per channel (wraps modulo $2^{32}$ using serial number arithmetic).
* **`Cumulative ACK Sequence` (32 bits):** Highest contiguous sequence number received in-order on `AckChID`.
* **`SACK Bitmask` (16 bits):** Bit $i$ ($0 \le i < 16$) is `1` if packet `Cumulative_ACK + 1 + i` has been received out-of-order on `AckChID`.

### 4.2 Logical Channel Configuration API

Channels are configured symmetrically on both endpoints via a channel list:

```json
[
  { "id": 0, "name": "c2",        "mode": "RELIABLE_ORDERED",     "priority": 0, "windowSize": 16 },
  { "id": 1, "name": "telemetry", "mode": "UNRELIABLE_UNORDERED", "priority": 1, "windowSize": 0  },
  { "id": 2, "name": "bulk_xfer", "mode": "RELIABLE_ORDERED",     "priority": 2, "windowSize": 64 }
]
```

---

## 5. Priority Multiplexer, Selective Repeat ARQ & FEC Engine

Both the Browser (TypeScript) and Embedded Server (Python 3) execute identical state machine and codec logic.

### 5.1 Transmission & Priority Scheduler (`PriorityScheduler`)

1. **Message Segmentation:** When an application submits a message (e.g. a 64-byte C2 command or a 5 MB file stream) to channel $C$:
   * Sliced into chunks of size `max_payload = app_mtu_bytes - 14`.
   * The final chunk of a discrete message is tagged with `FLAG_MSG_END`.
2. **Strict Priority Dequeue Order:**
   * When `bufferedAmount < 4 * app_mtu_bytes`, frames are dequeued in strict channel priority order (sorted by `priority` ascending):
      1. **Expired Retransmissions** on highest-priority channel first (`ChID 0` -> `ChID 1` -> ...).
      2. **New Outbound Frames** (respecting channel `windowSize` in-flight limits for `RELIABLE_ORDERED`) on highest-priority channel first.
      3. **Standalone `FLAG_ACK_ONLY` Frames** if an ACK timer expired or receiver state needs to be updated.
   * Because `ChID 0` (C2) preempts `ChID 2` (Bulk), high-priority commands yield within **1 frame time** (~1–2 ms).

### 5.2 Selective Repeat ARQ & Self-Healing ACKs (`ArqEngine`)

* **Sender Window:** Maintains a map of unacknowledged `SentSlot` entries (`seq`, `frame`, `firstSentTs`, `lastSentTs`, `retransmitCount`, `acked`).
* **Receiver Window:** Tracks `nextExpectedSeq` and reorder buffer.
  * In-order frames (`seq == nextExpectedSeq`) are immediately reassembled up to `FLAG_MSG_END` and delivered to callbacks.
  * Out-of-order frames (`seq > nextExpectedSeq`) are held in the reorder buffer and set the corresponding bit in the 16-bit SACK mask.
* **Piggybacked & Self-Healing ACKs:** Every outgoing frame stamps `AckChID`, `Cumulative ACK`, and `SACK Bitmask`. Because every frame carries full cumulative state + 16-packet bitmask, losing ACK packets on the RF link causes zero stalls—the next surviving frame heals the sender's window.
* **Adaptive RTO (Jacobson/Karels):**
  * Updated strictly from clean (non-retransmitted) RTT samples (`retransmitCount == 0`).
  * Formula: $\text{RTTVAR} = (1 - \beta) \cdot \text{RTTVAR} + \beta \cdot |\text{SRTT} - \text{RTT}|$, $\text{SRTT} = (1 - \alpha) \cdot \text{SRTT} + \alpha \cdot \text{RTT}$ (where $\alpha = 0.125, \beta = 0.25$).
  * $\text{RTO} = \text{SRTT} + 4 \cdot \text{RTTVAR}$, clamped between `[min_rto_ms, max_rto_ms]`.
  * Selective retransmission queues only the specific timed-out frame.

### 5.3 Forward Error Correction (`FecEngine`)

* **In-band XOR Parity:** When `fecXorGroup` $K > 0$ (default $K=4$ on high-BER links):
  * `FecEncoder` aggregates $K$ data frames, computes bitwise XOR across their payloads, and constructs a parity payload:
    * `groupSeqStart` (uint32, 4B) + `groupSize` (uint16, 2B) + XOR parity bytes.
  * Emits a parity frame with `flags = FLAG_ACK_ONLY` and `ackChid = (ackChid & 0x7F) | 0x80` (`FLAG_FEC_PARITY`).
  * `FecDecoder` tracks received frames per group. If exactly 1 data frame in group $K$ is lost, XORing the parity payload with the $K-1$ present data payloads recovers the missing payload instantly without waiting for an RTO timeout.

---

## 6. Browser-Side Implementation (TypeScript)

### 6.1 Architecture & Components

* `config.ts`: `LinkConfig`, `ChannelConfig`, profiles (`TERRESTRIAL_HIGH_BER_PROFILE`, `STARLINK_PROFILE`), and `DEFAULT_CHANNELS`.
* `FrameCodec.ts`: Binary header encoding and decoding via `DataView` with 100% network byte order equivalence.
* `PriorityScheduler.ts`: Priority queues (`newFrameQueues`, `retransmitQueues`), sequence assignment, and low-water mark checking.
* `ArqEngine.ts`: ARQ state machine, sliding window, SACK bitmask calculation, and Jacobson/Karels RTO.
* `FecEngine.ts`: XOR `FecEncoder` and `FecDecoder` logic.
* `SignalingClient.ts`: Manages WebSocket signaling (`ws://<ip>:8765/ws/webrtc`), automatic reconnection, and SDP Offer/Answer JSON exchange.
* `WebRtcTransport.ts`: Wraps browser `RTCPeerConnection` (`iceServers: []`) and unordered `RTCDataChannel("link", { ordered: false, maxRetransmits: 0 })`.
* `ArqWorker.ts`: `ArqWorkerHandler` running an unthrottled `10 ms` timer tick loop inside WebWorker scope. Handles `sendBlob` streaming via 64KB on-demand slices checked against send window capacity (`inFlight < 16`).
* `ResilientLinkClient.ts`: Main frontend entry point supporting main-thread or WebWorker execution (`useWorker: true/false`).

---

## 7. Embedded Server Architecture: Python 3 Backend

### 7.1 Component Architecture

* `config.py`: Link profiles and channel configurations.
* `frame_codec.py`: Header packing via `struct.Struct("!BBHIIH")` and `memoryview` slicing.
* `priority_scheduler.py`: Strict priority dequeue and in-flight tracking.
* `arq_engine.py`: Python `ArqEngine` implementation matching TypeScript behavior.
* `fec_engine.py`: Python `FecEncoder` and `FecDecoder`.
* `webrtc_backend.py`: `WebRtcBackend` wrapping `aiortc.RTCPeerConnection` and `RTCDataChannel`.
  * Runs a `5 ms` outbound task tick loop (`asyncio.sleep(0.005)`).
  * Uses `cryptography` to generate or load persistent ECDSA P-256 certificates from `/tmp/webrtc_cert.pem` & `/tmp/webrtc_key.pem`.
  * Supports session preemption: new WebSocket offers automatically close stale connections and reinitialize `ArqEngine`.
* `signaling_server.py`: `SignalingServer` using `websockets` serving `ws://0.0.0.0:8765/ws/webrtc`.
* `link.py`: `ResilientLink` high-level facade.

---

## 8. Embedded Server Architecture: Option B (C++17 + `mbedTLS` + Custom Shim)

For native C++ embedded deployment, `libPharosRTC` specifies a zero-dependency architecture over POSIX UDP sockets:

```text
+-------------------------------------------------------------------+
|                     C++17 Application / API                       |
|        send(ch_id, span<const byte>) / on_message(callback)       |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|                   Priority Mux & ARQ Engine (C++17)               |
|         Fixed-size Ring Buffers, Bitmask SACK, Timer Wheel        |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|                 Minimal SCTP-over-DTLS Shim (~600 LOC)            |
|  - Handles SCTP INIT / COOKIE-ECHO / HEARTBEAT / SHUTDOWN         |
|  - Handles DCEP (DataChannel Establishment Protocol) OPEN/ACK     |
|  - Wraps/unwraps DATA chunks with Forward-TSN (RFC 3758)          |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|                      mbedTLS 3.x (DTLS 1.2)                       |
|  - ECDHE-ECDSA-AES128-GCM-SHA256                                  |
|  - Custom BIO callbacks (udp_send / udp_recv)                     |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|               Minimal ICE-Lite Demuxer (~250 LOC)                 |
|  - Inspects first byte of incoming UDP datagram (RFC 7983):       |
|      [0..3]   -> STUN Binding Request (HMAC-SHA1 + FINGERPRINT)   |
|      [20..63] -> DTLS Record (passed to mbedTLS BIO)              |
+---------------------------------+---------------------------------+
                                  |
                         POSIX UDP Socket (IPv4)
```

---

## 9. Library API Specification

### TypeScript Client API (`ResilientLinkClient`)

```typescript
export class ResilientLinkClient {
  constructor(
    linkConfig?: LinkConfig,
    channelConfigs?: ChannelConfig[],
    useWorker?: boolean
  );

  connect(signalingUrl: string): Promise<void>;
  send(chid: number, payload: Uint8Array): void;
  sendBlob(chid: number, blob: Blob): void;
  onReceive(chid: number, cb: (payload: Uint8Array) => void): void;
  getStats(chid: number): ArqStats;
  disconnect(): void;
}
```

### Python Server API (`ResilientLink`)

```python
class ResilientLink:
    def __init__(
        self,
        link_config: Optional[LinkConfig] = None,
        channel_configs: Optional[List[ChannelConfig]] = None,
        cert_path: str = "/tmp/webrtc_cert.pem",
        key_path: str = "/tmp/webrtc_key.pem",
    ): ...

    async def start_signaling(
        self, host: str = "0.0.0.0", port: int = 8765, path: str = "/ws/webrtc"
    ) -> None: ...

    async def accept_offer(self, offer_sdp: str) -> str: ...
    def send(self, channel_id: int, payload: Union[bytes, bytearray, memoryview]) -> bool: ...
    def on_receive(self, channel_id: int, callback: Callable[[bytes], None]) -> None: ...
    def get_stats(self, channel_id: int) -> ArqStats: ...
    async def close(self) -> None: ...
```

---

## 10. Verification & Testing Plan

1. **Unit Tests:**
   * TypeScript unit tests via Vitest: `npm test` (`tests/ts/`).
   * Python unit tests via Pytest: `venv/bin/pytest` (`tests/python/`).
2. **Cross-Language Equivalency Suite (`tests/python/test_cross_language.py`):**
   * Validates 100% byte-for-byte binary header serialization/deserialization between TypeScript and Python.
   * Validates identical dequeue ordering between TS `PriorityScheduler` and Python `PriorityScheduler`.
   * Validates cross-language message fragmentation/reassembly (`ArqEngine`) and FEC recovery (`FecEngine`).
3. **Impairment Suite (`scripts/run_impairment_tests.sh` & Playwright E2E):**
   * High BER simulation: `tc qdisc add dev eth0 root netem delay 15ms 3ms loss 12%`.
   * Starlink simulation: `tc qdisc change dev eth0 root netem delay 45ms 20ms distribution normal loss 3%`.
   * RF Blackout: 5-second 100% drop recovery test.
