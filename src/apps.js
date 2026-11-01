// FRIDAY's launcher: turns what you actually say ("insta kholo", "open gmail")
// into a real thing on THIS PC.
//
// Two rules, because they are the two things people mean:
//   websites (gmail, youtube, maps)  -> open in Chrome, always
//   apps (whatsapp, instagram, spotify) -> the installed desktop app, not the website
//
// Installed apps are discovered once from Windows itself (Start-menu entries + Store
// apps), cached, and looked up by name -- so "insta" finds "Instagram Beta" without
// anybody hard-coding a path.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { runPowerShell, parseJsonLoose, launchDetached } from './ps.js';

const INDEX_FILE = path.join(DATA_DIR, 'apps.json');
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ */
/* Hindi / Hinglish spellings -> the word the lookup understands        */
/* ------------------------------------------------------------------ */

const HINDI_WORDS = [
  [/व्हाट्स\s?एप|व्हाट्स\s?ऐप|वॉट्स\s?ऐप|वाट्स\s?एप|व्हाट्सप/g, 'whatsapp'],
  [/इंस्टाग्राम|इन्स्टाग्राम|इन्स्टाग्राम/g, 'instagram'],
  [/यूट्यूब|यूट्युब|युट्यूब/g, 'youtube'],
  [/जीमेल|जिमेल/g, 'gmail'],
  [/क्रोम/g, 'chrome'],
  [/स्पॉटिफ़?ाई/g, 'spotify'],
  [/टेलीग्राम|टेलिग्राम/g, 'telegram'],
  [/डिस्कॉर्ड/g, 'discord'],
  [/फेसबुक|फ़ेसबुक/g, 'facebook'],
  [/नेटफ्लिक्स|नेटफ़्लिक्स/g, 'netflix'],
  [/अमेज़न|अमेजन|अमेज़ॉन/g, 'amazon'],
  [/फ्लिपकार्ट/g, 'flipkart'],
  [/स्नैपचैट/g, 'snapchat'],
  [/ट्विटर/g, 'twitter'],
  [/लिंक्डइन|लिंक्ड\s?इन/g, 'linkedin'],
  [/चैट\s?जीपीटी/g, 'chatgpt'],
  [/सेटिंग्स|सेटिंग/g, 'settings'],
  [/नोटपैड/g, 'notepad'],
  [/कैलकुलेटर/g, 'calculator'],
  [/कैमरा/g, 'camera'],
  [/कैलेंडर/g, 'calendar'],
  [/मैप्स|नक्शा/g, 'maps'],
  [/ज़ूम|जूम/g, 'zoom'],
  [/स्टीम/g, 'steam'],
  [/स्विगी/g, 'swiggy'],
  [/ज़ोमैटो|जोमैटो/g, 'zomato'],
  [/फ़ाइल\s?एक्सप्लोरर|फाइल\s?एक्सप्लोरर/g, 'explorer'],
  [/फ़ोटो|फोटो/g, 'photos'],
  [/ड्राइव/g, 'drive'],
  [/गूगल/g, 'google'],
  [/गिटहब|गीथब/g, 'github'],
  [/वेबसाइट|वेब\s?साइट/g, 'website'],
  [/वेब/g, 'web'],
  [/ब्राउज़र|ब्राउजर/g, 'browser'],
  [/डाउनलोड/g, 'download'],
  [/ओपन/g, 'open']
];

