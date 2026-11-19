import { describe, it, expect, beforeEach } from 'vitest';
import { ArqEngine } from '../../src/ts/ArqEngine';
import { TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS } from '../../src/ts/config';
import { Frame } from '../../src/ts/FrameCodec';

describe('ArqEngine (TypeScript)', () => {
  let sender: ArqEngine;
  let receiver: ArqEngine;

  beforeEach(() => {
    sender = new ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, [...DEFAULT_CHANNELS]);
    receiver = new ArqEngine(TERRESTRIAL_HIGH_BER_PROFILE, [...DEFAULT_CHANNELS]);
  });

  it('handles out-of-order frame delivery and generates SACK bitmasks', () => {
    const receivedMsgs: { chid: number; payload: Uint8Array }[] = [];
    receiver.onMessage((chid, payload) => {
      receivedMsgs.push({ chid, payload });
    });

    // Send 4 single-frame messages on ChID 0
    sender.sendMessage(0, new Uint8Array([10]));
    sender.sendMessage(0, new Uint8Array([20]));
    sender.sendMessage(0, new Uint8Array([30]));
    sender.sendMessage(0, new Uint8Array([40]));

    const f0 = sender.dequeueNextFrame(0)!; // Seq 0
    const f1 = sender.dequeueNextFrame(0)!; // Seq 1
    const f2 = sender.dequeueNextFrame(0)!; // Seq 2
    const f3 = sender.dequeueNextFrame(0)!; // Seq 3

    // Deliver f0 (seq 0) -> expectedSeq becomes 1
    receiver.onWireFrame(f0, 0);
    expect(receivedMsgs.length).toBe(1);
    expect(receivedMsgs[0].payload).toEqual(new Uint8Array([10]));

    // Drop f1! Deliver f2 (seq 2) out of order
    receiver.onWireFrame(f2, 0);
    let replyAck = receiver.dequeueNextFrame(0)!;
    expect(replyAck.header.cumulativeAckSeq).toBe(0);
    expect(replyAck.header.sackMask & (1 << 1)).not.toBe(0); // Bit 1 set for seq 2

    // Deliver f3 (seq 3) out of order
    receiver.onWireFrame(f3, 0);
    replyAck = receiver.dequeueNextFrame(0)!;
    expect(replyAck.header.cumulativeAckSeq).toBe(0);
    expect(replyAck.header.sackMask & (1 << 1)).not.toBe(0); // Bit 1 set for seq 2
    expect(replyAck.header.sackMask & (1 << 2)).not.toBe(0); // Bit 2 set for seq 3

    // Still only 1 message delivered to application so far
    expect(receivedMsgs.length).toBe(1);

    // Now deliver missing f1 (seq 1)
    receiver.onWireFrame(f1, 0);

    // Receiver should now reassemble and deliver seq 1, seq 2, seq 3 in order!
    expect(receivedMsgs.length).toBe(4);
    expect(receivedMsgs[0].payload).toEqual(new Uint8Array([10]));
    expect(receivedMsgs[1].payload).toEqual(new Uint8Array([20]));
    expect(receivedMsgs[2].payload).toEqual(new Uint8Array([30]));
    expect(receivedMsgs[3].payload).toEqual(new Uint8Array([40]));
  });

  it('performs selective retransmission of lost frames only', () => {
    sender.sendMessage(0, new Uint8Array([100])); // Seq 0
    sender.sendMessage(0, new Uint8Array([101])); // Seq 1
    sender.sendMessage(0, new Uint8Array([102])); // Seq 2

    const f0 = sender.dequeueNextFrame(0)!;
    const f1 = sender.dequeueNextFrame(0)!; // Lost frame
    const f2 = sender.dequeueNextFrame(0)!;

    // Receiver receives f0 and f2 (f1 lost)
    receiver.onWireFrame(f0, 0);
    receiver.onWireFrame(f2, 0);

    // Receiver produces ACK frame carrying cumAck=0, SACK=bit 1 (for seq 2)
    const ackFrame = receiver.dequeueNextFrame(0)!;
    sender.onWireFrame(ackFrame, 10);

    // Advance time past initial RTO (60 ms) to trigger retransmission check
    const retxFrame = sender.dequeueNextFrame(70);
    expect(retxFrame).not.toBeNull();
    // ONLY f1 (seq 1) should be retransmitted!
    expect(retxFrame!.header.sequenceNumber).toBe(1);

    // No further retransmissions pending (f0 and f2 were acknowledged)
    const nextFrame = sender.dequeueNextFrame(70);
    expect(nextFrame).toBeNull();
  });

  it('correctly segments and reassembles multi-frame messages', () => {
    const receivedMsgs: Uint8Array[] = [];
    receiver.onMessage((_chid, payload) => {
      receivedMsgs.push(payload);
    });

    // Large 1000-byte message
    const largePayload = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) largePayload[i] = (i * 7) & 0xff;

    sender.sendMessage(2, largePayload);

    // Dequeue all chunks from sender and pass to receiver out of order
    const frames: Frame[] = [];
    let f: Frame | null;
    while ((f = sender.dequeueNextFrame(0)) !== null) {
      frames.push(f);
    }
    const dataFrames = frames.filter((fr) => (fr.header.ackChid & 0x80) === 0);
    expect(dataFrames.length).toBe(5); // 206*4 + 176 = 1000

    // Pass frames in scrambled order: 0, 2, 4, 1, 3
    receiver.onWireFrame(dataFrames[0], 0);
    receiver.onWireFrame(dataFrames[2], 0);
    receiver.onWireFrame(dataFrames[4], 0);
    receiver.onWireFrame(dataFrames[1], 0);
    receiver.onWireFrame(dataFrames[3], 0);

    expect(receivedMsgs.length).toBe(1);
    expect(receivedMsgs[0]).toEqual(largePayload);
  });

  it('adapts RTO under jittered RTTs according to Jacobson/Karels and clamps bounds', () => {
    sender.sendMessage(0, new Uint8Array([1]));
    const f0 = sender.dequeueNextFrame(0)!;

    // Simulate RTT sample of 20 ms
    receiver.onWireFrame(f0, 0);
    const ack0 = receiver.dequeueNextFrame(0)!;
    sender.onWireFrame(ack0, 20);

    const stats1 = sender.getStats(0);
    expect(stats1.smoothedRttMs).toBe(20);
    expect(stats1.rttVarMs).toBe(10);
    expect(stats1.currentRtoMs).toBe(60); // 20 + 4*10 = 60

    // Send frame 2 with jittered RTT of 80 ms
    sender.sendMessage(0, new Uint8Array([2]));
    const f1 = sender.dequeueNextFrame(20)!;
    receiver.onWireFrame(f1, 20);
    const ack1 = receiver.dequeueNextFrame(20)!;
    sender.onWireFrame(ack1, 100); // 100 - 20 = 80ms RTT

    const stats2 = sender.getStats(0);
    expect(stats2.smoothedRttMs).toBe(27.5);
    expect(stats2.rttVarMs).toBe(22.5);
    expect(stats2.currentRtoMs).toBe(117.5); // 27.5 + 4*22.5 = 117.5
    expect(stats2.currentRtoMs).toBeGreaterThanOrEqual(TERRESTRIAL_HIGH_BER_PROFILE.minRtoMs);
    expect(stats2.currentRtoMs).toBeLessThanOrEqual(TERRESTRIAL_HIGH_BER_PROFILE.maxRtoMs);
  });

  it('passes 10% random loss simulation with 100% data integrity', () => {
    const sentByChid: Map<number, Uint8Array[]> = new Map([[0, []], [2, []]]);
    const receivedByChid: Map<number, Uint8Array[]> = new Map([[0, []], [2, []]]);

    receiver.onMessage((chid, payload) => {
      receivedByChid.get(chid)?.push(payload);
    });

    let totalSent = 0;
    // Enqueue 30 messages of varying sizes on ChID 0 and ChID 2
    for (let i = 0; i < 30; i++) {
      const size = (i % 5 === 0) ? 500 : 50;
      const payload = new Uint8Array(size);
      for (let b = 0; b < size; b++) payload[b] = (i + b) & 0xff;
      const chid = i % 2 === 0 ? 0 : 2;
      sentByChid.get(chid)!.push(payload);
      sender.sendMessage(chid, payload);
      totalSent++;
    }

    let currentTime = 0;
    // Simple deterministic pseudo-random loss (10% drop rate)
    let lossSeed = 42;
    const isDropped = () => {
      lossSeed = (lossSeed * 9301 + 49297) % 233280;
      return lossSeed / 233280 < 0.10;
    };

    let totalReceived = 0;
    const getTotalReceived = () =>
      (receivedByChid.get(0)?.length ?? 0) + (receivedByChid.get(2)?.length ?? 0);

    // Run transport loop until all messages are delivered
    let loops = 0;
    while (getTotalReceived() < totalSent && loops < 5000) {
      loops++;
      currentTime += 10;

      sender.tick(currentTime);
      receiver.tick(currentTime);

      // Sender -> Receiver
      let outFrame: Frame | null;
      while ((outFrame = sender.dequeueNextFrame(currentTime)) !== null) {
        if (!isDropped()) {
          receiver.onWireFrame(outFrame, currentTime);
        }
      }

      // Receiver -> Sender (ACKs)
      let ackFrame: Frame | null;
      while ((ackFrame = receiver.dequeueNextFrame(currentTime)) !== null) {
        if (!isDropped()) {
          sender.onWireFrame(ackFrame, currentTime);
        }
      }
    }

    expect(getTotalReceived()).toBe(totalSent);
    expect(receivedByChid.get(0)).toEqual(sentByChid.get(0));
    expect(receivedByChid.get(2)).toEqual(sentByChid.get(2));
  });
});
