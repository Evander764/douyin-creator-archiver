import { execFile } from 'node:child_process';
import { DEFAULT_CDP_PORT, DEFAULT_CHROME_PATH, sleep } from './utils.js';

const DEFAULT_WINDOW_BOUNDS = { left: 80, top: 80, width: 1280, height: 900 };

export async function cdpReady(port = DEFAULT_CDP_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchChrome({
  chromePath = DEFAULT_CHROME_PATH,
  profileDir,
  port = DEFAULT_CDP_PORT,
  url = 'https://www.douyin.com/',
  visible = true,
} = {}) {
  if (await cdpReady(port)) return { port, child: null, closeOnDone: false };
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--profile-directory=Default',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (visible) {
    args.push(
      `--window-position=${DEFAULT_WINDOW_BOUNDS.left},${DEFAULT_WINDOW_BOUNDS.top}`,
      `--window-size=${DEFAULT_WINDOW_BOUNDS.width},${DEFAULT_WINDOW_BOUNDS.height}`,
      '--new-window',
    );
  }
  args.push(url);
  const child = execFile(chromePath, args, { detached: false });
  for (let i = 0; i < 60; i += 1) {
    if (await cdpReady(port)) return { port, child, closeOnDone: true };
    await sleep(250);
  }
  try { child.kill('SIGTERM'); } catch {}
  throw new Error('Chrome CDP startup timed out');
}

async function sendBrowserCommand(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome Browser CDP timeout: ${method}`)), 10000);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Chrome Browser WebSocket error'));
    };
  });
}

async function createWindowTarget(port, url) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then((res) => res.json());
  if (!version.webSocketDebuggerUrl) throw new Error('Chrome Browser WebSocket URL is unavailable');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome Browser WebSocket connect timeout')), 10000);
    ws.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Chrome Browser WebSocket error'));
    };
  });
  try {
    const created = await sendBrowserCommand(ws, 'Target.createTarget', {
      url,
      newWindow: true,
      background: false,
      ...DEFAULT_WINDOW_BOUNDS,
    });
    const targetId = created?.targetId;
    for (let i = 0; i < 40; i += 1) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((res) => res.json());
      const target = targets.find((item) => item.id === targetId && item.webSocketDebuggerUrl);
      if (target) return target;
      await sleep(150);
    }
    throw new Error('Created Chrome target was not found');
  } finally {
    try { ws.close(); } catch {}
  }
}

export async function closeChromeTarget(port, targetId) {
  if (!port || !targetId) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export class CDPClient {
  constructor({ commandTimeoutMs = 30000 } = {}) {
    this.ws = null;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.msgId = 1;
    this.port = null;
    this.targetId = null;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  async connect(port, { initialUrl = 'about:blank' } = {}) {
    this.port = port;
    const target = await createWindowTarget(port, initialUrl);
    this.targetId = target.id;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome target WebSocket connect timeout')), 10000);
      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Chrome target WebSocket error'));
      };
      this.ws.onmessage = (event) => this.handleMessage(event);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && this.eventHandlers.has(message.method)) {
      for (const handler of this.eventHandlers.get(message.method)) {
        try { handler(message.params || {}, message); } catch {}
      }
    }
  }

  send(method, params = {}, { timeoutMs = this.commandTimeoutMs } = {}) {
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP command timed out: ${method}`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
  }

  async goto(url, waitMs = 2500) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Page script failed');
    return result.result?.value;
  }

  async close() {
    try { this.ws?.close(); } catch {}
    return closeChromeTarget(this.port, this.targetId);
  }
}