/** Lowercase, spell Hindi names in Latin, tidy whitespace. Used for every comparison. */
export function normalize(input) {
  let s = String(input ?? '');
  for (const [re, word] of HINDI_WORDS) s = s.replace(re, word);
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Letters and digits only: "WhatsApp!" -> "whatsapp", "VS Code" -> "vscode". */
const key = (input) => normalize(input).replace(/[^a-z0-9]+/g, '');

/** Where a phrase starts in the text, or -1. Word-boundary aware so "ig" is not "big". */
function findPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?![a-z0-9])`, 'i');
  const m = re.exec(text);
  return m ? m.index + m[0].indexOf(m[1]) : -1;
}

/** Drop "google" when the text actually said "google maps". */
function dropContained(hits) {
  return hits.filter(
    (h) => !hits.some((o) => o !== h && o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len)
  );
}

/* ------------------------------------------------------------------ */
/* Websites                                                            */
/* ------------------------------------------------------------------ */

// Sites people open by voice. Every site here is opened in Chrome (see openWebsite).
const SITE_DEFS = [
  { name: 'Gmail', url: 'https://mail.google.com', aliases: ['gmail', 'google mail', 'g mail'] },
  { name: 'YouTube', url: 'https://www.youtube.com', aliases: ['youtube', 'yt'] },
  { name: 'Google', url: 'https://www.google.com', aliases: ['google', 'search engine'] },
  { name: 'Google Maps', url: 'https://maps.google.com', aliases: ['google maps', 'maps', 'map'] },
  { name: 'Google Drive', url: 'https://drive.google.com', aliases: ['google drive', 'gdrive'] },
  { name: 'Google Docs', url: 'https://docs.google.com', aliases: ['google docs', 'docs'] },
  { name: 'Google Calendar', url: 'https://calendar.google.com', aliases: ['google calendar', 'calendar'] },
  { name: 'Google Meet', url: 'https://meet.google.com', aliases: ['google meet', 'meet'] },
  { name: 'Google Photos', url: 'https://photos.google.com', aliases: ['google photos'] },
  { name: 'ChatGPT', url: 'https://chatgpt.com', aliases: ['chatgpt', 'chat gpt', 'openai'] },
  { name: 'Gemini', url: 'https://gemini.google.com', aliases: ['gemini'] },
  { name: 'GitHub', url: 'https://github.com', aliases: ['github', 'git hub'] },
  { name: 'LinkedIn', url: 'https://www.linkedin.com', aliases: ['linkedin', 'linked in'] },
  { name: 'Reddit', url: 'https://www.reddit.com', aliases: ['reddit'] },
  { name: 'Twitter', url: 'https://x.com', aliases: ['twitter', 'tweet'] },
  { name: 'Facebook', url: 'https://www.facebook.com', aliases: ['facebook', 'fb'] },
  { name: 'Netflix', url: 'https://www.netflix.com', aliases: ['netflix'] },
  { name: 'Prime Video', url: 'https://www.primevideo.com', aliases: ['prime video', 'amazon prime', 'prime'] },
  { name: 'Hotstar', url: 'https://www.hotstar.com', aliases: ['hotstar', 'disney plus hotstar'] },
  { name: 'Spotify Web', url: 'https://open.spotify.com', aliases: ['spotify web', 'spotify website'] },
  { name: 'Amazon', url: 'https://www.amazon.in', aliases: ['amazon'] },
  { name: 'Flipkart', url: 'https://www.flipkart.com', aliases: ['flipkart'] },
  { name: 'Myntra', url: 'https://www.myntra.com', aliases: ['myntra'] },
  { name: 'Swiggy', url: 'https://www.swiggy.com', aliases: ['swiggy'] },
  { name: 'Zomato', url: 'https://www.zomato.com', aliases: ['zomato'] },
  { name: 'Paytm', url: 'https://paytm.com', aliases: ['paytm'] },
  { name: 'PhonePe', url: 'https://www.phonepe.com', aliases: ['phonepe', 'phone pe'] },
  { name: 'IRCTC', url: 'https://www.irctc.co.in', aliases: ['irctc', 'train ticket'] },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com', aliases: ['stackoverflow', 'stack overflow'] },
  { name: 'Pinterest', url: 'https://www.pinterest.com', aliases: ['pinterest'] },
  { name: 'WhatsApp Web', url: 'https://web.whatsapp.com', aliases: ['whatsapp web', 'whatsapp online'] },
  { name: 'Instagram Web', url: 'https://www.instagram.com', aliases: ['instagram web', 'instagram website'] },
  { name: 'Telegram Web', url: 'https://web.telegram.org', aliases: ['telegram web'] }
];

/* ------------------------------------------------------------------ */
/* Apps: things that should open as real windows, not tabs             */
/* ------------------------------------------------------------------ */

const APP_DEFS = [
  { name: 'whatsapp', label: 'WhatsApp', aliases: ['whatsapp', 'whats app', 'wa'], appNames: ['WhatsApp'], site: 'https://web.whatsapp.com' },
  { name: 'instagram', label: 'Instagram', aliases: ['instagram', 'insta', 'ig'], appNames: ['Instagram', 'Instagram Beta'], site: 'https://www.instagram.com' },
  { name: 'telegram', label: 'Telegram', aliases: ['telegram'], appNames: ['Telegram Desktop', 'Telegram'], site: 'https://web.telegram.org' },
  { name: 'discord', label: 'Discord', aliases: ['discord'], appNames: ['Discord'], site: 'https://discord.com/app' },
  { name: 'spotify', label: 'Spotify', aliases: ['spotify'], appNames: ['Spotify'], site: 'https://open.spotify.com' },
  { name: 'steam', label: 'Steam', aliases: ['steam'], appNames: ['Steam'], site: 'https://store.steampowered.com' },
  { name: 'zoom', label: 'Zoom', aliases: ['zoom'], appNames: ['Zoom Workplace', 'Zoom'], site: 'https://zoom.us' },
  { name: 'snapchat', label: 'Snapchat', aliases: ['snapchat', 'snap'], appNames: ['Snapchat'], site: 'https://web.snapchat.com' },
  { name: 'chrome', label: 'Chrome', aliases: ['chrome', 'google chrome', 'browser'], appNames: ['Google Chrome', 'Chrome'] },
  { name: 'edge', label: 'Edge', aliases: ['edge', 'microsoft edge'], appNames: ['Microsoft Edge', 'Edge'] },
  { name: 'notepad', label: 'Notepad', aliases: ['notepad', 'note pad'], appNames: ['Notepad'] },
  { name: 'calculator', label: 'Calculator', aliases: ['calculator', 'calc'], appNames: ['Calculator'] },
  { name: 'paint', label: 'Paint', aliases: ['paint', 'ms paint'], appNames: ['Paint'] },
  { name: 'explorer', label: 'File Explorer', aliases: ['file explorer', 'explorer', 'my files'], appNames: ['File Explorer'] },
  { name: 'cmd', label: 'Command Prompt', aliases: ['command prompt', 'cmd', 'terminal'], appNames: ['Command Prompt', 'Terminal', 'Windows Terminal'] },
  { name: 'settings', label: 'Settings', aliases: ['settings', 'windows settings'], appNames: ['Settings'] },
  { name: 'camera', label: 'Camera', aliases: ['camera'], appNames: ['Camera'] },
  { name: 'photos', label: 'Photos', aliases: ['photos', 'photo', 'gallery'], appNames: ['Photos'] },
  { name: 'store', label: 'Microsoft Store', aliases: ['microsoft store', 'store'], appNames: ['Microsoft Store'] },
  { name: 'word', label: 'Microsoft Word', aliases: ['word', 'ms word', 'microsoft word'], appNames: ['Word', 'Microsoft Word'] },
  { name: 'excel', label: 'Microsoft Excel', aliases: ['excel', 'ms excel'], appNames: ['Excel', 'Microsoft Excel'] },
  { name: 'powerpoint', label: 'PowerPoint', aliases: ['powerpoint', 'ppt'], appNames: ['PowerPoint', 'Microsoft PowerPoint'] },
  { name: 'outlook', label: 'Outlook', aliases: ['outlook'], appNames: ['Outlook', 'Outlook (new)', 'Outlook (classic)'] },
  { name: 'vscode', label: 'VS Code', aliases: ['vs code', 'vscode', 'visual studio code'], appNames: ['Visual Studio Code', 'VS Code'] },
  { name: 'vlc', label: 'VLC', aliases: ['vlc', 'vlc player'], appNames: ['VLC media player', 'VLC'] },
  { name: 'taskmgr', label: 'Task Manager', aliases: ['task manager', 'taskmgr'], appNames: ['Task Manager'] }
];

// Windows built-ins: the exact target Windows needs, so they work even if the
// Start menu has no entry for them.
const SYSTEM_TARGETS = {
  notepad: { target: 'notepad.exe', kind: 'exe' },
  calculator: { target: 'calc.exe', kind: 'exe' },
  paint: { target: 'mspaint.exe', kind: 'exe' },
  explorer: { target: 'explorer.exe', kind: 'exe' },
  cmd: { target: 'cmd.exe', kind: 'exe' },
  powershell: { target: 'powershell.exe', kind: 'exe' },
  taskmgr: { target: 'taskmgr.exe', kind: 'exe' },
  settings: { target: 'ms-settings:', kind: 'proto' },
  camera: { target: 'microsoft.windows.camera:', kind: 'proto' },
  photos: { target: 'ms-photos:', kind: 'proto' },
  store: { target: 'ms-windows-store:', kind: 'proto' },
  snipping: { target: 'ms-screenclip:', kind: 'proto' },
  recycle: { target: 'shell:RecycleBinFolder', kind: 'proto' }
};

/* ------------------------------------------------------------------ */
/* Static alias tables (fast, no disk or PowerShell)                   */
/* ------------------------------------------------------------------ */

const siteByAlias = new Map();
for (const def of SITE_DEFS) {
  for (const alias of [def.name, ...def.aliases]) {
    const k = key(alias);
    if (k && !siteByAlias.has(k)) siteByAlias.set(k, def);
  }
}

const appByAlias = new Map();
for (const def of APP_DEFS) {
  for (const alias of [def.name, def.label, ...def.aliases]) {
    const k = key(alias);
    if (k && !appByAlias.has(k)) appByAlias.set(k, def);
  }
}

const WEB_HINT = /\b(website|web\s?site|site|web|online|web version)\b|वेबसाइट|वेब/i;

/** "gmail" -> { name, url }. Also accepts a bare domain like "flipkart.com". */
export function resolveSite(input) {
  const raw = normalize(input);
  if (!raw) return null;
  const site = siteByAlias.get(key(raw));
  if (site) return { name: site.name, url: site.url };

  const app = appByAlias.get(key(raw));
  if (app?.site) return { name: app.label, url: app.site };

  // keep the whole host: "mail.google.com" must not collapse to "google.com"
  const domain = raw.match(/\b((?:[a-z0-9][a-z0-9-]*\.)+(?:com|in|org|net|io|co|app|dev|me|ai|gov|edu|tv|xyz))\b/i);
  if (domain) return { name: domain[1], url: `https://${domain[1]}` };
  return null;
}

