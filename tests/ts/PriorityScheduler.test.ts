import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityScheduler } from '../../src/ts/PriorityScheduler';
import { TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS, DeliveryMode } from '../../src/ts/config';
import {
  Frame,
  FrameHeader,
  PROTOCOL_VERSION,
  FLAG_MSG_END,
  FLAG_ACK_ONLY,
} from '../../src/ts/FrameCodec';

describe('PriorityScheduler (TypeScript)', () => {
  let scheduler: PriorityScheduler;

  beforeEach(() => {
    scheduler = new PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, [...DEFAULT_CHANNELS]);
  });

  it('slices large messages into App-MTU bounded payload chunks with FLAG_MSG_END on the last chunk', () => {
    // appMtuBytes = 220, Header = 14, Max payload = 206
    const payloadSize = 500; // 206 + 206 + 88 = 3 chunks
    const payload = new Uint8Array(payloadSize);
    for (let i = 0; i < payloadSize; i++) payload[i] = i & 0xff;

    const seqs = scheduler.enqueueMessage(2, payload);
    expect(seqs.length).toBe(3);
    expect(seqs).toEqual([0, 1, 2]);

    const frame1 = scheduler.dequeueNextFrame();
    expect(frame1).not.toBeNull();
    expect(frame1!.header.chid).toBe(2);
    expect(frame1!.header.payloadLength).toBe(206);
    expect(frame1!.header.flags & FLAG_MSG_END).toBe(0);

    const frame2 = scheduler.dequeueNextFrame();
    expect(frame2!.header.payloadLength).toBe(206);
    expect(frame2!.header.flags & FLAG_MSG_END).toBe(0);

    const frame3 = scheduler.dequeueNextFrame();
    expect(frame3!.header.payloadLength).toBe(88);
    expect(frame3!.header.flags & FLAG_MSG_END).not.toBe(0);
  });

  it('guarantees strict preemption: ChID 0 (C2) preempts ongoing ChID 2 (Bulk) transfer stream', () => {
    // Queue 5 bulk frames on ChID 2
    const bulkPayload = new Uint8Array(206 * 5);
    scheduler.enqueueMessage(2, bulkPayload);

    // Dequeue 2 bulk frames
    const f1 = scheduler.dequeueNextFrame();
    expect(f1!.header.chid).toBe(2);
    const f2 = scheduler.dequeueNextFrame();
    expect(f2!.header.chid).toBe(2);

    // Now C2 command arrives on ChID 0 while bulk transfer is in progress
    const c2Payload = new Uint8Array([0x01, 0x02, 0x03]);
    scheduler.enqueueMessage(0, c2Payload);

    // Immediate next frame dequeued MUST be ChID 0 (C2), preempting ChID 2!
    const c2Frame = scheduler.dequeueNextFrame();
    expect(c2Frame).not.toBeNull();
    expect(c2Frame!.header.chid).toBe(0);
    expect(c2Frame!.payload).toEqual(c2Payload);

    // After C2 frame finishes, bulk transfer resumes
    const f3 = scheduler.dequeueNextFrame();
    expect(f3!.header.chid).toBe(2);
  });

  it('enforces strict preemption hierarchy: Retransmissions > New Frames > Standalone ACKs', () => {
    // 1. Queue new frame on ChID 0
    scheduler.enqueueMessage(0, new Uint8Array([1]));
    // 2. Queue new frame on ChID 2
    scheduler.enqueueMessage(2, new Uint8Array([2]));

    // 3. Queue retransmission on ChID 2
    const retxFrame2: Frame = {
      header: {
        version: PROTOCOL_VERSION,
        flags: FLAG_MSG_END,
        chid: 2,
        ackChid: 0,
        payloadLength: 1,
        sequenceNumber: 99,
        cumulativeAckSeq: 0,
        sackMask: 0,
      },
      payload: new Uint8Array([99]),
    };
    scheduler.enqueueRetransmission(2, retxFrame2);

    // 4. Queue retransmission on ChID 0
    const retxFrame0: Frame = {
      header: {
        version: PROTOCOL_VERSION,
        flags: FLAG_MSG_END,
        chid: 0,
        ackChid: 0,
        payloadLength: 1,
        sequenceNumber: 88,
        cumulativeAckSeq: 0,
        sackMask: 0,
      },
      payload: new Uint8Array([88]),
    };
    scheduler.enqueueRetransmission(0, retxFrame0);

    // Order MUST be:
    // 1st: ChID 0 Retransmission (ChID 0 retx > ChID 2 retx > ChID 0 new > ChID 2 new)
    expect(scheduler.dequeueNextFrame()!.header.sequenceNumber).toBe(88);
    // 2nd: ChID 2 Retransmission
    expect(scheduler.dequeueNextFrame()!.header.sequenceNumber).toBe(99);
    // 3rd: ChID 0 New Frame
    expect(scheduler.dequeueNextFrame()!.header.chid).toBe(0);
    // 4th: ChID 2 New Frame
    expect(scheduler.dequeueNextFrame()!.header.chid).toBe(2);
  });

  it('throttles transmission based on buffer low-water mark (bufferedAmount < 4 * appMtuBytes)', () => {
    const mtu = TERRESTRIAL_HIGH_BER_PROFILE.appMtuBytes;
    const lowWaterMark = 4 * mtu; // 880 bytes

    scheduler.enqueueMessage(0, new Uint8Array([1, 2, 3]));

    // Below low-water mark -> allowed
    expect(scheduler.canSend(lowWaterMark - 1)).toBe(true);
    // At or above low-water mark -> throttled
    expect(scheduler.canSend(lowWaterMark)).toBe(false);
    expect(scheduler.canSend(lowWaterMark + 100)).toBe(false);

    // dequeueNextFrame with bufferedAmount >= lowWaterMark returns null
    expect(scheduler.dequeueNextFrame(lowWaterMark)).toBeNull();
    // dequeueNextFrame with bufferedAmount < lowWaterMark succeeds
    expect(scheduler.dequeueNextFrame(lowWaterMark - 1)).not.toBeNull();
  });

  it('respects channel send window limits (inFlightCount < windowSize)', () => {
    // ChID 0 has windowSize = 16
    // Create a scheduler with windowSize = 2 for testing
    const customChannels = [
      { id: 0, name: 'c2', mode: DeliveryMode.RELIABLE_ORDERED, priority: 0, windowSize: 2 },
      { id: 2, name: 'bulk', mode: DeliveryMode.RELIABLE_ORDERED, priority: 2, windowSize: 64 },
    ];
    const s = new PriorityScheduler(TERRESTRIAL_HIGH_BER_PROFILE, customChannels);

    s.enqueueMessage(0, new Uint8Array(206 * 4)); // 4 frames queued on ChID 0
    s.enqueueMessage(2, new Uint8Array([10])); // 1 frame queued on ChID 2

    // Dequeue frame 1 (inFlight = 1)
    expect(s.dequeueNextFrame()!.header.chid).toBe(0);
    // Dequeue frame 2 (inFlight = 2 -> window full!)
    expect(s.dequeueNextFrame()!.header.chid).toBe(0);

    // Next dequeue on ChID 0 is blocked because inFlightCount (2) == windowSize (2).
    // So scheduler falls back to ChID 2!
    const bulkFrame = s.dequeueNextFrame();
    expect(bulkFrame!.header.chid).toBe(2);

    // Releasing an in-flight slot allows ChID 0 to send frame 3
    s.releaseInFlight(0, 1);
    expect(s.dequeueNextFrame()!.header.chid).toBe(0);
  });

  it('piggybacks ACKs onto outbound data frames and falls back to standalone FLAG_ACK_ONLY frame', () => {
    scheduler.setPendingAck(1, 100, 0b101);
    expect(scheduler.hasPendingAck()).toBe(true);

    // If data frame is dequeued, ACK is piggybacked
    scheduler.enqueueMessage(0, new Uint8Array([1, 2, 3]));
    const frame = scheduler.dequeueNextFrame()!;
    expect(frame.header.chid).toBe(0);
    expect(frame.header.ackChid).toBe(1);
    expect(frame.header.cumulativeAckSeq).toBe(100);
    expect(frame.header.sackMask).toBe(0b101);
    expect(scheduler.hasPendingAck()).toBe(false);

    // Set another pending ACK when no data frames are queued
    scheduler.setPendingAck(2, 200, 0b11);
    const ackFrame = scheduler.dequeueNextFrame()!;
    expect(ackFrame.header.flags & FLAG_ACK_ONLY).not.toBe(0);
    expect(ackFrame.header.ackChid).toBe(2);
    expect(ackFrame.header.cumulativeAckSeq).toBe(200);
    expect(ackFrame.header.sackMask).toBe(0b11);
    expect(ackFrame.payload.byteLength).toBe(0);
    expect(scheduler.hasPendingAck()).toBe(false);
  });
});
