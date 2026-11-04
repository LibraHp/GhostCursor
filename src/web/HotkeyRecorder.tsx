import { useEffect, useRef, useState } from 'react';
import { App, Button } from 'antd';
import { recordedShortcut } from '../shared/settings';

const api = window.ghost!;
export function HotkeyRecorder({ value }: { value: string }) {
  const [recording, setRecording] = useState(false), [saving, setSaving] = useState(false);
  const active = useRef(false), button = useRef<HTMLButtonElement>(null);
  const { message } = App.useApp();
  async function cancel() {
    if (!active.current) return;
    active.current = false; setRecording(false); await api.recordHotkey(false);
  }
  useEffect(() => {
    if (!recording) return;
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { void cancel(); return; }
      const shortcut = recordedShortcut(event); if (!shortcut || !active.current) return;
      active.current = false; setRecording(false); setSaving(true);
      void api.setHotkey(shortcut).then(() => message.success('快捷键已更新')).catch(e => message.error(String(e.message).replace(/^.*Error: /, ''))).finally(() => setSaving(false));
    };
    const blur = () => { void cancel(); };
    const timeout = setTimeout(() => { void cancel(); }, 25_000);
    window.addEventListener('keydown', keydown, true); window.addEventListener('blur', blur);
    return () => { clearTimeout(timeout); window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', blur); };
  }, [recording]);
  useEffect(() => () => { if (active.current) { active.current = false; void api.recordHotkey(false); } }, []);
  return <div className="hotkey-recorder"><Button ref={button} loading={saving} disabled={saving} className={recording ? 'recording' : ''} aria-label="录制控制快捷键" onBlur={() => { if (active.current) void cancel(); }} onClick={() => {
    if (recording) { void cancel(); return; }
    void api.recordHotkey(true).then(() => { active.current = true; setRecording(true); button.current?.focus(); }).catch(e => message.error(String(e.message)));
  }}>{recording ? '请按下快捷键…' : value.split('+').map((key, i) => <span key={i}><kbd>{key}</kbd>{i < value.split('+').length - 1 && <em>+</em>}</span>)}</Button><small>{recording ? '按下组合键即可保存，Esc 取消' : '点击后直接按下新的组合键'}</small></div>;
}
