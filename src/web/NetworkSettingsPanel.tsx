import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, InputNumber, Radio, Switch } from 'antd';
import { validNetwork, type AutoStunResult, type NetworkSettings } from '../shared/network';

export function NetworkSettingsPanel({ value, sharing, autoStunResult }: { value: NetworkSettings; sharing: boolean; autoStunResult?: AutoStunResult }) {
  const [draft, setDraft] = useState(value), [saving, setSaving] = useState(false);
  const [stunText, setStunText] = useState(value.stunUrls.join('\n')), [turnText, setTurnText] = useState(value.turnUrls.join('\n'));
  const { message } = App.useApp();
  const savedValue = JSON.stringify(value);
  useEffect(() => { setDraft(value); setStunText(value.stunUrls.join('\n')); setTurnText(value.turnUrls.join('\n')); }, [savedValue]);
  const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  async function save() {
    const next = { ...draft, publicUrl: draft.publicUrl.trim(), mappedUdp: draft.transport === 'webrtc-mapped' ? { ...draft.mappedUdp, publicHost: draft.mappedUdp.publicHost.trim() } : value.mappedUdp, ...(draft.transport === 'webrtc' ? { stunUrls: draft.autoStun ? value.stunUrls : lines(stunText), turnUrls: lines(turnText) } : { stunUrls: value.stunUrls, turnUrls: value.turnUrls, username: value.username, credential: value.credential, relayOnly: value.relayOnly }) };
    if (!validNetwork(next)) { void message.error(draft.transport === 'webrtc-mapped' ? '请填写有效的公网 IPv4（不含协议和端口）、本机 UDP 端口（1024–65535）、公网 UDP 端口（1–65535），并检查公网邀请地址' : draft.transport === 'websocket' ? '请填写有效的公网地址，仅支持 http:// 或 https:// 域名根路径' : '请填写有效的公网地址和 STUN/TURN 地址；配置 TURN 时需填写账号和密码'); return; }
    setSaving(true);
    try { await window.ghost!.setNetwork(next); void message.success('外网连接设置已保存，下次共享生效'); }
    catch (e) { void message.error(String((e as Error).message)); }
    finally { setSaving(false); }
  }
  async function refresh() {
    setSaving(true);
    try { const result = await window.ghost!.refreshStun(); if (result.source === 'online') void message.success(result.message); else void message.warning(result.message); }
    catch (e) { void message.error(String((e as Error).message)); }
    finally { setSaving(false); }
  }
  return <div className="network-setting"><h3>外网与 FRP</h3><p>选择视频连接方式。通过 FRP 分享时，可使用 WebSocket 共用网页端口。</p>
    <fieldset disabled={sharing || saving}>
      <label>视频传输方式</label><Radio.Group aria-label="视频传输方式" optionType="button" buttonStyle="solid" disabled={sharing || saving} value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value })} options={[{ value: 'websocket', label: 'WebSocket · FRP 单端口' }, { value: 'webrtc', label: 'WebRTC · 低延迟' }, { value: 'webrtc-mapped', label: 'WebRTC · 固定 UDP' }]} />
      <label>公网邀请地址</label><Input aria-label="公网邀请地址" disabled={sharing || saving} placeholder="https://share.example.com 或 http://公网IP:端口" value={draft.publicUrl} onChange={e => setDraft({ ...draft, publicUrl: e.target.value })} />
      {draft.transport === 'webrtc-mapped' && <>
        <label>媒体映射的公网 IPv4</label><Input aria-label="媒体映射的公网 IPv4" disabled={sharing || saving} placeholder="例如 203.0.113.10（不含协议和端口）" value={draft.mappedUdp.publicHost} onChange={e => setDraft({ ...draft, mappedUdp: { ...draft.mappedUdp, publicHost: e.target.value } })} />
        <div className="turn-credentials"><div><label>本机媒体端口（UDP）</label><InputNumber aria-label="本机媒体端口 UDP" disabled={sharing || saving} min={1024} max={65535} precision={0} value={draft.mappedUdp.localPort} onChange={localPort => setDraft({ ...draft, mappedUdp: { ...draft.mappedUdp, localPort: localPort ?? 40000 } })} /></div><div><label>公网映射端口（UDP）</label><InputNumber aria-label="公网映射端口 UDP" disabled={sharing || saving} min={1} max={65535} precision={0} value={draft.mappedUdp.publicPort} onChange={publicPort => setDraft({ ...draft, mappedUdp: { ...draft.mappedUdp, publicPort: publicPort ?? 40000 } })} /></div></div>
        <p>需要分别转发网页 TCP 端口和媒体 UDP 端口，公网端口可与本机端口不同。此模式无需填写 STUN/TURN，一次仅支持一位访客；访客网络需允许 UDP。保存后重新开启共享，无需重启应用。</p>
      </>}
      {draft.transport === 'webrtc' && <>
      <div className="network-actions"><Switch aria-label="自动配置 STUN" disabled={sharing || saving} checked={draft.autoStun} onChange={autoStun => setDraft({ ...draft, autoStun })} /><span>自动配置 STUN</span><Button size="small" loading={saving} disabled={sharing || saving || !draft.autoStun || !value.autoStun || value.transport !== 'webrtc' || draft.relayOnly || value.relayOnly || JSON.stringify(draft) !== savedValue || stunText !== value.stunUrls.join('\n') || turnText !== value.turnUrls.join('\n')} onClick={() => { void refresh(); }}>立即更新</Button></div>
      {draft.autoStun && <p>保存或开始共享时自动从 always-online-stun 列表选择地址，缓存 1 小时，过期后在下次使用时更新；失败时使用缓存或默认地址。首次获取可能需要数秒。{draft.relayOnly ? '强制 TURN 中继已开启，暂不使用 STUN。' : autoStunResult ? `${autoStunResult.message}${autoStunResult.updatedAt ? ` · ${new Date(autoStunResult.updatedAt).toLocaleString()}` : ''}` : ''}</p>}
      <label>{draft.autoStun ? '当前 STUN 地址（自动管理）' : 'STUN 地址（每行一个）'}</label><Input.TextArea aria-label="STUN 地址" disabled={sharing || saving || draft.autoStun} rows={3} value={draft.autoStun ? value.stunUrls.join('\n') : stunText} onChange={e => setStunText(e.target.value)} placeholder="stun:stun.cloudflare.com:3478" />
      <label>TURN 中继地址（每行一个）</label><Input.TextArea aria-label="TURN 中继地址" disabled={sharing || saving} rows={2} value={turnText} onChange={e => setTurnText(e.target.value)} placeholder={'turn:turn.example.com:3478?transport=udp\nturn:turn.example.com:3478?transport=tcp'} />
      <div className="turn-credentials"><div><label>TURN 账号</label><Input aria-label="TURN 账号" disabled={sharing || saving} autoComplete="off" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} /></div><div><label>TURN 密码</label><Input.Password aria-label="TURN 密码" disabled={sharing || saving} autoComplete="new-password" value={draft.credential} onChange={e => setDraft({ ...draft, credential: e.target.value })} /></div></div>
      <div className="network-actions"><Switch aria-label="强制使用 TURN 中继" disabled={sharing || saving || !lines(turnText).length} checked={draft.relayOnly} onChange={relayOnly => setDraft({ ...draft, relayOnly })} /><span>强制使用 TURN 中继（适合 WebRTC 外网连接排查）</span></div></>}
      <Button type="primary" disabled={sharing || saving} loading={saving} onClick={() => { void save(); }}>保存外网设置</Button>
    </fieldset>
    {sharing && <p>请先停止共享，再修改外网连接设置。</p>}
    <Alert type="info" showIcon title={draft.transport === 'websocket' ? '视频和操作共用网页端口' : draft.transport === 'webrtc-mapped' ? '一个 TCP 网页端口 + 一个 UDP 媒体端口' : 'WebRTC 需要独立的视频连接'} description={draft.transport === 'websocket' ? '无需 STUN/TURN；FRP 映射当前服务端口，HTTP 反向代理需支持 /ws 的 WebSocket 转发。此模式缓冲延迟和编码开销较高，建议先用流畅 / 720p / 15 帧，访客使用新版 Edge 或 Chrome。' : draft.transport === 'webrtc-mapped' ? '路由器、Lucky 或 FRP 必须真正转发 UDP 到这台电脑的媒体端口，HTTP 反向代理和两个 TCP 映射无法代替。公网 IPv4 或映射端口变化后请更新设置并重新共享。连接失败时可改用 WebSocket。' : '自动 STUN 可帮助部分网络直连，检测成功仅表示主持人能收到 STUN 响应。仅映射网页端口不能保证 WebRTC 视频可达；直连失败时可改用 WebSocket，或配置 TURN 中继。'} />
  </div>;
}
