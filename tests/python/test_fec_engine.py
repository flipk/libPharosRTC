import pytest
from fec_engine import (
    FLAG_FEC_PARITY,
    FecDecoder,
    FecEncoder,
    decode_parity_payload,
    encode_parity_payload,
    xor_buffers,
)
from frame_codec import FLAG_MSG_END, PROTOCOL_VERSION, Frame, FrameHeader

def test_xor_buffers():
    buf1 = bytes([0xAA, 0xBB, 0xCC])
    buf2 = bytes([0x55, 0x55, 0x55, 0xFF])

    parity = xor_buffers([buf1, buf2])
    assert len(parity) == 4
    assert parity[0] == (0xAA ^ 0x55)
    assert parity[1] == (0xBB ^ 0x55)
    assert parity[2] == (0xCC ^ 0x55)
    assert parity[3] == (0x00 ^ 0xFF)

def test_encode_decode_parity_payload():
    parity_bytes = b"\x0a\x14\x1e\x28"
    encoded = encode_parity_payload(100, 4, parity_bytes)

    seq_start, k, decoded_bytes = decode_parity_payload(encoded)
    assert seq_start == 100
    assert k == 4
    assert decoded_bytes == parity_bytes

def test_fec_zero_retransmission_recovery_k4():
    K = 4
    encoder = FecEncoder(K)
    decoder = FecDecoder(K)

    data_frames = []
    for i in range(K):
        payload = bytes([10 + i, 20 + i, 30 + i, 40 + i, 50 + i, 60 + i])
        data_frames.append(
            Frame(
                header=FrameHeader(
                    version=PROTOCOL_VERSION,
                    flags=FLAG_MSG_END,
                    chid=2,
                    ack_chid=0,
                    payload_length=len(payload),
                    sequence_number=i,
                    cumulative_ack_seq=0,
                    sack_mask=0,
                ),
                payload=payload,
            )
        )

    parity_frame = None
    for i in range(K):
        p = encoder.add_data_frame(data_frames[i])
        if i < K - 1:
            assert p is None
        else:
            parity_frame = p

    assert parity_frame is not None
    assert (parity_frame.header.ack_chid & FLAG_FEC_PARITY) != 0

    # Simulate Frame 2 (seq 2) lost on the wire!
    decoder.add_data_frame(data_frames[0])
    decoder.add_data_frame(data_frames[1])
    decoder.add_data_frame(data_frames[3])

    recovered_frame = decoder.process_parity_frame(parity_frame)

    assert recovered_frame is not None
    assert recovered_frame.header.sequence_number == 2
    assert bytes(recovered_frame.payload) == bytes(data_frames[2].payload)
