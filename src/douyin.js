import {
  captureFrontmostApplication,
  CDPClient,
  launchChrome,
  restoreFrontmostApplication,
} from './cdp.js';
import { DEFAULT_CDP_PORT, DEFAULT_CHROME_PATH, DEFAULT_PROFILE_DIR, sleep } from './utils.js';

const VIDEO_ID_PATTERN = /douyin\.com\/video\/(\d{6,})|[?&]modal_id=(\d{6,})/i;

export function parseDouyinVideoId(url = '') {
  const match = String(url || '').match(VIDEO_ID_PATTERN);
  return match?.[1] || match?.[2] || null;
}

export function normalizeVideoUrl(url = '') {
  const id = parseDouyinVideoId(url);
  return id ? `https://www.douyin.com/video/${id}` : String(url || '');
}

export function isCleanSearchResultUrl(url = '', searchQuery = '') {
  try {
    const parsed = new URL(url);
    let decoded = parsed.href;
    try { decoded = decodeURIComponent(decoded); } catch {}
    return /\/(?:jingxuan\/)?search\//.test(parsed.pathname)
      && !parsed.searchParams.has('modal_id')
      && (!searchQuery || decoded.includes(searchQuery));
  } catch {
    return false;
  }
}

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstUrl(...groups) {
  for (const group of groups) {
    if (Array.isArray(group?.url_list) && group.url_list[0]) return group.url_list[0];
    if (typeof group === 'string' && group) return group;
  }
  return null;
}

function epochToISO(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number > 1e12 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function debugSearch(message) {
  if (process.env.DYCA_DEBUG_SEARCH) console.error(`search-debug: ${message}`);
}

export function normalizeStructuredVideo(aweme = {}, defaults = {}) {
  const statistics = aweme.statistics || {};
  const video = aweme.video || {};
  const music = aweme.music || {};
  const author = aweme.author || {};
  const id = String(aweme.aweme_id || aweme.awemeId || parseDouyinVideoId(defaults.url) || '');
  const title = compact(aweme.desc || aweme.item_title || defaults.title);
  const audioUrl = firstUrl(music.play_url);
  return {
    ...defaults,
    id,
    url: id ? normalizeVideoUrl(`https://www.douyin.com/video/${id}`) : defaults.url,
    title,
    description: title,
    author_name: author.nickname || defaults.author_name || null,
    author_id: String(author.uid || author.sec_uid || defaults.author_id || ''),
    publish_time: epochToISO(aweme.create_time || aweme.createTime),
    red_heart_count: statistics.digg_count ?? null,
    like_count: statistics.digg_count ?? statistics.like_count ?? null,
    favorite_count: statistics.collect_count ?? statistics.favorite_count ?? null,
    comment_count: statistics.comment_count ?? null,
    share_count: statistics.share_count ?? null,
    cover_url: firstUrl(video.origin_cover, video.raw_cover, video.cover, video.dynamic_cover),
    audio_url: audioUrl,
    audio_source: audioUrl ? 'music.play_url' : null,
    music_duration_seconds: Number(music.duration || 0) || null,
    download_url: firstUrl(video.download_addr),
    duration_ms: Number(video.duration || aweme.duration || 0) || null,
    metadata_status: 'structured',
  };
}

async function openQualifiedVideo(client, item, searchQuery) {
  const id = String(item.id || parseDouyinVideoId(item.url) || '');
  if (!id) throw new Error('Qualified item is missing a Douyin video id');
  const origin = await client.evaluate(`(() => {
    const root = document.scrollingElement || document.documentElement;
    const anchor = [...document.querySelectorAll('a[href*="/video/"]')]
      .find((node) => String(node.href || '').includes('/video/' + ${JSON.stringify(id)}));
    const card = document.getElementById('waterfall_item_' + ${JSON.stringify(id)});
    const before = { href: location.href, scroll_top: root.scrollTop };
    // Click the card's own handler. Hovering the cover mounts a preview
    // <video> that can intercept pointer events without opening the detail.
    const target = anchor || card?.querySelector('.PtY9QFFE') || card?.querySelector('.search-result-card') || card;
    if (!target) {
      return { ok: false, reason: 'visible_result_card_not_found', ...before };
    }
    const checkpointState = history.state && typeof history.state === 'object' ? history.state : {};
    history.pushState({ ...checkpointState, __dyca_search_checkpoint: true }, document.title, location.href);
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    if (anchor) anchor.removeAttribute('target');
    return {
      ok: true,
      opened_by: anchor ? 'visible_result_link' : 'visible_result_card',
      ...before,
    };
  })()`);
  if (!origin?.ok) throw new Error(`Douyin qualified-item open failed: ${origin?.reason || 'unknown'}`);
  await sleep(500);
  const clicked = await client.evaluate(`(() => {
    const anchor = [...document.querySelectorAll('a[href*="/video/"]')]
      .find((node) => String(node.href || '').includes('/video/' + ${JSON.stringify(id)}));
    const card = document.getElementById('waterfall_item_' + ${JSON.stringify(id)});
    const target = anchor || card?.querySelector('.PtY9QFFE') || card?.querySelector('.search-result-card') || card;
    if (!target) return false;
    if (anchor) anchor.removeAttribute('target');
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Douyin qualified-item click target disappeared');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`({ href: location.href, ready: location.href.includes(${JSON.stringify(id)}) })`);
    if (state?.ready) return { ...origin, item_id: id, search_query: searchQuery };
    await sleep(500);
  }
  throw new Error(`Douyin qualified-item detail did not open: ${id}`);
}

async function backToSearchResults(client, origin) {
  await client.evaluate('history.back()');
  if (typeof client.send === 'function') {
    try {
      const history = await client.send('Page.getNavigationHistory');
      const target = [...(history?.entries || [])].reverse()
        .find((entry) => isCleanSearchResultUrl(entry.url, origin.search_query));
      if (target && target.id !== history?.entries?.[history.currentIndex]?.id) {
        await client.send('Page.navigateToHistoryEntry', { entryId: target.id });
      }
    } catch {}
  }
  const deadline = Date.now() + 30000;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      return { href: location.href, value: input?.value || '' };
    })()`);
    if (isCleanSearchResultUrl(last?.href, origin.search_query)
      && last.value === origin.search_query
    ) {
      try {
        await client.evaluate(`(() => {
          const root = document.scrollingElement || document.documentElement;
          if (root) root.scrollTop = ${JSON.stringify(Number(origin.scroll_top || 0))};
          return true;
        })()`);
      } catch {
        // The URL and visible query are already restored. A transient React
        // execution-context swap must not abort the entire search lane merely
        // because the saved scroll offset could not be applied.
      }
      return last;
    }
    if (isCleanSearchResultUrl(last?.href, origin.search_query) && last.value !== origin.search_query) {
      await client.evaluate(`(() => {
        const input = [...document.querySelectorAll('input')]
          .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(origin.search_query)});
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(origin.search_query)} }));
        return Boolean(input);
      })()`);
    }
    await sleep(500);
  }
  throw new Error(`Douyin browser back failed; current page: ${last?.href || 'unknown'}`);
}

