import { useEffect, useRef, useState } from 'react';
import { Alert, App, Avatar, Button, ColorPicker, Empty, Input, Radio, Select, Tag } from 'antd';
import { CopyOutlined, DesktopOutlined, DisconnectOutlined, LinkOutlined, PlayCircleOutlined, SafetyOutlined, SettingOutlined, StopOutlined, TeamOutlined } from '@ant-design/icons';
import { BrowserBridge } from './browser-bridge';
import { HostMedia } from './host-media';
import { VideoControls } from './SettingsPanel';
import { CursorGlyph } from './CursorGlyph';
import { captureWindowId, type BrowserHostState, type VisitorPointer } from '../shared/browser-service';
import { transportLabel, type NetworkSettings } from '../shared/network';
import { initialVideoConstraints, type CursorSettings, type VideoSettings } from '../shared/settings';

const bridge = new BrowserBridge();
type Position = VisitorPointer & { at: number };
export function BrowserHost() {
  const { message } = App.useApp();
  const [state, setState] = useState<BrowserHostState>();
  const [key, setKey] = useState(''), [connecting, setConnecting] = useState(false), [error, setError] = useState('');
  const [tab, setTab] = useState('share'), [busy, setBusy] = useState(false), [stream, setStream] = useState<MediaStream>();
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [pair, setPair] = useState<{ code: string; expiresAt: number }>();
  const [clock, setClock] = useState(Date.now());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const video = useRef<HTMLVideoElement>(null), preview = useRef<HTMLDivElement>(null);
  const media = useRef<HostMedia | undefined>(undefined);
  const current = useRef<BrowserHostState | undefined>(undefined); current.current = state;
  const fail = (e: unknown) => { void message.error(e instanceof Error ? e.message : String(e)); };
  useEffect(() => {
    const offState = bridge.onBrowserState(next => {
      setState(next);
      if (!next.sharing) { media.current?.stop(); setStream(undefined); setPositions({}); }
    });
    const offClose = bridge.onClose(reason => { media.current?.stop(); setStream(undefined); setState(undefined); setError(reason); setPair(undefined); setPositions({}); });
    const offPointer = bridge.onPointer(position => {
      const m = position.message;
      setPositions(previous => {
        const next = { ...previous };
        if (['leave', 'release', 'touch-end'].includes(m.type)) delete next[position.id];
        else next[position.id] = { ...position, at: Date.now() };
        return next;
      });
    });
    const timer = setInterval(() => {
      setClock(Date.now());
      setPositions(previous => {
        const next = Object.fromEntries(Object.entries(previous).filter(([, value]) => Date.now() - value.at < 1800));
        return Object.keys(next).length === Object.keys(previous).length ? previous : next;
      });
    }, 500);
    const unload = () => { media.current?.stop(); bridge.close(); setState(undefined); setStream(undefined); setPositions({}); setPair(undefined); };
    window.addEventListener('pagehide', unload);
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.code === 'F8' && current.current?.controlEnabled) { event.preventDefault(); void bridge.toggleControl().catch(fail); }
    };
    window.addEventListener('keydown', shortcut);
    return () => { offState(); offClose(); offPointer(); clearInterval(timer); media.current?.dispose(); bridge.close(); window.removeEventListener('pagehide', unload); window.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => {
    const el = video.current, root = preview.current;
    if (!el || !root || !stream) return;
    el.srcObject = stream; void el.play().catch(fail);
    const measure = () => {
      if (!el.videoWidth || !el.videoHeight) return;
      setSize({ width: el.videoWidth, height: el.videoHeight }); bridge.frameSize(el.videoWidth, el.videoHeight); media.current?.frameChanged(el.videoWidth, el.videoHeight);
      const rect = el.getBoundingClientRect(), bounds = root.getBoundingClientRect();
      const scale = Math.min(rect.width / el.videoWidth, rect.height / el.videoHeight);
      const width = el.videoWidth * scale, height = el.videoHeight * scale;
      setArea({ left: rect.left - bounds.left + (rect.width - width) / 2, top: rect.top - bounds.top + (rect.height - height) / 2, width, height });
    };
    el.addEventListener('loadedmetadata', measure); el.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => { observer.disconnect(); el.removeEventListener('loadedmetadata', measure); el.removeEventListener('resize', measure); el.srcObject = null; };
  }, [stream, tab]);
  async function connect() {
    if (connecting) return;
    setConnecting(true); setError('');
    try {
      const next = await bridge.connect(key.trim());
      setKey(''); setState(next); media.current?.dispose(); media.current = new HostMedia(bridge, text => void message.error(text));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setConnecting(false); }
  }
  async function share() {
    if (!state || busy) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) { fail(new Error('浏览器共享窗口需要 HTTPS 或 localhost，并建议使用桌面版 Chrome / Edge')); return; }
    // Must run in the original click gesture, before any network roundtrip.
    const selecting = navigator.mediaDevices.getDisplayMedia({ video: { ...initialVideoConstraints(state.video), displaySurface: 'window' }, audio: false, monitorTypeSurfaces: 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' } as DisplayMediaStreamOptions);
    setBusy(true); let selected: MediaStream | undefined;
    try {
      selected = await selecting;
      const track = selected.getVideoTracks()[0];
      if (track.getSettings().displaySurface !== 'window') throw new Error('请选择一个应用窗口；当前版本不共享整个屏幕或浏览器标签页');
      const windowId = captureWindowId(track.label);
      await bridge.begin(windowId ? '浏览器选择的应用窗口' : track.label || '应用窗口', windowId);
      const live = await media.current!.capture(selected); setStream(live); setPositions({});
    } catch (e) {
      selected?.getTracks().forEach(track => track.stop());
      if ((await bridge.state().catch(() => undefined))?.sharing) await bridge.stop().catch(() => {});
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) fail(e);
    } finally { setBusy(false); }
  }
  async function changeVideo(value: VideoSettings) {
    if (busy) return; setBusy(true);
    const previous = state?.video;
    try { await media.current?.configure(value); await bridge.setVideo(value); }
    catch (e) { if (previous) await media.current?.configure(previous).catch(() => {}); fail(e); }
    finally { setBusy(false); }
  }
  async function changeCursor(value: CursorSettings) { try { await bridge.setCursor(value); } catch (e) { fail(e); } }
  const supported = window.isSecureContext && !!navigator.mediaDevices?.getDisplayMedia;
  if (!state) return <div className="viewer-shell"><header className="viewer-header"><div className="brand-mark"><span className="cursor-logo" />GhostCursor <Tag>Web</Tag></div><a href="/">访客入口</a></header>
    <main className="join-main"><div className="surface join-card"><div className="join-icon"><DesktopOutlined /></div><div className="eyebrow">SHARE FROM YOUR BROWSER</div><h1>打开浏览器，<br />开始一起协作。</h1><p>输入部署者提供的主持人密钥。<br />选择一个窗口，通过链接邀请对方。</p>
      <label htmlFor="host-key">主持人密钥</label><Input.Password id="host-key" autoComplete="off" size="large" value={key} onChange={e => setKey(e.target.value)} onPressEnter={() => { void connect(); }} />
      <Button type="primary" block size="large" loading={connecting} disabled={!key.trim()} onClick={() => { void connect(); }}>进入主持人工作台</Button>
      {error && <Alert type="error" showIcon title={error} />}{!supported && <Alert type="warning" showIcon title="当前环境不能发起窗口共享" description="请通过 HTTPS 或 localhost 使用桌面浏览器访问。移动端可通过邀请链接观看。" />}
      <div className="join-note"><SafetyOutlined /> 主持人密钥与访客邀请链接分别使用</div></div></main></div>;
  const controller = state.visitors.find(v => v.id === state.controller);
  const link = state.links[0] || '';
  return <div className="desktop-shell browser-shell">
    <div className="titlebar"><div className="brand-mark"><span className="cursor-logo" />GhostCursor <Tag color="blue">Web</Tag></div><Button type="text" onClick={() => { media.current?.stop(); bridge.close(); setState(undefined); }}>退出工作台</Button></div>
    <aside className="sidebar"><div className="workspace-label">工作空间</div>{[['share', <DesktopOutlined />, '窗口共享'], ['settings', <SettingOutlined />, '共享设置'], ['companion', <SafetyOutlined />, '本机辅助程序']].map(([id, icon, label]) => <button key={String(id)} className={`nav-item ${tab === id ? 'selected' : ''}`} onClick={() => setTab(String(id))}>{icon}<span>{label}</span></button>)}<div className="sidebar-bottom"><span className={`status-dot ${state.sharing ? 'on' : ''}`} />{state.sharing ? '正在共享' : '服务已连接'}<small>浏览器共享 · 单网站端口</small></div></aside>
    <main className="main-content"><header className="page-header"><div><div className="eyebrow">GHOSTCURSOR / WEB</div><h1>{tab === 'share' ? '让协作，就在眼前。' : tab === 'settings' ? '按你的习惯来。' : '连接本机，扩展协作。'}</h1><p>{tab === 'share' ? '浏览器选择窗口，对方打开链接即可观看。' : tab === 'settings' ? '画质和标记即时生效，网络方式在停止共享后修改。' : '辅助程序主动连接网站，本机无需开放端口。'}</p></div><Tag color={state.sharing ? 'green' : 'blue'}>{state.sharing ? '正在共享' : '准备就绪'}</Tag></header>
      {!state.companion.bound && <Alert className="state-alert" type="info" showIcon title="浏览器共享模式" description="访客位置显示在下方网页预览中。系统鼠标控制与实际应用窗口上的标记，需要连接且能验证窗口的本机辅助程序。" />}
      {tab === 'share' && <><section className="share-grid"><div className="surface preview-panel"><div className="section-heading"><h3><DesktopOutlined /> 共享窗口</h3>{stream && <span className="live-badge"><i /> 实时画面</span>}</div>
        <div className="share-quality"><VideoControls value={state.video} busy={busy} change={value => { void changeVideo(value); }} />{stream && <div className="capture-details">实际画面 {size.width} × {size.height} · {transportLabel(state.network.transport)}</div>}</div>
        <div ref={preview} className={`preview browser-preview ${stream ? 'has-video' : ''}`}>{stream ? <><video ref={video} autoPlay muted playsInline /><div className="browser-pointer-layer" style={{ left: area.left, top: area.top, width: area.width, height: area.height }}>{Object.values(positions).map(position => {
          const visitor = state.visitors.find(v => v.id === position.id), p = position.message;
          if (!visitor || p.x === undefined || p.y === undefined || (state.controlEnabled && position.id !== state.controller)) return null;
          return <CursorGlyph key={position.id} settings={state.cursor} name={visitor.name} color={visitor.color} touch={p.pointerType === 'touch' || p.pointerType === 'pen'} className="browser-visitor-cursor" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />;
        })}</div></> : <div className="preview-empty"><div className="join-icon"><DesktopOutlined /></div><h3>从一个窗口开始</h3><p>由浏览器选择要共享的应用窗口。</p><Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!supported} onClick={() => { void share(); }}>选择窗口并共享</Button></div>}</div>
        <div className="preview-footer"><div className="source-info"><span className="source-icon"><DesktopOutlined /></span><div><strong>{state.sharing ? state.sourceName : '尚未共享窗口'}</strong><small>{state.sharing ? '停止共享后可选择其他窗口' : '仅共享你在浏览器中选择的窗口'}</small></div></div>{state.sharing && <Button danger icon={<StopOutlined />} onClick={() => { void bridge.stop().catch(fail); }}>停止共享</Button>}</div></div>
        <div className="right-column"><div className="surface invite-panel"><div className="tile-icon"><LinkOutlined /></div><h3>邀请，一步到位。</h3><p>分享同一个网站的邀请链接，<br />本机无需端口映射。</p>{link && <Input aria-label="访客邀请链接" readOnly value={link} />}<Button block type="primary" icon={<CopyOutlined />} disabled={!link} onClick={() => { void bridge.copy(link).then(() => message.success('邀请链接已复制')).catch(fail); }}>复制邀请链接</Button><div className="tiny-note">邀请链接仅在本次共享期间有效</div></div><div className="surface shortcut-panel"><h3>控制，由你决定</h3><p>{state.companion.bound ? '先选择控制者，再明确开启控制。' : '连接本机辅助程序后，可开启系统鼠标控制。'}</p><Tag color={state.companion.bound ? 'success' : 'default'}>{state.companion.bound ? '辅助程序已绑定' : '观看与网页位置标记'}</Tag></div></div></section>
        <div className="surface visitor-panel"><div className="section-heading"><div><h3><TeamOutlined /> 在线访客 <span className="count">{state.visitors.length}</span></h3><p>每位访客默认仅观看与显示位置。</p></div></div>{!state.visitors.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有访客加入" /> : <div className="visitor-list">{state.visitors.map(v => <div className="visitor-row" key={v.id}><Avatar style={{ background: `${v.color}18`, color: v.color }}>{v.name.slice(0, 1)}</Avatar><div className="visitor-info"><strong>{v.name}</strong><small>{state.controlEnabled && state.controller === v.id ? '正在控制' : '观看与位置标记'}</small></div><Radio disabled={!state.companion.bound} checked={state.controller === v.id} onChange={() => { void bridge.selectController(v.id).catch(fail); }}>控制者</Radio><Button aria-label={`断开 ${v.name}`} type="text" icon={<DisconnectOutlined />} onClick={() => { void bridge.disconnect(v.id).catch(fail); }} /></div>)}</div>}
          <div className={`control-strip ${state.controlEnabled ? 'active' : ''}`}><SafetyOutlined /><div><strong>{state.controlEnabled ? `${controller?.name || '访客'} 正在控制` : '远程控制已关闭'}</strong><small>{state.companion.bound ? state.controlReason || '本机 Ctrl+Alt+F8 可立即收回控制' : state.companion.reason}</small></div><Button loading={state.controlPending} disabled={!state.sharing || !state.companion.bound || !controller} onClick={() => { void bridge.toggleControl().catch(fail); }}>{state.controlEnabled ? '收回控制' : '开启控制'}</Button></div></div></>}
      {tab === 'settings' && <div className="surface settings-panel"><div className="setting-row video-setting-row"><div><h3>分辨率与画质</h3><p>分辨率和帧率为上限，保持窗口比例。</p></div><VideoControls value={state.video} busy={busy} change={value => { void changeVideo(value); }} /></div>
        <div className="setting-row"><div><h3>鼠标样式</h3><p>同步网页预览、访客控制指针与已绑定的原生标记。</p></div><Radio.Group value={state.cursor.shape} onChange={e => { void changeCursor({ ...state.cursor, shape: e.target.value }); }} options={[{ value: 'arrow', label: '箭头' }, { value: 'ring', label: '圆环' }, { value: 'crosshair', label: '十字' }]} /><Select aria-label="鼠标尺寸" value={state.cursor.size} onChange={value => { void changeCursor({ ...state.cursor, size: value }); }} options={[{ value: 24, label: '小' }, { value: 32, label: '中' }, { value: 44, label: '大' }]} /></div>
        <div className="setting-row"><div><h3>鼠标颜色</h3><p>触摸与笔输入始终显示圆形落点。</p></div><Radio.Group value={state.cursor.color ? 'custom' : 'visitor'} onChange={e => { void changeCursor({ ...state.cursor, color: e.target.value === 'visitor' ? null : '#2563eb' }); }} options={[{ value: 'visitor', label: '跟随访客' }, { value: 'custom', label: '自定义' }]} />{state.cursor.color && <ColorPicker disabledAlpha showText value={state.cursor.color} onChangeComplete={value => { void changeCursor({ ...state.cursor, color: value.toHexString() }); }} />}</div>
        <BrowserNetwork value={state.network} sharing={state.sharing} fail={fail} />
        <Alert showIcon type="info" title="一个网站入口即可" description="默认 WebSocket 同时转发视频、信令和位置消息。服务器提供 HTTPS 与 WebSocket 反向代理即可；主持人和访客电脑都不需要 FRP 映射。" /></div>}
      {tab === 'companion' && <div className="surface settings-panel"><h3>可选的本机辅助程序</h3><p className="browser-help">纯浏览器可以共享观看和显示网页位置标记。需要实际应用上的标记与系统控制时，在共享窗口所在电脑运行辅助程序；辅助程序主动连接此网站，使用 2 分钟内有效的一次性配对码。</p><Alert type={state.companion.bound ? 'success' : 'info'} showIcon title={state.companion.connected ? '辅助程序已连接' : '尚未连接辅助程序'} description={state.companion.reason} />
        <div className="network-actions"><Button type="primary" disabled={state.companion.connected} onClick={() => { void bridge.call<{ code: string; expiresAt: number }>('pair-companion').then(setPair).catch(fail); }}>生成一次性配对码</Button><Button disabled={!state.companion.connected} onClick={() => { void bridge.call('disconnect-companion').catch(fail); }}>断开辅助程序</Button></div>
        {pair && !state.companion.connected && <div className="browser-pair"><label>一次性配对码（{Math.max(0, Math.ceil((pair.expiresAt - clock) / 1000))} 秒后过期）</label><Input aria-label="辅助程序配对码" readOnly value={clock < pair.expiresAt ? pair.code : '已过期，请重新生成'} /><p>在本机辅助程序的终端输入网站地址和配对码。不要输入主持人密钥，也不要把配对码转发给访客。</p></div>}
        <p className="browser-help">辅助程序仅支持 Windows / macOS。必须在同一台电脑运行，并由浏览器提供精确的窗口编号；无法验证编号时会保持原生功能关闭。Ctrl+Alt+F8 在辅助程序运行时用于收回控制，浏览器页面内也可收回。辅助程序断开不会中止浏览器观看。</p>
      </div>}
    </main>
  </div>;
}

