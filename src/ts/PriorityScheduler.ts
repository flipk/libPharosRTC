import { LinkConfig, ChannelConfig, DEFAULT_CHANNELS, DeliveryMode } from './config';
import {
  Frame,
  FrameHeader,
  PROTOCOL_VERSION,
  HEADER_SIZE_BYTES,
  FLAG_ACK_ONLY,
  FLAG_MSG_END,
} from './FrameCodec';

export interface PendingAck {
  hasAck: boolean;
  ackChid: number;
  cumAckSeq: number;
  sackMask: number;
}

export class PriorityScheduler {
  private linkConfig: LinkConfig;
  private channelConfigs: Map<number, ChannelConfig>;
  private sortedChids: number[];

  private newFrameQueues: Map<number, Frame[]>;
  private retransmitQueues: Map<number, Frame[]>;
  private nextSeqNums: Map<number, number>;
  private inFlightCounts: Map<number, number>;

  private pendingAck: PendingAck = {
    hasAck: false,
    ackChid: 0,
    cumAckSeq: 0,
    sackMask: 0,
  };

  constructor(linkConfig: LinkConfig, channelConfigs: ChannelConfig[] = [...DEFAULT_CHANNELS]) {
    this.linkConfig = linkConfig;
    this.channelConfigs = new Map();
    this.newFrameQueues = new Map();
    this.retransmitQueues = new Map();
    this.nextSeqNums = new Map();
    this.inFlightCounts = new Map();

    for (const cfg of channelConfigs) {
      this.channelConfigs.set(cfg.id, cfg);
      this.newFrameQueues.set(cfg.id, []);
      this.retransmitQueues.set(cfg.id, []);
      this.nextSeqNums.set(cfg.id, 0);
      this.inFlightCounts.set(cfg.id, 0);
    }

    this.sortedChids = Array.from(this.channelConfigs.values())
      .sort((a, b) => a.priority - b.priority)
      .map((cfg) => cfg.id);
  }

  public canSend(bufferedAmount: number): boolean {
    return bufferedAmount < this.getLowWaterMark();
  }

  public getLowWaterMark(): number {
    return 64 * this.linkConfig.appMtuBytes;
  }

  public enqueueMessage(chid: number, payload: Uint8Array, extraFlags: number = 0): number[] {
    const cfg = this.channelConfigs.get(chid);
    if (!cfg) {
      throw new Error(`Channel ${chid} is not configured`);
    }

    const maxPayload = this.linkConfig.appMtuBytes - HEADER_SIZE_BYTES;
    const seqNumsAssigned: number[] = [];
    let nextSeq = this.nextSeqNums.get(chid) ?? 0;
    const queue = this.newFrameQueues.get(chid)!;

    if (payload.byteLength === 0) {
      const seq = nextSeq;
      nextSeq = (nextSeq + 1) >>> 0;
      const header: FrameHeader = {
        version: PROTOCOL_VERSION,
        flags: extraFlags | FLAG_MSG_END,
        chid,
        ackChid: 0,
        payloadLength: 0,
        sequenceNumber: seq,
        cumulativeAckSeq: 0,
        sackMask: 0,
      };
      queue.push({ header, payload: new Uint8Array(0) });
      seqNumsAssigned.push(seq);
    } else {
      let offset = 0;
      while (offset < payload.byteLength) {
        const chunkSize = Math.min(maxPayload, payload.byteLength - offset);
        const chunk = payload.subarray(offset, offset + chunkSize);
        offset += chunkSize;
        const isLast = offset >= payload.byteLength;

        const seq = nextSeq;
        nextSeq = (nextSeq + 1) >>> 0;

        const flags = extraFlags | (isLast ? FLAG_MSG_END : 0);
        const header: FrameHeader = {
          version: PROTOCOL_VERSION,
          flags,
          chid,
          ackChid: 0,
          payloadLength: chunkSize,
          sequenceNumber: seq,
          cumulativeAckSeq: 0,
          sackMask: 0,
        };
        queue.push({ header, payload: chunk });
        seqNumsAssigned.push(seq);
      }
    }

    this.nextSeqNums.set(chid, nextSeq);
    return seqNumsAssigned;
  }

  public enqueueRetransmission(chid: number, frame: Frame): void {
    const queue = this.retransmitQueues.get(chid);
    if (!queue) {
      throw new Error(`Channel ${chid} is not configured`);
    }
    queue.push(frame);
  }

