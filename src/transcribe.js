import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ensureDir } from './utils.js';

const execFileAsync = promisify(execFile);

function parseWhisperJson(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const source = Array.isArray(raw.transcription)
    ? raw.transcription
    : Array.isArray(raw.segments)
      ? raw.segments
      : [];
  const segments = source.map((segment, index) => ({
    index,
    from: segment.timestamps?.from ?? segment.start ?? segment.from ?? null,
    to: segment.timestamps?.to ?? segment.end ?? segment.to ?? null,
    text: String(segment.text || '').trim(),
  })).filter((segment) => segment.text);
  return {
    text: segments.map((segment) => segment.text).join('\n').trim(),
    segments,
    language: raw.result?.language || raw.language || null,
  };
}

export async function transcribeAudio(audioPath, transcriptDir, label, {
  ffmpegPath = '/opt/homebrew/bin/ffmpeg',
  whisperCliPath = '/opt/homebrew/bin/whisper-cli',
  whisperModelPath = process.env.DYCA_WHISPER_MODEL || '',
  language = 'zh',
} = {}) {
  if (!existsSync(audioPath)) throw new Error(`Audio file does not exist: ${audioPath}`);
  if (!existsSync(whisperCliPath)) throw new Error(`whisper-cli does not exist: ${whisperCliPath}`);
  if (!whisperModelPath || !existsSync(whisperModelPath)) {
    throw new Error('Whisper model is missing. Pass --whisper-model PATH or set DYCA_WHISPER_MODEL.');
  }
  ensureDir(transcriptDir);
  const wavPath = join(transcriptDir, `${label}.transcribe.tmp.wav`);
  const whisperBase = join(transcriptDir, `${label}.whisper.tmp`);
  const whisperJsonPath = `${whisperBase}.json`;
  const transcriptPath = join(transcriptDir, `${label}.txt`);
  const segmentsPath = join(transcriptDir, `${label}.segments.json`);
  try {
    await execFileAsync(ffmpegPath, [
      '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
    ], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
    await execFileAsync(whisperCliPath, [
      '-m', whisperModelPath, '-f', wavPath, '-l', language, '-oj', '-of', whisperBase, '-np',
    ], { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (!existsSync(whisperJsonPath)) throw new Error('Whisper did not generate JSON output.');
    const parsed = parseWhisperJson(whisperJsonPath);
    if (!parsed.text) throw new Error('Whisper transcript was empty.');
    writeFileSync(transcriptPath, `${parsed.text}\n`);
    writeFileSync(segmentsPath, `${JSON.stringify(parsed.segments, null, 2)}\n`);
    return { ok: true, transcriptPath, segmentsPath, language: parsed.language, chars: parsed.text.length };
  } finally {
    rmSync(wavPath, { force: true });
    rmSync(whisperJsonPath, { force: true });
  }
}
