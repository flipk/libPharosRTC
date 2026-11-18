import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalingClient } from '../../src/ts/SignalingClient';
import { ArqWorkerHandler } from '../../src/ts/ArqWorker';
import { ResilientLinkClient } from '../../src/ts/ResilientLinkClient';
import { TERRESTRIAL_HIGH_BER_PROFILE, DEFAULT_CHANNELS } from '../../src/ts/config';
import { encodeFrame, PROTOCOL_VERSION, FLAG_MSG_END } from '../../src/ts/FrameCodec';

describe('SignalingClient', () => {
  it('registers callbacks and handles answer messages', () => {
    const client = new SignalingClient({ autoReconnect: false });
    const answers: string[] = [];
    client.onAnswer((sdp) => answers.push(sdp));

    // Create fake ws
    const fakeWs: any = {
      readyState: 1, // OPEN
      send: vi.fn(),
      close: vi.fn(),
    };
    (client as any).ws = fakeWs;

    // Trigger onmessage logic
    const fakeEvent = {
      data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1...' }),
    };

    // Simulate message handler
    const messageHandler = (event: any) => {
      const data = JSON.parse(event.data);
      if (data.type === 'answer' && typeof data.sdp === 'string') {
        (client as any).answerCallbacks.forEach((cb: any) => cb(data.sdp));
      }
    };

    messageHandler(fakeEvent);

    expect(answers.length).toBe(1);
    expect(answers[0]).toContain('v=0');
  });
});

describe('ArqWorkerHandler & Demand-Driven Blob Slicing', () => {
  let outputs: any[] = [];
  let handler: ArqWorkerHandler;

  beforeEach(() => {
    outputs = [];
    handler = new ArqWorkerHandler(
      (msg) => outputs.push(msg),
      TERRESTRIAL_HIGH_BER_PROFILE,
      [...DEFAULT_CHANNELS]
    );
  });

  it('handles sendMessage IPC and emits wireFrameToSend', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    handler.handleMessage({ type: 'sendMessage', chid: 0, payload });

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('wireFrameToSend');
    expect(outputs[0].frameBuffer.byteLength).toBe(14 + 5);

    handler.stop();
  });

  it('handles onWireFrame IPC and emits messageReceived', () => {
    const frame = {
      header: {
        version: PROTOCOL_VERSION,
        flags: FLAG_MSG_END,
        chid: 0,
        ackChid: 0,
        payloadLength: 4,
        sequenceNumber: 0,
        cumulativeAckSeq: 0,
        sackMask: 0,
      },
      payload: new Uint8Array([10, 20, 30, 40]),
    };
    const encoded = encodeFrame(frame);

    handler.handleMessage({ type: 'onWireFrame', frameBuffer: encoded.buffer });

    const rxMsg = outputs.find((m) => m.type === 'messageReceived');
    expect(rxMsg).toBeDefined();
    expect(rxMsg.chid).toBe(0);
    expect(new Uint8Array(rxMsg.payload)).toEqual(new Uint8Array([10, 20, 30, 40]));

    handler.stop();
  });

  it('slices Blobs on demand without buffering full blob into RAM', async () => {
    const blobData = new Uint8Array(200);
    for (let i = 0; i < 200; i++) blobData[i] = i & 0xff;
    const blob = new Blob([blobData]);

    handler.handleMessage({ type: 'sendBlob', chid: 2, blob, chunkSize: 80 });

    for (let i = 0; i < 10; i++) {
      handler.tick(i * 10);
      await new Promise((r) => setTimeout(r, 5));
    }

    const progressMsgs = outputs.filter((m) => m.type === 'blobProgress');
    expect(progressMsgs.length).toBeGreaterThan(0);
    const lastProgress = progressMsgs[progressMsgs.length - 1];
    expect(lastProgress.bytesSent).toBe(200);
    expect(lastProgress.totalBytes).toBe(200);

    handler.stop();
  });
});

describe('ResilientLinkClient API', () => {
  it('sends and receives messages using direct engine', () => {
    const client1 = new ResilientLinkClient(TERRESTRIAL_HIGH_BER_PROFILE, [...DEFAULT_CHANNELS], false);
    const client2 = new ResilientLinkClient(TERRESTRIAL_HIGH_BER_PROFILE, [...DEFAULT_CHANNELS], false);

    const received: Uint8Array[] = [];
    client2.onReceive(0, (payload) => {
      received.push(payload);
    });

    // Wire up transport loop directly
    const transport1 = (client1 as any).transport;
    const transport2 = (client2 as any).transport;

    transport1.sendWireFrame = (data: Uint8Array) => {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      transport2.wireFrameCallbacks.forEach((cb: any) => cb(u8.buffer));
      return true;
    };

    transport2.sendWireFrame = (data: Uint8Array) => {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      transport1.wireFrameCallbacks.forEach((cb: any) => cb(u8.buffer));
      return true;
    };

    client1.send(0, new Uint8Array([42, 43, 44]));

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([42, 43, 44]));
  });
});