/** A readable name for an address, so she can say "Opened Gmail" not "Opened a URL". */
function labelForUrl(url) {
  const clean = String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  for (const def of SITE_DEFS) {
    if (def.url.replace(/^https?:\/\//i, '').replace(/\/+$/, '') === clean) return def.name;
  }
  return clean.replace(/^www\./i, '').split('/')[0];
}

/** Which sites are mentioned, in the order they appear. */
export function findSitesInText(text) {
  const t = normalize(text);
  const hits = [];
  for (const def of SITE_DEFS) {
    for (const alias of [def.name.toLowerCase(), ...def.aliases]) {
      const at = findPhrase(t, alias);
      if (at >= 0) hits.push({ def, at, len: alias.length });
    }
  }
  const best = new Map();
  for (const h of dropContained(hits)) {
    const prev = best.get(h.def.name);
    if (!prev || h.at < prev.at) best.set(h.def.name, h);
  }
  return [...best.values()].sort((a, b) => a.at - b.at);
}

/** Which apps are mentioned, in the order they appear. */
export function findAppsInText(text) {
  const t = normalize(text);
  const hits = [];
  for (const def of APP_DEFS) {
    for (const alias of [def.name, ...def.aliases]) {
      const at = findPhrase(t, alias);
      if (at >= 0) hits.push({ def, at, len: alias.length });
    }
  }
  const best = new Map();
  for (const h of dropContained(hits)) {
    const prev = best.get(h.def.name);
    if (!prev || h.at < prev.at) best.set(h.def.name, h);
  }
  return [...best.values()].sort((a, b) => a.at - b.at);
}

export function appDefFor(input) {
  return appByAlias.get(key(input)) || null;
}

export function siteForAppName(name) {
  const def = appByAlias.get(key(name));
  return def?.site ? { name: def.label, url: def.site } : null;
}

/* ------------------------------------------------------------------ */
/* Installed apps: discovered from Windows, cached on disk             */
/* ------------------------------------------------------------------ */

let indexCache = null;
let indexAt = 0;

const JUNK = /uninstall|readme|release notes|documentation|license|manual|help|website|support|feedback|install additional|getting started/i;

function tidyEntries(list) {
  const byKey = new Map();
  const rank = { exe: 0, uwp: 1, lnk: 2, proto: 3, shell: 4 };
  for (const raw of list || []) {
    const name = String(raw?.name || '').trim();
    const target = String(raw?.target || '').trim();
    if (!name || !target || JUNK.test(name)) continue;
    const kind = raw.kind || 'lnk';
    const k = key(name);
    if (!k) continue;
    const entry = { name, label: name, target, kind, key: k, exe: raw.exe || null };
    const prev = byKey.get(k);
    if (!prev || (rank[kind] ?? 9) < (rank[prev.kind] ?? 9)) byKey.set(k, entry);
  }
  return [...byKey.values()];
}

async function refreshIndex() {
  const script = `
    $out = New-Object System.Collections.ArrayList
    try {
      foreach ($a in (Get-StartApps)) {
        if (-not $a.Name -or -not $a.AppID) { continue }
        $id = [string]$a.AppID
        $kind = 'shell'
        if ($id -match '^[A-Za-z]:\\\\') { $kind = 'exe' }
        elseif ($id -like '*!*') { $kind = 'uwp' }
        [void]$out.Add(@{ name = [string]$a.Name; target = $id; kind = $kind })
      }
    } catch { }
    $shell = New-Object -ComObject WScript.Shell
    $menus = @(
      (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
      (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
    )
    foreach ($m in $menus) {
      if (-not (Test-Path $m)) { continue }
      Get-ChildItem -LiteralPath $m -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          $sc = $shell.CreateShortcut($_.FullName)
          [void]$out.Add(@{ name = $_.BaseName; target = $_.FullName; kind = 'lnk'; exe = $sc.TargetPath })
        } catch { }
      }
    }
    $out | ConvertTo-Json -Depth 3 -Compress`;

  const r = await runPowerShell(script, { timeout: 30000 });
  const parsed = parseJsonLoose(r.stdout);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const entries = tidyEntries(list);
  indexCache = entries;
  indexAt = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ at: Date.now(), apps: entries }), 'utf8');
  } catch {
    /* the cache is an optimisation; the in-memory list is enough */
  }
  return entries;
}

