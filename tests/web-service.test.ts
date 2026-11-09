import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { WebService } from '../src/service/service';
import { encodeHostFrame } from '../src/shared/browser-service';
import { unpackRelayChunk } from '../src/shared/relay';

const key = 'unit-test-deployment-host-secret';
test('browser host authentication, viewer isolation, video forwarding and credential invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-web-service-'));
  await writeFile(join(root, 'index.html'), '<h1>GhostCursor Web</h1>');
  const service = new WebService({ webRoot: root, hostKey: key, port: 0, bind: '127.0.0.1' });
  const sockets: WebSocket[] = [];
  try {
    const address = await service.listen();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${origin}/host`)).status, 200);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    const connect = async (path: string) => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + path, { origin });
      sockets.push(ws); await once(ws, 'open'); return ws;
    };
    const denied = await connect('/host-ws');
    const deniedClose = once(denied, 'close'); denied.send(JSON.stringify({ type: 'host-auth', key: 'wrong' }));
    assert.equal((await deniedClose)[0], 4003);
    const host = await connect('/host-ws');
    const authenticated = once(host, 'message'); host.send(JSON.stringify({ type: 'host-auth', key }));
    assert.equal(JSON.parse((await authenticated)[0].toString()).type, 'host-ready');
    let serial = 0;
    const call = (method: string, args: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { host.off('message', receive); reject(new Error('No host response')); }, 3000);
      function receive(raw: any, binary: boolean) {
        if (binary) return;
        const data = JSON.parse(raw.toString()); if (data.type !== 'result' || data.id !== id) return;
        clearTimeout(timer); host.off('message', receive); data.error ? reject(new Error(data.error)) : resolve(data.value);
      }
      host.on('message', receive); host.send(JSON.stringify({ type: 'call', id, method, args }));
    });
    const state = await call('start', { name: 'Dedicated test window', sourceId: null });
    const invitation = new URL(state.links[0]);
    const viewer = await connect('/ws');
    const welcome = once(viewer, 'message'); viewer.send(JSON.stringify({ type: 'join', token: invitation.hash.slice(1), name: 'Alice' }));
    const visitor = JSON.parse((await welcome)[0].toString());
    await assert.rejects(call('toggle-control'), /辅助程序/);
    await assert.rejects(call('select-controller', { visitor: visitor.id }), /辅助程序/);
    assert.equal(service.session.enabled, false);
    const reset = once(viewer, 'message');
    assert.equal(await call('relay-start', { visitor: visitor.id, sessionId: state.sessionId, streamId: 7, mime: 'video/webm;codecs=vp8' }), true);
    await reset;
    const binary = new Promise<Buffer>(resolve => {
      const receive = (raw: Buffer, binary: boolean) => { if (binary) { viewer.off('message', receive); resolve(raw); } }; viewer.on('message', receive);
    });
    host.send(encodeHostFrame({ requestId: ++serial, visitor: visitor.id, sessionId: state.sessionId, streamId: 7, sequence: 0 }, new Uint8Array([1, 2, 3]).buffer));
    const raw = await binary;
    const chunk = unpackRelayChunk(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)!;
    assert.equal(chunk.streamId, 7); assert.deepEqual([...new Uint8Array(chunk.data)], [1, 2, 3]);
    await call('stop');
    assert.equal(service.session.active, false);
    const stale = await connect('/ws'); const staleClose = once(stale, 'close');
    stale.send(JSON.stringify({ type: 'join', token: invitation.hash.slice(1) }));
    assert.equal((await staleClose)[0], 4003);
  } finally { for (const socket of sockets) socket.terminate(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('browser host loss ends the session and helper pairing codes cannot be reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-pairing-'));
  const service = new WebService({ webRoot: root, hostKey: key, port: 0, bind: '127.0.0.1' });
  const sockets: WebSocket[] = [];
  try {
    const address = await service.listen(); assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const helper = new WebSocket(origin.replace('http:', 'ws:') + '/companion-ws'); sockets.push(helper); await once(helper, 'open');
    const closed = once(helper, 'close'); helper.send(JSON.stringify({ type: 'companion-auth', code: key, platform: 'win32' }));
    assert.equal((await closed)[0], 4003);
    const host = new WebSocket(origin.replace('http:', 'ws:') + '/host-ws', { origin }); sockets.push(host); await once(host, 'open');
    const ready = once(host, 'message'); host.send(JSON.stringify({ type: 'host-auth', key })); await ready;
    const active = new Promise<void>(resolve => {
      host.on('message', raw => { const data = JSON.parse(raw.toString()); if (data.type === 'result' && data.id === 1) resolve(); });
    });
    host.send(JSON.stringify({ type: 'call', id: 1, method: 'start', args: { name: 'Window', sourceId: null } })); await active;
    assert.equal(service.session.active, true);
    const pairing = new Promise<string>(resolve => {
      const receive = (raw: any) => { const data = JSON.parse(raw.toString()); if (data.type === 'result' && data.id === 2) { host.off('message', receive); resolve(data.value.code); } }; host.on('message', receive);
    });
    host.send(JSON.stringify({ type: 'call', id: 2, method: 'pair-companion', args: {} }));
    const code = await pairing;
    const paired = new WebSocket(origin.replace('http:', 'ws:') + '/companion-ws'); sockets.push(paired); await once(paired, 'open');
    const confirmed = once(paired, 'message'); paired.send(JSON.stringify({ type: 'companion-auth', code, platform: 'win32' }));
    assert.equal(JSON.parse((await confirmed)[0].toString()).type, 'companion-ready');
    const reused = new WebSocket(origin.replace('http:', 'ws:') + '/companion-ws'); sockets.push(reused); await once(reused, 'open');
    const reusedClose = once(reused, 'close'); reused.send(JSON.stringify({ type: 'companion-auth', code, platform: 'win32' }));
    assert.equal((await reusedClose)[0], 4003);
    host.close(); await once(host, 'close');
    for (let i = 0; i < 20 && service.session.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.session.active, false); assert.equal(service.session.token, ''); assert.equal(service.session.enabled, false);
  } finally { for (const socket of sockets) socket.terminate(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
