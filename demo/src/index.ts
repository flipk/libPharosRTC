import { ResilientLinkClient } from '../../src/ts/ResilientLinkClient';
import { FecDecoder, FLAG_FEC_PARITY } from '../../src/ts/FecEngine';
import { decodeFrame } from '../../src/ts/FrameCodec';
import { ImpairmentController } from './ImpairmentController';
import { FileTransferEngine, generateSyntheticData, TransferProgress } from './FileTransferEngine';
import { TelemetryUI, ExtendedTelemetryStats } from './TelemetryUI';

let client: ResilientLinkClient | null = null;
const impairment = new ImpairmentController();
const transferEngine = new FileTransferEngine();
const telemetryUI = new TelemetryUI();
const fecDecoder = new FecDecoder(4); // Default group size 4

let selectedPresetSize: number = 1048576; // Default 1 MB
let localSelectedFile: File | null = null;

let fecParityTxCount = 0;
let fecParityRxCount = 0;
let fecRecoveriesCount = 0;

// UI Elements
const connBadge = document.getElementById('connBadge') as HTMLElement;
const btnConnect = document.getElementById('btnConnect') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btnDisconnect') as HTMLButtonElement;

const lossSlider = document.getElementById('lossSlider') as HTMLInputElement;
const lossValue = document.getElementById('lossValue') as HTMLElement;
const lossRadios = document.querySelectorAll<HTMLInputElement>('input[name="lossDir"]');

const transferDirection = document.getElementById('transferDirection') as HTMLSelectElement;
const presetBtns = document.querySelectorAll<HTMLButtonElement>('.preset-btn');
const filePicker = document.getElementById('filePicker') as HTMLInputElement;
const currentSelectionText = document.getElementById('currentSelectionText') as HTMLElement;
const btnStartTransfer = document.getElementById('btnStartTransfer') as HTMLButtonElement;
const btnCancelTransfer = document.getElementById('btnCancelTransfer') as HTMLButtonElement;

const transferStatusText = document.getElementById('transferStatusText') as HTMLElement;
const transferProgressText = document.getElementById('transferProgressText') as HTMLElement;
const progressBarFill = document.getElementById('progressBarFill') as HTMLElement;
const transferSpeed = document.getElementById('transferSpeed') as HTMLElement;
const transferElapsed = document.getElementById('transferElapsed') as HTMLElement;
const integrityBadge = document.getElementById('integrityBadge') as HTMLElement;

const c2Input = document.getElementById('c2Input') as HTMLInputElement;
const btnSendC2 = document.getElementById('btnSendC2') as HTMLButtonElement;
const c2Log = document.getElementById('c2Log') as HTMLElement;

function logC2(msg: string) {
  const line = document.createElement('div');
  line.className = 'log-line';
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${msg}`;
  c2Log.appendChild(line);
  c2Log.scrollTop = c2Log.scrollHeight;
}

// Impairment slider event listener
lossSlider.addEventListener('input', () => {
  const percent = parseInt(lossSlider.value, 10);
  lossValue.textContent = `${percent}%`;
  impairment.setLossRate(percent);
  syncLossWithServer();
});

lossRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    impairment.setDirection(radio.value as any);
    syncLossWithServer();
  });
});

function syncLossWithServer() {
  if (client) {
    const payload = JSON.stringify({
      type: 'set_loss',
      rate: impairment.getLossRate(),
      direction: impairment.getDirection(),
    });
    client.send(0, new TextEncoder().encode(payload));
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1048576) {
    const mb = bytes / 1048576;
    return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return Number.isInteger(kb) ? `${kb} KB` : `${kb.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function updateSelectionDisplay() {
  presetBtns.forEach((btn) => {
    const size = parseInt(btn.dataset.size || '0', 10);
    if (!localSelectedFile && size === selectedPresetSize) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (localSelectedFile) {
    filePicker.classList.add('file-selected');
    const formattedSize = formatBytes(localSelectedFile.size);
    if (currentSelectionText) {
      currentSelectionText.textContent = `Custom File: ${localSelectedFile.name} (${formattedSize})`;
    }
  } else {
    filePicker.classList.remove('file-selected');
    const formattedSize = formatBytes(selectedPresetSize);
    if (currentSelectionText) {
      currentSelectionText.textContent = `${formattedSize} Synthetic Preset`;
    }
  }
}

// Preset button handlers
presetBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedPresetSize = parseInt(btn.dataset.size || '1048576', 10);
    filePicker.value = '';
    localSelectedFile = null;
    updateSelectionDisplay();
  });
});