async function duplicateQualifiedDetail(client, origin) {
  if (typeof client.send !== 'function') throw new Error('Douyin backup-tab creation requires CDP Target.createTarget');
  const current = await client.evaluate('({ href: location.href, title: document.title })');
  if (!current?.href || !String(current.href).includes(String(origin.item_id))) {
    throw new Error('Douyin backup-tab creation refused: detail page identity mismatch');
  }
  const created = await client.send('Target.createTarget', {
    url: current.href,
    background: true,
  });
  if (!created?.targetId) throw new Error('Douyin backup-tab creation failed');
  return { backup_target_id: created.targetId, backup_url: current.href };
}

async function currentSearchMatches(client, searchQuery) {
  let state = await client.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
    return { href: location.href, value: input?.value || '' };
  })()`);
  if (isCleanSearchResultUrl(state?.href, searchQuery) && state.value !== searchQuery) {
    await client.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(searchQuery)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(searchQuery)} }));
      return Boolean(input);
    })()`);
    await sleep(200);
    state = await client.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      return { href: location.href, value: input?.value || '' };
    })()`);
  }
  return Boolean(
    state?.href
    && isCleanSearchResultUrl(state.href, searchQuery)
    && state.value === searchQuery
  );
}

export async function processQualifiedItemTransaction(client, item, {
  searchQuery,
  onQualified,
  keyword = '',
  minRedHearts = 1000,
  withinDays = 120,
  capturedAt = new Date().toISOString(),
  onBackupCreated = null,
  excludedTerms = [],
  excludedVideoIds = [],
} = {}) {
  const origin = await openQualifiedVideo(client, item, searchQuery);
  try {
    // Search API rows are already the platform's exact structured payload and
    // include statistics, create_time and music.play_url. Re-fetch only DOM
    // card observations, whose abbreviated label/date still require proof.
    const detail = item.metadata_status === 'structured'
      ? { ok: true, item }
      : await fetchStructuredVideoDetailWithRetry(client, item.url, item);
    if (!detail.ok) {
      return { processed: false, rejected_reason: detail.error || 'structured_detail_unavailable' };
    }
    if (new Set(excludedVideoIds.map(String)).has(String(detail.item.id))) {
      return { processed: false, rejected_reason: 'excluded_video_id' };
    }
    if (itemMatchesExcludedTerms(detail.item, excludedTerms)) {
      return { processed: false, rejected_reason: 'excluded_term' };
    }
    const verification = applyKeywordSearchStandard([detail.item], {
      keyword,
      minRedHearts,
      withinDays,
      target: 1,
      maxScanned: 1,
      capturedAt,
    });
    const verifiedItem = verification.qualified_items[0];
    if (!verifiedItem) {
      return {
        processed: false,
        rejected_reason: 'structured_detail_did_not_qualify',
        verification: verification.standard,
      };
    }
    if (typeof onQualified !== 'function') {
      return { processed: true, item: verifiedItem, receipt: null, backup: null };
    }
    const backup = await duplicateQualifiedDetail(client, origin);
    onBackupCreated?.({ item: verifiedItem, ...backup });
    const receipt = await onQualified(verifiedItem, { ...origin, ...backup, phase: 'queued_with_backup' });
    return { processed: true, item: verifiedItem, receipt, backup };
  } finally {
    await backToSearchResults(client, origin);
  }
}

export function parseLengthPrefixedJsonStream(input = '') {
  const text = String(input || '');
  if (!text.trim()) return [];
  try {
    return [JSON.parse(text)];
  } catch {}

  const buffer = Buffer.from(text, 'utf8');
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    while (offset < buffer.length && /\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
    if (offset >= buffer.length) break;
    const crlf = buffer.indexOf('\r\n', offset, 'utf8');
    const lf = buffer.indexOf('\n', offset, 'utf8');
    const lineEnd = crlf >= 0 ? crlf : lf;
    const delimiterBytes = crlf >= 0 ? 2 : 1;
    if (lineEnd < 0) break;
    const sizeToken = buffer.subarray(offset, lineEnd).toString('ascii').trim().split(';')[0];
    const byteLength = Number.parseInt(sizeToken, 16);
    if (!Number.isInteger(byteLength) || byteLength <= 0) break;
    const bodyStart = lineEnd + delimiterBytes;
    const bodyEnd = bodyStart + byteLength;
    if (bodyEnd > buffer.length) break;
    try {
      frames.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')));
    } catch {
      break;
    }
    offset = bodyEnd;
  }
  return frames;
}

export function extractSearchVideos(payload = {}) {
  const awemes = [];
  const seenObjects = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if ((value.aweme_id || value.awemeId) && value.statistics) {
      awemes.push(normalizeStructuredVideo(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return uniqByVideoId(awemes);
}

export function parseSearchStreamBody(input = '') {
  return uniqByVideoId(parseLengthPrefixedJsonStream(input).flatMap((frame) => extractSearchVideos(frame)));
}

function numericMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseAbbreviatedCount(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[,+\s]/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)(万|w|亿)?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  const multiplier = match[2] === '亿' ? 100_000_000 : (match[2] === '万' || match[2] === 'w' ? 10_000 : 1);
  const parsed = Math.round(number * multiplier);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function shanghaiEndOfDayUtc(year, month, day) {
  const value = Date.UTC(year, month - 1, day, 15, 59, 59, 999);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseDouyinSearchDate(value, capturedAt = new Date().toISOString()) {
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) throw new Error('capturedAt must be a valid timestamp');
  const text = compact(value).replace(/^[·•\s]+/, '').replace(/^发布于\s*/, '');
  if (!text) return null;
  if (/^(刚刚|片刻前)$/.test(text)) return new Date(capturedAtMs).toISOString();
  const relative = text.match(/^(\d+(?:\.\d+)?)\s*(分钟|小时|天|周)前$/);
  if (relative) {
    const unitMs = { 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000, 周: 604_800_000 }[relative[2]];
    return new Date(capturedAtMs - (Number(relative[1]) * unitMs)).toISOString();
  }
  if (/^(今天|昨天|前天)$/.test(text)) {
    const days = text === '今天' ? 0 : (text === '昨天' ? 1 : 2);
    return new Date(capturedAtMs - (days * 86_400_000)).toISOString();
  }
  const explicit = text.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/);
  if (!explicit) return null;
  const captured = new Date(capturedAtMs);
  const local = shanghaiDateParts(captured);
  let year = explicit[1] ? Number(explicit[1]) : local.year;
  const month = Number(explicit[2]);
  const day = Number(explicit[3]);
  let date = shanghaiEndOfDayUtc(year, month, day);
  if (!date || shanghaiDateParts(date).month !== month || shanghaiDateParts(date).day !== day) return null;
  if (!explicit[1] && date.getTime() > capturedAtMs + 86_400_000) {
    year -= 1;
    date = shanghaiEndOfDayUtc(year, month, day);
  }
  return date?.toISOString() || null;
}

export function normalizeSearchCardObservation(raw = {}, capturedAt = new Date().toISOString()) {
  const id = String(raw.id || '').replace(/^waterfall_item_/, '');
  if (!/^\d{6,}$/.test(id) || raw.kind === '图文') return null;
  const redHeartCount = parseAbbreviatedCount(raw.metric_text);
  const publishTime = parseDouyinSearchDate(raw.date_text, capturedAt);
  if (!compact(raw.title) || redHeartCount === null) return null;
  return {
    id,
    url: `https://www.douyin.com/video/${id}`,
    title: compact(raw.title),
    description: compact(raw.title),
    author_name: compact(raw.author_name).replace(/^@/, '') || null,
    publish_time: publishTime,
    red_heart_count: redHeartCount,
    red_heart_display: compact(raw.metric_text),
    red_heart_source: 'search_card_heart_label',
    metadata_status: 'search_card_dom',
  };
}

