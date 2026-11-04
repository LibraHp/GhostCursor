import { useEffect, useRef, useState } from 'react';
import { Alert, App, Avatar, Button, Input, Spin, Tag } from 'antd';
import { ArrowRightOutlined, DesktopOutlined, DisconnectOutlined, ExpandOutlined, EyeOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { videoPoint, type PointerMessage, type Signal } from '../shared/protocol';
import { DEFAULT_CURSOR, DEFAULT_VIDEO, validCursor, validVideo, VIDEO_PRESETS, type Presentation } from '../shared/settings';
import { CursorGlyph } from './CursorGlyph';

export function Viewer() {
  const { message } = App.useApp();
  const [name, setName] = useState(''), [joined, setJoined] = useState(false), [connected, setConnected] = useState(false);
  const [status, setStatus] = useState(''), [color, setColor] = useState('#2563eb'), [canControl, setCanControl] = useState(false);
  const [controlReason, setControlReason] = useState('等待主持人开启控制');
  const [touchIndicator, setTouchIndicator] = useState<{ x: number; y: number } | null>(null);
  const [presentation, setPresentation] = useState<Presentation>({ video: DEFAULT_VIDEO, cursor: DEFAULT_CURSOR });
  const [hasController, setHasController] = useState(false);
  const [controlledCursor, setControlledCursor] = useState<{ id: string; name: string; color: string; x: number; y: number; visible: boolean; pointerType?: string } | null>(null);
  const [videoArea, setVideoArea] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const video = useRef<HTMLVideoElement>(null), stage = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null), pc = useRef<RTCPeerConnection | null>(null), channel = useRef<RTCDataChannel | null>(null);
  const identity = useRef({ id: '', name: '', color: '#2563eb', sessionId: '', epoch: 0, control: false });
  const point = useRef<{ x: number; y: number } | null>(null);
  const activePointer = useRef<{ id: number; type: 'mouse' | 'touch' | 'pen' } | null>(null);
  const lastSent = useRef(0), raf = useRef(0);
  const token = useRef(location.hash.slice(1));
  function send(type: PointerMessage['type'], extra: Partial<PointerMessage> = {}) {
    const ch = channel.current;
    if (!ch || ch.readyState !== 'open') return;
    if (!['pointer', 'leave', 'touch-start', 'touch-end'].includes(type) && !identity.current.control) return;
    if (ch.bufferedAmount > 16_384) { ch.close(); socket.current?.close(); return; }
    ch.send(JSON.stringify({ type, sessionId: identity.current.sessionId, epoch: identity.current.epoch, pointerType: activePointer.current?.type || 'mouse', ...point.current, ...extra }));
    if (identity.current.control) {
      const visible = !['leave', 'release', 'touch-end'].includes(type);
      if (point.current) setControlledCursor({ id: identity.current.id, name: identity.current.name, color: identity.current.color, ...point.current, visible, pointerType: extra.pointerType || activePointer.current?.type || 'mouse' });
      else if (!visible) setControlledCursor(previous => previous ? { ...previous, visible: false } : null);
    }
    lastSent.current = performance.now();
  }
  function end(text: string) {
    point.current = null; activePointer.current = null; setTouchIndicator(null); setControlledCursor(null); setHasController(false); identity.current.control = false; setCanControl(false); setConnected(false);
    channel.current?.close(); channel.current = null; pc.current?.close(); pc.current = null;
    socket.current?.close(); socket.current = null; setStatus(text);
    if (video.current) video.current.srcObject = null;
  }
  function join() {
    if (!token.current) { setStatus('邀请链接缺少凭据，请向主持人索取完整链接。'); return; }
    if (!window.RTCPeerConnection) { setStatus('此浏览器不支持 WebRTC，请使用新版 Edge 或 Chrome。'); return; }
    end('正在连接主持人…'); setJoined(true);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket.current = ws;
    const peer = new RTCPeerConnection({ iceServers: [] }); pc.current = peer;
    let candidates: RTCIceCandidateInit[] = [], chain = Promise.resolve();
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    function signal(value: Signal) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
    peer.onicecandidate = event => { if (event.candidate) signal({ type: 'ice', data: event.candidate.toJSON() }); };
    peer.ontrack = event => {
      if (video.current) { video.current.srcObject = event.streams[0] || new MediaStream([event.track]); void video.current.play().catch(() => setStatus('请点击画面开始播放')); }
    };
    peer.ondatachannel = event => {
      channel.current = event.channel;
      event.channel.onopen = () => { setConnected(true); setStatus(''); };
      event.channel.onclose = () => { if (socket.current === ws) end('连接已断开，可以重新加入。'); };
    };
    peer.onconnectionstatechange = () => {
      clearTimeout(disconnectTimer);
      if (peer.connectionState === 'failed') { if (socket.current === ws) end('视频连接失败，请确认双方网络可互通。'); }
      if (peer.connectionState === 'disconnected') disconnectTimer = setTimeout(() => { if (socket.current === ws) end('网络连接已中断，请重新加入。'); }, 5000);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token: token.current, name: name.trim() }));
    ws.onerror = () => { if (socket.current === ws) end('无法连接服务，请确认共享仍在运行。'); };
    ws.onclose = event => {
      clearTimeout(disconnectTimer);
      if (socket.current === ws) end(event.reason || '共享已结束或连接已断开。');
    };
    ws.onmessage = event => {
      chain = chain.then(async () => {
        if (socket.current !== ws) return;
        const data = JSON.parse(event.data);
        if (data.type === 'welcome') { identity.current = { id: data.id, name: data.name, color: data.color, sessionId: data.sessionId, epoch: 0, control: false }; setColor(data.color); setStatus('正在建立视频连接…'); }
        else if (data.type === 'control') {
          const allow = !!data.enabled && data.controller === identity.current.id;
          identity.current.control = allow; identity.current.epoch = data.epoch;
          setCanControl(allow);
          setHasController(!!data.enabled);
          setControlledCursor(null);
          setControlReason(data.enabled && data.controller !== identity.current.id ? '主持人已授权另一位访客' : data.reason || '等待主持人开启控制');
        } else if (data.type === 'presentation' && validVideo(data.video) && validCursor(data.cursor)) {
          setPresentation({ video: data.video, cursor: data.cursor });
        } else if (data.type === 'controller-cursor') {
          if (data.id !== identity.current.id && typeof data.name === 'string' && typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color) && Number.isFinite(data.x) && Number.isFinite(data.y) && data.x >= 0 && data.x <= 1 && data.y >= 0 && data.y <= 1) setControlledCursor(data);
          else if (data.id !== identity.current.id && !data.visible) setControlledCursor(previous => previous ? { ...previous, visible: false } : null);
        } else if (data.type === 'offer') {
          await peer.setRemoteDescription(data.data);
          for (const candidate of candidates) await peer.addIceCandidate(candidate);
          candidates = [];
          await peer.setLocalDescription(await peer.createAnswer());
          signal({ type: 'answer', data: peer.localDescription!.toJSON() });
        } else if (data.type === 'ice') {
          if (peer.remoteDescription) await peer.addIceCandidate(data.data); else if (candidates.length < 128) candidates.push(data.data);
        } else if (data.type === 'ended') end('主持人已结束共享。');
      }).catch(() => { if (socket.current === ws) end('连接协商失败，请重新加入。'); });
    };
  }
  useEffect(() => {
    const timer = setInterval(() => { if (point.current && performance.now() - lastSent.current > 400) send('pointer'); }, 400);
    const release = () => { send('release'); send('leave'); point.current = null; activePointer.current = null; setTouchIndicator(null); };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); cancelAnimationFrame(raf.current); release(); socket.current?.close(); pc.current?.close(); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    const el = video.current, container = stage.current; if (!el || !container) return;
    const measure = () => {
      if (!el.videoWidth || !el.videoHeight) return;
      const box = el.getBoundingClientRect(), root = container.getBoundingClientRect();
      const scale = Math.min(box.width / el.videoWidth, box.height / el.videoHeight);
      const width = el.videoWidth * scale, height = el.videoHeight * scale;
      setVideoArea({ left: box.left - root.left + (box.width - width) / 2, top: box.top - root.top + (box.height - height) / 2, width, height });
    };
    const observer = new ResizeObserver(measure); observer.observe(el);
    el.addEventListener('loadedmetadata', measure); el.addEventListener('resize', measure);
    return () => { observer.disconnect(); el.removeEventListener('loadedmetadata', measure); el.removeEventListener('resize', measure); };
  }, [joined]);
  function locate(clientX: number, clientY: number) {
    const el = video.current;
    return el && el.readyState >= 2 ? videoPoint(clientX, clientY, el.getBoundingClientRect(), el.videoWidth, el.videoHeight) : null;
  }
  function isTouch(type: string) { return type === 'touch' || type === 'pen'; }
  function showTouch(clientX: number, clientY: number) {
    const bounds = stage.current?.getBoundingClientRect();
    if (bounds) setTouchIndicator({ x: clientX - bounds.left, y: clientY - bounds.top });
  }
  function finishPointer(event: React.PointerEvent<HTMLVideoElement>, cancelled = false) {
    const active = activePointer.current;
    if (active && active.id !== event.pointerId) return;
    const touch = isTouch(event.pointerType);
    if (touch && !active) return;
    const next = locate(event.clientX, event.clientY);
    if (next) point.current = next;
    if (touch) {
      if (point.current) send('touch-end');
      if (cancelled || !next) send('release'); else send('up', { button: 0 });
      send('leave'); point.current = null; setTouchIndicator(null);
    } else if (cancelled || !next) { send('release'); send('leave'); point.current = null; }
    else send('up', { button: event.button });
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  useEffect(() => {
    const el = video.current; if (!el) return;
    const wheel = (event: WheelEvent) => {
      point.current = locate(event.clientX, event.clientY);
      if (!point.current || !identity.current.control) return;
      event.preventDefault();
      const delta = Math.max(-1200, Math.min(1200, event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1)));
      send('wheel', { delta: Math.round(delta) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [joined]);
  return <div className="viewer-shell"><header className="viewer-header"><div className="brand-mark"><span className="cursor-logo" />GhostCursor</div><div className="viewer-header-right"><Tag bordered={false} color={connected ? 'success' : 'default'}>{connected ? '已连接' : '等待连接'}</Tag>{joined && connected && <Avatar size="small" style={{ background: color }}>{name.slice(0, 1) || '访'}</Avatar>}</div></header>
    {!joined ? <main className="join-main"><div className="surface join-card"><div className="join-icon"><DesktopOutlined /></div><div className="eyebrow">一起看，一起协作</div><h1>窗口的另一边，<br />也有你的参与。</h1><p>加入共享，实时观看对方的应用窗口。<br />移动鼠标，让对方看见你指向的位置。</p><label htmlFor="visitor-name">如何称呼你</label><Input id="visitor-name" size="large" maxLength={24} value={name} placeholder="输入你的名字（可选）" onChange={e => setName(e.target.value)} onPressEnter={join} /><Button size="large" block type="primary" icon={<ArrowRightOutlined />} onClick={join}>加入共享</Button>{status && <Alert type="error" showIcon title={status} />}<div className="join-note"><LockOutlined /> 默认仅观看，操作权限由主持人决定</div></div><small className="viewer-footnote">GhostCursor · 窗口共享，轻松协作</small></main> : <main className="watch-main"><div className="watch-toolbar"><div><span className={`status-dot ${connected ? 'on' : ''}`} /><strong>共享画面</strong></div><div><Tag color={canControl ? 'blue' : 'default'} icon={canControl ? <SafetyOutlined /> : <EyeOutlined />}>{canControl ? '你已获得鼠标控制权限' : '观看与位置标记'}</Tag><Button icon={<ExpandOutlined />} onClick={() => { void stage.current?.requestFullscreen().catch(() => message.info('浏览器暂不支持全屏')); }}>全屏</Button><Button icon={<DisconnectOutlined />} onClick={() => { end('你已离开共享。'); setJoined(false); }}>离开</Button></div></div>
      <div ref={stage} className={`video-stage ${canControl ? 'controlling' : ''} ${hasController ? 'single-cursor' : ''}`}>
        <video ref={video} autoPlay muted playsInline onContextMenu={e => e.preventDefault()} onClick={() => { void video.current?.play().catch(() => {}); }}
          onPointerMove={e => {
            if (activePointer.current && activePointer.current.id !== e.pointerId) return;
            if (isTouch(e.pointerType) && !activePointer.current) return;
            const next = locate(e.clientX, e.clientY);
            if (!next) { if (point.current) { send('release'); send('leave'); } point.current = null; setTouchIndicator(null); return; }
            point.current = next;
            if (isTouch(e.pointerType)) showTouch(e.clientX, e.clientY);
            if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; if (point.current) send('pointer', { pointerType: isTouch(e.pointerType) ? e.pointerType as 'touch' | 'pen' : 'mouse' }); });
          }}
          onPointerLeave={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) return; send('release'); send('leave'); point.current = null; setTouchIndicator(null); }}
          onPointerDown={e => {
            if (activePointer.current && activePointer.current.id !== e.pointerId) return;
            point.current = locate(e.clientX, e.clientY); if (!point.current) return;
            activePointer.current = { id: e.pointerId, type: isTouch(e.pointerType) ? e.pointerType as 'touch' | 'pen' : 'mouse' };
            e.preventDefault();
            if (isTouch(e.pointerType)) { e.currentTarget.setPointerCapture(e.pointerId); showTouch(e.clientX, e.clientY); send('touch-start'); }
            else send('pointer');
            if (identity.current.control) { e.currentTarget.setPointerCapture(e.pointerId); send('down', { button: isTouch(e.pointerType) ? 0 : e.button }); }
          }}
          onPointerUp={e => finishPointer(e)}
          onPointerCancel={e => finishPointer(e, true)}
          onLostPointerCapture={e => { if (activePointer.current?.id === e.pointerId) finishPointer(e, true); }}
        />
        {hasController && controlledCursor?.visible && <CursorGlyph className="controller-cursor" settings={presentation.cursor} color={controlledCursor.color} name={controlledCursor.name} touch={controlledCursor.pointerType === 'touch' || controlledCursor.pointerType === 'pen'} style={{ left: videoArea.left + controlledCursor.x * videoArea.width, top: videoArea.top + controlledCursor.y * videoArea.height }} />}
        {!hasController && touchIndicator && <span className="touch-indicator" style={{ left: touchIndicator.x, top: touchIndicator.y, borderColor: presentation.cursor.color || color, color: presentation.cursor.color || color }} aria-hidden="true" />}
        {!connected && <div className="video-message">{socket.current ? <Spin size="large" /> : <DesktopOutlined />}<h3>{status || '等待画面…'}</h3>{!socket.current && <Button type="primary" onClick={join}>重新加入</Button>}</div>}
      </div><div className="viewer-tip"><span className="status-dot" style={{ background: color }} />{canControl ? '已授权：鼠标或触摸可操作共享窗口，主持人可随时收回控制。' : `${controlReason}。鼠标移动或手指触摸只显示位置，不执行操作。`}<span className="viewer-quality">{VIDEO_PRESETS[presentation.video.preset].label} · {presentation.video.fps} 帧/秒</span></div>
    </main>}
  </div>;
}
