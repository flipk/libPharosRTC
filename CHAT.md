# USER

suppose there exists a product which is an small embedded device
controlled by a PC. it is just the PC and the device, with a radio
link carrying IP between them, and no internet. unfortunately the
radio link between them sometimes suffers a high bit error rate (and
it is not the type of link that has MAC layer retransmissions, so one
bad bit is one dropped packet with failed CRC). we do not have control
over the radio link design.
(side question, i believe this is in contrast to WIFI which has at
least a couple MAC layer retransmissions, is that correct?)
on such a link it is my belief that large packets (1500 byte MTU) are
more likely to get dropped than small ones, so if we want to maximize
our reliability we should use small packets; and we should use UDP
(because TCP behaves very poorly on bad links); and we should have a
sliding window protocol with selective retransmissions.
am i correct thus far?

# AGENT

Your architectural instincts are spot-on across the board. Every single conclusion you reached is grounded in solid network engineering principles for high-BER (Bit Error Rate) links without link-layer recovery.

### 1. Wi-Fi Comparison (Side Question)

**Yes, you are completely correct.** Standard IEEE 802.11 (Wi-Fi) implements positive acknowledgments (ACKs) and retransmissions directly at the MAC layer. If a frame is corrupted in transit, the receiver does not send a MAC ACK, and the sender automatically retransmits it (typically up to 4–7 times depending on frame size and driver settings) before the IP layer ever knows anything went wrong. Because your customer's radio link lacks this—functioning more like raw serial-over-RF, unacknowledged point-to-point telemetry, or tactical data links—a single bit flip destroys the entire frame at the physical/data-link boundary.

### 2. Packet Size vs. Bit Error Rate

**Correct.** Assuming independent bit errors (such as random thermal noise or AWGN), the probability of a packet surviving without a single bit error decays exponentially with packet length:

$$P(\text{success}) = (1 - \text{BER})^N$$

where $N$ is the total number of bits in the frame (including MAC, IP, and UDP headers).

For example, at a relatively severe $\text{BER} = 10^{-4}$ (1 bad bit per 10,000 bits):

* **1500-byte packet (12,000 bits):** $(1 - 0.0001)^{12000} \approx \mathbf{30\%}$ survival rate (70% packet loss).
* **100-byte packet (800 bits):** $(1 - 0.0001)^{800} \approx \mathbf{92\%}$ survival rate (8% packet loss).

*(Note: If the radio suffers from **burst errors**—where interference wipes out several milliseconds of transmission regardless of size—smaller packets still help because they are statistically less likely to overlap with a noise burst, and less data is lost when they do.)*

### 3. Why UDP Beats TCP Here

**Correct.** Standard TCP assumes packet loss equals **network congestion**, not physical radio corruption. When your link drops packets due to bit errors, TCP reacts in three destructive ways:

* **Congestion Window Collapse:** TCP cuts its congestion window (`cwnd`) in half (or down to 1 MSS) on every loss event, throttling your throughput to a crawl even though the link has zero congestion.
* **Exponential Backoff:** Repeated losses cause TCP's Retransmission Timeout (RTO) to double repeatedly (1s, 2s, 4s, 8s...), freezing communication on an embedded control link where responsiveness usually matters.
* **Head-of-Line (HoL) Blocking:** Even with TCP Selective Acknowledgments (SACK), the receiving OS socket will not deliver valid packets `N+1` and `N+2` to your application until missing packet `N` is finally recovered.

### 4. Sliding Window with Selective Repeat (ARQ)

**Correct.** Implementing a custom **Selective Repeat ARQ** (Automatic Repeat Request) sliding window over UDP is the classic, textbook solution for this exact problem:

* **Sliding Window:** Keeps multiple packets in flight simultaneously so you don't waste radio airtime waiting a full round-trip time (RTT) for an ACK after every tiny packet (which would kill throughput on a Stop-and-Wait protocol).
* **Selective Retransmission:** Only resends the specific sequence numbers that were dropped, rather than re-transmitting the entire window (Go-Back-N), preserving scarce RF bandwidth.

