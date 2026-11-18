import asyncio
import argparse
import sys
from pathlib import Path

# Add src/python to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "python"))

from link import ResilientLink
from config import TERRESTRIAL_HIGH_BER_PROFILE, STARLINK_PROFILE

async def main():
    parser = argparse.ArgumentParser(description="libPharosRTC Embedded Test Server Daemon")
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind signaling server")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind signaling server")
    parser.add_argument("--profile", default="terrestrial", choices=["terrestrial", "starlink"], help="Link profile")
    args = parser.parse_args()

    link_cfg = TERRESTRIAL_HIGH_BER_PROFILE if args.profile == "terrestrial" else STARLINK_PROFILE
    link = ResilientLink(link_config=link_cfg)

    # Store received C2 messages and echo back for latency testing
    def on_c2_message(payload: bytes):
        text = payload.decode("utf-8", errors="replace")
        print(f"[SERVER RX C2] {text}", flush=True)
        # Echo back C2 response
        success = link.send(0, f"ACK:{text}".encode("utf-8"))
        print(f"[SERVER TX C2 ACK] ACK:{text} (sent={success})", flush=True)

    def on_bulk_message(payload: bytes):
        print(f"[SERVER RX BULK] Chunk {len(payload)} bytes", flush=True)

    link.on_receive(0, on_c2_message)
    link.on_receive(2, on_bulk_message)

    await link.start_signaling(host=args.host, port=args.port)
    print(f"[SERVER READY] Running on ws://{args.host}:{args.port}/ws/webrtc ({args.profile})", flush=True)

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await link.close()

if __name__ == "__main__":
    asyncio.run(main())
