
# libPharosRTC: Resilient Browser-to-Embedded Transport over High-BER IP Links

## 1. System Overview & Goals

This document specifies a reusable, zero-install browser-to-embedded transport protocol designed to operate reliably across degraded IP links—ranging from **high-BER, low-RTT terrestrial RF links** (no MAC-layer ARQ, tens of milliseconds RTT) to **variable-latency satellite links** (e.g., Starlink, ~25–80 ms nominal RTT with periodic weather/handover fades and spikes).

### Core Architectural Decisions
1. **Zero-Install Browser Endpoint:** Uses standard browser `RTCPeerConnection` and `RTCDataChannel` configured in **unordered, unreliable** mode (`ordered: false, maxRetransmits: 0`) to pass raw datagrams without browser-level head-of-line blocking or TCP congestion collapse.
2. **Offline / Isolated IP Operation:** Operates without STUN or TURN servers (`iceServers: []`) using host ICE candidates and an embedded **ICE-Lite** responder. Signaling reuses the device's existing **NGINX + Python WebSocket** stack.
3. **Small-Frame Discipline:** Enforces a strict, configurable application Maximum Transmission Unit (**App-MTU**, default `220 bytes`) so every frame fits inside a single unfragmented UDP/IP packet. This prevents catastrophic packet-loss amplification on high-BER links where $P(\text{success}) = (1 - \text{BER})^N$.
4. **Priority-Multiplexed Selective Repeat ARQ:** Implements a custom framing, priority scheduler, and Selective Repeat ARQ engine above the unreliable DataChannel, supporting multiple logical channels with distinct delivery guarantees (`RELIABLE_ORDERED` and `UNRELIABLE_UNORDERED`) and strict priority preemption so bulk file transfers never starve low-latency Command & Control (C2).

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

### Session Lifecycle & Preemption

* **Single Active Session:** The embedded server enforces a single active control session. If a new browser client completes a WebSocket signaling handshake while a previous session is active (or stale due to RF blackout), the server tears down the old transport context, resets ARQ state, and binds to the new peer.
* **Signaling Flow:**
   1. Browser loads static SPA from `NGINX` (`HTTP/HTTPS`).
   2. Browser opens WebSocket to `NGINX` (`/ws/webrtc`), which proxies to the local Python signaling daemon.
   3. Browser creates `RTCPeerConnection({ iceServers: [] })`, opens a single `RTCDataChannel("link", { ordered: false, maxRetransmits: 0 })`, generates an SDP Offer, waits for ICE host candidate gathering completion (or trickles candidates), and sends `{ type: "offer", sdp: ... }` over WebSocket.
   4. Embedded device replies with `{ type: "answer", sdp: ... }` containing its host IP/UDP port, ICE-Lite credentials, and self-signed ECDSA P-256 certificate SHA-256 fingerprint.
   5. Browser performs STUN Binding connectivity check -> DTLS 1.2 handshake -> SCTP `INIT`/`COOKIE-ECHO` -> DataChannel `OPEN`.



---

## 3. Configurable Link Profiles

Because the transport must operate over both low-RTT terrestrial RF and higher-latency Starlink links, all timing and framing parameters are driven by a runtime `LinkConfig` object negotiated or loaded at startup:

| Parameter | Description | Terrestrial High-BER Profile | Starlink Profile |
| --- | --- | --- | --- |
| `app_mtu_bytes` | Max total wire frame size (header + payload) | `200` – `256` B | `512` – `900` B |
| `window_size_pkts` | Max unacknowledged packets per reliable channel | `32` | `64` – `128` |
| `initial_rto_ms` | Initial Retransmission Timeout | `60` ms | `180` ms |
| `min_rto_ms` | Minimum clamped RTO | `30` ms | `100` ms |
| `max_rto_ms` | Maximum clamped RTO | `1000` ms | `3000` ms |
| `ack_delay_ms` | Max hold time before sending standalone ACK | `10` ms | `25` ms |
| `keepalive_ms` | Heartbeat interval when idle (carries latest ACKs) | `200` ms | `500` ms |
| `fec_xor_group` | Optional XOR parity packet every $K$ bulk frames (`0`=off) | `4` (optional) | `0` (off) |

