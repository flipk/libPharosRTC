import { LinkConfig, ChannelConfig, DEFAULT_CHANNELS, DeliveryMode } from './config';
import {
  Frame,
  FrameHeader,
  PROTOCOL_VERSION,
  HEADER_SIZE_BYTES,
  FLAG_ACK_ONLY,
  FLAG_MSG_END,
  seqLessThan,
  seqDiff,
} from './FrameCodec';
import { PriorityScheduler } from './PriorityScheduler';

export interface ArqStats {
  txFrames: number;
  rxFrames: number;
  retransmissions: number;
  smoothedRttMs: number;
  rttVarMs: number;
  currentRtoMs: number;
  estimatedPacketLoss: number;
}

export type MessageCallback = (chid: number, payload: Uint8Array) => void;

interface SentSlot {
  seq: number;
  frame: Frame;
  firstSentTs: number;
  lastSentTs: number;
  retransmitCount: number;
  acked: boolean;
}

interface RtoState {
  srtt: number;
  rttvar: number;
  rto: number;
  hasSample: boolean;
}

export class ArqEngine {
  private linkConfig: LinkConfig;
  private channelConfigs: Map<number, ChannelConfig>;
  private scheduler: PriorityScheduler;

  private sentSlots: Map<number, Map<number, SentSlot>>;
  private rtoState: Map<number, RtoState>;
  private nextExpectedSeq: Map<number, number>;
  private reorderBuffers: Map<number, Map<number, Frame>>;
  private assemblyBuffers: Map<number, Uint8Array[]>;

  private txFrames: Map<number, number>;
  private rxFrames: Map<number, number>;
  private retransmissions: Map<number, number>;

  private messageCallbacks: MessageCallback[] = [];

  constructor(
    linkConfig: LinkConfig,
    channelConfigs: ChannelConfig[] = [...DEFAULT_CHANNELS]
  ) {
    this.linkConfig = linkConfig;
    this.channelConfigs = new Map();
    this.sentSlots = new Map();
    this.rtoState = new Map();
    this.nextExpectedSeq = new Map();
    this.reorderBuffers = new Map();
    this.assemblyBuffers = new Map();
    this.txFrames = new Map();
    this.rxFrames = new Map();
    this.retransmissions = new Map();

    for (const cfg of channelConfigs) {
      this.channelConfigs.set(cfg.id, cfg);
      this.sentSlots.set(cfg.id, new Map());
      this.rtoState.set(cfg.id, {
        srtt: linkConfig.initialRtoMs,
        rttvar: linkConfig.initialRtoMs / 2,
        rto: linkConfig.initialRtoMs,
        hasSample: false,
      });
      this.nextExpectedSeq.set(cfg.id, 0);
      this.reorderBuffers.set(cfg.id, new Map());
      this.assemblyBuffers.set(cfg.id, []);
      this.txFrames.set(cfg.id, 0);
      this.rxFrames.set(cfg.id, 0);
      this.retransmissions.set(cfg.id, 0);
    }

    this.scheduler = new PriorityScheduler(linkConfig, channelConfigs);
  }

  public getScheduler(): PriorityScheduler {
    return this.scheduler;
  }

  public onMessage(cb: MessageCallback): void {
    this.messageCallbacks.push(cb);
  }

  public sendMessage(chid: number, payload: Uint8Array): number[] {
    return this.scheduler.enqueueMessage(chid, payload);
  }

  public getRto(chid: number): number {
    return this.rtoState.get(chid)?.rto ?? this.linkConfig.initialRtoMs;
  }

  public getStats(chid: number): ArqStats {
    const tx = this.txFrames.get(chid) ?? 0;
    const rx = this.rxFrames.get(chid) ?? 0;
    const retx = this.retransmissions.get(chid) ?? 0;
    const rto = this.rtoState.get(chid);
    const loss = tx > 0 ? retx / tx : 0;

    return {
      txFrames: tx,
      rxFrames: rx,
      retransmissions: retx,
      smoothedRttMs: rto?.srtt ?? 0,
      rttVarMs: rto?.rttvar ?? 0,
      currentRtoMs: rto?.rto ?? this.linkConfig.initialRtoMs,
      estimatedPacketLoss: loss,
    };
  }

