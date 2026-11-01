// Keeps the local brain (Ollama) alive without the user managing it:
// starts the local server if the portable build is present, and can download the model.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';

const OLLAMA_DIR = path.join(ROOT, 'tools', 'ollama');
const OLLAMA_EXE = path.join(OLLAMA_DIR, 'ollama.exe');
const MODELS_DIR = path.join(DATA_DIR, 'models');

const state = {
  starting: false,
  startedByUs: false,
  process: null,
  pull: null // { model, percent, status, done, error }
};

export function ollamaBinary() {
  return fs.existsSync(OLLAMA_EXE) ? OLLAMA_EXE : null;
}

export function runtimeState() {
  return {
    portable: Boolean(ollamaBinary()),
    starting: state.starting,
    pull: state.pull
  };
}

async function probe(url, timeout = 5000) {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the bundled Ollama server if it is installed but not answering. */
export async function ensureOllama(cfg) {
  const url = (cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  if (await probe(url)) return { ok: true, started: false };

  const exe = ollamaBinary();
  if (!exe) return { ok: false, reason: 'Ollama is not installed' };
  if (state.starting) return { ok: false, reason: 'starting' };

  state.starting = true;
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  try {
    const child = spawn(exe, ['serve'], {
      cwd: OLLAMA_DIR,
      detached: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OLLAMA_MODELS: MODELS_DIR,
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_KEEP_ALIVE: cfg.keepAlive || '30m',
        OLLAMA_NUM_PARALLEL: '1',
        // Smaller KV cache = more layers on the GPU. On a 4GB card this is the
        // difference between 8 and 20 tokens/second on the 7B.
        OLLAMA_FLASH_ATTENTION: '1',
        OLLAMA_KV_CACHE_TYPE: 'q8_0'
      }
    });
    state.process = child;
    state.startedByUs = true;
    child.on('exit', () => {
      state.process = null;
      state.startedByUs = false;
    });

    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probe(url, 2500)) {
        state.starting = false;
        return { ok: true, started: true };
      }
    }
    state.starting = false;
    return { ok: false, reason: 'Ollama did not start in time' };
  } catch (err) {
    state.starting = false;
    return { ok: false, reason: err.message };
  } finally {
    state.starting = false;
  }
}

/** Download the model in the background, tracking progress for the UI. */
export function pullModel(cfg, model = cfg.model) {
  if (state.pull && !state.pull.done && !state.pull.error) {
    return { started: false, reason: 'already downloading', pull: state.pull };
  }
  const exe = ollamaBinary();
  if (!exe) return { started: false, reason: 'Ollama is not installed' };

  state.pull = { model, percent: 0, status: 'starting', done: false, error: null };

  const child = spawn(exe, ['pull', model], {
    cwd: OLLAMA_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OLLAMA_MODELS: MODELS_DIR, OLLAMA_HOST: '127.0.0.1:11434' }
  });

  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/[\r\n]+/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      // progress lines look like: "pulling 8934a1  45% ▕███   ▏ 1.2 GB/2.0 GB  12 MB/s"
      const pct = text.match(/(\d{1,3})%/);
      if (pct) state.pull.percent = Math.min(99, Number(pct[1]));
      const clean = text.replace(/[▕▏█▁▂▃▄▅▆▇]/g, '').replace(/\s+/g, ' ').trim();
      if (clean) state.pull.status = clean.slice(0, 120);
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    state.pull.error = err.message;
    state.pull.done = true;
  });

  child.on('close', (code) => {
    if (code === 0) {
      state.pull.percent = 100;
      state.pull.status = 'ready';
      state.pull.done = true;
    } else if (!state.pull.error) {
      state.pull.error = `download failed (exit ${code})`;
      state.pull.done = true;
    }
  });

  return { started: true, pull: state.pull };
}

export function stopOllama() {
  if (state.process) {
    try {
      state.process.kill();
    } catch {}
    state.process = null;
  }
}
