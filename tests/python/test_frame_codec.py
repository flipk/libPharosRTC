import pytest
from config import (
    TERRESTRIAL_HIGH_BER_PROFILE,
    STARLINK_PROFILE,
    DEFAULT_CHANNELS,
    DeliveryMode,
)
from frame_codec import (
    PROTOCOL_VERSION,
    HEADER_SIZE_BYTES,
    FLAG_SYN,
    FLAG_ACK_ONLY,
    FLAG_MSG_END,
    HEADER_STRUCT,
    FrameHeader,
    Frame,
    seq_diff,
    seq_less_than,
    encode_header,
    decode_header,
    encode_frame,
    decode_frame,
)

def test_config_profiles():
    assert TERRESTRIAL_HIGH_BER_PROFILE.app_mtu_bytes == 220
    assert TERRESTRIAL_HIGH_BER_PROFILE.window_size_pkts == 32
    assert TERRESTRIAL_HIGH_BER_PROFILE.initial_rto_ms == 60
    assert TERRESTRIAL_HIGH_BER_PROFILE.min_rto_ms == 30
    assert TERRESTRIAL_HIGH_BER_PROFILE.max_rto_ms == 1000
    assert TERRESTRIAL_HIGH_BER_PROFILE.ack_delay_ms == 10
    assert TERRESTRIAL_HIGH_BER_PROFILE.keepalive_ms == 200
    assert TERRESTRIAL_HIGH_BER_PROFILE.fec_xor_group == 4

    assert STARLINK_PROFILE.app_mtu_bytes == 900
    assert STARLINK_PROFILE.window_size_pkts == 64
    assert STARLINK_PROFILE.initial_rto_ms == 180
    assert STARLINK_PROFILE.min_rto_ms == 100
    assert STARLINK_PROFILE.max_rto_ms == 3000
    assert STARLINK_PROFILE.ack_delay_ms == 25
    assert STARLINK_PROFILE.keepalive_ms == 500
    assert STARLINK_PROFILE.fec_xor_group == 0

    assert len(DEFAULT_CHANNELS) == 3
    assert DEFAULT_CHANNELS[0].id == 0
    assert DEFAULT_CHANNELS[0].mode == DeliveryMode.RELIABLE_ORDERED
    assert DEFAULT_CHANNELS[1].id == 1
    assert DEFAULT_CHANNELS[1].mode == DeliveryMode.UNRELIABLE_UNORDERED
    assert DEFAULT_CHANNELS[2].id == 2
    assert DEFAULT_CHANNELS[2].mode == DeliveryMode.RELIABLE_ORDERED

def test_seq_arithmetic():
    assert seq_diff(10, 5) == 5
    assert seq_diff(5, 10) == -5
    assert seq_less_than(5, 10) is True
    assert seq_less_than(10, 5) is False
    assert seq_less_than(5, 5) is False

    # Wrapping
    max_uint = 0xFFFFFFFF
    assert seq_diff(0, max_uint) == 1
    assert seq_less_than(max_uint, 0) is True
    assert seq_less_than(0, max_uint) is False

def test_header_encode_decode():
    header = FrameHeader(
        version=PROTOCOL_VERSION,
        flags=FLAG_SYN | FLAG_MSG_END,
        chid=3,
        ack_chid=2,
        payload_length=100,
        sequence_number=0x12345678,
        cumulative_ack_seq=0x87654321,
        sack_mask=0xABCD,
    )

    encoded = encode_header(header)
    assert len(encoded) == HEADER_SIZE_BYTES

    decoded = decode_header(encoded)
    assert decoded == header

def test_header_bit_layout():
    header = FrameHeader(
        version=1,
        flags=FLAG_SYN | FLAG_MSG_END,  # 1 | 4 = 5
        chid=3,
        ack_chid=7,
        payload_length=0,
        sequence_number=0,
        cumulative_ack_seq=0,
        sack_mask=0,
    )

    encoded = encode_header(header)
    # Byte 0 = (1 << 6) | (5 << 3) | 3 = 0x6B (107)
    assert encoded[0] == 0x6B
    assert encoded[1] == 7

def test_header_boundaries():
    header = FrameHeader(
        version=3,
        flags=7,
        chid=7,
        ack_chid=255,
        payload_length=65535,
        sequence_number=0xFFFFFFFF,
        cumulative_ack_seq=0xFFFFFFFF,
        sack_mask=0xFFFF,
    )

    encoded = encode_header(header)
    decoded = decode_header(encoded)
    assert decoded == header

def test_frame_encode_decode():
    payload = b"Hello libPharosRTC!"
    frame = Frame(
        header=FrameHeader(
            version=PROTOCOL_VERSION,
            flags=FLAG_MSG_END,
            chid=0,
            ack_chid=0,
            payload_length=len(payload),
            sequence_number=1001,
            cumulative_ack_seq=1000,
            sack_mask=0b0000000000000001,
        ),
        payload=payload,
    )

    encoded = encode_frame(frame)
    assert len(encoded) == HEADER_SIZE_BYTES + len(payload)

    decoded = decode_frame(encoded)
    assert decoded.header == frame.header
    assert bytes(decoded.payload) == payload

def test_ack_only_frame():
    frame = Frame(
        header=FrameHeader(
            version=PROTOCOL_VERSION,
            flags=FLAG_ACK_ONLY,
            chid=0,
            ack_chid=0,
            payload_length=0,
            sequence_number=50,
            cumulative_ack_seq=50,
            sack_mask=0,
        ),
        payload=b"",
    )

    encoded = encode_frame(frame)
    assert len(encoded) == HEADER_SIZE_BYTES

    decoded = decode_frame(encoded)
    assert decoded.header == frame.header
    assert len(decoded.payload) == 0

def test_error_handling():
    with pytest.raises(ValueError):
        decode_header(b"\x00" * 10)

    header = FrameHeader(
        version=1,
        flags=0,
        chid=0,
        ack_chid=0,
        payload_length=50,
        sequence_number=1,
        cumulative_ack_seq=0,
        sack_mask=0,
    )
    encoded = encode_header(header)
    with pytest.raises(ValueError):
        decode_frame(encoded)  # only 14 bytes, but claims 50 payload bytes

    with pytest.raises(ValueError):
        invalid_header = FrameHeader(
            version=1,
            flags=0,
            chid=0,
            ack_chid=0,
            payload_length=70000,
            sequence_number=0,
            cumulative_ack_seq=0,
            sack_mask=0,
        )
        encode_header(invalid_header)
