import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { NativeBridge } from '../electron/native';
import { validCursor } from '../shared/settings';
import { TokenBucket } from '../shared/rate-limit';

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('本机辅助程序仅支持 Windows / macOS');
const prompt = createInterface({ input: stdin, output: stdout });
const native = new NativeBridge();
let socket: WebSocket | undefined, ending = false, ready = false, target = '', serverOffset = 0, lastMessage = Date.now();
let bindingGeneration = 0;
let confirmedActivation = false;
let confirmation: AbortController | undefined;
const sourceList = new Map<string, string>();
const revoke = (reason: string) => {
  try { native.send('grant', { enabled: false, controller: '', epoch: 0 }); native.send('clear'); } catch {}
  target = ''; bindingGeneration++; console.log(reason);
};
function shutdown() {
  if (ending) return; ending = true;
  revoke('本机辅助程序已停止，输入与标记已清理。');
  socket?.close(); native.close(); prompt.close();
  const timeout = setTimeout(() => process.exit(0), 2200); timeout.unref();
}
function send(data: object) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 256_000) { socket.terminate(); return; }
  socket.send(JSON.stringify(data));
}
native.on('failure', () => { if (!ending) { console.error('原生组件已断开'); shutdown(); } });
native.on('status', value => send({ type: 'native-status', value }));
native.on('local-revoke', () => { confirmedActivation = false; bindingGeneration++; confirmation?.abort(); confirmation = undefined; console.log('已通过本机快捷键收回控制。'); send({ type: 'local-revoke' }); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);

async function run() {
  console.log('GhostCursor 本机辅助程序\n仅连接你信任的 GhostCursor 网站。共享观看无需本程序。\n配对后网站可以向此程序请求标记与控制；原生窗口会在本机单独确认，控制仍需主持人明确授权。');
  const address = (await prompt.question('网站地址（例如 https://share.example.com）：')).trim();
  const url = new URL(address);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('请使用 HTTPS 网站根地址；仅 localhost 可用 HTTP');
  const code = (await prompt.question('一次性配对码（请勿输入主持人密钥）：')).trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('配对码格式不正确');
  const answer = (await prompt.question(`允许连接 ${url.origin}？输入 yes 确认：`)).trim();
  if (answer !== 'yes') { shutdown(); return; }
  const executable = process.platform === 'win32' ? 'GhostCursor.Native.exe' : 'GhostCursor.Native';
  await native.launch(resolve(__dirname, '../native', executable));
  if (process.platform === 'darwin') await native.request('permissions', { prompt: true });
  await native.request('companion-hotkey');
  const endpoint = new URL('/companion-ws', url); endpoint.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(endpoint, { maxPayload: 128_000, perMessageDeflate: false }); socket = ws;
  ws.on('open', () => send({ type: 'companion-auth', code, platform: process.platform }));
  ws.on('ping', () => { lastMessage = Date.now(); });
  ws.on('error', () => { console.error('网站连接失败'); shutdown(); });
  ws.on('close', () => shutdown());
  const watchdog = setInterval(() => { if (Date.now() - lastMessage > 25000) { console.error('网站连接超时'); shutdown(); } }, 1000); watchdog.unref();
  ws.once('close', () => clearInterval(watchdog));
  const limit = new TokenBucket(400, 800);
  let chain = Promise.resolve(), queued = 0;
  ws.on('message', (raw, binary) => {
    lastMessage = Date.now();
    if (binary || !limit.take() || queued >= 64) { shutdown(); return; }
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch { shutdown(); return; }
    if (data?.type === 'companion-ready' && !ready && Number.isFinite(data.serverTime)) {
      ready = true; serverOffset = Date.now() - data.serverTime;
      console.log('已配对。Ctrl+Alt+F8 可在本机随时收回控制；退出本程序会清理标记与控制。'); return;
    }
    if (!ready || !['native-send', 'native-request'].includes(data?.type) || !data.payload || typeof data.payload !== 'object') { shutdown(); return; }
    // Revocations bypass pending local confirmation and always execute at once.
    if (data.type === 'native-send' && (data.method === 'clear' || (data.method === 'grant' && data.payload.enabled === false))) {
      bindingGeneration++;
      confirmedActivation = false;
      confirmation?.abort(); confirmation = undefined;
      try { native.send(data.method, data.payload); } catch { shutdown(); }
      if (data.method === 'clear') target = '';
      return;
    }
    queued++;
    const receivedAt = Date.now(), binding = target, generation = bindingGeneration;
    chain = chain.then(async () => {
      if (ending || generation !== bindingGeneration) return;
      const p = data.payload;
      try {
        let value: any;
        if (data.type === 'native-request') {
          if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new Error('无效请求编号');
          switch (data.method) {
            case 'windows': {
              value = await native.request('windows'); sourceList.clear();
              for (const row of value.windows || []) if (typeof row.id === 'string' && typeof row.name === 'string') sourceList.set(row.id, row.name);
              break;
            }
            case 'target': {
              if (typeof p.hwnd !== 'string' || !/^\d+$/.test(p.hwnd) || !sourceList.has(`window:${p.hwnd}:0`)) throw new Error('窗口未经本机枚举确认');
              const selected = p.hwnd;
              confirmation = new AbortController();
              const answer = await prompt.question(`\n网站请求绑定本机窗口「${sourceList.get(`window:${selected}:0`)}」。确认它就是浏览器正在共享的窗口？输入 yes：`, { signal: AbortSignal.any([confirmation.signal, AbortSignal.timeout(55000)]) });
              confirmation = undefined;
              if (answer.trim() !== 'yes' || Date.now() - receivedAt > 55000 || ending || generation !== bindingGeneration) throw new Error('本机尚未确认窗口，请停止共享后重试');
              value = await native.request('target', { hwnd: selected }); target = selected; break;
            }
            case 'appearance': if (!validCursor(p)) throw new Error('无效鼠标样式'); value = await native.request('appearance', p); break;
            case 'activate':
            case 'grant':
              if (!target || target !== binding || Date.now() - receivedAt > 500 || (data.method === 'grant' && (!Number.isSafeInteger(p.epoch) || typeof p.controller !== 'string' || typeof p.enabled !== 'boolean'))) throw new Error('窗口绑定已失效或授权消息过期');
              if (data.method === 'grant' && p.enabled && !confirmedActivation) throw new Error('本机已收回控制，请主持人重新授权');
              value = await native.request(data.method, p);
              if (data.method === 'activate' && generation === bindingGeneration) confirmedActivation = true;
              break;
            default: throw new Error('辅助程序不允许此操作');
          }
          send({ type: 'native-result', id: data.id, value });
        } else {
          switch (data.method) {
            case 'pointer':
              if (!target || binding !== target || !Number.isFinite(p.sentAt) || Date.now() - receivedAt > 250 || Math.abs(Date.now() - (p.sentAt + serverOffset)) > 250) return;
              native.send('pointer', { ...p, sentAt: p.sentAt + serverOffset }); break;
            case 'frame':
              if (target && binding === target && Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width <= 16384 && p.height <= 16384) native.send('frame', p); break;
            case 'remove': if (typeof p.visitor === 'string') native.send('remove', { visitor: p.visitor }); break;
            default: throw new Error('辅助程序不允许此操作');
          }
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : '本机操作失败';
        if (data.type === 'native-request') send({ type: 'native-result', id: data.id, error: reason });
        else { revoke('本机输入失败，已停止控制。'); send({ type: 'local-revoke' }); }
      }
    }).finally(() => { queued--; });
  });
}
void run().catch(e => { console.error(e instanceof Error ? e.message : '辅助程序启动失败'); shutdown(); process.exitCode = 1; });
