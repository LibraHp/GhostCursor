import type { HostState, PointerMessage } from './protocol';
import { MAX_RELAY_CHUNK } from './relay';

export interface BrowserHostState extends HostState {
  companion: { connected: boolean; bound: boolean; platform?: string; reason: string };
  rtc?: RTCConfiguration;
}
export interface VisitorPointer {
  id: string; message: PointerMessage;
}
export const HOST_FRAME_HEADER_LIMIT = 512;
export function encodeHostFrame(metadata: { requestId: number; visitor: string; sessionId: string; streamId: number; sequence: number }, data: ArrayBuffer): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  if (json.length > HOST_FRAME_HEADER_LIMIT || !data.byteLength || data.byteLength > MAX_RELAY_CHUNK) throw new Error('无效视频分片');
  const bytes = new Uint8Array(4 + json.length + data.byteLength);
  new DataView(bytes.buffer).setUint32(0, json.length);
  bytes.set(json, 4); bytes.set(new Uint8Array(data), json.length + 4);
  return bytes.buffer;
}
export function decodeHostFrame(packet: ArrayBuffer): { metadata: Record<string, unknown>; data: ArrayBuffer } | null {
  if (packet.byteLength < 6 || packet.byteLength > MAX_RELAY_CHUNK + HOST_FRAME_HEADER_LIMIT + 4) return null;
  const length = new DataView(packet).getUint32(0);
  if (length < 2 || length > HOST_FRAME_HEADER_LIMIT || length + 4 >= packet.byteLength) return null;
  try {
    const metadata = JSON.parse(new TextDecoder().decode(packet.slice(4, length + 4)));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    return { metadata, data: packet.slice(length + 4) };
  } catch { return null; }
}
// A normal browser cannot enumerate native windows or map arbitrary titles
// reliably. Enable native features ONLY when Chromium exposes an exact window
// capture identifier; opaque labels keep the session in browser-only mode.
export function captureWindowId(label: string): string | null {
  const match = /^window:(\d+):\d+$/.exec(label);
  return match && BigInt(match[1]) > 0n ? `window:${match[1]}:0` : null;
}
