import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
import { collectCreatorVideos, parseDouyinVideoId, resolveVideoMedia } from './douyin.js';
import { curlDownload, extractAudio } from './download.js';

const execFileAsync = promisify(execFile);

function usage() {
  return `Douyin Creator Archiver

Usage:
  dyca doctor
  dyca login [--profile-dir PATH] [--port 9533]
  dyca list --creator-url URL [--out DIR] [--limit N]
  dyca archive --creator-url URL [--out DIR] [--limit N] [--mode audio|video|both]
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
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function commandLogin(args) {
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  await launchChrome({ ...options, url: 'https://www.douyin.com/', visible: true });
  console.log(`Opened Douyin login window with profile: ${options.profileDir}`);
  console.log('Finish login/verification in Chrome, then rerun list/archive.');
}

function writeVideoIndex(outDir, videos) {
  ensureDir(outDir);
  writeFileSync(join(outDir, 'creator-videos.json'), `${JSON.stringify(videos, null, 2)}\n`);
  writeFileSync(join(outDir, 'creator-videos.jsonl'), `${videos.map((item) => JSON.stringify(item)).join('\n')}\n`);
}

async function commandList(args) {
  const creatorUrl = required(args['creator-url'], 'Missing --creator-url');
  const outDir = resolve(String(args.out || './douyin-archive'));
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const scrollRounds = Math.max(1, Math.min(Number(args['scroll-rounds'] || 80), 500));
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  const videos = await collectCreatorVideos({
    creatorUrl,
    limit,
    scrollRounds,
    ...options,
    onProgress: (event) => console.error(`list round=${event.round} found=${event.found}`),
  });
  writeVideoIndex(outDir, videos);
  console.log(JSON.stringify({ ok: true, count: videos.length, outDir }, null, 2));
}

async function commandArchive(args) {
  const creatorUrl = required(args['creator-url'], 'Missing --creator-url');
  const outDir = resolve(String(args.out || './douyin-archive'));
  const mode = String(args.mode || 'both');
  if (!['audio', 'video', 'both'].includes(mode)) throw new Error('--mode must be audio, video, or both');
  const limit = Math.max(1, Math.min(Number(args.limit || 100), 5000));
  const delayMs = Math.max(0, Number(args['delay-ms'] || 2500));
  const options = commonOptions(args);
  ensureDir(options.profileDir);
  ensureDir(outDir);
  ensureDir(join(outDir, 'logs'));
  const videos = await collectCreatorVideos({
    creatorUrl,
    limit,
    scrollRounds: Math.max(1, Math.min(Number(args['scroll-rounds'] || 80), 500)),
    ...options,
    onProgress: (event) => console.error(`list round=${event.round} found=${event.found}`),
  });
  writeVideoIndex(outDir, videos);
  const report = { ok: true, creatorUrl, mode, total: videos.length, succeeded: 0, failed: 0, items: [] };
  for (let index = 0; index < videos.length; index += 1) {
    const item = videos[index];
    const id = parseDouyinVideoId(item.url) || item.id || sanitizeSegment(item.url, `video_${index + 1}`);
    const label = sanitizeSegment(`${String(index + 1).padStart(4, '0')}_${id}`);
    const videoPath = join(outDir, 'videos', `${label}.mp4`);
    const audioPath = join(outDir, 'audio', `${label}.m4a`);
    const tempVideoPath = mode === 'audio' ? join(outDir, 'logs', `${label}.video.tmp`) : videoPath;
    try {
      console.error(`archive ${index + 1}/${videos.length}: ${item.title || item.url}`);
      const resolved = await resolveVideoMedia({ videoUrl: item.url, ...options });
      await curlDownload(resolved.mediaUrl, tempVideoPath, { headers: resolved.headers });
      if (mode === 'audio' || mode === 'both') await extractAudio(tempVideoPath, audioPath);
      if (mode === 'audio') rmSync(tempVideoPath, { force: true });
      report.succeeded += 1;
      report.items.push({ ...item, ok: true, videoPath: mode === 'audio' ? null : videoPath, audioPath: mode === 'video' ? null : audioPath, mediaSource: resolved.source });
    } catch (error) {
      report.failed += 1;
      report.items.push({ ...item, ok: false, error: error.message });
    }
    writeFileSync(join(outDir, 'logs', 'archive-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (index < videos.length - 1) await sleep(delayMs);
  }
  if (report.failed) report.ok = false;
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
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

