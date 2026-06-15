import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, sanitizeSegment } from '../src/utils.js';
import { normalizeVideoUrl, parseDouyinVideoId } from '../src/douyin.js';

test('parseDouyinVideoId supports video and modal urls', () => {
  assert.equal(parseDouyinVideoId('https://www.douyin.com/video/7611095597914918153'), '7611095597914918153');
  assert.equal(parseDouyinVideoId('https://www.douyin.com/search/x?modal_id=7611095597914918153&type=video'), '7611095597914918153');
  assert.equal(normalizeVideoUrl('https://www.douyin.com/search/x?modal_id=7611095597914918153&type=video'), 'https://www.douyin.com/video/7611095597914918153');
});

test('parseArgs handles flags and values', () => {
  const parsed = parseArgs(['--creator-url', 'https://example.test', '--limit=10', '--visible', 'false', 'loose']);
  assert.equal(parsed['creator-url'], 'https://example.test');
  assert.equal(parsed.limit, '10');
  assert.equal(parsed.visible, 'false');
  assert.deepEqual(parsed._, ['loose']);
});

test('sanitizeSegment creates filesystem-safe names', () => {
  assert.equal(sanitizeSegment('  hello / 你好 ? world  '), 'hello_world');
  assert.equal(sanitizeSegment(''), 'item');
});

