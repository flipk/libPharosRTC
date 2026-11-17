# libPharosRTC Implementation Plan

This plan breaks down the implementation of **libPharosRTC** into clear, numbered phases. Each phase is designed to fit comfortably within a Gemini 3.5 Flash context window and includes explicit deliverables, technical specifications, and verification criteria.

---

## Architecture Overview & Decisions

- **Protocol Stack**: Browser (`RTCDataChannel` `ordered: false, maxRetransmits: 0`) $\leftrightarrow$ Python 3 (`aiortc`) Embedded Server.
- **Framing**: 14-byte binary header, strict App-MTU encapsulation (default 220B terrestrial / configurable).
- **ARQ**: Selective Repeat ARQ, 16-bit SACK bitmask, Jacobson/Karels adaptive RTO, self-healing piggybacked ACKs.
- **Multiplexing**: Strict priority preemption (ChID 0 C2 > ChID 1 Telemetry > ChID 2 Bulk) + Deficit Round-Robin.
- **Frontend Stack**: TypeScript + Vite + Vitest + Playwright (WebWorker timers).
- **Backend Stack**: Python 3 + `aiortc` + `aiohttp`/`websockets` + `cryptography`.

---

## Phase 1: Environment Setup & Core Wire Protocol (Binary Codec)

### Goal
Establish project repository layout, configuration profiles, and dual-language (TypeScript & Python) binary header serialization/deserialization with 100% byte-level equivalence.

### Specifications
- **Header Layout (14 Bytes, Big-Endian)**:
  - `Ver` (2 bits) | `Flags` (3 bits: `SYN=0x1`, `ACK_ONLY=0x2`, `MSG_END=0x4`) | `ChID` (3 bits: `0..7`)
  - `Reserved / AckChID` (8 bits: `0x00..0x07`)
  - `Payload Length` (16 bits)
  - `Sequence Number` (32 bits)
  - `Cumulative ACK Sequence` (32 bits)
  - `SACK Bitmask` (16 bits)
- **Link Profiles**: Terrestrial High-BER (`app_mtu` 200–256B, RTO 30–1000ms) and Starlink (`app_mtu` 512–900B, RTO 100–3000ms).

### Deliverables
1. **Repository Structure**:
   - `/src/ts/` (TypeScript source & worker)
   - `/src/python/` (Python libPharosRTC package)
   - `/tests/` (Vitest & pytest suites)
2. **Binary Codec (TS)**: `FrameCodec.ts` using `DataView` / `ArrayBuffer`.
3. **Binary Codec (Python)**: `frame_codec.py` using `struct.Struct("!BBHIIH")` and `memoryview`.
4. **Link & Channel Configurations**: Typed configuration definitions in both languages.

### Verification
- Cross-language round-trip unit tests: serialize frame in TS $\rightarrow$ parse in Python, and vice-versa.
- Boundary test for edge values (32-bit sequence wrapping, 16-bit bitmasks, zero/max payload lengths).

---

## Phase 2: Priority Multiplexer & Scheduling Engine

### Goal
Implement queue management and frame scheduling in both TypeScript and Python, guaranteeing strict preemption of low-latency Command & Control (C2) packets over bulk file transfers.

### Specifications
- **Channel Hierarchy**: Logical channels `0..7` (ChID 0 highest priority). Modes: `RELIABLE_ORDERED`, `UNRELIABLE_UNORDERED`.
- **Preemption Rule**: High-priority retransmissions > High-priority new frames > Low-priority frames > `FLAG_ACK_ONLY` frames.
- **Flow Control**: Limit outbound enqueue based on `bufferedAmount < 4 * app_mtu_bytes`.
- **ACK Piggybacking**: Auto-attach `Cumulative ACK` and `SACK Bitmask` of active channels to outgoing data frames, falling back to standalone `FLAG_ACK_ONLY` frames when idle.

### Deliverables
1. **Priority Mux (TS)**: `PriorityScheduler.ts`.
2. **Priority Mux (Python)**: `priority_scheduler.py`.
3. **Unit Tests**:
   - Priority preemption tests: assert ChID 0 frame is dequeued immediately when queued during a simulated ChID 2 bulk transfer stream.
   - Buffer low-water mark throttling tests.

### Verification
- Vitest & pytest suite asserting strict dequeue order and zero starvation of ChID 0.

---

## Phase 3: Selective Repeat ARQ & Adaptive RTO Engine

### Goal
Build the core Selective Repeat ARQ state machines, receiver reorder buffers, SACK processing, and Jacobson/Karels RTO estimator.

### Specifications
- **Sender Window**: Sliding window up to `window_size_pkts` per channel. Tracks `SentSlot` (`seq`, `payload`, `flags`, `last_sent_ts`, `retransmit_count`).
- **Adaptive RTO**:
  $$\text{SRTT} \leftarrow (1 - \alpha) \cdot \text{SRTT} + \alpha \cdot \text{RTT}$$
  $$\text{RTTVAR} \leftarrow (1 - \beta) \cdot \text{RTTVAR} + \beta \cdot |\text{SRTT} - \text{RTT}|$$
  $$\text{RTO} = \text{clamp}(\text{SRTT} + 4 \cdot \text{RTTVAR}, \text{min\_rto\_ms}, \text{max\_rto\_ms})$$
  *(Calculated exclusively on non-retransmitted frames).*
- **Receiver Buffer**: In-order delivery to upper layer up to `FLAG_MSG_END`. Out-of-order storage up to 16-bit SACK offset (`Cumulative ACK + 1 + i`).
- **Segmentation & Reassembly**: Slicing payloads to `max_payload = app_mtu_bytes - 14` and tagging final slice with `FLAG_MSG_END`.

