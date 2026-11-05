import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedShortcut, validShortcut, validVideo, validCursor, presetSettings, videoConstraints, initialVideoConstraints, storedVideo } from '../src/shared/settings';

test('quality presets select meaningful default frame rates and preserve independent caps', () => {
  assert.deepEqual(presetSettings('smooth'), { preset: 'smooth', fps: 15, resolution: '720p' });
  assert.deepEqual(presetSettings('ultra'), { preset: 'ultra', fps: 60, resolution: '1440p' });
  const constraints = videoConstraints({ preset: 'hd', fps: 24, resolution: '1080p' });
  assert.deepEqual(constraints.width, { max: 1920 });
  assert.deepEqual(constraints.frameRate, { ideal: 24, max: 24 });
  assert.equal(validVideo({ preset: '__proto__', fps: 30 }), false);
  assert.equal(validVideo({ preset: 'hd', fps: 1000 }), false);
  assert.equal(validCursor({ shape: 'arrow', size: 32, color: 'url(file:///private)' }), false);
  assert.equal(validCursor({ shape: 'crosshair', size: 44, color: '#9a22ff' }), true);
});

test('resolution limits are independent of presets and original removes the previous cap', () => {
  assert.deepEqual(videoConstraints({ preset: 'smooth', fps: 15, resolution: '2160p' }).width, { max: 3840 });
  const original = videoConstraints({ preset: 'ultra', fps: 30, resolution: 'original' });
  assert.equal(original.width, undefined); assert.equal(original.height, undefined);
  assert.deepEqual(original.frameRate, { ideal: 30, max: 30 });
  assert.deepEqual(initialVideoConstraints({ preset: 'hd', fps: 24, resolution: '720p' }).width, { ideal: 1280 });
  assert.equal(validVideo({ preset: 'hd', fps: 30, resolution: '8k' }), false);
  assert.deepEqual(storedVideo({ preset: 'smooth', fps: 24 }), { preset: 'smooth', fps: 24, resolution: '720p' });
  assert.equal(storedVideo({ preset: 'hd', fps: 30, resolution: 'invalid' }), null);
});

test('recording uses physical keys and ignores modifiers, repeats and IME composition', () => {
  const key = { code: 'KeyA', key: 'A', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, repeat: false, isComposing: false };
  assert.equal(recordedShortcut(key), 'Ctrl+Shift+A');
  assert.equal(recordedShortcut({ ...key, code: 'F9', altKey: true }), 'Ctrl+Alt+Shift+F9');
  assert.equal(recordedShortcut({ ...key, code: 'ControlLeft' }), null);
  assert.equal(recordedShortcut({ ...key, repeat: true }), null);
  assert.equal(recordedShortcut({ ...key, isComposing: true }), null);
  assert.equal(recordedShortcut({ ...key, ctrlKey: false, shiftKey: false }), null);
  assert.equal(validShortcut('Ctrl+Ctrl+A'), false);
  assert.equal(validShortcut('Ctrl+Alt+F24'), true);
});
