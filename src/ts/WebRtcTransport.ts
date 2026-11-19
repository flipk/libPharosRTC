import { SignalingClient } from './SignalingClient';

export type WireFrameCallback = (data: ArrayBuffer) => void;
export type ChannelOpenCallback = () => void;
export type ConnectionStateCallback = (state: RTCPeerConnectionState) => void;

export class WebRtcTransport {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  private wireFrameCallbacks: WireFrameCallback[] = [];
  private openCallbacks: ChannelOpenCallback[] = [];
  private stateCallbacks: ConnectionStateCallback[] = [];

  private inboundFilter: ((data: ArrayBuffer) => boolean) | null = null;
  private outboundFilter: ((data: ArrayBuffer | Uint8Array) => boolean) | null = null;

  private signalingClient: SignalingClient | null = null;

  constructor() {}

  public setInboundFilter(filter: ((data: ArrayBuffer) => boolean) | null): void {
    this.inboundFilter = filter;
  }

  public setOutboundFilter(filter: ((data: ArrayBuffer | Uint8Array) => boolean) | null): void {
    this.outboundFilter = filter;
  }

  public async startNegotiation(signalingClient: SignalingClient): Promise<void> {
    this.signalingClient = signalingClient;
    this.close();

    // iceServers: [] for local host candidates (no STUN/TURN required)
    this.pc = new RTCPeerConnection({ iceServers: [] });

    // Single unreliable, unordered DataChannel
    this.channel = this.pc.createDataChannel('link', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.channel.binaryType = 'arraybuffer';

    this.channel.onopen = () => {
      this.openCallbacks.forEach((cb) => cb());
    };

    this.channel.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        if (this.inboundFilter && !this.inboundFilter(event.data)) {
          return; // Dropped by impairment filter
        }
        this.wireFrameCallbacks.forEach((cb) => cb(event.data));
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        const state = this.pc.connectionState;
        this.stateCallbacks.forEach((cb) => cb(state));

        if (state === 'failed' || state === 'disconnected') {
          // Trigger immediate re-negotiation if signaling is open
          if (this.signalingClient && this.signalingClient.isOpen()) {
            this.startNegotiation(this.signalingClient).catch(() => {});
          }
        }
      }
    };

    let offerSent = false;
    const sendOfferNow = () => {
      if (offerSent || !this.pc) return;
      offerSent = true;
      const offer = this.pc.localDescription;
      if (offer) {
        signalingClient.sendOffer(offer.sdp);
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        setTimeout(sendOfferNow, 30);
      } else {
        sendOfferNow();
      }
    };

    setTimeout(sendOfferNow, 150);

    signalingClient.onAnswer((answerSdp: string) => {
      if (this.pc && (this.pc.signalingState === 'have-local-offer' || this.pc.signalingState === 'stable')) {
        this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }).catch(() => {});
      }
    });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
  }

  public sendWireFrame(data: ArrayBuffer | Uint8Array): boolean {
    if (this.channel && this.channel.readyState === 'open') {
      if (this.outboundFilter && !this.outboundFilter(data)) {
        return true; // Dropped by impairment filter
      }
      try {
        this.channel.send(data as any);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  public getBufferedAmount(): number {
    return this.channel ? this.channel.bufferedAmount : 0;
  }

  public onWireFrameReceived(cb: WireFrameCallback): void {
    this.wireFrameCallbacks.push(cb);
  }

  public onChannelOpen(cb: ChannelOpenCallback): void {
    this.openCallbacks.push(cb);
  }

  public onStateChange(cb: ConnectionStateCallback): void {
    this.stateCallbacks.push(cb);
  }

  public isChannelOpen(): boolean {
    return this.channel !== null && this.channel.readyState === 'open';
  }

  public close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}
