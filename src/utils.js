import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __filename = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(__filename), '..');
export const DEFAULT_APP_SUPPORT_DIR = resolve(homedir(), 'Library/Application Support/Douyin Creator Archiver');
export const DEFAULT_PROFILE_DIR = resolve(DEFAULT_APP_SUPPORT_DIR, 'chrome-profile');
export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_CDP_PORT = 9533;

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function fileExists(path) {
  return Boolean(path) && existsSync(path);
}

export function sanitizeSegment(value, fallback = 'item') {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || fallback;
}

export function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

export function parseArgs(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

export function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

