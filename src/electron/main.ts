import { app, BrowserWindow, ipcMain, desktopCapturer, session as electronSession, globalShortcut, clipboard } from 'electron';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { Session } from './session';
import { NativeBridge } from './native';
import { SharingServer } from './server';
import { ControlCoordinator } from './control';
import { validSignal, type HostState, type HostEvent } from '../shared/protocol';

app.setName('GhostCursor');
if (process.env.GHOSTCURSOR_E2E) app.setPath('userData', join(app.getPath('temp'), `ghostcursor-e2e-${process.pid}`));
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow;
const sharing = new Session(), native = new NativeBridge();
const webRoot = join(__dirname, '../web');
const server = new SharingServer(sharing, webRoot);
let sourceId = '', sourceName = '', port = 3210, hotkey = 'Ctrl+Alt+F8';
let nativeReady = false, targetAvailable = false, error = '', busy = false;
let quitting = false;
let nativeReason = '';
const pendingMoves = new Map<string, { message: object; at: number }>();
const rates = new Map<string, { start: number; count: number }>();
const controls = new ControlCoordinator(sharing, { request: (type, payload) => native.request(type, payload), send: sendNative }, () => { server.broadcastState(); publish(); });

function state(): HostState {
  const hosts = ['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(items => items || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address)];
  return { sharing: sharing.active, sessionId: sharing.id, visitors: [...sharing.visitors.values()], controller: sharing.controller,
    controlEnabled: sharing.enabled, epoch: sharing.epoch, links: sharing.active ? [...new Set(hosts)].map(host => `http://${host}:${port}/#${sharing.token}`) : [],
    controlPending: controls.pending, controlReason: sharing.controlReason,
    port, sourceName, hotkey, nativeReady, targetAvailable, error: error || (sharing.active ? nativeReason : '') };
}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('state', state()); }
function event(value: HostEvent) { if (window && !window.isDestroyed()) window.webContents.send('event', value); }
function sendNative(type: string, payload = {}) {
  try { native.send(type, payload); } catch (e) { nativeReady = false; sharing.revoke(); pendingMoves.clear(); error = (e as Error).message; publish(); server.broadcastState(); }
}
function syncGrant() {
  pendingMoves.clear();
  controls.synchronize();
}
async function toggle() {
  error = '';
  if (!nativeReady) throw new Error('原生组件尚未就绪');
  await controls.toggle();
}
async function stop() {
  sharing.end(); sourceId = ''; sourceName = ''; pendingMoves.clear(); rates.clear(); targetAvailable = false; nativeReason = '';
  syncGrant();
  sendNative('clear'); server.broadcastState(); publish(); await server.stop();
}
function registerHotkey(value: string) {
  if (value === hotkey && globalShortcut.isRegistered(hotkey)) return;
  if (!/^((Ctrl|Alt|Shift|Super)\+){1,3}(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(value)) throw new Error('请输入组合快捷键，例如 Ctrl+Alt+F8');
  const old = hotkey;
  if (!globalShortcut.register(value, () => { void toggle().catch(e => { error = (e as Error).message; }).finally(publish); })) throw new Error('快捷键已被占用，请换一个组合');
  hotkey = value;
  if (old !== value) globalShortcut.unregister(old);
}
async function sources() {
  const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 400, height: 240 }, fetchWindowIcons: false });
  return list.filter(s => s.name !== 'GhostCursor' && !s.name.startsWith('GhostCursor Overlay')).map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1160, height: 820, minWidth: 940, minHeight: 700, title: 'GhostCursor',
    icon: join(__dirname, '../../assets/icon.png'),
    backgroundColor: '#f3f5fa', titleBarStyle: 'hidden', titleBarOverlay: { color: '#f3f5fa', symbolColor: '#26354a', height: 40 },
    backgroundMaterial: 'mica', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'display-capture' && wc === window.webContents && sharing.active);
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'display-capture' && wc === window.webContents && sharing.active));
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!sharing.active || request.frame !== window.webContents.mainFrame || !sourceId) { callback({}); return; }
    try {
      const id = sourceId;
      const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = list.find(s => s.id === id);
      if (!source || sourceId !== id || !sharing.active) callback({}); else callback({ video: source });
    } catch { callback({}); }
  });
  const trusted = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => e.sender === window.webContents && e.senderFrame === window.webContents.mainFrame;
  const handle = (name: string, callback: (...args: any[]) => any) => ipcMain.handle(name, (e, ...args) => { if (!trusted(e)) throw new Error('无效调用'); return callback(...args); });
  const on = (name: string, callback: (...args: any[]) => void) => ipcMain.on(name, (e, ...args) => { if (trusted(e)) callback(...args); });
  handle('state', state); handle('sources', sources);
  handle('diagnostics', () => native.request('snapshot'));
  handle('start', async (options: { sourceId: string; port: number }) => {
    if (busy || sharing.active) throw new Error('请先停止当前共享');
    if (!nativeReady) throw new Error('原生组件未就绪，请重启程序');
    if (!options || !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('端口必须在 1024–65535 之间');
    busy = true; error = '';
    try {
      const list = await sources(); const selected = list.find(s => s.id === options.sourceId);
      if (!selected || !/^window:\d+:\d+$/.test(selected.id)) throw new Error('窗口已关闭，请刷新列表');
      await native.request('target', { hwnd: selected.id.split(':')[1] });
      sourceId = selected.id; sourceName = selected.name; port = options.port; sharing.begin();
      await server.start(port); publish(); return state();
    } catch (e) { await stop(); error = (e as Error).message; publish(); throw e; }
    finally { busy = false; }
  });
  handle('stop', stop);
  handle('select-controller', (id: string | null) => { if (id !== null && typeof id !== 'string') throw new Error('无效访客'); error = ''; sharing.select(id); syncGrant(); });
  handle('toggle-control', toggle);
  handle('disconnect', (id: string) => { if (typeof id === 'string') server.disconnect(id); });
  handle('set-hotkey', async (value: string) => { registerHotkey(value); await writeFile(join(app.getPath('userData'), 'settings.json'), JSON.stringify({ hotkey })); publish(); });
  handle('copy', (value: string) => { if (typeof value === 'string' && value.length < 4096) clipboard.writeText(value); });
  on('signal', (id, signal) => { if (typeof id === 'string' && sharing.visitors.has(id) && validSignal(signal)) server.signal(id, signal); });
  on('frame-size', (width, height) => { if (sharing.active && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384) sendNative('frame', { width, height }); });
  on('pointer', (id: string, value: unknown) => {
    const accepted = sharing.accept(id, value); if (!accepted) return;
    let rate = rates.get(id); const now = Date.now();
    if (!rate || now - rate.start > 1000) { rate = { start: now, count: 0 }; rates.set(id, rate); }
    if (++rate.count > 240) { if (sharing.controller === id && sharing.enabled) { sharing.revoke(); syncGrant(); } return; }
    const visitor = sharing.visitors.get(id)!;
    const { type, ...coordinates } = accepted.message;
    const payload = { visitor: id, name: visitor.name, color: visitor.color, ...coordinates, action: type, inject: accepted.inject, sentAt: now };
    if (accepted.message.type === 'pointer') pendingMoves.set(id, { message: payload, at: now });
    else { pendingMoves.delete(id); sendNative('pointer', payload); }
  });
  on('close', () => window.close()); on('minimize', () => window.minimize());
  const ticker = setInterval(() => {
    const moves = [...pendingMoves.values()]; pendingMoves.clear();
    for (const move of moves) if (Date.now() - move.at < 100) sendNative('pointer', move.message);
  }, 16); ticker.unref();
  native.on('status', status => {
    targetAvailable = !!status.available; nativeReason = status.reason || '';
    if (status.enabled === false && Number.isSafeInteger(status.epoch)) controls.nativeRevoked(status.epoch, nativeReason || '系统已停止远程控制');
    if (!targetAvailable && sharing.enabled) { sharing.revoke(nativeReason); syncGrant(); }
    event({ type: 'native-status', available: targetAvailable, reason: nativeReason }); publish();
    if (status.closed && sharing.active) void stop();
  });
  native.on('failure', () => {
    if (quitting) return;
    nativeReady = false; error = '原生组件已断开，已停止共享。请重启程序。';
    void stop();
  });
  server.on('join', visitor => { event({ type: 'visitor-joined', visitor }); publish(); });
  server.on('leave', id => { pendingMoves.delete(id); rates.delete(id); sendNative('remove', { visitor: id }); if (sharing.controller === null) syncGrant(); else publish(); event({ type: 'visitor-left', id }); });
  server.on('signal', (id, signal) => event({ type: 'signal', id, signal }));
  server.on('failure', (e: Error) => { error = e.message; void stop(); });
  try {
    const settings = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof settings.hotkey === 'string') hotkey = settings.hotkey;
  } catch {}
  try { registerHotkey(hotkey); } catch (e) { error = (e as Error).message; }
  await window.loadFile(join(webRoot, 'index.html'));
  try { await native.launch(app.isPackaged ? join(process.resourcesPath, 'native/GhostCursor.Native.exe') : join(__dirname, '../native/GhostCursor.Native.exe')); nativeReady = true; }
  catch (e) { error = `原生组件启动失败：${(e as Error).message}`; }
  publish();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; sharing.end(); native.close(); void server.stop(); globalShortcut.unregisterAll(); });