export function itemMatchesKeyword(item, keyword = '') {
  const needle = compact(keyword).replace(/^#+/, '').normalize('NFKC').toLowerCase();
  if (!needle) return true;
  const haystack = `${item?.title || ''} ${item?.description || ''}`.normalize('NFKC').toLowerCase();
  if (/^[a-z0-9]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

export function itemMatchesExcludedTerms(item, excludedTerms = []) {
  const haystack = `${item?.author_name || ''} ${item?.title || ''} ${item?.description || ''}`.normalize('NFKC').toLowerCase();
  return excludedTerms.some((term) => {
    const needle = compact(term).normalize('NFKC').toLowerCase();
    return Boolean(needle && haystack.includes(needle));
  });
}

export function keywordSearchAttemptLimit(resumeCurrent = false) {
  return resumeCurrent ? 1 : 2;
}

export function isTransientSearchScrollFailure(reason = '') {
  return reason === 'scroll_container_not_found';
}

export function applyKeywordSearchStandard(items = [], {
  keyword = '',
  minRedHearts = 1000,
  withinDays = 120,
  target = 1,
  maxScanned = 200,
  capturedAt = new Date().toISOString(),
} = {}) {
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) throw new Error('capturedAt must be a valid timestamp');
  const cutoffMs = capturedAtMs - (Number(withinDays) * 24 * 60 * 60 * 1000);
  const unique = uniqByVideoId(items);
  const scannedItems = [];
  const qualified = [];
  const counters = {
    irrelevant_keyword_count: 0,
    missing_red_heart_count: 0,
    red_heart_at_or_below_count: 0,
    missing_publish_time_count: 0,
    outside_time_window_count: 0,
  };
  for (const item of unique) {
    if (scannedItems.length >= maxScanned || qualified.length >= target) break;
    const redHeartCount = numericMetric(item.red_heart_count);
    const publishTimeMs = Date.parse(item.publish_time || '');
    const hasPublishTime = Number.isFinite(publishTimeMs);
    const withinWindow = hasPublishTime && publishTimeMs >= cutoffMs && publishTimeMs <= capturedAtMs + (5 * 60 * 1000);
    const keywordRelevant = itemMatchesKeyword(item, keyword);
    if (!keywordRelevant) counters.irrelevant_keyword_count += 1;
    if (redHeartCount === null) counters.missing_red_heart_count += 1;
    else if (redHeartCount <= minRedHearts) counters.red_heart_at_or_below_count += 1;
    if (!hasPublishTime) counters.missing_publish_time_count += 1;
    else if (!withinWindow) counters.outside_time_window_count += 1;
    const normalized = { ...item, keyword, red_heart_count: redHeartCount };
    scannedItems.push(normalized);
    if (keywordRelevant && redHeartCount !== null && redHeartCount > minRedHearts && withinWindow) qualified.push(normalized);
  }
  return {
    scanned_items: scannedItems,
    qualified_items: qualified,
    standard: {
      red_heart_field: 'statistics.digg_count',
      red_heart_operator: '>',
      min_red_hearts: minRedHearts,
      time_field: 'create_time',
      within_days: withinDays,
      captured_at: new Date(capturedAtMs).toISOString(),
      cutoff_at: new Date(cutoffMs).toISOString(),
      target_per_keyword: target,
      max_scanned_per_keyword: maxScanned,
      scanned_count: scannedItems.length,
      qualified_count: qualified.length,
      ...counters,
    },
  };
}

export function selectVisibleQualifiedCandidate(items = [], visibleIds = [], attemptedIds = [], options = {}) {
  const visible = new Set([...visibleIds].map(String));
  const attempted = new Set([...attemptedIds].map(String));
  const maxScanned = Number(options.maxScanned || options.maxScannedPerKeyword || 200);
  const selection = applyKeywordSearchStandard(items, {
    ...options,
    target: maxScanned,
    maxScanned,
  });
  return selection.qualified_items.find((candidate) => {
    const id = String(candidate.id || parseDouyinVideoId(candidate.url) || '');
    return visible.has(id) && !attempted.has(id);
  }) || null;
}

export async function fetchStructuredVideoDetail(client, videoUrl, defaults = {}) {
  const id = parseDouyinVideoId(videoUrl);
  if (!id) return { ok: false, error: 'missing_video_id', item: null };
  try {
    const response = await client.evaluate(`
      (async () => {
        const endpoint = new URL('/aweme/v1/web/aweme/detail/', location.origin);
        endpoint.searchParams.set('aweme_id', ${JSON.stringify(id)});
        const res = await fetch(endpoint.href, {
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' },
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { ok: res.ok, status: res.status, data };
      })()
    `);
    if (!response?.ok) return { ok: false, error: `http_${response?.status || 'unknown'}`, item: null };
    const aweme = response.data?.aweme_detail || response.data?.aweme || null;
    if (!aweme) return { ok: false, error: 'missing_aweme_detail', item: null };
    return { ok: true, error: null, item: normalizeStructuredVideo(aweme, { ...defaults, url: normalizeVideoUrl(videoUrl) }) };
  } catch (error) {
    return { ok: false, error: error.message || 'structured_fetch_failed', item: null };
  }
}

async function fetchStructuredVideoDetailWithRetry(client, videoUrl, defaults = {}, attempts = 6) {
  let last = { ok: false, error: 'structured_detail_unavailable', item: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await fetchStructuredVideoDetail(client, videoUrl, defaults);
    if (last.ok) return last;
    if (attempt < attempts) await sleep(750);
  }
  return last;
}

export function parseCreatorPostPayload(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const awemeList = data.aweme_list || data.awemeList || [];
  const marker = data.has_more ?? data.hasMore;
  const hasMore = marker === undefined || marker === null
    ? null
    : marker === true || marker === 1 || marker === '1';
  return {
    items: Array.isArray(awemeList) ? awemeList.map((aweme) => normalizeStructuredVideo(aweme)) : [],
    has_more: hasMore,
    cursor: data.max_cursor ?? data.maxCursor ?? data.cursor ?? null,
  };
}

async function drainCreatorPostResponses(client, queue = []) {
  const result = { items: [], has_more: null, cursor: null, responses: 0 };
  while (queue.length) {
    const response = queue.shift();
    try {
      const body = await client.send('Network.getResponseBody', { requestId: response.requestId }, { timeoutMs: 5000 });
      let text = body?.body || '';
      if (body?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
      const page = parseCreatorPostPayload(JSON.parse(text));
      result.items.push(...page.items);
      if (page.has_more !== null) result.has_more = page.has_more;
      if (page.cursor !== null) result.cursor = page.cursor;
      result.responses += 1;
    } catch (error) {
      if (process.env.DYCA_DEBUG_NETWORK) console.error(`creator-post body error: ${error.message}`);
    }
  }
  return result;
}

function uniqByVideoId(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = parseDouyinVideoId(item.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item, id, url: normalizeVideoUrl(item.url) });
  }
  return out;
}

async function waitForUsableDouyinPage(client, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(`
      (() => {
        const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const riskControl = /安全验证|滑块验证|验证一下|访问太频繁|请稍后再试|环境异常|操作过于频繁/.test(text);
        const loginRequired = /登录后|扫码登录|密码登录|手机号登录|请先登录/.test(text);
        const videoLinks = Array.from(document.querySelectorAll('a[href]')).filter((a) => /douyin\\.com\\/video\\//.test(new URL(a.getAttribute('href'), location.href).href)).length;
        return { ok: /douyin\\.com$/i.test(location.host) && !riskControl && !loginRequired, riskControl, loginRequired, videoLinks, href: location.href };
      })()
    `);
    if (last?.riskControl) throw new Error('Douyin requires verification. Complete it in the dedicated Chrome window and retry.');
    if (last?.loginRequired) throw new Error('Douyin requires login. Run `dyca login` and retry.');
    if (last?.ok) return last;
    await sleep(800);
  }
  throw new Error(`Douyin page was not usable before timeout: ${last?.href || 'unknown URL'}`);
}

