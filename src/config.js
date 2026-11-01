// FRIDAY config - a plain JSON file next to the app, no database needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_PATH = path.join(ROOT, 'friday.config.json');

const DEFAULTS = {
  // Network
  port: 4173,
  host: '0.0.0.0', // also listen on LAN so your iPhone can reach it
  token: '', // generated on first run - this is the key in your "phone link"

  // Brain (all local, all free)
  ollamaUrl: 'http://127.0.0.1:11434',
  // The 3B fits entirely in a 4GB GPU (~36 tok/s). The 7B overflows onto the CPU
  // and drops to ~8 tok/s, so it is only worth switching to on bigger cards.
  model: 'qwen2.5:3b-instruct',
  temperature: 0.35,
  numCtx: 4096,
  numPredict: 700,
  keepAlive: '2h',

  // Optional big brain: a free-tier OpenAI-compatible key makes her as knowledgeable as
  // ChatGPT. Off by default - with no key she runs entirely on the laptop.
  cloud: {
    enabled: false,
    provider: 'gemini',
    baseUrl: '',
    model: '',
    apiKey: ''
  },

  // What FRIDAY is allowed to touch
  allowRoots: [os.homedir()],
  allowAllPaths: false,

  // Tools that never ask for permission. Everything risky asks first.
  autoApproveTools: ['system_status', 'open_url', 'list_dir', 'read_file', 'search_files', 'screenshot', 'look_at_screen', 'media_control', 'clipboard', 'web_search', 'browse_web', 'remember', 'recall', 'set_reminder', 'list_reminders', 'get_time', 'notify', 'open_app'],

  // Voice
  voice: {
    enabled: true,
    engine: 'auto', // 'auto' picks the best free engine; see tts.js
    hiVoice: 'hi-IN-SwaraNeural',
    enVoice: 'en-IN-NeerjaNeural',
    rate: '+0%',
    pitch: '+0Hz'
  },

  // Who she is talking to
  userName: 'boss',
  wakePhrase: 'friday',
  language: 'auto' // 'auto' | 'hi' | 'en'
};

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let saved = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn('[friday] config file was invalid JSON, starting fresh:', err.message);
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...saved,
    voice: { ...DEFAULTS.voice, ...(saved.voice || {}) },
    cloud: { ...DEFAULTS.cloud, ...(saved.cloud || {}) },
    allowRoots: Array.isArray(saved.allowRoots) && saved.allowRoots.length ? saved.allowRoots : DEFAULTS.allowRoots,
    autoApproveTools: Array.isArray(saved.autoApproveTools) ? saved.autoApproveTools : DEFAULTS.autoApproveTools
  };
  let dirty = false;
  if (!cfg.token) {
    cfg.token = randomToken();
    dirty = true;
  }
  if (dirty || !fs.existsSync(CONFIG_PATH)) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

export function publicConfig(cfg) {
  // never leak the token or the cloud API key to the browser
  const { token, cloud, ...rest } = cfg;
  return { ...rest, cloud: { ...cloud, apiKey: '' } };
}

// IPv4 addresses other devices on the same wifi can use.
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}
