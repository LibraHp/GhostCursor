import type { GhostBridge } from '../shared/protocol';
import { VIDEO_PRESETS, type VideoSettings } from '../shared/settings';
import { MAX_RELAY_BUFFER, MAX_RELAY_CHUNK, RELAY_MIME_TYPES } from '../shared/relay';

// One recorder per visitor allows late joins and slow clients to restart without
// resetting other viewers. Capture still uses a single selected-window track.
export class RelaySender {
  private recorder?: MediaRecorder;
  private generation = 0;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private mime: string;
  constructor(private api: GhostBridge, private id: string, private sessionId: string, private stream: MediaStream, private settings: VideoSettings, supported: string[], private onError: (text: string) => void) {
    this.mime = RELAY_MIME_TYPES.find(mime => supported.includes(mime) && MediaRecorder.isTypeSupported(mime)) || '';
    if (!this.mime) throw new Error('双方浏览器没有共同的视频编码格式，请使用新版 Edge 或 Chrome，或改用 WebRTC');
  }
  async start(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.closeRecorder(); clearTimeout(this.retry);
    const streamId = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    let sequence = 0, queued = 0;
    const startedAt = performance.now();
    let chain = Promise.resolve();
    try {
      const ready = await this.api.relayStart(this.id, this.sessionId, streamId, this.mime);
      if (this.stopped || generation !== this.generation) return;
      if (!ready) { this.resync(generation); return; }
      const recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime, videoBitsPerSecond: VIDEO_PRESETS[this.settings.preset].bitrate,
        // Supported Chromium versions bound the initial keyframe wait. Older
        // implementations ignore this optional recording hint.
        videoKeyFrameIntervalDuration: 500,
      } as MediaRecorderOptions);
      this.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!event.data.size || this.stopped || generation !== this.generation) return;
        queued += event.data.size;
        if (queued > MAX_RELAY_BUFFER) { this.resync(generation); return; }
        chain = chain.then(async () => {
          try {
            if (this.stopped || generation !== this.generation) return;
            const data = await event.data.arrayBuffer();
            // A container chunk can be split at arbitrary byte boundaries: MSE
            // reconstructs the byte stream in order, without dropping deltas.
            for (let offset = 0; offset < data.byteLength; offset += MAX_RELAY_CHUNK) {
              if (this.stopped || generation !== this.generation) return;
              const accepted = await this.api.relayChunk(this.id, this.sessionId, streamId, sequence++, data.slice(offset, offset + MAX_RELAY_CHUNK));
              if (!accepted) { this.resync(generation); return; }
            }
            if (performance.now() - startedAt > 10000) this.retries = 0;
          } finally { queued -= event.data.size; }
        }).catch(() => this.resync(generation));
      };
      recorder.onerror = () => { if (!this.stopped && generation === this.generation) this.fail('WebSocket 视频编码失败，请降低分辨率或改用 WebRTC'); };
      recorder.start(100);
    } catch (e) { if (!this.stopped && generation === this.generation) this.fail(`WebSocket 视频启动失败：${(e as Error).message}`); }
  }
  reconfigure(value: VideoSettings) { this.settings = value; this.retries = 0; void this.start(); }
  private resync(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    this.generation++; this.closeRecorder(); clearTimeout(this.retry);
    if (++this.retries > 8) { this.fail('视频传输持续拥塞，请降低画质和帧率后重新加入'); return; }
    this.retry = setTimeout(() => { void this.start(); }, 1000);
  }
  private fail(text: string) { this.stop(); this.onError(text); void this.api.disconnect(this.id, text).catch(() => {}); }
  private closeRecorder() {
    const recorder = this.recorder; this.recorder = undefined;
    if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); }
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.retry); this.closeRecorder(); }
}