---

### Two Practical Additions to Consider

Since you are building a custom reliability layer over UDP, two small enhancements will make your protocol significantly more resilient on a lossy radio link:

1. **Piggybacked ACKs & Bitmasks (SACK):** Keep your acknowledgments tiny and frequent. Instead of sending a standalone ACK packet for every received frame, include a `last_contiguous_seq_num` plus a 16-bit or 32-bit **received-packet bitmask** inside your normal telemetry/command packets (or in periodic compact ACK frames). Because ACKs themselves can get dropped by bit errors, a cumulative + bitmask ACK is self-healing: the next surviving ACK automatically updates the sender on the exact state of the entire window.
2. **Application-Layer Forward Error Correction (FEC):** If the radio link has high latency (where waiting for a retransmission hurts control loop responsiveness) or asymmetric error rates, consider adding simple XOR parity packets (e.g., 1 parity packet for every 4 data packets). If any 1 of the 5 packets is dropped by a bit flip, the receiver reconstructs it immediately without needing a retransmission at all.

# USER

one desire is that the PC side is simply a web browser with no custom
software install required. can we use WebRTC to implement the UDP
part? i'm assuming we need some kind of STUN or TURN server and we
need to implement DTLS.
(side question, would mbedtls be able to implement webRTC compatible DTLS?)

# AGENT

Yes, you can use **WebRTC DataChannels** (`RTCDataChannel`) in an unordered, unreliable mode (`ordered: false, maxRetransmits: 0`) to get raw, unacknowledged UDP-like datagrams directly in a standard web browser with zero software installation—and then run your custom Selective Repeat ARQ protocol right inside JavaScript/WebAssembly on top of that DataChannel.

However, because you are on an isolated IP link with no internet, several pieces of the standard WebRTC stack behave differently than people expect—and there is one major architectural catch with **SCTP** that you need to watch out for.

---

### 1. STUN and TURN Servers: Not Needed!

Because your PC and embedded device have direct IP connectivity over the radio link (with no NAT routers or internet between them), **you do not need a STUN or TURN server**.

* **Why:** STUN is only used to discover public IP:port mappings behind NAT, and TURN is only used to relay traffic when symmetric NAT or firewalls block direct peer-to-peer packets.
* **How it works locally:** When you instantiate `new RTCPeerConnection({ iceServers: [] })` with an empty `iceServers` array, the browser gathers **host ICE candidates** (its own local IP address and ephemeral UDP port).
* **What your device *does* need:**
1. **A tiny Signaling channel:** WebRTC requires an out-of-band handshake (exchanging SDP offers/answers and ICE candidates) before UDP packets can flow. Since your embedded device is likely already serving the web page (or running a lightweight HTTP/WebSocket server on a known IP), the browser simply fetches the page over HTTP and exchanges the SDP offer/answer via a single HTTP `POST` or WebSocket message.
2. **ICE-Lite:** Your embedded device does not need a full ICE state machine. Implementing **ICE-Lite** (RFC 8445) on the device means it simply responds to incoming STUN Binding Requests from the browser with a valid STUN Binding Response containing the HMAC-SHA1 integrity attribute (`MESSAGE-INTEGRITY`).



---

### 2. DTLS and `mbedTLS` Compatibility (Side Question)

**Yes, WebRTC strictly requires DTLS 1.2**, and **`mbedTLS` supports it out of the box**—with one important browser quirk regarding certificates.

