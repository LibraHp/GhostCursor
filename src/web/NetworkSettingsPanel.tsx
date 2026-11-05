import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Radio, Switch } from 'antd';
import { validNetwork, type NetworkSettings } from '../shared/network';

export function NetworkSettingsPanel({ value, sharing }: { value: NetworkSettings; sharing: boolean }) {
  const [draft, setDraft] = useState(value), [saving, setSaving] = useState(false);
  const [stunText, setStunText] = useState(value.stunUrls.join('\n')), [turnText, setTurnText] = useState(value.turnUrls.join('\n'));
  const { message } = App.useApp();
  const savedValue = JSON.stringify(value);
  useEffect(() => { setDraft(value); setStunText(value.stunUrls.join('\n')); setTurnText(value.turnUrls.join('\n')); }, [savedValue]);
  const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  async function save() {
    const next = { ...draft, publicUrl: draft.publicUrl.trim(), ...(draft.transport === 'webrtc' ? { stunUrls: lines(stunText), turnUrls: lines(turnText) } : { stunUrls: value.stunUrls, turnUrls: value.turnUrls, username: value.username, credential: value.credential, relayOnly: value.relayOnly }) };
    if (!validNetwork(next)) { void message.error(draft.transport === 'websocket' ? '请填写有效的公网地址，仅支持 http:// 或 https:// 域名根路径' : '请填写有效的公网地址和 STUN/TURN 地址；配置 TURN 时需填写账号和密码'); return; }
    setSaving(true);
    try { await window.ghost!.setNetwork(next); void message.success('外网连接设置已保存，下次共享生效'); }
    catch (e) { void message.error(String((e as Error).message)); }
    finally { setSaving(false); }
  }
  return <div className="network-setting"><h3>外网与 FRP</h3><p>选择视频连接方式。通过 FRP 分享时，可使用 WebSocket 共用网页端口。</p>
    <fieldset disabled={sharing || saving}>
      <label>视频传输方式</label><Radio.Group aria-label="视频传输方式" optionType="button" buttonStyle="solid" disabled={sharing || saving} value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value })} options={[{ value: 'websocket', label: 'WebSocket · FRP 单端口' }, { value: 'webrtc', label: 'WebRTC · 低延迟' }]} />
      <label>公网邀请地址</label><Input aria-label="公网邀请地址" disabled={sharing || saving} placeholder="https://share.example.com 或 http://公网IP:端口" value={draft.publicUrl} onChange={e => setDraft({ ...draft, publicUrl: e.target.value })} />
      {draft.transport === 'webrtc' && <><label>STUN 地址（每行一个）</label><Input.TextArea aria-label="STUN 地址" disabled={sharing || saving} rows={2} value={stunText} onChange={e => setStunText(e.target.value)} placeholder="stun:stun.cloudflare.com:3478" />
      <label>TURN 中继地址（每行一个）</label><Input.TextArea aria-label="TURN 中继地址" disabled={sharing || saving} rows={2} value={turnText} onChange={e => setTurnText(e.target.value)} placeholder={'turn:turn.example.com:3478?transport=udp\nturn:turn.example.com:3478?transport=tcp'} />
      <div className="turn-credentials"><div><label>TURN 账号</label><Input aria-label="TURN 账号" disabled={sharing || saving} autoComplete="off" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} /></div><div><label>TURN 密码</label><Input.Password aria-label="TURN 密码" disabled={sharing || saving} autoComplete="new-password" value={draft.credential} onChange={e => setDraft({ ...draft, credential: e.target.value })} /></div></div>
      <div className="network-actions"><Switch aria-label="强制使用 TURN 中继" disabled={sharing || saving || !lines(turnText).length} checked={draft.relayOnly} onChange={relayOnly => setDraft({ ...draft, relayOnly })} /><span>强制使用 TURN 中继（适合 WebRTC 外网连接排查）</span></div></>}
      <Button type="primary" disabled={sharing || saving} loading={saving} onClick={() => { void save(); }}>保存外网设置</Button>
    </fieldset>
    {sharing && <p>请先停止共享，再修改外网连接设置。</p>}
    <Alert type="info" showIcon title={draft.transport === 'websocket' ? '视频和操作共用网页端口' : 'WebRTC 需要独立的视频连接'} description={draft.transport === 'websocket' ? '无需 STUN/TURN；FRP 映射当前服务端口，HTTP 反向代理需支持 /ws 的 WebSocket 转发。此模式缓冲延迟和编码开销较高，建议先用流畅 / 720p / 15 帧，访客使用新版 Edge 或 Chrome。' : '默认 STUN 可帮助部分网络直连；仅映射网页端口不能保证 WebRTC 视频可达。直连失败时请配置两端均可访问的 TURN 中继。'} />
  </div>;
}
