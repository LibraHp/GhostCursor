import { MAX_RELAY_BUFFER, validRelayMime } from '../shared/relay';

type Chunk = { sequence: number; data: ArrayBuffer };
// Feed encoded container bytes into the browser's normal video decoder. This
// works over ws:// too; WebCodecs would require a secure browser context.
export class RelayPlayer {
  private mediaSource: MediaSource;
  private buffer?: SourceBuffer;
  private url: string;
  private queue: Chunk[] = [];
  private queuedBytes = 0;
  private operation?: { kind: 'append'; chunk: Chunk } | { kind: 'remove' };
  private nextSequence = 0;
  private ackSequence = -1;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private video: HTMLVideoElement, mime: string, private ack: (sequence: number) => void, private onReady: () => void, private onError: (text: string) => void) {
    if (!validRelayMime(mime) || !window.MediaSource || !MediaSource.isTypeSupported(mime)) throw new Error('浏览器不支持该视频格式，请使用新版 Edge 或 Chrome，或改用 WebRTC');
    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    this.video.srcObject = null; this.video.src = this.url;
    this.video.addEventListener('loadeddata', this.loaded);
    this.video.addEventListener('error', this.error);
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.disposed) return;
      try {
        this.buffer = this.mediaSource.addSourceBuffer(mime);
        this.buffer.addEventListener('updateend', this.updated);
        this.buffer.addEventListener('error', this.error);
        this.pump();
      } catch { this.fail('浏览器无法初始化视频解码器，请换用新版 Edge 或 Chrome'); }
    }, { once: true });
  }
  private loaded = () => { if (!this.disposed) { this.onReady(); void this.video.play().catch(() => {}); } };
  private error = () => this.fail('WebSocket 视频解码失败，请降低分辨率后重新加入，或改用 WebRTC');
  append(sequence: number, data: ArrayBuffer) {
    if (this.disposed) return;
    if (sequence !== this.nextSequence++) { this.fail('视频分片顺序异常，请重新加入'); return; }
    this.queuedBytes += data.byteLength;
    if (this.queuedBytes > MAX_RELAY_BUFFER) { this.fail('视频解码积压，请降低画质后重新加入'); return; }
    this.queue.push({ sequence, data }); this.pump();
  }
  private updated = () => {
    if (this.disposed) return;
    const operation = this.operation; this.operation = undefined;
    if (operation?.kind === 'append') {
      this.queuedBytes -= operation.chunk.data.byteLength;
      this.ackSequence = operation.chunk.sequence;
      // ACKs are cumulative: acknowledge the latest appended fragment at
      // most every 100 ms, including the final fragment of an idle stream.
      if (this.ackTimer === undefined) this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined; if (!this.disposed) this.ack(this.ackSequence);
      }, 100);
    }
    try {
      const buffered = this.buffer?.buffered;
      if (buffered?.length) {
        const end = buffered.end(buffered.length - 1), start = buffered.start(buffered.length - 1);
        // Stay close to the live edge rather than accumulating TCP delay.
        if (end - this.video.currentTime > 1.2 || this.video.currentTime < start) this.video.currentTime = Math.max(start, end - 0.25);
        this.video.playbackRate = end - this.video.currentTime > 0.55 ? 1.05 : 1;
        if (this.video.paused) void this.video.play().catch(() => {});
      }
    } catch { /* Buffered ranges can change while a live seek is pending. */ }
    this.pump();
  };
  private pump() {
    const buffer = this.buffer;
    if (this.disposed || !buffer || buffer.updating || this.operation || this.mediaSource.readyState !== 'open') return;
    try {
      const buffered = buffer.buffered;
      if (buffered.length && this.video.currentTime - buffered.start(0) > 5) {
        this.operation = { kind: 'remove' }; buffer.remove(buffered.start(0), this.video.currentTime - 3); return;
      }
      const chunk = this.queue.shift(); if (!chunk) return;
      this.operation = { kind: 'append', chunk }; buffer.appendBuffer(chunk.data);
    } catch { this.fail('视频缓冲不可用，请降低画质后重新加入'); }
  }
  private fail(text: string) { if (!this.disposed) { this.dispose(); this.onError(text); } }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.queue = []; this.operation = undefined; this.queuedBytes = 0;
    clearTimeout(this.ackTimer); this.ackTimer = undefined;
    this.video.removeEventListener('loadeddata', this.loaded); this.video.removeEventListener('error', this.error);
    this.buffer?.removeEventListener('updateend', this.updated); this.buffer?.removeEventListener('error', this.error);
    try { if (this.buffer?.updating) this.buffer.abort(); } catch {}
    this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.playbackRate = 1;
    URL.revokeObjectURL(this.url);
  }
}