* **What `mbedTLS` provides:** `mbedTLS` has full, mature support for **DTLS 1.2** (`MBEDTLS_SSL_PROTO_DTLS`), cookie verification, and the required ECDHE-ECDSA cipher suites (`TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256`) that Chrome, Firefox, and Edge mandate for WebRTC.
* **The Self-Signed Certificate Catch:** In normal HTTPS, browsers reject self-signed certificates on raw IP addresses unless the user clicks through scary warnings or installs a root CA. **WebRTC solves this cleanly:** during the SDP signaling exchange, your device sends the SHA-256 fingerprint of its self-signed ECDSA certificate (`a=fingerprint:sha-256 ...`). The browser verifies that the DTLS handshake certificate matches that SDP fingerprint—no CA or user warning required.
* **Lightweight Alternatives:** If RAM/flash on your embedded device is tight, look at **`libdatachannel`** (C/C++, supports `mbedTLS` as its crypto/DTLS backend) or **`usrsctp` + `mbedTLS**`, which handle the exact SDP/ICE-Lite/DTLS/SCTP glue that browsers expect.

---

### 3. The Hidden Catch: WebRTC DataChannels Run Over SCTP

This is the single most important detail for your high-BER radio link: **WebRTC DataChannels are not raw UDP.** The protocol stack inside a browser is:

$$\text{Your Data} \longrightarrow \mathbf{\text{SCTP}} \longrightarrow \mathbf{\text{DTLS 1.2}} \longrightarrow \mathbf{\text{UDP}} \longrightarrow \mathbf{\text{IP}}$$

Even when you configure a DataChannel with `{ ordered: false, maxRetransmits: 0 }`:

1. **MTU & Fragmentation:** SCTP sits inside DTLS inside UDP. Because of DTLS + SCTP framing overhead (~50–60 bytes), you must keep your application messages small (e.g., $\le 200\text{–}400\text{ bytes}$) so SCTP never fragments a message across multiple UDP packets. (If SCTP fragments a message and 1 fragment is lost to a bit error, the entire message is dropped).
2. **Handshake Fragility on High-BER Links:** The initial **DTLS 1.2 handshake** and **SCTP `INIT` handshake** use large multi-packet flights (especially certificates). If your radio link has a high BER *during connection setup*, those large handshake packets will drop repeatedly until DTLS retransmits them. Keeping your device's ECDSA certificate minimal (P-256 key, minimal X.509 fields, no extra extensions) keeps the DTLS `Certificate` flight under ~500 bytes so it survives bad links easily.

---

### Alternative Browser-Native Option: WebTransport (HTTP/3 + QUIC)

Depending on your browser targets and embedded MCU resources, **WebTransport** (using unreliable **QUIC Datagrams**) is worth a brief look:

* **Pros:** Gives you true, unacknowledged UDP-style datagrams (`datagrams.writable` / `datagrams.readable`) without SCTP overhead, and requires no separate SDP/ICE signaling—just a single HTTPS/QUIC connection.
* **Cons:** Requires **TLS 1.3** (which `mbedTLS` 3.x supports, though QUIC stacks like `ngtcp2` or `msquic` are heavier than DTLS+SCTP), and if you use a self-signed certificate without a domain/CA, you must use `serverCertificateHashes` in the browser's `WebTransport` constructor (with a max certificate lifetime of 14 days).

For most embedded devices, **WebRTC DataChannel (`ordered: false, maxRetransmits: 0`) with `mbedTLS` + ICE-Lite** remains the most battle-tested, zero-install way to get UDP datagrams into a browser on an offline local network.

# USER

i am deciding whether the embedded side can be C++ or python. i know
with mbedtls i can do C++ but would all aspects of this also work if
the embedded side is python?

# AGENT

**Yes, the entire stack works in Python on an embedded Linux device**, provided your hardware has enough RAM/CPU to run a full Python 3 runtime (e.g., an embedded Linux SBC or module with $\ge 64\text{–}128\text{ MB}$ RAM, rather than a bare-metal/RTOS microcontroller like an STM32 or ESP32, where MicroPython lacks the required WebRTC/DTLS/SCTP libraries).

In Python, you don't even have to assemble the ICE, DTLS, and SCTP pieces manually—the mature **`aiortc`** library implements the entire WebRTC stack natively in Python (using `cryptography` / OpenSSL for DTLS 1.2 and pure Python/C bindings for ICE and SCTP).

---

### How Python (`aiortc`) vs. C++ (`libdatachannel` / `mbedTLS`) Compare Here

