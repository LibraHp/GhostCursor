import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { validSignal, type Signal } from '../shared/protocol';
import { Session } from './session';

const colors = ['#2563eb', '#8b5cf6', '#e65580', '#059669', '#d97706', '#0891b2', '#6366f1', '#dc2626'];
export class SharingServer extends EventEmitter {
  private http?: Server; private wss?: WebSocketServer;
  private clients = new Map<string, WebSocket>();
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
      // Browser connections must originate from this exact HTTP service.
      if (req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
      let id = ''; let alive = true; let count = 0; let since = Date.now();
      const timeout = setTimeout(() => ws.close(4001, '请提供加入凭据'), 5000);
      const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 10_000);
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('message', raw => {
        try {
          if (Date.now() - since > 1000) { since = Date.now(); count = 0; }
          if (++count > 120) { ws.close(4008, '消息过于频繁'); return; }
          const data = JSON.parse(raw.toString());
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
            this.send(id, { type: 'welcome', id, color, sessionId: this.session.id });
            this.emit('join', visitor); this.broadcastState();
          } else if (validSignal(data)) this.emit('signal', id, data);
          else ws.close(4002, '无效信令');
        } catch { ws.close(4002, '无效消息'); }
      });
      ws.on('close', () => {
        clearTimeout(timeout); clearInterval(heartbeat);
        if (id && this.clients.delete(id)) { this.session.remove(id); this.emit('leave', id); this.broadcastState(); }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', error => this.emit('failure', error));
  }
  send(id: string, message: object) { const ws = this.clients.get(id); if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 256_000) ws.terminate(); else ws.send(JSON.stringify(message)); } }
  signal(id: string, signal: Signal) { if (validSignal(signal)) this.send(id, signal); }
  disconnect(id: string) { this.clients.get(id)?.close(4000, '主持人已断开你的连接'); }
  broadcastState() {
    for (const id of this.clients.keys()) this.send(id, { type: 'control', enabled: this.session.enabled, controller: this.session.controller, epoch: this.session.epoch, reason: this.session.controlReason });
  }
  async stop() {
    for (const ws of this.wss?.clients || []) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ended' })); ws.terminate(); }
    this.clients.clear(); this.wss?.close(); this.wss = undefined;
    const server = this.http; this.http = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
