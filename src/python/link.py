import logging
from typing import Callable, List, Optional, Union

from arq_engine import ArqStats
from config import ChannelConfig, LinkConfig
from signaling_server import SignalingServer
from webrtc_backend import WebRtcBackend

logger = logging.getLogger("link")

class ResilientLink:
    def __init__(
        self,
        link_config: Optional[LinkConfig] = None,
        channel_configs: Optional[List[ChannelConfig]] = None,
        cert_path: str = "/tmp/webrtc_cert.pem",
        key_path: str = "/tmp/webrtc_key.pem",
    ):
        self.backend = WebRtcBackend(
            link_config=link_config,
            channel_configs=channel_configs,
            cert_path=cert_path,
            key_path=key_path,
        )
        self.signaling_server: Optional[SignalingServer] = None

    async def start_signaling(
        self, host: str = "0.0.0.0", port: int = 8765, path: str = "/ws/webrtc"
    ) -> None:
        self.signaling_server = SignalingServer(
            backend=self.backend,
            host=host,
            port=port,
            path=path,
        )
        await self.signaling_server.start()

    async def stop_signaling(self) -> None:
        if self.signaling_server:
            await self.signaling_server.stop()
            self.signaling_server = None

    async def accept_offer(self, offer_sdp: str) -> str:
        return await self.backend.handle_offer(offer_sdp)

    def send(self, channel_id: int, payload: Union[bytes, bytearray, memoryview]) -> bool:
        return self.backend.send(channel_id, payload)

    def on_receive(self, channel_id: int, callback: Callable[[bytes], None]) -> None:
        self.backend.on_receive(channel_id, callback)

    def get_stats(self, channel_id: int) -> ArqStats:
        return self.backend.get_stats(channel_id)

    async def close(self) -> None:
        await self.stop_signaling()
        await self.backend.close()