| Factor | Python (`aiortc`) | C++ (`libdatachannel` + `mbedTLS` or `usrsctp`) |
| --- | --- | --- |
| **WebRTC Stack Completeness** | **Out-of-the-box.** Handles SDP, ICE-Lite, DTLS 1.2, and `RTCDataChannel` (`ordered=False, maxRetransmits=0`) in ~40 lines of `asyncio` code. | **Modular.** Libraries like `libdatachannel` bundle ICE/DTLS/SCTP cleanly, or you wire `mbedTLS` + `usrsctp` + custom ICE-Lite together. |
| **Hardware Footprint** | Requires embedded Linux (e.g., Raspberry Pi, i.MX, BeagleBone, Yocto/Buildroot with Python 3). ~30–50 MB RAM baseline. | Runs anywhere—from bare-metal/FreeRTOS MCUs (~100–200 KB RAM) up to embedded Linux. |
| **High-BER & Small Packet Control** | **Slightly harder to tune.** `aiortc`'s internal SCTP layer defaults to standard ~1200-byte MTU chunking and standard SCTP `INIT` timers unless you monkey-patch or configure its transport parameters. | **Total control.** You can explicitly clamp the DTLS/SCTP max packet size (e.g., to 256 bytes) and tune DTLS handshake retransmission timeouts (`mbedtls_ssl_conf_handshake_timeout`) for noisy RF links. |
| **Selective Repeat ARQ Layer** | Very fast to prototype and iterate on top of `channel.send()` / `@channel.on("message")` using `asyncio` timers and `struct.pack`. | Deterministic, zero-GC latency; trivial ring-buffer and bitmask manipulation without interpreter jitter. |
| **Startup / Handshake Speed** | Slower initial startup (Python import + OpenSSL ECDSA keygen takes ~0.5–1.5s on a low-power ARM core). | Near-instantaneous startup and deterministic DTLS handshake timing. |

---

### Three Python-Specific Caveats for Your High-BER Link

If you choose Python on embedded Linux, keep these three details in mind:

1. **Keep Your Application Payloads Small (Avoid SCTP Fragmentation):**
`aiortc`'s SCTP implementation (`aiortc.rtcsctptransport`) will happily accept a 4 KB message from your Python code and fragment it into multiple ~1200-byte UDP datagrams—which will get destroyed on your high-BER radio link. As long as **your** Selective Repeat ARQ layer slices data into small chunks (e.g., $\le 200\text{–}300\text{ bytes}$) *before* calling `channel.send()`, `aiortc` will emit each chunk as a single, unfragmented UDP packet.
2. **Pre-Generate or Cache Your Self-Signed Certificate:**
`aiortc` generates a fresh ECDSA certificate on startup by default, which is fast on a desktop PC but can take a noticeable fraction of a second on a slow embedded ARM CPU. Pre-generating the self-signed ECDSA P-256 cert/key pair once and loading it at boot speeds up readiness and ensures your SDP fingerprint is ready immediately when the browser connects.
3. **Aggressive DTLS Handshake Timeouts:**
In `aiortc`, the underlying DTLS handshake uses OpenSSL with default retransmission timers (~1 second initial timeout). On a noisy radio link where 1 or 2 handshake packets drop, a session setup might take 3–6 seconds to complete. Once DTLS and SCTP finish connecting, however, your `ordered=False, maxRetransmits=0` DataChannel passes datagrams straight through with zero SCTP retransmission delays, putting your Python ARQ loop completely in charge.

### Rule of Thumb for Deciding

* **Choose Python (`aiortc`)** if the device runs **embedded Linux**, your packet rate is moderate (tens to a few hundred small packets per second), and rapid development/iteration on the ARQ logic and signaling HTTP/WebSocket server is a priority.
* **Choose C++ (`libdatachannel` / `mbedTLS`)** if you are on a **resource-constrained MCU (RTOS/bare-metal)**, need strict sub-millisecond timing guarantees, or want fine-grained control over DTLS MTU clamping and handshake retransmission timers on an extremely noisy link.