async function collectVisibleVideoLinks(client) {
  return client.evaluate(`
    (() => {
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = new URL(a.getAttribute('href'), location.href).href;
        if (!/douyin\\.com\\/video\\//.test(href)) continue;
        const card = a.closest('li, article, div') || a;
        const title = clean(a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || card.innerText || '');
        out.push({ url: href, title });
      }
      return out;
    })()
  `);
}

async function collectVisibleSearchCards(client, capturedAt) {
  const raw = await client.evaluate(`
    (() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return [...document.querySelectorAll('[id^="waterfall_item_"]')].map((card) => {
        const lines = String(card.innerText || '').split('\\n').map(clean).filter(Boolean);
        const dateLine = lines.findLast((line) => /^(?:·\\s*)?(?:刚刚|片刻前|今天|昨天|前天|\\d+(?:\\.\\d+)?\\s*(?:分钟|小时|天|周)前|(?:(?:\\d{4})年)?\\d{1,2}月\\d{1,2}日)$/.test(line));
        const authorIndex = dateLine ? lines.indexOf(dateLine) - 1 : -1;
        const metricText = clean(card.querySelector('.pMq55q1M span:last-child')?.innerText || lines[1]);
        const title = clean(card.querySelector('.BjLsdJMi')?.innerText
          || (authorIndex > 2 ? lines.slice(2, authorIndex).join(' ') : lines[2]));
        return {
          id: card.id,
          kind: clean(card.querySelector('.FnM1bbIQ')?.innerText || lines[0]),
          metric_text: metricText,
          title,
          author_name: clean(card.querySelector('.WldPmwm5')?.innerText || (authorIndex >= 0 ? lines[authorIndex] : '')),
          date_text: clean(card.querySelector('.dO8W7uoF')?.innerText || dateLine),
        };
      });
    })()
  `);
  return raw.map((item) => normalizeSearchCardObservation(item, capturedAt)).filter(Boolean);
}

async function waitForSearchInput(client, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(`(() => {
      const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
      found: Boolean([...document.querySelectorAll('input')].find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''))),
      ready: document.readyState === 'complete',
      page_age_ms: Math.round(performance.now()),
      href: location.href,
      risk_control: /安全验证|滑块验证|验证一下|环境异常/.test(text),
      login_required: /扫码登录|密码登录|手机号登录|请先登录/.test(text),
      };
    })()`);
    if (last?.risk_control) throw new Error('Douyin requires verification. Complete it in the dedicated Chrome window and retry.');
    if (last?.login_required) throw new Error('Douyin requires login. Run `dyca login` and retry.');
    if (last?.found && last?.ready && last.page_age_ms >= 2500) return;
    await sleep(500);
  }
  throw new Error(`Douyin search input was not found before timeout: ${last?.href || 'unknown URL'}`);
}