function BrowserNetwork({ value, sharing, fail }: { value: NetworkSettings; sharing: boolean; fail: (e: unknown) => void }) {
  const [draft, setDraft] = useState(value), [saving, setSaving] = useState(false);
  const [stunText, setStunText] = useState(value.stunUrls.join('\n')), [turnText, setTurnText] = useState(value.turnUrls.join('\n'));
  const saved = JSON.stringify(value);
  useEffect(() => { setDraft(value); setStunText(value.stunUrls.join('\n')); setTurnText(value.turnUrls.join('\n')); }, [saved]);
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return <div className="network-setting"><h3>视频传输方式</h3><fieldset disabled={sharing || saving}>
    <Radio.Group disabled={sharing || saving} value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value })} options={[{ value: 'websocket', label: 'WebSocket · 单网站端口' }, { value: 'webrtc', label: 'WebRTC · 直连优先' }]} />
    {draft.transport === 'webrtc' && <><label>STUN 地址（每行一个，留空可仅使用局域网候选）</label><Input.TextArea disabled={sharing || saving || draft.autoStun} value={stunText} onChange={e => setStunText(e.target.value)} /><Radio.Group disabled={sharing || saving} value={draft.autoStun} onChange={e => setDraft({ ...draft, autoStun: e.target.value })} options={[{ value: true, label: '自动 STUN' }, { value: false, label: '手动 STUN' }]} /><p>自动 STUN 在开始共享时获取地址，UDP 探测发生在部署服务器；不保证主持人和访客可以直连。</p>
      <label>TURN 地址（每行一个）</label><Input.TextArea disabled={sharing || saving} value={turnText} onChange={e => setTurnText(e.target.value)} /><div className="turn-credentials"><Input aria-label="TURN 账号" disabled={sharing || saving} placeholder="TURN 账号" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} /><Input.Password aria-label="TURN 密码" disabled={sharing || saving} autoComplete="off" placeholder="TURN 密码" value={draft.credential} onChange={e => setDraft({ ...draft, credential: e.target.value })} /></div><Radio.Group disabled={sharing || saving || !lines(turnText).length} value={draft.relayOnly} onChange={e => setDraft({ ...draft, relayOnly: e.target.value })} options={[{ value: false, label: '允许直连' }, { value: true, label: '强制 TURN' }]} /></>}
    <Button type="primary" loading={saving} disabled={sharing || saving} onClick={() => { setSaving(true); const next = draft.transport === 'webrtc' ? { ...draft, stunUrls: draft.autoStun ? value.stunUrls : lines(stunText), turnUrls: lines(turnText), relayOnly: lines(turnText).length > 0 && draft.relayOnly } : { ...draft, stunUrls: value.stunUrls, turnUrls: value.turnUrls, username: value.username, credential: value.credential, relayOnly: value.relayOnly }; void bridge.setNetwork(next).catch(fail).finally(() => setSaving(false)); }}>保存连接方式</Button></fieldset>
    <p>{sharing ? '停止共享后可以修改传输方式。' : draft.transport === 'websocket' ? '默认推荐；视频经过服务器，双方仅需访问同一个网站。' : 'WebRTC 直连取决于双方网络，可能需要 TURN；普通浏览器无法固定媒体 UDP 端口。'}</p></div>;
}
