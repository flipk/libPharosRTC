import { describe, it, expect } from 'vitest';
import {
  xorBuffers,
  encodeParityPayload,
  decodeParityPayload,
  FecEncoder,
  FecDecoder,
  FLAG_FEC_PARITY,
} from '../../src/ts/FecEngine';
import { Frame, PROTOCOL_VERSION, FLAG_MSG_END } from '../../src/ts/FrameCodec';

describe('XOR Forward Error Correction (FecEngine)', () => {
  it('computes XOR parity across buffers of equal and varying lengths', () => {
    const buf1 = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const buf2 = new Uint8Array([0x55, 0x55, 0x55, 0xff]);

    const parity = xorBuffers([buf1, buf2]);
    expect(parity.byteLength).toBe(4);
    expect(parity[0]).toBe(0xaa ^ 0x55); // 0xff
    expect(parity[1]).toBe(0xbb ^ 0x55); // 0xee
    expect(parity[2]).toBe(0xcc ^ 0x55); // 0x99
    expect(parity[3]).toBe(0x00 ^ 0xff); // 0xff
  });

  it('encodes and decodes parity payload headers', () => {
    const parityBytes = new Uint8Array([10, 20, 30, 40]);
    const encoded = encodeParityPayload(100, 4, parityBytes);

    const decoded = decodeParityPayload(encoded);
    expect(decoded.groupSeqStart).toBe(100);
    expect(decoded.groupSize).toBe(4);
    expect(decoded.parityBytes).toEqual(parityBytes);
  });

  it('demonstrates zero-retransmission recovery of a single missing frame in a K=4 XOR group', () => {
    const K = 4;
    const encoder = new FecEncoder(K);
    const decoder = new FecDecoder(K);

    // Create 4 data frames for ChID 2
    const dataFrames: Frame[] = [];
    for (let i = 0; i < K; i++) {
      dataFrames.push({
        header: {
          version: PROTOCOL_VERSION,
          flags: FLAG_MSG_END,
          chid: 2,
          ackChid: 0,
          payloadLength: 10,
          sequenceNumber: i,
          cumulativeAckSeq: 0,
          sackMask: 0,
        },
        payload: new Uint8Array([10 + i, 20 + i, 30 + i, 40 + i, 50 + i, 60 + i, 70 + i, 80 + i, 90 + i, 100 + i]),
      });
    }

    // Encoder processes 4 frames -> returns 1 parity frame
    let parityFrame: Frame | null = null;
    for (let i = 0; i < K; i++) {
      const p = encoder.addDataFrame(dataFrames[i]);
      if (i < K - 1) {
        expect(p).toBeNull();
      } else {
        parityFrame = p;
      }
    }

    expect(parityFrame).not.toBeNull();
    expect((parityFrame!.header.ackChid & FLAG_FEC_PARITY)).not.toBe(0);

    // Simulate Frame 2 (seq 2) LOST on the wire!
    // Receiver receives Frame 0, Frame 1, Frame 3
    decoder.addDataFrame(dataFrames[0]);
    decoder.addDataFrame(dataFrames[1]);
    decoder.addDataFrame(dataFrames[3]);

    // Receiver processes parity frame
    const recoveredFrame = decoder.processParityFrame(parityFrame!);

    expect(recoveredFrame).not.toBeNull();
    expect(recoveredFrame!.header.sequenceNumber).toBe(2);
    expect(recoveredFrame!.payload).toEqual(dataFrames[2].payload);
  });
});
