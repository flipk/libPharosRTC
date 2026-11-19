#!/usr/bin/env python3
import asyncio
import argparse
import hashlib
import json
import logging
import os
import random
import sys
import time
from pathlib import Path

# Add src/python to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "python"))

from aiohttp import web
from config import TERRESTRIAL_HIGH_BER_PROFILE, STARLINK_PROFILE
from link import ResilientLink

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("demo_server")

# Global impairment state for server outbound loss simulation
server_loss_rate = 0.0
server_loss_dir = "both"

class DemoServer:
    def __init__(self, host: str, port: int, profile: str, static_dir: str):
        self.host = host
        self.port = port
        self.profile_name = profile
        self.static_dir = Path(static_dir).resolve()

        link_cfg = TERRESTRIAL_HIGH_BER_PROFILE if profile == "terrestrial" else STARLINK_PROFILE
        self.link = ResilientLink(link_config=link_cfg)

        # File assembly state for uploads (Client -> Server)
        self.upload_buffer = bytearray()
        self.upload_expected_size = 0
        self.upload_expected_hash = ""
        self.upload_received_bytes = 0
        self.upload_received_offsets = set()

        # Hook receive handlers
        self.link.on_receive(0, self.handle_c2_message)
        self.link.on_receive(2, self.handle_bulk_message)

        # Wrap backend channel send to apply simulated outbound packet loss
        self._patch_outbound_loss()

    def _patch_outbound_loss(self):
        backend = self.link.backend
        original_outbound_loop = backend._outbound_loop

        async def patched_outbound_loop():
            try:
                while backend.current_pc and backend.current_pc.connectionState != "closed":
                    await asyncio.sleep(0.005)
                    now = time.time() * 1000.0
                    backend.arq_engine.tick(now)

                    if backend.current_channel and getattr(backend.current_channel, "readyState", None) == "open":
                        while True:
                            buffered_amount = getattr(backend.current_channel, "bufferedAmount", 0)
                            frame = backend.arq_engine.dequeue_next_frame(now=now, buffered_amount=buffered_amount)
                            if frame is None:
                                break

                            # Apply server-side outbound loss simulation
                            if server_loss_rate > 0 and server_loss_dir in ("both", "server_tx"):
                                if random.random() < server_loss_rate:
                                    continue # Drop packet

                            from frame_codec import encode_frame
                            encoded = encode_frame(frame)
                            backend.current_channel.send(encoded)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.error(f"Error in patched outbound loop: {e}")

        backend._outbound_loop = patched_outbound_loop

    def handle_c2_message(self, payload: bytes):
        try:
            text = payload.decode("utf-8")
            data = json.loads(text)

            if data.get("type") == "set_loss":
                global server_loss_rate, server_loss_dir
                server_loss_rate = float(data.get("rate", 0.0))
                server_loss_dir = str(data.get("direction", "both"))
                logger.info(f"[SERVER IMPAIRMENT] Set outbound loss rate to {server_loss_rate*100:.1f}% ({server_loss_dir})")
                return

            if data.get("type") == "request_download":
                size = int(data.get("size", 1048576))
                logger.info(f"[SERVER DOWNLOAD] Client requested download of {size} bytes")
                asyncio.create_task(self.stream_download_to_client(size))
                return

        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

        # Echo back C2 command for latency testing
        text_str = payload.decode("utf-8", errors="replace")
        logger.info(f"[C2 RECV] {text_str}")
        self.link.send(0, f"ACK: {text_str}".encode("utf-8"))

    def handle_bulk_message(self, payload: bytes):
        if not payload:
            return

        type_byte = payload[0]

        if type_byte == 0x01:
            # META FRAME: [0x01][4 bytes size][32 bytes sha256]
            if len(payload) >= 37:
                self.upload_expected_size = int.from_bytes(payload[1:5], "big")
                self.upload_expected_hash = payload[5:37].hex()
                self.upload_buffer = bytearray(self.upload_expected_size)
                self.upload_received_bytes = 0
                self.upload_received_offsets = set()
                logger.info(f"[UPLOAD META] Expecting {self.upload_expected_size} bytes (SHA256: {self.upload_expected_hash[:8]}...)")

        elif type_byte == 0x02:
            # CHUNK FRAME: [0x02][4 bytes offset][payload bytes]
            if len(payload) >= 5 and self.upload_expected_size > 0:
                offset = int.from_bytes(payload[1:5], "big")
                chunk_data = payload[5:]
                chunk_len = len(chunk_data)

                if offset not in self.upload_received_offsets:
                    self.upload_received_offsets.add(offset)
                    self.upload_buffer[offset : offset + chunk_len] = chunk_data
                    self.upload_received_bytes += chunk_len
                    logger.info(f"[UPLOAD PROGRESS] Received chunk offset={offset} len={chunk_len} -> {self.upload_received_bytes}/{self.upload_expected_size} bytes ({self.upload_received_bytes/self.upload_expected_size*100:.1f}%)")
                    prog_msg = json.dumps({"type": "upload_progress", "received": self.upload_received_bytes, "total": self.upload_expected_size})
                    self.link.send(0, prog_msg.encode("utf-8"))

                if self.upload_received_bytes >= self.upload_expected_size:
                    computed_hash = hashlib.sha256(self.upload_buffer).hexdigest()
                    hash_match = computed_hash == self.upload_expected_hash
                    logger.info(f"[UPLOAD COMPLETE] Received {self.upload_received_bytes} bytes. Hash Match: {hash_match}")

                    # Send Completion ACK on ChID 2 and ChID 0
                    ack_frame = bytearray([0x03]) + hashlib.sha256(self.upload_buffer).digest()
                    self.link.send(2, bytes(ack_frame))
                    c2_ack = json.dumps({"type": "upload_complete", "hash_match": hash_match, "size": self.upload_received_bytes})
                    self.link.send(0, c2_ack.encode("utf-8"))

    async def stream_download_to_client(self, size_bytes: int):
        # Generate synthetic data
        data = bytearray(size_bytes)
        for i in range(size_bytes):
            data[i] = (i * 31 + 17) & 0xFF
        raw_bytes = bytes(data)

        digest = hashlib.sha256(raw_bytes).digest()

        # 1. Send Meta Frame on ChID 2
        meta_frame = bytearray([0x01]) + size_bytes.to_bytes(4, "big") + digest
        self.link.send(2, bytes(meta_frame))

        # 2. Stream Chunk Frames
        chunk_size = 65536
        offset = 0
        while offset < size_bytes:
            end = min(offset + chunk_size, size_bytes)
            slice_data = raw_bytes[offset:end]

            chunk_frame = bytearray([0x02]) + offset.to_bytes(4, "big") + slice_data

            # Apply backpressure: wait if new_frames queue on bulk channel is too deep
            while True:
                q_depth = self.link.backend.arq_engine.get_scheduler().get_queue_depth(2)
                if q_depth["new_frames"] < 100:
                    break
                await asyncio.sleep(0.01)

            self.link.send(2, bytes(chunk_frame))

            offset = end
            await asyncio.sleep(0.015)

        # Notify C2
        completion_msg = json.dumps({"type": "download_complete", "size": size_bytes})
        self.link.send(0, completion_msg.encode("utf-8"))

    async def handle_websocket(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        logger.info("New WebSocket connection established for WebRTC signaling.")

        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")

                    if msg_type == "offer":
                        t0 = time.time()
                        logger.info(f"[{t0:.3f}] Received SDP Offer from browser client.")
                        offer_sdp = data.get("sdp")
                        client_ip = request.remote or "127.0.0.1"
                        answer_sdp = await self.link.accept_offer(offer_sdp, client_ip=client_ip)
                        t1 = time.time()
                        logger.info(f"[{t1:.3f}] Generated SDP Answer in {(t1-t0)*1000:.1f}ms. Sending to client...")
                        await ws.send_json({"type": "answer", "sdp": answer_sdp})
                    elif msg_type == "candidate":
                        pass
                elif msg.type == web.WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")
        finally:
            logger.info("WebSocket connection closed.")
        return ws

    async def handle_index(self, request):
        index_file = self.static_dir / "index.html"
        if index_file.exists():
            return web.FileResponse(index_file)
        return web.Response(text="Demo static assets not built yet. Run 'npm run build:demo' first.", status=404)

async def main():
    parser = argparse.ArgumentParser(description="libPharosRTC Interactive Lossy Link Demo Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind HTTP and signaling server")
    parser.add_argument("--port", type=int, default=2500, help="Port to bind HTTP and signaling server")
    parser.add_argument("--profile", default="terrestrial", choices=["terrestrial", "starlink"], help="Link profile")
    parser.add_argument("--static-dir", default="demo/static", help="Path to static web assets directory")
    args = parser.parse_args()

    server = DemoServer(host=args.host, port=args.port, profile=args.profile, static_dir=args.static_dir)

    app = web.Application()
    app.router.add_get("/ws/webrtc", server.handle_websocket)
    app.router.add_get("/", server.handle_index)

    static_path = Path(args.static_dir).resolve()
    if static_path.exists():
        app.router.add_static("/", static_path)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    url = f"http://{args.host}:{args.port}"
    print("=" * 68, flush=True)
    print(" PharosRTC Interactive Lossy Link Demo Server", flush=True)
    print(" Open Chrome or your web browser at:", flush=True)
    print(f"   --> {url}", flush=True)
    print("=" * 68, flush=True)
    print(f"[INFO] WebRTC Signaling Endpoint: ws://{args.host}:{args.port}/ws/webrtc", flush=True)
    print(f"[INFO] Profile: {args.profile.upper()} | Static Dir: {static_path}", flush=True)
    print("[READY] Server running. Press Ctrl+C to exit.", flush=True)

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await runner.cleanup()
        await server.link.close()

if __name__ == "__main__":
    asyncio.run(main())
