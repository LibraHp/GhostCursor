import test from 'node:test';
import assert from 'node:assert/strict';
import { useCompatibility, validGraphicsMode } from '../src/shared/graphics';

test('automatic graphics mode uses compatibility on Windows 10 and respects explicit overrides', () => {
  assert.equal(useCompatibility('auto', 19045), true);
  assert.equal(useCompatibility('auto', 26200), false);
  assert.equal(useCompatibility('hardware', 19045), false);
  assert.equal(useCompatibility('compatibility', 26200), true);
  assert.equal(useCompatibility('auto', 0, 'darwin'), false);
  assert.equal(useCompatibility('compatibility', 0, 'darwin'), true);
  assert.equal(validGraphicsMode('disable-security'), false);
  assert.equal(validGraphicsMode('compatibility'), true);
});
