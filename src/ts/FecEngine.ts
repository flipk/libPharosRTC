import { Frame, FrameHeader, PROTOCOL_VERSION, FLAG_ACK_ONLY } from './FrameCodec';

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

export function encodeParityPayload(groupSeqStart: number, groupSize: number, parityBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(6 + parityBytes.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint32(0, groupSeqStart >>> 0, false);
  view.setUint16(4, groupSize & 0xffff, false);
  buf.set(parityBytes, 6);
  return buf;
}

export function decodeParityPayload(payload: Uint8Array): {
  groupSeqStart: number;
  groupSize: number;
  parityBytes: Uint8Array;
} {
  if (payload.byteLength < 6) {
    throw new RangeError('Parity payload buffer too short');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const groupSeqStart = view.getUint32(0, false);
  const groupSize = view.getUint16(4, false);
  const parityBytes = payload.subarray(6);
  return { groupSeqStart, groupSize, parityBytes };
}

export class FecEncoder {
  private groupSize: number;
  private currentGroup: Frame[] = [];

  constructor(groupSize: number) {
    this.groupSize = groupSize;
  }

  public addDataFrame(frame: Frame): Frame | null {
    if (this.groupSize <= 0) return null;

    this.currentGroup.push(frame);

    if (this.currentGroup.length >= this.groupSize) {
      const groupSeqStart = this.currentGroup[0].header.sequenceNumber;
      const payloads = this.currentGroup.map((f) => f.payload);
      const parityBytes = xorBuffers(payloads);

      const parityPayload = encodeParityPayload(groupSeqStart, this.groupSize, parityBytes);
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
    this.receivedGroups.get(groupSeqStart)!.set(seq, frame);
  }

  public processParityFrame(parityFrame: Frame): Frame | null {
    if (this.groupSize <= 0) return null;

    const { groupSeqStart, groupSize, parityBytes } = decodeParityPayload(parityFrame.payload);
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
      const presentFrames = Array.from(groupMap.values());
      if (presentFrames.length === 0) return null;

      const presentPayloads = presentFrames.map((f) => f.payload);

      const allBuffers = [parityBytes, ...presentPayloads];
      const recoveredFullPayload = xorBuffers(allBuffers);

      const templateHeader = presentFrames[0].header;
      const recoveredPayload = recoveredFullPayload.subarray(0, templateHeader.payloadLength);

      const recoveredFrame: Frame = {
        header: {
          ...templateHeader,
          sequenceNumber: missingSeq,
          payloadLength: recoveredPayload.byteLength,
        },
        payload: recoveredPayload,
      };

      groupMap.set(missingSeq, recoveredFrame);
      return recoveredFrame;
    }

    return null;
  }
}
