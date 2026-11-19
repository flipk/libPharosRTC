import { Frame, FrameHeader, PROTOCOL_VERSION, FLAG_ACK_ONLY, FLAG_MSG_END } from './FrameCodec';

export const FLAG_FEC_PARITY = 0x80;

export function xorBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0);

  let maxLen = 0;
  for (const b of buffers) {
    if (b.byteLength > maxLen) maxLen = b.byteLength;
  }

  const result = new Uint8Array(maxLen);
  for (const b of buffers) {
    for (let i = 0; i < b.byteLength; i++) {
      result[i] ^= b[i];
    }
  }
  return result;
}

export function encodeParityPayload(
  groupSeqStart: number,
  groupSize: number,
  parityBytes: Uint8Array,
  flagsMask: number = 0,
  endLengths?: Map<number, number> | Record<number, number>
): Uint8Array {
  let extraLengthsCount = 0;
  for (let i = 0; i < groupSize; i++) {
    if ((flagsMask & (1 << i)) !== 0) extraLengthsCount++;
  }
  const buf = new Uint8Array(8 + extraLengthsCount * 2 + parityBytes.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint32(0, groupSeqStart >>> 0, false);
  view.setUint16(4, groupSize & 0xffff, false);
  view.setUint16(6, flagsMask & 0xffff, false);
  let offset = 8;
  for (let i = 0; i < groupSize; i++) {
    if ((flagsMask & (1 << i)) !== 0) {
      const lenVal = endLengths instanceof Map ? (endLengths.get(i) ?? 0) : ((endLengths as any)?.[i] ?? 0);
      view.setUint16(offset, lenVal & 0xffff, false);
      offset += 2;
    }
  }
  buf.set(parityBytes, offset);
  return buf;
}

export function decodeParityPayload(payload: Uint8Array): {
  groupSeqStart: number;
  groupSize: number;
  flagsMask: number;
  endLengths: Map<number, number>;
  parityBytes: Uint8Array;
} {
  if (payload.byteLength < 6) {
    throw new RangeError('Parity payload buffer too short');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const groupSeqStart = view.getUint32(0, false);
  const groupSize = view.getUint16(4, false);
  let flagsMask = 0;
  const endLengths = new Map<number, number>();
  let offset = 6;
  if (payload.byteLength >= 8) {
    flagsMask = view.getUint16(6, false);
    offset = 8;
    for (let i = 0; i < groupSize; i++) {
      if ((flagsMask & (1 << i)) !== 0) {
        if (offset + 2 <= payload.byteLength) {
          endLengths.set(i, view.getUint16(offset, false));
          offset += 2;
        }
      }
    }
  }
  const parityBytes = payload.subarray(offset);
  return { groupSeqStart, groupSize, flagsMask, endLengths, parityBytes };
}

export class FecEncoder {
  private groupSize: number;
  private currentGroup: Frame[] = [];

  constructor(groupSize: number) {
    this.groupSize = groupSize;
  }

  public addDataFrame(frame: Frame): Frame | null {
    if (this.groupSize <= 0) return null;

    if (
      this.currentGroup.length > 0 &&
      this.currentGroup[0].header.chid !== frame.header.chid
    ) {
      this.currentGroup = [];
    }

    this.currentGroup.push(frame);

    if (this.currentGroup.length >= this.groupSize) {
      const groupSeqStart = this.currentGroup[0].header.sequenceNumber;
      const payloads = this.currentGroup.map((f) => f.payload);
      const parityBytes = xorBuffers(payloads);

      let flagsMask = 0;
      const endLengths = new Map<number, number>();
      for (let i = 0; i < this.groupSize; i++) {
        const f = this.currentGroup[i];
        if ((f.header.flags & FLAG_MSG_END) !== 0) {
          flagsMask |= (1 << i);
          endLengths.set(i, f.header.payloadLength);
        }
      }

      const parityPayload = encodeParityPayload(groupSeqStart, this.groupSize, parityBytes, flagsMask, endLengths);
      const lastFrameHeader = this.currentGroup[this.currentGroup.length - 1].header;

      const parityFrame: Frame = {
        header: {
          version: PROTOCOL_VERSION,
          flags: FLAG_ACK_ONLY,
          chid: lastFrameHeader.chid,
          ackChid: (lastFrameHeader.ackChid & 0x7f) | FLAG_FEC_PARITY,
          payloadLength: parityPayload.byteLength,
          sequenceNumber: (lastFrameHeader.sequenceNumber + 1) >>> 0,
          cumulativeAckSeq: lastFrameHeader.cumulativeAckSeq,
          sackMask: lastFrameHeader.sackMask,
        },
        payload: parityPayload,
      };

      this.currentGroup = [];
      return parityFrame;
    }

    return null;
  }
}

export class FecDecoder {
  private groupSize: number;
  private receivedGroups: Map<number, Map<number, Frame>> = new Map();

  constructor(groupSize: number) {
    this.groupSize = groupSize;
  }

  public addDataFrame(frame: Frame): void {
    if (this.groupSize <= 0) return;
    const seq = frame.header.sequenceNumber;
    const groupSeqStart = seq - (seq % this.groupSize);
    if (!this.receivedGroups.has(groupSeqStart)) {
      this.receivedGroups.set(groupSeqStart, new Map());
    }
    const groupMap = this.receivedGroups.get(groupSeqStart)!;
    groupMap.set(seq, frame);

    if (groupMap.size >= this.groupSize) {
      this.receivedGroups.delete(groupSeqStart);
    }

    if (this.receivedGroups.size > 64) {
      const keys = Array.from(this.receivedGroups.keys());
      keys.sort((a, b) => ((a - seq) >>> 0) - ((b - seq) >>> 0));
      for (let i = 0; i < keys.length - 32; i++) {
        this.receivedGroups.delete(keys[i]);
      }
    }
  }

  public processParityFrame(parityFrame: Frame): Frame | null {
    if (this.groupSize <= 0) return null;

    const { groupSeqStart, groupSize, flagsMask, endLengths, parityBytes } = decodeParityPayload(parityFrame.payload);
    const groupMap = this.receivedGroups.get(groupSeqStart) || new Map();

    const missingSeqs: number[] = [];
    for (let i = 0; i < groupSize; i++) {
      const targetSeq = (groupSeqStart + i) >>> 0;
      if (!groupMap.has(targetSeq)) {
        missingSeqs.push(targetSeq);
      }
    }

    // Recover ONLY if exactly 1 frame is missing in the group
    if (missingSeqs.length === 1) {
      const missingSeq = missingSeqs[0];
      const missingIdx = (missingSeq - groupSeqStart) >>> 0;
      const presentFrames = Array.from(groupMap.values());
      if (presentFrames.length === 0) return null;

      const presentPayloads = presentFrames.map((f) => f.payload);

      const allBuffers = [parityBytes, ...presentPayloads];
      const recoveredFullPayload = xorBuffers(allBuffers);

      const templateHeader = presentFrames[0].header;
      const hasMsgEnd = (flagsMask & (1 << missingIdx)) !== 0;
      const recoveredFlags = hasMsgEnd ? FLAG_MSG_END : 0;
      const recoveredLen = hasMsgEnd
        ? (endLengths.get(missingIdx) ?? parityBytes.length)
        : Math.max(parityBytes.length, ...presentFrames.map((f) => f.header.payloadLength));
      const recoveredPayload = recoveredFullPayload.subarray(0, recoveredLen);

      const recoveredFrame: Frame = {
        header: {
          ...templateHeader,
          flags: recoveredFlags,
          sequenceNumber: missingSeq,
          payloadLength: recoveredPayload.byteLength,
        },
        payload: recoveredPayload,
      };

      groupMap.set(missingSeq, recoveredFrame);
      this.receivedGroups.delete(groupSeqStart);
      return recoveredFrame;
    }

    return null;
  }
}
