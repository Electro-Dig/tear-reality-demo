import test from 'node:test';
import assert from 'node:assert/strict';
import { assignLayerImages } from '../src/layerImages.js';

test('assignLayerImages repeats the last uploaded image until three layers are filled', () => {
  assert.deepEqual(assignLayerImages(['one'], 3), ['one', 'one', 'one']);
  assert.deepEqual(assignLayerImages(['one', 'two'], 3), ['one', 'two', 'two']);
  assert.deepEqual(assignLayerImages(['one', 'two', 'three'], 3), ['one', 'two', 'three']);
});

test('assignLayerImages ignores extra uploads beyond the requested layer count', () => {
  assert.deepEqual(assignLayerImages(['one', 'two', 'three', 'four'], 3), ['one', 'two', 'three']);
});
