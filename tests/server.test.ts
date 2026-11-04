import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Session } from '../src/electron/session';
import { SharingServer } from '../src/electron/server';

test('HTTP/WebSocket service authenticates joins, revokes on disconnect and invalidates links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghostcursor-test-'));
  await writeFile(join(root, 'index.html'), '<h1>GhostCursor</h1>');
  const session = new Session(); session.begin();
  const service = new SharingServer(session, root);
  const sockets: WebSocket[] = [];
  try {
    await service.start(0);
    // Test-only introspection keeps ephemeral port selection race-free.
    const address = (service as any).http.address(); const port = address.port;
    const url = `http://127.0.0.1:${port}`;
    const html = await fetch(url); assert.equal(html.status, 200); assert.match(html.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
    assert.equal((await fetch(url + '/package.json')).status, 404);
    const connect = async (origin = url) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin }); sockets.push(ws); await once(ws, 'open'); return ws; };
    const rejected = await connect();
    const badClose = once(rejected, 'close'); rejected.send(JSON.stringify({ type: 'join', token: 'invalid' }));
    assert.equal((await badClose)[0], 4003);
    const ws = await connect();
    const welcome = once(ws, 'message'); ws.send(JSON.stringify({ type: 'join', token: session.token, name: 'Alice\u0000' }));
    const joined = JSON.parse((await welcome)[0].toString());
    assert.equal(joined.type, 'welcome'); assert.equal(session.visitors.size, 1); assert.equal(session.visitors.get(joined.id)?.name, 'Alice');
    session.select(joined.id); session.toggle(); assert.equal(session.enabled, true);
    const left = once(service, 'leave'); ws.close(); await left; assert.equal(session.enabled, false); assert.equal(session.controller, null);
    const oldToken = session.token; session.end(); session.begin();
    const stale = await connect(); const staleClose = once(stale, 'close'); stale.send(JSON.stringify({ type: 'join', token: oldToken }));
    assert.equal((await staleClose)[0], 4003);
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://untrusted.invalid' }); sockets.push(foreign);
    assert.match(String((await once(foreign, 'error'))[0]), /socket hang up/);
  } finally { sockets.forEach(ws => ws.terminate()); await service.stop(); await rm(root, { recursive: true, force: true }); }
});
