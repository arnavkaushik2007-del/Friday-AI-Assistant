// Checks the whole stack: config, tools, voice, brain. Run: npm run selftest
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { configureTools, listTools, getTool } from '../src/tools.js';
import { speak, voiceStatus } from '../src/tts.js';
import { makeLlm } from '../src/llm.js';
import { makeBrain } from '../src/brain.js';
import { routeQuery } from '../src/router.js';
import { findApp, findChrome } from '../src/apps.js';
import { PROVIDERS, publicCloud, resolveCloud } from '../src/cloud.js';
import { makeHybridLlm } from '../src/llm.js';

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${info ? `  \x1b[90m${info}\x1b[0m` : ''}`);
}

const cfg = loadConfig();
configureTools(cfg);

console.log('\n  F R I D A Y  ·  self test\n  ' + '─'.repeat(52));

// 1. config
check('config loads', Boolean(cfg.token), `port ${cfg.port}, model ${cfg.model}`);

// 2. ui assets
const ui = ['public/index.html', 'public/app.js', 'public/style.css', 'public/manifest.webmanifest', 'public/sw.js'];
const missing = ui.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('web UI present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '5 files');

// 2b. app mode: launcher + always-listening controls
const launcher = fs.existsSync(path.join(ROOT, 'scripts', 'app.ps1'));
check('app launcher present', launcher, launcher ? 'scripts/app.ps1' : 'missing');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const listens = /id="set-listen"/.test(html) && /id="set-autostart"/.test(html) && /id="quit-app"/.test(html);
check('listening + startup settings in UI', listens, listens ? 'listen mode, autostart, quit' : 'controls missing');

// 2c. desktop icon + shortcut
const icoPath = path.join(ROOT, 'assets', 'friday.ico');
let icoSizes = 0;
try {
  const ico = fs.readFileSync(icoPath);
  if (ico.readUInt16LE(2) === 1) icoSizes = ico.readUInt16LE(4);
} catch {
  /* not built yet */
}
check('FRIDAY icon built', icoSizes >= 5, icoSizes ? `${icoSizes} sizes` : 'run npm run shortcut');

const desktopDirs = [
  process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'),
  process.env.OneDriveConsumer && path.join(process.env.OneDriveConsumer, 'Desktop'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop')
].filter(Boolean);
const lnk = desktopDirs.map((d) => path.join(d, 'FRIDAY.lnk')).find((p) => fs.existsSync(p));
check('desktop icon present', Boolean(lnk), lnk || 'run npm run shortcut');

// 2d. opening things: sites go to Chrome, apps to the installed app
const chromeExe = findChrome();
check('chrome found for websites', Boolean(chromeExe), chromeExe || 'not installed');

const notepadLookup = await findApp('notepad');
check('finds apps installed on this PC', Boolean(notepadLookup), notepadLookup ? `${notepadLookup.name} [${notepadLookup.kind}]` : 'app lookup failed');

const gmailRoute = routeQuery('gmail kholo');
check(
  'routes "gmail kholo" to the browser',
  gmailRoute?.[0]?.name === 'open_url' && /mail\.google\.com/.test(gmailRoute[0].args.url || ''),
  gmailRoute ? JSON.stringify(gmailRoute[0].args) : 'no route'
);

const instaRoute = routeQuery('insta kholo');
check(
  'routes "insta kholo" to the desktop app',
  instaRoute?.[0]?.name === 'open_app' && instaRoute[0].args.name === 'instagram',
  instaRoute ? JSON.stringify(instaRoute[0].args) : 'no route'
);

const twoSites = routeQuery('open gmail aur youtube');
check('opens two sites in one go', twoSites?.length === 2, twoSites ? twoSites.map((s) => s.args.url).join(' + ') : 'no route');

// 2e. the optional big brain (free-tier key = ChatGPT-level knowledge)
const cloudUi = ['set-cloud-provider', 'set-cloud-key', 'set-cloud-model', 'btn-cloud-test', 'set-cloud-on'];
const cloudMissing = cloudUi.filter((id) => !html.includes(`id="${id}"`));
check('big-brain settings in UI', cloudMissing.length === 0, cloudMissing.length ? `missing ${cloudMissing.join(', ')}` : 'provider, key, model, test');

check('big brain off until a key is given', !cfg.cloud?.enabled, cfg.cloud?.apiKey ? 'key saved, still switchable' : 'local model only');
const resolvedGemini = resolveCloud({ provider: 'gemini' });
check(
  'provider presets are real',
  resolvedGemini.baseUrl.includes('generativelanguage.googleapis.com') && Object.keys(PROVIDERS).length >= 4,
  `${Object.keys(PROVIDERS).length} providers`
);

const secret = 'sk-selftest-secret-123';
const leaked = JSON.stringify(publicCloud({ provider: 'gemini', apiKey: secret })).includes(secret);
check('cloud key never reaches the browser', !leaked, leaked ? 'LEAKED' : 'masked as keyMask');

const stubLocal = {
  chat: async () => 'local',
  chatStream: async (m, cb) => {
    cb('local');
    return 'local';
  },
  chatRaw: async () => ({ content: 'local', toolCalls: [] }),
  health: async () => ({ online: true, models: ['stub'], model: 'stub', hasModel: true })
};
const brokenCloud = {
  chat: async () => {
    throw new Error('401 from provider');
  },
  chatStream: async () => {
    throw new Error('401 from provider');
  },
  chatRaw: async () => {
    throw new Error('401 from provider');
  },
  health: async () => ({ online: false, error: '401' }),
  base: 'http://stub',
  provider: 'stub',
  model: 'stub'
};
const hybrid = makeHybridLlm({
  cfg: { cloud: { enabled: true, apiKey: 'x', provider: 'custom', baseUrl: 'http://stub', model: 'stub' } },
  local: stubLocal,
  cloud: brokenCloud
});
const fellBack = await hybrid.chatRaw([{ role: 'user', content: 'hi' }]);
check(
  'a dead cloud key falls back to the laptop',
  fellBack.content === 'local' && (await hybrid.health()).mode === 'local',
  'conversation keeps working'
);

// 3. tools
const tools = listTools();
check('tools registered', tools.length >= 15, `${tools.length} tools`);
const high = tools.filter((t) => t.risk === 'high');
check('risky tools gated', high.length > 0, `${high.length} ask permission first`);

// 4. a real tool run
const status = getTool('system_status');
if (status) {
  const r = await status.run({});
  check('system_status runs', r.ok !== false, String(r.summary || '').slice(0, 70));
} else {
  check('system_status runs', false, 'tool missing');
}

// 5. voice, both languages
const voice = voiceStatus();
check('voice engine present', voice.piper || voice.sapi, voice.piper ? 'piper offline' : 'windows sapi');

for (const [lang, text] of [
  ['hi', 'नमस्ते बॉस, मैं फ्राइडे हूँ।'],
  ['en', 'Good evening, boss. Everything is ready.']
]) {
  const started = Date.now();
  try {
    const out = await speak(text, { lang, engine: 'auto' });
    const ms = Date.now() - started;
    check(`voice ${lang}`, Boolean(out.audio?.length), `${out.engine}, ${(out.audio.length / 1024).toFixed(0)} kB, ${ms} ms`);
  } catch (err) {
    check(`voice ${lang}`, false, err.message);
  }
}

// 6. brain
const llm = makeLlm(cfg);
const health = await llm.health();
check('ollama reachable', health.online, health.online ? health.url : health.error || '');
check('model downloaded', Boolean(health.hasModel), health.models?.slice(0, 3).join(', ') || 'none');

if (health.online && health.hasModel) {
  const brain = makeBrain({ cfg, llm });

  // the real contract: a Hindi message gets a Devanagari answer, whatever the model drifts to
  const hiStart = Date.now();
  const hiTurn = await brain.runTurn({ text: 'नमस्ते, तुम कौन हो?', onEvent: () => {} });
  check(
    'replies in Hindi to a Hindi message',
    /[\u0900-\u097F]/.test(hiTurn.text),
    `${Date.now() - hiStart} ms · ${hiTurn.text.slice(0, 50)}`
  );

  const events = [];
  const turn = await brain.runTurn({ text: 'इस लैपटॉप की बैटरी कितनी है?', onEvent: (e, d) => events.push({ e, d }) });
  const usedStatus = events.some((x) => x.e === 'tool' && x.d.name === 'system_status');
  check(
    'battery question reads the real value',
    usedStatus && /\d+\s*%/.test(turn.text),
    `${events.filter((x) => x.e === 'tool').length} tool call(s) · ${turn.text.slice(0, 50)}`
  );
} else {
  check('replies in Hindi to a Hindi message', false, 'skipped — brain not ready');
  check('battery question reads the real value', false, 'skipped — brain not ready');
}

const failed = results.filter((r) => !r.ok);
console.log('  ' + '─'.repeat(52));
console.log(`  ${results.length - failed.length}/${results.length} passed${failed.length ? `  ·  ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