async function submitSearchKeyword(client, keyword) {
  const searchQuery = keyword.startsWith('#') ? keyword : `#${keyword}`;
  await waitForSearchInput(client);
  const previousHref = await client.evaluate('location.href');
  debugSearch(`input ready for ${searchQuery}`);
  await client.send('Page.bringToFront');
  const inputPoint = await client.evaluate(`
    (() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  if (!inputPoint) throw new Error('Douyin search UI failed: search_input_not_found');
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputPoint.x, y: inputPoint.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputPoint.x, y: inputPoint.y, button: 'left', clickCount: 1 });
  const focused = await client.evaluate(`
    (() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      input?.focus();
      return Boolean(input && document.activeElement === input);
    })()
  `);
  if (!focused) throw new Error('Douyin search UI failed: search_input_focus_failed');
  let cleared = false;
  for (let clearAttempt = 0; clearAttempt < 2 && !cleared; clearAttempt += 1) {
    await client.evaluate(`
      (() => {
        const input = [...document.querySelectorAll('input')]
          .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
        input?.focus();
        input?.select();
        return Boolean(input);
      })()
    `);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', commands: ['deleteBackward'] });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(200);
    cleared = await client.evaluate(`
      (() => {
        const input = [...document.querySelectorAll('input')]
          .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
        return Boolean(input && input.value === '');
      })()
    `);
  }
  if (!cleared) throw new Error('Douyin search UI failed: previous_keyword_not_cleared');
  // Douyin may re-render the search input while typing. Insert the complete
  // query in one focused-input operation so characters are not lost.
  await client.send('Input.insertText', { text: searchQuery });
  await sleep(Math.max(200, searchQuery.length * 35));
  debugSearch(`typing completed for ${searchQuery}`);
  const action = await client.evaluate(`
    (() => {
      const input = [...document.querySelectorAll('input')]
        .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
      const button = [...document.querySelectorAll('button')]
        .find((node) => String(node.innerText || node.getAttribute('aria-label') || '').trim() === '搜索');
      if (!input || input.value !== ${JSON.stringify(searchQuery)}) return { ok: false, reason: 'search_input_value_mismatch', value: input?.value || '' };
      if (!button) return { ok: false, reason: 'search_button_not_found', value: input.value };
      button.focus();
      button.click();
      return { ok: true, value: input.value };
    })()
  `);
  if (!action?.ok) throw new Error(`Douyin search UI failed: ${action?.reason || 'unknown'}${action?.value ? ` (actual: ${action.value})` : ''}`);
  debugSearch(`search button clicked for ${searchQuery}`);
  await sleep(1500);

  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(`
      (() => {
        const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const input = [...document.querySelectorAll('input')]
          .find((node) => /搜索/.test(node.placeholder || node.getAttribute('aria-label') || ''));
        let decodedHref = location.href;
        let decodedPreviousHref = ${JSON.stringify(previousHref)};
        try { decodedHref = decodeURIComponent(location.href); } catch {}
        try { decodedPreviousHref = decodeURIComponent(decodedPreviousHref); } catch {}
        return {
          href: location.href,
          value: input?.value || '',
          ready: /\\/search\\//.test(location.pathname)
            && input?.value === ${JSON.stringify(searchQuery)}
            && (location.href !== ${JSON.stringify(previousHref)} || decodedPreviousHref.includes(${JSON.stringify(searchQuery)}))
            && decodedHref.includes(${JSON.stringify(searchQuery)}),
          risk_control: /安全验证|滑块验证|验证一下|环境异常/.test(text),
          rate_limited: /搜索过于频繁|访问太频繁|请稍后再试|操作过于频繁/.test(text),
          login_required: /扫码登录|密码登录|手机号登录|请先登录/.test(text),
        };
      })()
    `);
    if (last?.risk_control) throw new Error('Douyin requires verification. Complete it in the dedicated Chrome window and retry.');
    if (last?.login_required) throw new Error('Douyin requires login. Run `dyca login` and retry.');
    if (last?.ready) {
      debugSearch(`results page ready for ${searchQuery}`);
      break;
    }
    if (last?.rate_limited) {
      const error = new Error('Douyin search is rate limited');
      error.code = 'DOUYIN_RATE_LIMITED';
      throw error;
    }
    await sleep(750);
  }
  if (!last?.ready) throw new Error(`Douyin search results did not load for keyword: ${keyword}`);
  return last;
}

async function waitForQueuedSearchResponse(queue, keyword, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (queue.some((item) => item.keyword === keyword)) return true;
    await sleep(500);
  }
  return false;
}

async function drainSearchResponses(client, queue, keyword) {
  const selected = [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].keyword !== keyword) continue;
    selected.unshift(queue[index]);
    queue.splice(index, 1);
  }
  const items = [];
  let parsedResponses = 0;
  for (const response of selected) {
    try {
      const body = await client.send('Network.getResponseBody', { requestId: response.requestId }, { timeoutMs: 10000 });
      let text = body?.body || '';
      if (body?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
      items.push(...parseSearchStreamBody(text));
      parsedResponses += 1;
    } catch (error) {
      if (process.env.DYCA_DEBUG_NETWORK) console.error(`search-stream body error: ${error.message}`);
    }
  }
  return { items: uniqByVideoId(items), parsed_responses: parsedResponses };
}

async function scrollSearchResults(client) {
  return client.evaluate(`
    (() => {
      const candidates = [...document.querySelectorAll('*')]
        .filter((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return /auto|scroll/.test(style.overflowY)
            && node.scrollHeight > node.clientHeight + 200
            && node.clientHeight > 200
            && rect.width > 300;
        })
        .sort((a, b) => b.clientHeight - a.clientHeight);
      const root = document.scrollingElement || document.documentElement;
      const rootScrollable = root.scrollHeight > Math.max(root.clientHeight, innerHeight) + 200;
      const target = rootScrollable ? root : candidates[0];
      if (!target) return { ok: false, reason: 'scroll_container_not_found', at_end: true };
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollHeight, target.scrollTop + Math.max(target.clientHeight * 2.5, 1600));
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      const after = target.scrollTop;
      const tailText = String(target.innerText || '').slice(-500);
      return {
        ok: true,
        target: target === root ? 'document' : 'nested',
        before,
        after,
        moved: after > before,
        at_end: after + target.clientHeight >= target.scrollHeight - 8,
        explicit_end: /暂时没有更多了|没有更多内容|已经到底了/.test(tailText),
        scroll_height: target.scrollHeight,
        client_height: target.clientHeight,
      };
    })()
  `);
}

export async function collectKeywordSearchBatch({
  keywords = [],
  targetPerKeyword = 1,
  maxScannedPerKeyword = 200,
  minRedHearts = 1000,
  withinDays = 120,
  maxScrollRounds = 200,
  scrollDelayMs = 2500,
  responseWaitMs = 15000,
  rateLimitBackoffMs = 180000,
  profileDir = DEFAULT_PROFILE_DIR,
  chromePath = DEFAULT_CHROME_PATH,
  port = DEFAULT_CDP_PORT,
  visible = true,
  onProgress = null,
  onCheckpoint = null,
  onQualified = null,
  onKeywordBatch = null,
  deferQualifiedProcessing = false,
  resumeCurrent = false,
  seedQualifiedItems = [],
  excludedTerms = [],
  excludedVideoIds = [],
} = {}) {
  const normalizedKeywords = [...new Set(keywords.map((value) => compact(value)).filter(Boolean))];
  if (!normalizedKeywords.length) throw new Error('At least one keyword is required');
  const capturedAt = new Date().toISOString();
  const previousFrontmostApplication = await captureFrontmostApplication();
  await launchChrome({ chromePath, profileDir, port, url: 'https://www.douyin.com/jingxuan', visible });
  const client = new CDPClient({ commandTimeoutMs: 30000 });
  await client.connect(port, {
    initialUrl: 'https://www.douyin.com/jingxuan',
    reuseUrlPattern: '^(?!.*[?&]modal_id=)https://www\\.douyin\\.com/(?:jingxuan(?:/search/|$)|search/)',
  });
  const keepAlive = setInterval(() => {}, 1000);
  const responseQueue = [];
  const pendingRequests = new Map();
  let activeKeyword = null;
  try {
    await client.send('Network.enable');
    client.on('Network.responseReceived', (params) => {
      const url = String(params.response?.url || '');
      if (!/\/aweme\/v1\/web\/general\/search\/(?:stream|single)\//i.test(url)) return;
      pendingRequests.set(params.requestId, activeKeyword);
    });
    client.on('Network.loadingFinished', (params) => {
      const keyword = pendingRequests.get(params.requestId);
      if (!keyword) return;
      pendingRequests.delete(params.requestId);
      responseQueue.push({ requestId: params.requestId, keyword });
    });
    client.on('Network.loadingFailed', (params) => pendingRequests.delete(params.requestId));
    const keywordReports = [];
    const qualifiedItems = [];
    const scannedItems = [];
    const explicitlyExcludedIds = new Set(excludedVideoIds.map(String));
    for (let keywordIndex = 0; keywordIndex < normalizedKeywords.length; keywordIndex += 1) {
      const keyword = normalizedKeywords[keywordIndex];
      const searchQuery = keyword.startsWith('#') ? keyword : `#${keyword}`;
      const resumeThisKeyword = Boolean(resumeCurrent && keywordIndex === 0);
      activeKeyword = keyword;
      onProgress?.({ phase: 'keyword_start', keyword, keyword_index: keywordIndex + 1, keyword_total: normalizedKeywords.length });
      const keywordSeedItems = seedQualifiedItems
        .filter((item) => item?.id && compact(item.keyword).replace(/^#+/, '') === keyword.replace(/^#+/, ''));
      const seedMap = () => new Map(keywordSeedItems.map((item) => [String(item.id), item]));
      let observed = seedMap();
      const verifiedQualifiedItems = new Map(observed);
      const attemptedCandidateIds = new Set(observed.keys());
      const previouslyAcceptedIds = new Set(qualifiedItems.map((entry) => String(entry.id || parseDouyinVideoId(entry.url) || '')));
      const applyExclusion = (entry) => {
        const id = String(entry.id || parseDouyinVideoId(entry.url) || '');
        const exclusionReason = explicitlyExcludedIds.has(id) || previouslyAcceptedIds.has(id)
          ? 'excluded_video_id'
          : (itemMatchesExcludedTerms(entry, excludedTerms) ? 'excluded_term' : null);
        return exclusionReason ? { ...entry, red_heart_count: null, exclusion_reason: exclusionReason } : entry;
      };
      let parsedResponses = 0;
      let roundsCompleted = 0;
      let searchAttempts = 0;
      let selection = applyKeywordSearchStandard([], {
        keyword,
        minRedHearts,
        withinDays,
        target: targetPerKeyword,
        maxScanned: maxScannedPerKeyword,
        capturedAt,
      });
      let stopReason = 'no_search_response';
      for (let attempt = 1; attempt <= keywordSearchAttemptLimit(resumeThisKeyword); attempt += 1) {
        searchAttempts = attempt;
        if (attempt > 1) {
          onProgress?.({ phase: 'keyword_retry', keyword, attempt });
          await sleep(Math.max(1500, Number(scrollDelayMs || 0)));
        }
        if (resumeThisKeyword && attempt === 1) {
          if (!await currentSearchMatches(client, searchQuery)) {
            throw new Error(`Cannot resume: current Douyin page is not ${searchQuery} search results`);
          }
          onProgress?.({ phase: 'keyword_resume', keyword, seeded: observed.size });
        } else {
          let submitted = false;
          for (let rateAttempt = 1; rateAttempt <= 3 && !submitted; rateAttempt += 1) {
            try {
              await submitSearchKeyword(client, keyword);
              submitted = true;
            } catch (error) {
              if (error?.code !== 'DOUYIN_RATE_LIMITED' || rateAttempt >= 3) throw error;
              onProgress?.({
                phase: 'rate_limit_wait',
                keyword,
                attempt: rateAttempt,
                wait_ms: rateLimitBackoffMs,
              });
              await sleep(rateLimitBackoffMs);
            }
          }
        }
        debugSearch(`collector entered scan loop for ${keyword} attempt=${attempt}`);
        if (!resumeThisKeyword || attempt > 1) observed = seedMap();
        parsedResponses = 0;
        let stableRounds = 0;
        let transientScrollRounds = 0;
        roundsCompleted = 0;
        for (let round = 0; round < maxScrollRounds; round += 1) {
          roundsCompleted = round + 1;
          debugSearch(`waiting response keyword=${keyword} round=${round + 1}`);
          await waitForQueuedSearchResponse(responseQueue, keyword, round === 0 ? responseWaitMs : Math.min(responseWaitMs, 8000));
          debugSearch(`draining response keyword=${keyword} round=${round + 1} queued=${responseQueue.length}`);
          const drained = await drainSearchResponses(client, responseQueue, keyword);
          parsedResponses += drained.parsed_responses;
          const before = observed.size;
          for (const item of drained.items) {
            if (item.id && !observed.has(item.id)) observed.set(item.id, applyExclusion(item));
          }
          const cardItems = await collectVisibleSearchCards(client, capturedAt);
          let visibleCardIds = new Set(cardItems.map((item) => String(item.id)));
          for (const item of cardItems) {
            if (item.id && !observed.has(item.id)) observed.set(item.id, applyExclusion(item));
          }
          while (verifiedQualifiedItems.size < targetPerKeyword) {
            const qualifiedItem = selectVisibleQualifiedCandidate(
              [...observed.values()],
              visibleCardIds,
              attemptedCandidateIds,
              {
              keyword,
              minRedHearts,
              withinDays,
              maxScanned: maxScannedPerKeyword,
              capturedAt,
              },
            );
            if (!qualifiedItem) break;
            const qualifiedId = String(qualifiedItem.id || parseDouyinVideoId(qualifiedItem.url) || '');
            attemptedCandidateIds.add(qualifiedId);
            onProgress?.({ phase: 'qualified_start', keyword, item: qualifiedItem });
            let transaction;
            try {
              transaction = await processQualifiedItemTransaction(client, qualifiedItem, {
                searchQuery,
                onQualified: deferQualifiedProcessing ? null : onQualified,
                keyword,
                minRedHearts,
                withinDays,
                capturedAt,
                excludedTerms,
                excludedVideoIds: [...explicitlyExcludedIds, ...previouslyAcceptedIds],
                onBackupCreated: (backup) => onProgress?.({ phase: 'backup_tab_created', keyword, ...backup }),
              });
            } catch (error) {
              // Waterfall virtualization can remove a card between observation
              // and click. Continue only when the visible search state is still
              // intact; navigation/back failures remain fatal.
              let searchRestored = false;
              for (let check = 0; check < 6 && !searchRestored; check += 1) {
                try { searchRestored = await currentSearchMatches(client, searchQuery); }
                catch {}
                if (!searchRestored) await sleep(300);
              }
              if (!searchRestored) throw error;
              transaction = { processed: false, rejected_reason: error.message || 'candidate_open_failed' };
            }
            if (transaction.processed) {
              verifiedQualifiedItems.set(qualifiedId, transaction.item);
              observed.set(qualifiedId, transaction.item);
              onProgress?.({ phase: 'qualified_done', keyword, item: transaction.item, transaction });
            } else {
              observed.set(qualifiedId, {
                ...qualifiedItem,
                red_heart_count: null,
                structured_verification_error: transaction.rejected_reason,
              });
              onProgress?.({ phase: 'qualified_rejected', keyword, item: qualifiedItem, transaction });
            }
            const refreshedCards = await collectVisibleSearchCards(client, capturedAt);
            visibleCardIds = new Set(refreshedCards.map((entry) => String(entry.id)));
            for (const entry of refreshedCards) {
              if (entry.id && !observed.has(entry.id)) observed.set(entry.id, applyExclusion(entry));
            }
          }
          selection = applyKeywordSearchStandard([...observed.values()], {
            keyword,
            minRedHearts,
            withinDays,
            target: targetPerKeyword,
            maxScanned: maxScannedPerKeyword,
            capturedAt,
          });
          onProgress?.({
            phase: 'keyword_scan',
            keyword,
            round: round + 1,
            scanned: selection.standard.scanned_count,
            qualified: verifiedQualifiedItems.size,
          });
          if (round === 0 && parsedResponses === 0 && observed.size === 0 && !resumeThisKeyword) {
            stopReason = 'no_search_response';
            break;
          }
          if (verifiedQualifiedItems.size >= targetPerKeyword) {
            stopReason = 'target_reached';
            break;
          }
          if (selection.standard.scanned_count >= maxScannedPerKeyword) {
            stopReason = 'scan_limit_reached';
            break;
          }
          let scroll = null;
          let scrollError = null;
          for (let scrollAttempt = 0; scrollAttempt < 4 && !scroll; scrollAttempt += 1) {
            try { scroll = await scrollSearchResults(client); }
            catch (error) {
              scrollError = error;
              await sleep(300);
            }
          }
          if (!scroll) {
            let searchIntact = false;
            try { searchIntact = await currentSearchMatches(client, searchQuery); } catch {}
            if (!searchIntact) throw scrollError || new Error('Douyin search scroll failed');
            scroll = { ok: false, reason: 'scroll_container_not_found' };
          }
          debugSearch(`scroll keyword=${keyword} ok=${scroll?.ok} before=${scroll?.before ?? 'n/a'} after=${scroll?.after ?? 'n/a'}`);
          if (!scroll?.ok) {
            if (!isTransientSearchScrollFailure(scroll?.reason)) {
              throw new Error(`Douyin search scroll failed: ${scroll?.reason || 'unknown'}`);
            }
            transientScrollRounds += 1;
            await sleep(Math.max(500, Number(scrollDelayMs || 0)));
            if (transientScrollRounds >= 10) {
              stopReason = 'scroll_stalled_before_scan_limit';
              break;
            }
            continue;
          }
          transientScrollRounds = 0;
          await sleep(Math.max(500, Number(scrollDelayMs || 0)));
          if (scroll.explicit_end) {
            stopReason = 'results_exhausted';
            break;
          }
          stableRounds = observed.size === before && scroll.at_end && !scroll.moved ? stableRounds + 1 : 0;
          if (stableRounds >= 5) {
            stopReason = 'scroll_stalled_before_scan_limit';
            break;
          }
        }
        if (stopReason === 'no_search_response' && observed.size > 0) stopReason = 'scroll_round_limit_reached';
        if (parsedResponses > 0 || observed.size > 0 || (resumeThisKeyword && attempt === 1)) break;
      }
      if (parsedResponses === 0 && observed.size === 0 && !resumeThisKeyword) {
        throw new Error(`Douyin returned neither structured responses nor visible result cards after 2 attempts: ${keyword}`);
      }
      const report = {
        keyword,
        search_query: searchQuery,
        keyword_index: keywordIndex + 1,
        stop_reason: stopReason,
        rounds_completed: roundsCompleted,
        search_attempts: searchAttempts,
        parsed_search_responses: parsedResponses,
        observed_unique_count: observed.size,
        excluded_term_count: [...observed.values()].filter((item) => item.exclusion_reason === 'excluded_term').length,
        excluded_video_id_count: [...observed.values()].filter((item) => item.exclusion_reason === 'excluded_video_id').length,
        resumed_from_existing_results: resumeThisKeyword,
        ...selection.standard,
        qualified_count: verifiedQualifiedItems.size,
      };
      keywordReports.push(report);
      scannedItems.push(...selection.scanned_items);
      qualifiedItems.push(...verifiedQualifiedItems.values());
      onProgress?.({ phase: 'keyword_done', ...report });
      if (deferQualifiedProcessing && typeof onKeywordBatch === 'function') {
        const seedIds = new Set(keywordSeedItems
          .filter((item) => item.metadata_status === 'seeded_verified_ingestion')
          .map((item) => String(item.id)));
        const batchItems = [...verifiedQualifiedItems.values()]
          .filter((item) => !seedIds.has(String(item.id)));
        await onKeywordBatch(batchItems, { keyword, search_query: searchQuery });
        onProgress?.({ phase: 'keyword_batch_queued', keyword, count: batchItems.length });
      }
      await onCheckpoint?.({
        captured_at: capturedAt,
        keywords: normalizedKeywords,
        qualified_items: [...qualifiedItems],
        scanned_items: [...scannedItems],
        keyword_reports: [...keywordReports],
      });
      if (keywordIndex < normalizedKeywords.length - 1) await sleep(Math.max(1000, Number(scrollDelayMs || 0)));
    }
    return {
      captured_at: capturedAt,
      keywords: normalizedKeywords,
      qualified_items: qualifiedItems,
      scanned_items: scannedItems,
      keyword_reports: keywordReports,
    };
  } finally {
    clearInterval(keepAlive);
    await client.disconnect().catch(() => {});
    await restoreFrontmostApplication(previousFrontmostApplication);
  }
}

