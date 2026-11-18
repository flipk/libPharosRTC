import struct
from typing import Dict, List, Optional, Tuple, Union

from frame_codec import FLAG_ACK_ONLY, PROTOCOL_VERSION, Frame, FrameHeader

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

def encode_parity_payload(group_seq_start: int, group_size: int, parity_bytes: bytes) -> bytes:
    header = struct.pack("!IH", group_seq_start & 0xFFFFFFFF, group_size & 0xFFFF)
    return header + parity_bytes

def decode_parity_payload(payload: Union[bytes, bytearray, memoryview]) -> Tuple[int, int, bytes]:
    mv = memoryview(payload)
    if len(mv) < 6:
        raise ValueError("Parity payload buffer too short")
    group_seq_start, group_size = struct.unpack("!IH", mv[:6])
    parity_bytes = bytes(mv[6:])
    return group_seq_start, group_size, parity_bytes

class FecEncoder:
    def __init__(self, group_size: int):
        self.group_size = group_size
        self.current_group: List[Frame] = []

    def add_data_frame(self, frame: Frame) -> Optional[Frame]:
        if self.group_size <= 0:
            return None

        self.current_group.append(frame)

        if len(self.current_group) >= self.group_size:
            group_seq_start = self.current_group[0].header.sequence_number
            payloads = [bytes(f.payload) for f in self.current_group]
            parity_bytes = xor_buffers(payloads)

            parity_payload = encode_parity_payload(group_seq_start, self.group_size, parity_bytes)
            last_frame_header = self.current_group[-1].header

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

            self.current_group = []
            return parity_frame

        return None

class FecDecoder:
    def __init__(self, group_size: int):
        self.group_size = group_size
        self.received_groups: Dict[int, Dict[int, Frame]] = {}

    def add_data_frame(self, frame: Frame) -> None:
        if self.group_size <= 0:
            return
        seq = frame.header.sequence_number
        group_seq_start = seq - (seq % self.group_size)
        if group_seq_start not in self.received_groups:
            self.received_groups[group_seq_start] = {}
        self.received_groups[group_seq_start][seq] = frame

    def process_parity_frame(self, parity_frame: Frame) -> Optional[Frame]:
        if self.group_size <= 0:
            return None

        group_seq_start, group_size, parity_bytes = decode_parity_payload(parity_frame.payload)
        group_map = self.received_groups.get(group_seq_start, {})

        missing_seqs = []
        for i in range(group_size):
            target_seq = (group_seq_start + i) & 0xFFFFFFFF
            if target_seq not in group_map:
                missing_seqs.append(target_seq)

        if len(missing_seqs) == 1:
            missing_seq = missing_seqs[0]
            present_frames = list(group_map.values())
            if not present_frames:
                return None

            present_payloads = [bytes(f.payload) for f in present_frames]
            all_buffers = [parity_bytes] + present_payloads
            recovered_full_payload = xor_buffers(all_buffers)

            template_header = present_frames[0].header
            recovered_payload = recovered_full_payload[: template_header.payload_length]

            recovered_frame = Frame(
                header=FrameHeader(
                    version=template_header.version,
                    flags=template_header.flags,
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
            return recovered_frame

        return None
