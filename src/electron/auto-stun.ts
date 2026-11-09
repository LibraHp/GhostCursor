import { createSocket } from 'node:dgram';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_NETWORK, type AutoStunResult } from '../shared/network';

const LIST_URL = 'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts_tcp.txt';
const MAX_LIST_BYTES = 256 * 1024;
const CACHE_AGE = 60 * 60 * 1000;
type Endpoint = { host: string; port: number; url: string };
function endpoint(line: string): Endpoint | null {
  const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):([0-9]{1,5})$/i.exec(line.trim());
  if (!match) return null;
  const port = Number(match[2]); if (port < 1 || port > 65535) return null;
  return { host: match[1], port, url: `stun:${match[1]}:${port}` };
}
// Chromium's regular STUN URLs use UDP. The TCP list alone does not prove
// compatibility, so only install entries which also answer UDP Binding here.
function respondsToUdp(server: Endpoint): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createSocket('udp4'), transaction = randomBytes(12);
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket.close(); } catch {} resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1000);
    socket.on('error', () => done(false));
    socket.on('message', data => {
      if (data.length < 20 || data.readUInt16BE(0) !== 0x0101 || data.readUInt32BE(4) !== 0x2112a442 || !data.subarray(8, 20).equals(transaction)) return;
      const length = data.readUInt16BE(2); if (length % 4 || length + 20 > data.length) return;
      for (let offset = 20; offset + 4 <= length + 20;) {
        const type = data.readUInt16BE(offset), size = data.readUInt16BE(offset + 2);
        if (offset + 4 + size > length + 20) return;
        if ((type === 0x0020 || type === 0x0001) && size >= 8) { done(true); return; }
        offset += 4 + Math.ceil(size / 4) * 4;
      }
    });
    socket.connect(server.port, server.host, () => {
      if (finished) { try { socket.close(); } catch {} return; }
      const request = Buffer.alloc(20); request.writeUInt16BE(1, 0); request.writeUInt32BE(0x2112a442, 4); transaction.copy(request, 8);
      socket.send(request, error => { if (error) done(false); });
    });
  });
}

export class AutoStun {
  private cached?: AutoStunResult;
  private loaded = false;
  private attemptedAt = 0;
  private pending?: Promise<AutoStunResult>;
  constructor(private cacheFile: string) {}
  resolve(force = false): Promise<AutoStunResult> {
    if (this.pending) return this.pending;
    const work = this.update(force).finally(() => { this.pending = undefined; });
    this.pending = work; return work;
  }
  private async update(force: boolean): Promise<AutoStunResult> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const file = await readFile(this.cacheFile, 'utf8');
        if (file.length <= 8192) {
          const saved = JSON.parse(file) as AutoStunResult;
          if (Array.isArray(saved.urls) && saved.urls.length > 0 && saved.urls.length <= 3 && saved.urls.every(url => typeof url === 'string' && url.startsWith('stun:') && endpoint(url.slice(5))) && Number.isFinite(saved.updatedAt) && saved.updatedAt > 0 && saved.updatedAt <= Date.now()) this.cached = { ...saved, source: 'cache', message: '使用已缓存的自动 STUN 地址' };
        }
      } catch {}
    }
    if (!force && this.cached && Date.now() - this.cached.updatedAt < CACHE_AGE) return this.cached;
    if (!force && Date.now() - this.attemptedAt < 60000) return this.fallback();
    this.attemptedAt = Date.now();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(LIST_URL, { signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('列表下载失败');
      const reader = response.body.getReader(); let bytes = 0, content = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > MAX_LIST_BYTES) { controller.abort(); throw new Error('列表过大'); }
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
      } finally { reader.releaseLock(); }
      clearTimeout(timeout);
      const unique = new Map<string, Endpoint>();
      for (const line of content.split(/\r?\n/)) { const server = endpoint(line); if (server) unique.set(server.url, server); }
      const candidates = [...unique.values()];
      for (let i = candidates.length - 1; i > 0; i--) { const j = randomInt(i + 1); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
      const urls: string[] = [];
      for (let i = 0; i < Math.min(12, candidates.length) && urls.length < 3; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const answers = await Promise.allSettled(batch.map(respondsToUdp));
        answers.forEach((answer, index) => { if (answer.status === 'fulfilled' && answer.value && urls.length < 3) urls.push(batch[index].url); });
      }
      if (!urls.length) throw new Error('没有兼容的 STUN 响应');
      const result: AutoStunResult = { urls, source: 'online', updatedAt: Date.now(), message: `已从在线列表自动配置 ${urls.length} 个 STUN 地址（本机 UDP 响应有效）` };
      this.cached = result;
      await writeFile(this.cacheFile, JSON.stringify(result)).catch(() => {});
      return result;
    } catch { return this.fallback(); }
    finally { clearTimeout(timeout); }
  }
  private fallback(): AutoStunResult {
    return this.cached ? { ...this.cached, source: 'cache', message: '在线更新未成功，使用已缓存的 STUN 地址' } : { urls: [...DEFAULT_NETWORK.stunUrls], source: 'fallback', updatedAt: 0, message: '未获取到兼容地址，使用默认 STUN；可稍后更新或手动配置' };
  }
}