export async function collectCreatorSnapshot({
  creatorUrl,
  limit = 100,
  scrollRounds = 80,
  profileDir = DEFAULT_PROFILE_DIR,
  chromePath = DEFAULT_CHROME_PATH,
  port = DEFAULT_CDP_PORT,
  visible = true,
  metadataDelayMs = 300,
  onProgress = null,
} = {}) {
  if (!creatorUrl) throw new Error('Missing --creator-url');
  await launchChrome({ chromePath, profileDir, port, url: 'https://www.douyin.com/', visible });
  const client = new CDPClient({ commandTimeoutMs: 30000 });
  await client.connect(port, { initialUrl: 'https://www.douyin.com/' });
  try {
    const postResponses = [];
    const postRequestIds = new Set();
    try {
      await client.send('Network.enable');
      client.on('Network.responseReceived', (params) => {
        const url = String(params.response?.url || '');
        if (/aweme\/v1\/web\/aweme\/post/i.test(url)) {
          postRequestIds.add(params.requestId);
        }
      });
      client.on('Network.loadingFinished', (params) => {
        if (!postRequestIds.delete(params.requestId)) return;
        postResponses.push({ requestId: params.requestId });
      });
      client.on('Network.loadingFailed', (params) => {
        postRequestIds.delete(params.requestId);
      });
    } catch {}
    await client.goto(creatorUrl, 6000);
    await waitForUsableDouyinPage(client);
    let videos = [];
    const structured = new Map();
    let stableRounds = 0;
    let roundsCompleted = 0;
    let stopReason = 'scroll_rounds_exhausted';
    let paginationObserved = false;
    let hasMore = null;
    let cursor = null;
    const refreshStructured = async () => {
      const page = await drainCreatorPostResponses(client, postResponses);
      if (page.responses) paginationObserved = true;
      if (page.has_more !== null) hasMore = page.has_more;
      if (page.cursor !== null) cursor = page.cursor;
      for (const item of page.items) {
        if (item.id && !structured.has(item.id)) structured.set(item.id, item);
      }
    };
    const mergeObserved = (domVideos = []) => uniqByVideoId([
      ...structured.values(),
      ...domVideos,
    ]).slice(0, limit);
    await refreshStructured();
    for (let round = 0; round < Number(scrollRounds || 80); round += 1) {
      roundsCompleted = round + 1;
      const before = videos.length;
      videos = mergeObserved([...videos, ...(await collectVisibleVideoLinks(client))]);
      onProgress?.({ phase: 'list', round: round + 1, found: videos.length });
      if (videos.length >= limit) {
        stopReason = 'limit_reached';
        break;
      }
      if (paginationObserved && hasMore === false) {
        stopReason = 'cursor_exhausted';
        break;
      }
      await client.evaluate('window.scrollBy(0, Math.max(900, window.innerHeight * 0.85))');
      await sleep(1800);
      await refreshStructured();
      videos = mergeObserved(videos);
      if (videos.length === before) stableRounds += 1;
      else stableRounds = 0;
      if (stableRounds >= 6) {
        stopReason = 'dom_stable';
        break;
      }
    }
    const enriched = [];
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      if (video.metadata_status === 'structured') {
        enriched.push(video);
        onProgress?.({ phase: 'metadata', index: index + 1, total: videos.length, ok: true });
      } else {
        const detail = await fetchStructuredVideoDetail(client, video.url, video);
        enriched.push(detail.ok ? detail.item : { ...video, metadata_status: 'failed', metadata_error: detail.error });
        onProgress?.({ phase: 'metadata', index: index + 1, total: videos.length, ok: detail.ok });
      }
      if (index < videos.length - 1) await sleep(Math.max(0, Number(metadataDelayMs || 0)));
    }
    const complete = stopReason === 'cursor_exhausted' && paginationObserved && hasMore === false;
    return {
      videos: enriched,
      listing: {
        observed_count: enriched.length,
        rounds_completed: roundsCompleted,
        stop_reason: stopReason,
        pagination_observed: paginationObserved,
        has_more: hasMore,
        cursor,
        complete,
        completeness_note: complete
          ? 'Creator post pagination returned has_more=false without hitting the requested limit.'
          : 'The run did not prove creator-page exhaustion; treat observed_count as non-authoritative.',
      },
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function collectCreatorVideos(options = {}) {
  return (await collectCreatorSnapshot(options)).videos;
}

function isMediaUrl({ url = '', mimeType = '', resourceType = '' } = {}) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(?:css|js|png|jpe?g|webp|gif|svg|woff2?)(?:\?|$)/i.test(value)) return false;
  const mime = String(mimeType || '').toLowerCase();
  const type = String(resourceType || '').toLowerCase();
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  if (type === 'media' && /(?:mime_type=(?:audio|video)|\.mp4|douyinvod|tos-cn-[av]e)/i.test(value)) return true;
  return /(?:mime_type=(?:audio|video)_mp4|\/(?:audio|video)\/tos\/|douyinvod|v\d+-dy-|\.mp4(?:\?|$))/i.test(value);
}

