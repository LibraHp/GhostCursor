import type { GhostBridge, HostEvent, Signal } from '../shared/protocol';
import { DEFAULT_VIDEO, VIDEO_PRESETS, videoConstraints, initialVideoConstraints, type VideoSettings } from '../shared/settings';
import { DEFAULT_NETWORK, connectionFailure, rtcConfiguration, type NetworkSettings } from '../shared/network';
import { mappedCandidate } from '../shared/mapped-ice';
import { RelaySender } from './relay-sender';

type Peer = { pc: RTCPeerConnection; channel: RTCDataChannel; candidates: RTCIceCandidateInit[]; chain: Promise<void>; timeout?: ReturnType<typeof setTimeout> };
export class HostMedia {
  private peers = new Map<string, Peer>();
  private waiting = new Set<string>();
  private stream?: MediaStream;
  private unsubscribe: () => void;
  private settings: VideoSettings = { ...DEFAULT_VIDEO };
  private network: NetworkSettings = DEFAULT_NETWORK;
  private relays = new Map<string, RelaySender>();
  private relayWaiting = new Map<string, string[]>();
  private ready = false;
  private sessionId = '';
  private generation = 0;
  private frame = { width: 0, height: 0 };
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private configuring: Promise<void> = Promise.resolve();
  constructor(private api: GhostBridge, private onError: (text: string) => void) {
    this.unsubscribe = api.onEvent(event => this.event(event));
  }
  async capture(selectedStream?: MediaStream) {
    const generation = ++this.generation;
    const state = await this.api.state();
    if (generation !== this.generation || !state.sharing) throw new Error('共享已停止');
    this.settings = state.video;
    this.network = state.network;
    this.sessionId = state.sessionId;
    const stream = selectedStream || await navigator.mediaDevices.getDisplayMedia({ video: initialVideoConstraints(state.video), audio: false });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error('共享已停止'); }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => { if (this.stream === stream) { void this.api.stop(); this.stop(); } }, { once: true });
    await this.configure(state.video);
    if (generation !== this.generation) throw new Error('共享已停止');
    const dimensions = track.getSettings();
    this.frame = { width: dimensions.width || 0, height: dimensions.height || 0 };
    this.ready = true;
    if (this.network.transport === 'websocket') {
      for (const [id, mimeTypes] of this.relayWaiting) this.connectRelay(id, mimeTypes);
    } else {
      for (const v of state.visitors) this.waiting.add(v.id);
      for (const id of this.waiting) void this.connect(id);
    }
    this.relayWaiting.clear();
    this.waiting.clear();
    return stream;
  }
  configure(value: VideoSettings) {
    const generation = this.generation, stream = this.stream;
    const work = this.configuring.catch(() => {}).then(async () => {
      if (generation !== this.generation) return;
      const previous = this.settings;
      try {
        await stream?.getVideoTracks()[0]?.applyConstraints(videoConstraints(value));
        if (generation !== this.generation) return;
        for (const peer of this.peers.values()) await this.configureSender(peer.pc, value);
        if (generation !== this.generation) return;
        this.settings = { ...value };
        clearTimeout(this.resizeTimer);
        const dimensions = stream?.getVideoTracks()[0]?.getSettings();
        if (dimensions?.width && dimensions.height) this.frame = { width: dimensions.width, height: dimensions.height };
        for (const relay of this.relays.values()) relay.reconfigure(value);
      } catch (error) {
        if (generation !== this.generation) return;
        await stream?.getVideoTracks()[0]?.applyConstraints(videoConstraints(previous)).catch(() => {});
        for (const peer of this.peers.values()) await this.configureSender(peer.pc, previous).catch(() => {});
        throw new Error(`画质切换失败：${(error as Error).message}`);
      }
    });
    this.configuring = work; return work;
  }
  frameChanged(width: number, height: number) {
    if (!this.ready || (width === this.frame.width && height === this.frame.height)) return;
    this.frame = { width, height }; clearTimeout(this.resizeTimer);
    if (this.network.transport === 'websocket') this.resizeTimer = setTimeout(() => {
      if (this.ready) for (const relay of this.relays.values()) relay.reconfigure(this.settings);
    }, 300);
  }
  private async configureSender(pc: RTCPeerConnection, value: VideoSettings) {
    for (const sender of pc.getSenders().filter(s => s.track?.kind === 'video')) {
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      for (const encoding of params.encodings) { encoding.maxBitrate = VIDEO_PRESETS[value.preset].bitrate; encoding.maxFramerate = value.fps; }
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    }
  }
  private event(event: HostEvent) {
    if (event.type === 'visitor-joined') { if (this.ready && this.network.transport !== 'websocket') void this.connect(event.visitor.id); else if (!this.ready) this.waiting.add(event.visitor.id); }
    if (event.type === 'relay-ready') { if (this.ready) this.connectRelay(event.id, event.mimeTypes); else this.relayWaiting.set(event.id, event.mimeTypes); }
    if (event.type === 'visitor-left') { this.waiting.delete(event.id); this.relayWaiting.delete(event.id); this.relays.get(event.id)?.stop(); this.relays.delete(event.id); const peer = this.peers.get(event.id); clearTimeout(peer?.timeout); peer?.pc.close(); this.peers.delete(event.id); }
    if (event.type === 'signal') {
      const peer = this.peers.get(event.id); if (!peer) return;
      peer.chain = peer.chain.then(() => this.receive(peer, event.signal)).catch(() => { this.api.disconnect(event.id).catch(() => {}); });
    }
  }
  private connectRelay(id: string, mimeTypes: string[]) {
    if (!this.stream || this.network.transport !== 'websocket') return;
    this.relays.get(id)?.stop(); this.relays.delete(id);
    try {
      const relay = new RelaySender(this.api, id, this.sessionId, this.stream, this.settings, mimeTypes, this.onError);
      this.relays.set(id, relay); void relay.start();
    } catch (e) { this.onError((e as Error).message); void this.api.disconnect(id, (e as Error).message); }
  }
  private async connect(id: string) {
    if (!this.stream || this.peers.has(id)) return;
    const pc = new RTCPeerConnection(rtcConfiguration(this.network));
    const channel = pc.createDataChannel('cursor', { ordered: true });
    const peer: Peer = { pc, channel, candidates: [], chain: Promise.resolve() };
    this.peers.set(id, peer);
    const fail = (reason = connectionFailure(this.network.transport)) => {
      if (this.peers.get(id) !== peer) return;
      clearTimeout(peer.timeout); this.peers.delete(id); pc.close();
      this.onError(reason); void this.api.disconnect(id, reason).catch(() => {});
    };
    peer.timeout = setTimeout(() => fail(), 45000);
    channel.onopen = () => clearTimeout(peer.timeout);
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 2048) return;
      try { this.api.pointer(id, JSON.parse(event.data)); } catch {}
    };
    let advertised = false;
    const published = new Set<string>();
    pc.onicecandidate = event => {
      if (this.peers.get(id) !== peer || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      this.api.signal(id, { type: 'ice', data: candidate });
      if (this.network.transport === 'webrtc-mapped') {
        const mapped = mappedCandidate(candidate, this.network.mappedUdp);
        const key = mapped ? `${mapped.sdpMid}:${mapped.sdpMLineIndex}:${mapped.usernameFragment}` : '';
        if (mapped && !published.has(key)) {
          published.add(key); advertised = true;
          this.api.signal(id, { type: 'ice', data: mapped });
        }
      }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && this.network.transport === 'webrtc-mapped' && !advertised) fail('未获得固定端口的 IPv4 UDP 候选地址。请确认本机端口未被占用、IPv4 可用，停止共享后重试或改用 WebSocket。');
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail();
      if (pc.connectionState === 'connected') void this.configureSender(pc, this.settings).catch(e => this.onError((e as Error).message));
    };
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      if (this.peers.get(id) === peer) this.api.signal(id, { type: 'offer', data: pc.localDescription!.toJSON() });
    } catch (e) { if (this.peers.get(id) === peer) fail(`视频连接失败：${(e as Error).message}`); }
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
    this.ready = false; this.generation++; clearTimeout(this.resizeTimer); this.frame = { width: 0, height: 0 };
    for (const relay of this.relays.values()) relay.stop();
    this.relays.clear(); this.relayWaiting.clear();
    for (const peer of this.peers.values()) { clearTimeout(peer.timeout); peer.pc.close(); }
    this.peers.clear(); this.waiting.clear();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
  }
  dispose() { this.stop(); this.unsubscribe(); }
}
