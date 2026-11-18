from dataclasses import dataclass
import struct
from typing import Union

PROTOCOL_VERSION = 1
HEADER_SIZE_BYTES = 14

FLAG_SYN = 0x1
FLAG_ACK_ONLY = 0x2
FLAG_MSG_END = 0x4

# Fixed 14-byte Big-Endian format:
# B: Byte 0 (Ver (2b) | Flags (3b) | ChID (3b))
# B: Byte 1 (AckChID / Reserved (8b))
# H: Bytes 2-3 (Payload Length (16b))
# I: Bytes 4-7 (Sequence Number (32b))
# I: Bytes 8-11 (Cumulative ACK Sequence (32b))
# H: Bytes 12-13 (Selective ACK (SACK) Bitmask (16b))
HEADER_STRUCT = struct.Struct("!BBHIIH")

@dataclass
class FrameHeader:
    version: int
    flags: int
    chid: int
    ack_chid: int
    payload_length: int
    sequence_number: int
    cumulative_ack_seq: int
    sack_mask: int

@dataclass
class Frame:
    header: FrameHeader
    payload: Union[bytes, bytearray, memoryview] = b""

def seq_diff(a: int, b: int) -> int:
    """Calculates (a - b) in 32-bit serial number arithmetic (RFC 1982)."""
    diff = ((a & 0xFFFFFFFF) - (b & 0xFFFFFFFF) + 0x80000000) % 0x100000000 - 0x80000000
    return diff

def seq_less_than(a: int, b: int) -> bool:
    """Returns True if a < b in 32-bit serial number arithmetic."""
    return seq_diff(a, b) < 0

def encode_header(header: FrameHeader) -> bytes:
    if not (0 <= header.payload_length <= 0xFFFF):
        raise ValueError(f"Payload length {header.payload_length} out of 16-bit range (0..65535)")
    
    b0 = ((header.version & 0x03) << 6) | ((header.flags & 0x07) << 3) | (header.chid & 0x07)
    b1 = header.ack_chid & 0xFF
    return HEADER_STRUCT.pack(
        b0,
        b1,
        header.payload_length,
        header.sequence_number & 0xFFFFFFFF,
        header.cumulative_ack_seq & 0xFFFFFFFF,
        header.sack_mask & 0xFFFF,
    )

def decode_header(data: Union[bytes, bytearray, memoryview], offset: int = 0) -> FrameHeader:
    mv = memoryview(data)
    if len(mv) < offset + HEADER_SIZE_BYTES:
        raise ValueError(f"Buffer too short for header: {len(mv)} < {offset + HEADER_SIZE_BYTES}")
    
    b0, ack_chid, payload_length, seq_num, cum_ack, sack_mask = HEADER_STRUCT.unpack_from(mv, offset)
    version = (b0 >> 6) & 0x03
    flags = (b0 >> 3) & 0x07
    chid = b0 & 0x07
    return FrameHeader(
        version=version,
        flags=flags,
        chid=chid,
        ack_chid=ack_chid,
        payload_length=payload_length,
        sequence_number=seq_num,
        cumulative_ack_seq=cum_ack,
        sack_mask=sack_mask,
    )

def encode_frame(frame: Frame) -> bytes:
    payload_bytes = bytes(frame.payload)
    header = FrameHeader(
        version=frame.header.version,
        flags=frame.header.flags,
        chid=frame.header.chid,
        ack_chid=frame.header.ack_chid,
        payload_length=len(payload_bytes),
        sequence_number=frame.header.sequence_number,
        cumulative_ack_seq=frame.header.cumulative_ack_seq,
        sack_mask=frame.header.sack_mask,
    )
    header_bytes = encode_header(header)
    return header_bytes + payload_bytes

def decode_frame(data: Union[bytes, bytearray, memoryview], offset: int = 0) -> Frame:
    mv = memoryview(data)
    if len(mv) < offset + HEADER_SIZE_BYTES:
        raise ValueError(f"Buffer too short for header: {len(mv)} < {offset + HEADER_SIZE_BYTES}")
    
    header = decode_header(mv, offset=offset)
    total_len = offset + HEADER_SIZE_BYTES + header.payload_length
    if len(mv) < total_len:
        raise ValueError(f"Buffer too short for payload: {len(mv)} < {total_len}")
    
    payload = mv[offset + HEADER_SIZE_BYTES : total_len]
    return Frame(header=header, payload=payload)
