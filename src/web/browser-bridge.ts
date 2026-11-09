import type { BrowserHostState, VisitorPointer } from '../shared/browser-service';
import { encodeHostFrame } from '../shared/browser-service';
import type { GhostBridge, HostEvent, HostState, Signal, WindowSource } from '../shared/protocol';
import type { CursorSettings, VideoSettings } from '../shared/settings';
import type { AutoStunResult, NetworkSettings } from '../shared/network';
import type { GraphicsMode } from '../shared/graphics';

export class BrowserBridge implements GhostBridge {
  private ws?: WebSocket;
  private serial = 0;
  private latest?: BrowserHostState;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private states = new Set<(state: BrowserHostState) => void>();
  private events = new Set<(event: HostEvent) => void>();
  private pointers = new Set<(event: VisitorPointer) => void>();
  private closes = new Set<(reason: string) => void>();
  async connect(key: string): Promise<BrowserHostState> {
    this.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/host-ws`);
      this.ws = ws;
      let ready = false;
      const timeout = setTimeout(() => { ws.close(); reject(new Error('主持人服务连接超时')); }, 10000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'host-auth', key }));
      ws.onmessage = event => {
        if (this.ws !== ws) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'host-ready') { clearTimeout(timeout); ready = true; this.accept(data.state); resolve(data.state); }
          else if (data.type === 'state') this.accept(data.state);
          else if (data.type === 'event') for (const listener of this.events) listener(data.event);
          else if (data.type === 'visitor-pointer') for (const listener of this.pointers) listener({ id: data.id, message: data.message });
          else if (data.type === 'result') {
            const request = this.pending.get(data.id); if (!request) return;
            clearTimeout(request.timer); this.pending.delete(data.id);
            data.error ? request.reject(new Error(data.error)) : request.resolve(data.value);
          }
        } catch { ws.close(4002, '服务返回了无效消息'); }
      };
      ws.onerror = () => { if (!ready) { clearTimeout(timeout); reject(new Error('无法连接主持人服务')); } };
      ws.onclose = event => {
        clearTimeout(timeout);
        if (this.ws !== ws) return;
        this.ws = undefined; this.latest = undefined;
        const reason = event.reason || '主持人连接已断开，共享已结束';
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } this.pending.clear();
        if (!ready) reject(new Error(reason));
        for (const listener of this.closes) listener(reason);
      };
    });
  }
  private accept(value: BrowserHostState) { this.latest = value; for (const listener of this.states) listener(value); }
  private send(method: string, args: object = {}) {
    if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 4 * 1024 * 1024) this.ws.send(JSON.stringify({ type: 'call', method, args }));
  }
  call<T = void>(method: string, args: object = {}): Promise<T> {
    return this.request(id => JSON.stringify({ type: 'call', id, method, args }));
  }
  private request<T>(encode: (id: number) => string | ArrayBuffer): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) { reject(new Error('主持人尚未连接')); return; }
      if (this.pending.size >= 64 || this.ws.bufferedAmount > 4 * 1024 * 1024) { reject(new Error('上传连接积压，请降低画质')); return; }
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('服务响应超时')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(encode(id)); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  state(): Promise<BrowserHostState> { return this.latest ? Promise.resolve(this.latest) : this.call('state'); }
  onState(callback: (state: HostState) => void) { this.states.add(callback); return () => { this.states.delete(callback); }; }
  onBrowserState(callback: (state: BrowserHostState) => void) { this.states.add(callback); return () => { this.states.delete(callback); }; }
  onEvent(callback: (event: HostEvent) => void) { this.events.add(callback); return () => { this.events.delete(callback); }; }
  onPointer(callback: (event: VisitorPointer) => void) { this.pointers.add(callback); return () => { this.pointers.delete(callback); }; }
  onClose(callback: (reason: string) => void) { this.closes.add(callback); return () => { this.closes.delete(callback); }; }
  sources(): Promise<WindowSource[]> { return Promise.resolve([]); }
  start(): Promise<HostState> { return Promise.reject(new Error('请在浏览器中点击共享窗口')); }
  begin(name: string, sourceId: string | null): Promise<BrowserHostState> { return this.call('start', { name, sourceId }); }
  stop() { return this.call('stop'); }
  selectController(visitor: string | null) { return this.call('select-controller', { visitor }); }
  toggleControl() { return this.call('toggle-control'); }
  setVideo(value: VideoSettings) { return this.call('set-video', { value }); }
  setCursor(value: CursorSettings) { return this.call('set-cursor', { value }); }
  setNetwork(value: NetworkSettings) { return this.call('set-network', { value }); }
  refreshStun(): Promise<AutoStunResult> { return this.call('refresh-stun'); }
  setHotkey(): Promise<void> { return Promise.reject(new Error('浏览器快捷键在页面获得焦点时有效；全局收回快捷键由本机辅助程序提供')); }
  recordHotkey(): Promise<void> { return Promise.resolve(); }
  setGraphics(_mode: GraphicsMode): Promise<void> { return Promise.reject(new Error('图形渲染由浏览器管理')); }
  requestPermissions(): Promise<void> { return Promise.reject(new Error('请在本机系统设置中管理辅助程序权限')); }
  restart(): Promise<void> { location.reload(); return Promise.resolve(); }
  copyGraphicsDiagnostics(): Promise<void> { return this.copy(navigator.userAgent); }
  diagnostics(): Promise<{ successfulInputs: number; visibleMarkers: number; available: boolean; reason: string }> { return Promise.reject(new Error('诊断仅在本机辅助程序提供')); }
  disconnect(visitor: string) { return this.call('disconnect', { visitor }); }
  signal(visitor: string, signal: Signal) { this.send('signal', { visitor, signal }); }
  pointer(visitor: string, message: unknown) { this.send('pointer', { visitor, message }); }
  relayStart(visitor: string, sessionId: string, streamId: number, mime: string): Promise<boolean> { return this.call('relay-start', { visitor, sessionId, streamId, mime }); }
  relayChunk(visitor: string, sessionId: string, streamId: number, sequence: number, data: ArrayBuffer): Promise<boolean> {
    return this.request(requestId => encodeHostFrame({ requestId, visitor, sessionId, streamId, sequence }, data));
  }
  frameSize(width: number, height: number) { this.send('frame-size', { width, height }); }
  async copy(text: string) { await navigator.clipboard.writeText(text); }
  close() {
    const ws = this.ws; this.ws = undefined; this.latest = undefined;
    ws?.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('主持人连接已关闭')); } this.pending.clear();
  }
  minimize() {}
}
