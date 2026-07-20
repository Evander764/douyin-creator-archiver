import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, sanitizeSegment } from '../src/utils.js';
import { REUSABLE_CHROME_SPAWN_OPTIONS } from '../src/cdp.js';
import {
  applyKeywordSearchStandard,
  normalizeStructuredVideo,
  normalizeVideoUrl,
  parseCreatorPostPayload,
  parseAbbreviatedCount,
  parseDouyinVideoId,
  parseDouyinSearchDate,
  parseLengthPrefixedJsonStream,
  parseSearchStreamBody,
  normalizeSearchCardObservation,
  itemMatchesKeyword,
  isTransientSearchScrollFailure,
  isCleanSearchResultUrl,
  keywordSearchAttemptLimit,
  processQualifiedItemTransaction,
  selectVisibleQualifiedCandidate,
} from '../src/douyin.js';
import { buildYtDlpAudioArgs, selectAudioOnlyFormat, validateAudioDuration, validateAudioOnlyProbe } from '../src/download.js';
import {
  createQualifiedHookQueue, filterByMinimumLikes, filterByMinimumRedHearts, writeArchiveReport
} from '../src/cli.js';

test('parseDouyinVideoId supports video and modal urls', () => {
  assert.equal(parseDouyinVideoId('https://www.douyin.com/video/7611095597914918153'), '7611095597914918153');
  assert.equal(parseDouyinVideoId('https://www.douyin.com/search/x?modal_id=7611095597914918153&type=video'), '7611095597914918153');
  assert.equal(normalizeVideoUrl('https://www.douyin.com/search/x?modal_id=7611095597914918153&type=video'), 'https://www.douyin.com/video/7611095597914918153');
});

test('search restoration accepts only the clean keyword history entry, never a modal overlay', () => {
  assert.equal(isCleanSearchResultUrl('https://www.douyin.com/search/%23%E5%88%9B%E4%B8%9A?type=general', '#创业'), true);
  assert.equal(isCleanSearchResultUrl('https://www.douyin.com/jingxuan/search/%23%E5%88%9B%E4%B8%9A?modal_id=7611095597914918153&type=general', '#创业'), false);
  assert.equal(isCleanSearchResultUrl('https://www.douyin.com/search/%23AI?type=general', '#创业'), false);
});

