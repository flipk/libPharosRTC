# libPharosRTC - Python Server-Side Developer Guide

This guide describes how to integrate the **libPharosRTC** Python backend into embedded Linux systems (e.g. Yocto ARM, Raspberry Pi, Debian) or backend services. **libPharosRTC** delivers high-reliability, priority-multiplexed, low-latency communication over lossy, high-BER, or variable-latency IP links (RF telemetry, Starlink satellite) without relying on external STUN/TURN infrastructure.

---

## 1. Overview & Architecture

The Python implementation of `libPharosRTC` uses `aiortc` and `cryptography` to host an offline **ICE-Lite** responder and WebRTC stack.

### Key Highlights
- **Zero External Dependencies**: Operates in air-gapped/isolated networks (`iceServers: []`).
- **Persistent ECDSA Certificates**: Automatically generates and caches ECDSA P-256 TLS certificates (`/tmp/webrtc_cert.pem`) to eliminate expensive SSL cert generation on weak ARM embedded CPUs during startup.
- **Selective Repeat ARQ & Small-Frame MTU**: Prevents packet loss amplification by strictly enforcing small App-MTU bounds (220B default for RF, 900B for satellite).
- **Session Preemption**: Opening a new session automatically cleans up stale WebRTC peer connections and resets the ARQ sequence state.

---

## 2. Installation & Module Imports

The package modules can be imported directly:

```python
from libpharosrtc import (
    ResilientLink,
    WebRtcBackend,
    SignalingServer,
    LinkConfig,
    ChannelConfig,
    DeliveryMode,
    TERRESTRIAL_HIGH_BER_PROFILE,
    STARLINK_PROFILE,
    DEFAULT_CHANNELS,
)
```

---

## 3. Quick Start (Standalone Signaling)

If you want `libPharosRTC` to manage its own lightweight WebSocket server for WebRTC SDP signaling:

```python
import asyncio
import json
from libpharosrtc import ResilientLink, TERRESTRIAL_HIGH_BER_PROFILE

async def main():
    # 1. Instantiate ResilientLink with the terrestrial RF profile
    link = ResilientLink(
        link_config=TERRESTRIAL_HIGH_BER_PROFILE,
        cert_path="/var/run/webrtc_cert.pem",
        key_path="/var/run/webrtc_key.pem",
    )

    # 2. Register callbacks for specific channels
    # Channel 0: C2 Commands (RELIABLE_ORDERED)
    def handle_c2(payload: bytes):
        msg = json.loads(payload.decode("utf-8"))
        print(f"[C2 Command Received]: {msg}")
        
        # Echo response back over Channel 0
        response = json.dumps({"status": "ACK", "op": msg.get("op")}).encode("utf-8")
        link.send(0, response)

    link.on_receive(0, handle_c2)

    # Channel 1: Telemetry (UNRELIABLE_UNORDERED)
    def handle_telemetry(payload: bytes):
        print(f"[Telemetry Inbound]: {payload.hex()}")

    link.on_receive(1, handle_telemetry)

    # 3. Start embedded WebSocket signaling server
    await link.start_signaling(host="0.0.0.0", port=8765, path="/ws/webrtc")
    print("ResilientLink signaling listening on ws://0.0.0.0:8765/ws/webrtc")

    # 4. Background task sending outbound telemetry over Channel 1
    async def telemetry_loop():
        seq = 0
        while True:
            await asyncio.sleep(0.1) # 10 Hz telemetry
            telemetry_data = json.dumps({"seq": seq, "voltage": 12.4, "temp": 42.1}).encode("utf-8")
            link.send(1, telemetry_data)
            seq += 1

    asyncio.create_task(telemetry_loop())

    # Keep running
    try:
        await asyncio.Event().wait()
    finally:
        await link.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## 4. Piggybacking on an Existing Application Server

If your Python application already runs an existing WebSocket / HTTP server (e.g. **FastAPI**, **Aiohttp**, or **websockets**), you can use `WebRtcBackend` directly without launching a second server.

### Example: FastAPI / Starlette Integration

```python
from fastapi import FastAPI, WebSocket
from libpharosrtc import WebRtcBackend, TERRESTRIAL_HIGH_BER_PROFILE
import json

app = FastAPI()

# Single backend instance
webrtc_backend = WebRtcBackend(link_config=TERRESTRIAL_HIGH_BER_PROFILE)

# Register data handlers
def handle_c2_command(payload: bytes):
    print("Received C2 over WebRTC DataChannel:", payload.decode())

webrtc_backend.on_receive(0, handle_c2_command)

