import type { VideoSettings, CursorSettings } from './settings';
import type { GraphicsMode, GraphicsState } from './graphics';
import type { NetworkSettings } from './network';

export interface WindowSource { id: string; name: string; thumbnail: string }
export interface Visitor { id: string; name: string; color: string; connectedAt: number }
export interface HostState {
  sharing: boolean; sessionId: string; visitors: Visitor[]; controller: string | null;
  controlEnabled: boolean; epoch: number; links: string[]; port: number;
  controlPending: boolean; controlReason: string;
  video: VideoSettings; cursor: CursorSettings;
  graphics: GraphicsState;
  network: NetworkSettings;
  sourceName: string; hotkey: string; nativeReady: boolean; targetAvailable: boolean; error: string;
}
export type PointerMessage = {
  type: 'pointer' | 'down' | 'up' | 'wheel' | 'leave' | 'release' | 'touch-start' | 'touch-end';
  sessionId: string; epoch: number; x?: number; y?: number; button?: number; delta?: number;
  pointerType?: 'mouse' | 'touch' | 'pen';
};
export type Signal = { type: 'offer' | 'answer' | 'ice'; data: unknown };
export type HostEvent = { type: 'visitor-joined'; visitor: Visitor } |
  { type: 'relay-ready'; id: string; mimeTypes: string[] } |
  { type: 'visitor-left'; id: string } | { type: 'signal'; id: string; signal: Signal } |
  { type: 'native-status'; available: boolean; reason: string };
export interface GhostBridge {
  state(): Promise<HostState>; sources(): Promise<WindowSource[]>;
  start(options: { sourceId: string; port: number }): Promise<HostState>;
  stop(): Promise<void>; selectController(id: string | null): Promise<void>;
  toggleControl(): Promise<void>; setHotkey(value: string): Promise<void>;
  recordHotkey(recording: boolean): Promise<void>;
  setVideo(value: VideoSettings): Promise<void>;
  setCursor(value: CursorSettings): Promise<void>;
  setGraphics(mode: GraphicsMode): Promise<void>;
  setNetwork(value: NetworkSettings): Promise<void>;
  restart(): Promise<void>; copyGraphicsDiagnostics(): Promise<void>;
  disconnect(id: string, reason?: string): Promise<void>;
  diagnostics(): Promise<{ successfulInputs: number; visibleMarkers: number; available: boolean; reason: string }>;
  signal(id: string, signal: Signal): void; pointer(id: string, message: unknown): void;
  relayStart(id: string, sessionId: string, streamId: number, mime: string): Promise<boolean>;
  relayChunk(id: string, sessionId: string, streamId: number, sequence: number, data: ArrayBuffer): Promise<boolean>;
  frameSize(width: number, height: number): void;
  copy(text: string): Promise<void>;
  onState(callback: (state: HostState) => void): () => void;
  onEvent(callback: (event: HostEvent) => void): () => void;
  close(): void; minimize(): void;
}
declare global { interface Window { ghost?: GhostBridge } }

export function validSignal(value: unknown): value is Signal {
  if (!value || typeof value !== 'object') return false;
  const s = value as Signal;
  if (s.type === 'offer' || s.type === 'answer') {
    const d = s.data as RTCSessionDescriptionInit;
    return !!d && d.type === s.type && typeof d.sdp === 'string' && d.sdp.length <= 100_000;
  }
  if (s.type === 'ice') {
    const d = s.data as RTCIceCandidateInit;
    return !!d && typeof d.candidate === 'string' && d.candidate.length < 4096 &&
      (d.sdpMid == null || typeof d.sdpMid === 'string') &&
      (d.sdpMLineIndex == null || (Number.isInteger(d.sdpMLineIndex) && d.sdpMLineIndex >= 0));
  }
  return false;
}

export function validPointer(value: unknown): value is PointerMessage {
  if (!value || typeof value !== 'object') return false;
  const p = value as PointerMessage;
  if (typeof p.sessionId !== 'string' || !Number.isSafeInteger(p.epoch) || p.epoch < 0) return false;
  if (p.pointerType !== undefined && !['mouse', 'touch', 'pen'].includes(p.pointerType)) return false;
  if (p.type === 'leave' || p.type === 'release') return true;
  if (!['pointer', 'down', 'up', 'wheel', 'touch-start', 'touch-end'].includes(p.type)) return false;
  if ((p.type === 'touch-start' || p.type === 'touch-end') && p.pointerType !== 'touch' && p.pointerType !== 'pen') return false;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false;
  if ((p.type === 'down' || p.type === 'up') && ![0, 1, 2].includes(p.button!)) return false;
  if (p.type === 'wheel' && (typeof p.delta !== 'number' || !Number.isFinite(p.delta) || Math.abs(p.delta) > 1200)) return false;
  return true;
}

// Convert a point in an object-fit:contain video to normalized capture coordinates.
export function videoPoint(px: number, py: number, box: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale, h = height * scale;
  const x = (px - box.left - (box.width - w) / 2) / w;
  const y = (py - box.top - (box.height - h) / 2) / h;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
