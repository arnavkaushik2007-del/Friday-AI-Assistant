// Tiny JSON store: conversation history, long term memory, reminders.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const files = {
  history: path.join(DATA_DIR, 'history.json'),
  memory: path.join(DATA_DIR, 'memory.json'),
  reminders: path.join(DATA_DIR, 'reminders.json')
};

function read(name, fallback) {
  try {
    const raw = fs.readFileSync(files[name], 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(files[name], JSON.stringify(value, null, 2), 'utf8');
}

export const history = {
  all() {
    return read('history', []);
  },
  append(role, content, meta = {}) {
    const list = read('history', []);
    list.push({ role, content, ts: Date.now(), ...meta });
    // keep the last 400 messages on disk
    const trimmed = list.slice(-400);
    write('history', trimmed);
    return trimmed;
  },
  clear() {
    write('history', []);
  },
  // last N turns, formatted for the model
  recent(n = 12) {
    const list = read('history', []).filter((m) => m.role === 'user' || m.role === 'assistant');
    return list.slice(-n).map((m) => ({ role: m.role, content: m.content }));
  }
};

export const memory = {
  all() {
    return read('memory', []);
  },
  add(text, tag = 'note') {
    const list = read('memory', []);
    const entry = { id: list.length + 1, text, tag, ts: Date.now() };
    list.push(entry);
    write('memory', list.slice(-500));
    return entry;
  },
  search(query) {
    const q = String(query || '').toLowerCase().trim();
    const list = read('memory', []);
    if (!q) return list.slice(-20);
    return list.filter((m) => m.text.toLowerCase().includes(q)).slice(-20);
  }
};

export const reminders = {
  all() {
    return read('reminders', []);
  },
  add(text, dueAt) {
    const list = read('reminders', []);
    const r = { id: Date.now().toString(36), text, dueAt, done: false, notified: false };
    list.push(r);
    write('reminders', list);
    return r;
  },
  due(now = Date.now()) {
    return read('reminders', []).filter((r) => !r.done && !r.notified && r.dueAt <= now);
  },
  markNotified(id) {
    const list = read('reminders', []);
    const r = list.find((x) => x.id === id);
    if (r) r.notified = true;
    write('reminders', list);
  },
  complete(id) {
    const list = read('reminders', []);
    const r = list.find((x) => x.id === id);
    if (r) r.done = true;
    write('reminders', list);
    return r;
  },
  pending() {
    return read('reminders', []).filter((r) => !r.done);
  }
};
