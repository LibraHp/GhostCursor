export interface NetworkSettings {
  transport: 'webrtc' | 'websocket';
  publicUrl: string;
  stunUrls: string[];
  turnUrls: string[];
  username: string;
  credential: string;
  relayOnly: boolean;
}
export const DEFAULT_NETWORK: NetworkSettings = {
  transport: 'websocket', publicUrl: '', stunUrls: ['stun:stun.cloudflare.com:3478'], turnUrls: [], username: '', credential: '', relayOnly: false,
};
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
  if (!n || !['webrtc', 'websocket'].includes(n.transport) || typeof n.publicUrl !== 'string' || n.publicUrl.length > 2048 || !validUrls(n.stunUrls, false) || !validUrls(n.turnUrls, true) || typeof n.username !== 'string' || n.username.length > 512 || typeof n.credential !== 'string' || n.credential.length > 2048 || typeof n.relayOnly !== 'boolean') return false;
  if (n.transport === 'webrtc' && n.turnUrls.length && (!n.username || !n.credential)) return false;
  if (n.transport === 'webrtc' && n.relayOnly && !n.turnUrls.length) return false;
  try { publicOrigin(n.publicUrl); return true; } catch { return false; }
}
export function storedNetwork(value: unknown): NetworkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const migrated = { ...value, transport: (value as NetworkSettings).transport ?? 'webrtc' };
  return validNetwork(migrated) ? migrated : null;
}
export function rtcConfiguration(n: NetworkSettings): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  if (n.stunUrls.length) iceServers.push({ urls: [...n.stunUrls] });
  if (n.turnUrls.length) iceServers.push({ urls: [...n.turnUrls], username: n.username, credential: n.credential });
  return { iceServers, iceTransportPolicy: n.relayOnly ? 'relay' : 'all' };
}
export const NETWORK_FAILURE = '网页已连接，但视频连接失败。FRP 仅映射网页端口不足以转发视频，请检查 TURN 地址、账号和端口；配置后重新开始共享。';
