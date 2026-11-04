import type { GhostBridge, HostEvent, Signal } from '../shared/protocol';

type Peer = { pc: RTCPeerConnection; channel: RTCDataChannel; candidates: RTCIceCandidateInit[]; chain: Promise<void> };
export class HostMedia {
  private peers = new Map<string, Peer>();
  private waiting = new Set<string>();
  private stream?: MediaStream;
  private unsubscribe: () => void;
  constructor(private api: GhostBridge, private onError: (text: string) => void) {
    this.unsubscribe = api.onEvent(event => this.event(event));
  }
  async capture() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    const track = this.stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => { void this.api.stop(); this.stop(); }, { once: true });
    const state = await this.api.state();
    for (const v of state.visitors) this.waiting.add(v.id);
    for (const id of this.waiting) void this.connect(id);
    this.waiting.clear();
    return this.stream;
  }
  private event(event: HostEvent) {
    if (event.type === 'visitor-joined') { if (this.stream) void this.connect(event.visitor.id); else this.waiting.add(event.visitor.id); }
    if (event.type === 'visitor-left') { this.waiting.delete(event.id); this.peers.get(event.id)?.pc.close(); this.peers.delete(event.id); }
    if (event.type === 'signal') {
      const peer = this.peers.get(event.id); if (!peer) return;
      peer.chain = peer.chain.then(() => this.receive(peer, event.signal)).catch(() => { this.api.disconnect(event.id).catch(() => {}); });
    }
  }
  private async connect(id: string) {
    if (!this.stream || this.peers.has(id)) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel('cursor', { ordered: true });
    const peer: Peer = { pc, channel, candidates: [], chain: Promise.resolve() };
    this.peers.set(id, peer);
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 2048) return;
      try { this.api.pointer(id, JSON.parse(event.data)); } catch {}
    };
    pc.onicecandidate = event => { if (event.candidate) this.api.signal(id, { type: 'ice', data: event.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') void this.api.disconnect(id); };
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      if (this.peers.get(id) === peer) this.api.signal(id, { type: 'offer', data: pc.localDescription!.toJSON() });
    } catch (e) { pc.close(); this.peers.delete(id); this.onError(`视频连接失败：${(e as Error).message}`); void this.api.disconnect(id); }
  }
  private async receive(peer: Peer, signal: Signal) {
    if (signal.type === 'answer') {
      await peer.pc.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
      for (const candidate of peer.candidates) await peer.pc.addIceCandidate(candidate);
      peer.candidates = [];
    } else if (signal.type === 'ice') {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.data as RTCIceCandidateInit);
      else peer.candidates.push(signal.data as RTCIceCandidateInit);
    }
  }
  stop() {
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear(); this.waiting.clear();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
  }
  dispose() { this.stop(); this.unsubscribe(); }
}
