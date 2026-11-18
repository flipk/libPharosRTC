import { describe, it, expect } from 'vitest';
import {
  encodeHeader,
  decodeHeader,
  encodeFrame,
  decodeFrame,
  seqDiff,
  seqLessThan,
  PROTOCOL_VERSION,
  HEADER_SIZE_BYTES,
  FLAG_SYN,
  FLAG_ACK_ONLY,
  FLAG_MSG_END,
  FrameHeader,
  Frame,
} from '../../src/ts/FrameCodec';
import {
  TERRESTRIAL_HIGH_BER_PROFILE,
  STARLINK_PROFILE,
  DEFAULT_CHANNELS,
  DeliveryMode,
} from '../../src/ts/config';

describe('Configuration Profiles', () => {
  it('defines valid Terrestrial High-BER profile', () => {
    expect(TERRESTRIAL_HIGH_BER_PROFILE.appMtuBytes).toBe(220);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.windowSizePkts).toBe(32);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.initialRtoMs).toBe(60);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.minRtoMs).toBe(30);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.maxRtoMs).toBe(1000);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.ackDelayMs).toBe(10);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.keepaliveMs).toBe(200);
    expect(TERRESTRIAL_HIGH_BER_PROFILE.fecXorGroup).toBe(4);
  });

  it('defines valid Starlink profile', () => {
    expect(STARLINK_PROFILE.appMtuBytes).toBe(900);
    expect(STARLINK_PROFILE.windowSizePkts).toBe(64);
    expect(STARLINK_PROFILE.initialRtoMs).toBe(180);
    expect(STARLINK_PROFILE.minRtoMs).toBe(100);
    expect(STARLINK_PROFILE.maxRtoMs).toBe(3000);
    expect(STARLINK_PROFILE.ackDelayMs).toBe(25);
    expect(STARLINK_PROFILE.keepaliveMs).toBe(500);
    expect(STARLINK_PROFILE.fecXorGroup).toBe(0);
  });

  it('defines default channels correctly', () => {
    expect(DEFAULT_CHANNELS.length).toBe(3);
    expect(DEFAULT_CHANNELS[0]).toEqual({
      id: 0,
      name: 'c2',
      mode: DeliveryMode.RELIABLE_ORDERED,
      priority: 0,
      windowSize: 16,
    });
    expect(DEFAULT_CHANNELS[1]).toEqual({
      id: 1,
      name: 'telemetry',
      mode: DeliveryMode.UNRELIABLE_UNORDERED,
      priority: 1,
      windowSize: 0,
    });
    expect(DEFAULT_CHANNELS[2]).toEqual({
      id: 2,
      name: 'bulk_xfer',
      mode: DeliveryMode.RELIABLE_ORDERED,
      priority: 2,
      windowSize: 64,
    });
  });
});

describe('Sequence Number Arithmetic (32-bit serial arithmetic)', () => {
  it('handles standard sequence differences', () => {
    expect(seqDiff(10, 5)).toBe(5);
    expect(seqDiff(5, 10)).toBe(-5);
    expect(seqLessThan(5, 10)).toBe(true);
    expect(seqLessThan(10, 5)).toBe(false);
    expect(seqLessThan(5, 5)).toBe(false);
  });

  it('handles 32-bit sequence wrapping correctly', () => {
    const max = 0xffffffff;
    expect(seqDiff(0, max)).toBe(1);
    expect(seqLessThan(max, 0)).toBe(true);
    expect(seqLessThan(0, max)).toBe(false);

    expect(seqDiff(5, max - 5)).toBe(11);
    expect(seqLessThan(max - 5, 5)).toBe(true);
  });
});

