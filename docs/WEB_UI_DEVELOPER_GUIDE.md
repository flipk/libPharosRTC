# libPharosRTC - Web UI Developer Guide

This guide details how to integrate **libPharosRTC** into modern TypeScript/JavaScript web applications. **libPharosRTC** provides reliable, low-latency, and priority-multiplexed browser-to-embedded communication over lossy, high-BER, or variable-latency IP links (such as satellite or RF telemetry links) without intermediate STUN or TURN servers.

---

## 1. Overview & Core Concepts

Traditional WebRTC applications use browser data channels with default TCP-like reliability or pure unreliable mode. On degraded or high-BER links, standard SCTP retransmissions can cause head-of-line blocking and buffer starvation.

`libPharosRTC` solves this by configuring the underlying WebRTC `RTCDataChannel` in raw datagram mode (`ordered: false, maxRetransmits: 0`) and managing its own Selective Repeat ARQ, Deficit Round-Robin priority scheduler, and small App-MTU discipline in the browser.

### Transport vs. Signaling
- **Signaling Channel (WebSocket)**: Used **only** during setup to exchange WebRTC SDP Offer and Answer descriptions.
- **Data Transport (WebRTC DataChannel)**: Operates directly over UDP. All application payloads, ARQ retransmissions, SACK bitmasks, and priority scheduling travel across this DataChannel.

---

## 2. Installation & Exports

Exported classes and utilities are available from `libpharosrtc`:

```typescript
import {
  ResilientLinkClient,
  WebRtcTransport,
  SignalingClient,
  TERRESTRIAL_HIGH_BER_PROFILE,
  STARLINK_PROFILE,
  DEFAULT_CHANNELS,
  DeliveryMode,
  LinkConfig,
  ChannelConfig
} from 'libpharosrtc';
```

---

## 3. Quick Start (Standalone Signaling)

If your backend is running the standalone `libPharosRTC` signaling server (e.g. `ws://<device-ip>:8765/ws/webrtc`), you can connect directly using `ResilientLinkClient`.

```typescript
import { ResilientLinkClient, TERRESTRIAL_HIGH_BER_PROFILE } from 'libpharosrtc';

// 1. Create client instance (using high-BER RF preset profile)
const client = new ResilientLinkClient(
  TERRESTRIAL_HIGH_BER_PROFILE,
  undefined, // default channel configuration (Ch 0: C2, Ch 1: Telemetry, Ch 2: Bulk)
  true       // enable WebWorker offloading for unthrottled background timers
);

// 2. Register channel receive listeners
// Channel 0: Command & Control (RELIABLE_ORDERED)
client.onReceive(0, (payload: Uint8Array) => {
  const text = new TextDecoder().decode(payload);
  console.log('Received C2 Command Ack/Response:', text);
});

// Channel 1: High-rate Telemetry (UNRELIABLE_UNORDERED)
client.onReceive(1, (payload: Uint8Array) => {
  const telemetry = JSON.parse(new TextDecoder().decode(payload));
  console.log('Received Telemetry Frame:', telemetry);
});

// 3. Register channel open callback
client.onChannelOpen(() => {
  console.log('Resilient DataChannel is OPEN and ready for transfer');

  // Send a C2 command payload
  const cmd = new TextEncoder().encode(JSON.stringify({ op: 'SET_HEADING', heading: 180 }));
  client.send(0, cmd);
});

// 4. Initiate connection to signaling endpoint
async function start() {
  try {
    await client.connect('ws://192.168.1.50:8765/ws/webrtc');
  } catch (err) {
    console.error('Signaling / Connection error:', err);
  }
}

start();
```

---

## 4. Piggybacking on an Existing Application WebSocket

If your application **already maintains a WebSocket connection** to the backend, you do **not** need to open a second WebSocket or run `SignalingServer`.

You can route libPharosRTC's SDP exchange over your existing WebSocket connection.

### Example: Existing WebSocket Adapter

```typescript
import { WebRtcTransport, ResilientLinkClient } from 'libpharosrtc';

// 1. Create a custom signaling adapter for your existing WebSocket
export class ExistingWsSignalingAdapter {
  private answerCallbacks: ((sdp: string) => void)[] = [];

  constructor(private ws: WebSocket) {
    // Intercept incoming messages on the existing WebSocket
    this.ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pharos_answer' && typeof data.sdp === 'string') {
          // Pass the SDP answer back to libPharosRTC
          this.answerCallbacks.forEach(cb => cb(data.sdp));
        }
      } catch {
        // Ignore non-JSON or unrelated messages
      }
    });
  }

  // Called by libPharosRTC to send the SDP offer over your WS connection
  public sendOffer(sdp: string): void {
    this.ws.send(JSON.stringify({
      type: 'pharos_offer',
      sdp: sdp
    }));
  }

  public onAnswer(cb: (sdp: string) => void): void {
    this.answerCallbacks.push(cb);
  }

  public isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

// 2. Negotiate WebRTC over your existing WebSocket
async function connectOverExistingWs(existingWs: WebSocket) {
  const transport = new WebRtcTransport();
  const signalingAdapter = new ExistingWsSignalingAdapter(existingWs);

  // High-level client can attach to the transport
  const client = new ResilientLinkClient();

  transport.onChannelOpen(() => {
    console.log('DataChannel connected via piggybacked WebSocket signaling!');
  });

  // Start negotiation using your custom adapter
  await transport.startNegotiation(signalingAdapter as any);
}
```

