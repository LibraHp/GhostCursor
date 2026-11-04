import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/electron/session';
import { ControlCoordinator } from '../src/electron/control';

function setup() {
  const session = new Session(); session.begin();
  session.visitors.set('alice', { id: 'alice', name: 'Alice', color: '#2563eb', connectedAt: 0 });
  session.select('alice');
  const calls: string[] = [];
  let grant: (value: { enabled: boolean }) => void = () => {};
  const control = new ControlCoordinator(session, {
    request: async type => {
      calls.push(type);
      if (type === 'activate') return {};
      return new Promise<{ enabled: boolean }>(resolve => { grant = resolve; });
    },
    send: (_type, payload) => { calls.push(`disable:${(payload as { epoch: number }).epoch}`); },
  }, () => calls.push('broadcast'));
  return { session, control, calls, confirm: (enabled: boolean) => grant({ enabled }) };
}

test('native confirmation is required before advertising control permission', async () => {
  const { session, control, calls, confirm } = setup();
  const granting = control.toggle(); await Promise.resolve();
  assert.equal(session.enabled, false); assert.equal(control.pending, true);
  assert.ok(calls.indexOf('activate') < calls.indexOf('grant'));
  confirm(true); await granting;
  assert.equal(session.enabled, true); assert.equal(control.pending, false);
});

test('cancelling an in-flight grant rejects a late confirmation', async () => {
  const { session, control, confirm } = setup();
  const granting = control.toggle(); await Promise.resolve();
  await control.toggle(); const cancelledEpoch = session.epoch;
  confirm(true); await granting;
  assert.equal(session.enabled, false); assert.equal(session.epoch, cancelledEpoch);
});

test('native denial and late native fault cannot leave UI permission enabled', async () => {
  const { session, control, confirm } = setup();
  const denied = control.toggle(); await Promise.resolve(); confirm(false);
  await assert.rejects(denied, /系统未确认/); assert.equal(session.enabled, false);
  const next = control.toggle(); await Promise.resolve(); confirm(true); await next;
  const epoch = session.epoch;
  control.nativeRevoked(epoch - 1, 'old event'); assert.equal(session.enabled, true);
  control.nativeRevoked(epoch, 'Windows 拒绝输入');
  assert.equal(session.enabled, false); assert.equal(session.controlReason, 'Windows 拒绝输入');
});

test('disconnect during native activation never grants a stale controller', async () => {
  const { session, control, confirm } = setup();
  const granting = control.toggle(); await Promise.resolve();
  session.remove('alice'); control.synchronize();
  confirm(true); await granting;
  assert.equal(session.enabled, false); assert.equal(session.controller, null);
});

test('touch location events are visible without input permission, even after granting', () => {
  const { session } = setup();
  const start = { type: 'touch-start', pointerType: 'touch', sessionId: session.id, epoch: session.epoch, x: .3, y: .4 };
  assert.equal(session.accept('alice', start)?.inject, false);
  session.toggle();
  assert.equal(session.accept('alice', { ...start, epoch: session.epoch })?.inject, false);
  assert.equal(session.accept('alice', { ...start, epoch: session.epoch, type: 'down', button: 0 })?.inject, true);
  assert.equal(session.accept('alice', { ...start, type: 'touch-end' })?.inject, false);
  assert.equal(session.accept('alice', { ...start, pointerType: 'mouse' }), null);
  assert.equal(session.accept('alice', { ...start, x: Number.NaN }), null);
});
