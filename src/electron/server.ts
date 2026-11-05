import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { validSignal, validPointer, type Signal } from '../shared/protocol';
import { Session } from './session';
import { DEFAULT_CURSOR, DEFAULT_VIDEO, type Presentation } from '../shared/settings';
import { DEFAULT_NETWORK, rtcConfiguration, type NetworkSettings } from '../shared/network';
import { MAX_RELAY_CHUNK, packRelayChunk, validRelayMime } from '../shared/relay';
import { TokenBucket } from '../shared/rate-limit';

const colors = ['#2563eb', '#8b5cf6', '#e65580', '#059669', '#d97706', '#0891b2', '#6366f1', '#dc2626'];
export class SharingServer extends EventEmitter {
  private http?: Server; private wss?: WebSocketServer;
  private clients = new Map<string, WebSocket>();
  private presentation: Presentation = { video: DEFAULT_VIDEO, cursor: DEFAULT_CURSOR };
  private network: NetworkSettings = DEFAULT_NETWORK;
  private relay = new Map<string, { streamId: number; sequence: number; ack: number; bytes: number; pending: Map<number, { bytes: number; sentAt: number }> }>();
  constructor(private session: Session, private webRoot: string) { super(); }
  async start(port: number) {
    const server = createServer(async (req, res) => {
      const headers = {
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        if (path !== '/' && !path.startsWith('/assets/')) { res.writeHead(404, headers).end(); return; }
        const file = resolve(this.webRoot, path === '/' ? 'index.html' : '.' + decodeURIComponent(path));
        if (!file.startsWith(resolve(this.webRoot) + sep)) { res.writeHead(403, headers).end(); return; }
        const content = await readFile(file);
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
        res.writeHead(200, { ...headers, 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { res.writeHead(404, headers).end(); }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128_000, perMessageDeflate: false });
    this.http = server; this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || wss.clients.size >= 24) { socket.destroy(); return; }
      // Permit the configured public origin when FRP rewrites the upstream Host.
      const origins = [`http://${req.headers.host}`, `https://${req.headers.host}`, ...(this.network.publicUrl ? [this.network.publicUrl] : [])];
      if (!req.headers.origin || !origins.includes(req.headers.origin)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
      let id = ''; let alive = true; let lastReady = 0;
      const incoming = new TokenBucket(1200, 4800), messages = new TokenBucket(480, 1440), acknowledgements = new TokenBucket(120, 480);
      const timeout = setTimeout(() => ws.close(4001, '请提供加入凭据'), 5000);
      const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 10_000);
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('message', (raw, isBinary) => {
        try {
          if (isBinary) { ws.close(4002, '访客不能上传视频'); return; }
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!incoming.take()) { ws.close(4008, '消息持续过于频繁'); return; }
          const data = JSON.parse(raw.toString());
          // Video acknowledgements have their own budget; legacy viewers may
          // acknowledge every fragment. Excess cumulative ACKs can be skipped.
          const videoAck = !!id && this.network.transport === 'websocket' && data.type === 'relay-ack';
          if (videoAck) { if (!acknowledgements.take()) return; }
          else if (!messages.take()) { ws.close(4008, '操作消息持续过于频繁'); return; }
          if (!id) {
            const token = typeof data.token === 'string' ? data.token : '';
            const expected = this.session.token;
            if (data.type !== 'join' || !this.session.active || !expected || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) { ws.close(4003, '加入链接无效或已失效'); return; }
            if (this.clients.size >= 8) { ws.close(4008, '当前会话最多支持 8 位访客'); return; }
            clearTimeout(timeout); id = randomUUID();
            const name = typeof data.name === 'string' ? data.name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 24) : '';
            const used = new Set([...this.session.visitors.values()].map(v => v.color));
            const color = colors.find(c => !used.has(c)) || colors[0];
            const visitor = { id, name: name || `访客 ${this.clients.size + 1}`, color, connectedAt: Date.now() };
            this.clients.set(id, ws); this.session.visitors.set(id, visitor);
            this.send(id, { type: 'welcome', id, name: visitor.name, color, sessionId: this.session.id, transport: this.network.transport, ...(this.network.transport === 'webrtc' ? { rtc: rtcConfiguration(this.network) } : {}) });
            this.send(id, { type: 'presentation', ...this.presentation });
            this.emit('join', visitor); this.broadcastState();
          } else if (this.network.transport === 'websocket' && data.type === 'relay-ready') {
            if (data.sessionId !== this.session.id || !Array.isArray(data.mimeTypes) || !data.mimeTypes.length || data.mimeTypes.length > 4 || !data.mimeTypes.every(validRelayMime)) { ws.close(4002, '无效视频格式'); return; }
            if (Date.now() - lastReady < 1000) return;
            lastReady = Date.now(); this.emit('relay-ready', id, data.mimeTypes);
          } else if (this.network.transport === 'websocket' && data.type === 'relay-ack') {
            const relay = this.relay.get(id);
            if (!relay || data.sessionId !== this.session.id || data.streamId !== relay.streamId) return;
            if (!Number.isSafeInteger(data.sequence) || data.sequence <= relay.ack || data.sequence > relay.sequence) return;
            relay.ack = data.sequence;
            for (const [sequence, pending] of relay.pending) if (sequence <= data.sequence) { relay.bytes -= pending.bytes; relay.pending.delete(sequence); }
          } else if (this.network.transport === 'websocket' && data.type === 'pointer' && validPointer(data.message)) {
            // Ignore input for an older video layout while a stream restarts.
            const relay = this.relay.get(id);
            if (relay && relay.streamId === data.streamId) this.emit('pointer', id, data.message);
          }
          else if (this.network.transport === 'webrtc' && validSignal(data)) this.emit('signal', id, data);
          else ws.close(4002, '无效信令');
        } catch { ws.close(4002, '无效消息'); }
      });
      ws.on('close', () => {
        clearTimeout(timeout); clearInterval(heartbeat);
        this.relay.delete(id);
        if (id && this.clients.delete(id)) { this.session.remove(id); this.emit('leave', id); this.broadcastState(); }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', error => this.emit('failure', error));
  }
  send(id: string, message: object) { const ws = this.clients.get(id); if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 4 * 1024 * 1024) ws.terminate(); else ws.send(JSON.stringify(message)); } }
  relayStart(id: string, sessionId: string, streamId: number, mime: string): boolean {
    const ws = this.clients.get(id);
    if (!this.session.active || sessionId !== this.session.id || this.network.transport !== 'websocket' || ws?.readyState !== WebSocket.OPEN || !validRelayMime(mime) || !Number.isInteger(streamId) || streamId <= 0 || streamId > 0xffffffff || ws.bufferedAmount > 512 * 1024) return false;
    this.emit('relay-reset', id);
    this.relay.set(id, { streamId, sequence: -1, ack: -1, bytes: 0, pending: new Map() });
    this.send(id, { type: 'relay-reset', sessionId, streamId, mime }); return true;
  }
  relayChunk(id: string, sessionId: string, streamId: number, sequence: number, data: ArrayBuffer): boolean {
    const ws = this.clients.get(id), relay = this.relay.get(id);
    if (!this.session.active || sessionId !== this.session.id || this.network.transport !== 'websocket' || !relay || relay.streamId !== streamId || ws?.readyState !== WebSocket.OPEN || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff || sequence !== relay.sequence + 1 || !(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > MAX_RELAY_CHUNK) return false;
    const oldest = relay.pending.values().next().value;
    if (ws.bufferedAmount > 512 * 1024 || relay.bytes + data.byteLength > 4 * 1024 * 1024 || (oldest && Date.now() - oldest.sentAt > 4000)) {
      this.relay.delete(id); this.emit('relay-reset', id); return false;
    }
    relay.sequence = sequence; relay.bytes += data.byteLength;
    relay.pending.set(sequence, { bytes: data.byteLength, sentAt: Date.now() });
    ws.send(packRelayChunk(streamId, sequence, data), { binary: true }); return true;
  }
  signal(id: string, signal: Signal) { if (validSignal(signal)) this.send(id, signal); }
  disconnect(id: string, reason = '主持人已断开你的连接') { this.clients.get(id)?.close(4000, Buffer.from(reason).subarray(0, 120).toString('utf8').replace(/\uFFFD$/u, '')); }
  setNetwork(value: NetworkSettings) { this.network = value; }
  setPresentation(value: Presentation) {
    this.presentation = value;
    for (const id of this.clients.keys()) this.send(id, { type: 'presentation', ...value });
  }
  cursor(id: string, position: { x?: number; y?: number; pointerType?: string; visible: boolean }) {
    if (!this.session.enabled || this.session.controller !== id) return;
    const visitor = this.session.visitors.get(id); if (!visitor) return;
    for (const client of this.clients.keys()) this.send(client, { type: 'controller-cursor', id, name: visitor.name, color: visitor.color, ...position });
  }
  broadcastState() {
    for (const id of this.clients.keys()) this.send(id, { type: 'control', enabled: this.session.enabled, controller: this.session.controller, epoch: this.session.epoch, reason: this.session.controlReason });
  }
  async stop() {
    for (const ws of this.wss?.clients || []) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ended' })); ws.terminate(); }
    this.clients.clear(); this.relay.clear(); this.wss?.close(); this.wss = undefined;
    const server = this.http; this.http = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
