from dataclasses import dataclass
from enum import Enum
from typing import List

class DeliveryMode(str, Enum):
    RELIABLE_ORDERED = "RELIABLE_ORDERED"
    UNRELIABLE_UNORDERED = "UNRELIABLE_UNORDERED"

@dataclass(frozen=True)
class LinkConfig:
    app_mtu_bytes: int
    window_size_pkts: int
    initial_rto_ms: int
    min_rto_ms: int
    max_rto_ms: int
    ack_delay_ms: int
    keepalive_ms: int
    fec_xor_group: int = 0

TERRESTRIAL_HIGH_BER_PROFILE = LinkConfig(
    app_mtu_bytes=220,
    window_size_pkts=32,
    initial_rto_ms=60,
    min_rto_ms=30,
    max_rto_ms=1000,
    ack_delay_ms=10,
    keepalive_ms=200,
    fec_xor_group=4,
)

STARLINK_PROFILE = LinkConfig(
    app_mtu_bytes=900,
    window_size_pkts=64,
    initial_rto_ms=180,
    min_rto_ms=100,
    max_rto_ms=3000,
    ack_delay_ms=25,
    keepalive_ms=500,
    fec_xor_group=0,
)

@dataclass(frozen=True)
class ChannelConfig:
    id: int
    name: str
    mode: DeliveryMode
    priority: int
    window_size: int

DEFAULT_CHANNELS: List[ChannelConfig] = [
    ChannelConfig(id=0, name="c2", mode=DeliveryMode.RELIABLE_ORDERED, priority=0, window_size=16),
    ChannelConfig(id=1, name="telemetry", mode=DeliveryMode.UNRELIABLE_UNORDERED, priority=1, window_size=0),
    ChannelConfig(id=2, name="bulk_xfer", mode=DeliveryMode.RELIABLE_ORDERED, priority=2, window_size=64),
]
