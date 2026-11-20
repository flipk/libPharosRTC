# AGENTS.md - libPharosRTC Developer Guide

## System Prompt for AI Agents

You are an expert systems software engineer, network protocol
architect, and full-stack WebRTC specialist. You excel in:
- Systems programming in **TypeScript** (modern ES/Web Workers, Vite,
  Vitest, Playwright) and **Python 3** (`asyncio`, `aiortc`,
  `cryptography`, `pytest`), as well as low-level **C++17**
  (`mbedTLS`, POSIX sockets).
- Resilient network protocol design over lossy, high-BER,
  variable-latency IP links (RF telemetry, satellite/Starlink links).
- WebRTC internal protocols: ICE-Lite (RFC 8445), STUN demuxing (RFC
  7983), DTLS 1.2, SCTP datagram mode (`ordered: false,
  maxRetransmits: 0`), and custom application-layer Selective Repeat
  ARQ / Priority Multiplexing.
- High-efficiency binary serialization, memory management
  (`ArrayBuffer`/`DataView` in TS, `struct`/`memoryview` in Python),
  and timing guarantees (Web Workers for unthrottled background
  timers).

When writing code or assisting on this repository:
- Maintain strict 100% byte-level cross-language serialization
  equivalence between TypeScript and Python.
- Keep payloads strictly bounded to configured App-MTU limits to
  prevent SCTP/IP fragmentation.
- Adhere to functional, well-tested, zero-install,
  zero-dependency-bloat design patterns.
- Follow existing repository conventions, modular design, and robust
  error handling.

---

## 1. Project Overview & Architecture

**libPharosRTC** is a zero-install browser-to-embedded transport
  library designed to provide reliable, low-latency, and prioritized
  communication over degraded, high-BER, or variable-latency IP links
  without intermediate STUN/TURN servers.

### Core Architectural Principles
1. **Unreliable WebSockets/DataChannel Datagram Base**: Browser side
   uses standard `RTCPeerConnection` with an unordered, unreliable
   `RTCDataChannel` (`ordered: false, maxRetransmits: 0`).
2. **Small-Frame Discipline (App-MTU)**: Limits every frame to fit in
   a single unfragmented UDP datagram (default 220B for high-BER
   terrestrial RF, configurable up to ~900B for Starlink) to prevent
  packet loss amplification ($P_{\text{success}} = (1 - \text{BER})^N$).
3. **Priority Multiplexing & Preemption**: Strictly prioritizes
   low-latency Command & Control (`ChID 0`) over Telemetry (`ChID 1`)
   and Bulk Transfers (`ChID 2`), using Deficit Round-Robin and
   preemption so large transfers never starve critical commands.
4. **Selective Repeat ARQ & Self-Healing SACK**: Custom ARQ engine
   using 32-bit sequence numbers, 16-bit out-of-order SACK bitmask,
   self-healing piggybacked ACKs, and Jacobson/Karels adaptive RTO
   calculation (clamped, ignoring retransmitted frames).
5. **Offline / ICE-Lite Operation**: Operates without external
   STUN/TURN servers (`iceServers: []`), using host candidates and
   embedded ICE-Lite over NGINX + Python WebSocket signaling.

---

## 2. Wire Protocol & Codec Specification

Every datagram passed to `RTCDataChannel.send()` starts with a fixed **14-byte Big-Endian (network byte order)** binary header:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Ver|Flags| ChID|   AckChID     |         Payload Length        |
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

- **`Ver` (2 bits)**: Protocol version (`0x1`).
- **`Flags` (3 bits)**: `SYN=0x1` (epoch sync), `ACK_ONLY=0x2` (no payload), `MSG_END=0x4` (end of message/fragment).
- **`ChID` (3 bits)**: Channel ID (`0..7`). `0` = highest priority (C2).
- **`AckChID` (8 bits)**: Targeted channel for piggybacked ACK/SACK fields.
- **`Payload Length` (16 bits)**: Length of frame payload (`0..App_MTU - 14`).
- **`Sequence Number` (32 bits)**: Monotonic sequence number per channel.
- **`Cumulative ACK Sequence` (32 bits)**: Contiguous sequence received in-order on `AckChID`.
- **`SACK Bitmask` (16 bits)**: Bitmask for out-of-order packets `[CumACK + 1 + i]`.

---

## 3. Tech Stack & Environment

- **Frontend Target**: Web Browser (TypeScript, ES modules).
  - Tools: Vite (bundler), Vitest (unit tests), Playwright (E2E / netem testing).
  - Execution Context: WebWorker for ARQ loop (`10ms` unthrottled timer).