filePicker.addEventListener('change', () => {
  if (filePicker.files && filePicker.files[0]) {
    localSelectedFile = filePicker.files[0];
  } else {
    localSelectedFile = null;
  }
  updateSelectionDisplay();
});

// Initialize UI selection display
updateSelectionDisplay();

// Connect Button
btnConnect.addEventListener('click', async () => {
  if (client) {
    client.disconnect();
  }

  connBadge.textContent = 'Connecting...';
  connBadge.className = 'badge badge-connecting';
  const tStart = performance.now();

  client = new ResilientLinkClient(undefined, undefined, true); // WebWorker mode

  // Listen for out-of-band server telemetry over WebSocket
  client.getSignalingClient().onMessage((data: any) => {
    if (data.type === 'server_telemetry' && data.stats) {
      telemetryUI.updateServerStats(data.stats);
    }
  });

  // Set impairment filters on transport
  const transport = (client as any).transport;
  if (transport) {
    // Note: Server-to-client loss is simulated on server side in demo_server.py.
    // Client handles client-to-server outbound loss to prevent double dropping.
    transport.setInboundFilter(() => true);
    transport.setOutboundFilter(() => !impairment.shouldDropOutbound());
  }

  client.onChannelOpen(() => {
    const elapsedMs = (performance.now() - tStart).toFixed(0);
    connBadge.textContent = 'Connected';
    connBadge.className = 'badge badge-connected';
    btnConnect.disabled = true;
    btnDisconnect.disabled = false;
    btnStartTransfer.disabled = false;
    btnSendC2.disabled = false;
    logC2(`WebRTC DataChannel connected in ${elapsedMs} ms.`);
    syncLossWithServer();
  });

  // Track C2 messages
  client.onReceive(0, (payload) => {
    const text = new TextDecoder().decode(payload);
    try {
      const json = JSON.parse(text);
      if (json.type === 'download_complete') {
        logC2(`[Server] Download stream complete: ${json.size} bytes`);
      } else if (json.type === 'upload_progress') {
        transferEngine.updateUploadProgress(json.received, json.total);
      } else if (json.type === 'upload_complete') {
        logC2(`[Server] Upload verified: ${json.size} bytes (SHA-256 match: ${json.hash_match})`);
        transferEngine.handleIncomingChunk(new Uint8Array([0x03]));
      } else {
        logC2(`[C2 RX] ${text}`);
      }
    } catch {
      logC2(`[C2 RX] ${text}`);
    }
  });

  // Bulk channel (ChID 2) receiver for file transfer
  client.onReceive(2, (payload) => {
    transferEngine.handleIncomingChunk(payload, (ackMsg) => {
      if (client) client.send(2, ackMsg);
    });
  });

  // Progress callback for file transfer engine
  transferEngine.onProgress((progress: TransferProgress) => {
    updateTransferUI(progress);
  });

  const wsUrl = `ws://${window.location.host}/ws/webrtc`;
  try {
    await client.connect(wsUrl);
  } catch (err) {
    connBadge.textContent = 'Error';
    connBadge.className = 'badge badge-fail';
    logC2(`Connection failed: ${(err as Error).message}`);
  }
});

btnDisconnect.addEventListener('click', () => {
  if (client) {
    client.disconnect();
    client = null;
  }
  connBadge.textContent = 'Disconnected';
  connBadge.className = 'badge badge-disconnected';
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
  btnStartTransfer.disabled = true;
  btnCancelTransfer.disabled = true;
  btnSendC2.disabled = true;
  logC2('Disconnected from server.');
});

