import { ArqEngine, ArqStats } from './ArqEngine';
import { ArqWorkerHandler } from './ArqWorker';
import { LinkConfig, ChannelConfig, TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS } from './config';
import { decodeFrame, encodeFrame } from './FrameCodec';
import { SignalingClient } from './SignalingClient';
import { WebRtcTransport } from './WebRtcTransport';

export type ReceiveCallback = (payload: Uint8Array) => void;

export class ResilientLinkClient {
  private signalingClient: SignalingClient;
  private transport: WebRtcTransport;
  private workerHandler: ArqWorkerHandler | null = null;
  private directEngine: ArqEngine | null = null;

  private receiveCallbacks: Map<number, ReceiveCallback[]> = new Map();

  constructor(
    linkConfig: LinkConfig = TERRESTRIAL_HIGH_BER_PROFILE,
    channelConfigs: ChannelConfig[] = [...DEFAULT_CHANNELS],
    useWorker: boolean = false
  ) {
    this.signalingClient = new SignalingClient();
    this.transport = new WebRtcTransport();

    if (useWorker) {
      this.workerHandler = new ArqWorkerHandler(
        (msg) => this.handleWorkerOutput(msg),
        linkConfig,
        channelConfigs
      );
    } else {
      this.directEngine = new ArqEngine(linkConfig, channelConfigs);
      this.directEngine.onMessage((chid, payload) => {
        this.emitReceive(chid, payload);
      });
    }

    this.transport.onWireFrameReceived((buffer) => {
      if (this.workerHandler) {
        this.workerHandler.handleMessage({ type: 'onWireFrame', frameBuffer: buffer });
      } else if (this.directEngine) {
        const frame = decodeFrame(buffer);
        this.directEngine.onWireFrame(frame);
        this.drainDirectEngine();
      }
    });

    this.transport.onChannelOpen(() => {
      if (this.workerHandler) {
        this.workerHandler.drainOutbound();
      } else if (this.directEngine) {
        this.drainDirectEngine();
      }
    });
  }

  public onChannelOpen(cb: () => void): void {
    this.transport.onChannelOpen(cb);
  }

  public async connect(signalingUrl: string): Promise<void> {
    await this.signalingClient.connect(signalingUrl);
    await this.transport.startNegotiation(this.signalingClient);
  }

  public send(chid: number, payload: Uint8Array): void {
    if (this.workerHandler) {
      this.workerHandler.handleMessage({ type: 'sendMessage', chid, payload });
    } else if (this.directEngine) {
      this.directEngine.sendMessage(chid, payload);
      this.drainDirectEngine();
    }
  }

  public sendBlob(chid: number, blob: Blob): void {
    if (this.workerHandler) {
      this.workerHandler.handleMessage({ type: 'sendBlob', chid, blob });
    } else {
      // Fallback direct blob slicing
      this.sliceAndSendBlobDirect(chid, blob);
    }
  }

  public onReceive(chid: number, cb: ReceiveCallback): void {
    if (!this.receiveCallbacks.has(chid)) {
      this.receiveCallbacks.set(chid, []);
    }
    this.receiveCallbacks.get(chid)!.push(cb);
  }

  public getStats(chid: number): ArqStats {
    if (this.directEngine) {
      return this.directEngine.getStats(chid);
    }
    if (this.workerHandler) {
      return this.workerHandler.getEngine().getStats(chid);
    }
    return {
      txFrames: 0,
      rxFrames: 0,
      retransmissions: 0,
      smoothedRttMs: 0,
      rttVarMs: 0,
      currentRtoMs: 0,
      estimatedPacketLoss: 0,
    };
  }

  public disconnect(): void {
    this.signalingClient.disconnect();
    this.transport.close();
    if (this.workerHandler) {
      this.workerHandler.stop();
    }
  }

  private handleWorkerOutput(msg: any): void {
    if (msg.type === 'wireFrameToSend') {
      const u8 = new Uint8Array(msg.frameBuffer);
      this.transport.sendWireFrame(u8);
    } else if (msg.type === 'messageReceived') {
      const u8 = new Uint8Array(msg.payload);
      this.emitReceive(msg.chid, u8);
    }
  }

  private drainDirectEngine(): void {
    if (!this.directEngine) return;
    let frame: ReturnType<ArqEngine['dequeueNextFrame']>;
    while (
      (frame = this.directEngine.dequeueNextFrame(
        undefined,
        this.transport.getBufferedAmount()
      )) !== null
    ) {
      const buf = encodeFrame(frame);
      this.transport.sendWireFrame(buf);
    }
  }

  private async sliceAndSendBlobDirect(chid: number, blob: Blob): Promise<void> {
    const chunkSize = 1024 * 64;
    let offset = 0;
    while (offset < blob.size) {
      const slice = blob.slice(offset, offset + chunkSize);
      offset += slice.size;
      const ab = await slice.arrayBuffer();
      this.send(chid, new Uint8Array(ab));
    }
  }

  private emitReceive(chid: number, payload: Uint8Array): void {
    const cbs = this.receiveCallbacks.get(chid) || [];
    cbs.forEach((cb) => cb(payload));
  }
}
