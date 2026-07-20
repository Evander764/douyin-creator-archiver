import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import {
  DEFAULT_CDP_PORT,
  DEFAULT_CHROME_PATH,
  DEFAULT_PROFILE_DIR,
  ensureDir,
  fileExists,
  parseArgs,
  parseBool,
  required,
  sanitizeSegment,
  sleep,
} from './utils.js';
import { launchChrome } from './cdp.js';
import {
  collectCreatorSnapshot,
  collectKeywordSearchBatch,
  parseDouyinVideoId,
  resolveVideoMedia,
} from './douyin.js';
import { curlDownload, downloadAudioWithYtDlp, downloadMusicPlayUrl, extractAudio } from './download.js';
import { transcribeAudio } from './transcribe.js';

const execFileAsync = promisify(execFile);

function usage() {
  return `Douyin Creator Archiver

Usage:
  dyca doctor
  dyca login [--profile-dir PATH] [--port 9533]
  dyca search-keywords --keywords-file FILE [--out DIR] [--target-per-keyword 1] [--max-scanned-per-keyword 200] [--min-red-hearts 1000] [--within-days 60] [--qualified-hook SCRIPT] [--hook-concurrency 2]
  dyca list --creator-url URL [--out DIR] [--limit N] [--min-red-hearts 1000]
  dyca archive --creator-url URL [--out DIR] [--limit N] [--min-red-hearts 1000] [--mode audio|video|both] [--transcribe true --whisper-model PATH]
  dyca archive-urls --input ROWS.jsonl [--out DIR] [--limit N] [--min-red-hearts 1000] [--mode audio|video|both] [--transcribe true --whisper-model PATH]
`;
}

function minimumRedHearts(args) {
  const value = Number(args['min-red-hearts'] ?? args['min-likes'] ?? 1000);
  if (!Number.isFinite(value) || value < 0) throw new Error('--min-red-hearts must be a non-negative number');
  return Math.floor(value);
}

function numericMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function filterByMinimumRedHearts(videos = [], threshold = 1000) {
  const qualified = [];
  let atOrBelowThreshold = 0;
  let missingRedHeartCount = 0;
  for (const video of videos) {
    const redHeartCount = numericMetric(video.red_heart_count ?? video.like_count);
    if (redHeartCount === null) {
      missingRedHeartCount += 1;
    } else if (redHeartCount <= threshold) {
      atOrBelowThreshold += 1;
    } else {
      qualified.push({ ...video, red_heart_count: redHeartCount });
    }
  }
  return {
    videos: qualified,
    standard: {
      field: 'statistics.digg_count',
      operator: '>',
      threshold,
      observed_count: videos.length,
      qualified_count: qualified.length,
      at_or_below_threshold_count: atOrBelowThreshold,
      missing_red_heart_count: missingRedHeartCount,
    },
  };
}

export function filterByMinimumLikes(videos = [], threshold = 1000) {
  return filterByMinimumRedHearts(videos, threshold);
}

function applyRedHeartStandard(snapshot, threshold) {
  const filtered = filterByMinimumRedHearts(snapshot.videos, threshold);
  return {
    videos: filtered.videos,
    listing: { ...snapshot.listing, red_heart_standard: filtered.standard },
  };
}

function commonOptions(args) {
  return {
    profileDir: resolve(String(args['profile-dir'] || DEFAULT_PROFILE_DIR)),
    chromePath: String(args['chrome-path'] || DEFAULT_CHROME_PATH),
    port: Number(args.port || DEFAULT_CDP_PORT),
    visible: parseBool(args.visible, true),
  };
}

