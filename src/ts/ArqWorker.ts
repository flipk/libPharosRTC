import { ArqEngine } from './ArqEngine';
import { LinkConfig, ChannelConfig, TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS } from './config';
import { decodeFrame, encodeFrame, Frame } from './FrameCodec';

export interface WorkerInitMsg {
  type: 'init';
  linkConfig?: LinkConfig;
  channelConfigs?: ChannelConfig[];
}

export interface WorkerSendMsg {
  type: 'sendMessage';
  chid: number;
  payload: ArrayBuffer | Uint8Array;
}

export interface WorkerSendBlobMsg {
  type: 'sendBlob';
  chid: number;
  blob: Blob;
  chunkSize?: number;
}

export interface WorkerWireFrameMsg {
  type: 'onWireFrame';
  frameBuffer: ArrayBuffer;
}

export interface WorkerTickMsg {
  type: 'tick';
  now?: number;
}

export interface WorkerGetStatsMsg {
  type: 'getStats';
  chid: number;
}

export type MainToWorkerMsg =
  | WorkerInitMsg
  | WorkerSendMsg
  | WorkerSendBlobMsg
  | WorkerWireFrameMsg
  | WorkerTickMsg
  | WorkerGetStatsMsg;

export interface BlobState {
  chid: number;
  blob: Blob;
  offset: number;
  totalBytes: number;
  chunkSize: number;
}

export class ArqWorkerHandler {
  private arqEngine!: ArqEngine;
  private postMessageCb: (msg: any) => void;
  private timerId: any = null;
  private activeBlobs: BlobState[] = [];

  constructor(
    postMessageCb: (msg: any) => void,
    linkConfig: LinkConfig = TERRESTRIAL_HIGH_BER_PROFILE,
    channelConfigs: ChannelConfig[] = [...DEFAULT_CHANNELS]
  ) {
    this.postMessageCb = postMessageCb;
    this.init(linkConfig, channelConfigs);
  }

  public init(linkConfig?: LinkConfig, channelConfigs?: ChannelConfig[]): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
    }

    const cfg = linkConfig || TERRESTRIAL_HIGH_BER_PROFILE;
    const chCfgs = channelConfigs || [...DEFAULT_CHANNELS];

    this.arqEngine = new ArqEngine(cfg, chCfgs);
    this.arqEngine.onMessage((chid, payload) => {
      const ab = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      this.postMessageCb({
        type: 'messageReceived',
        chid,
        payload: ab,
      });
    });

    // Unthrottled 10ms tick loop inside worker
    this.timerId = setInterval(() => {
      this.tick();
    }, 10);
  }

  public handleMessage(msg: MainToWorkerMsg): void {
    switch (msg.type) {
      case 'init':
        this.init(msg.linkConfig, msg.channelConfigs);
        break;
      case 'sendMessage': {
        const u8 = msg.payload instanceof Uint8Array ? msg.payload : new Uint8Array(msg.payload);
        this.arqEngine.sendMessage(msg.chid, u8);
        this.drainOutbound();
        break;
      }
      case 'sendBlob': {
        const chunkSize = msg.chunkSize || 1024 * 64; // default 64KB slice
        this.activeBlobs.push({
          chid: msg.chid,
          blob: msg.blob,
          offset: 0,
          totalBytes: msg.blob.size,
          chunkSize,
        });
        this.processBlobs();
        break;
      }
      case 'onWireFrame': {
        const frame = decodeFrame(msg.frameBuffer);
        this.arqEngine.onWireFrame(frame);
        this.drainOutbound();
        break;
      }
      case 'tick':
        this.tick(msg.now);
        break;
      case 'getStats': {
        const stats = this.arqEngine.getStats(msg.chid);
        this.postMessageCb({ type: 'stats', chid: msg.chid, stats });
        break;
      }
    }
  }

  public tick(now?: number): void {
    this.arqEngine.tick(now);
    this.processBlobs();
    this.drainOutbound(now);
  }

  private async processBlobs(): Promise<void> {
    for (let i = this.activeBlobs.length - 1; i >= 0; i--) {
      const state = this.activeBlobs[i];
      const scheduler = this.arqEngine.getScheduler();
      const inFlight = scheduler.getInFlightCount(state.chid);

      // Only slice next chunk if send window has capacity
      if (inFlight < 16 && state.offset < state.totalBytes) {
        const sliceSize = Math.min(state.chunkSize, state.totalBytes - state.offset);
        const slice = state.blob.slice(state.offset, state.offset + sliceSize);
        state.offset += sliceSize;

        try {
          const ab = await slice.arrayBuffer();
          this.arqEngine.sendMessage(state.chid, new Uint8Array(ab));
          this.postMessageCb({
            type: 'blobProgress',
            chid: state.chid,
            bytesSent: state.offset,
            totalBytes: state.totalBytes,
          });
        } catch {
          // ignore slice read errors
        }

        if (state.offset >= state.totalBytes) {
          this.activeBlobs.splice(i, 1);
        }
      }
    }
  }

  public drainOutbound(now?: number, bufferedAmount?: number): void {
    let frame: Frame | null;
    while ((frame = this.arqEngine.dequeueNextFrame(now, bufferedAmount)) !== null) {
      const buf = encodeFrame(frame);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      this.postMessageCb({
        type: 'wireFrameToSend',
        frameBuffer: ab,
      });
    }
  }

  public stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  public getEngine(): ArqEngine {
    return this.arqEngine;
  }
}

// Global worker setup if executing inside WebWorker scope
if (typeof self !== 'undefined' && 'postMessage' in self && typeof (self as any).importScripts === 'function') {
  const handler = new ArqWorkerHandler((msg) => (self as any).postMessage(msg));
  self.onmessage = (e: MessageEvent) => {
    handler.handleMessage(e.data);
  };
}
