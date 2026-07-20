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

export function buildYtDlpAudioArgs(videoUrl, audioPath, profileDir) {
  const outputTemplate = String(audioPath).replace(/\.m4a$/i, '.%(ext)s');
  return [
    '--cookies-from-browser', `chrome:${profileDir}`,
    '-f', 'bestaudio/best',
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

export async function downloadAudioWithYtDlp(videoUrl, audioPath, {
  profileDir,
  ytDlpPath = 'yt-dlp',
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  ensureDir(dirname(audioPath));
  rmSync(audioPath, { force: true });
  await execFileAsync(ytDlpPath, buildYtDlpAudioArgs(videoUrl, audioPath, profileDir), {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!existsSync(audioPath)) throw new Error('yt-dlp did not generate the expected m4a output.');
  return { ok: true, path: audioPath, bytes: statSync(audioPath).size };
}