### Deliverables
1. **ARQ Engine (TS)**: `ArqEngine.ts`.
2. **ARQ Engine (Python)**: `arq_engine.py`.
3. **Unit Tests**:
   - Out-of-order frame delivery and SACK generation.
   - Selective retransmission upon packet loss without resending in-order frames.
   - Message segmentation & multi-frame reassembly correctness.
   - RTO convergence under jittered RTT simulation.

### Verification
- Simulated loss tests (10% random drops): verify 100% data integrity, correct message boundaries, and adaptive RTO clamping.

---

## Phase 4: Python Embedded Server Stack (`aiortc` + Signaling)

### Goal
Build the Python embedded server daemon integrating persistent ECDSA certificates, NGINX-compatible WebSocket signaling, and `aiortc` transport management.

### Specifications
- **Certificate**: Persistent self-signed ECDSA P-256 certificate (`/etc/device/webrtc_cert.pem`) loaded via `python3-cryptography` / `RTCCertificate.load_pem()`.
- **Signaling**: WebSocket endpoint (`/ws/webrtc`) exchanging SDP Offer/Answer JSON payloads.
- **Session Preemption**: Single active session rule—tears down old session, resets ARQ state, and binds immediately when a new client connects.
- **Zero-Copy Optimization**: `memoryview` slicing for outbound buffer processing.
- **SCTP MTU Safety**: Keep every frame `channel.send()` $\le \text{app\_mtu\_bytes}$ to prevent `aiortc` internal fragmentation.

### Deliverables
1. **Signaling Server**: `signaling_server.py`.
2. **WebRTC Transport Backend**: `webrtc_backend.py`.
3. **ResilientLink Python API**: `link.py` exposing `send()`, `on_receive()`, and `get_stats()`.
4. **Integration Tests**: Loopback test validating Python-to-Python SDP exchange and datagram throughput.

### Verification
- Automated test script starting Python server, running a mock client connection over local WebSocket + aiortc, and verifying datagram exchange.

---

## Phase 5: Browser Client Stack (TypeScript + WebWorker)

### Goal
Implement the browser-side library with a dedicated WebWorker execution context for unthrottled ARQ timer ticks and efficient stream/blob reading.

### Specifications
- **Signaling Client**: `SignalingClient.ts` managing WebSocket SDP Offer/Answer negotiation and auto-reconnect.
- **WebRTC Transport**: `WebRtcTransport.ts` managing `RTCPeerConnection({ iceServers: [] })` and `RTCDataChannel("link", { ordered: false, maxRetransmits: 0 })`.
- **WebWorker (`ArqWorker.ts`)**: Runs unthrottled `10 ms` timer tick loop (`setInterval` inside WebWorker), avoiding background tab throttling.
- **Blob Streaming**: Demand-driven file chunking (`file.slice(...)`) tied to window capacity to preserve browser RAM.

### Deliverables
1. **Browser Library**: `SignalingClient.ts`, `WebRtcTransport.ts`, `ArqWorker.ts`, `index.ts`.
2. **Demo SPA**: Lightweight HTML/TS frontend for C2 messaging, telemetry graphs, and file transfer testing.
3. **Vitest / Worker Tests**: Unit tests for worker message passing and buffer slicing.

### Verification
- Browser bundle builds cleanly via Vite (`npm run build`). Worker handles simulated heavy tab throttling without dropping ARQ tick interval.

---

## Phase 6: Impairment Verification & E2E Test Suite (`tc netem`)

### Goal
Validate the full system under real-world degraded network conditions using Linux `tc netem` and Playwright end-to-end testing.

### Specifications
1. **Terrestrial High-BER Profile**:
   - `tc qdisc add dev eth0 root netem delay 15ms 3ms loss 12%`
   - *Target*: C2 command p99 latency $< 60\text{ ms}$ during simultaneous 5 MB file transfer; zero disconnects.
2. **Starlink Rain-Fade / Handover Profile**:
   - `tc qdisc change dev eth0 root netem delay 45ms 20ms distribution normal loss 3%`
   - *Target*: Smooth RTO adaptation, no spurious retransmission storms.
3. **5-Second RF Blackout**:
   - 100% loss for 5s, then restored.
   - *Target*: Session remains connected (DTLS keepalive > 5s), ARQ resumes from exact last acknowledged sequence number.

### Deliverables
1. **E2E Playwright Test Suite**: `tests/e2e/impairment.spec.ts`.
2. **Netem Test Runner Script**: `scripts/run_impairment_tests.sh`.
3. **Benchmark Report Generator**: Produces latency profiles, throughput metrics, and loss recovery graphs.

### Verification
- Execution of all three network impairment scenarios passing automated thresholds in the test harness.

---

## Phase 7 (Deferred / Stretch): XOR Forward Error Correction & C++ Option B Shim

### Goal
Add optional XOR Parity Forward Error Correction (`fec_xor_group`) and sketch the C++17 `mbedTLS` standalone shim architecture for bare-metal/constrained targets.

### Specifications
- **XOR FEC**: Transmit 1 XOR parity packet per $K$ data packets. Receiver recovers single lost frame in group without waiting for ARQ RTO.
- **C++ Shim Spec**: Architectural reference and interfaces for C++17 `mbedTLS` DTLS 1.2 + custom SCTP/DCEP/ICE-Lite demuxer (~600 LOC shim).

### Deliverables
1. **FEC Engine Extension**: XOR parity encoder/decoder in TS and Python.
2. **C++ Architectural Spec & Stubs**: `cpp/include/resilient_link.hpp`.

### Verification
- Unit test demonstrating zero-retransmission recovery of a single missing frame in a $K=4$ XOR group.