---

## 4. Wire Protocol Specification

Every message passed to `RTCDataChannel.send()` is a single binary frame strictly bounded by `app_mtu_bytes`. All multi-byte integers are **Big-Endian (network byte order)**.

### 4.1 Frame Header Layout (14 Bytes Fixed)

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Ver|Flags| ChID|   Reserved    |         Payload Length        |
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
* `0x2` (`FLAG_ACK_ONLY`): Frame carries no application payload (`Payload Length == 0`), used solely to advance ACKs/SACKs.
* `0x4` (`FLAG_MSG_END`): Marks the final fragment of a multi-frame application message or bulk file chunk.


* **`ChID` (3 bits):** Logical Channel ID (`0..7`). Lower numeric `ChID` = higher scheduling priority (`ChID 0` is highest).
* **`Reserved` (8 bits):** Reserved for future use (`0x00`), or carries `AckChID` (the channel ID to which the piggybacked ACK/SACK fields apply). *Note: Using these 8 bits as `AckChID` allows a data frame on `ChID 2` (Bulk) to acknowledge packets on `ChID 0` (C2) or vice versa.*
* **`Payload Length` (16 bits):** Byte length of payload (`0` to `app_mtu_bytes - 14`).
* **`Sequence Number` (32 bits):** Monotonically increasing packet sequence number per channel (wraps modulo $2^{32}$ using serial number arithmetic).
* **`Cumulative ACK Sequence` (32 bits):** Highest contiguous sequence number received in-order on `AckChID`.
* **`SACK Bitmask` (16 bits):** Bit $i$ ($0 \le i < 16$) is `1` if packet `Cumulative_ACK + 1 + i` has been received out-of-order on `AckChID`.

### 4.2 Logical Channel Configuration API

Users configure channels symmetrically on both endpoints via a declarative channel table:

```json
[
  { "id": 0, "name": "c2",        "mode": "RELIABLE_ORDERED",     "priority": 0, "window": 16 },
  { "id": 1, "name": "telemetry", "mode": "UNRELIABLE_UNORDERED", "priority": 1, "window": 0  },
  { "id": 2, "name": "bulk_xfer", "mode": "RELIABLE_ORDERED",     "priority": 2, "window": 64 }
]

```

---

## 5. Priority Multiplexer & Selective Repeat ARQ Engine

Both the Browser (TypeScript) and Embedded Server (Python or C++) execute the exact same state machine logic.

### 5.1 Transmission & Priority Scheduler

1. **Message Segmentation:** When the application submits a message (e.g., a 64-byte C2 command or a 5 MB file stream) to channel $C$:
   * It is sliced into chunks of size `max_payload = app_mtu_bytes - 14`.
   * The final chunk of a discrete message is tagged with `FLAG_MSG_END`.

