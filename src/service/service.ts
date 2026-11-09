import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SharingServer } from '../electron/server';
import { Session } from '../electron/session';
import { ControlCoordinator } from '../electron/control';
import { AutoStun } from '../electron/auto-stun';
import { TokenBucket } from '../shared/rate-limit';
import { DEFAULT_NETWORK, publicOrigin, rtcConfiguration, validNetwork, type NetworkSettings, type AutoStunResult } from '../shared/network';
import { DEFAULT_CURSOR, DEFAULT_VIDEO, validCursor, validVideo } from '../shared/settings';
import { validSignal, type PointerMessage } from '../shared/protocol';
import { decodeHostFrame, type BrowserHostState } from '../shared/browser-service';
import { MAX_RELAY_CHUNK } from '../shared/relay';

function equalSecret(value: unknown, expected: string): boolean {
  return typeof value === 'string' && !!expected && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
const message = (e: unknown) => e instanceof Error ? e.message : '请求处理失败';
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效请求');
  return value as Record<string, any>;
}
export interface WebServiceOptions { webRoot: string; hostKey: string; publicUrl?: string; bind?: string; port?: number }

// One broadcaster per deployment, matching the desktop session model. A host
// credential never doubles as a viewer credential or a companion pairing code.
export class WebService {
  readonly session = new Session();
  readonly sharing: SharingServer;
  private hostWss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_CHUNK + 516, perMessageDeflate: false });
  private helperWss = new WebSocketServer({ noServer: true, maxPayload: 128_000, perMessageDeflate: false });
  private host?: WebSocket;
  private helper?: WebSocket;
  private hostOrigin = '';
  private pairing?: { code: string; expiresAt: number };
  private helperPlatform = '';
  private bound = false;
  private helperReason = '未连接本机辅助程序：位置显示在网页预览中，系统控制不可用';
  private sourceId = '';
  private sourceName = '';
  private frame = { width: 0, height: 0 };
  private video = { ...DEFAULT_VIDEO };
  private cursor = { ...DEFAULT_CURSOR };
  private network: NetworkSettings;
  private autoStun = new AutoStun(join(tmpdir(), 'ghostcursor-web-stun-cache.json'));
  private autoStunResult?: AutoStunResult;
  private serial = 0;
  private requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private moves = new Map<string, { payload: object; message: PointerMessage; at: number }>();
  private rates = new Map<string, TokenBucket>();
  private controls: ControlCoordinator;
  private ticker: NodeJS.Timeout;
  private ending = false;
  constructor(private options: WebServiceOptions) {
    if (options.hostKey.length < 24) throw new Error('GHOSTCURSOR_HOST_KEY 至少需要 24 个字符');
    const publicUrl = options.publicUrl ? publicOrigin(options.publicUrl) : '';
    options.publicUrl = publicUrl;
    this.network = { ...DEFAULT_NETWORK, mappedUdp: { ...DEFAULT_NETWORK.mappedUdp }, publicUrl };
    this.sharing = new SharingServer(this.session, options.webRoot);
    this.controls = new ControlCoordinator(this.session, { request: (type, payload) => this.nativeRequest(type, payload), send: (type, payload) => this.nativeSend(type, payload) }, () => { this.sharing.broadcastState(); this.publish(); });
    this.sharing.setNetwork(this.network);
    this.sharing.on('join', visitor => { this.event({ type: 'visitor-joined', visitor }); this.publish(); });
    this.sharing.on('leave', id => {
      this.moves.delete(id); this.rates.delete(id); this.nativeSend('remove', { visitor: id });
      if (!this.session.controller) this.controls.synchronize();
      this.event({ type: 'visitor-left', id }); this.publish();
    });
    this.sharing.on('signal', (id, signal) => this.event({ type: 'signal', id, signal }));
    this.sharing.on('relay-ready', (id, mimeTypes) => this.event({ type: 'relay-ready', id, mimeTypes }));
    this.sharing.on('pointer', (id, value) => this.pointer(id, value));
    this.sharing.on('relay-reset', id => this.pointer(id, { type: 'leave', sessionId: this.session.id, epoch: this.session.epoch }));
    this.ticker = setInterval(() => {
      for (const [id, move] of this.moves) {
        this.moves.delete(id);
        if (Date.now() - move.at < 200) this.deliverPointer(id, move.message, move.payload);
      }
    }, 16); this.ticker.unref();
    this.hostWss.on('connection', ws => this.hostConnection(ws));
    this.helperWss.on('connection', ws => this.helperConnection(ws));
  }
  get state(): BrowserHostState {
    const address = this.sharing.address;
    const origin = this.options.publicUrl || this.hostOrigin;
    return { platform: 'browser', sharing: this.session.active, sessionId: this.session.id, visitors: [...this.session.visitors.values()],
      controller: this.session.controller, controlEnabled: this.session.enabled, controlPending: this.controls.pending, controlReason: this.session.controlReason,
      epoch: this.session.epoch, links: this.session.active && origin ? [`${origin}/#${this.session.token}`] : [],
      port: typeof address === 'object' && address ? address.port : this.options.port || 3210,
      sourceName: this.sourceName, video: this.video, cursor: this.cursor, hotkey: 'Ctrl+Alt+F8', network: this.network, autoStunResult: this.autoStunResult,
      graphics: { mode: 'auto', compatibility: false, restartRequired: false }, nativeReady: !!this.helper && this.bound, targetAvailable: this.bound,
      error: '', companion: { connected: !!this.helper, bound: this.bound, platform: this.helperPlatform, reason: this.helperReason },
      ...(this.network.transport === 'webrtc' ? { rtc: rtcConfiguration(this.network) } : {}),
    };
  }
  async listen() {
    await this.sharing.start(this.options.port ?? 3210, { host: this.options.bind, browserHost: true,
      request: (req, res) => {
        if (req.url !== '/healthz') return false;
        res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 200 : 405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'GET' ? '{"ok":true}' : undefined); return true;
      },
      upgrade: (req, socket, head) => {
        if (!['/host-ws', '/companion-ws'].includes(req.url || '')) return false;
        const companion = req.url === '/companion-ws', wss = companion ? this.helperWss : this.hostWss;
        const origins = this.options.publicUrl ? [this.options.publicUrl] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        // The native companion connects outbound; browser connections require
        // same-origin validation in addition to the independent host secret.
        if (wss.clients.size >= 4 || (companion ? !!req.headers.origin : !origins.includes(req.headers.origin || ''))) { socket.destroy(); return true; }
        wss.handleUpgrade(req, socket, head, ws => { if (!companion) (ws as WebSocket & { origin?: string }).origin = req.headers.origin; wss.emit('connection', ws); });
        return true;
      },
    });
    return this.sharing.address;
  }
  private send(ws: WebSocket | undefined, value: object): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.terminate(); return false; }
    ws.send(JSON.stringify(value)); return true;
  }
  private event(event: object) { this.send(this.host, { type: 'event', event }); }
  private publish() { this.send(this.host, { type: 'state', state: this.state }); }
  private heartbeat(ws: WebSocket) {
    let alive = true;
    const timeout = setTimeout(() => { if (ws !== this.host && ws !== this.helper) ws.close(4003, '连接认证超时'); }, 5000);
    const interval = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 10_000);
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => ws.terminate());
    ws.once('close', () => { clearTimeout(timeout); clearInterval(interval); });
  }
  private hostConnection(ws: WebSocket) {
    this.heartbeat(ws);
    const calls = new TokenBucket(480, 1440), bytes = new TokenBucket(16 * 1024 * 1024, 32 * 1024 * 1024);
    let chain = Promise.resolve(), queued = 0, queuedBytes = 0;
    ws.on('message', (raw: RawData, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const length = Array.isArray(raw) ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0) : raw.byteLength;
      if (!bytes.consume(length) || (!binary && !calls.take()) || queued >= 64 || queuedBytes + length > 8 * 1024 * 1024) { ws.close(4008, '主持人连接积压，请降低画质'); return; }
      queued++; queuedBytes += length;
      chain = chain.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws !== this.host) {
          const data = !binary ? record(JSON.parse(raw.toString())) : {};
          if (data.type !== 'host-auth' || !equalSecret(data.key, this.options.hostKey)) { ws.close(4003, '主持人密钥无效'); return; }
          if (this.host || this.ending) { ws.close(4009, '已有主持人连接，请先退出其他主持人页面'); return; }
          this.host = ws; this.hostOrigin = (ws as WebSocket & { origin?: string }).origin || '';
          this.send(ws, { type: 'host-ready', state: this.state }); return;
        }
        if (binary) {
          const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          const packet = decodeHostFrame(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
          if (!packet || !Number.isSafeInteger(packet.metadata.requestId) || (packet.metadata.requestId as number) <= 0 || typeof packet.metadata.visitor !== 'string') { ws.close(4002, '无效视频分片'); return; }
          const m = packet.metadata;
          const value = this.sharing.relayChunk(m.visitor as string, m.sessionId as string, m.streamId as number, m.sequence as number, packet.data);
          this.send(ws, { type: 'result', id: m.requestId, value }); return;
        }
        const data = record(JSON.parse(raw.toString()));
        if (data.type !== 'call' || typeof data.method !== 'string') { ws.close(4002, '无效主持人请求'); return; }
        if (data.id !== undefined && (!Number.isSafeInteger(data.id) || data.id <= 0)) { ws.close(4002, '无效请求编号'); return; }
        try {
          const value = await this.call(data.method, data.args, ws);
          if (data.id !== undefined) this.send(ws, { type: 'result', id: data.id, value });
        } catch (e) { if (data.id !== undefined) this.send(ws, { type: 'result', id: data.id, error: message(e) }); }
      }).catch(() => ws.close(4002, '无效主持人消息')).finally(() => { queued--; queuedBytes -= length; });
    });
    ws.once('close', () => {
      if (ws !== this.host) return;
      this.host = undefined; this.pairing = undefined;
      this.stopSharing(); this.helper?.close(4000, '主持人已离线');
      this.hostOrigin = '';
    });
  }
  private async call(method: string, input: unknown, owner: WebSocket): Promise<unknown> {
    const args = input === undefined ? {} : record(input);
    switch (method) {
      case 'state': return this.state;
      case 'start': {
        if (this.session.active) throw new Error('请先停止当前共享');
        if (typeof args.name !== 'string' || args.name.length > 512 || (args.sourceId !== null && (typeof args.sourceId !== 'string' || !/^window:\d+:0$/.test(args.sourceId)))) throw new Error('无效捕获窗口');
        if (this.network.transport === 'webrtc' && this.network.autoStun && !this.network.relayOnly) {
          this.autoStunResult = await this.autoStun.resolve(); this.network = { ...this.network, stunUrls: [...this.autoStunResult.urls] };
        }
        if (owner !== this.host || owner.readyState !== WebSocket.OPEN) throw new Error('主持人已断开');
        this.sourceId = args.sourceId || ''; this.sourceName = args.name.trim() || '浏览器选择的窗口';
        this.session.begin(); this.sharing.setNetwork(this.network); this.sharing.setPresentation({ video: this.video, cursor: this.cursor });
        void this.bindHelper().then(() => this.publish()); this.publish(); return this.state;
      }
      case 'stop': this.stopSharing(); return;
      case 'set-video':
        if (!validVideo(args.value)) throw new Error('无效画质设置');
        this.video = { ...args.value }; this.sharing.setPresentation({ video: this.video, cursor: this.cursor }); this.publish(); return;
      case 'set-cursor':
        if (!validCursor(args.value)) throw new Error('无效鼠标样式');
        if (this.helper && this.bound) await this.nativeRequest('appearance', args.value);
        this.cursor = { ...args.value }; this.sharing.setPresentation({ video: this.video, cursor: this.cursor }); this.publish(); return;
      case 'set-network': {
        if (this.session.active) throw new Error('请先停止共享');
        if (!validNetwork(args.value) || args.value.transport === 'webrtc-mapped') throw new Error('浏览器支持 WebSocket 或普通 WebRTC；无法固定浏览器 UDP 端口');
        this.network = { ...args.value, mappedUdp: { ...DEFAULT_NETWORK.mappedUdp }, publicUrl: this.options.publicUrl || '' };
        this.sharing.setNetwork(this.network); this.publish(); return;
      }
      case 'refresh-stun':
        if (this.session.active || this.network.transport !== 'webrtc' || !this.network.autoStun || this.network.relayOnly) throw new Error('请先停止共享并保存普通 WebRTC 自动 STUN 设置');
        this.autoStunResult = await this.autoStun.resolve(true); this.network = { ...this.network, stunUrls: [...this.autoStunResult.urls] }; this.sharing.setNetwork(this.network); this.publish(); return this.autoStunResult;
      case 'signal':
        if (typeof args.visitor === 'string' && this.session.visitors.has(args.visitor) && validSignal(args.signal) && this.network.transport === 'webrtc') this.sharing.signal(args.visitor, args.signal);
        return;
      case 'relay-start': return this.sharing.relayStart(args.visitor, args.sessionId, args.streamId, args.mime);
      case 'pointer': if (typeof args.visitor === 'string') this.pointer(args.visitor, args.message); return;
      case 'frame-size':
        if (this.session.active && Number.isInteger(args.width) && Number.isInteger(args.height) && args.width > 0 && args.height > 0 && args.width <= 16384 && args.height <= 16384) { this.frame = { width: args.width, height: args.height }; this.nativeSend('frame', this.frame); }
        return;
      case 'disconnect':
        if (typeof args.visitor === 'string') this.sharing.disconnect(args.visitor); return;
      case 'select-controller':
        if (!this.bound) throw new Error('请先连接并绑定本机辅助程序');
        if (args.visitor !== null && typeof args.visitor !== 'string') throw new Error('无效控制者');
        this.session.select(args.visitor); this.moves.clear(); this.controls.synchronize(); return;
      case 'toggle-control':
        if (!this.helper || !this.bound) throw new Error('系统鼠标控制需要已绑定窗口的本机辅助程序');
        this.moves.clear(); await this.controls.toggle(); return;
      case 'pair-companion':
        if (this.helper) throw new Error('辅助程序已连接，请先在本机退出辅助程序');
        this.pairing = { code: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 120_000 }; return this.pairing;
      case 'disconnect-companion': this.helper?.close(4000, '主持人已断开辅助程序'); this.pairing = undefined; return;
      default: throw new Error('不支持的操作');
    }
  }
  private pointer(id: string, value: unknown) {
    const accepted = this.session.accept(id, value); if (!accepted) return;
    let rate = this.rates.get(id);
    if (!rate) { rate = new TokenBucket(120, 360); this.rates.set(id, rate); }
    const m = accepted.message;
    if (!['up', 'release', 'leave', 'touch-end'].includes(m.type) && !rate.take()) return;
    const visitor = this.session.visitors.get(id)!;
    const { type, ...coordinates } = m;
    const payload = { visitor: id, name: visitor.name, color: visitor.color, ...coordinates, action: type, inject: accepted.inject && this.bound, sentAt: Date.now() };
    if (type === 'pointer') this.moves.set(id, { payload, message: m, at: Date.now() });
    else { this.moves.delete(id); this.deliverPointer(id, m, payload); }
  }
  private deliverPointer(id: string, m: PointerMessage, payload: object) {
    this.send(this.host, { type: 'visitor-pointer', id, message: m });
    if (this.bound) this.nativeSend('pointer', payload);
    this.sharing.cursor(id, { x: m.x, y: m.y, pointerType: m.pointerType, visible: !['leave', 'release', 'touch-end'].includes(m.type) });
  }
  private stopSharing() {
    this.session.end(); this.moves.clear(); this.rates.clear(); this.bound = false; this.frame = { width: 0, height: 0 };
    for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error('共享已停止')); } this.requests.clear();
    this.controls.synchronize(); this.nativeSend('clear'); this.sharing.endSession(); this.sourceId = ''; this.sourceName = ''; this.publish();
  }
  private helperConnection(ws: WebSocket) {
    this.heartbeat(ws);
    const limit = new TokenBucket(240, 480);
    ws.on('message', (raw, binary) => {
      if (binary || !limit.take()) { ws.close(4002, '无效辅助程序消息'); return; }
      try {
        const data = record(JSON.parse(raw.toString()));
        if (ws !== this.helper) {
          if (data.type !== 'companion-auth' || !this.host || this.helper || !this.pairing || this.pairing.expiresAt < Date.now() || !equalSecret(data.code, this.pairing.code) || !['win32', 'darwin'].includes(data.platform)) { ws.close(4003, '配对码无效或已过期'); return; }
          this.pairing = undefined; this.helper = ws; this.helperPlatform = data.platform;
          this.helperReason = '本机辅助程序已连接，等待绑定浏览器共享窗口';
          this.send(ws, { type: 'companion-ready', serverTime: Date.now() });
          void this.bindHelper().then(() => this.publish()); return;
        }
        if (data.type === 'native-result' && Number.isSafeInteger(data.id)) {
          const request = this.requests.get(data.id); if (!request) return;
          this.requests.delete(data.id); clearTimeout(request.timer);
          if (data.error) request.reject(new Error(String(data.error).slice(0, 300))); else request.resolve(record(data.value));
        } else if (data.type === 'native-status') {
          const status = record(data.value);
          if (Number.isSafeInteger(status.epoch) && status.enabled === false) this.controls.nativeRevoked(status.epoch, typeof status.reason === 'string' ? status.reason : '系统已停止控制');
          if (this.session.active && this.bound && status.available === false && this.session.enabled) this.controls.revoke(typeof status.reason === 'string' ? status.reason : '共享窗口不可用');
          this.event({ type: 'native-status', available: !!status.available, reason: typeof status.reason === 'string' ? status.reason : '' });
          if (status.closed && this.session.active) this.stopSharing();
        } else if (data.type === 'local-revoke') this.controls.revoke('本机快捷键已收回控制');
        else { ws.close(4002, '无效辅助程序消息'); }
      } catch { ws.close(4002, '无效辅助程序消息'); }
    });
    ws.once('close', () => {
      if (ws !== this.helper) return;
      this.helper = undefined; this.bound = false; this.helperPlatform = '';
      for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error('本机辅助程序已断开')); } this.requests.clear();
      this.helperReason = '辅助程序已断开，已收回控制；浏览器共享可继续观看';
      this.moves.clear(); this.controls.revoke('本机辅助程序已断开'); this.publish();
    });
  }
  private nativeSend(type: string, payload: object = {}) { this.send(this.helper, { type: 'native-send', method: type, payload }); }
  private nativeRequest(method: string, payload: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.helper) { reject(new Error('本机辅助程序未连接')); return; }
      const id = ++this.serial;
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('本机辅助程序响应超时')); }, method === 'target' ? 60000 : 8000);
      this.requests.set(id, { resolve, reject, timer });
      if (!this.send(this.helper, { type: 'native-request', id, method, payload })) { clearTimeout(timer); this.requests.delete(id); reject(new Error('本机辅助程序连接不可用')); }
    });
  }
  private async bindHelper() {
    this.bound = false;
    if (!this.helper || !this.session.active) return;
    const helper = this.helper, session = this.session.id, source = this.sourceId;
    if (!source) { this.helperReason = '浏览器未提供可验证的原生窗口编号；共享观看和网页标记可用，原生标记与控制保持关闭'; this.nativeSend('clear'); return; }
    this.helperReason = '正在验证共享窗口，请在本机辅助程序终端确认窗口绑定';
    try {
      const result = await this.nativeRequest('windows');
      if (!Array.isArray(result.windows) || !result.windows.some((w: any) => w.id === source)) throw new Error('辅助程序未找到浏览器共享的同一个窗口；请确认在同一台电脑运行');
      if (helper !== this.helper || session !== this.session.id) return;
      await this.nativeRequest('target', { hwnd: source.split(':')[1] });
      if (helper !== this.helper || session !== this.session.id) return;
      await this.nativeRequest('appearance', this.cursor);
      if (helper !== this.helper || session !== this.session.id) return;
      this.bound = true; this.helperReason = '本机辅助程序已绑定共享窗口，选择控制者后仍需明确开启控制';
      if (this.frame.width) this.nativeSend('frame', this.frame);
    } catch (e) { if (helper === this.helper && session === this.session.id) { this.helperReason = message(e); this.nativeSend('clear'); } }
  }
  async close() {
    this.ending = true; clearInterval(this.ticker); this.stopSharing();
    for (const ws of [...this.hostWss.clients, ...this.helperWss.clients]) ws.terminate();
    this.hostWss.close(); this.helperWss.close(); await this.sharing.stop();
  }
}
