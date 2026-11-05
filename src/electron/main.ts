import { app, BrowserWindow, ipcMain, desktopCapturer, session as electronSession, globalShortcut, clipboard, screen } from 'electron';
import { join } from 'node:path';
import { networkInterfaces, release as osRelease } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Session } from './session';
import { NativeBridge } from './native';
import { SharingServer } from './server';
import { ControlCoordinator } from './control';
import { SourceCatalog, selectableWindows } from './source-catalog';
import { validGraphicsMode, useCompatibility, type GraphicsMode } from '../shared/graphics';
import { DEFAULT_NETWORK, publicOrigin, storedNetwork, validNetwork, type NetworkSettings } from '../shared/network';
import { validSignal, type HostState, type HostEvent } from '../shared/protocol';
import { TokenBucket } from '../shared/rate-limit';
import { DEFAULT_VIDEO, DEFAULT_CURSOR, storedVideo, validVideo, validCursor, validShortcut, type VideoSettings, type CursorSettings } from '../shared/settings';

app.setName('GhostCursor');
if (process.env.GHOSTCURSOR_E2E) app.setPath('userData', join(app.getPath('temp'), `ghostcursor-e2e-${process.pid}`));
const windowsBuild = Number(osRelease().split('.')[2]);
const graphicsPath = join(app.getPath('userData'), 'graphics.json');
let graphicsMode: GraphicsMode = 'auto';
try { const saved = JSON.parse(readFileSync(graphicsPath, 'utf8')); if (validGraphicsMode(saved.mode)) graphicsMode = saved.mode; } catch {}
const forcedGraphics = process.argv.includes('--graphics-compatibility') ? 'compatibility' : process.argv.includes('--graphics-hardware') ? 'hardware' : undefined;
const compatibility = useCompatibility(forcedGraphics || graphicsMode, windowsBuild);
// Must be applied before app.ready / any renderer or GPU process starts.
if (compatibility) app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow;
const sharing = new Session(), native = new NativeBridge();
const webRoot = join(__dirname, '../web');
const server = new SharingServer(sharing, webRoot);
const captureSources = new SourceCatalog(() => desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }));
let sourceId = '', sourceName = '', port = 3210, hotkey = 'Ctrl+Alt+F8';
let nativeReady = false, targetAvailable = false, error = '', busy = false;
let quitting = false;
let nativeReason = '';
let sessionHosts = ['127.0.0.1'];
let network: NetworkSettings = { ...DEFAULT_NETWORK };
let video: VideoSettings = { ...DEFAULT_VIDEO }, cursor: CursorSettings = { ...DEFAULT_CURSOR };
let recordingHotkey = false, recordingTimer: NodeJS.Timeout | undefined;
let settingsWrite = Promise.resolve();
function persistSettings() {
  const contents = JSON.stringify({ hotkey, video, cursor, network });
  const write = settingsWrite.catch(() => {}).then(() => writeFile(join(app.getPath('userData'), 'settings.json'), contents));
  settingsWrite = write; return write;
}
function presentation() { server.setPresentation({ video, cursor }); }
const pendingMoves = new Map<string, { message: object; at: number }>();
const rates = new Map<string, { moves: TokenBucket; actions: TokenBucket }>();
const controls = new ControlCoordinator(sharing, { request: (type, payload) => native.request(type, payload), send: sendNative }, () => { server.broadcastState(); publish(); });

