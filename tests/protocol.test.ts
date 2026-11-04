import test from 'node:test';
import assert from 'node:assert/strict';
import { validPointer, validSignal, videoPoint } from '../src/shared/protocol';
import { Session } from '../src/electron/session';

test('video mapping excludes letterboxing and handles scaling and offsets', () => {
  const box = { left: 100, top: 60, width: 1000, height: 1000 };
  assert.equal(videoPoint(600, 80, box, 1920, 1080), null);
  assert.deepEqual(videoPoint(600, 560, box, 1920, 1080), { x: .5, y: .5 });
  const edge = videoPoint(1100, 841.25, box, 1920, 1080)!;
  assert.ok(Math.abs(edge.x - 1) < 1e-12 && Math.abs(edge.y - 1) < 1e-12);
  assert.equal(videoPoint(600, 560, box, 0, 0), null);
  assert.deepEqual(videoPoint(600, 560, box, 600, 1200), { x: .5, y: .5 });
});

test('invalid coordinates, buttons, epochs, wheel values and SDP are rejected', () => {
  const pointer = { type: 'pointer', sessionId: 'test', epoch: 0, x: .2, y: .3 };
  assert.equal(validPointer(pointer), true);
  for (const patch of [{ x: NaN }, { y: Infinity }, { x: -1 }, { y: 1.01 }, { epoch: -1 }, { epoch: .1 }, { type: 'key' }]) assert.equal(validPointer({ ...pointer, ...patch }), false);
  assert.equal(validPointer({ ...pointer, type: 'down', button: 4 }), false);
  assert.equal(validPointer({ ...pointer, type: 'wheel', delta: 1201 }), false);
  assert.equal(validPointer({ ...pointer, type: 'wheel', delta: 120 }), true);
  assert.equal(validSignal({ type: 'offer', data: { type: 'answer', sdp: 'v=0' } }), false);
  assert.equal(validSignal({ type: 'ice', data: { candidate: 'candidate:...', sdpMLineIndex: -1 } }), false);
});

test('viewers can show positions without receiving control', () => {
  const session = new Session(); session.begin();
  session.visitors.set('alice', { id: 'alice', name: 'Alice', color: '#000000', connectedAt: 0 });
  const message = { type: 'pointer', sessionId: session.id, epoch: session.epoch, x: .5, y: .5 };
  assert.equal(session.accept('alice', message)?.inject, false);
  assert.equal(session.accept('alice', { ...message, type: 'down', button: 0 }), null);
  assert.equal(session.accept('unknown', message), null);
  assert.throws(() => session.toggle());
});

test('control is exclusive, old input is invalidated on revoke, disconnect and restart', () => {
  const session = new Session(); session.begin(); const oldToken = session.token, oldId = session.id;
  for (const id of ['alice', 'bob']) session.visitors.set(id, { id, name: id, color: '#000000', connectedAt: 0 });
  session.select('alice'); session.toggle();
  const click = { type: 'down', sessionId: session.id, epoch: session.epoch, x: .5, y: .5, button: 0 };
  assert.equal(session.accept('alice', click)?.inject, true);
  assert.equal(session.accept('bob', click), null);
  session.revoke(); session.toggle();
  assert.equal(session.accept('alice', click), null);
  assert.equal(session.accept('alice', { ...click, epoch: session.epoch })?.inject, true);
  session.remove('alice'); assert.equal(session.enabled, false); assert.equal(session.controller, null);
  session.end(); assert.equal(session.token, ''); assert.equal(session.accept('bob', click), null);
  session.begin(); assert.notEqual(session.token, oldToken); assert.notEqual(session.id, oldId);
  assert.equal(session.enabled, false); assert.equal(session.visitors.size, 0);
});