@app.websocket("/ws/app_control")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    try:
        while True:
            raw_text = await websocket.receive_text()
            data = json.loads(raw_text)

            # Route libPharosRTC signaling SDP offers over your existing WS endpoint
            if data.get("type") == "pharos_offer":
                offer_sdp = data["sdp"]
                
                # Pass offer SDP to backend and generate answer SDP
                answer_sdp = await webrtc_backend.handle_offer(offer_sdp)

                # Send answer back to frontend over existing WS
                await websocket.send_json({
                    "type": "pharos_answer",
                    "sdp": answer_sdp
                })
            else:
                # Handle standard app messages
                pass
    except Exception as e:
        print(f"WebSocket client disconnected: {e}")
```

### Example: Raw `websockets` Integration

```python
import asyncio
import json
import websockets
from libpharosrtc import WebRtcBackend

backend = WebRtcBackend()

async def ws_handler(websocket, path):
    async for message in websocket:
        data = json.loads(message)
        if data.get("type") == "pharos_offer":
            answer_sdp = await backend.handle_offer(data["sdp"])
            await websocket.send(json.dumps({"type": "pharos_answer", "sdp": answer_sdp}))

async def start():
    server = await websockets.serve(ws_handler, "0.0.0.0", 8080)
    await server.wait_closed()
```

---

## 5. Configuring Channel Priorities & Profiles

### Profiles
- **`TERRESTRIAL_HIGH_BER_PROFILE`**: `220 bytes` App-MTU, `32` frame window, initial RTO `60ms`, FEC XOR Group `4`. Optimized for high-BER terrestrial RF links.
- **`STARLINK_PROFILE`**: `900 bytes` App-MTU, `64` frame window, initial RTO `180ms`. Optimized for Starlink satellite links with periodic rain-fade / handover spikes.

### Defining Custom Channels
You can customize channels by passing a list of `ChannelConfig` objects:

```python
from libpharosrtc import ChannelConfig, DeliveryMode, LinkConfig

custom_channels = [
    ChannelConfig(id=0, name="c2_critical", mode=DeliveryMode.RELIABLE_ORDERED, priority=0, window_size=16),
    ChannelConfig(id=1, name="sensors", mode=DeliveryMode.UNRELIABLE_UNORDERED, priority=1, window_size=0),
    ChannelConfig(id=2, name="bulk_file", mode=DeliveryMode.RELIABLE_ORDERED, priority=2, window_size=64),
]

link = ResilientLink(
    link_config=TERRESTRIAL_HIGH_BER_PROFILE,
    channel_configs=custom_channels
)
```

---

## 6. Binary Payloads & Memory Optimization

The `send()` method accepts any standard Python buffer type (`bytes`, `bytearray`, or `memoryview`):

```python
# Standard bytes
link.send(0, b"\x01\x02\x03\x04")

# Zero-copy memoryview from array/buffer
buffer = bytearray(1024)
view = memoryview(buffer)[0:220]
link.send(2, view)
```

---

## 7. Diagnostics & Performance Metrics

To inspect link quality parameters programmatically:

```python
stats = link.get_stats(channel_id=0)

print(f"Channel 0 SRTT: {stats.smoothed_rtt_ms:.2f} ms")
print(f"Channel 0 Current RTO: {stats.current_rto_ms:.2f} ms")
print(f"Channel 0 Estimated Loss: {stats.estimated_packet_loss * 100:.1f} %")
print(f"Channel 0 Retransmissions: {stats.retransmissions}")
print(f"TX Frames: {stats.tx_frames} | RX Frames: {stats.rx_frames}")
```

### `ArqStats` Reference Attributes
- `tx_frames`: Total wire frames sent.
- `rx_frames`: Total wire frames received.
- `retransmissions`: Number of retransmitted packets triggered by SACK/RTO.
- `smoothed_rtt_ms`: Jacobson/Karels smoothed RTT.
- `rtt_var_ms`: RTT variance (jitter).
- `current_rto_ms`: Current active Retransmission TimeOut.
- `estimated_packet_loss`: Estimated packet loss ratio (0.0 to 1.0).
- `fec_parity_tx`: Total FEC parity frames transmitted.
- `fec_parity_rx`: Total FEC parity frames received.
- `fec_recoveries`: Total data frames successfully reconstructed via FEC parity recovery.

---

## 8. Clean Shutdown

When shutting down your application or service, ensure proper cleanup of `asyncio` tasks and WebRTC resources:

```python
# Gracefully stop signaling and close active peer connections
await link.close()
```
