export interface MappedUdp { localPort: number; publicHost: string; publicPort: number }
export interface NetworkSettings {
  transport: 'webrtc' | 'websocket' | 'webrtc-mapped';
  mappedUdp: MappedUdp;
  autoStun: boolean;
  publicUrl: string;
  stunUrls: string[];
  turnUrls: string[];
  username: string;
  credential: string;
  relayOnly: boolean;
}
export const DEFAULT_NETWORK: NetworkSettings = {
  transport: 'websocket', mappedUdp: { localPort: 40000, publicHost: '', publicPort: 40000 }, autoStun: true, publicUrl: '', stunUrls: ['stun:stun.cloudflare.com:3478'], turnUrls: [], username: '', credential: '', relayOnly: false,
};
export function validIpv4(value: string): boolean {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every(n => n <= 255) && octets[0] > 0 && octets[0] < 224 && octets[0] !== 127;
}
function validMappedUdp(value: unknown, required: boolean): value is MappedUdp {
  const m = value as MappedUdp;
  return !!m && Number.isInteger(m.localPort) && m.localPort >= 1024 && m.localPort <= 65535 && Number.isInteger(m.publicPort) && m.publicPort >= 1 && m.publicPort <= 65535 && typeof m.publicHost === 'string' && (m.publicHost === '' ? !required : validIpv4(m.publicHost));
}
export function transportLabel(transport: NetworkSettings['transport']): string {
  return transport === 'websocket' ? 'WebSocket' : transport === 'webrtc-mapped' ? 'WebRTC · 固定 UDP' : 'WebRTC';
}
export function connectionFailure(transport: NetworkSettings['transport']): string {
  return transport === 'webrtc-mapped' ? '网页已连接，但固定 UDP 视频连接失败。请检查公网 IPv4、UDP 端口映射、本机端口占用及防火墙；访客网络需允许 UDP。也可改用 WebSocket。' : NETWORK_FAILURE;
}
function validUrls(value: unknown, turn: boolean): value is string[] {
  return Array.isArray(value) && value.length <= 8 && value.every(url => typeof url === 'string' && url.length <= 512 &&
    (turn ? /^turns?:[a-z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/i : /^stuns?:[a-z0-9.\-[\]:]+$/i).test(url));
}
export function publicOrigin(value: string): string {
  if (!value.trim()) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('公网地址请填写完整的 http:// 或 https:// 地址，仅支持域名根路径');
  return url.origin;
}
export function validNetwork(value: unknown): value is NetworkSettings {
  const n = value as NetworkSettings;
  if (!n || !['webrtc', 'websocket', 'webrtc-mapped'].includes(n.transport) || !validMappedUdp(n.mappedUdp, n.transport === 'webrtc-mapped') || typeof n.autoStun !== 'boolean' || typeof n.publicUrl !== 'string' || n.publicUrl.length > 2048 || !validUrls(n.stunUrls, false) || !validUrls(n.turnUrls, true) || typeof n.username !== 'string' || n.username.length > 512 || typeof n.credential !== 'string' || n.credential.length > 2048 || typeof n.relayOnly !== 'boolean') return false;
  if (n.transport === 'webrtc' && n.turnUrls.length && (!n.username || !n.credential)) return false;
  if (n.transport === 'webrtc' && n.relayOnly && !n.turnUrls.length) return false;
  try { publicOrigin(n.publicUrl); return true; } catch { return false; }
}
export function storedNetwork(value: unknown): NetworkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const old = value as NetworkSettings;
  const migrated = { ...value, transport: old.transport ?? 'webrtc', mappedUdp: old.mappedUdp ?? { ...DEFAULT_NETWORK.mappedUdp }, autoStun: old.autoStun ?? (Array.isArray(old.stunUrls) && old.stunUrls.length === 1 && old.stunUrls[0] === DEFAULT_NETWORK.stunUrls[0]) };
  return validNetwork(migrated) ? migrated : null;
}
export interface AutoStunResult { urls: string[]; source: 'online' | 'cache' | 'fallback'; updatedAt: number; message: string }
export function rtcConfiguration(n: NetworkSettings): RTCConfiguration {
  if (n.transport === 'webrtc-mapped') return { iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
  const iceServers: RTCIceServer[] = [];
  if (n.stunUrls.length) iceServers.push({ urls: [...n.stunUrls] });
  if (n.turnUrls.length) iceServers.push({ urls: [...n.turnUrls], username: n.username, credential: n.credential });
  return { iceServers, iceTransportPolicy: n.relayOnly ? 'relay' : 'all' };
}
export const NETWORK_FAILURE = '网页已连接，但视频连接失败。FRP 仅映射网页端口不足以转发视频，请检查 TURN 地址、账号和端口；配置后重新开始共享。';
