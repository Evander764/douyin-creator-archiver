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
import { collectCreatorSnapshot, parseDouyinVideoId, resolveVideoMedia } from './douyin.js';
import { curlDownload, extractAudio } from './download.js';
import { transcribeAudio } from './transcribe.js';

const execFileAsync = promisify(execFile);

function usage() {
  return `Douyin Creator Archiver

Usage:
  dyca doctor
  dyca login [--profile-dir PATH] [--port 9533]
  dyca list --creator-url URL [--out DIR] [--limit N]
  dyca archive --creator-url URL [--out DIR] [--limit N] [--mode audio|video|both] [--transcribe true --whisper-model PATH]
  dyca archive-urls --input ROWS.jsonl [--out DIR] [--limit N] [--mode audio|video|both] [--transcribe true --whisper-model PATH]
`;
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
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  const snapshot = await collectCreatorSnapshot({
    creatorUrl,
    limit,
    scrollRounds,
    ...options,
    onProgress: logCollectionProgress,
  });
  writeVideoIndex(outDir, snapshot.videos, snapshot.listing);
  console.log(JSON.stringify({ ok: true, count: snapshot.videos.length, listing: snapshot.listing, outDir }, null, 2));
}

async function commandArchive(args) {
  const creatorUrl = required(args['creator-url'], 'Missing --creator-url');
  const outDir = resolve(String(args.out || './douyin-archive'));
  const mode = String(args.mode || 'both');
  if (!['audio', 'video', 'both'].includes(mode)) throw new Error('--mode must be audio, video, or both');
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const delayMs = Math.max(0, Number(args['delay-ms'] || 2500));
  const options = commonOptions(args);
  const snapshot = await collectCreatorSnapshot({
    creatorUrl,
    limit,
    scrollRounds: Math.max(1, Math.min(Number(args['scroll-rounds'] || 80), 500)),
    ...options,
    onProgress: logCollectionProgress,
  });
  const report = await archiveVideoRows({
    videos: snapshot.videos,
    outDir,
    mode,
    delayMs,
    options,
    origin: { command: 'archive', creatorUrl, listing: snapshot.listing },
    downloadCovers: parseBool(args.covers, true),
    transcribe: parseBool(args.transcribe, false),
    whisperModelPath: String(args['whisper-model'] || process.env.DYCA_WHISPER_MODEL || ''),
    whisperCliPath: String(args['whisper-cli'] || '/opt/homebrew/bin/whisper-cli'),
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
}) {
  if (transcribe && mode === 'video') throw new Error('--transcribe requires --mode audio or --mode both');
  ensureDir(options.profileDir);
  ensureDir(outDir);
  ensureDir(join(outDir, 'logs'));
  ensureDir(join(outDir, 'covers'));
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
      const resolved = item.download_url
        ? {
          mediaUrl: item.download_url,
          headers: { referer: 'https://www.douyin.com/' },
          source: 'structured-download',
        }
        : await resolveVideoMedia({ videoUrl: item.url, ...options });
      const downloaded = await curlDownload(resolved.mediaUrl, tempVideoPath, { headers: resolved.headers });
      let audio = null;
      if (mode === 'audio' || mode === 'both') audio = await extractAudio(tempVideoPath, audioPath);
      if (mode === 'audio') rmSync(tempVideoPath, { force: true });
      mediaOk = true;
      result.mediaSource = resolved.source;
      result.downloadedBytes = downloaded.bytes;
      result.audioBytes = audio?.bytes || null;
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
  const options = commonOptions(args);
  const rows = readJsonlRows(inputPath);
  const videos = rowsToVideos(rows, {
    urlField: String(args['url-field'] || 'source_url'),
    titleField: String(args['title-field'] || 'title'),
  }).slice(0, limit);
  const report = await archiveVideoRows({
    videos,
    outDir,
    mode,
    delayMs,
    options,
    origin: { command: 'archive-urls', inputPath },
    downloadCovers: parseBool(args.covers, true),
    transcribe: parseBool(args.transcribe, false),
    whisperModelPath: String(args['whisper-model'] || process.env.DYCA_WHISPER_MODEL || ''),
    whisperCliPath: String(args['whisper-cli'] || '/opt/homebrew/bin/whisper-cli'),
  });
  console.log(JSON.stringify({ ok: report.ok, total: report.total, succeeded: report.succeeded, failed: report.failed, outDir }, null, 2));
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
  if (command === 'list') return commandList(args);
  if (command === 'archive') return commandArchive(args);
  if (command === 'archive-urls') return commandArchiveUrls(args);
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}
