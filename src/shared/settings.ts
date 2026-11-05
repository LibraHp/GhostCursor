export const VIDEO_PRESETS = {
  smooth: { label: '流畅', width: 1280, height: 720, fps: 15, bitrate: 1_500_000, description: '720p · 节省带宽' },
  hd: { label: '高清', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, description: '1080p · 清晰均衡' },
  ultra: { label: '超清', width: 2560, height: 1440, fps: 60, bitrate: 10_000_000, description: '1440p · 更多细节' },
} as const;
export type VideoPreset = keyof typeof VIDEO_PRESETS;
export type FrameRate = 15 | 24 | 30 | 60;
export const RESOLUTIONS = {
  '720p': { label: '720p · 1280 × 720', width: 1280, height: 720 },
  '1080p': { label: '1080p · 1920 × 1080', width: 1920, height: 1080 },
  '1440p': { label: '1440p · 2560 × 1440', width: 2560, height: 1440 },
  '2160p': { label: '4K · 3840 × 2160', width: 3840, height: 2160 },
  original: { label: '原始窗口分辨率', width: 0, height: 0 },
} as const;
export type VideoResolution = keyof typeof RESOLUTIONS;
export interface VideoSettings { preset: VideoPreset; fps: FrameRate; resolution: VideoResolution }
export type CursorShape = 'arrow' | 'ring' | 'crosshair';
export interface CursorSettings { shape: CursorShape; size: 24 | 32 | 44; color: string | null }
export interface Presentation { video: VideoSettings; cursor: CursorSettings }
export const DEFAULT_VIDEO: VideoSettings = { preset: 'hd', fps: 30, resolution: '1080p' };
export const DEFAULT_CURSOR: CursorSettings = { shape: 'arrow', size: 32, color: null };
export function validVideo(value: unknown): value is VideoSettings {
  const v = value as VideoSettings;
  return !!v && Object.hasOwn(VIDEO_PRESETS, v.preset) && [15, 24, 30, 60].includes(v.fps) && Object.hasOwn(RESOLUTIONS, v.resolution);
}
export function validCursor(value: unknown): value is CursorSettings {
  const c = value as CursorSettings;
  return !!c && ['arrow', 'ring', 'crosshair'].includes(c.shape) && [24, 32, 44].includes(c.size) &&
    (c.color === null || (typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color)));
}
export function presetSettings(preset: VideoPreset): VideoSettings { return { preset, fps: VIDEO_PRESETS[preset].fps, resolution: `${VIDEO_PRESETS[preset].height}p` as VideoResolution }; }
export function storedVideo(value: unknown): VideoSettings | null {
  if (validVideo(value)) return value;
  const old = value as VideoSettings;
  if (old && old.resolution === undefined && Object.hasOwn(VIDEO_PRESETS, old.preset) && [15, 24, 30, 60].includes(old.fps)) return { ...presetSettings(old.preset), fps: old.fps };
  return null;
}
export function videoConstraints(value: VideoSettings): MediaTrackConstraints {
  const p = RESOLUTIONS[value.resolution];
  return { ...(p.width ? { width: { max: p.width }, height: { max: p.height } } : {}), frameRate: { ideal: value.fps, max: value.fps }, cursor: 'never' } as MediaTrackConstraints;
}
export function initialVideoConstraints(value: VideoSettings): MediaTrackConstraints {
  const p = RESOLUTIONS[value.resolution];
  // getDisplayMedia only accepts ideals for the initial size request.
  return { ...(p.width ? { width: { ideal: p.width }, height: { ideal: p.height } } : {}), frameRate: { ideal: value.fps }, cursor: 'never' } as MediaTrackConstraints;
}

export type ShortcutInput = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat' | 'isComposing'>;
export function recordedShortcut(event: ShortcutInput): string | null {
  if (event.repeat || event.isComposing) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code : '';
  const mods = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean);
  return key && mods.length ? [...mods, key].join('+') : null;
}
export function validShortcut(value: unknown): value is string {
  if (typeof value !== 'string' || !/^((Ctrl|Alt|Shift|Super)\+){1,4}(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(value)) return false;
  const parts = value.split('+'); return new Set(parts).size === parts.length;
}
