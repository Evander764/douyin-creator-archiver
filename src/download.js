import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { ensureDir, sleep } from './utils.js';

const execFileAsync = promisify(execFile);

export async function curlDownload(url, targetPath, { headers = {}, timeoutMs = 600000, attempts = 3 } = {}) {
  ensureDir(dirname(targetPath));
  const partialPath = `${targetPath}.partial`;
  const args = [
    '-L',
    '--fail',
    '--silent',
    '--show-error',
    '--compressed',
    '--connect-timeout', '25',
    '--speed-time', '90',
    '--speed-limit', '1024',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-C', '-',
    '-o', partialPath,
  ];
  for (const [key, value] of Object.entries(headers || {})) {
    if (!value || /^(cookie|authorization)$/i.test(key)) continue;
    args.push('-H', `${key}: ${value}`);
  }
  args.push(url);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await execFileAsync('/usr/bin/curl', args, { timeout: timeoutMs + 15000, encoding: 'utf8', maxBuffer: 512 * 1024 });
      rmSync(targetPath, { force: true });
      copyFileSync(partialPath, targetPath);
      rmSync(partialPath, { force: true });
      return { ok: true, path: targetPath, bytes: statSync(targetPath).size };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2500 * attempt);
    }
  }
  const bytes = existsSync(partialPath) ? statSync(partialPath).size : 0;
  throw new Error(`curl download failed${bytes ? ` after ${Math.round(bytes / 1024 / 1024)}MB` : ''}: ${lastError?.stderr || lastError?.message || lastError}`);
}

export async function extractAudio(videoPath, audioPath, { ffmpegPath = '/opt/homebrew/bin/ffmpeg' } = {}) {
  ensureDir(dirname(audioPath));
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-c:a', 'aac',
    '-b:a', '128k',
    audioPath,
  ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
  return { ok: true, path: audioPath, bytes: statSync(audioPath).size };
}

export function validateAudioOnlyProbe(value = {}) {
  const payload = typeof value === 'string' ? JSON.parse(value) : value;
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
  const videoStreams = streams.filter((stream) => stream?.codec_type === 'video');
  if (!audioStreams.length || videoStreams.length) {
    throw new Error(`audio_only_validation_failed: audio_streams=${audioStreams.length} video_streams=${videoStreams.length}`);
  }
  const durationSeconds = Number(payload?.format?.duration);
  return {
    audio_streams: audioStreams.length,
    video_streams: 0,
    duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
  };
}

export function validateAudioDuration(actualSeconds, expectedSeconds, toleranceSeconds = 3) {
  const actual = Number(actualSeconds);
  const expected = Number(expectedSeconds);
  const tolerance = Math.max(0, Number(toleranceSeconds) || 0);
  if (!Number.isFinite(expected) || expected <= 0) return { checked: false, difference_seconds: null };
  if (!Number.isFinite(actual) || actual <= 0) {
    throw new Error(`audio_duration_missing: expected=${expected.toFixed(3)}`);
  }
  const difference = Math.abs(actual - expected);
  if (difference > tolerance) {
    throw new Error(`audio_duration_mismatch: expected=${expected.toFixed(3)} actual=${actual.toFixed(3)} tolerance=${tolerance.toFixed(3)}`);
  }
  return { checked: true, difference_seconds: difference };
}

