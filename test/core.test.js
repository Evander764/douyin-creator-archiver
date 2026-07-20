import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, sanitizeSegment } from '../src/utils.js';
import {
  applyKeywordSearchStandard,
  normalizeStructuredVideo,
  normalizeVideoUrl,
  parseCreatorPostPayload,
  parseDouyinVideoId,
  parseLengthPrefixedJsonStream,
  parseSearchStreamBody,
  processQualifiedItemTransaction,
} from '../src/douyin.js';
import { buildYtDlpAudioArgs, selectAudioOnlyFormat, validateAudioDuration, validateAudioOnlyProbe } from '../src/download.js';
import { filterByMinimumLikes, filterByMinimumRedHearts, writeArchiveReport } from '../src/cli.js';

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

test('normalizeStructuredVideo keeps metrics and exposes music.play_url as pure audio', () => {
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
    music: { duration: 31, play_url: { url_list: ['https://audio.example/original-sound.m4a'] } },
  });
  assert.equal(item.red_heart_count, 13);
  assert.equal(item.like_count, 13);
  assert.equal(item.favorite_count, 3);
  assert.equal(item.comment_count, 1);
  assert.equal(item.share_count, 2);
  assert.equal(item.cover_url, 'https://img.example/cover.jpg');
  assert.equal(item.audio_url, 'https://audio.example/original-sound.m4a');
  assert.equal(item.audio_source, 'music.play_url');
  assert.equal(item.music_duration_seconds, 31);
  assert.equal(item.download_url, 'https://media.example/video.mp4');
  assert.equal(item.duration_ms, 30861);
});

test('audio probe accepts pure audio, records duration, and rejects any video stream', () => {
  assert.deepEqual(validateAudioOnlyProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '30.861' } }), {
    audio_streams: 1,
    video_streams: 0,
    duration_seconds: 30.861,
  });
  assert.throws(
    () => validateAudioOnlyProbe({ streams: [{ codec_type: 'audio' }, { codec_type: 'video' }] }),
    /audio_only_validation_failed/,
  );
  assert.throws(() => validateAudioOnlyProbe({ streams: [] }), /audio_only_validation_failed/);
  assert.equal(validateAudioDuration(30.861, 30.5, 3).checked, true);
  assert.throws(() => validateAudioDuration(914.73, 289.734, 3), /audio_duration_mismatch/);
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

test('1000-red-heart standard is strict and excludes missing metrics', () => {
  const result = filterByMinimumRedHearts([
    { id: 'a', red_heart_count: 999 },
    { id: 'b', red_heart_count: 1000 },
    { id: 'c', red_heart_count: '1,200' },
    { id: 'd', red_heart_count: null },
  ], 1000);
  assert.deepEqual(result.videos.map((item) => item.id), ['c']);
  assert.equal(result.standard.threshold, 1000);
  assert.equal(result.standard.operator, '>');
  assert.equal(result.standard.qualified_count, 1);
  assert.equal(result.standard.at_or_below_threshold_count, 2);
  assert.equal(result.standard.missing_red_heart_count, 1);
});

test('search stream parser handles byte-length-prefixed UTF-8 JSON frames', () => {
  const frames = [
    { status_code: 0, data: [{ aweme_info: { aweme_id: '7611095597914918153', desc: '中文标题', create_time: 1760000000, statistics: { digg_count: 1300 } } }] },
    { status_code: 0, data: [{ aweme_info: { aweme_id: '7611095597914918154', desc: '第二条', create_time: 1760000100, statistics: { digg_count: 999 } } }] },
  ];
  const body = frames.map((frame) => {
    const json = JSON.stringify(frame);
    return `${Buffer.byteLength(json, 'utf8').toString(16)}\r\n${json}`;
  }).join('\r\n');
  assert.equal(parseLengthPrefixedJsonStream(body).length, 2);
  const videos = parseSearchStreamBody(body);
  assert.deepEqual(videos.map((item) => item.id), ['7611095597914918153', '7611095597914918154']);
  assert.equal(videos[0].red_heart_count, 1300);
});

