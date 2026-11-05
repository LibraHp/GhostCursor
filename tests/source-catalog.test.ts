import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SourceCatalog, selectableWindows } from '../src/electron/source-catalog';

test('capture timeout does not pile up OS requests and a late completion permits retry', async () => {
  let complete!: (value: { id: string }[]) => void;
  let calls = 0;
  const catalog = new SourceCatalog<{ id: string }>(() => { calls++; return new Promise(resolve => { complete = resolve; }); }, 15);
  await assert.rejects(catalog.find('window:1:0'), /超时/);
  await assert.rejects(catalog.find('window:1:0'), /超时/);
  assert.equal(calls, 1);
  complete([{ id: 'window:1:0' }]);
  await setImmediate();
  const retry = catalog.find('window:2:0');
  await Promise.resolve();
  assert.equal(calls, 2);
  complete([{ id: 'window:2:0' }]);
  assert.deepEqual(await retry, { id: 'window:2:0' });
});

test('failed capture enumeration can retry and unavailable windows report a useful error', async () => {
  let calls = 0;
  const catalog = new SourceCatalog(async () => { if (++calls === 1) throw Error('driver failed'); return [{ id: 'window:1:1' }]; });
  await assert.rejects(catalog.find('window:1:0'), /driver failed/);
  assert.deepEqual(await catalog.find('window:1:0'), { id: 'window:1:1' });
  await assert.rejects(catalog.find('window:2:0'), /无法捕获/);
  assert.deepEqual(selectableWindows([{ id: 'screen:1:0', name: 'Desktop' }, { id: 'window:1:0', name: 'App' }]), [{ id: 'window:1:0', name: 'App', thumbnail: '' }]);
});