function state(): HostState {
  return { sharing: sharing.active, sessionId: sharing.id, visitors: [...sharing.visitors.values()], controller: sharing.controller,
    controlEnabled: sharing.enabled, epoch: sharing.epoch, links: sharing.active ? [...(network.publicUrl ? [`${network.publicUrl}/#${sharing.token}`] : []), ...sessionHosts.map(host => `http://${host}:${port}/#${sharing.token}`)] : [],
    controlPending: controls.pending, controlReason: sharing.controlReason, video, cursor,
    graphics: { mode: graphicsMode, compatibility, restartRequired: useCompatibility(graphicsMode, windowsBuild) !== compatibility }, network,
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
  if (!validShortcut(value)) throw new Error('请按下带修饰键的组合，例如 Ctrl+Alt+F8');
  if (value === hotkey && globalShortcut.isRegistered(hotkey)) return;
  const old = hotkey;
  if (!globalShortcut.register(value, () => { void toggle().catch(e => { error = (e as Error).message; }).finally(publish); })) throw new Error('快捷键已被占用，请换一个组合');
  hotkey = value;
  if (old !== value) globalShortcut.unregister(old);
}
function finishRecording() {
  clearTimeout(recordingTimer); recordingHotkey = false;
  try { registerHotkey(hotkey); } catch (e) { error = (e as Error).message; publish(); }
}
async function sources() {
  if (!nativeReady) throw new Error('原生组件尚未就绪，请稍后重试或重启程序');
  const response = await native.request('windows', { excludePid: process.env.GHOSTCURSOR_E2E ? 0 : process.pid });
  const ownId = `window:${window.getNativeWindowHandle().readBigUInt64LE()}:0`;
  return selectableWindows(response.windows).filter(s => s.id !== ownId);
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1160, height: 820, minWidth: 940, minHeight: 700, title: 'GhostCursor',
    icon: join(__dirname, '../../assets/icon.png'),
    backgroundColor: '#f3f5fa', titleBarStyle: 'hidden', titleBarOverlay: { color: '#f3f5fa', symbolColor: '#26354a', height: 40 },
    ...(!compatibility && windowsBuild >= 22000 ? { backgroundMaterial: 'mica' as const } : {}), autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'display-capture' && wc === window.webContents && sharing.active);
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'display-capture' && wc === window.webContents && sharing.active));
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!sharing.active || request.frame !== window.webContents.mainFrame || !sourceId) { callback({}); return; }
    try {
      const id = sourceId, captureSession = sharing.id;
      const source = await captureSources.find(id);
      if (sourceId !== id || !sharing.active || sharing.id !== captureSession) callback({}); else callback({ video: source });
    } catch (e) { error = (e as Error).message; publish(); callback({}); }
  });
  const trusted = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => e.sender === window.webContents && e.senderFrame === window.webContents.mainFrame;
  const handle = (name: string, callback: (...args: any[]) => any) => ipcMain.handle(name, (e, ...args) => { if (!trusted(e)) throw new Error('无效调用'); return callback(...args); });
  const on = (name: string, callback: (...args: any[]) => void) => ipcMain.on(name, (e, ...args) => { if (trusted(e)) callback(...args); });
  handle('state', state); handle('sources', sources);
  handle('diagnostics', () => native.request('snapshot'));
  handle('relay-start', (id: string, sessionId: string, streamId: number, mime: string) => server.relayStart(id, sessionId, streamId, mime));
  handle('relay-chunk', (id: string, sessionId: string, streamId: number, sequence: number, data: ArrayBuffer) => server.relayChunk(id, sessionId, streamId, sequence, data));
  handle('set-graphics', async (mode: GraphicsMode) => {
    if (!validGraphicsMode(mode)) throw new Error('无效图形模式');
    await writeFile(graphicsPath, JSON.stringify({ mode })); graphicsMode = mode; publish();
  });
  handle('restart', () => { app.relaunch({ args: process.argv.slice(1).filter(arg => !['--graphics-compatibility', '--graphics-hardware'].includes(arg)) }); app.quit(); });
  handle('copy-graphics-diagnostics', () => {
    clipboard.writeText(JSON.stringify({ version: app.getVersion(), windows: osRelease(), mode: graphicsMode, compatibility, features: app.getGPUFeatureStatus(), displays: screen.getAllDisplays().map(d => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor })) }, null, 2));
  });
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
      sessionHosts = [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(items => items || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address)])];
      await server.start(port); publish(); return state();
    } catch (e) { await stop(); error = (e as Error).message; publish(); throw e; }
    finally { busy = false; }
  });
  handle('stop', stop);
  handle('select-controller', (id: string | null) => { if (id !== null && typeof id !== 'string') throw new Error('无效访客'); error = ''; sharing.select(id); syncGrant(); });
  handle('toggle-control', toggle);
  handle('disconnect', (id: string, reason?: string) => { if (typeof id === 'string') server.disconnect(id, typeof reason === 'string' ? reason.slice(0, 100) : undefined); });
  handle('set-network', async (value: NetworkSettings) => {
    if (sharing.active || busy) throw new Error('请先停止共享，再修改外网连接设置');
    if (!validNetwork(value)) throw new Error('请检查公网地址、STUN/TURN 地址和中继账号；强制中继需要填写 TURN');
    const next: NetworkSettings = { transport: value.transport, publicUrl: publicOrigin(value.publicUrl), stunUrls: [...value.stunUrls], turnUrls: [...value.turnUrls], username: value.username, credential: value.credential, relayOnly: value.relayOnly };
    const previous = network; network = next;
    try { await persistSettings(); } catch (e) { network = previous; throw e; }
    server.setNetwork(network); publish();
  });
  handle('set-hotkey', async (value: string) => {
    try { registerHotkey(value); recordingHotkey = false; clearTimeout(recordingTimer); await persistSettings(); publish(); }
    catch (e) { finishRecording(); throw e; }
  });
  handle('record-hotkey', (recording: boolean) => {
    if (typeof recording !== 'boolean') throw new Error('无效录制状态');
    if (!recording) { finishRecording(); return; }
    if (sharing.enabled || controls.pending) controls.revoke('正在录制快捷键，已收回控制');
    recordingHotkey = true; globalShortcut.unregister(hotkey); clearTimeout(recordingTimer);
    recordingTimer = setTimeout(finishRecording, 30_000);
  });
  window.on('blur', () => { if (recordingHotkey) finishRecording(); });
  handle('set-video', async (value: VideoSettings) => {
    if (!validVideo(value)) throw new Error('无效画质或帧率');
    video = { preset: value.preset, fps: value.fps, resolution: value.resolution }; await persistSettings(); presentation(); publish();
  });
  handle('set-cursor', async (value: CursorSettings) => {
    if (!validCursor(value)) throw new Error('无效鼠标样式');
    const next = { shape: value.shape, size: value.size, color: value.color };
    await native.request('appearance', next); cursor = next; await persistSettings(); presentation(); publish();
  });
  handle('copy', (value: string) => { if (typeof value === 'string' && value.length < 4096) clipboard.writeText(value); });
  on('signal', (id, signal) => { if (typeof id === 'string' && sharing.visitors.has(id) && validSignal(signal)) server.signal(id, signal); });
  on('frame-size', (width, height) => { if (sharing.active && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384) sendNative('frame', { width, height }); });
  const acceptPointer = (id: string, value: unknown) => {
    const accepted = sharing.accept(id, value); if (!accepted) return;
    const { type, ...coordinates } = accepted.message;
    let rate = rates.get(id); const now = Date.now();
    if (!rate) { rate = { moves: new TokenBucket(120, 360), actions: new TokenBucket(120, 360) }; rates.set(id, rate); }
    if (type === 'pointer') { if (!rate.moves.take()) return; }
    // Releases and exits must still clear held buttons and markers when a
    // movement or wheel burst has exhausted its own budget.
    else if (!['up', 'release', 'leave', 'touch-end'].includes(type) && !rate.actions.take()) {
      if (sharing.controller === id && sharing.enabled) { sharing.revoke('操作消息持续过于频繁，已收回控制'); syncGrant(); } return;
    }
    const visitor = sharing.visitors.get(id)!;
    const payload = { visitor: id, name: visitor.name, color: visitor.color, ...coordinates, action: type, inject: accepted.inject, sentAt: now };
    if (accepted.message.type === 'pointer') pendingMoves.set(id, { message: payload, at: now });
    else { pendingMoves.delete(id); sendNative('pointer', payload); server.cursor(id, { ...coordinates, visible: !['leave', 'release', 'touch-end'].includes(type) }); }
  };
  on('pointer', acceptPointer);
  server.on('pointer', acceptPointer);
  server.on('relay-reset', id => acceptPointer(id, { type: 'leave', sessionId: sharing.id, epoch: sharing.epoch }));
  on('close', () => window.close()); on('minimize', () => window.minimize());
  const ticker = setInterval(() => {
    const moves = [...pendingMoves.values()]; pendingMoves.clear();
    for (const move of moves) if (Date.now() - move.at < 100) {
      sendNative('pointer', move.message);
      const p = move.message as { visitor: string; x: number; y: number; pointerType: string };
      server.cursor(p.visitor, { x: p.x, y: p.y, pointerType: p.pointerType, visible: true });
    }
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
  server.on('relay-ready', (id, mimeTypes) => event({ type: 'relay-ready', id, mimeTypes }));
  server.on('failure', (e: Error) => { error = e.message; void stop(); });
  try {
    const settings = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof settings.hotkey === 'string') hotkey = settings.hotkey;
    video = storedVideo(settings.video) || video;
    if (validCursor(settings.cursor)) cursor = settings.cursor;
    network = storedNetwork(settings.network) || network;
  } catch {}
  if (!validShortcut(hotkey)) hotkey = 'Ctrl+Alt+F8';
  try { registerHotkey(hotkey); } catch (e) { error = (e as Error).message; }
  presentation();
  server.setNetwork(network);
  await window.loadFile(join(webRoot, 'index.html'));
  try { await native.launch(app.isPackaged ? join(process.resourcesPath, 'native/GhostCursor.Native.exe') : join(__dirname, '../native/GhostCursor.Native.exe')); await native.request('appearance', cursor); nativeReady = true; }
  catch (e) { error = `原生组件启动失败：${(e as Error).message}`; }
  publish();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; sharing.end(); native.close(); void server.stop(); globalShortcut.unregisterAll(); });
