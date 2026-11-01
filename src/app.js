// HTTP layer: auth, static UI, chat stream, approvals, voice, reminders, screenshots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, DATA_DIR, publicConfig, saveConfig, lanAddresses } from './config.js';
import { listTools, configureTools } from './tools.js';
import { resolveApproval, makeBrain } from './brain.js';
import { history, reminders } from './store.js';
import { speak, voiceStatus } from './tts.js';
import { ensureOllama, pullModel, runtimeState } from './runtime.js';
import { autostartEnabled, setAutostart } from './autostart.js';
import { PROVIDERS, publicCloud, resolveCloud } from './cloud.js';
import { lookAtImage, setVisionCloud, visionStatus } from './vision.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function readJson(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function sendFile(res, file, { cache = 'no-cache' } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

export function makeServer({ cfg, llm, cloud, onQuit }) {
  configureTools(cfg);
  setVisionCloud(cloud);
  const brain = makeBrain({ cfg, llm });

  let busy = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const token = cfg.token;
    const cookies = parseCookies(req);
    const provided = cookies.friday_token || url.searchParams.get('t') || req.headers['x-friday-token'];

    // ---- public assets (needed for the login page too) ----
    if (pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname === '/icon.svg' || pathname === '/style.css') {
      return sendFile(res, path.join(PUBLIC_DIR, pathname.slice(1)));
    }

    // ---- login / token ----
    if (pathname === '/login' || pathname === '/') {
      if (provided && provided === token) {
        if (pathname === '/login') {
          res.writeHead(302, { 'Set-Cookie': `friday_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax`, Location: '/' });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `friday_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax`
        });
        return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(loginPage(provided && provided !== token ? 'That access link is not valid.' : ''));
    }

    // ---- everything else needs the token ----
    if (provided !== token) {
      if (pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(''));
    }

    try {
      if (pathname === '/api/state' && req.method === 'GET') {
        const health = await llm.health();
        return json(res, 200, {
          config: publicConfig(cfg),
          voice: voiceStatus(),
          brain: { ...health, ...runtimeState() },
          cloud: { ...publicCloud(cfg.cloud), providers: PROVIDERS },
          vision: await visionStatus({ cfg, cloud }),
          tools: listTools(),
          history: history.all().slice(-40),
          reminders: reminders.pending(),
          platform: process.platform,
          host: os.hostname(),
          autostart: autostartEnabled()
        });
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, await llm.health());
      }

      if (pathname === '/api/brain/state' && req.method === 'GET') {
        const health = await llm.health();
        return json(res, 200, { ...health, ...runtimeState() });
      }

      if (pathname === '/api/brain/start' && req.method === 'POST') {
        const result = await ensureOllama(cfg);
        const health = await llm.health();
        return json(res, 200, { ...result, ...health, ...runtimeState() });
      }

      if (pathname === '/api/brain/pull' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const start = await ensureOllama(cfg);
        if (!start.ok) return json(res, 200, { started: false, reason: start.reason, ...(await llm.health()) });
        const result = pullModel(cfg, String(body.model || cfg.model));
        return json(res, 200, result);
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        // a shared screen frame travels with the message, so the limit is generous
        const body = await readJson(req, 12 * 1024 * 1024);
        const text = String(body.text || '').slice(0, 4000);
        const image = typeof body.image === 'string' ? body.image : '';
        if (!text.trim() && !image) return json(res, 400, { error: 'empty message' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        let closed = false;
        req.on('close', () => {
          closed = true;
        });
        const send = (event, data) => {
          if (closed) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          if (image) {
            // she is being shown the screen: answer about the picture, no tool guessing
            const hi = /[\u0900-\u097F]/.test(text);
            const question = text.trim() || (hi ? 'मेरी स्क्रीन पर क्या है? कोई दिक्कत दिख रही है?' : 'What is on my screen? Is anything wrong?');
            send('status', { text: 'looking at your screen' });
            const out = await lookAtImage({ image, question, cfg });
            const label = out.engine === 'cloud' ? cfg.cloud.model : out.model || 'vision model';
            send('tool', {
              name: 'look_at_screen',
              ok: out.ok,
              args: { question },
              summary: out.ok ? `Saw the screen with ${label} in ${Math.round(out.ms / 1000)}s` : out.hint || 'could not see',
              media: null
            });
            const answer = out.ok ? out.text : out.hint || 'I could not see your screen.';
            history.append('user', text.trim() || (hi ? '[screen shared]' : '[screen shared]'));
            history.append('assistant', answer);
            send('answer', { text: answer, lang: /[\u0900-\u097F]/.test(answer) ? 'hi' : 'en', media: null });
          } else {
            await brain.runTurn({ text, onEvent: send });
          }
        } catch (err) {
          send('error', { message: err.message, setup: /Brain offline|ECONNREFUSED|fetch failed/i.test(err.message) });
        }
        send('done', {});
        return res.end();
      }

      if (pathname === '/api/approve' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.always && body.tool && !cfg.autoApproveTools.includes(body.tool)) {
          cfg.autoApproveTools.push(body.tool);
          saveConfig(cfg);
        }
        const ok = resolveApproval(String(body.id), Boolean(body.allow));
        return json(res, ok ? 200 : 404, { ok });
      }

      if (pathname === '/api/voices' && req.method === 'GET') {
        try {
          const { listVoices } = await import('./tts.js');
          const voices = await listVoices();
          return json(res, 200, voices);
        } catch (err) {
          return json(res, 200, { piper: [], sapi: [], google: [{ id: 'google-hi', label: 'Google Hindi (female)', lang: 'hi' }, { id: 'google-en', label: 'Google English (Indian female)', lang: 'en' }] });
        }
      }

      if (pathname === '/api/tts' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text || '').slice(0, 2000);
        if (!text.trim()) return json(res, 400, { error: 'empty text' });
        try {
          const out = await speak(text, {
            lang: body.lang === 'hi' ? 'hi' : 'en',
            engine: body.engine || cfg.voice.engine || 'auto',
            rate: cfg.voice.rate || '+0%',
            voiceId: typeof body.voiceId === 'string' ? body.voiceId : cfg.voice.voiceId || ''
          });
          if (out.browser) return json(res, 200, { browser: true, text: out.text });
          res.writeHead(200, {
            'Content-Type': out.mime,
            'Content-Length': out.audio.length,
            'Cache-Control': 'no-store',
            'X-Voice-Engine': out.engine
          });
          return res.end(out.audio);
        } catch (err) {
          return json(res, 200, { browser: true, text, reason: err.message });
        }
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.userName === 'string' && body.userName.trim()) cfg.userName = body.userName.trim().slice(0, 40);
        if (typeof body.model === 'string' && body.model.trim()) cfg.model = body.model.trim();
        if (body.voice && typeof body.voice === 'object') {
          if (body.voice.engine) cfg.voice.engine = body.voice.engine;
          if (typeof body.voice.enabled === 'boolean') cfg.voice.enabled = body.voice.enabled;
          if (typeof body.voice.voiceId === 'string') cfg.voice.voiceId = body.voice.voiceId;
        }
        if (typeof body.allowAllPaths === 'boolean') cfg.allowAllPaths = body.allowAllPaths;
        if (Array.isArray(body.allowRoots)) {
          cfg.allowRoots = body.allowRoots.map((p) => String(p)).filter(Boolean).slice(0, 20);
        }
        if (Array.isArray(body.autoApproveTools)) cfg.autoApproveTools = body.autoApproveTools.map(String);

        if (body.cloud && typeof body.cloud === 'object') {
          const next = { ...cfg.cloud };
          if (typeof body.cloud.enabled === 'boolean') next.enabled = body.cloud.enabled;
          if (typeof body.cloud.provider === 'string' && PROVIDERS[body.cloud.provider]) next.provider = body.cloud.provider;
          if (typeof body.cloud.model === 'string') next.model = body.cloud.model.trim();
          if (typeof body.cloud.baseUrl === 'string') next.baseUrl = body.cloud.baseUrl.trim();
          // an empty key means "keep the saved one"; a literal null clears it
          if (body.cloud.apiKey === null) next.apiKey = '';
          else if (typeof body.cloud.apiKey === 'string' && body.cloud.apiKey.trim()) next.apiKey = body.cloud.apiKey.trim();
          cfg.cloud = next;
        }

        saveConfig(cfg);
        configureTools(cfg);
        if (cloud?.reload) cloud.reload(cfg.cloud);
        return json(res, 200, { ok: true, config: publicConfig(cfg), cloud: publicCloud(cfg.cloud) });
      }

      // current cloud-brain settings + live status (never includes the key)
      if (pathname === '/api/cloud' && req.method === 'GET') {
        const status = cloud ? await cloud.health() : { online: false, error: 'not initialised' };
        return json(res, 200, { ...publicCloud(cfg.cloud), models: status.models || [], online: Boolean(status.online), error: status.error || '' });
      }

      // "Connect" button: proves the key works before you rely on it
      if (pathname === '/api/cloud/test' && req.method === 'POST') {
        if (!cloud) return json(res, 500, { ok: false, error: 'cloud brain not available' });
        const body = await readJson(req).catch(() => ({}));
        const trial = resolveCloud({
          ...cfg.cloud,
          provider: body.provider || cfg.cloud.provider,
          model: body.model || cfg.cloud.model,
          baseUrl: body.baseUrl !== undefined ? body.baseUrl : cfg.cloud.baseUrl,
          apiKey: body.apiKey || cfg.cloud.apiKey
        });

        // test against the candidate settings without saving them
        const previous = cfg.cloud;
        cfg.cloud = { ...cfg.cloud, ...trial, enabled: true };
        cloud.reload(cfg.cloud);
        const started = Date.now();
        try {
          const models = await cloud.listModels();
          const answer = await cloud.chat(
            [
              { role: 'system', content: 'Reply with exactly: connected' },
              { role: 'user', content: 'ping' }
            ],
            { temperature: 0, numPredict: 12 }
          );
          return json(res, 200, {
            ok: true,
            ms: Date.now() - started,
            model: trial.model,
            provider: trial.provider,
            sample: answer.slice(0, 120),
            models: models.slice(0, 200)
          });
        } catch (err) {
          return json(res, 200, { ok: false, error: String(err.message || err).slice(0, 400) });
        } finally {
          cfg.cloud = previous;
          cloud.reload(cfg.cloud);
        }
      }

      if (pathname === '/api/autostart' && req.method === 'GET') {
        return json(res, 200, { enabled: autostartEnabled() });
      }

      if (pathname === '/api/autostart' && req.method === 'POST') {
        const body = await readJson(req);
        const out = setAutostart(Boolean(body.enabled));
        return json(res, out.ok ? 200 : 500, out);
      }

      // quit the whole app (server + window). The token is required, so only you can stop her.
      if (pathname === '/api/quit' && req.method === 'POST') {
        json(res, 200, { ok: true, bye: true });
        setTimeout(() => {
          if (typeof onQuit === 'function') onQuit();
          process.exit(0);
        }, 250);
        return undefined;
      }

      if (pathname === '/api/history' && req.method === 'GET') {
        return json(res, 200, { history: history.all().slice(-100) });
      }

      if (pathname === '/api/history' && req.method === 'DELETE') {
        history.clear();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/reminders' && req.method === 'GET') {
        return json(res, 200, { reminders: reminders.pending() });
      }

      if (pathname === '/api/reminders/due' && req.method === 'GET') {
        const due = reminders.due();
        due.forEach((r) => reminders.markNotified(r.id));
        return json(res, 200, { due });
      }

      if (pathname.startsWith('/media/')) {
        const name = path.basename(pathname.slice('/media/'.length));
        return sendFile(res, path.join(MEDIA_DIR, name), { cache: 'max-age=86400' });
      }

      // static UI
      const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      return sendFile(res, file);
    } catch (err) {
      console.error('[friday] request failed:', err);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    }
  });

  // wake up the model on start so the first reply is instant (best effort)
  (async () => {
    try {
      const health = await llm.health();
      if (!health.online || !health.hasModel) return;
      await llm.chat([{ role: 'user', content: 'hi' }], { numPredict: 1 });
      console.log('[friday] brain warmed up');
    } catch {
      /* brain wakes on first use instead */
    }
  })();

  return { server, brain };
}

