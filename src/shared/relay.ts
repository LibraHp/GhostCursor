export const RELAY_MIME_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4;codecs=avc1.42E01E'] as const;
export const MAX_RELAY_CHUNK = 256 * 1024;
export const MAX_RELAY_BUFFER = 8 * 1024 * 1024;
export const RELAY_HEADER_SIZE = 12;
const MAGIC = 0x47435631;
export function validRelayMime(value: unknown): value is string { return typeof value === 'string' && (RELAY_MIME_TYPES as readonly string[]).includes(value); }
export function packRelayChunk(streamId: number, sequence: number, data: ArrayBuffer): Uint8Array {
  const packet = new Uint8Array(RELAY_HEADER_SIZE + data.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, MAGIC); view.setUint32(4, streamId); view.setUint32(8, sequence);
  packet.set(new Uint8Array(data), RELAY_HEADER_SIZE); return packet;
}
export function unpackRelayChunk(packet: ArrayBuffer): { streamId: number; sequence: number; data: ArrayBuffer } | null {
  if (packet.byteLength <= RELAY_HEADER_SIZE || packet.byteLength > MAX_RELAY_CHUNK + RELAY_HEADER_SIZE) return null;
  const view = new DataView(packet);
  if (view.getUint32(0) !== MAGIC) return null;
  return { streamId: view.getUint32(4), sequence: view.getUint32(8), data: packet.slice(RELAY_HEADER_SIZE) };
}