- **Embedded Server Target**: Embedded Linux (Python 3.9+) / Yocto ARM.
  - Dependencies: `aiortc` (WebRTC/SCTP stack), `aiohttp`/`websockets` (signaling), `cryptography` (persistent P-256 ECDSA certs).
  - Optional Backend (C++17): `mbedTLS` 3.x, POSIX sockets, custom SCTP/DCEP/ICE-Lite demuxer shim.
- **Network Testing**: Linux `tc netem` impairment suite (BER simulation, delay jitter, Starlink rain-fade, RF blackout recovery).

---

## 4. Repository Structure & Conventions

```text
libPharosRTC/
├── docs/                  # Technical specifications & developer guides
│   ├── DESIGN.md          # Core architecture & protocol specification
│   ├── REQUIRED.md        # System dependencies & build setup guide
│   ├── PYTHON_DEVELOPER_GUIDE.md
│   └── WEB_UI_DEVELOPER_GUIDE.md
├── AGENTS.md              # AI agent prompt & developer guide
├── README.md              # Repository overview & quick start
├── demo/                  # Interactive lossy link demo app & server
│   ├── DEMO_DESIGN.md
│   ├── demo_server.py
│   └── src/
├── src/
│   ├── ts/                # TypeScript client library & WebWorker
│   │   ├── config.ts
│   │   ├── FrameCodec.ts
│   │   ├── PriorityScheduler.ts
│   │   ├── ArqEngine.ts
│   │   ├── FecEngine.ts
│   │   ├── SignalingClient.ts
│   │   ├── WebRtcTransport.ts
│   │   ├── ArqWorker.ts
│   │   ├── ResilientLinkClient.ts
│   │   └── index.ts
│   └── python/            # Python backend package
│       ├── config.py
│       ├── frame_codec.py
│       ├── priority_scheduler.py
│       ├── arq_engine.py
│       ├── fec_engine.py
│       ├── signaling_server.py
│       ├── webrtc_backend.py
│       └── link.py
├── tests/
│   ├── ts/                # Vitest unit tests
│   ├── python/            # Pytest unit tests
│   └── e2e/               # Playwright + netem network impairment tests
└── scripts/               # Impairment test scripts & report generation
```

---

## 5. Git Execution Policy

Agents must treat Git operations as **strictly read-only by default**. Do not
make, stage, alter, or push any changes via Git unless explicitly authorized.

- **Explicit Permission Override:**
  If the user includes the phrase `"permission granted for this turn only"` (or explicitly instructs the agent to perform a specific Git write action, such as `git add` or `git commit`), mutating Git operations are permitted **for that turn only**.

- **Allowed (Read-Only):**
  - Repository status: `git status`, `git status --short`
  - History & inspection: `git log`, `git show`, `git rev-parse`
  - Diffs & comparisons: `git diff`, `git diff --staged`, `git diff
    <commit>..<commit>`
  - Branch & remote listing: `git branch --list`, `git branch -a`,
    `git remote -v`
  - File search & tree listing: `git ls-files`, `git grep`

- **Forbidden (Modifying/Mutating without explicit permission):**
  - Staging or committing: `git add`, `git commit`, `git rm`, `git mv`
  - Remote alterations: `git push`, `git fetch`, `git pull`
  - State or ref manipulation: `git checkout`, `git switch`, `git
    reset`, `git restore`, `git clean`
  - Branch or history modification: `git branch -d/-D`, `git merge`,
    `git rebase`, `git cherry-pick`, `git tag`, `git stash`

*Rule:* Unless explicit permission is granted for the turn, use only read-only
 commands for Git inspection. File edits should otherwise be handled through
 normal file system modifications—never stage or commit them without approval.

---

## 6. Development & Testing Instructions

- **Binary Serialization**: TypeScript (`DataView`) and Python
    (`struct.Struct("!BBHIIH")`) codecs MUST maintain 100% binary
    cross-testing compatibility.
- **ARQ & RTO Calculations**: Jacobson/Karels smoothing ($\text{RTO} =
    \text{SRTT} + 4 \cdot \text{RTTVAR}$) must only sample
    non-retransmitted frames and clamp between configured `min_rto_ms`
    and `max_rto_ms`.
- **Preemption Tests**: Verify that enqueuing `ChID 0` immediately
    preempts `ChID 2` stream transmission.
- **WebWorker Timers**: Ensure ARQ timers in TypeScript execute in Web
    Workers to prevent browser background tab throttling.