export async function downloadMusicPlayUrl(audioUrl, audioPath, {
  headers = { referer: 'https://www.douyin.com/' },
  ffmpegPath = '/opt/homebrew/bin/ffmpeg',
  ffprobePath = '/opt/homebrew/bin/ffprobe',
  expectedDurationSeconds = null,
  durationToleranceSeconds = 3,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  if (!/^https?:\/\//i.test(String(audioUrl || ''))) throw new Error('music.play_url is missing or invalid');
  ensureDir(dirname(audioPath));
  const sourcePath = `${audioPath}.music-source`;
  rmSync(audioPath, { force: true });
  rmSync(sourcePath, { force: true });
  rmSync(`${sourcePath}.partial`, { force: true });
  try {
    const downloaded = await curlDownload(audioUrl, sourcePath, { headers, timeoutMs });
    const inspected = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name:format=duration',
      '-of', 'json',
      sourcePath,
    ], { encoding: 'utf8', timeout: Math.min(timeoutMs, 60_000), maxBuffer: 1024 * 1024 });
    const probe = validateAudioOnlyProbe(inspected.stdout);
    probe.duration_validation = validateAudioDuration(
      probe.duration_seconds,
      expectedDurationSeconds,
      durationToleranceSeconds,
    );
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', sourcePath,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'aac',
      '-b:a', '128k',
      audioPath,
    ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    if (!existsSync(audioPath)) throw new Error('ffmpeg did not generate the expected m4a output from music.play_url.');
    return { ok: true, path: audioPath, bytes: statSync(audioPath).size, sourceBytes: downloaded.bytes, probe };
  } finally {
    rmSync(sourcePath, { force: true });
    rmSync(`${sourcePath}.partial`, { force: true });
  }
}

export function buildYtDlpAudioArgs(videoUrl, audioPath, profileDir, formatId) {
  const outputTemplate = String(audioPath).replace(/\.m4a$/i, '.%(ext)s');
  return [
    '--cookies-from-browser', `chrome:${profileDir}`,
    '-f', formatId,
    '-x',
    '--audio-format', 'm4a',
    '--no-write-thumbnail',
    '--no-write-info-json',
    '--no-playlist',
    '--no-update',
    '-o', outputTemplate,
    videoUrl,
  ];
}

export function selectAudioOnlyFormat(formats = []) {
  return [...formats]
    .filter((format) => format?.format_id && format.vcodec === 'none' && format.acodec && format.acodec !== 'none')
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0] || null;
}

export async function downloadAudioWithYtDlp(videoUrl, audioPath, {
  profileDir,
  ytDlpPath = 'yt-dlp',
  ffprobePath = '/opt/homebrew/bin/ffprobe',
  expectedDurationSeconds = null,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  ensureDir(dirname(audioPath));
  rmSync(audioPath, { force: true });
  const commonArgs = [
    '--cookies-from-browser', `chrome:${profileDir}`,
    '--no-playlist',
    '--no-update',
  ];
  const inspected = await execFileAsync(ytDlpPath, [
    ...commonArgs,
    '--dump-single-json',
    '--skip-download',
    videoUrl,
  ], {
    encoding: 'utf8',
    timeout: Math.min(timeoutMs, 2 * 60 * 1000),
    maxBuffer: 32 * 1024 * 1024,
  });
  const metadata = JSON.parse(inspected.stdout);
  const expectedId = String(videoUrl || '').match(/\/video\/(\d{6,})/)?.[1] || '';
  if (expectedId && metadata.id && expectedId !== String(metadata.id)) {
    throw new Error(`audio_target_mismatch: expected=${expectedId} actual=${metadata.id}`);
  }
  validateAudioDuration(metadata.duration, expectedDurationSeconds, 3);
  const audioOnly = selectAudioOnlyFormat(metadata.formats || []);
  if (!audioOnly) throw new Error('audio_only_unavailable: Douyin did not expose a genuine audio-only format.');
  await execFileAsync(ytDlpPath, buildYtDlpAudioArgs(videoUrl, audioPath, profileDir, audioOnly.format_id), {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!existsSync(audioPath)) throw new Error('yt-dlp did not generate the expected m4a output.');
  try {
    const outputProbe = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name:format=duration',
      '-of', 'json',
      audioPath,
    ], { encoding: 'utf8', timeout: Math.min(timeoutMs, 60_000), maxBuffer: 1024 * 1024 });
    const probe = validateAudioOnlyProbe(outputProbe.stdout);
    probe.duration_validation = validateAudioDuration(probe.duration_seconds, expectedDurationSeconds, 3);
    return { ok: true, path: audioPath, bytes: statSync(audioPath).size, probe };
  } catch (error) {
    rmSync(audioPath, { force: true });
    throw error;
  }
}
