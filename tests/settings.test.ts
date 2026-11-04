import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedShortcut, validShortcut, validVideo, validCursor, presetSettings, videoConstraints } from '../src/shared/settings';

test('quality presets select meaningful default frame rates and preserve independent caps', () => {
  assert.deepEqual(presetSettings('smooth'), { preset: 'smooth', fps: 15 });
  assert.deepEqual(presetSettings('ultra'), { preset: 'ultra', fps: 60 });
  const constraints = videoConstraints({ preset: 'hd', fps: 24 });
  assert.deepEqual(constraints.width, { max: 1920 });
  assert.deepEqual(constraints.frameRate, { ideal: 24, max: 24 });
  assert.equal(validVideo({ preset: '__proto__', fps: 30 }), false);
  assert.equal(validVideo({ preset: 'hd', fps: 1000 }), false);
  assert.equal(validCursor({ shape: 'arrow', size: 32, color: 'url(file:///private)' }), false);
  assert.equal(validCursor({ shape: 'crosshair', size: 44, color: '#9a22ff' }), true);
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
