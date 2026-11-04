import { Session } from './session';

interface NativeControl {
  request(type: string, payload?: object): Promise<{ enabled?: boolean; reason?: string }>;
  send(type: string, payload: object): void;
}
type Attempt = { sessionId: string; controller: string; epoch: number; granting: boolean };

// Permission is advertised only after the native process confirms the same epoch.
// A second toggle, disconnect, target change or native rejection cancels an in-flight grant.
export class ControlCoordinator {
  private attempt: Attempt | null = null;
  get pending() { return this.attempt !== null; }
  constructor(private session: Session, private native: NativeControl, private changed: () => void) {}
  private current(a: Attempt) {
    return this.attempt === a && this.session.active && this.session.id === a.sessionId &&
      this.session.controller === a.controller && this.session.visitors.has(a.controller) && this.session.epoch === a.epoch;
  }
  synchronize() {
    this.attempt = null;
    this.native.send('grant', { enabled: false, controller: this.session.controller, epoch: this.session.epoch });
    this.changed();
  }
  revoke(reason?: string) { this.session.revoke(reason); this.synchronize(); }
  nativeRevoked(epoch: number, reason: string) {
    if (epoch === this.session.epoch && (this.session.enabled || this.attempt?.granting)) this.revoke(reason);
  }
  async toggle() {
    if (this.session.enabled || this.pending) { this.revoke(); return; }
    if (!this.session.active || !this.session.controller || !this.session.visitors.has(this.session.controller)) throw new Error('请先选择一位在线访客');
    const a: Attempt = { sessionId: this.session.id, controller: this.session.controller, epoch: this.session.epoch, granting: false };
    this.attempt = a; this.changed();
    try {
      await this.native.request('activate');
      if (!this.current(a)) return;
      a.epoch = this.session.prepareGrant(); a.granting = true;
      const result = await this.native.request('grant', { enabled: true, controller: a.controller, epoch: a.epoch });
      if (!this.current(a)) return;
      if (!result.enabled) throw new Error(result.reason || '系统未确认控制授权，请重试');
      this.session.commitGrant(a.epoch);
      this.attempt = null; this.changed();
    } catch (error) {
      if (!this.current(a)) return;
      this.revoke((error as Error).message);
      throw error;
    } finally { if (this.attempt === a) { this.attempt = null; this.changed(); } }
  }
}
