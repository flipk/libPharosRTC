import pytest
from arq_engine import ArqEngine
from config import TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS
from frame_codec import Frame

def test_out_of_order_sack_generation():
    sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    receiver = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    received_msgs = []
    receiver.on_message(lambda chid, payload: received_msgs.append((chid, payload)))

    sender.send_message(0, b"\x0a")
    sender.send_message(0, b"\x14")
    sender.send_message(0, b"\x1e")
    sender.send_message(0, b"\x28")

    f0 = sender.dequeue_next_frame(0)  # Seq 0
    f1 = sender.dequeue_next_frame(0)  # Seq 1
    f2 = sender.dequeue_next_frame(0)  # Seq 2
    f3 = sender.dequeue_next_frame(0)  # Seq 3

    receiver.on_wire_frame(f0, 0)
    assert len(received_msgs) == 1
    assert received_msgs[0][1] == b"\x0a"

    # Drop f1, deliver f2 out of order
    receiver.on_wire_frame(f2, 0)
    reply_ack = receiver.dequeue_next_frame(0)
    assert reply_ack.header.cumulative_ack_seq == 0
    assert (reply_ack.header.sack_mask & (1 << 1)) != 0  # Bit 1 set for seq 2

    # Deliver f3 out of order
    receiver.on_wire_frame(f3, 0)
    reply_ack = receiver.dequeue_next_frame(0)
    assert reply_ack.header.cumulative_ack_seq == 0
    assert (reply_ack.header.sack_mask & (1 << 1)) != 0
    assert (reply_ack.header.sack_mask & (1 << 2)) != 0  # Bit 2 set for seq 3

    assert len(received_msgs) == 1

    # Deliver missing f1
    receiver.on_wire_frame(f1, 0)
    assert len(received_msgs) == 4
    assert received_msgs[0][1] == b"\x0a"
    assert received_msgs[1][1] == b"\x14"
    assert received_msgs[2][1] == b"\x1e"
    assert received_msgs[3][1] == b"\x28"

def test_selective_retransmission():
    sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    receiver = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    sender.send_message(0, b"frame0")
    sender.send_message(0, b"frame1")
    sender.send_message(0, b"frame2")

    f0 = sender.dequeue_next_frame(0)
    f1 = sender.dequeue_next_frame(0)  # Lost
    f2 = sender.dequeue_next_frame(0)

    receiver.on_wire_frame(f0, 0)
    receiver.on_wire_frame(f2, 0)

    ack = receiver.dequeue_next_frame(0)
    sender.on_wire_frame(ack, 10)

    # Advance time past initial RTO (60 ms)
    retx_frame = sender.dequeue_next_frame(70)
    assert retx_frame is not None
    assert retx_frame.header.sequence_number == 1  # ONLY f1 retransmitted

    next_frame = sender.dequeue_next_frame(70)
    assert next_frame is None

def test_multi_frame_segmentation_reassembly():
    sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    receiver = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    received_msgs = []
    receiver.on_message(lambda chid, payload: received_msgs.append(payload))

    large_payload = bytes((i * 7) & 0xFF for i in range(1000))
    sender.send_message(2, large_payload)

    frames = []
    while (f := sender.dequeue_next_frame(0)) is not None:
        frames.append(f)
    data_frames = [fr for fr in frames if (fr.header.ack_chid & 0x80) == 0]
    assert len(data_frames) == 5

    # Deliver out of order: 0, 2, 4, 1, 3
    receiver.on_wire_frame(data_frames[0], 0)
    receiver.on_wire_frame(data_frames[2], 0)
    receiver.on_wire_frame(data_frames[4], 0)
    receiver.on_wire_frame(data_frames[1], 0)
    receiver.on_wire_frame(data_frames[3], 0)

    assert len(received_msgs) == 1
    assert received_msgs[0] == large_payload

def test_rto_adaptation_jacobson_karels():
    sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    receiver = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    sender.send_message(0, b"msg1")
    f0 = sender.dequeue_next_frame(0)

    receiver.on_wire_frame(f0, 0)
    ack0 = receiver.dequeue_next_frame(0)
    sender.on_wire_frame(ack0, 20)  # RTT = 20ms

    stats1 = sender.get_stats(0)
    assert stats1.smoothed_rtt_ms == 20.0
    assert stats1.rtt_var_ms == 10.0
    assert stats1.current_rto_ms == 60.0

    # Jittered RTT = 80ms
    sender.send_message(0, b"msg2")
    f1 = sender.dequeue_next_frame(20)
    receiver.on_wire_frame(f1, 20)
    ack1 = receiver.dequeue_next_frame(20)
    sender.on_wire_frame(ack1, 100)

    stats2 = sender.get_stats(0)
    assert stats2.smoothed_rtt_ms == 27.5
    assert stats2.rtt_var_ms == 22.5
    assert stats2.current_rto_ms == 117.5

def test_10_percent_random_loss_simulation():
    sender = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    receiver = ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    sent_by_chid = {0: [], 2: []}
    received_by_chid = {0: [], 2: []}

    receiver.on_message(lambda chid, payload: received_by_chid[chid].append(payload))

    total_sent = 0
    for i in range(30):
        size = 500 if (i % 5 == 0) else 50
        payload = bytes((i + b) & 0xFF for b in range(size))
        chid = 0 if (i % 2 == 0) else 2
        sent_by_chid[chid].append(payload)
        sender.send_message(chid, payload)
        total_sent += 1

    current_time = 0.0
    loss_seed = 42

    def is_dropped():
        nonlocal loss_seed
        loss_seed = (loss_seed * 9301 + 49297) % 233280
        return (loss_seed / 233280.0) < 0.10

    def get_total_received():
        return len(received_by_chid[0]) + len(received_by_chid[2])

    loops = 0
    while get_total_received() < total_sent and loops < 5000:
        loops += 1
        current_time += 10.0

        sender.tick(current_time)
        receiver.tick(current_time)

        while (out_frame := sender.dequeue_next_frame(current_time)) is not None:
            if not is_dropped():
                receiver.on_wire_frame(out_frame, current_time)

        while (ack_frame := receiver.dequeue_next_frame(current_time)) is not None:
            if not is_dropped():
                sender.on_wire_frame(ack_frame, current_time)

    assert get_total_received() == total_sent
    assert received_by_chid[0] == sent_by_chid[0]
    assert received_by_chid[2] == sent_by_chid[2]