  public dequeueNextFrame(now?: number, bufferedAmount?: number): Frame | null {
    const timestamp = now ?? performance.now();
    this.checkRetransmissions(timestamp);

    const frame = this.scheduler.dequeueNextFrame(bufferedAmount);
    if (!frame) return null;

    const chid = frame.header.chid;
    this.txFrames.set(chid, (this.txFrames.get(chid) ?? 0) + 1);

    const cfg = this.channelConfigs.get(chid);
    if (
      cfg &&
      cfg.mode === DeliveryMode.RELIABLE_ORDERED &&
      (frame.header.flags & FLAG_ACK_ONLY) === 0
    ) {
      const seqMap = this.sentSlots.get(chid)!;
      if (!seqMap.has(frame.header.sequenceNumber)) {
        seqMap.set(frame.header.sequenceNumber, {
          seq: frame.header.sequenceNumber,
          frame,
          firstSentTs: timestamp,
          lastSentTs: timestamp,
          retransmitCount: 0,
          acked: false,
        });
      }
    }

    return frame;
  }

  public tick(now?: number): void {
    const timestamp = now ?? performance.now();
    this.checkRetransmissions(timestamp);
  }

  public checkRetransmissions(now: number): void {
    for (const [chid, cfg] of this.channelConfigs.entries()) {
      if (cfg.mode !== DeliveryMode.RELIABLE_ORDERED) continue;

      const rto = this.rtoState.get(chid)!.rto;
      const slots = this.sentSlots.get(chid)!;

      for (const slot of slots.values()) {
        if (!slot.acked && now - slot.lastSentTs >= rto) {
          slot.retransmitCount++;
          slot.lastSentTs = now;
          this.retransmissions.set(chid, (this.retransmissions.get(chid) ?? 0) + 1);
          this.scheduler.enqueueRetransmission(chid, slot.frame);
        }
      }
    }
  }

  public onWireFrame(frame: Frame, now?: number): void {
    const timestamp = now ?? performance.now();
    const chid = frame.header.chid;
    this.rxFrames.set(chid, (this.rxFrames.get(chid) ?? 0) + 1);

    // Process piggybacked ACK
    this.processAck(frame.header.ackChid, frame.header.cumulativeAckSeq, frame.header.sackMask, timestamp);

    // If ACK-ONLY, nothing more to process
    if ((frame.header.flags & FLAG_ACK_ONLY) !== 0) {
      return;
    }

    const cfg = this.channelConfigs.get(chid);
    if (!cfg) return;

    if (cfg.mode === DeliveryMode.UNRELIABLE_UNORDERED) {
      const assembly = this.assemblyBuffers.get(chid)!;
      if (frame.payload.byteLength > 0) {
        assembly.push(frame.payload);
      }
      if ((frame.header.flags & FLAG_MSG_END) !== 0) {
        const fullMsg = this.concatUint8Arrays(assembly);
        assembly.length = 0;
        this.emitMessage(chid, fullMsg);
      }
      return;
    }

    // RELIABLE_ORDERED
    const seq = frame.header.sequenceNumber;
    let expectedSeq = this.nextExpectedSeq.get(chid)!;

    if (seqLessThan(seq, expectedSeq)) {
      // Duplicate frame, update ACK state for remote sender
      this.updatePendingAck(chid);
      return;
    }

    const reorderBuf = this.reorderBuffers.get(chid)!;
    if (seq === expectedSeq) {
      const assembly = this.assemblyBuffers.get(chid)!;
      assembly.push(frame.payload);

      if ((frame.header.flags & FLAG_MSG_END) !== 0) {
        const fullMsg = this.concatUint8Arrays(assembly);
        assembly.length = 0;
        this.emitMessage(chid, fullMsg);
      }

      expectedSeq = (expectedSeq + 1) >>> 0;

      while (reorderBuf.has(expectedSeq)) {
        const nextFrame = reorderBuf.get(expectedSeq)!;
        reorderBuf.delete(expectedSeq);
        assembly.push(nextFrame.payload);

        if ((nextFrame.header.flags & FLAG_MSG_END) !== 0) {
          const fullMsg = this.concatUint8Arrays(assembly);
          assembly.length = 0;
          this.emitMessage(chid, fullMsg);
        }
        expectedSeq = (expectedSeq + 1) >>> 0;
      }

      this.nextExpectedSeq.set(chid, expectedSeq);
    } else {
      // Out of order
      reorderBuf.set(seq, frame);
    }

    this.updatePendingAck(chid);
  }