2. **Strict Priority + Deficit Round-Robin (DRR) Dequeue:**
   * Whenever the underlying DataChannel buffer is below its low-water mark (`bufferedAmount < 4 * app_mtu_bytes`), the scheduler selects the next frame to transmit in strict priority order:
      1. **Expired Retransmissions** on highest-priority channel first (`ChID 0` -> `ChID 1` -> ...).
      2. **New Outbound Frames** (within the channel's `window_size_pkts` limit) on highest-priority channel first.
      3. **Standalone `FLAG_ACK_ONLY` Frames** if an ACK timer expired and no outbound data frame piggybacked the ACK.

   * Because `ChID 0` (C2) always preempts `ChID 2` (Bulk), a 10 MB file upload will yield within **1 frame time** (~1–2 ms) whenever a C2 command or retransmission is queued.



### 5.2 Selective Repeat ARQ & Self-Healing ACKs

* **Sender Window:** Maintains a ring buffer of unacknowledged `SentSlot` entries (`seq`, `payload`, `flags`, `first_sent_ts`, `last_sent_ts`, `retransmit_count`).
* **Receiver Window:** Maintains `next_expected_seq` and an out-of-order reorder buffer up to `window_size_pkts`.
* When an in-order frame arrives (`seq == next_expected_seq`), it and any contiguous buffered frames are immediately reassembled (up to `FLAG_MSG_END`) and delivered to the upper layer.
* When an out-of-order frame arrives (`seq > next_expected_seq`), it is stored in the reorder buffer and the corresponding bit in the 16-bit SACK mask is set.


* **Piggybacked & Self-Healing ACKs:** Every outgoing frame stamps the current `Cumulative ACK` and `SACK Bitmask` for the most recently active remote channel (rotating across active channels). Because every ACK carries the full cumulative state + 16-packet bitmask, **losing an ACK packet on the RF link causes zero stalls**—the next surviving frame automatically heals the sender's window state.
* **Adaptive RTO (No Congestion Collapse):**
* Unlike TCP, **packet loss does NOT halve the congestion window or trigger exponential backoff**.
* RTO is updated strictly from clean (non-retransmitted) RTT samples using Jacobson/Karels smoothing (`SRTT`, `RTTVAR`), clamped between `[min_rto_ms, max_rto_ms]`.
* When `now - slot.last_sent_ts >= RTO`, **only that specific missing `seq**` is retransmitted (Selective Repeat), keeping the rest of the window flowing.



---

## 6. Browser-Side Implementation (TypeScript / WebWorker)

Running the ARQ timers inside a dedicated **WebWorker** is strongly recommended so browser UI rendering or background tab throttling (`setTimeout` clamping to 1000 ms in inactive tabs) does not stall RF retransmissions.

### 6.1 Key Components

* `SignalingClient.ts`: Connects to `wss://<device-ip>/ws/webrtc`, handles SDP Offer/Answer JSON exchange, and reconnects automatically if the WebSocket drops.
* `WebRtcTransport.ts`:
* Creates `new RTCPeerConnection({ iceServers: [] })`.
* Creates `pc.createDataChannel("link", { ordered: false, maxRetransmits: 0 })` with `binaryType = "arraybuffer"`.
* Monitors `iceConnectionState` (`disconnected` / `failed` triggers immediate WebSocket re-signaling).


* `ArqWorker.ts`:
* Runs a high-resolution `10 ms` tick loop (`setInterval` inside Worker is unthrottled by tab visibility).
* Serializes/deserializes the 14-byte header via `DataView`.
* For bulk file uploads (`File` / `Blob`), reads slices on demand via `file.slice(offset, offset + chunkSize).arrayBuffer()` only when the `bulk_xfer` channel's send window has free slots—preventing browser RAM exhaustion on large files.



---

## 7. Embedded Server Architecture: Option A (Python 3)

Best suited for rapid iteration and unified integration with the existing Python WebSocket server on Yocto ARM.

### 7.1 Yocto Dependencies

Add to your Yocto image recipe (`IMAGE_INSTALL:append`):

* `python3-aiortc` (provides `RTCPeerConnection`, `RTCDataChannel`, `aioice`, `pylibsrtp`, and OpenSSL DTLS bindings)
* `python3-aiohttp` or `python3-websockets` (for the signaling endpoint behind NGINX)
* `python3-cryptography` (for loading the persistent self-signed ECDSA certificate)

### 7.2 Implementation Architecture

```text
NGINX (:80/:443) --[WebSocket /ws/webrtc]--> Python asyncio Process
                                                |-- Signaling Handler (JSON SDP)
                                                |-- aiortc RTCPeerConnection (UDP Ephemeral Port)
                                                |-- ArqMuxEngine (asyncio.Task 5ms tick + struct.Struct)
                                                +-- App Handlers (C2 IPC / File Streamer)

```

### 7.3 Python-Specific Implementation Details

1. **Persistent ECDSA Certificate:** Generate a self-signed P-256 certificate once on first boot (`/etc/device/webrtc_cert.pem` & `webrtc_key.pem`) and pass it to `RTCCertificate.load_pem(...)`. Avoids ~500 ms keygen latency per connection on ARM.
2. **Preventing `aiortc` SCTP Fragmentation:** `aiortc`'s `RTCSctpTransport` fragments messages larger than ~1200 bytes. Because `ArqMuxEngine` strictly bounds every `channel.send(frame_bytes)` call to `app_mtu_bytes <= 900`, `aiortc` emits every frame as a single, unfragmented UDP packet.
3. **Zero-Copy Framing:** Pre-compile `HEADER_STRUCT = struct.Struct("!BBHIII")` (adjusted to 14 bytes: `!BBHIIH`) and use `memoryview` slicing for bulk file transfers so chunks are read directly from disk into frame buffers without intermediate copies.
4. **In-Process vs. IPC Coupling:** Because the signaling WebSocket server is already Python, running `aiortc` and `ArqMuxEngine` in the **same `asyncio` event loop** eliminates IPC serialization overhead between signaling and WebRTC.

---

## 8. Embedded Server Architecture: Option B (C++17 + `mbedTLS` + Custom Shim)

Best suited if you want a standalone, reusable C++ library (`libresilient_link.so`) with minimal runtime footprint, deterministic sub-millisecond timing, and explicit control over DTLS handshake retransmission timers and MTU clamping.

### 8.1 Architecture & Minimal Custom Shim Breakdown

Rather than pulling in heavy dependencies (`usrsctp`, `libnice`, `OpenSSL`), a point-to-point browser-to-device server only needs **three minimal components** layered over a single non-blocking POSIX UDP socket (`epoll` / `io_uring`):

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
|  - Tuned handshake timeout: mbedtls_ssl_conf_handshake_timeout()  |
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

### 8.2 How the Minimal Shim Works

1. **RFC 7983 Packet Demultiplexing:**
On the single bound UDP port, every `recvfrom()` peeks at `buf[0]`:
   * `0x00..0x03`: **STUN packet.** The ICE-Lite responder verifies `USERNAME` (`local_ufrag:remote_ufrag`), computes `MESSAGE-INTEGRITY` (HMAC-SHA1 using `local_pwd`) and `CRC32` `FINGERPRINT`, and immediately replies with a STUN `Binding Success Response` containing `XOR-MAPPED-ADDRESS`.
   * `0x14..0x3F` (`20..63`): **DTLS packet.** Fed directly into `mbedTLS` via custom `f_recv` BIO callback.

2. **`mbedTLS` DTLS 1.2 Configuration:**
   * Configure `MBEDTLS_SSL_TRANSPORT_DATAGRAM` with `mbedtls_ssl_cookie_setup()` for DoS protection.
   * Load the device's persistent ECDSA P-256 certificate and export its SHA-256 fingerprint (`XX:XX:...`) to the Python signaling service via a lightweight local UNIX domain socket (`/run/webrtc_link.sock`).
   * Tune handshake timers specifically for high-BER links:
```cpp
// Aggressive initial retry (250ms) capped at 2000ms so lost handshake
// flights recover rapidly without waiting for default 1s->2s->4s backoff.
mbedtls_ssl_conf_handshake_timeout(&conf, 250, 2000);
mbedtls_ssl_set_mtu(&ssl, link_config.app_mtu_bytes + 64);

```


3. **Minimal SCTP + DCEP Shim (~600 LOC):**
Because the browser opens a single unreliable, unordered DataChannel and our ARQ engine handles all reliability above it, the C++ SCTP shim does **not** need full congestion control, stream reassembly, or retransmission queues:
   * **Handshake:** Responds to browser `INIT` with `INIT-ACK` (advertising `Forward-TSN` support), echoes `COOKIE-ECHO` with `COOKIE-ACK`.
   * **DCEP:** Parses the browser's `DATA_CHANNEL_OPEN` message (`0x03`) on Stream 0 and replies with `DATA_CHANNEL_ACK` (`0x02`).
   * **Data Path:**
      * *Inbound:* Extracts payload from SCTP `DATA` chunks (`type == 0x00`, PPID `53` binary) and passes directly to `ArqMuxEngine::on_wire_frame()`. Sends periodic `SACK` chunks advertising the latest received TSN so the browser's SCTP sender window never stalls.
      * *Outbound:* Wraps `ArqMuxEngine` frames in a single SCTP `DATA` chunk (`B=1, E=1, U=1` unordered flags, incrementing TSN) and passes to `mbedtls_ssl_write()`. If `SACK` indicates a gap, emits a `FORWARD-TSN` (`0xC0`) chunk so the browser immediately advances its receive window without blocking.





### 8.3 Signaling Bridge with Existing Python WebSocket Server

To keep NGINX and your existing Python WebSocket server untouched, the C++ daemon exposes a local UNIX socket (`/run/resilient_link.sock`) accepting simple JSON-RPC commands from Python:

* `{"cmd": "create_session", "offer_sdp": "..."}` -> returns `{"answer_sdp": "..."}`
* `{"cmd": "set_profile", "profile": "starlink" | "terrestrial_rf"}` -> updates `LinkConfig` live.

---

## 9. Reusable C++ / Python Library Interface

Both implementations expose an identical conceptual API so the library can be dropped into future embedded products:

```cpp
struct ChannelConfig {
    uint8_t id;
    DeliveryMode mode;      // RELIABLE_ORDERED | UNRELIABLE_UNORDERED
    uint8_t priority;       // 0 = highest
    uint16_t window_size;   // ignored for UNRELIABLE_UNORDERED
};

class ResilientLink {
public:
    explicit ResilientLink(const LinkConfig& link_cfg,
                           const std::vector<ChannelConfig>& channels);

    // Signaling hook (called by WebSocket handler)
    std::string accept_offer(std::string_view offer_sdp);

    // Application Data API
    bool send(uint8_t channel_id, std::span<const uint8_t> payload);
    void on_receive(uint8_t channel_id,
                    std::function<void(std::span<const uint8_t>)> cb);

    // Diagnostics & Telemetry
    struct Stats {
        uint64_t tx_frames;
        uint64_t rx_frames;
        uint64_t retransmissions;
        uint32_t smoothed_rtt_ms;
        float estimated_packet_loss;
    };
    Stats get_stats(uint8_t channel_id) const;
};

```

---

## 10. Verification & Testing Plan

Before field deployment over customer RF or Starlink hardware, validate the transport under controlled impairment using Linux `tc netem` on the Yocto device:

1. **Terrestrial High-BER Simulation:**
   * *Pass Criteria:* C2 commands maintain `< 60 ms` p99 latency while a simultaneous 5 MB file upload completes without stalls or disconnects.

```bash
tc qdisc add dev eth0 root netem delay 15ms 3ms loss 12%

```

2. **Starlink Handover & Rain-Fade Simulation:**
   * *Pass Criteria:* Adaptive RTO tracks variable latency without spurious retransmission storms; bulk transfer throughput adapts smoothly.

```bash
tc qdisc change dev eth0 root netem delay 45ms 20ms distribution normal loss 3%

```

3. **Complete RF Blackout (5-Second Drop):**
   * Drop 100% of UDP packets for 5 seconds, then restore.
   * *Pass Criteria:* WebRTC ICE/DTLS session remains alive (DTLS consent/keepalive > 5s), and both C2 and bulk channels resume automatically from their exact last acknowledged sequence numbers.