async function commandDoctor() {
  const checks = [];
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version });
  checks.push({ name: 'chrome', ok: fileExists(DEFAULT_CHROME_PATH), detail: DEFAULT_CHROME_PATH });
  checks.push({ name: 'curl', ok: fileExists('/usr/bin/curl'), detail: '/usr/bin/curl' });
  let ffmpegOk = false;
  let ffmpegDetail = '/opt/homebrew/bin/ffmpeg';
  try {
    const { stdout } = await execFileAsync('/opt/homebrew/bin/ffmpeg', ['-version'], { encoding: 'utf8', timeout: 3000 });
    ffmpegOk = /ffmpeg version/i.test(stdout);
  } catch (error) {
    ffmpegDetail = error.message;
  }
  checks.push({ name: 'ffmpeg', ok: ffmpegOk, detail: ffmpegDetail });
  for (const check of checks) {
    console.log(`${check.ok ? 'OK ' : 'ERR'} ${check.name}: ${check.detail}`);
  }
  const whisperCli = '/opt/homebrew/bin/whisper-cli';
  const whisperModel = process.env.DYCA_WHISPER_MODEL || '';
  console.log(`${existsSync(whisperCli) ? 'OPT' : 'MISS'} whisper-cli: ${whisperCli}`);
  console.log(`${whisperModel && existsSync(whisperModel) ? 'OPT' : 'MISS'} whisper-model: ${whisperModel || 'set DYCA_WHISPER_MODEL or pass --whisper-model'}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function commandLogin(args) {
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  await launchChrome({ ...options, url: 'https://www.douyin.com/', visible: true });
  console.log(`Opened Douyin login window with profile: ${options.profileDir}`);
  console.log('Finish login/verification in Chrome, then rerun list/archive.');
}

function writeVideoIndex(outDir, videos, listing = null) {
  ensureDir(outDir);
  ensureDir(join(outDir, 'logs'));
  writeFileSync(join(outDir, 'creator-videos.json'), `${JSON.stringify(videos, null, 2)}\n`);
  writeFileSync(join(outDir, 'creator-videos.jsonl'), `${videos.map((item) => JSON.stringify(item)).join('\n')}\n`);
  if (listing) writeFileSync(join(outDir, 'logs', 'list-report.json'), `${JSON.stringify(listing, null, 2)}\n`);
}

function readJsonlRows(inputPath) {
  return readFileSync(inputPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${inputPath}:${index + 1}: ${error.message}`);
      }
    });
}

function rowsToVideos(rows, { urlField = 'source_url', titleField = 'title' } = {}) {
  return rows.map((row, index) => {
    const url = row[urlField] || row.url || row.source_url;
    if (!url) throw new Error(`Input row ${index + 1} is missing URL field: ${urlField}`);
    return {
      ...row,
      id: parseDouyinVideoId(url) || row.platform_item_id || row.id || '',
      url,
      title: row[titleField] || row.title || '',
    };
  });
}

function logCollectionProgress(event = {}) {
  if (event.phase === 'metadata') {
    console.error(`metadata ${event.index}/${event.total}: ${event.ok ? 'ok' : 'failed'}`);
    return;
  }
  console.error(`list round=${event.round} found=${event.found}`);
}

async function commandList(args) {
  const creatorUrl = required(args['creator-url'], 'Missing --creator-url');
  const outDir = resolve(String(args.out || './douyin-archive'));
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const scrollRounds = Math.max(1, Math.min(Number(args['scroll-rounds'] || 80), 500));
  const minRedHearts = minimumRedHearts(args);
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  const snapshot = await collectCreatorSnapshot({
    creatorUrl,
    limit,
    scrollRounds,
    ...options,
    onProgress: logCollectionProgress,
  });
  const selected = applyRedHeartStandard(snapshot, minRedHearts);
  writeVideoIndex(outDir, selected.videos, selected.listing);
  console.log(JSON.stringify({ ok: true, count: selected.videos.length, listing: selected.listing, outDir }, null, 2));
}

async function commandArchive(args) {
  const creatorUrl = required(args['creator-url'], 'Missing --creator-url');
  const outDir = resolve(String(args.out || './douyin-archive'));
  const mode = String(args.mode || 'both');
  if (!['audio', 'video', 'both'].includes(mode)) throw new Error('--mode must be audio, video, or both');
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const delayMs = Math.max(0, Number(args['delay-ms'] || 2500));
  const minRedHearts = minimumRedHearts(args);
  const options = commonOptions(args);
  const snapshot = await collectCreatorSnapshot({
    creatorUrl,
    limit,
    scrollRounds: Math.max(1, Math.min(Number(args['scroll-rounds'] || 80), 500)),
    ...options,
    onProgress: logCollectionProgress,
  });
  const selected = applyRedHeartStandard(snapshot, minRedHearts);
  const report = await archiveVideoRows({
    videos: selected.videos,
    outDir,
    mode,
    delayMs,
    options,
    origin: { command: 'archive', creatorUrl, listing: selected.listing },
    downloadCovers: parseBool(args.covers, false),
    transcribe: parseBool(args.transcribe, false),
    whisperModelPath: String(args['whisper-model'] || process.env.DYCA_WHISPER_MODEL || ''),
    whisperCliPath: String(args['whisper-cli'] || '/opt/homebrew/bin/whisper-cli'),
    ytDlpPath: String(args['yt-dlp-path'] || process.env.DYCA_YT_DLP || 'yt-dlp'),
  });
  console.log(JSON.stringify({ ok: report.ok, total: report.total, succeeded: report.succeeded, failed: report.failed, outDir }, null, 2));
}

