import { randomBytes, randomUUID } from 'node:crypto';
import { validPointer, type PointerMessage, type Visitor } from '../shared/protocol';
export class Session {
  id = ''; token = ''; epoch = 0; active = false;
  visitors = new Map<string, Visitor>(); controller: string | null = null; enabled = false;
  controlReason = '等待主持人开启控制';
  begin() { this.end(); this.id = randomUUID(); this.token = randomBytes(32).toString('base64url'); this.active = true; this.controlReason = '等待主持人开启控制'; }
  end() { this.revoke(); this.active = false; this.token = ''; this.id = ''; this.controller = null; this.visitors.clear(); }
  revoke(reason = '主持人已关闭控制') { this.enabled = false; this.epoch++; this.controlReason = reason; }
  select(id: string | null) {
    if (id !== null && !this.visitors.has(id)) throw new Error('访客已离线');
    this.revoke(id ? '已选定控制者，等待主持人开启控制' : '等待主持人选择控制者'); this.controller = id;
  }
  toggle() {
    if (this.enabled) return this.revoke();
    if (!this.active || !this.controller || !this.visitors.has(this.controller)) throw new Error('请先选择一位在线访客');
    this.epoch++; this.enabled = true;
    this.controlReason = '';
  }
  prepareGrant() {
    if (!this.active || !this.controller || !this.visitors.has(this.controller)) throw new Error('请先选择一位在线访客');
    this.enabled = false; return ++this.epoch;
  }
  commitGrant(epoch: number) {
    if (epoch !== this.epoch || !this.active || !this.controller || !this.visitors.has(this.controller)) return false;
    this.enabled = true; this.controlReason = ''; return true;
  }
  remove(id: string) {
    this.visitors.delete(id);
    if (this.controller === id) { this.revoke('控制者已断开连接'); this.controller = null; }
  }
  accept(id: string, value: unknown): { message: PointerMessage; inject: boolean } | null {
    if (!this.active || !this.visitors.has(id) || !validPointer(value) || value.sessionId !== this.id) return null;
    const displayOnly = value.type === 'touch-start' || value.type === 'touch-end';
    const inject = !displayOnly && this.enabled && this.controller === id && value.epoch === this.epoch;
    if (!['pointer', 'leave', 'touch-start', 'touch-end'].includes(value.type) && !inject) return null;
    return { message: value, inject };
  }
}
