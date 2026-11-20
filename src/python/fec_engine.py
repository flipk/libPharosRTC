import struct
from typing import Dict, List, Optional, Tuple, Union

from frame_codec import FLAG_ACK_ONLY, FLAG_MSG_END, PROTOCOL_VERSION, Frame, FrameHeader

FLAG_FEC_PARITY = 0x80

def xor_buffers(buffers: List[Union[bytes, bytearray, memoryview]]) -> bytes:
    if not buffers:
        return b""

    max_len = max(len(b) for b in buffers)
    result = bytearray(max_len)

    for buf in buffers:
        mv = memoryview(buf)
        for i in range(len(mv)):
            result[i] ^= mv[i]

    return bytes(result)

def encode_parity_payload(
    group_seq_start: int,
    group_size: int,
    parity_bytes: bytes,
    flags_mask: int = 0,
    end_lengths: Optional[Dict[int, int]] = None,
) -> bytes:
    hdr = struct.pack("!IHH", group_seq_start & 0xFFFFFFFF, group_size & 0xFFFF, flags_mask & 0xFFFF)
    lengths_bytes = bytearray()
    if end_lengths:
        for i in range(group_size):
            if (flags_mask & (1 << i)) != 0:
                l = end_lengths.get(i, 0)
                lengths_bytes += struct.pack("!H", l & 0xFFFF)
    return hdr + bytes(lengths_bytes) + parity_bytes

def decode_parity_payload(payload: Union[bytes, bytearray, memoryview]) -> Tuple[int, int, bytes, int, Dict[int, int]]:
    mv = memoryview(payload)
    if len(mv) < 6:
        raise ValueError("Parity payload buffer too short")
    group_seq_start, group_size = struct.unpack_from("!IH", mv, 0)
    flags_mask = 0
    end_lengths: Dict[int, int] = {}
    offset = 6
    if len(mv) >= 8:
        flags_mask = struct.unpack_from("!H", mv, 6)[0]
        offset = 8
        for i in range(group_size):
            if (flags_mask & (1 << i)) != 0:
                if offset + 2 <= len(mv):
                    end_lengths[i] = struct.unpack_from("!H", mv, offset)[0]
                    offset += 2
    parity_bytes = bytes(mv[offset:])
    return group_seq_start, group_size, parity_bytes, flags_mask, end_lengths

class FecEncoder:
    def __init__(self, group_size: int):
        self.group_size = group_size
        self.current_groups: Dict[int, List[Frame]] = {}

    def add_data_frame(self, frame: Frame) -> Optional[Frame]:
        if self.group_size <= 0:
            return None

        chid = frame.header.chid
        if chid not in self.current_groups:
            self.current_groups[chid] = []

        group = self.current_groups[chid]
        group.append(frame)

        if len(group) >= self.group_size:
            group_seq_start = group[0].header.sequence_number
            payloads = [bytes(f.payload) for f in group]
            parity_bytes = xor_buffers(payloads)

            flags_mask = 0
            end_lengths: Dict[int, int] = {}
            for i, f in enumerate(group):
                if (f.header.flags & FLAG_MSG_END) != 0:
                    flags_mask |= (1 << i)
                    end_lengths[i] = f.header.payload_length

            parity_payload = encode_parity_payload(group_seq_start, self.group_size, parity_bytes, flags_mask, end_lengths)
            last_frame_header = group[-1].header

            parity_frame = Frame(
                header=FrameHeader(
                    version=PROTOCOL_VERSION,
                    flags=FLAG_ACK_ONLY,
                    chid=last_frame_header.chid,
                    ack_chid=(last_frame_header.ack_chid & 0x7F) | FLAG_FEC_PARITY,
                    payload_length=len(parity_payload),
                    sequence_number=(last_frame_header.sequence_number + 1) & 0xFFFFFFFF,
                    cumulative_ack_seq=last_frame_header.cumulative_ack_seq,
                    sack_mask=last_frame_header.sack_mask,
                ),
                payload=parity_payload,
            )

            del self.current_groups[chid]
            return parity_frame

        return None

class FecDecoder:
    def __init__(self, group_size: int):
        self.group_size = group_size
        self.received_groups: Dict[int, Dict[int, Dict[int, Frame]]] = {}

    def add_data_frame(self, frame: Frame) -> None:
        if self.group_size <= 0:
            return
        chid = frame.header.chid
        seq = frame.header.sequence_number
        group_seq_start = seq - (seq % self.group_size)

        if chid not in self.received_groups:
            self.received_groups[chid] = {}

        ch_map = self.received_groups[chid]
        if group_seq_start not in ch_map:
            ch_map[group_seq_start] = {}

        ch_map[group_seq_start][seq] = frame

        # If group is complete, all data frames arrived; no parity recovery needed
        if len(ch_map[group_seq_start]) >= self.group_size:
            del ch_map[group_seq_start]

        # Prune old incomplete groups to prevent memory leakage
        if len(ch_map) > 64:
            oldest_keys = sorted(ch_map.keys(), key=lambda k: (k - seq) & 0xFFFFFFFF)
            for old_key in oldest_keys[: len(ch_map) - 32]:
                del ch_map[old_key]

    def process_parity_frame(self, parity_frame: Frame) -> Optional[Frame]:
        if self.group_size <= 0:
            return None

        chid = parity_frame.header.chid
        group_seq_start, group_size, parity_bytes, flags_mask, end_lengths = decode_parity_payload(parity_frame.payload)
        ch_map = self.received_groups.get(chid, {})
        group_map = ch_map.get(group_seq_start, {})

        missing_seqs = []
        for i in range(group_size):
            target_seq = (group_seq_start + i) & 0xFFFFFFFF
            if target_seq not in group_map:
                missing_seqs.append(target_seq)

        if len(missing_seqs) == 1:
            missing_seq = missing_seqs[0]
            missing_idx = (missing_seq - group_seq_start) & 0xFFFFFFFF
            present_frames = list(group_map.values())
            if not present_frames:
                return None

            present_payloads = [bytes(f.payload) for f in present_frames]
            all_buffers = [parity_bytes] + present_payloads
            recovered_full_payload = xor_buffers(all_buffers)

            template_header = present_frames[0].header
            has_msg_end = (flags_mask & (1 << missing_idx)) != 0
            recovered_flags = FLAG_MSG_END if has_msg_end else 0
            recovered_len = (
                end_lengths.get(missing_idx, len(parity_bytes))
                if has_msg_end
                else max(len(parity_bytes), max(f.header.payload_length for f in present_frames))
            )
            recovered_payload = recovered_full_payload[:recovered_len]

            recovered_frame = Frame(
                header=FrameHeader(
                    version=template_header.version,
                    flags=recovered_flags,
                    chid=template_header.chid,
                    ack_chid=template_header.ack_chid,
                    payload_length=len(recovered_payload),
                    sequence_number=missing_seq,
                    cumulative_ack_seq=template_header.cumulative_ack_seq,
                    sack_mask=template_header.sack_mask,
                ),
                payload=recovered_payload,
            )

            group_map[missing_seq] = recovered_frame
            if group_seq_start in ch_map:
                del ch_map[group_seq_start]
            return recovered_frame

        return None