// Start Transfer
btnStartTransfer.addEventListener('click', async () => {
  if (!client) return;

  const mode = transferDirection.value;
  btnStartTransfer.disabled = true;
  btnCancelTransfer.disabled = false;
  integrityBadge.textContent = 'In Progress';
  integrityBadge.className = 'badge badge-neutral';

  if (mode === 'upload') {
    let dataToUpload: Uint8Array;
    if (localSelectedFile) {
      const arrayBuf = await localSelectedFile.arrayBuffer();
      dataToUpload = new Uint8Array(arrayBuf);
    } else {
      dataToUpload = generateSyntheticData(selectedPresetSize);
    }

    transferStatusText.textContent = `Uploading ${dataToUpload.byteLength.toLocaleString()} B...`;
    logC2(`Started file upload: ${dataToUpload.byteLength} bytes.`);

    await transferEngine.startUpload(dataToUpload, (chunk) => {
      if (client) {
        client.send(2, chunk);
      }
    });
  } else {
    // Download mode
    const sizeToRequest = localSelectedFile ? localSelectedFile.size : selectedPresetSize;
    transferStatusText.textContent = `Requesting download of ${sizeToRequest.toLocaleString()} B...`;
    logC2(`Requested download: ${sizeToRequest} bytes.`);

    const requestJson = JSON.stringify({ type: 'request_download', size: sizeToRequest });
    client.send(0, new TextEncoder().encode(requestJson));
  }
});

btnCancelTransfer.addEventListener('click', () => {
  transferEngine.cancel();
  transferStatusText.textContent = 'Cancelled';
  btnStartTransfer.disabled = false;
  btnCancelTransfer.disabled = true;
  integrityBadge.textContent = 'Cancelled';
  integrityBadge.className = 'badge badge-fail';
});

// C2 Send
btnSendC2.addEventListener('click', () => {
  if (!client) return;
  const msg = c2Input.value.trim();
  if (msg) {
    client.send(0, new TextEncoder().encode(msg));
    logC2(`[C2 TX] ${msg}`);
    c2Input.value = '';
  }
});

c2Input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnSendC2.click();
  }
});

function updateTransferUI(p: TransferProgress) {
  transferProgressText.textContent = `${p.percentage.toFixed(1)}% (${p.bytesTransferred.toLocaleString()} / ${p.totalBytes.toLocaleString()} B)`;
  progressBarFill.style.width = `${p.percentage}%`;
  transferSpeed.textContent = `${p.speedKbps.toFixed(1)} KB/s`;
  transferElapsed.textContent = `${p.elapsedSeconds.toFixed(1)}s`;

  if (p.isComplete) {
    btnStartTransfer.disabled = false;
    btnCancelTransfer.disabled = true;
    transferStatusText.textContent = 'Transfer Complete!';

    if (p.hashMatch === true) {
      integrityBadge.textContent = 'PASS - SHA-256 Verified';
      integrityBadge.className = 'badge badge-pass';
      logC2('SHA-256 integrity check PASSED! 100% loss-free reconstruction.');
    } else if (p.hashMatch === false) {
      integrityBadge.textContent = 'FAIL - Hash Mismatch';
      integrityBadge.className = 'badge badge-fail';
      logC2('SHA-256 integrity check FAILED.');
    }
  }
}

// Telemetry Polling Loop (100ms)
setInterval(() => {
  if (client) {
    const arqStats = client.getStats(2); // Check bulk channel stats
    const stats: ExtendedTelemetryStats = {
      ...arqStats,
      fecParityTx: arqStats.fecParityTx ?? 0,
      fecParityRx: arqStats.fecParityRx ?? 0,
      fecRecoveries: arqStats.fecRecoveries ?? 0,
      appMtu: 220,
    };
    telemetryUI.update(stats);
  }
}, 100);
