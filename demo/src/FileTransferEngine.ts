export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speedKbps: number;
  elapsedSeconds: number;
  isComplete: boolean;
  hashMatch: boolean | null; // null if pending, true/false when complete
}

export type ProgressCallback = (progress: TransferProgress) => void;

export async function computeSha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeSha256Bytes(buffer: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

export function generateSyntheticData(sizeBytes: number): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  // Fill with deterministic repeating pseudo-random pattern for speed and consistency
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i * 31 + 17) & 0xff;
  }
  return buf;
}

export class FileTransferEngine {
  private activeBuffer: Uint8Array | null = null;
  private expectedSize: number = 0;
  private expectedHashHex: string = '';
  private receivedBytes: number = 0;
  private receivedOffsetMap: Set<number> = new Set();

  private startTime: number = 0;
  private isUploading: boolean = false;
  private isDownloading: boolean = false;
  private isCancelled: boolean = false;

  private onProgressCb: ProgressCallback | null = null;

  public onProgress(cb: ProgressCallback): void {
    this.onProgressCb = cb;
  }

  public reset(): void {
    this.activeBuffer = null;
    this.expectedSize = 0;
    this.expectedHashHex = '';
    this.receivedBytes = 0;
    this.receivedOffsetMap.clear();
    this.startTime = 0;
    this.isUploading = false;
    this.isDownloading = false;
    this.isCancelled = false;
  }

  public cancel(): void {
    this.isCancelled = true;
    this.reset();
  }

  public updateUploadProgress(receivedBytes: number, totalBytes: number): void {
    if (!this.isUploading) return;
    this.receivedBytes = receivedBytes;
    this.expectedSize = totalBytes;
    this.notifyProgress(false, null);
  }

  public isBusy(): boolean {
    return this.isUploading || this.isDownloading;
  }

  // Handle incoming wire frame on ChID 2
  public async handleIncomingChunk(
    payload: Uint8Array,
    sendAckCb?: (ackMsg: Uint8Array) => void
  ): Promise<void> {
    if (this.isCancelled || payload.byteLength === 0) return;

    const type = payload[0];

    if (type === 0x01) {
      // META FRAME: [0x01][4 bytes size][32 bytes sha256]
      if (this.isUploading || payload.byteLength < 37) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      this.expectedSize = view.getUint32(1, false);
      const hashBytes = payload.subarray(5, 37);
      this.expectedHashHex = Array.from(hashBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      this.activeBuffer = new Uint8Array(this.expectedSize);
      this.receivedBytes = 0;
      this.receivedOffsetMap.clear();
      this.startTime = performance.now();
      this.isDownloading = true;

      this.notifyProgress(false, null);
    } else if (type === 0x02) {
      // CHUNK FRAME: [0x02][4 bytes offset][payload bytes]
      if (!this.isDownloading || !this.activeBuffer || payload.byteLength < 5) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const offset = view.getUint32(1, false);
      const chunkData = payload.subarray(5);

      if (offset + chunkData.byteLength > this.activeBuffer.byteLength) return;

      if (!this.receivedOffsetMap.has(offset)) {
        this.receivedOffsetMap.add(offset);
        this.activeBuffer.set(chunkData, offset);
        this.receivedBytes += chunkData.byteLength;
      }

      const complete = this.receivedBytes >= this.expectedSize;
      let hashMatch: boolean | null = null;

      if (complete) {
        const computedHash = await computeSha256Hex(this.activeBuffer);
        hashMatch = computedHash === this.expectedHashHex;
        this.isDownloading = false;

        if (sendAckCb) {
          // Send completion frame
          const completeFrame = new Uint8Array(33);
          completeFrame[0] = 0x03;
          const hashBytes = await computeSha256Bytes(this.activeBuffer);
          completeFrame.set(hashBytes, 1);
          sendAckCb(completeFrame);
        }
      }

      this.notifyProgress(complete, hashMatch);
    } else if (type === 0x03) {
      // COMPLETION ACK FRAME
      if (this.isUploading) {
        this.isUploading = false;
        this.notifyProgress(true, true);
      }
    }
  }

  // Start uploading file over ChID 2
  public async startUpload(
    fileData: Uint8Array,
    sendChunkCb: (chunk: Uint8Array) => void,
    chunkSizeBytes: number = 65536
  ): Promise<void> {
    this.reset();
    this.isUploading = true;
    this.activeBuffer = fileData;
    this.expectedSize = fileData.byteLength;
    const hashBytes = await computeSha256Bytes(fileData);
    this.expectedHashHex = Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    this.startTime = performance.now();

    // 1. Send Meta Frame
    const metaFrame = new Uint8Array(37);
    metaFrame[0] = 0x01;
    const metaView = new DataView(metaFrame.buffer);
    metaView.setUint32(1, this.expectedSize, false);
    metaFrame.set(hashBytes, 5);
    sendChunkCb(metaFrame);

    // 2. Stream Data Chunks
    let offset = 0;
    while (offset < this.expectedSize) {
      if (this.isCancelled) break;

      const end = Math.min(offset + chunkSizeBytes, this.expectedSize);
      const slice = fileData.subarray(offset, end);

      const chunkFrame = new Uint8Array(5 + slice.byteLength);
      chunkFrame[0] = 0x02;
      const chunkView = new DataView(chunkFrame.buffer);
      chunkView.setUint32(1, offset, false);
      chunkFrame.set(slice, 5);

      sendChunkCb(chunkFrame);
      offset = end;

      // Yield briefly to avoid locking UI thread on huge uploads
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private notifyProgress(isComplete: boolean, hashMatch: boolean | null): void {
    if (!this.onProgressCb) return;

    const elapsedSec = (performance.now() - (this.startTime || performance.now())) / 1000;
    const speedKbps = elapsedSec > 0 ? this.receivedBytes / 1024 / elapsedSec : 0;
    const percentage = this.expectedSize > 0 ? Math.min(100, (this.receivedBytes / this.expectedSize) * 100) : 0;

    this.onProgressCb({
      bytesTransferred: this.receivedBytes,
      totalBytes: this.expectedSize,
      percentage,
      speedKbps,
      elapsedSeconds: elapsedSec,
      isComplete,
      hashMatch,
    });
  }
}
