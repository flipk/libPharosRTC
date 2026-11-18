import asyncio
import json
import logging
from typing import Optional
import websockets

from webrtc_backend import WebRtcBackend

logger = logging.getLogger("signaling_server")

class SignalingServer:
    def __init__(
        self,
        backend: WebRtcBackend,
        host: str = "0.0.0.0",
        port: int = 8765,
        path: str = "/ws/webrtc",
    ):
        self.backend = backend
        self.host = host
        self.port = port
        self.path = path
        self.server: Optional[websockets.WebSocketServer] = None

    async def _handle_connection(self, websocket, path: str = ""):
        logger.info(f"New WebSocket client connected on path: {path}")
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "offer":
                        offer_sdp = data.get("sdp")
                        if not offer_sdp:
                            await websocket.send(json.dumps({"error": "Missing sdp field in offer"}))
                            continue

                        answer_sdp = await self.backend.handle_offer(offer_sdp)
                        await websocket.send(json.dumps({
                            "type": "answer",
                            "sdp": answer_sdp
                        }))
                    elif msg_type == "candidate":
                        # Trickle ICE candidates (optional/handled by host candidate gather)
                        logger.debug(f"Received candidate: {data.get('candidate')}")
                    else:
                        logger.warning(f"Unknown message type: {msg_type}")
                except Exception as e:
                    logger.error(f"Error processing WebSocket message: {e}")
                    await websocket.send(json.dumps({"error": str(e)}))
        except websockets.exceptions.ConnectionClosed:
            logger.info("WebSocket client disconnected")

    async def start(self) -> None:
        if self.server is not None:
            return

        self.server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
        )
        logger.info(f"SignalingServer running on ws://{self.host}:{self.port}{self.path}")

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
            logger.info("SignalingServer stopped")