async function loadIndex({ force = false } = {}) {
  if (!force && indexCache) return indexCache;
  if (!force) {
    try {
      const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (data?.apps?.length && Date.now() - (data.at || 0) < INDEX_TTL_MS) {
        indexCache = data.apps;
        indexAt = data.at || 0;
        return indexCache;
      }
    } catch {
      /* no usable cache */
    }
  }
  return refreshIndex();
}

function bestMatch(entries, candidate) {
  const ck = key(candidate);
  if (!ck) return null;
  const exact = entries.find((e) => e.key === ck);
  if (exact) return exact;

  // "insta" -> "Instagram Beta", "whatsapp" -> "WhatsApp"
  if (ck.length >= 3) {
    const starts = entries.filter((e) => e.key.startsWith(ck) || ck.startsWith(e.key));
    if (starts.length) return starts.sort((a, b) => a.key.length - b.key.length)[0];
  }
  if (ck.length >= 4) {
    const inside = entries.filter((e) => e.key.includes(ck));
    if (inside.length) return inside.sort((a, b) => a.key.length - b.key.length)[0];
  }
  return null;
}

/** Find an installed app by any name the user might use. */
export async function findApp(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const def = appDefFor(raw);
  const candidates = [def?.name, ...(def?.appNames || []), raw].filter(Boolean);

  let entries = await loadIndex();
  for (const cand of candidates) {
    const hit = bestMatch(entries, cand);
    if (hit) return hit;
  }

  // a miss might just mean the cache predates an install - but rebuilding costs ~2 s,
  // so only do it once in a while instead of on every unknown name
  if (Date.now() - indexAt > 10 * 60 * 1000) {
    entries = await loadIndex({ force: true });
    for (const cand of candidates) {
      const hit = bestMatch(entries, cand);
      if (hit) return hit;
    }
  }

  const sys = SYSTEM_TARGETS[key(def?.name || raw)];
  if (sys) return { name: def?.label || raw, label: def?.label || raw, target: sys.target, kind: sys.kind, key: key(raw) };
  return null;
}

