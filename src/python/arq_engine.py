from dataclasses import dataclass
import time
from typing import Callable, Dict, List, Optional, Union

from config import DEFAULT_CHANNELS, ChannelConfig, DeliveryMode, LinkConfig
from frame_codec import (
    FLAG_ACK_ONLY,
    FLAG_MSG_END,
    Frame,
    seq_diff,
    seq_less_than,
)
from priority_scheduler import PriorityScheduler

@dataclass
class ArqStats:
    tx_frames: int
    rx_frames: int
    retransmissions: int
    smoothed_rtt_ms: float
    rtt_var_ms: float
    current_rto_ms: float
    estimated_packet_loss: float

@dataclass
class SentSlot:
    seq: int
    frame: Frame
    first_sent_ts: float
    last_sent_ts: float
    retransmit_count: int = 0
    acked: bool = False

@dataclass
class RtoState:
    srtt: float
    rttvar: float
    rto: float
    has_sample: bool = False

MessageCallback = Callable[[int, bytes], None]

class ArqEngine:
    def __init__(
        self,
        link_config: LinkConfig,
        channel_configs: Optional[List[ChannelConfig]] = None,
    ):
        self.link_config = link_config
        cfgs = channel_configs if channel_configs is not None else DEFAULT_CHANNELS

        self.channel_configs: Dict[int, ChannelConfig] = {}
        self.sent_slots: Dict[int, Dict[int, SentSlot]] = {}
        self.rto_state: Dict[int, RtoState] = {}
        self.next_expected_seq: Dict[int, int] = {}
        self.reorder_buffers: Dict[int, Dict[int, Frame]] = {}
        self.assembly_buffers: Dict[int, List[bytes]] = {}

        self.tx_frames: Dict[int, int] = {}
        self.rx_frames: Dict[int, int] = {}
        self.retransmissions: Dict[int, int] = {}

        self.message_callbacks: List[MessageCallback] = []

        for cfg in cfgs:
            self.channel_configs[cfg.id] = cfg
            self.sent_slots[cfg.id] = {}
            self.rto_state[cfg.id] = RtoState(
                srtt=float(link_config.initial_rto_ms),
                rttvar=float(link_config.initial_rto_ms) / 2.0,
                rto=float(link_config.initial_rto_ms),
                has_sample=False,
            )
            self.next_expected_seq[cfg.id] = 0
            self.reorder_buffers[cfg.id] = {}
            self.assembly_buffers[cfg.id] = []
            self.tx_frames[cfg.id] = 0
            self.rx_frames[cfg.id] = 0
            self.retransmissions[cfg.id] = 0

        self.scheduler = PriorityScheduler(link_config, channel_configs)

    def get_scheduler(self) -> PriorityScheduler:
        return self.scheduler

    def on_message(self, cb: MessageCallback) -> None:
        self.message_callbacks.append(cb)

    def send_message(self, chid: int, payload: Union[bytes, bytearray, memoryview]) -> List[int]:
        return self.scheduler.enqueue_message(chid, payload)

    def get_rto(self, chid: int) -> float:
        state = self.rto_state.get(chid)
        return state.rto if state else float(self.link_config.initial_rto_ms)

    def get_stats(self, chid: int) -> ArqStats:
        tx = self.tx_frames.get(chid, 0)
        rx = self.rx_frames.get(chid, 0)
        retx = self.retransmissions.get(chid, 0)
        state = self.rto_state.get(chid)
        loss = float(retx) / float(tx) if tx > 0 else 0.0

        return ArqStats(
            tx_frames=tx,
            rx_frames=rx,
            retransmissions=retx,
            smoothed_rtt_ms=state.srtt if state else 0.0,
            rtt_var_ms=state.rttvar if state else 0.0,
            current_rto_ms=state.rto if state else float(self.link_config.initial_rto_ms),
            estimated_packet_loss=loss,
        )

    def dequeue_next_frame(
        self, now: Optional[float] = None, buffered_amount: Optional[int] = None
    ) -> Optional[Frame]:
        timestamp = now if now is not None else time.time() * 1000.0
        self.check_retransmissions(timestamp)

        frame = self.scheduler.dequeue_next_frame(buffered_amount)
        if frame is None:
            return None

        chid = frame.header.chid
        self.tx_frames[chid] = self.tx_frames.get(chid, 0) + 1

        cfg = self.channel_configs.get(chid)
        if (
            cfg
            and cfg.mode == DeliveryMode.RELIABLE_ORDERED
            and (frame.header.flags & FLAG_ACK_ONLY) == 0
        ):
            seq_map = self.sent_slots[chid]
            if frame.header.sequence_number not in seq_map:
                seq_map[frame.header.sequence_number] = SentSlot(
                    seq=frame.header.sequence_number,
                    frame=frame,
                    first_sent_ts=timestamp,
                    last_sent_ts=timestamp,
                    retransmit_count=0,
                    acked=False,
                )

        return frame

    def tick(self, now: Optional[float] = None) -> None:
        timestamp = now if now is not None else time.time() * 1000.0
        self.check_retransmissions(timestamp)

    def check_retransmissions(self, now: float) -> None:
        for chid, cfg in self.channel_configs.items():
            if cfg.mode != DeliveryMode.RELIABLE_ORDERED:
                continue

            rto = self.rto_state[chid].rto
            slots = self.sent_slots[chid]

            for slot in slots.values():
                if not slot.acked and (now - slot.last_sent_ts >= rto):
                    slot.retransmit_count += 1
                    slot.last_sent_ts = now
                    self.retransmissions[chid] = self.retransmissions.get(chid, 0) + 1
                    self.scheduler.enqueue_retransmission(chid, slot.frame)

    def on_wire_frame(self, frame: Frame, now: Optional[float] = None) -> None:
        timestamp = now if now is not None else time.time() * 1000.0
        chid = frame.header.chid
        self.rx_frames[chid] = self.rx_frames.get(chid, 0) + 1

        # Process piggybacked ACK
        self._process_ack(
            frame.header.ack_chid,
            frame.header.cumulative_ack_seq,
            frame.header.sack_mask,
            timestamp,
        )

        # Standalone ACK check
        if (frame.header.flags & FLAG_ACK_ONLY) != 0:
            return

        cfg = self.channel_configs.get(chid)
        if not cfg:
            return

        payload_bytes = bytes(frame.payload)

        if cfg.mode == DeliveryMode.UNRELIABLE_UNORDERED:
            assembly = self.assembly_buffers[chid]
            if len(payload_bytes) > 0:
                assembly.append(payload_bytes)
            if (frame.header.flags & FLAG_MSG_END) != 0:
                full_msg = b"".join(assembly)
                assembly.clear()
                self._emit_message(chid, full_msg)
            return

        # RELIABLE_ORDERED
        seq = frame.header.sequence_number
        expected_seq = self.next_expected_seq[chid]

        if seq_less_than(seq, expected_seq):
            # Duplicate frame, update ACK state for sender
            self._update_pending_ack(chid)
            return

        reorder_buf = self.reorder_buffers[chid]
        if seq == expected_seq:
            assembly = self.assembly_buffers[chid]
            assembly.append(payload_bytes)

            if (frame.header.flags & FLAG_MSG_END) != 0:
                full_msg = b"".join(assembly)
                assembly.clear()
                self._emit_message(chid, full_msg)

            expected_seq = (expected_seq + 1) & 0xFFFFFFFF

            while expected_seq in reorder_buf:
                next_frame = reorder_buf.pop(expected_seq)
                next_payload = bytes(next_frame.payload)
                assembly.append(next_payload)

                if (next_frame.header.flags & FLAG_MSG_END) != 0:
                    full_msg = b"".join(assembly)
                    assembly.clear()
                    self._emit_message(chid, full_msg)

                expected_seq = (expected_seq + 1) & 0xFFFFFFFF

            self.next_expected_seq[chid] = expected_seq
        else:
            # Out of order
            reorder_buf[seq] = frame

        self._update_pending_ack(chid)

    def _process_ack(self, ack_chid: int, cum_ack_seq: int, sack_mask: int, now: float) -> None:
        slots = self.sent_slots.get(ack_chid)
        if not slots:
            return

        for seq, slot in list(slots.items()):
            if slot.acked:
                continue

            is_acked = False
            # Cumulative ACK: seq <= cum_ack_seq
            if not seq_less_than(cum_ack_seq, seq):
                is_acked = True
            else:
                # SACK bitmask check
                diff = seq_diff(seq, (cum_ack_seq + 1) & 0xFFFFFFFF)
                if 0 <= diff < 16:
                    if (sack_mask & (1 << diff)) != 0:
                        is_acked = True

            if is_acked:
                slot.acked = True
                self.scheduler.release_in_flight(ack_chid, 1)

                # Karn's algorithm: update RTO on clean (non-retransmitted) frames only
                if slot.retransmit_count == 0:
                    rtt = max(1.0, now - slot.first_sent_ts)
                    self._update_rto(ack_chid, rtt)

        # Clean up acked slots
        for seq in list(slots.keys()):
            if slots[seq].acked:
                del slots[seq]

    def _update_rto(self, chid: int, rtt_ms: float) -> None:
        state = self.rto_state[chid]
        if not state.has_sample:
            state.srtt = rtt_ms
            state.rttvar = rtt_ms / 2.0
            state.has_sample = True
        else:
            alpha = 0.125
            beta = 0.25
            state.rttvar = (1.0 - beta) * state.rttvar + beta * abs(state.srtt - rtt_ms)
            state.srtt = (1.0 - alpha) * state.srtt + alpha * rtt_ms

        raw_rto = state.srtt + 4.0 * state.rttvar
        state.rto = max(
            float(self.link_config.min_rto_ms),
            min(float(self.link_config.max_rto_ms), raw_rto),
        )

    def _update_pending_ack(self, chid: int) -> None:
        expected_seq = self.next_expected_seq[chid]
        cum_ack_seq = (expected_seq - 1) & 0xFFFFFFFF
        sack_mask = self._calculate_sack_mask(chid)
        self.scheduler.set_pending_ack(chid, cum_ack_seq, sack_mask)

    def _calculate_sack_mask(self, chid: int) -> int:
        expected_seq = self.next_expected_seq[chid]
        buffer = self.reorder_buffers.get(chid)
        if not buffer:
            return 0

        mask = 0
        for i in range(16):
            target_seq = (expected_seq + i) & 0xFFFFFFFF
            if target_seq in buffer:
                mask |= 1 << i
        return mask

    def _emit_message(self, chid: int, payload: bytes) -> None:
        for cb in self.message_callbacks:
            cb(chid, payload)