test('dedicated Chrome is detached so CLI exit cannot close the reusable Douyin window', () => {
  assert.equal(REUSABLE_CHROME_SPAWN_OPTIONS.detached, true);
  assert.equal(REUSABLE_CHROME_SPAWN_OPTIONS.stdio, 'ignore');
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

test('keyword search standard requires >1000 red hearts and publication within 120 days', () => {
  const capturedAt = '2026-07-20T12:00:00.000Z';
  const make = (id, redHeartCount, publishTime) => ({
    id,
    url: `https://www.douyin.com/video/${id}`,
    red_heart_count: redHeartCount,
    publish_time: publishTime,
    title: '普通人创业方法',
  });
  const result = applyKeywordSearchStandard([
    make('7611095597914918101', 1000, '2026-07-20T00:00:00.000Z'),
    make('7611095597914918102', 1001, '2026-03-22T11:59:59.000Z'),
    make('7611095597914918103', 1001, '2026-03-22T12:00:00.000Z'),
    make('7611095597914918104', 5000, null),
  ], { keyword: '创业', capturedAt, minRedHearts: 1000, withinDays: 120, target: 10, maxScanned: 200 });
  assert.deepEqual(result.qualified_items.map((item) => item.id), ['7611095597914918103']);
  assert.equal(result.standard.red_heart_operator, '>');
  assert.equal(result.standard.red_heart_at_or_below_count, 1);
  assert.equal(result.standard.outside_time_window_count, 1);
  assert.equal(result.standard.missing_publish_time_count, 1);
});

test('search-card parsing expands 万/亿 and resolves Douyin dates in Asia/Shanghai', () => {
  assert.equal(parseAbbreviatedCount('1.2万'), 12000);
  assert.equal(parseAbbreviatedCount('45.0万'), 450000);
  assert.equal(parseAbbreviatedCount('1.6亿'), 160000000);
  assert.equal(parseAbbreviatedCount('1,001'), 1001);
  assert.equal(parseDouyinSearchDate('· 19小时前', '2026-07-20T12:00:00.000Z'), '2026-07-19T17:00:00.000Z');
  assert.equal(parseDouyinSearchDate('3月27日', '2026-07-20T12:00:00.000Z'), '2026-03-27T15:59:59.999Z');
  assert.equal(parseDouyinSearchDate('2025年12月24日', '2026-07-20T12:00:00.000Z'), '2025-12-24T15:59:59.999Z');
  assert.equal(normalizeSearchCardObservation({
    id: 'waterfall_item_7621509241727225131',
    kind: '05:39',
    metric_text: '1.0万',
    title: '年入百万并没有那么难 #年入百万',
    author_name: '@群响刘思毅',
    date_text: '· 3月27日',
  }, '2026-07-20T12:00:00.000Z').red_heart_count, 10000);
  assert.equal(normalizeSearchCardObservation({
    id: 'waterfall_item_7516737796636216585',
    kind: '图文',
    metric_text: '1448',
    title: '图文内容',
    date_text: '2025年6月16日',
  }, '2026-07-20T12:00:00.000Z'), null);
});

test('keyword relevance rejects ASCII substrings but accepts real AI terms', () => {
  assert.equal(itemMatchesKeyword({ title: '#haerin 回归' }, 'AI'), false);
  assert.equal(itemMatchesKeyword({ title: '普通人用AI工具创业' }, 'AI'), true);
  assert.equal(itemMatchesKeyword({ title: '三个搞钱方法' }, '搞钱'), true);
  const result = applyKeywordSearchStandard([{
    id: '7664212023937279080',
    url: 'https://www.douyin.com/video/7664212023937279080',
    title: '#haerin 回归',
    red_heart_count: 2046,
    publish_time: '2026-07-19T12:16:59.000Z'
  }], { keyword: 'AI', capturedAt: '2026-07-20T12:00:00.000Z' });
  assert.equal(result.standard.irrelevant_keyword_count, 1);
  assert.equal(result.qualified_items.length, 0);
});

test('resume-current never retries by submitting the same keyword again', () => {
  assert.equal(keywordSearchAttemptLimit(true), 1);
  assert.equal(keywordSearchAttemptLimit(false), 2);
});

test('a missing scroll container is treated as transient while search cards are still mounting', () => {
  assert.equal(isTransientSearchScrollFailure('scroll_container_not_found'), true);
  assert.equal(isTransientSearchScrollFailure('javascript_failed'), false);
});

test('keyword search standard stops at 1 qualified item or 200 scanned items', () => {
  const capturedAt = '2026-07-20T12:00:00.000Z';
  const eligible = Array.from({ length: 20 }, (_, index) => ({
    id: String(7611095597914918200n + BigInt(index)),
    url: `https://www.douyin.com/video/${7611095597914918200n + BigInt(index)}`,
    red_heart_count: 1001,
    publish_time: '2026-07-20T00:00:00.000Z',
  }));
  const targetStopped = applyKeywordSearchStandard(eligible, { capturedAt, target: 1, maxScanned: 200 });
  assert.equal(targetStopped.standard.scanned_count, 1);
  assert.equal(targetStopped.standard.qualified_count, 1);
  const ineligible = Array.from({ length: 250 }, (_, index) => ({
    id: String(7611095597914920000n + BigInt(index)),
    url: `https://www.douyin.com/video/${7611095597914920000n + BigInt(index)}`,
    red_heart_count: 1000,
    publish_time: '2026-07-20T00:00:00.000Z',
  }));
  const limitStopped = applyKeywordSearchStandard(ineligible, { capturedAt, target: 1, maxScanned: 200 });
  assert.equal(limitStopped.standard.scanned_count, 200);
  assert.equal(limitStopped.standard.qualified_count, 0);
});

test('visible-card gate skips an earlier network candidate that is not rendered yet', () => {
  const items = [
    {
      id: '7611095597914918301',
      url: 'https://www.douyin.com/video/7611095597914918301',
      title: '个人IP 方法一',
      red_heart_count: 5000,
      publish_time: '2026-07-19T00:00:00.000Z',
    },
    {
      id: '7611095597914918302',
      url: 'https://www.douyin.com/video/7611095597914918302',
      title: '个人IP 方法二',
      red_heart_count: 6000,
      publish_time: '2026-07-18T00:00:00.000Z',
    },
  ];
  const selected = selectVisibleQualifiedCandidate(
    items,
    new Set(['7611095597914918302']),
    new Set(),
    { keyword: '个人IP', capturedAt: '2026-07-20T12:00:00.000Z', withinDays: 120, maxScanned: 200 },
  );
  assert.equal(selected.id, '7611095597914918302');
});

test('qualified item transaction applies ingestion before browser back and verifies restored search', async () => {
  const events = [];
  let page = 'search';
  const client = {
    async evaluate(expression) {
      if (expression.includes('const anchor =')) {
        events.push('open');
        page = 'detail';
        return { ok: true, href: 'https://www.douyin.com/jingxuan/search/%23创业', scroll_top: 321, click_point: { x: 10, y: 20 } };
      }
      if (expression.includes("history.back()")) {
        events.push('back');
        page = 'search';
        return undefined;
      }
      if (expression.includes('ready: location.href.includes')) {
        return { href: `https://www.douyin.com/video/7611095597914918153`, ready: page === 'detail' };
      }
      if (expression.includes('title: document.title')) {
        return { href: 'https://www.douyin.com/video/7611095597914918153', title: 'detail' };
      }
      if (expression.includes("const endpoint = new URL('/aweme/v1/web/aweme/detail/'")) {
        return {
          ok: true,
          status: 200,
          data: {
            aweme_detail: {
              aweme_id: '7611095597914918153',
              desc: '创业方法',
              create_time: Math.floor(Date.now() / 1000),
              statistics: { digg_count: 1001 },
            },
          },
        };
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
    async send(method, params) {
      if (method === 'Input.dispatchMouseEvent') {
        events.push(`mouse-${params.type}`);
        return {};
      }
      if (method === 'Target.createTarget') {
        events.push('backup-tab');
        return { targetId: 'backup-1' };
      }
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ id: 1, url: 'https://www.douyin.com/search/%23创业' }] };
      }
      throw new Error(`Unexpected CDP command: ${method}`);
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
  assert.deepEqual(events, ['open', 'open', 'backup-tab', 'ingest', 'back', 'restore-scroll']);
});

test('qualified item transaction returns through browser history when a note adds a second detail entry', async () => {
  const events = [];
  let page = 'search';
  const client = {
    async evaluate(expression) {
      if (expression.includes('const anchor =')) {
        page = 'detail';
        events.push('open');
        return { ok: true, href: 'https://www.douyin.com/search/%23AI', scroll_top: 88 };
      }
      if (expression.includes("history.back()")) {
        page = 'note';
        events.push('back');
        return undefined;
      }
      if (expression.includes('ready: location.href.includes')) {
        return { href: 'https://www.douyin.com/note/7611095597914918153', ready: page === 'detail' };
      }
      if (expression.includes('title: document.title')) {
        return { href: 'https://www.douyin.com/note/7611095597914918153', title: 'detail' };
      }
      if (expression.includes("const endpoint = new URL('/aweme/v1/web/aweme/detail/'")) {
        return {
          ok: true,
          status: 200,
          data: {
            aweme_detail: {
              aweme_id: '7611095597914918153',
              desc: 'AI 方法',
              create_time: Math.floor(Date.now() / 1000),
              statistics: { digg_count: 1001 },
            },
          },
        };
      }
      if (expression.includes("const input =")) {
        return page === 'search'
          ? { href: 'https://www.douyin.com/search/%23AI', value: '#AI' }
          : { href: 'https://www.douyin.com/note/7611095597914918153', value: '' };
      }
      if (expression.includes('root.scrollTop =')) {
        events.push('restore-scroll');
        return undefined;
      }
      throw new Error(`Unexpected expression: ${expression}`);
    },
    async send(method, params) {
      if (method === 'Target.createTarget') {
        events.push('backup-tab');
        return { targetId: 'backup-note' };
      }
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: 'https://www.douyin.com/search/%23AI' },
            { id: 2, url: 'https://www.douyin.com/note/7611095597914918153' },
          ],
        };
      }
      if (method === 'Page.navigateToHistoryEntry' && params.entryId === 1) {
        page = 'search';
        events.push('history-entry-back');
        return {};
      }
      throw new Error(`Unexpected CDP command: ${method}`);
    },
  };
  const result = await processQualifiedItemTransaction(client, {
    id: '7611095597914918153',
    url: 'https://www.douyin.com/video/7611095597914918153',
  }, {
    searchQuery: '#AI',
    onQualified: async () => {
      events.push('ingest');
      return { applied: true };
    },
  });
  assert.equal(result.processed, true);
  assert.deepEqual(events, ['open', 'open', 'backup-tab', 'ingest', 'back', 'history-entry-back', 'restore-scroll']);
});

test('streaming hook queue starts work without blocking search and caps worker concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const queue = createQualifiedHookQueue({
    script: '/tmp/hook.mjs', outDir: '/tmp/out', timeoutMs: 1000, concurrency: 2,
    runHook: async (_script, item) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        resolve({ item_id: item.id });
      });
    }),
  });
  const first = queue.enqueue({ id: '1' }, { backup_target_id: 'tab-1', port: 9533 });
  const second = queue.enqueue({ id: '2' }, { backup_target_id: 'tab-2', port: 9533 });
  const third = queue.enqueue({ id: '3' }, { backup_target_id: 'tab-3', port: 9533 });
  assert.equal(first.queued && second.queued && third.queued, true);
  assert.equal(maxActive, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  while (releases.length) releases.shift()();
  const report = await queue.drain();
  assert.deepEqual({ total: report.total, complete: report.complete, failed: report.failed }, { total: 3, complete: 3, failed: 0 });
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