function scoreMedia(candidate = {}) {
  if (!isMediaUrl(candidate)) return -1;
  let score = 0;
  const url = String(candidate.url || '');
  const mime = String(candidate.mimeType || '').toLowerCase();
  if (mime === 'video/mp4') score += 180;
  else if (mime.startsWith('video/')) score += 140;
  else if (mime.startsWith('audio/')) score += 90;
  if (/mime_type=video_mp4/i.test(url)) score += 140;
  if (/douyinvod|\/video\/tos\/|tos-cn-ve/i.test(url)) score += 90;
  if (Number(candidate.encodedDataLength) > 0) score += Math.min(80, Math.floor(Number(candidate.encodedDataLength) / 1024 / 1024));
  score += Math.min(20, Number(candidate.seenIndex || 0));
  return score;
}

function bestMedia(candidates) {
  return [...candidates].filter((item) => scoreMedia(item) >= 0).sort((a, b) => scoreMedia(b) - scoreMedia(a))[0] || null;
}

export async function resolveVideoMedia({
  videoUrl,
  profileDir = DEFAULT_PROFILE_DIR,
  chromePath = DEFAULT_CHROME_PATH,
  port = DEFAULT_CDP_PORT,
  visible = true,
  timeoutMs = 90000,
} = {}) {
  const id = parseDouyinVideoId(videoUrl);
  if (!id) throw new Error(`Cannot parse Douyin video id from ${videoUrl}`);
  await launchChrome({ chromePath, profileDir, port, url: 'https://www.douyin.com/', visible });
  const client = new CDPClient({ commandTimeoutMs: 30000 });
  const candidates = new Map();
  let seenIndex = 0;
  const record = (requestId, patch) => {
    if (!requestId) return;
    const current = candidates.get(requestId) || { requestId, seenIndex: ++seenIndex };
    candidates.set(requestId, { ...current, ...patch });
  };
  await client.connect(port, { initialUrl: 'https://www.douyin.com/' });
  try {
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', (params) => {
      record(params.requestId, {
        url: params.request?.url,
        resourceType: params.type,
        headers: {
          referer: 'https://www.douyin.com/',
          'user-agent': params.request?.headers?.['User-Agent'] || params.request?.headers?.['user-agent'] || undefined,
        },
      });
    });
    client.on('Network.responseReceived', (params) => {
      record(params.requestId, {
        url: params.response?.url,
        mimeType: params.response?.mimeType,
        resourceType: params.type,
      });
    });
    client.on('Network.loadingFinished', (params) => {
      record(params.requestId, { encodedDataLength: params.encodedDataLength });
    });
    await client.goto(normalizeVideoUrl(videoUrl), 7000);
    await waitForUsableDouyinPage(client);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pageMedia = await client.evaluate(`
        (async () => {
          const video = document.querySelector('video');
          if (!video) return null;
          video.muted = true;
          video.volume = 0;
          try { await video.play(); } catch {}
          return video.currentSrc && /^https?:/.test(video.currentSrc) ? { url: video.currentSrc, mimeType: 'video/mp4', resourceType: 'page-video' } : null;
        })()
      `).catch(() => null);
      if (pageMedia?.url) return { id, mediaUrl: pageMedia.url, headers: { referer: 'https://www.douyin.com/' }, source: 'page-video' };
      const selected = bestMedia(candidates.values());
      if (selected?.url) return { id, mediaUrl: selected.url, headers: selected.headers || { referer: 'https://www.douyin.com/' }, source: 'network-media' };
      await sleep(1000);
    }
    throw new Error(`No playable media URL captured for video ${id}`);
  } finally {
    await client.close().catch(() => {});
  }
}