describe('Header Serialization & Deserialization', () => {
  it('encodes and decodes a header with exact 14-byte layout', () => {
    const header: FrameHeader = {
      version: PROTOCOL_VERSION,
      flags: FLAG_SYN | FLAG_MSG_END,
      chid: 3,
      ackChid: 2,
      payloadLength: 100,
      sequenceNumber: 0x12345678,
      cumulativeAckSeq: 0x87654321,
      sackMask: 0xabcd,
    };

    const encoded = encodeHeader(header);
    expect(encoded.byteLength).toBe(HEADER_SIZE_BYTES);

    const decoded = decodeHeader(encoded);
    expect(decoded).toEqual(header);
  });

  it('verifies exact bit layout of Byte 0', () => {
    // Ver = 1 (0b01), Flags = 5 (0b101), ChID = 3 (0b011)
    // Byte 0 = (1 << 6) | (5 << 3) | 3 = 0x40 | 0x28 | 0x03 = 0x6B (107)
    const header: FrameHeader = {
      version: 1,
      flags: FLAG_SYN | FLAG_MSG_END, // 1 | 4 = 5
      chid: 3,
      ackChid: 7,
      payloadLength: 0,
      sequenceNumber: 0,
      cumulativeAckSeq: 0,
      sackMask: 0,
    };

    const encoded = encodeHeader(header);
    expect(encoded[0]).toBe(0x6b);
    expect(encoded[1]).toBe(7);
  });

  it('handles boundary values for all fields', () => {
    const header: FrameHeader = {
      version: 3,
      flags: 7,
      chid: 7,
      ackChid: 255,
      payloadLength: 65535,
      sequenceNumber: 0xffffffff,
      cumulativeAckSeq: 0xffffffff,
      sackMask: 0xffff,
    };

    const encoded = encodeHeader(header);
    const decoded = decodeHeader(encoded);
    expect(decoded).toEqual(header);
  });

  it('throws error when buffer is too small for header', () => {
    const smallBuf = new Uint8Array(13);
    expect(() => decodeHeader(smallBuf)).toThrow(RangeError);
  });

  it('throws error when payload length exceeds 16-bit uint', () => {
    const header: FrameHeader = {
      version: 1,
      flags: 0,
      chid: 0,
      ackChid: 0,
      payloadLength: 70000,
      sequenceNumber: 0,
      cumulativeAckSeq: 0,
      sackMask: 0,
    };
    expect(() => encodeHeader(header)).toThrow(RangeError);
  });
});

describe('Frame Serialization & Deserialization', () => {
  it('encodes and decodes a complete frame with payload', () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const frame: Frame = {
      header: {
        version: PROTOCOL_VERSION,
        flags: FLAG_MSG_END,
        chid: 0,
        ackChid: 0,
        payloadLength: payload.byteLength,
        sequenceNumber: 1001,
        cumulativeAckSeq: 1000,
        sackMask: 0b0000000000000001,
      },
      payload,
    };

    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(HEADER_SIZE_BYTES + payload.byteLength);

    const decoded = decodeFrame(encoded);
    expect(decoded.header).toEqual(frame.header);
    expect(decoded.payload).toEqual(payload);
  });

  it('handles zero-payload frames (FLAG_ACK_ONLY)', () => {
    const frame: Frame = {
      header: {
        version: PROTOCOL_VERSION,
        flags: FLAG_ACK_ONLY,
        chid: 0,
        ackChid: 0,
        payloadLength: 0,
        sequenceNumber: 50,
        cumulativeAckSeq: 50,
        sackMask: 0,
      },
      payload: new Uint8Array(0),
    };

    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(HEADER_SIZE_BYTES);

    const decoded = decodeFrame(encoded);
    expect(decoded.header).toEqual(frame.header);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('throws error when buffer is too short for payload', () => {
    const header: FrameHeader = {
      version: 1,
      flags: 0,
      chid: 0,
      ackChid: 0,
      payloadLength: 20,
      sequenceNumber: 1,
      cumulativeAckSeq: 0,
      sackMask: 0,
    };
    const buf = encodeHeader(header);
    // buf is 14 bytes, but payload length claims 20 bytes
    expect(() => decodeFrame(buf)).toThrow(RangeError);
  });
});
