from dataclasses import dataclass
from typing import Dict, List, Optional, Union

from config import DEFAULT_CHANNELS, ChannelConfig, DeliveryMode, LinkConfig
from frame_codec import (
    FLAG_ACK_ONLY,
    FLAG_MSG_END,
    HEADER_SIZE_BYTES,
    PROTOCOL_VERSION,
    Frame,
    FrameHeader,
)

@dataclass
class PendingAck:
    has_ack: bool = False
    ack_chid: int = 0
    cum_ack_seq: int = 0
    sack_mask: int = 0

class PriorityScheduler:
    def __init__(
        self,
        link_config: LinkConfig,
        channel_configs: Optional[List[ChannelConfig]] = None,
    ):
        self.link_config = link_config
        cfgs = channel_configs if channel_configs is not None else DEFAULT_CHANNELS

        self.channel_configs: Dict[int, ChannelConfig] = {}
        self.new_frame_queues: Dict[int, List[Frame]] = {}
        self.retransmit_queues: Dict[int, List[Frame]] = {}
        self.next_seq_nums: Dict[int, int] = {}
        self.in_flight_counts: Dict[int, int] = {}

        for cfg in cfgs:
            self.channel_configs[cfg.id] = cfg
            self.new_frame_queues[cfg.id] = []
            self.retransmit_queues[cfg.id] = []
            self.next_seq_nums[cfg.id] = 0
            self.in_flight_counts[cfg.id] = 0

        # Sort channels by priority ascending (0 highest)
        sorted_cfgs = sorted(self.channel_configs.values(), key=lambda c: c.priority)
        self.sorted_chids: List[int] = [c.id for c in sorted_cfgs]

        self.pending_ack = PendingAck()

    def can_send(self, buffered_amount: int) -> bool:
        return buffered_amount < self.get_low_water_mark()

    def get_low_water_mark(self) -> int:
        return 64 * self.link_config.app_mtu_bytes

    def enqueue_message(
        self,
        chid: int,
        payload: Union[bytes, bytearray, memoryview],
        extra_flags: int = 0,
    ) -> List[int]:
        if chid not in self.channel_configs:
            raise ValueError(f"Channel {chid} is not configured")

        mv = memoryview(payload)
        max_payload = self.link_config.app_mtu_bytes - HEADER_SIZE_BYTES
        seq_nums_assigned: List[int] = []
        next_seq = self.next_seq_nums[chid]
        queue = self.new_frame_queues[chid]

        if len(mv) == 0:
            seq = next_seq
            next_seq = (next_seq + 1) & 0xFFFFFFFF
            header = FrameHeader(
                version=PROTOCOL_VERSION,
                flags=extra_flags | FLAG_MSG_END,
                chid=chid,
                ack_chid=0,
                payload_length=0,
                sequence_number=seq,
                cumulative_ack_seq=0,
                sack_mask=0,
            )
            queue.append(Frame(header=header, payload=b""))
            seq_nums_assigned.append(seq)
        else:
            offset = 0
            while offset < len(mv):
                chunk_size = min(max_payload, len(mv) - offset)
                chunk = mv[offset : offset + chunk_size]
                offset += chunk_size
                is_last = offset >= len(mv)

                seq = next_seq
                next_seq = (next_seq + 1) & 0xFFFFFFFF
                flags = extra_flags | (FLAG_MSG_END if is_last else 0)

                header = FrameHeader(
                    version=PROTOCOL_VERSION,
                    flags=flags,
                    chid=chid,
                    ack_chid=0,
                    payload_length=chunk_size,
                    sequence_number=seq,
                    cumulative_ack_seq=0,
                    sack_mask=0,
                )
                queue.append(Frame(header=header, payload=chunk))
                seq_nums_assigned.append(seq)

        self.next_seq_nums[chid] = next_seq
        return seq_nums_assigned

    def enqueue_retransmission(self, chid: int, frame: Frame) -> None:
        if chid not in self.retransmit_queues:
            raise ValueError(f"Channel {chid} is not configured")
        self.retransmit_queues[chid].append(frame)

    def set_pending_ack(self, ack_chid: int, cum_ack_seq: int, sack_mask: int) -> None:
        self.pending_ack = PendingAck(
            has_ack=True,
            ack_chid=ack_chid,
            cum_ack_seq=cum_ack_seq,
            sack_mask=sack_mask,
        )

    def has_pending_ack(self) -> bool:
        return self.pending_ack.has_ack

    def has_pending_frames(self) -> bool:
        for q in self.retransmit_queues.values():
            if len(q) > 0:
                return True
        for chid in self.sorted_chids:
            q = self.new_frame_queues[chid]
            if len(q) > 0:
                cfg = self.channel_configs[chid]
                if cfg.mode == DeliveryMode.UNRELIABLE_UNORDERED or cfg.window_size <= 0:
                    return True
                if self.in_flight_counts[chid] < cfg.window_size:
                    return True
        return self.pending_ack.has_ack

    def dequeue_next_frame(self, buffered_amount: Optional[int] = None) -> Optional[Frame]:
        if buffered_amount is not None and not self.can_send(buffered_amount):
            return None

        # 1. Expired Retransmissions on highest-priority channel first
        for chid in self.sorted_chids:
            retx_queue = self.retransmit_queues[chid]
            if len(retx_queue) > 0:
                frame = retx_queue.pop(0)
                self._apply_piggybacked_ack(frame)
                return frame

        # 2. New Outbound Frames on highest-priority channel first
        for chid in self.sorted_chids:
            new_queue = self.new_frame_queues[chid]
            if len(new_queue) > 0:
                cfg = self.channel_configs[chid]
                if cfg.mode == DeliveryMode.RELIABLE_ORDERED and cfg.window_size > 0:
                    if self.in_flight_counts[chid] >= cfg.window_size:
                        continue  # Window full

                frame = new_queue.pop(0)
                if cfg.mode == DeliveryMode.RELIABLE_ORDERED and cfg.window_size > 0:
                    self.in_flight_counts[chid] += 1
                self._apply_piggybacked_ack(frame)
                return frame

        # 3. Standalone FLAG_ACK_ONLY Frame
        if self.pending_ack.has_ack:
            ack_frame = Frame(
                header=FrameHeader(
                    version=PROTOCOL_VERSION,
                    flags=FLAG_ACK_ONLY,
                    chid=self.sorted_chids[0] if self.sorted_chids else 0,
                    ack_chid=self.pending_ack.ack_chid,
                    payload_length=0,
                    sequence_number=0,
                    cumulative_ack_seq=self.pending_ack.cum_ack_seq,
                    sack_mask=self.pending_ack.sack_mask,
                ),
                payload=b"",
            )
            self.pending_ack.has_ack = False
            return ack_frame

        return None

    def _apply_piggybacked_ack(self, frame: Frame) -> None:
        if self.pending_ack.has_ack:
            parity_flag = frame.header.ack_chid & 0x80
            frame.header.ack_chid = (self.pending_ack.ack_chid & 0x7F) | parity_flag
            frame.header.cumulative_ack_seq = self.pending_ack.cum_ack_seq
            frame.header.sack_mask = self.pending_ack.sack_mask
            self.pending_ack.has_ack = False

    def release_in_flight(self, chid: int, count: int = 1) -> None:
        current = self.in_flight_counts.get(chid, 0)
        self.in_flight_counts[chid] = max(0, current - count)

    def remove_acked_retransmission(self, chid: int, seq: int) -> None:
        queue = self.retransmit_queues.get(chid)
        if queue:
            self.retransmit_queues[chid] = [f for f in queue if f.header.sequence_number != seq]

    def get_in_flight_count(self, chid: int) -> int:
        return self.in_flight_counts.get(chid, 0)

    def get_queue_depth(self, chid: int) -> dict:
        retransmit = len(this_q) if (this_q := self.retransmit_queues.get(chid)) else 0
        new_frames = len(this_q) if (this_q := self.new_frame_queues.get(chid)) else 0
        return {"retransmit": retransmit, "new_frames": new_frames}
