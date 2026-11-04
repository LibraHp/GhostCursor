import { Alert, ColorPicker, InputNumber, Radio, Select, Segmented, Tag } from 'antd';
import type { HostState } from '../shared/protocol';
import { VIDEO_PRESETS, presetSettings, type VideoSettings, type VideoPreset, type FrameRate, type CursorSettings } from '../shared/settings';
import { HotkeyRecorder } from './HotkeyRecorder';
import { CursorGlyph } from './CursorGlyph';

export function VideoControls({ value, busy, change }: { value: VideoSettings; busy: boolean; change: (value: VideoSettings) => void }) {
  return <div className="video-controls"><Select aria-label="画质预设" value={value.preset} disabled={busy} onChange={(preset: VideoPreset) => change(presetSettings(preset))} options={Object.entries(VIDEO_PRESETS).map(([value, preset]) => ({ value, label: `${preset.label} · ${preset.height}p` }))} />
    <Select aria-label="共享帧率" value={value.fps} disabled={busy} onChange={(fps: FrameRate) => change({ ...value, fps })} options={[15, 24, 30, 60].map(value => ({ value, label: `${value} 帧/秒` }))} /></div>;
}

export function SettingsPanel({ state, port, setPort, videoBusy, cursorBusy, changeVideo, changeCursor }: {
  state: HostState; port: number; setPort: (value: number) => void; videoBusy: boolean; cursorBusy: boolean;
  changeVideo: (value: VideoSettings) => void; changeCursor: (value: CursorSettings) => void;
}) {
  return <div className="surface settings-panel">
    <div className="setting-row"><div><h3>共享画质与帧率</h3><p>可在共享中切换；分辨率为上限，实际清晰度取决于窗口与网络。</p></div><VideoControls value={state.video} busy={videoBusy} change={changeVideo} /></div>
    <div className="setting-row"><div><h3>全局控制快捷键</h3><p>点击右侧，再直接按下组合键。Esc 取消。</p></div><HotkeyRecorder value={state.hotkey} /></div>
    <div className="cursor-setting"><div className="setting-row"><div><h3>鼠标样式</h3><p>应用到本机和访客画面；控制时仅显示带控制者名称的指针。</p></div><div className="cursor-preview"><CursorGlyph settings={state.cursor} color="#2563eb" name="控制者" /></div></div>
      <div className="cursor-options"><label>形状</label><Radio.Group aria-label="鼠标形状" disabled={cursorBusy} optionType="button" buttonStyle="solid" value={state.cursor.shape} onChange={e => changeCursor({ ...state.cursor, shape: e.target.value })} options={[{ value: 'arrow', label: '箭头' }, { value: 'ring', label: '圆环' }, { value: 'crosshair', label: '十字' }]} />
        <label>大小</label><Segmented aria-label="鼠标大小" disabled={cursorBusy} value={state.cursor.size} onChange={size => changeCursor({ ...state.cursor, size: size as 24 | 32 | 44 })} options={[{ value: 24, label: '小' }, { value: 32, label: '中' }, { value: 44, label: '大' }]} />
        <label>颜色</label><div className="cursor-color"><Radio.Group disabled={cursorBusy} value={state.cursor.color ? 'custom' : 'visitor'} onChange={e => changeCursor({ ...state.cursor, color: e.target.value === 'visitor' ? null : '#2563eb' })} options={[{ value: 'visitor', label: '跟随访客' }, { value: 'custom', label: '自定义' }]} />{state.cursor.color && <ColorPicker aria-label="鼠标颜色" disabled={cursorBusy} value={state.cursor.color} disabledAlpha onChangeComplete={color => changeCursor({ ...state.cursor, color: color.toHexString() })} showText />}</div>
      </div><div className="cursor-style-note">触摸与笔输入使用圆形落点；控制者名称始终保留。</div>
    </div>
    <div className="setting-row"><div><h3>Web 服务端口</h3><p>同一局域网中的设备可通过邀请链接加入。</p></div><InputNumber aria-label="Web 服务端口" min={1024} max={65535} value={port} disabled={state.sharing} onChange={value => setPort(value || 3210)} /></div>
    <div className="setting-row"><div><h3>Windows 原生组件</h3><p>用于绘制访客标记和处理授权后的鼠标输入。</p></div><Tag color={state.nativeReady ? 'success' : 'processing'}>{state.nativeReady ? '已就绪' : '连接中 / 不可用'}</Tag></div>
    <Alert type="info" showIcon title="当前版本优先支持局域网" description="访客与本机需处于可互通的网络。如连接失败，请确认 Windows 防火墙允许 GhostCursor 的专用网络连接。" />
  </div>;
}