/* ------------------------------------------------------------------ */
/* Launching                                                           */
/* ------------------------------------------------------------------ */

async function launchEntry(entry) {
  const { target, kind } = entry;

  if (kind === 'exe' && /\.exe$/i.test(target) && fs.existsSync(target)) {
    try {
      launchDetached(target, []);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  const arg =
    kind === 'uwp' || kind === 'shell' ? `shell:AppsFolder\\${target}` : target;
  const r = await runPowerShell(`Start-Process ${psQuote(arg)}`, { timeout: 20000 });
  return { ok: r.code === 0, detail: r.stderr };
}

/** Chrome, wherever this PC keeps it. Chrome is the browser she opens sites in. */
export function findChrome() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA
  ].filter(Boolean);
  for (const root of roots) {
    const exe = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    try {
      if (fs.existsSync(exe)) return exe;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** Open a site. Chrome first; the default browser only if Chrome is missing. */
export async function openWebsite(input, { label } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, summary: 'No website given.' };

  // an explicit address is used exactly as given - never re-resolved to its parent domain
  const site = /^https?:\/\//i.test(raw) ? null : resolveSite(raw);
  let url = site?.url || '';
  if (!url) {
    url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) {
      return { ok: false, summary: `"${raw}" is not a web address I can open.` };
    }
  }
  const name = label || site?.name || labelForUrl(url);
  const chrome = findChrome();

  if (chrome) {
    try {
      launchDetached(chrome, [url]);
      return { ok: true, summary: `Opened ${name} in Chrome.`, data: { url, browser: 'chrome', label: name } };
    } catch (err) {
      /* fall through to the default browser */
    }
  }

  const r = await runPowerShell(`Start-Process ${psQuote(url)}`, { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, summary: `Could not open ${name}. ${String(r.stderr || '').slice(0, 200)}` };
  }
  return { ok: true, summary: `Opened ${name}.`, data: { url, browser: 'default', label: name } };
}

/**
 * Open whatever the user named: an installed app if there is one, otherwise its
 * website in Chrome. "whatsapp" -> desktop app, "gmail" -> browser tab.
 */
export async function openThing(input, { prefer = 'auto' } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, summary: 'No app or website name given.' };

  const wantsWeb = prefer === 'web' || (prefer !== 'app' && WEB_HINT.test(raw));
  const withoutHint = normalize(raw).replace(WEB_HINT, ' ').replace(/\s+/g, ' ').trim();

  if (wantsWeb) {
    const site = resolveSite(raw) || resolveSite(withoutHint);
    if (site) return openWebsite(site.url, { label: site.name });
    if (prefer === 'web') return { ok: false, summary: `I do not know the website for "${raw}".` };
  }

  if (prefer !== 'web') {
    const entry = await findApp(withoutHint || raw);
    if (entry) {
      const r = await launchEntry(entry);
      if (r.ok) {
        const label = entry.label || entry.name;
        return { ok: true, summary: `Opened ${label}.`, data: { app: label, kind: entry.kind } };
      }
      // an installed app that refuses to start: report it, do not pretend
      if (prefer === 'app') {
        return { ok: false, summary: `"${entry.label || entry.name}" is installed but would not start. ${String(r.detail || '').slice(0, 200)}` };
      }
    }
  }

  const site = resolveSite(raw) || resolveSite(withoutHint) || siteForAppName(raw);
  if (site) return openWebsite(site.url, { label: site.name });

  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw)) return openWebsite(raw);

  return {
    ok: false,
    summary: `I could not find "${raw}" installed on this PC, and I do not know a website for it either.`
  };
}
