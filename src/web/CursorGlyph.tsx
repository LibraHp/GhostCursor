import type { CSSProperties } from 'react';
import type { CursorSettings } from '../shared/settings';

export function CursorGlyph({ settings, color, name, touch = false, className = '', style }: {
  settings: CursorSettings; color: string; name?: string; touch?: boolean; className?: string; style?: CSSProperties;
}) {
  const shape = touch ? 'ring' : settings.shape;
  const tint = settings.color || color;
  return <span className={`named-cursor cursor-${shape} ${className}`} style={{ color: tint, ...style }} aria-hidden="true">
    <svg width={settings.size} height={settings.size} viewBox="0 0 32 32" className="cursor-glyph">
      {shape === 'arrow' ? <path d="M2 2 3 26 9 20 14 31 19 28 14 18 23 17Z" fill="currentColor" stroke="white" strokeWidth="1.4" /> : shape === 'ring' ? <><circle cx="16" cy="16" r="13" fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth="2" /><circle cx="16" cy="16" r="3" fill="currentColor" stroke="white" /></> : <><path d="M16 1V11M16 21V31M1 16H11M21 16H31" stroke="white" strokeWidth="4" /><path d="M16 1V11M16 21V31M1 16H11M21 16H31" stroke="currentColor" strokeWidth="2" /><circle cx="16" cy="16" r="3" fill="currentColor" stroke="white" /></>}
    </svg>
    {name && <span className="cursor-name" style={{ background: tint, top: shape === 'arrow' ? settings.size + 4 : settings.size / 2 + 8 }}>{name}</span>}
  </span>;
}