  private processAck(ackChid: number, cumAckSeq: number, sackMask: number, now: number): void {
    const slots = this.sentSlots.get(ackChid);
    if (!slots) return;

    for (const [seq, slot] of slots.entries()) {
      if (slot.acked) continue;

      let isAcked = false;
      // Cumulative ACK check: seq <= cumAckSeq in 32-bit serial arithmetic
      if (!seqLessThan(cumAckSeq, seq)) {
        isAcked = true;
      } else {
        // SACK bitmask check
        const diff = seqDiff(seq, (cumAckSeq + 1) >>> 0);
        if (diff >= 0 && diff < 16) {
          if ((sackMask & (1 << diff)) !== 0) {
            isAcked = true;
          }
        }
      }

      if (isAcked) {
        slot.acked = true;
        this.scheduler.releaseInFlight(ackChid, 1);

        // Jacobson/Karels RTO update on clean (non-retransmitted) samples only
        if (slot.retransmitCount === 0) {
          const rtt = Math.max(1, now - slot.firstSentTs);
          this.updateRto(ackChid, rtt);
        }
      }
    }

    // Clean up acked slots from sliding window
    for (const [seq, slot] of Array.from(slots.entries())) {
      if (slot.acked) {
        slots.delete(seq);
      }
    }
  }

  private updateRto(chid: number, rttMs: number): void {
    const state = this.rtoState.get(chid)!;
    if (!state.hasSample) {
      state.srtt = rttMs;
      state.rttvar = rttMs / 2;
      state.hasSample = true;
    } else {
      const alpha = 0.125;
      const beta = 0.25;
      state.rttvar = (1 - beta) * state.rttvar + beta * Math.abs(state.srtt - rttMs);
      state.srtt = (1 - alpha) * state.srtt + alpha * rttMs;
    }

    const rawRto = state.srtt + 4 * state.rttvar;
    state.rto = Math.max(
      this.linkConfig.minRtoMs,
      Math.min(this.linkConfig.maxRtoMs, rawRto)
    );
  }

  private updatePendingAck(chid: number): void {
    const expectedSeq = this.nextExpectedSeq.get(chid)!;
    const cumAckSeq = (expectedSeq - 1) >>> 0;
    const sackMask = this.calculateSackMask(chid);
    this.scheduler.setPendingAck(chid, cumAckSeq, sackMask);
  }

  private calculateSackMask(chid: number): number {
    const expectedSeq = this.nextExpectedSeq.get(chid)!;
    const buffer = this.reorderBuffers.get(chid);
    if (!buffer || buffer.size === 0) return 0;

    let mask = 0;
    for (let i = 0; i < 16; i++) {
      const targetSeq = (expectedSeq + i) >>> 0;
      if (buffer.has(targetSeq)) {
        mask |= 1 << i;
      }
    }
    return mask;
  }

  private emitMessage(chid: number, payload: Uint8Array): void {
    for (const cb of this.messageCallbacks) {
      cb(chid, payload);
    }
  }

  private concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (const c of chunks) totalLen += c.byteLength;
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
}
