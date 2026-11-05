import { Alert, App, Button, ColorPicker, InputNumber, Radio, Select, Segmented, Tag } from 'antd';
import type { HostState } from '../shared/protocol';
import { VIDEO_PRESETS, RESOLUTIONS, presetSettings, type VideoSettings, type VideoPreset, type VideoResolution, type FrameRate, type CursorSettings } from '../shared/settings';
import { HotkeyRecorder } from './HotkeyRecorder';
import { CursorGlyph } from './CursorGlyph';
import type { GraphicsMode } from '../shared/graphics';
import { useState } from 'react';
import { NetworkSettingsPanel } from './NetworkSettingsPanel';

export function VideoControls({ value, busy, change }: { value: VideoSettings; busy: boolean; change: (value: VideoSettings) => void }) {
  return <div className="video-controls"><Select aria-label="画质预设" value={value.preset} disabled={busy} onChange={(preset: VideoPreset) => change(presetSettings(preset))} options={Object.entries(VIDEO_PRESETS).map(([value, preset]) => ({ value, label: preset.label }))} />
    <Select className="resolution-select" aria-label="共享分辨率" value={value.resolution} disabled={busy} onChange={(resolution: VideoResolution) => change({ ...value, resolution })} options={Object.entries(RESOLUTIONS).map(([value, resolution]) => ({ value, label: resolution.label }))} />
    <Select aria-label="共享帧率" value={value.fps} disabled={busy} onChange={(fps: FrameRate) => change({ ...value, fps })} options={[15, 24, 30, 60].map(value => ({ value, label: `${value} 帧/秒` }))} /></div>;
}

export function SettingsPanel({ state, port, setPort, videoBusy, cursorBusy, changeVideo, changeCursor }: {
  state: HostState; port: number; setPort: (value: number) => void; videoBusy: boolean; cursorBusy: boolean;
  changeVideo: (value: VideoSettings) => void; changeCursor: (value: CursorSettings) => void;
}) {
  const [graphicsBusy, setGraphicsBusy] = useState(false);
  const { message } = App.useApp();
  const graphicsError = (e: unknown) => { void message.error(String((e as Error).message)); };
  async function changeGraphics(mode: GraphicsMode) {
    setGraphicsBusy(true);
    try { await window.ghost!.setGraphics(mode); } catch (e) { graphicsError(e); }
    finally { setGraphicsBusy(false); }
  }
  return <div className="surface settings-panel">
    <div className="graphics-setting"><div><h3>图形兼容模式</h3><p>整个界面、下拉框或页面切换卡顿时可尝试兼容模式。自动模式在 Windows 10 使用兼容渲染。</p><p>当前：{state.graphics.compatibility ? '兼容模式 · 硬件加速已关闭' : '硬件加速模式'}。兼容模式可能增加视频处理的 CPU 占用。</p></div>
      <Radio.Group aria-label="图形模式" disabled={graphicsBusy} value={state.graphics.mode} onChange={e => { void changeGraphics(e.target.value); }} options={[{ value: 'auto', label: '自动' }, { value: 'compatibility', label: '兼容' }, { value: 'hardware', label: '硬件加速' }]} />
      <div className="graphics-actions">{state.graphics.restartRequired && <><span>已保存，重启后生效{state.sharing ? '；重启会结束当前共享' : ''}。</span><Button onClick={() => { void window.ghost!.restart().catch(graphicsError); }}>重启 GhostCursor</Button></>}<Button type="link" onClick={() => { void window.ghost!.copyGraphicsDiagnostics().then(() => message.success('图形诊断已复制')).catch(graphicsError); }}>复制图形诊断</Button></div>
    </div>
    <div className="setting-row video-setting-row"><div><h3>分辨率与画质</h3><p>共享中可独立切换分辨率和帧率，保持窗口比例。高分屏卡顿时建议选择 720p、15 帧/秒。</p><p>预设会重置分辨率与帧率；原始分辨率随窗口大小变化。</p></div><VideoControls value={state.video} busy={videoBusy} change={changeVideo} /></div>
    <div className="setting-row"><div><h3>全局控制快捷键</h3><p>点击右侧，再直接按下组合键。Esc 取消。</p></div><HotkeyRecorder value={state.hotkey} /></div>
    <div className="cursor-setting"><div className="setting-row"><div><h3>鼠标样式</h3><p>应用到本机和访客画面；控制时仅显示带控制者名称的指针。</p></div><div className="cursor-preview"><CursorGlyph settings={state.cursor} color="#2563eb" name="控制者" /></div></div>
      <div className="cursor-options"><label>形状</label><Radio.Group aria-label="鼠标形状" disabled={cursorBusy} optionType="button" buttonStyle="solid" value={state.cursor.shape} onChange={e => changeCursor({ ...state.cursor, shape: e.target.value })} options={[{ value: 'arrow', label: '箭头' }, { value: 'ring', label: '圆环' }, { value: 'crosshair', label: '十字' }]} />
        <label>大小</label><Segmented aria-label="鼠标大小" disabled={cursorBusy} value={state.cursor.size} onChange={size => changeCursor({ ...state.cursor, size: size as 24 | 32 | 44 })} options={[{ value: 24, label: '小' }, { value: 32, label: '中' }, { value: 44, label: '大' }]} />
        <label>颜色</label><div className="cursor-color"><Radio.Group disabled={cursorBusy} value={state.cursor.color ? 'custom' : 'visitor'} onChange={e => changeCursor({ ...state.cursor, color: e.target.value === 'visitor' ? null : '#2563eb' })} options={[{ value: 'visitor', label: '跟随访客' }, { value: 'custom', label: '自定义' }]} />{state.cursor.color && <ColorPicker aria-label="鼠标颜色" disabled={cursorBusy} value={state.cursor.color} disabledAlpha onChangeComplete={color => changeCursor({ ...state.cursor, color: color.toHexString() })} showText />}</div>
      </div><div className="cursor-style-note">触摸与笔输入使用圆形落点；控制者名称始终保留。</div>
    </div>
    <div className="setting-row"><div><h3>Web 服务端口</h3><p>同一局域网中的设备可通过邀请链接加入。</p></div><InputNumber aria-label="Web 服务端口" min={1024} max={65535} value={port} disabled={state.sharing} onChange={value => setPort(value || 3210)} /></div>
    <NetworkSettingsPanel value={state.network} sharing={state.sharing} />
    <div className="setting-row"><div><h3>Windows 原生组件</h3><p>用于绘制访客标记和处理授权后的鼠标输入。</p></div><Tag color={state.nativeReady ? 'success' : 'processing'}>{state.nativeReady ? '已就绪' : '连接中 / 不可用'}</Tag></div>
    <Alert type="info" showIcon title="连接方式" description="局域网可使用邀请链接；FRP 外网访问可选择 WebSocket 共用网页端口，无需 TURN。WebRTC 模式直连失败时可配置 TURN。Windows 防火墙需允许 GhostCursor 的网络连接。" />
  </div>;
}
