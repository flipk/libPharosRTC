import { ResilientLinkClient } from './ResilientLinkClient';

let client: ResilientLinkClient | null = null;

const wsUrlInput = document.getElementById('wsUrl') as HTMLInputElement;
const btnConnect = document.getElementById('btnConnect') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btnDisconnect') as HTMLButtonElement;
const connStatus = document.getElementById('connStatus') as HTMLDivElement;

const c2Input = document.getElementById('c2Input') as HTMLInputElement;
const btnSendC2 = document.getElementById('btnSendC2') as HTMLButtonElement;
const c2Logs = document.getElementById('c2Logs') as HTMLDivElement;

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const btnSendFile = document.getElementById('btnSendFile') as HTMLButtonElement;
const fileProgress = document.getElementById('fileProgress') as HTMLProgressElement;

const statTx = document.getElementById('statTx') as HTMLElement;
const statRx = document.getElementById('statRx') as HTMLElement;
const statRetx = document.getElementById('statRetx') as HTMLElement;
const statRtt = document.getElementById('statRtt') as HTMLElement;
const statRto = document.getElementById('statRto') as HTMLElement;

function logC2(msg: string) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  c2Logs.appendChild(line);
  c2Logs.scrollTop = c2Logs.scrollHeight;
}

btnConnect.addEventListener('click', async () => {
  if (client) client.disconnect();

  client = new ResilientLinkClient(undefined, undefined, true); // Use WebWorker

  client.onReceive(0, (payload) => {
    const text = new TextDecoder().decode(payload);
    logC2(`RX (ChID 0): ${text}`);
  });

  client.onReceive(2, (payload) => {
    logC2(`RX (ChID 2 Bulk Chunk): ${payload.byteLength} bytes`);
  });

  connStatus.textContent = 'Status: Connecting...';
  try {
    await client.connect(wsUrlInput.value);
    connStatus.textContent = 'Status: Connected & Negotiating WebRTC';
  } catch (err) {
    connStatus.textContent = `Status: Error (${(err as Error).message})`;
  }
});

btnDisconnect.addEventListener('click', () => {
  if (client) {
    client.disconnect();
    client = null;
  }
  connStatus.textContent = 'Status: Disconnected';
});

btnSendC2.addEventListener('click', () => {
  if (!client) {
    alert('Connect first!');
    return;
  }
  const text = c2Input.value.trim();
  if (text) {
    const payload = new TextEncoder().encode(text);
    client.send(0, payload);
    logC2(`TX (ChID 0): ${text}`);
    c2Input.value = '';
  }
});

btnSendFile.addEventListener('click', () => {
  if (!client) {
    alert('Connect first!');
    return;
  }
  const file = fileInput.files?.[0];
  if (file) {
    client.sendBlob(2, file);
    logC2(`Started file upload: ${file.name} (${file.size} bytes)`);
  }
});

setInterval(() => {
  if (client) {
    const stats = client.getStats(0);
    statTx.textContent = stats.txFrames.toString();
    statRx.textContent = stats.rxFrames.toString();
    statRetx.textContent = stats.retransmissions.toString();
    statRtt.textContent = `${stats.smoothedRttMs.toFixed(1)} ms`;
    statRto.textContent = `${stats.currentRtoMs.toFixed(1)} ms`;
  }
}, 500);
