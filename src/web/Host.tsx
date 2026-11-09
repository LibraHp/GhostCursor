import { useEffect, useRef, useState } from 'react';
import { Alert, App, Avatar, Button, Empty, Input, Modal, Radio, Select, Spin, Tag, Tooltip } from 'antd';
import { AppstoreOutlined, ArrowRightOutlined, CheckCircleFilled, CopyOutlined, DesktopOutlined, DisconnectOutlined, EyeOutlined, LinkOutlined, LockOutlined, PlayCircleOutlined, ReloadOutlined, SafetyOutlined, SettingOutlined, StopOutlined, TeamOutlined } from '@ant-design/icons';
import type { HostState, WindowSource } from '../shared/protocol';
import { HostMedia } from './host-media';
import { DEFAULT_VIDEO, DEFAULT_CURSOR, type VideoSettings, type CursorSettings } from '../shared/settings';
import { SettingsPanel, VideoControls } from './SettingsPanel';
import { DEFAULT_NETWORK, transportLabel } from '../shared/network';

const initial: HostState = { sharing: false, sessionId: '', visitors: [], controller: null, controlEnabled: false, controlPending: false, controlReason: '等待主持人开启控制', epoch: 0, links: [], port: 3210, sourceName: '', hotkey: 'Ctrl+Alt+F8', video: DEFAULT_VIDEO, cursor: DEFAULT_CURSOR, graphics: { mode: 'auto', compatibility: false, restartRequired: false }, network: DEFAULT_NETWORK, nativeReady: false, targetAvailable: false, error: '' };
const api = window.ghost!;
export function Host() {
  const { message } = App.useApp();
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState('share');
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [windowError, setWindowError] = useState(''), [windowSearch, setWindowSearch] = useState('');
  const refreshing = useRef(false);
  const [selected, setSelected] = useState<WindowSource>();
  const [picker, setPicker] = useState(false), [loading, setLoading] = useState(false), [starting, setStarting] = useState(false);
  const [port, setPort] = useState(3210), [videoBusy, setVideoBusy] = useState(false), [cursorBusy, setCursorBusy] = useState(false);
  const [link, setLink] = useState('');
  const [stream, setStream] = useState<MediaStream>();
  const [captureSize, setCaptureSize] = useState({ width: 0, height: 0 });
  const video = useRef<HTMLVideoElement>(null), media = useRef<HostMedia | null>(null);
  const frameProbe = useRef<HTMLVideoElement>(null);
  const fail = (error: unknown) => { const text = String((error as Error).message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); console.error('[GhostCursor]', text); void message.error(text); };
  useEffect(() => { document.documentElement.classList.toggle('graphics-compatible', state.graphics.compatibility); }, [state.graphics.compatibility]);
  useEffect(() => {
    const accept = (next: HostState) => { setState(next); if (!next.sharing) { media.current?.stop(); setStream(undefined); } };
    api.state().then(accept).catch(fail);
    media.current = new HostMedia(api, text => void message.error(text));
    const off = api.onState(accept);
    return () => { off(); media.current?.dispose(); };
  }, []);
  useEffect(() => { setLink((state.network.publicUrl && state.links.find(value => new URL(value).origin === state.network.publicUrl)) || state.links.find(value => new URL(value).hostname !== '127.0.0.1') || state.links[0] || ''); }, [state.sessionId]);
  useEffect(() => {
    const el = video.current; if (!el || !stream) return;
    el.srcObject = stream;
    void el.play().catch(fail);
    return () => { el.srcObject = null; };
  }, [stream, tab]);
  useEffect(() => {
    const el = frameProbe.current; if (!el || !stream) return;
    el.srcObject = stream;
    const report = () => { if (el.videoWidth && el.videoHeight) { api.frameSize(el.videoWidth, el.videoHeight); media.current?.frameChanged(el.videoWidth, el.videoHeight); setCaptureSize({ width: el.videoWidth, height: el.videoHeight }); } };
    el.addEventListener('loadedmetadata', report); el.addEventListener('resize', report);
    void el.play().catch(fail);
    return () => { el.removeEventListener('loadedmetadata', report); el.removeEventListener('resize', report); el.srcObject = null; };
  }, [stream]);
  async function changeVideo(value: VideoSettings) {
    if (videoBusy || starting) return;
    setVideoBusy(true);
    try { await media.current?.configure(value); await api.setVideo(value); }
    catch (error) { await media.current?.configure(state.video).catch(() => {}); fail(error); }
    finally { setVideoBusy(false); }
  }
  async function changeCursor(value: CursorSettings) {
    if (cursorBusy) return;
    setCursorBusy(true);
    try { await api.setCursor(value); } catch (error) { fail(error); }
    finally { setCursorBusy(false); }
  }
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true; setLoading(true); setWindowError('');
    try {
      const list = await api.sources(); setWindows(list);
      setSelected(previous => list.find(item => item.id === previous?.id));
    } catch (e) { setWindowError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { refreshing.current = false; setLoading(false); }
  }
  async function choose() { setWindowSearch(''); setPicker(true); await refresh(); }
  async function start() {
    if (!selected) { await choose(); return; }
    setStarting(true);
    try { await api.start({ sourceId: selected.id, port }); setStream(await media.current!.capture()); void message.success('共享已开启，复制链接邀请访客'); }
    catch (e) { await api.stop().catch(() => {}); fail(e); }
    finally { setStarting(false); }
  }
  const controller = state.visitors.find(v => v.id === state.controller);
  const matchingWindows = windows.filter(item => item.name.toLocaleLowerCase().includes(windowSearch.trim().toLocaleLowerCase()));
  const visitorPanel = <div className="surface visitor-panel">
    <div className="section-heading"><div><h3>在线访客 <span className="count">{state.visitors.length}</span></h3><p>先选择控制者，再点击“开启控制”或按快捷键。选择人选不会自动授权。</p></div><TeamOutlined /></div>
    {state.visitors.length === 0 ? <div className="visitor-empty"><div className="soft-icon"><TeamOutlined /></div><span>还没有访客加入</span><small>开启共享后，将链接发送给对方</small></div> : <div className="visitor-list">{state.visitors.map(v => <div className="visitor-row" key={v.id}>
      <Avatar style={{ background: `${v.color}16`, color: v.color, flexShrink: 0 }}>{v.name.slice(0, 1)}</Avatar>
      <div className="visitor-info"><strong>{v.name}</strong><small>{state.controller === v.id ? state.controlEnabled ? '正在控制' : '已选定 · 尚未授权操作' : '观看中 · 显示位置'}</small></div>
      <Radio checked={state.controller === v.id} onChange={() => { void api.selectController(v.id).catch(fail); }}>控制者</Radio>
      <Tooltip title="断开访客"><Button type="text" size="small" aria-label={`断开 ${v.name}`} icon={<DisconnectOutlined />} onClick={() => { void api.disconnect(v.id).catch(fail); }} /></Tooltip>
    </div>)}</div>}
    <div className={`control-strip ${state.controlEnabled ? 'active' : ''}`}><SafetyOutlined /><div><strong>{state.controlPending ? '正在切换共享窗口并开启控制…' : state.controlEnabled ? `${controller?.name || '访客'} 正在控制` : '远程控制已关闭'}</strong><small>{state.controlEnabled ? '按快捷键随时收回控制' : state.controlReason || '访客位置标记仍可显示，不执行操作'}</small></div>
      <Button size="small" type={state.controlEnabled ? 'default' : 'primary'} loading={state.controlPending} disabled={!state.sharing || !controller || !state.nativeReady} onClick={() => { void api.toggleControl().catch(fail); }}>{state.controlEnabled ? '收回控制' : '开启控制'}</Button>
    </div>
  </div>;
  return <div className="desktop-shell">
    <video ref={frameProbe} className="capture-probe" autoPlay muted playsInline aria-hidden="true" />
    <div className="titlebar"><div className="brand-mark"><span className="cursor-logo" />GhostCursor</div></div>
    <aside className="sidebar"><div className="workspace-label">工作空间</div>
      {[['share', <AppstoreOutlined />, '窗口共享'], ['visitors', <TeamOutlined />, '访客管理'], ['settings', <SettingOutlined />, '设置']].map(([key, icon, label]) => <button key={String(key)} className={`nav-item ${tab === key ? 'selected' : ''}`} onClick={() => setTab(String(key))}>{icon}<span>{label}</span>{key === 'visitors' && state.visitors.length > 0 && <b>{state.visitors.length}</b>}</button>)}
      <div className="sidebar-bottom"><div className={`status-dot ${state.sharing ? 'on' : ''}`} /><span>{state.sharing ? '共享服务运行中' : '准备就绪'}</span><small>GhostCursor · 0.2.2</small></div>
    </aside>
    <main className="main-content">
      <header className="page-header"><div><div className="eyebrow">GHOSTCURSOR / {tab === 'share' ? 'SHARE' : tab === 'visitors' ? 'PEOPLE' : 'SETTINGS'}</div><h1>{tab === 'share' ? '让协作，就在眼前。' : tab === 'visitors' ? '一起看，一起协作。' : '按你的习惯来。'}</h1><p>{tab === 'share' ? '分享一个窗口，让对方看见你正在做的事。' : tab === 'visitors' ? '查看在线访客，掌握每一次控制授权。' : '简单设置，随时开始下一次共享。'}</p></div><Tag bordered={false} className="header-tag" icon={state.sharing ? <CheckCircleFilled /> : <LockOutlined />} color={state.sharing ? 'green' : 'default'}>{state.sharing ? '正在共享' : '仅本地运行'}</Tag></header>
      {state.error && <Alert className="state-alert" type={state.nativeReady ? 'info' : 'error'} showIcon title={state.error} />}
      {tab === 'share' && <>
        <section className="share-grid">
          <div className="surface preview-panel"><div className="section-heading"><h3><DesktopOutlined /> 共享窗口</h3>{state.sharing ? <span className="live-badge"><i /> 实时画面</span> : <span className="muted">只分享你选择的窗口</span>}</div>
            <div className="share-quality"><VideoControls value={state.video} busy={videoBusy || starting} change={value => { void changeVideo(value); }} />{stream && captureSize.width > 0 && <div className="capture-details">实际画面 {captureSize.width} × {captureSize.height} · 帧率上限 {state.video.fps} 帧/秒</div>}</div>
            <div className={`preview ${stream ? 'has-video' : ''}`}>
              {stream ? <video ref={video} autoPlay muted playsInline /> : <div className="preview-empty"><div className="window-illustration"><div className="illustration-bar"><i /><i /><i /></div><div className="illustration-body"><DesktopOutlined /><span className="illustration-line" /><span className="illustration-line short" /></div><span className="illustration-pointer" /></div><h3>{selected ? '窗口已准备好' : '从一个窗口开始'}</h3><p>{selected ? selected.name : '选择想分享的应用，其他内容留给自己。'}</p><Button icon={<DesktopOutlined />} onClick={() => { void choose(); }}>选择窗口</Button></div>}
            </div>
            <div className="preview-footer"><div className="source-info"><span className="source-icon"><DesktopOutlined /></span><div><strong>{state.sharing ? state.sourceName : selected?.name || '尚未选择窗口'}</strong><small>{state.sharing ? `${transportLabel(state.network.transport)} · 视频共享` : '支持桌面应用窗口'}</small></div></div>
              {!state.sharing && selected && <Button type="text" onClick={() => { void choose(); }}>更换</Button>}
              {state.sharing ? <Button danger icon={<StopOutlined />} onClick={() => { void api.stop().catch(fail); }}>停止共享</Button> : <Button type="primary" loading={starting} disabled={!state.nativeReady} icon={<PlayCircleOutlined />} onClick={() => { void start(); }}>开始共享</Button>}
            </div>
          </div>
          <div className="right-column"><div className="surface invite-panel"><div className="tile-icon"><LinkOutlined /></div><h3>邀请，一步到位。</h3><p>对方打开链接即可观看，<br />无需安装任何软件。</p>
            {state.sharing ? <><Select className="link-select" value={link} onChange={setLink} options={state.links.map(value => ({ value, label: state.network.publicUrl && new URL(value).origin === state.network.publicUrl ? `公网 · ${new URL(value).host}` : new URL(value).hostname === '127.0.0.1' ? '本机测试 · 127.0.0.1' : `局域网 · ${new URL(value).hostname}` }))} /><Button block type="primary" icon={<CopyOutlined />} onClick={() => { void api.copy(link).then(() => message.success('邀请链接已复制')).catch(fail); }}>复制邀请链接</Button></> : <Button block disabled icon={<CopyOutlined />}>开启共享后获取链接</Button>}
            <div className="tiny-note"><LockOutlined /> 链接仅在本次共享期间有效</div>
          </div><div className="surface shortcut-panel"><div className="section-heading"><h3>控制，由你决定</h3><SafetyOutlined /></div><p>选好访客，点击“开启控制”，<br />或按快捷键开启与收回。</p><div className="key-combo">{state.hotkey.split('+').map((key, i) => <span key={i}><kbd>{key}</kbd>{i < state.hotkey.split('+').length - 1 && <em>+</em>}</span>)}</div><div className="shortcut-note"><span className={`status-dot ${state.controlEnabled ? 'on' : ''}`} />{state.controlEnabled ? '控制已开启' : '选定访客后仍需开启控制'}</div></div></div>
        </section>
        {visitorPanel}
        <div className="bottom-hint"><EyeOutlined /> 访客移动鼠标时，位置标记会显示在你本机的共享窗口上。<button onClick={() => setTab('settings')}>共享设置 <ArrowRightOutlined /></button></div>
      </>}
      {tab === 'visitors' && <>{visitorPanel}<div className="surface help-panel"><SafetyOutlined /><div><h3>你始终拥有控制权</h3><p>位置标记不等于操作权限。每次连接默认关闭控制，断线会自动收回；同一时刻只允许一位访客操作。</p></div></div></>}
      {tab === 'settings' && <SettingsPanel state={state} port={port} setPort={setPort} videoBusy={videoBusy || starting} cursorBusy={cursorBusy} changeVideo={value => { void changeVideo(value); }} changeCursor={value => { void changeCursor(value); }} />}
    </main>
    <Modal title="选择要共享的窗口" open={picker} width={830} onCancel={() => setPicker(false)} footer={<><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void refresh(); }}>刷新窗口</Button><Button type="primary" disabled={!selected} onClick={() => setPicker(false)}>使用此窗口</Button></>}>
      <p className="picker-note">选择窗口名称即可。开始共享前，请恢复最小化的窗口。</p>
      <Input.Search aria-label="搜索窗口" placeholder="搜索窗口名称" value={windowSearch} onChange={e => setWindowSearch(e.target.value)} allowClear />
      {windowError && <Alert className="picker-error" type="error" showIcon title="读取窗口列表失败" description={windowError} />}
      {loading && <div className="picker-loading"><Spin size="small" /><span>正在读取窗口列表…</span></div>}
      <div className="window-list" aria-busy={loading}>{matchingWindows.map(item => <button key={item.id} title={item.name} aria-pressed={selected?.id === item.id} className={`window-choice ${selected?.id === item.id ? 'chosen' : ''}`} onClick={() => setSelected(item)}><div><DesktopOutlined /><span>{item.name}</span>{selected?.id === item.id && <CheckCircleFilled />}</div></button>)}{!loading && !windowError && !matchingWindows.length && <Empty description={windows.length ? '没有匹配的窗口' : '没有找到可共享窗口，请先打开一个应用'} />}</div>
    </Modal>
  </div>;
}
