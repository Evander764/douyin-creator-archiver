import { CDPClient, launchChrome } from './cdp.js';
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

export function normalizeStructuredVideo(aweme = {}, defaults = {}) {
  const statistics = aweme.statistics || {};
  const video = aweme.video || {};
  const author = aweme.author || {};
  const id = String(aweme.aweme_id || aweme.awemeId || parseDouyinVideoId(defaults.url) || '');
  const title = compact(aweme.desc || aweme.item_title || defaults.title);
  return {
    ...defaults,
    id,
    url: id ? normalizeVideoUrl(`https://www.douyin.com/video/${id}`) : defaults.url,
    title,
    description: title,
    author_name: author.nickname || defaults.author_name || null,
    publish_time: epochToISO(aweme.create_time || aweme.createTime),
    like_count: statistics.digg_count ?? statistics.like_count ?? null,
    favorite_count: statistics.collect_count ?? statistics.favorite_count ?? null,
    comment_count: statistics.comment_count ?? null,
    share_count: statistics.share_count ?? null,
    cover_url: firstUrl(video.origin_cover, video.raw_cover, video.cover, video.dynamic_cover),
    download_url: firstUrl(video.download_addr),
    duration_ms: Number(video.duration || aweme.duration || 0) || null,
    metadata_status: 'structured',
  };
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
        const riskControl = /验证码|安全验证|验证一下|访问太频繁|请稍后再试|环境异常|操作过于频繁/.test(text);
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
    await client.goto(creatorUrl, 6000);
    await waitForUsableDouyinPage(client);
    let videos = [];
    let stableRounds = 0;
    let roundsCompleted = 0;
    let stopReason = 'scroll_rounds_exhausted';
    for (let round = 0; round < Number(scrollRounds || 80); round += 1) {
      roundsCompleted = round + 1;
      const before = videos.length;
      videos = uniqByVideoId([...videos, ...(await collectVisibleVideoLinks(client))]).slice(0, limit);
      onProgress?.({ phase: 'list', round: round + 1, found: videos.length });
      if (videos.length >= limit) {
        stopReason = 'limit_reached';
        break;
      }
      await client.evaluate('window.scrollBy(0, Math.max(900, window.innerHeight * 0.85))');
      await sleep(1800);
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
      const detail = await fetchStructuredVideoDetail(client, video.url, video);
      enriched.push(detail.ok ? detail.item : { ...video, metadata_status: 'failed', metadata_error: detail.error });
      onProgress?.({ phase: 'metadata', index: index + 1, total: videos.length, ok: detail.ok });
      if (index < videos.length - 1) await sleep(Math.max(0, Number(metadataDelayMs || 0)));
    }
    return {
      videos: enriched,
      listing: {
        observed_count: enriched.length,
        rounds_completed: roundsCompleted,
        stop_reason: stopReason,
        complete: false,
        completeness_note: 'DOM scrolling cannot prove creator-page exhaustion; treat this as observed_count, not an authoritative total.',
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
