import asyncio
import logging
from pathlib import Path
import re
import time
from typing import Callable, Dict, List, Optional, Union

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription, RTCCertificate
from cryptography import x509
from cryptography.hazmat.primitives import serialization

from arq_engine import ArqEngine, ArqStats
from config import DEFAULT_CHANNELS, ChannelConfig, LinkConfig, TERRESTRIAL_HIGH_BER_PROFILE
from frame_codec import decode_frame, encode_frame, Frame

logger = logging.getLogger("webrtc_backend")

def sanitize_sdp_offer(sdp: str, client_ip: str = "127.0.0.1") -> str:
    if not sdp or ".local" not in sdp:
        return sdp

    lines = sdp.splitlines()
    filtered = [l for l in lines if not ("a=candidate:" in l and ".local" in l)]
    return "\r\n".join(filtered) + "\r\n"

def get_or_create_ecdsa_certificate(
    cert_path: str = "/tmp/webrtc_cert.pem",
    key_path: str = "/tmp/webrtc_key.pem",
) -> RTCCertificate:
    cert_file = Path(cert_path)
    key_file = Path(key_path)

    if cert_file.exists() and key_file.exists():
        try:
            key_pem = key_file.read_bytes()
            cert_pem = cert_file.read_bytes()
            loaded_key = serialization.load_pem_private_key(key_pem, password=None)
            loaded_cert = x509.load_pem_x509_certificate(cert_pem)
            return RTCCertificate(key=loaded_key, cert=loaded_cert)
        except Exception as e:
            logger.warning(f"Failed to load existing cert/key from disk, generating new: {e}")

    cert_obj = RTCCertificate.generateCertificate()
    try:
        cert_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.parent.mkdir(parents=True, exist_ok=True)

        key_pem = cert_obj._key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
        cert_pem = cert_obj._cert.public_bytes(serialization.Encoding.PEM)

        key_file.write_bytes(key_pem)
        cert_file.write_bytes(cert_pem)
    except Exception as e:
        logger.warning(f"Failed to write certificate/key to disk: {e}")

    return cert_obj

class WebRtcBackend:
    def __init__(
        self,
        link_config: Optional[LinkConfig] = None,
        channel_configs: Optional[List[ChannelConfig]] = None,
        cert_path: str = "/tmp/webrtc_cert.pem",
        key_path: str = "/tmp/webrtc_key.pem",
    ):
        self.link_config = link_config or TERRESTRIAL_HIGH_BER_PROFILE
        self.channel_configs = channel_configs or DEFAULT_CHANNELS
        self.cert_path = cert_path
        self.key_path = key_path

        self.arq_engine = ArqEngine(self.link_config, self.channel_configs)

        self.current_pc: Optional[RTCPeerConnection] = None
        self.current_channel = None
        self._tick_task: Optional[asyncio.Task] = None
        self._receive_callbacks: Dict[int, List[Callable[[bytes], None]]] = {}

        # Wire up ARQ message handler to route to receive callbacks
        self.arq_engine.on_message(self._handle_arq_message)

    def _handle_arq_message(self, chid: int, payload: bytes) -> None:
        cbs = self._receive_callbacks.get(chid, [])
        for cb in cbs:
            try:
                cb(payload)
            except Exception as e:
                logger.error(f"Error in receive callback for chid {chid}: {e}")

    def on_receive(self, chid: int, callback: Callable[[bytes], None]) -> None:
        if chid not in self._receive_callbacks:
            self._receive_callbacks[chid] = []
        self._receive_callbacks[chid].append(callback)

    def send(self, chid: int, payload: Union[bytes, bytearray, memoryview]) -> bool:
        try:
            self.arq_engine.send_message(chid, payload)
            return True
        except Exception as e:
            logger.error(f"Failed to send message on chid {chid}: {e}")
            return False

    def get_stats(self, chid: int) -> ArqStats:
        return self.arq_engine.get_stats(chid)

    async def handle_offer(self, offer_sdp: str, client_ip: str = "127.0.0.1") -> str:
        # Session Preemption: tear down old connection and reset ARQ state
        await self.close_active_session()

        # Re-initialize ARQ Engine for fresh session
        self.arq_engine = ArqEngine(self.link_config, self.channel_configs)
        self.arq_engine.on_message(self._handle_arq_message)

        cert = get_or_create_ecdsa_certificate(self.cert_path, self.key_path)
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        setattr(pc, "_RTCPeerConnection__certificates", [cert])
        self.current_pc = pc

        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(f"[{time.time():.3f}] DataChannel opened on server: {channel.label}")
            self.current_channel = channel

            @channel.on("message")
            def on_message(message):
                if isinstance(message, (bytes, bytearray, memoryview)):
                    try:
                        frame = decode_frame(message)
                        timestamp = time.time() * 1000.0
                        self.arq_engine.on_wire_frame(frame, now=timestamp)
                    except Exception as e:
                        logger.error(f"Failed to decode incoming frame: {e}")

        @pc.on("connectionstatechange")
        async def on_state_change():
            logger.info(f"[{time.time():.3f}] WebRTC connection state: {pc.connectionState}")
            if pc.connectionState in ["failed", "closed", "disconnected"]:
                pass

        sanitized_sdp = sanitize_sdp_offer(offer_sdp, client_ip)
        offer = RTCSessionDescription(sdp=sanitized_sdp, type="offer")
        await pc.setRemoteDescription(offer)

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        # Start outbound tick loop task
        self._tick_task = asyncio.create_task(self._outbound_loop())

        return pc.localDescription.sdp

    async def _outbound_loop(self) -> None:
        try:
            while self.current_pc and self.current_pc.connectionState != "closed":
                await asyncio.sleep(0.005)  # 5ms tick loop
                now = time.time() * 1000.0
                self.arq_engine.tick(now)

                if self.current_channel and getattr(self.current_channel, "readyState", None) == "open":
                    while True:
                        buffered_amount = getattr(self.current_channel, "bufferedAmount", 0)
                        frame = self.arq_engine.dequeue_next_frame(now=now, buffered_amount=buffered_amount)
                        if frame is None:
                            break

                        encoded = encode_frame(frame)
                        self.current_channel.send(encoded)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error in WebRTC outbound loop: {e}")

    async def close_active_session(self) -> None:
        if self._tick_task and not self._tick_task.done():
            this_task = self._tick_task
            self._tick_task = None
            this_task.cancel()
            try:
                await this_task
            except asyncio.CancelledError:
                pass

        if self.current_channel:
            self.current_channel = None

        if self.current_pc:
            pc = self.current_pc
            self.current_pc = None
            try:
                await pc.close()
            except Exception as e:
                logger.warning(f"Error closing RTCPeerConnection: {e}")

    async def close(self) -> None:
        await self.close_active_session()