test('keyword search standard requires >1000 red hearts and publication within 14 days', () => {
  const capturedAt = '2026-07-20T12:00:00.000Z';
  const make = (id, redHeartCount, publishTime) => ({
    id,
    url: `https://www.douyin.com/video/${id}`,
    red_heart_count: redHeartCount,
    publish_time: publishTime,
  });
  const result = applyKeywordSearchStandard([
    make('7611095597914918101', 1000, '2026-07-20T00:00:00.000Z'),
    make('7611095597914918102', 1001, '2026-07-06T11:59:59.000Z'),
    make('7611095597914918103', 1001, '2026-07-06T12:00:00.000Z'),
    make('7611095597914918104', 5000, null),
  ], { keyword: '创业', capturedAt, minRedHearts: 1000, withinDays: 14, target: 10, maxScanned: 200 });
  assert.deepEqual(result.qualified_items.map((item) => item.id), ['7611095597914918103']);
  assert.equal(result.standard.red_heart_operator, '>');
  assert.equal(result.standard.red_heart_at_or_below_count, 1);
  assert.equal(result.standard.outside_time_window_count, 1);
  assert.equal(result.standard.missing_publish_time_count, 1);
});

test('keyword search standard stops at 3 qualified items or 200 scanned items', () => {
  const capturedAt = '2026-07-20T12:00:00.000Z';
  const eligible = Array.from({ length: 20 }, (_, index) => ({
    id: String(7611095597914918200n + BigInt(index)),
    url: `https://www.douyin.com/video/${7611095597914918200n + BigInt(index)}`,
    red_heart_count: 1001,
    publish_time: '2026-07-20T00:00:00.000Z',
  }));
  const targetStopped = applyKeywordSearchStandard(eligible, { capturedAt, target: 3, maxScanned: 200 });
  assert.equal(targetStopped.standard.scanned_count, 3);
  assert.equal(targetStopped.standard.qualified_count, 3);
  const ineligible = Array.from({ length: 250 }, (_, index) => ({
    id: String(7611095597914920000n + BigInt(index)),
    url: `https://www.douyin.com/video/${7611095597914920000n + BigInt(index)}`,
    red_heart_count: 1000,
    publish_time: '2026-07-20T00:00:00.000Z',
  }));
  const limitStopped = applyKeywordSearchStandard(ineligible, { capturedAt, target: 3, maxScanned: 200 });
  assert.equal(limitStopped.standard.scanned_count, 200);
  assert.equal(limitStopped.standard.qualified_count, 0);
});

test('qualified item transaction applies ingestion before browser back and verifies restored search', async () => {
  const events = [];
  let page = 'search';
  const client = {
    async evaluate(expression) {
      if (expression.includes('const anchor =')) {
        events.push('open');
        page = 'detail';
        return { ok: true, href: 'https://www.douyin.com/jingxuan/search/%23创业', scroll_top: 321 };
      }
      if (expression.includes("history.back()")) {
        events.push('back');
        page = 'search';
        return undefined;
      }
      if (expression.includes('ready: location.href.includes')) {
        return { href: `https://www.douyin.com/video/7611095597914918153`, ready: page === 'detail' };
      }
      if (expression.includes("const input =")) {
        return { href: 'https://www.douyin.com/search/%23创业', value: '#创业' };
      }
      if (expression.includes('root.scrollTop =')) {
        events.push('restore-scroll');
        return undefined;
      }
      throw new Error(`Unexpected expression: ${expression}`);
    },
  };
  const result = await processQualifiedItemTransaction(client, {
    id: '7611095597914918153',
    url: 'https://www.douyin.com/video/7611095597914918153',
  }, {
    searchQuery: '#创业',
    onQualified: async () => {
      events.push('ingest');
      return { applied: true };
    },
  });
  assert.equal(result.processed, true);
  assert.deepEqual(events, ['open', 'ingest', 'back', 'restore-scroll']);
});

test('yt-dlp audio args use the dedicated Chrome profile and selected audio-only format', () => {
  const args = buildYtDlpAudioArgs('https://www.douyin.com/video/123456789', '/tmp/audio.m4a', '/tmp/profile', 'audio-128k');
  assert.deepEqual(args.slice(0, 2), ['--cookies-from-browser', 'chrome:/tmp/profile']);
  assert.equal(args[3], 'audio-128k');
  assert.ok(args.includes('-x'));
  assert.ok(args.includes('m4a'));
  assert.ok(args.includes('/tmp/audio.%(ext)s'));
  assert.equal(args.at(-1), 'https://www.douyin.com/video/123456789');
});

test('audio-only selection rejects muxed video and picks the best genuine audio track', () => {
  const selected = selectAudioOnlyFormat([
    { format_id: 'muxed', vcodec: 'h265', acodec: 'aac', tbr: 400 },
    { format_id: 'audio-low', vcodec: 'none', acodec: 'aac', abr: 64 },
    { format_id: 'audio-high', vcodec: 'none', acodec: 'aac', abr: 128 },
  ]);
  assert.equal(selected.format_id, 'audio-high');
  assert.equal(selectAudioOnlyFormat([{ format_id: 'muxed', vcodec: 'h264', acodec: 'aac' }]), null);
});
