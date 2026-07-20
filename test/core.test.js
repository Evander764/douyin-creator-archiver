import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, sanitizeSegment } from '../src/utils.js';
import { normalizeStructuredVideo, normalizeVideoUrl, parseCreatorPostPayload, parseDouyinVideoId } from '../src/douyin.js';
import { writeArchiveReport } from '../src/cli.js';

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

test('normalizeStructuredVideo keeps engagement metrics and cover', () => {
  const item = normalizeStructuredVideo({
    aweme_id: '7611095597914918153',
    desc: '测试标题',
    create_time: 1760000000,
    statistics: { digg_count: 13, collect_count: 3, comment_count: 1, share_count: 2 },
    video: {
      duration: 30861,
      origin_cover: { url_list: ['https://img.example/cover.jpg'] },
      download_addr: { url_list: ['https://media.example/video.mp4'] },
    },
  });
  assert.equal(item.like_count, 13);
  assert.equal(item.favorite_count, 3);
  assert.equal(item.comment_count, 1);
  assert.equal(item.share_count, 2);
  assert.equal(item.cover_url, 'https://img.example/cover.jpg');
  assert.equal(item.download_url, 'https://media.example/video.mp4');
  assert.equal(item.duration_ms, 30861);
});

test('writeArchiveReport persists final failed state', () => {
  const root = mkdtempSync(join(tmpdir(), 'dyca-report-'));
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  writeArchiveReport(root, { ok: true, total: 1, succeeded: 0, failed: 1, items: [] });
  const saved = JSON.parse(readFileSync(join(logs, 'archive-report.json'), 'utf8'));
  assert.equal(saved.ok, false);
});

test('parseCreatorPostPayload preserves cursor exhaustion evidence', () => {
  const page = parseCreatorPostPayload({
    aweme_list: [{
      aweme_id: '7611095597914918153',
      desc: '分页视频',
      statistics: { digg_count: 8, collect_count: 2 },
      video: { cover: { url_list: ['https://img.example/page.jpg'] } },
    }],
    has_more: 0,
    max_cursor: 123,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].like_count, 8);
  assert.equal(page.items[0].favorite_count, 2);
  assert.equal(page.has_more, false);
  assert.equal(page.cursor, 123);
});
