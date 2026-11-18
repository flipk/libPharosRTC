import pytest
from config import TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS, ChannelConfig, DeliveryMode
from frame_codec import (
    PROTOCOL_VERSION,
    FLAG_ACK_ONLY,
    FLAG_MSG_END,
    Frame,
    FrameHeader,
)
from priority_scheduler import PriorityScheduler

def test_message_segmentation():
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    # App MTU = 220, Header = 14 -> Max payload = 206
    payload = bytes(range(256)) * 2  # 512 bytes -> 206 + 206 + 100 = 3 chunks

    seqs = scheduler.enqueue_message(2, payload)
    assert seqs == [0, 1, 2]

    f1 = scheduler.dequeue_next_frame()
    assert f1 is not None
    assert f1.header.chid == 2
    assert f1.header.payload_length == 206
    assert (f1.header.flags & FLAG_MSG_END) == 0

    f2 = scheduler.dequeue_next_frame()
    assert f2.header.payload_length == 206
    assert (f2.header.flags & FLAG_MSG_END) == 0

    f3 = scheduler.dequeue_next_frame()
    assert f3.header.payload_length == 100
    assert (f3.header.flags & FLAG_MSG_END) != 0

def test_priority_preemption_c2_over_bulk():
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    # Queue 5 bulk frames on ChID 2
    scheduler.enqueue_message(2, b"X" * (206 * 5))

    # Dequeue 2 bulk frames
    f1 = scheduler.dequeue_next_frame()
    assert f1.header.chid == 2
    f2 = scheduler.dequeue_next_frame()
    assert f2.header.chid == 2

    # C2 command arrives on ChID 0 (priority 0)
    c2_payload = b"\x01\x02\x03"
    scheduler.enqueue_message(0, c2_payload)

    # Immediate next frame dequeued MUST be ChID 0 (C2)
    c2_frame = scheduler.dequeue_next_frame()
    assert c2_frame is not None
    assert c2_frame.header.chid == 0
    assert bytes(c2_frame.payload) == c2_payload

    # After C2 frame finishes, bulk transfer resumes
    f3 = scheduler.dequeue_next_frame()
    assert f3.header.chid == 2

def test_strict_hierarchy_retransmission_over_new():
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    # Queue new frame on ChID 0
    scheduler.enqueue_message(0, b"new0")
    # Queue new frame on ChID 2
    scheduler.enqueue_message(2, b"new2")

    # Queue retransmission on ChID 2
    retx2 = Frame(
        header=FrameHeader(
            version=PROTOCOL_VERSION,
            flags=FLAG_MSG_END,
            chid=2,
            ack_chid=0,
            payload_length=4,
            sequence_number=99,
            cumulative_ack_seq=0,
            sack_mask=0,
        ),
        payload=b"retx2",
    )
    scheduler.enqueue_retransmission(2, retx2)

    # Queue retransmission on ChID 0
    retx0 = Frame(
        header=FrameHeader(
            version=PROTOCOL_VERSION,
            flags=FLAG_MSG_END,
            chid=0,
            ack_chid=0,
            payload_length=4,
            sequence_number=88,
            cumulative_ack_seq=0,
            sack_mask=0,
        ),
        payload=b"retx0",
    )
    scheduler.enqueue_retransmission(0, retx0)

    # Expected order: Retx 0 -> Retx 2 -> New 0 -> New 2
    assert scheduler.dequeue_next_frame().header.sequence_number == 88
    assert scheduler.dequeue_next_frame().header.sequence_number == 99
    assert scheduler.dequeue_next_frame().header.chid == 0
    assert scheduler.dequeue_next_frame().header.chid == 2

def test_buffer_low_water_mark_throttling():
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)
    mtu = TERRESTRIAL_HIGH_BER_PROFILE.app_mtu_bytes
    low_water_mark = 4 * mtu  # 880 bytes

    scheduler.enqueue_message(0, b"data")

    assert scheduler.can_send(low_water_mark - 1) is True
    assert scheduler.can_send(low_water_mark) is False
    assert scheduler.can_send(low_water_mark + 10) is False

    assert scheduler.dequeue_next_frame(buffered_amount=low_water_mark) is None
    assert scheduler.dequeue_next_frame(buffered_amount=low_water_mark - 1) is not None

def test_channel_window_limits():
    custom_channels = [
        ChannelConfig(id=0, name="c2", mode=DeliveryMode.RELIABLE_ORDERED, priority=0, window_size=2),
        ChannelConfig(id=2, name="bulk", mode=DeliveryMode.RELIABLE_ORDERED, priority=2, window_size=64),
    ]
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, custom_channels)

    scheduler.enqueue_message(0, b"X" * (206 * 4))  # 4 frames queued on ChID 0
    scheduler.enqueue_message(2, b"bulk_data")     # 1 frame on ChID 2

    assert scheduler.dequeue_next_frame().header.chid == 0
    assert scheduler.dequeue_next_frame().header.chid == 0

    # ChID 0 in-flight count (2) == window_size (2), so it falls back to ChID 2!
    bulk_frame = scheduler.dequeue_next_frame()
    assert bulk_frame.header.chid == 2

    # Releasing slot frees ChID 0
    scheduler.release_in_flight(0, 1)
    assert scheduler.dequeue_next_frame().header.chid == 0

def test_ack_piggybacking_and_standalone_ack():
    scheduler = PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS)

    scheduler.set_pending_ack(ack_chid=1, cum_ack_seq=100, sack_mask=0b101)
    assert scheduler.has_pending_ack() is True

    # Dequeue data frame -> ACK piggybacked
    scheduler.enqueue_message(0, b"payload")
    frame = scheduler.dequeue_next_frame()
    assert frame.header.chid == 0
    assert frame.header.ack_chid == 1
    assert frame.header.cumulative_ack_seq == 100
    assert frame.header.sack_mask == 0b101
    assert scheduler.has_pending_ack() is False

    # Standalone ACK frame when no data frame is queued
    scheduler.set_pending_ack(ack_chid=2, cum_ack_seq=200, sack_mask=0b11)
    ack_frame = scheduler.dequeue_next_frame()
    assert (ack_frame.header.flags & FLAG_ACK_ONLY) != 0
    assert ack_frame.header.ack_chid == 2
    assert ack_frame.header.cumulative_ack_seq == 200
    assert ack_frame.header.sack_mask == 0b11
    assert len(ack_frame.payload) == 0
    assert scheduler.has_pending_ack() is False
