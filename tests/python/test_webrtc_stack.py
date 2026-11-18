import asyncio
import json
from pathlib import Path
import pytest

from aiortc import RTCPeerConnection, RTCSessionDescription
from link import ResilientLink
from frame_codec import decode_frame, encode_frame
from webrtc_backend import get_or_create_ecdsa_certificate
import websockets

@pytest.mark.asyncio
async def test_persistent_certificate_generation_and_loading(tmp_path):
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")

    assert not Path(cert_path).exists()
    assert not Path(key_path).exists()

    # First call: generates and writes to disk
    cert1 = get_or_create_ecdsa_certificate(cert_path, key_path)
    assert Path(cert_path).exists()
    assert Path(key_path).exists()
    fp1 = cert1.getFingerprints()[0].value

    # Second call: loads from disk
    cert2 = get_or_create_ecdsa_certificate(cert_path, key_path)
    fp2 = cert2.getFingerprints()[0].value

    assert fp1 == fp2

@pytest.mark.asyncio
async def test_full_webrtc_stack_signaling_and_data_exchange():
    cert_dir = Path("/tmp/webrtc_test_certs")
    link = ResilientLink(
        cert_path=str(cert_dir / "cert.pem"),
        key_path=str(cert_dir / "key.pem"),
    )

    port = 8789
    await link.start_signaling(host="127.0.0.1", port=port)

    server_received = {}
    def on_server_rx(chid, payload):
        server_received[chid] = payload

    link.on_receive(0, lambda p: on_server_rx(0, p))
    link.on_receive(2, lambda p: on_server_rx(2, p))

    # Connect client over WebSocket signaling
    uri = f"ws://127.0.0.1:{port}/ws/webrtc"
    async with websockets.connect(uri) as ws:
        client_pc = RTCPeerConnection()
        channel = client_pc.createDataChannel("link", ordered=False, maxRetransmits=0)

        client_received = asyncio.Event()
        client_payloads = {}

        @channel.on("message")
        def on_client_message(msg):
            if isinstance(msg, bytes):
                frame = decode_frame(msg)
                if frame.payload:
                    client_payloads[frame.header.chid] = bytes(frame.payload)
                    client_received.set()

        offer = await client_pc.createOffer()
        await client_pc.setLocalDescription(offer)

        await ws.send(json.dumps({"type": "offer", "sdp": client_pc.localDescription.sdp}))
        resp = json.loads(await ws.recv())

        assert resp["type"] == "answer"
        answer_sdp = resp["sdp"]
        await client_pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))

        # Wait for channel to open
        open_event = asyncio.Event()
        @channel.on("open")
        def on_open():
            open_event.set()

        if channel.readyState == "open":
            open_event.set()
        else:
            await asyncio.wait_for(open_event.wait(), timeout=5.0)

        # Client sends message to server
        c2_msg = b"COMMAND_START_ENGINES"
        frame_seqs = link.backend.arq_engine.send_message(0, c2_msg)
        frame = link.backend.arq_engine.dequeue_next_frame(now=time_now())
        assert frame is not None
        channel.send(encode_frame(frame))

        # Wait for server to process message
        for _ in range(50):
            if 0 in server_received:
                break
            await asyncio.sleep(0.02)

        assert server_received.get(0) == c2_msg

        # Server sends frame to client
        bulk_msg = b"BULK_TELEMETRY_PACKET"
        link.send(2, bulk_msg)

        # Wait for client to receive frame
        await asyncio.wait_for(client_received.wait(), timeout=5.0)
        assert client_payloads.get(2) == bulk_msg

        await client_pc.close()

    await link.close()

@pytest.mark.asyncio
async def test_session_preemption():
    link = ResilientLink()
    port = 8790
    await link.start_signaling(host="127.0.0.1", port=port)

    uri = f"ws://127.0.0.1:{port}/ws/webrtc"

    # Client 1 connects
    async with websockets.connect(uri) as ws1:
        pc1 = RTCPeerConnection()
        pc1.createDataChannel("link", ordered=False, maxRetransmits=0)
        offer1 = await pc1.createOffer()
        await pc1.setLocalDescription(offer1)
        await ws1.send(json.dumps({"type": "offer", "sdp": pc1.localDescription.sdp}))
        resp1 = json.loads(await ws1.recv())
        await pc1.setRemoteDescription(RTCSessionDescription(sdp=resp1["sdp"], type="answer"))

        assert link.backend.current_pc is not None
        first_pc = link.backend.current_pc

        # Client 2 connects (Preemption!)
        async with websockets.connect(uri) as ws2:
            pc2 = RTCPeerConnection()
            pc2.createDataChannel("link", ordered=False, maxRetransmits=0)
            offer2 = await pc2.createOffer()
            await pc2.setLocalDescription(offer2)
            await ws2.send(json.dumps({"type": "offer", "sdp": pc2.localDescription.sdp}))
            resp2 = json.loads(await ws2.recv())
            await pc2.setRemoteDescription(RTCSessionDescription(sdp=resp2["sdp"], type="answer"))

            # Server's active connection MUST now be client 2, and client 1's connection was torn down!
            assert link.backend.current_pc is not None
            assert link.backend.current_pc != first_pc

            await pc2.close()

        await pc1.close()

    await link.close()

def time_now():
    import time
    return time.time() * 1000.0