function loginPage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRIDAY · locked</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070d;color:#dfe7f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.card{max-width:420px;padding:32px;border-radius:20px;background:rgba(18,24,38,.9);border:1px solid rgba(90,160,255,.25);box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:26px;letter-spacing:.28em;font-weight:600}
p{color:#8fa3c4;line-height:1.5;font-size:14px}
form{display:flex;gap:8px;margin-top:18px}
input{flex:1;padding:12px;border-radius:12px;border:1px solid #2b3a55;background:#0b1220;color:#fff;font-size:14px}
button{padding:12px 18px;border-radius:12px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff8f8f;font-size:13px;margin-top:10px}
small{color:#5d6f8c;display:block;margin-top:14px;font-size:12px;line-height:1.5}
</style></head><body>
<div class="card">
  <h1>FRIDAY</h1>
  <p>This assistant is locked to one owner. Open the link printed in the FRIDAY terminal window on your PC, or paste your access token below.</p>
  ${message ? `<div class="err">${message}</div>` : ''}
  <form method="GET" action="/login">
    <input name="t" placeholder="Access token" autocomplete="off" autofocus>
    <button type="submit">Unlock</button>
  </form>
  <small>Your token lives in <code>friday.config.json</code> on the PC. It keeps strangers on your wifi out.</small>
</div>
</body></html>`;
}