export function writeArchiveReport(outDir, report) {
  report.ok = report.failed === 0;
  writeFileSync(join(outDir, 'logs', 'archive-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function archiveVideoRows({
  videos,
  outDir,
  mode,
  delayMs,
  options,
  origin,
  downloadCovers = true,
  transcribe = false,
  whisperModelPath = '',
  whisperCliPath = '/opt/homebrew/bin/whisper-cli',
  ytDlpPath = 'yt-dlp',
}) {
  if (transcribe && mode === 'video') throw new Error('--transcribe requires --mode audio or --mode both');
  ensureDir(options.profileDir);
  ensureDir(outDir);
  ensureDir(join(outDir, 'logs'));
  if (downloadCovers) ensureDir(join(outDir, 'covers'));
  ensureDir(join(outDir, 'transcripts'));
  writeVideoIndex(outDir, videos, origin?.listing || null);
  const report = {
    ok: true,
    origin,
    mode,
    options: { covers: downloadCovers, transcribe },
    total: videos.length,
    succeeded: 0,
    failed: 0,
    items: [],
  };
  for (let index = 0; index < videos.length; index += 1) {
    const item = videos[index];
    const id = parseDouyinVideoId(item.url) || item.id || sanitizeSegment(item.url, `video_${index + 1}`);
    const label = sanitizeSegment(`${String(index + 1).padStart(4, '0')}_${id}`);
    const videoPath = join(outDir, 'videos', `${label}.mp4`);
    const audioPath = join(outDir, 'audio', `${label}.m4a`);
    const tempVideoPath = mode === 'audio' ? join(outDir, 'logs', `${label}.video.tmp`) : videoPath;
    const coverPath = join(outDir, 'covers', `${label}.jpg`);
    const result = {
      ...item,
      ok: false,
      videoPath: mode === 'audio' ? null : videoPath,
      audioPath: mode === 'video' ? null : audioPath,
      coverPath: null,
      transcriptPath: null,
    };
    let mediaOk = false;
    let coverOk = !downloadCovers;
    let transcriptOk = !transcribe;
    try {
      console.error(`archive-url ${index + 1}/${videos.length}: ${item.title || item.url}`);
      if (mode === 'audio') {
        try {
          let audio;
          if (item.audio_url) {
            try {
              audio = await downloadMusicPlayUrl(item.audio_url, audioPath, {
                expectedDurationSeconds: Number(item.duration_ms) > 0
                  ? Number(item.duration_ms) / 1000
                  : item.music_duration_seconds,
              });
              result.mediaSource = 'music.play_url';
              result.sourceAudioBytes = audio.sourceBytes;
              result.audioProbe = audio.probe;
            } catch (musicPlayUrlError) {
              result.musicPlayUrlError = musicPlayUrlError.message;
              audio = await downloadAudioWithYtDlp(item.url, audioPath, {
                profileDir: options.profileDir,
                ytDlpPath,
                expectedDurationSeconds: Number(item.duration_ms) > 0
                  ? Number(item.duration_ms) / 1000
                  : item.music_duration_seconds,
              });
              result.mediaSource = 'yt-dlp-audio';
            }
          } else {
            audio = await downloadAudioWithYtDlp(item.url, audioPath, {
              profileDir: options.profileDir,
              ytDlpPath,
              expectedDurationSeconds: Number(item.duration_ms) > 0
                ? Number(item.duration_ms) / 1000
                : item.music_duration_seconds,
            });
            result.mediaSource = 'yt-dlp-audio';
          }
          mediaOk = true;
          result.audioBytes = audio.bytes;
          if (audio.probe) result.audioProbe = audio.probe;
        } catch (audioOnlyError) {
          result.audioOnlyError = audioOnlyError.message;
          throw audioOnlyError;
        }
      } else {
        const resolved = item.download_url
          ? {
            mediaUrl: item.download_url,
            headers: { referer: 'https://www.douyin.com/' },
            source: 'structured-download',
          }
          : await resolveVideoMedia({ videoUrl: item.url, ...options });
        const downloaded = await curlDownload(resolved.mediaUrl, tempVideoPath, { headers: resolved.headers });
        const audio = mode === 'both' ? await extractAudio(tempVideoPath, audioPath) : null;
        mediaOk = true;
        result.mediaSource = resolved.source;
        result.downloadedBytes = downloaded.bytes;
        result.audioBytes = audio?.bytes || null;
      }
    } catch (error) {
      result.mediaError = error.message;
    }
    if (downloadCovers) {
      if (!item.cover_url) {
        result.coverError = 'cover_url_missing';
      } else {
        try {
          const cover = await curlDownload(item.cover_url, coverPath, { headers: { referer: 'https://www.douyin.com/' } });
          coverOk = true;
          result.coverPath = coverPath;
          result.coverBytes = cover.bytes;
        } catch (error) {
          result.coverError = error.message;
        }
      }
    }
    if (transcribe) {
      if (!mediaOk || !existsSync(audioPath)) {
        result.transcriptError = 'audio_not_ready';
      } else {
        try {
          const transcript = await transcribeAudio(audioPath, join(outDir, 'transcripts'), label, {
            whisperCliPath,
            whisperModelPath,
          });
          transcriptOk = true;
          result.transcriptPath = transcript.transcriptPath;
          result.transcriptSegmentsPath = transcript.segmentsPath;
          result.transcriptChars = transcript.chars;
        } catch (error) {
          result.transcriptError = error.message;
        }
      }
    }
    result.ok = mediaOk && coverOk && transcriptOk;
    if (result.ok) report.succeeded += 1;
    else report.failed += 1;
    report.items.push(result);
    writeArchiveReport(outDir, report);
    if (index < videos.length - 1) await sleep(delayMs);
  }
  return writeArchiveReport(outDir, report);
}

async function commandArchiveUrls(args) {
  const inputPath = resolve(required(args.input, 'Missing --input'));
  const outDir = resolve(String(args.out || './douyin-archive-urls'));
  const mode = String(args.mode || 'audio');
  if (!['audio', 'video', 'both'].includes(mode)) throw new Error('--mode must be audio, video, or both');
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const delayMs = Math.max(0, Number(args['delay-ms'] || 2500));
  const minRedHearts = minimumRedHearts(args);
  const options = commonOptions(args);
  const rows = readJsonlRows(inputPath);
  const candidates = rowsToVideos(rows, {
    urlField: String(args['url-field'] || 'source_url'),
    titleField: String(args['title-field'] || 'title'),
  });
  const filtered = filterByMinimumRedHearts(candidates, minRedHearts);
  const videos = filtered.videos.slice(0, limit);
  const report = await archiveVideoRows({
    videos,
    outDir,
    mode,
    delayMs,
    options,
    origin: { command: 'archive-urls', inputPath, red_heart_standard: { ...filtered.standard, selected_count: videos.length } },
    downloadCovers: parseBool(args.covers, false),
    transcribe: parseBool(args.transcribe, false),
    whisperModelPath: String(args['whisper-model'] || process.env.DYCA_WHISPER_MODEL || ''),
    whisperCliPath: String(args['whisper-cli'] || '/opt/homebrew/bin/whisper-cli'),
    ytDlpPath: String(args['yt-dlp-path'] || process.env.DYCA_YT_DLP || 'yt-dlp'),
  });
  console.log(JSON.stringify({ ok: report.ok, total: report.total, succeeded: report.succeeded, failed: report.failed, outDir }, null, 2));
}

function parseKeywords(args) {
  const keywords = [];
  if (args['keywords-file']) {
    keywords.push(...readFileSync(resolve(String(args['keywords-file'])), 'utf8').split(/\r?\n/));
  }
  if (args.keywords) keywords.push(...String(args.keywords).split(/[，,\n]/));
  return [...new Set(keywords.map((value) => String(value || '').trim()).filter((value) => value && !value.startsWith('#')))];
}

function positiveInteger(value, fallback, name, maximum = 10000) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

function logKeywordProgress(event = {}) {
  if (event.phase === 'keyword_start') {
    console.error(`keyword ${event.keyword_index}/${event.keyword_total}: ${event.keyword}`);
  } else if (event.phase === 'keyword_scan') {
    console.error(`scan ${event.keyword}: round=${event.round} scanned=${event.scanned} qualified=${event.qualified}`);
  } else if (event.phase === 'keyword_done') {
    console.error(`done ${event.keyword}: scanned=${event.scanned_count} qualified=${event.qualified_count} stop=${event.stop_reason}`);
  } else if (event.phase === 'keyword_retry') {
    console.error(`retry ${event.keyword}: attempt=${event.attempt}`);
  } else if (event.phase === 'keyword_resume') {
    console.error(`resume ${event.keyword}: seeded=${event.seeded}`);
  } else if (event.phase === 'qualified_start') {
    console.error(`ingest ${event.keyword}: ${event.item.id} start`);
  } else if (event.phase === 'qualified_done') {
    console.error(`ingest ${event.keyword}: ${event.item.id} applied; browser back verified`);
  }
}

async function runQualifiedHook(script, item, outDir, timeoutMs) {
  const itemId = parseDouyinVideoId(item.url) || item.id;
  const transactionDir = join(outDir, 'transactions', String(itemId));
  ensureDir(transactionDir);
  const itemPath = join(transactionDir, 'qualified-item.json');
  writeFileSync(itemPath, `${JSON.stringify(item, null, 2)}\n`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    script,
    '--item-json', itemPath,
    '--transaction-dir', transactionDir,
  ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const receipt = {
    ok: true,
    item_id: String(itemId),
    completed_at: new Date().toISOString(),
    stdout: String(stdout || '').trim(),
    stderr: String(stderr || '').trim(),
  };
  writeFileSync(join(transactionDir, 'hook-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function createQualifiedHookQueue({ script, outDir, timeoutMs, concurrency = 2, runHook = runQualifiedHook } = {}) {
  const limit = positiveInteger(concurrency, 2, '--hook-concurrency', 8);
  const waiting = [];
  const jobs = [];
  let active = 0;
  const pump = () => {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      active += 1;
      job.status = 'running';
      console.error(`worker ${job.item.id}: start`);
      runHook(script, job.item, outDir, timeoutMs)
        .then((receipt) => {
          job.status = 'complete';
          job.receipt = receipt;
          console.error(`worker ${job.item.id}: complete`);
          job.resolve(receipt);
        })
        .catch((error) => {
          job.status = 'failed';
          job.error = error.message;
          console.error(`worker ${job.item.id}: failed: ${error.message}`);
          job.reject(error);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return {
    enqueue(item, context = {}) {
      const enriched = {
        ...item,
        pipeline: {
          mode: 'streaming_parallel',
          backup_target_id: context.backup_target_id,
          backup_url: context.backup_url,
          cdp_port: context.port,
          queued_at: new Date().toISOString(),
        },
      };
      const job = { item: enriched, status: 'queued', receipt: null, error: null };
      job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
      job.promise.catch(() => {});
      jobs.push(job);
      waiting.push(job);
      pump();
      return {
        queued: true,
        item_id: String(item.id || ''),
        backup_target_id: context.backup_target_id,
        queue_position: waiting.length,
      };
    },
    async drain() {
      const settled = await Promise.allSettled(jobs.map((job) => job.promise));
      return {
        total: jobs.length,
        complete: settled.filter((item) => item.status === 'fulfilled').length,
        failed: settled.filter((item) => item.status === 'rejected').length,
        jobs: jobs.map(({ item, status, receipt, error }) => ({
          item_id: String(item.id || ''), status, error, receipt,
        })),
      };
    },
  };
}

function writeKeywordSearchResults(outDir, result, runStatus = 'complete') {
  ensureDir(outDir);
  ensureDir(join(outDir, 'logs'));
  writeFileSync(join(outDir, 'qualified-content.json'), `${JSON.stringify(result.qualified_items, null, 2)}\n`);
  writeFileSync(join(outDir, 'qualified-content.jsonl'), `${result.qualified_items.map((item) => JSON.stringify(item)).join('\n')}\n`);
  writeFileSync(join(outDir, 'logs', 'scanned-content.jsonl'), `${result.scanned_items.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const report = {
    run_status: runStatus,
    captured_at: result.captured_at,
    keywords: result.keywords,
    keyword_count: result.keywords.length,
    total_scanned_count: result.scanned_items.length,
    total_qualified_count: result.qualified_items.length,
    keyword_reports: result.keyword_reports,
  };
  writeFileSync(join(outDir, 'keyword-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function commandSearchKeywords(args) {
  const keywords = parseKeywords(args);
  if (!keywords.length) throw new Error('Provide --keywords-file FILE or --keywords "词1,词2"');
  const outDir = resolve(String(args.out || './douyin-keyword-search'));
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  const qualifiedHook = args['qualified-hook'] ? resolve(String(args['qualified-hook'])) : '';
  if (qualifiedHook && !existsSync(qualifiedHook)) throw new Error(`--qualified-hook was not found: ${qualifiedHook}`);
  const resumeItem = args['resume-item-json']
    ? JSON.parse(readFileSync(resolve(String(args['resume-item-json'])), 'utf8'))
    : null;
  const hookQueue = qualifiedHook ? createQualifiedHookQueue({
    script: qualifiedHook,
    outDir,
    timeoutMs: Math.max(60_000, Number(args['qualified-hook-timeout-ms'] || 30 * 60 * 1000)),
    concurrency: positiveInteger(args['hook-concurrency'], 2, '--hook-concurrency', 8),
  }) : null;
  const result = await collectKeywordSearchBatch({
    keywords,
    targetPerKeyword: positiveInteger(args['target-per-keyword'], 1, '--target-per-keyword', 100),
    maxScannedPerKeyword: positiveInteger(args['max-scanned-per-keyword'], 200, '--max-scanned-per-keyword', 5000),
    minRedHearts: minimumRedHearts(args),
    withinDays: positiveInteger(args['within-days'], 60, '--within-days', 3650),
    maxScrollRounds: positiveInteger(args['max-scroll-rounds'], 80, '--max-scroll-rounds', 500),
    scrollDelayMs: Math.max(500, Number(args['scroll-delay-ms'] || 2500)),
    responseWaitMs: Math.max(3000, Number(args['response-wait-ms'] || 15000)),
    ...options,
    onProgress: logKeywordProgress,
    onCheckpoint: (checkpoint) => writeKeywordSearchResults(outDir, checkpoint, 'in_progress'),
    onQualified: hookQueue
      ? (item, context) => hookQueue.enqueue(item, { ...context, port: options.port })
      : null,
    resumeCurrent: parseBool(args['resume-current'], false),
    seedQualifiedItems: resumeItem ? [resumeItem] : [],
  });
  const pipeline = hookQueue ? await hookQueue.drain() : { total: 0, complete: 0, failed: 0, jobs: [] };
  writeFileSync(join(outDir, 'pipeline-report.json'), `${JSON.stringify(pipeline, null, 2)}\n`);
  const report = writeKeywordSearchResults(outDir, result, pipeline.failed ? 'partial_failure' : 'complete');
  if (pipeline.failed) throw new Error(`Streaming pipeline completed with ${pipeline.failed} failed worker(s)`);
  console.log(JSON.stringify({ ok: true, outDir, ...report }, null, 2));
}

export async function main(argv = []) {
  const [command = 'help', ...rest] = argv;
  const args = parseArgs(rest);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'doctor') return commandDoctor(args);
  if (command === 'login') return commandLogin(args);
  if (command === 'search-keywords') return commandSearchKeywords(args);
  if (command === 'list') return commandList(args);
  if (command === 'archive') return commandArchive(args);
  if (command === 'archive-urls') return commandArchiveUrls(args);
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}