---

## 5. Channel Profiles & Priorities

`libPharosRTC` uses strict priority multiplexing across logical channels. By default, three channels are pre-configured:

| Channel ID | Name | Delivery Mode | Priority | Description |
| :--- | :--- | :--- | :--- | :--- |
| **0** | `c2` | `RELIABLE_ORDERED` | **0 (Highest)** | Command & Control. Preempts all other traffic immediately. |
| **1** | `telemetry` | `UNRELIABLE_UNORDERED` | **1 (Medium)** | Telemetry / Sensor updates. Dropped frames are not retransmitted. |
| **2** | `bulk_xfer` | `RELIABLE_ORDERED` | **2 (Lowest)** | File/Blob transfers. Sent during bandwidth idle periods. |

### Link Preset Profiles
- **`TERRESTRIAL_HIGH_BER_PROFILE`**: `220 bytes` App-MTU, `32` pkt window, initial RTO `60ms`, FEC XOR Group `4`. Optimized for high-noise terrestrial RF links.
- **`STARLINK_PROFILE`**: `900 bytes` App-MTU, `64` pkt window, initial RTO `180ms`. Optimized for high-throughput variable latency satellite links.

### Defining Custom Channels
```typescript
import { ChannelConfig, DeliveryMode } from 'libpharosrtc';

const customChannels: ChannelConfig[] = [
  { id: 0, name: 'critical_c2', mode: DeliveryMode.RELIABLE_ORDERED, priority: 0, windowSize: 16 },
  { id: 1, name: 'video_stream', mode: DeliveryMode.UNRELIABLE_UNORDERED, priority: 1, windowSize: 0 },
  { id: 2, name: 'log_sync', mode: DeliveryMode.RELIABLE_ORDERED, priority: 2, windowSize: 32 },
];

const client = new ResilientLinkClient(TERRESTRIAL_HIGH_BER_PROFILE, customChannels, true);
```

---

## 6. Sending Files and Large Payloads

To send large files without starving real-time C2 commands:

```typescript
// Sending raw binary payload
const binaryData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
client.send(0, binaryData);

// Chunked Blob transmission (Bulk Channel 2)
const fileInput = document.querySelector<HTMLInputElement>('#file-picker')!;
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    // Slices and queues the blob onto Channel 2 without blocking Channel 0 C2
    client.sendBlob(2, file);
  }
});
```

---

## 7. WebWorker Offloading (Background Tab Support)

Modern browsers throttle `setInterval` and `setTimeout` timers to 1 Hz or slower when a browser tab is minimized or running in the background.

To prevent ARQ timer starvation:
- Pass `true` as the 3rd argument to `ResilientLinkClient`:
  ```typescript
  const client = new ResilientLinkClient(TERRESTRIAL_HIGH_BER_PROFILE, undefined, true);
  ```
- This runs the ARQ calculation engine inside a dedicated WebWorker, maintaining accurate **10ms unthrottled timers** even when the tab is hidden or minimized.

---

## 8. Link Diagnostics & Real-Time Statistics

You can poll link statistics per channel at any time:

```typescript
setInterval(() => {
  const c2Stats = client.getStats(0);
  const bulkStats = client.getStats(2);

  console.log(`C2 SRTT: ${c2Stats.smoothedRttMs}ms | Current RTO: ${c2Stats.currentRtoMs}ms`);
  console.log(`Bulk Retransmissions: ${bulkStats.retransmissions} | Estimated Loss: ${(bulkStats.estimatedPacketLoss * 100).toFixed(1)}%`);
}, 1000);
```

### Stats Interface (`ArqStats`)
- `txFrames`: Total wire frames transmitted.
- `rxFrames`: Total wire frames received.
- `retransmissions`: Count of retransmitted frames.
- `smoothedRttMs`: Jacobson/Karels smoothed Round-Trip Time.
- `rttVarMs`: Round-Trip Time variance.
- `currentRtoMs`: Active Retransmission TimeOut (clamped between min and max RTO).
- `estimatedPacketLoss`: Estimated packet loss ratio (0.0 to 1.0).
- `fecParityTx`: Total FEC parity frames transmitted.
- `fecParityRx`: Total FEC parity frames received.
- `fecRecoveries`: Total data frames successfully reconstructed via FEC parity recovery.