  public setPendingAck(ackChid: number, cumAckSeq: number, sackMask: number): void {
    this.pendingAck = {
      hasAck: true,
      ackChid,
      cumAckSeq,
      sackMask,
    };
  }

  public hasPendingAck(): boolean {
    return this.pendingAck.hasAck;
  }

  public hasPendingFrames(): boolean {
    for (const q of this.retransmitQueues.values()) {
      if (q.length > 0) return true;
    }
    for (const chid of this.sortedChids) {
      const q = this.newFrameQueues.get(chid)!;
      if (q.length > 0) {
        const cfg = this.channelConfigs.get(chid)!;
        if (cfg.mode === DeliveryMode.UNRELIABLE_UNORDERED || cfg.windowSize <= 0) {
          return true;
        }
        const inFlight = this.inFlightCounts.get(chid) ?? 0;
        if (inFlight < cfg.windowSize) {
          return true;
        }
      }
    }
    return this.pendingAck.hasAck;
  }

  public dequeueNextFrame(bufferedAmount?: number): Frame | null {
    if (bufferedAmount !== undefined && !this.canSend(bufferedAmount)) {
      return null;
    }

    // 1. Expired Retransmissions on highest-priority channel first
    for (const chid of this.sortedChids) {
      const retxQueue = this.retransmitQueues.get(chid)!;
      if (retxQueue.length > 0) {
        const frame = retxQueue.shift()!;
        this.applyPiggybackedAck(frame);
        return frame;
      }
    }

    // 2. New Outbound Frames on highest-priority channel first
    for (const chid of this.sortedChids) {
      const newQueue = this.newFrameQueues.get(chid)!;
      if (newQueue.length > 0) {
        const cfg = this.channelConfigs.get(chid)!;
        if (cfg.mode === DeliveryMode.RELIABLE_ORDERED && cfg.windowSize > 0) {
          const inFlight = this.inFlightCounts.get(chid) ?? 0;
          if (inFlight >= cfg.windowSize) {
            continue;
          }
        }

        const frame = newQueue.shift()!;
        if (cfg.mode === DeliveryMode.RELIABLE_ORDERED && cfg.windowSize > 0) {
          const currentInFlight = this.inFlightCounts.get(chid) ?? 0;
          this.inFlightCounts.set(chid, currentInFlight + 1);
        }
        this.applyPiggybackedAck(frame);
        return frame;
      }
    }

    // 3. Standalone FLAG_ACK_ONLY Frame
    if (this.pendingAck.hasAck) {
      const ackFrame: Frame = {
        header: {
          version: PROTOCOL_VERSION,
          flags: FLAG_ACK_ONLY,
          chid: this.sortedChids[0] ?? 0,
          ackChid: this.pendingAck.ackChid,
          payloadLength: 0,
          sequenceNumber: 0,
          cumulativeAckSeq: this.pendingAck.cumAckSeq,
          sackMask: this.pendingAck.sackMask,
        },
        payload: new Uint8Array(0),
      };
      this.pendingAck.hasAck = false;
      return ackFrame;
    }

    return null;
  }

  private applyPiggybackedAck(frame: Frame): void {
    if (this.pendingAck.hasAck) {
      const parityFlag = frame.header.ackChid & 0x80;
      frame.header.ackChid = (this.pendingAck.ackChid & 0x7f) | parityFlag;
      frame.header.cumulativeAckSeq = this.pendingAck.cumAckSeq;
      frame.header.sackMask = this.pendingAck.sackMask;
      this.pendingAck.hasAck = false;
    }
  }

  public releaseInFlight(chid: number, count: number = 1): void {
    const current = this.inFlightCounts.get(chid) ?? 0;
    this.inFlightCounts.set(chid, Math.max(0, current - count));
  }

  public removeAckedRetransmission(chid: number, seq: number): void {
    const queue = this.retransmitQueues.get(chid);
    if (queue && queue.length > 0) {
      this.retransmitQueues.set(
        chid,
        queue.filter((f) => f.header.sequenceNumber !== seq)
      );
    }
  }

  public getInFlightCount(chid: number): number {
    return this.inFlightCounts.get(chid) ?? 0;
  }

  public getQueueDepth(chid: number): { retransmit: number; newFrames: number } {
    const retransmit = this.retransmitQueues.get(chid)?.length ?? 0;
    const newFrames = this.newFrameQueues.get(chid)?.length ?? 0;
    return { retransmit, newFrames };
  }
}
