export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE_BYTES = 14;

export const FLAG_SYN = 0x1;
export const FLAG_ACK_ONLY = 0x2;
export const FLAG_MSG_END = 0x4;

export interface FrameHeader {
  version: number;
  flags: number;
  chid: number;
  ackChid: number;
  payloadLength: number;
  sequenceNumber: number;
  cumulativeAckSeq: number;
  sackMask: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Uint8Array;
}

export function seqDiff(a: number, b: number): number {
  return ((a >>> 0) - (b >>> 0)) | 0;
}

export function seqLessThan(a: number, b: number): boolean {
  return seqDiff(a, b) < 0;
}

export function encodeHeader(
  header: FrameHeader,
  targetView?: DataView,
  offset: number = 0
): Uint8Array {
  if (header.payloadLength < 0 || header.payloadLength > 0xffff) {
    throw new RangeError(`Payload length ${header.payloadLength} out of 16-bit range (0..65535)`);
  }

  const buf = targetView
    ? new Uint8Array(targetView.buffer, targetView.byteOffset, targetView.byteLength)
    : new Uint8Array(HEADER_SIZE_BYTES);

  const view = targetView || new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (view.byteLength < offset + HEADER_SIZE_BYTES) {
    throw new RangeError(
      `Target buffer too small for header: ${view.byteLength} < ${offset + HEADER_SIZE_BYTES}`
    );
  }

  const ver = header.version & 0x03;
  const flags = header.flags & 0x07;
  const chid = header.chid & 0x07;
  const byte0 = (ver << 6) | (flags << 3) | chid;
  const byte1 = header.ackChid & 0xff;

  view.setUint8(offset, byte0);
  view.setUint8(offset + 1, byte1);
  view.setUint16(offset + 2, header.payloadLength, false); // Big-Endian
  view.setUint32(offset + 4, header.sequenceNumber >>> 0, false); // Big-Endian
  view.setUint32(offset + 8, header.cumulativeAckSeq >>> 0, false); // Big-Endian
  view.setUint16(offset + 12, header.sackMask & 0xffff, false); // Big-Endian

  return targetView ? new Uint8Array(view.buffer, view.byteOffset + offset, HEADER_SIZE_BYTES) : buf;
}

export function decodeHeader(
  buffer: ArrayBuffer | Uint8Array | DataView,
  offset: number = 0
): FrameHeader {
  let view: DataView;
  if (buffer instanceof DataView) {
    view = buffer;
  } else if (buffer instanceof Uint8Array) {
    view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    view = new DataView(buffer);
  }

  if (view.byteLength < offset + HEADER_SIZE_BYTES) {
    throw new RangeError(
      `Buffer too small to decode header: ${view.byteLength} < ${offset + HEADER_SIZE_BYTES}`
    );
  }

  const byte0 = view.getUint8(offset);
  const version = (byte0 >> 6) & 0x03;
  const flags = (byte0 >> 3) & 0x07;
  const chid = byte0 & 0x07;
  const ackChid = view.getUint8(offset + 1);
  const payloadLength = view.getUint16(offset + 2, false);
  const sequenceNumber = view.getUint32(offset + 4, false);
  const cumulativeAckSeq = view.getUint32(offset + 8, false);
  const sackMask = view.getUint16(offset + 12, false);

  return {
    version,
    flags,
    chid,
    ackChid,
    payloadLength,
    sequenceNumber,
    cumulativeAckSeq,
    sackMask,
  };
}

export function encodeFrame(frame: Frame): Uint8Array {
  const payload = frame.payload;
  const payloadLength = payload.byteLength;
  const header: FrameHeader = {
    ...frame.header,
    payloadLength,
  };

  const frameBuffer = new Uint8Array(HEADER_SIZE_BYTES + payloadLength);
  const view = new DataView(frameBuffer.buffer);
  encodeHeader(header, view, 0);
  frameBuffer.set(payload, HEADER_SIZE_BYTES);

  return frameBuffer;
}

export function decodeFrame(
  buffer: ArrayBuffer | Uint8Array | DataView,
  offset: number = 0
): Frame {
  let u8: Uint8Array;
  if (buffer instanceof Uint8Array) {
    u8 = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
  } else if (buffer instanceof DataView) {
    u8 = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
  } else {
    u8 = new Uint8Array(buffer, offset);
  }

  const header = decodeHeader(u8, 0);
  const totalLength = HEADER_SIZE_BYTES + header.payloadLength;

  if (u8.byteLength < totalLength) {
    throw new RangeError(
      `Buffer too small for frame payload: ${u8.byteLength} < ${totalLength}`
    );
  }

  const payload = u8.subarray(HEADER_SIZE_BYTES, totalLength);
  return {
    header,
    payload,
  };
}
