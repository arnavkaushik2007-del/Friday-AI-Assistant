// FRIDAY's hands: everything she can actually do on the PC.
// Each tool declares a risk level; "high" tools need the user's approval.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './config.js';
import { runPowerShell, parseJsonLoose } from './ps.js';
import { memory, reminders } from './store.js';
import { openThing, openWebsite } from './apps.js';
import { lookAtScreen, visionStatus } from './vision.js';
import { toEnglish } from './translate.js';

let cfg = null;
export function configureTools(config) {
  cfg = config;
}

const truncate = (s, n = 3500) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}\n… [truncated ${str.length - n} chars]` : str;
};

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function expandPath(p) {
  let out = String(p || '').trim();
  if (!out) out = os.homedir();
  if (out === '~') out = os.homedir();
  if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/%([A-Za-z_]+)%/g, (m, name) => process.env[name] ?? m);
  return path.resolve(out);
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Blocks FRIDAY from touching anything outside the folders you allowed. */
export function safePath(p, { mustExist = false } = {}) {
  const abs = expandPath(p);
  if (!cfg?.allowAllPaths) {
    const roots = cfg?.allowRoots?.length ? cfg.allowRoots : [os.homedir()];
    const ok = roots.some((root) => isInside(abs, root));
    if (!ok) {
      throw new Error(
        `Access denied: "${abs}" is outside the folders FRIDAY is allowed to use. Ask the user to add it in Settings, or edit allowRoots in friday.config.json.`
      );
    }
  }
  if (mustExist && !fs.existsSync(abs)) throw new Error(`Not found: ${abs}`);
  return abs;
}

// App and website knowledge lives in ./apps.js: it asks Windows what is actually
// installed, so "insta" opens the real Instagram app instead of guessing a path.

const registry = [];
function tool(def) {
  registry.push(def);
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

tool({
  name: 'get_time',
  risk: 'low',
  desc: 'Current date, time and day on this PC. args: {}',
  async run() {
    const now = new Date();
    const formatted = now.toLocaleString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    return { ok: true, summary: `It is ${formatted} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).` };
  }
});

tool({
  name: 'system_status',
  risk: 'low',
  desc: 'RAM, CPU load, disk space, battery and uptime of this PC. args: {}',
  async run() {
    const script = `
      $os = Get-CimInstance Win32_OperatingSystem
      $cs = Get-CimInstance Win32_ComputerSystem
      $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
      $disks = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object {
        @{ name = $_.Name; usedGB = [math]::Round($_.Used/1GB,1); freeGB = [math]::Round($_.Free/1GB,1) }
      })
      $batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
      @{
        os            = $os.Caption
        totalRamGB    = [math]::Round($cs.TotalPhysicalMemory/1GB,1)
        freeRamGB     = [math]::Round($os.FreePhysicalMemory/1MB,1)
        cpuPercent    = if ($cpu) { [math]::Round($cpu,0) } else { $null }
        uptimeHours   = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1)
        disks         = $disks
        battery       = if ($batt) { @{ percent = $batt.EstimatedChargeRemaining; charging = [bool]($batt.BatteryStatus -eq 2 -or $batt.BatteryStatus -eq 6) } } else { $null }
      } | ConvertTo-Json -Depth 5 -Compress`;
    const r = await runPowerShell(script, { timeout: 20000 });
    const data = parseJsonLoose(r.stdout);
    if (!data) return { ok: false, summary: `Could not read system status. ${truncate(r.stderr, 500)}` };
    const usedRam = (data.totalRamGB - data.freeRamGB).toFixed(1);
    const mainDisk = (data.disks || [])[0];
    const parts = [
      `RAM: ${usedRam} of ${data.totalRamGB} GB used (${data.freeRamGB} GB free)`,
      data.cpuPercent !== null && data.cpuPercent !== undefined ? `CPU load: ${data.cpuPercent}%` : null,
      mainDisk ? `Disk ${mainDisk.name}: ${mainDisk.freeGB} GB free` : null,
      data.battery ? `Battery: ${data.battery.percent}%${data.battery.charging ? ' (charging)' : ''}` : null,
      `Uptime: ${data.uptimeHours} h`
    ].filter(Boolean);
    return { ok: true, summary: parts.join(' · '), data };
  }
});

tool({
  name: 'run_powershell',
  risk: 'high',
  desc: 'Run any PowerShell command on the PC and return its output. args: { command: string }',
  async run(args) {
    const command = String(args.command || args.script || '').trim();
    if (!command) return { ok: false, summary: 'No command given.' };
    const r = await runPowerShell(command, { timeout: 30000 });
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.code === 0,
      summary: truncate(out || '(command finished with no output)', 3000),
      data: { exitCode: r.code, ms: r.ms }
    };
  }
});

tool({
  name: 'open_app',
  risk: 'low',
  desc: 'Open an installed desktop app by name - whatsapp, instagram, telegram, spotify, notepad, vscode, settings, word, any installed program. If that app is not installed but the name is a known website it opens the site in Chrome instead. args: { name: string }',
  async run(args) {
    return openThing(String(args.name || '').trim());
  }
});

tool({
  name: 'open_url',
  risk: 'low',
  desc: 'Open a website in Chrome. Use for gmail, youtube, google maps, chatgpt, netflix, any site, or a known domain. args: { url: string }',
  async run(args) {
    return openWebsite(String(args.url || '').trim());
  }
});

tool({
  name: 'list_dir',
  risk: 'low',
  desc: 'List files and folders in a directory. args: { path: string }',
  async run(args) {
    const dir = safePath(args.path || os.homedir(), { mustExist: true });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return { ok: false, summary: `${dir} is a file, not a folder.` };
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 60);
    const lines = entries.map((e) => {
      if (e.isDirectory()) return `[dir]  ${e.name}`;
      try {
        const s = fs.statSync(path.join(dir, e.name));
        return `[file] ${e.name} (${(s.size / 1024).toFixed(1)} KB)`;
      } catch {
        return `[file] ${e.name}`;
      }
    });
    return {
      ok: true,
      summary: lines.length ? `Contents of ${dir}:\n${lines.join('\n')}` : `${dir} is empty.`,
      data: { path: dir, count: entries.length }
    };
  }
});

tool({
  name: 'read_file',
  risk: 'low',
  desc: 'Read a text file from disk. args: { path: string }',
  async run(args) {
    const file = safePath(args.path, { mustExist: true });
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) return { ok: false, summary: `${file} is too big (${(stat.size / 1048576).toFixed(1)} MB).` };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { ok: false, summary: `${path.basename(file)} looks like a binary file.` };
    return { ok: true, summary: `File ${file}:\n\n${truncate(buf.toString('utf8'), 6000)}` };
  }
});

tool({
  name: 'write_file',
  risk: 'medium',
  desc: 'Create or overwrite a text file. args: { path: string, content: string }',
  async run(args) {
    const file = safePath(args.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.content ?? ''), 'utf8');
    return { ok: true, summary: `Saved ${file} (${String(args.content ?? '').length} characters).`, data: { path: file } };
  }
});

tool({
  name: 'search_files',
  risk: 'low',
  desc: 'Find files by name pattern under a folder. args: { query: string, path?: string }',
  async run(args) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, summary: 'No search text given.' };
    const root = safePath(args.path || os.homedir(), { mustExist: true });
    const script = `
      $root = ${psQuote(root)}
      $q = ${psQuote(query)}
      Get-ChildItem -LiteralPath $root -Recurse -Filter "*$q*" -ErrorAction SilentlyContinue -Depth 4 |
        Select-Object -First 40 |
        ForEach-Object { @{ name = $_.Name; path = $_.FullName; dir = $_.PSIsContainer; sizeKB = if ($_.PSIsContainer) { $null } else { [math]::Round($_.Length/1KB,1) } } } |
        ConvertTo-Json -Depth 3 -Compress`;
    const r = await runPowerShell(script, { timeout: 25000 });
    const data = parseJsonLoose(r.stdout);
    if (!data) return { ok: true, summary: `No files matching "${query}" found in ${root}.` };
    const list = Array.isArray(data) ? data : [data];
    const lines = list.map((f) => `${f.dir ? '[dir] ' : ''}${f.path}`);
    return { ok: true, summary: `Found ${list.length} match(es):\n${lines.join('\n')}`, data: list };
  }
});

tool({
  name: 'screenshot',
  risk: 'low',
  desc: 'Take a screenshot of the screen and show it to the user. args: {}',
  async run() {
    const dir = path.join(DATA_DIR, 'media');
    fs.mkdirSync(dir, { recursive: true });
    const name = `screen-${Date.now()}.png`;
    const file = path.join(dir, name);
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
      $bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()`;
    const r = await runPowerShell(script, { timeout: 20000 });
    if (!fs.existsSync(file)) return { ok: false, summary: `Screenshot failed. ${truncate(r.stderr, 300)}` };
    return {
      ok: true,
      summary: `Screenshot captured and saved to ${file}.`,
      media: { type: 'image', url: `/media/${name}`, path: file }
    };
  }
});

tool({
  name: 'look_at_screen',
  risk: 'low',
  desc: 'Look at the user\'s screen with a vision model and answer what is on it - a window, an error message, a dialog, code. Use it when the user asks what is on their screen or asks for help with a problem they are looking at. args: { question?: string }',
  async run(args) {
    const question = String(args.question || 'What is on my screen? What is the problem?');
    const out = await lookAtScreen({ question: String(args.question || ''), cfg });
    if (!out.ok) return { ok: false, summary: out.hint || 'I could not read the screen.' };
    return {
      ok: true,
      summary: `${out.text}\n\n(seen with ${out.engine === 'cloud' ? 'the cloud model' : out.model} in ${Math.round(out.ms / 1000)}s)`,
      media: out.media || null,
      data: { engine: out.engine, model: out.model, ms: out.ms, question, text: out.text }
    };
  }
});

tool({
  name: 'media_control',
  risk: 'low',
  desc: 'Control music/video and system volume. args: { action: "play_pause" | "next" | "previous" | "stop" | "volume_up" | "volume_down" | "mute" }',
  async run(args) {
    const map = {
      play_pause: 179,
      play: 179,
      pause: 179,
      next: 176,
      next_track: 176,
      previous: 177,
      prev: 177,
      stop: 178,
      volume_up: 175,
      volume_down: 174,
      mute: 173
    };
    const action = String(args.action || '').toLowerCase().replace(/\s+/g, '_');
    const code = map[action];
    if (!code) return { ok: false, summary: `Unknown media action "${args.action}".` };
    const r = await runPowerShell(
      `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code}); Start-Sleep -Milliseconds 150`,
      { timeout: 8000 }
    );
    return r.code === 0 ? { ok: true, summary: `Media: ${action}` } : { ok: false, summary: truncate(r.stderr, 300) };
  }
});

tool({
  name: 'clipboard',
  risk: 'low',
  desc: 'Read or write the clipboard. args: { action: "get" | "set", text?: string }',
  async run(args) {
    const action = String(args.action || 'get').toLowerCase();
    if (action === 'set') {
      const text = String(args.text ?? '');
      const r = await runPowerShell(`Set-Clipboard -Value ${psQuote(text)}`, { timeout: 8000 });
      return r.code === 0 ? { ok: true, summary: 'Copied to clipboard.' } : { ok: false, summary: truncate(r.stderr, 300) };
    }
    const r = await runPowerShell('Get-Clipboard -Raw', { timeout: 8000 });
    return { ok: true, summary: `Clipboard: ${truncate(r.stdout || '(empty)', 1500)}` };
  }
});

tool({
  name: 'type_text',
  risk: 'high',
  desc: 'Type text into whatever window is focused on the PC. args: { text: string }',
  async run(args) {
    const text = String(args.text ?? '');
    if (!text) return { ok: false, summary: 'No text given.' };
    if (/[^\x00-\x7F]/.test(text)) {
      return { ok: false, summary: 'Typing non-English text (Hindi) into another app is not reliable on Windows; use clipboard + paste instead.' };
    }
    // escape SendKeys special characters
    const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
    const r = await runPowerShell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys(${psQuote(escaped)})`, { timeout: 8000 });
    return r.code === 0 ? { ok: true, summary: 'Typed the text.' } : { ok: false, summary: truncate(r.stderr, 300) };
  }
});

tool({
  name: 'lock_pc',
  risk: 'medium',
  desc: 'Lock the Windows screen. args: {}',
  async run() {
    const r = await runPowerShell('rundll32.exe user32.dll,LockWorkStation', { timeout: 8000 });
    return { ok: r.code === 0, summary: 'PC locked.' };
  }
});

tool({
  name: 'sleep_pc',
  risk: 'high',
  desc: 'Put the PC to sleep. args: {}',
  async run() {
    const r = await runPowerShell('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { timeout: 8000 });
    return { ok: r.code === 0, summary: 'Going to sleep.' };
  }
});

tool({
  name: 'shutdown_pc',
  risk: 'high',
  desc: 'Shut the PC down in 60 seconds (the user can cancel). args: {}',
  async run() {
    const r = await runPowerShell('shutdown.exe /s /t 60 /c "FRIDAY shutdown"', { timeout: 8000 });
    return { ok: r.code === 0, summary: 'Shutdown scheduled in 60 seconds. Say "cancel shutdown" to stop it.' };
  }
});

tool({
  name: 'cancel_shutdown',
  risk: 'low',
  desc: 'Cancel a pending shutdown. args: {}',
  async run() {
    const r = await runPowerShell('shutdown.exe /a', { timeout: 8000 });
    return { ok: r.code === 0, summary: r.code === 0 ? 'Shutdown cancelled.' : 'No shutdown was pending.' };
  }
});

tool({
  name: 'set_reminder',
  risk: 'low',
  desc: 'Set a reminder. args: { text: string, in_minutes?: number, at?: "YYYY-MM-DD HH:MM" }',
  async run(args) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'No reminder text given.' };
    let due;
    if (args.in_minutes !== undefined && args.in_minutes !== null && !Number.isNaN(Number(args.in_minutes))) {
      due = Date.now() + Number(args.in_minutes) * 60000;
    } else if (args.at) {
      const parsed = new Date(String(args.at).replace(' ', 'T'));
      if (Number.isNaN(parsed.getTime())) return { ok: false, summary: `Could not understand the time "${args.at}".` };
      due = parsed.getTime();
    } else {
      due = Date.now() + 3600000;
    }
    const r = reminders.add(text, due);
    const when = new Date(due).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    return { ok: true, summary: `Reminder set for ${when}: ${text}`, data: r };
  }
});

tool({
  name: 'list_reminders',
  risk: 'low',
  desc: 'List pending reminders. args: {}',
  async run() {
    const list = reminders.pending();
    if (!list.length) return { ok: true, summary: 'No pending reminders.' };
    const lines = list.map((r) => `- ${r.text} (${new Date(r.dueAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })})`);
    return { ok: true, summary: `Pending reminders:\n${lines.join('\n')}`, data: list };
  }
});

tool({
  name: 'remember',
  risk: 'low',
  desc: 'Save a lasting fact about the user (preferences, names, projects). args: { text: string }',
  async run(args) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'Nothing to remember.' };
    memory.add(text);
    return { ok: true, summary: `Remembered: ${text}` };
  }
});

tool({
  name: 'recall',
  risk: 'low',
  desc: 'Search your saved memories about the user. args: { query?: string }',
  async run(args) {
    const found = memory.search(args.query);
    if (!found.length) return { ok: true, summary: 'Nothing saved about that yet.' };
    return { ok: true, summary: found.map((m) => `- ${m.text}`).join('\n'), data: found };
  }
});

tool({
  name: 'notify',
  risk: 'low',
  desc: 'Show a Windows notification toast. args: { title: string, text: string }',
  async run(args) {
    const title = String(args.title || 'FRIDAY').slice(0, 60);
    const text = String(args.text || '').slice(0, 200);
    const script = `
      try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $nodes = $t.GetElementsByTagName("text")
        $nodes.Item(0).AppendChild($t.CreateTextNode(${psQuote(title)})) | Out-Null
        $nodes.Item(1).AppendChild($t.CreateTextNode(${psQuote(text)})) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($t)
        $app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
        "shown"
      } catch { "toast-failed: $($_.Exception.Message)" }`;
    const r = await runPowerShell(script, { timeout: 12000 });
    if (r.stdout.includes('toast-failed')) return { ok: false, summary: 'Windows blocked the notification (no registered app id).' };
    return { ok: true, summary: `Notification shown: ${title}` };
  }
});

tool({
  name: 'web_search',
  risk: 'low',
  desc: 'Search the web (DuckDuckGo, free) and get result titles + snippets. args: { query: string }',
  async run(args) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, summary: 'No search query given.' };
    try {
      const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8'
        },
        signal: AbortSignal.timeout(15000)
      });
      const html = await res.text();
      const clean = (s) =>
        s
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
      // DuckDuckGo puts the link and its snippet in two separate anchors. Matching both
      // in one regex (the old way) quietly dropped every snippet, so she was answering
      // from titles alone — which is how "weather in Delhi" turned into an invented 15°C.
      const results = [];
      const anchors = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      for (let i = 0; i < anchors.length && results.length < 8; i += 1) {
        const m = anchors[i];
        const tail = html.slice(m.index + m[0].length, anchors[i + 1]?.index ?? html.length);
        const snippet = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        let url = m[1];
        const redirect = url.match(/uddg=([^&]+)/);
        if (redirect) url = decodeURIComponent(redirect[1]);
        if (url.startsWith('//')) url = `https:${url}`;
        results.push({ title: clean(m[2]), snippet: clean(snippet?.[1] || ''), url });
      }
      if (!results.length) return { ok: false, summary: 'Web search returned nothing usable (possibly blocked).' };
      return {
        ok: true,
        summary: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n'),
        data: results
      };
    } catch (err) {
      return { ok: false, summary: `Web search failed: ${err.message}` };
    }
  }
});

/** A page's readable text. Shared by browse_web and web_answer. */
async function fetchReadable(url, { limit = 8000, timeout = 20000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8'
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/html|text/i.test(type)) throw new Error('not a text page');
  const html = await res.text();
  // crude but effective extraction
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit)}\n\n[truncated]`;
  return text;
}

tool({
  name: 'browse_web',
  risk: 'low',
  desc: 'Open a web page and read its main content to answer questions about it. args: { url: string, query?: string }',
  async run(args) {
    const url = String(args.url || '').trim();
    if (!url) return { ok: false, summary: 'No URL given.' };
    try {
      const text = await fetchReadable(url);
      const query = String(args.query || '').trim();
      const summary = query ? `Content from ${url} (focused on: ${query}):\n\n${text}` : `Content from ${url}:\n\n${text}`;
      return { ok: true, summary: summary.slice(0, 9000), data: { url, length: text.length } };
    } catch (err) {
      return { ok: false, summary: `Failed to browse ${url}: ${err.message}` };
    }
  }
});

// Search + read the best pages in one call. This is what makes "what's the weather"
// today's real number instead of whatever the model remembers from training.
const webCache = new Map(); // query -> { at, result }: asking twice in a row is instant
const WEB_TTL = 3 * 60 * 1000;

tool({
  name: 'web_answer',
  risk: 'low',
  desc: 'Search the web and read the best pages to answer anything that changes daily: weather, news, prices, scores, share rates, "latest"/"today" facts. args: { query: string }',
  async run(args) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, summary: 'No search query given.' };

    const key = query.toLowerCase();
    const hit = webCache.get(key);
    if (hit && Date.now() - hit.at < WEB_TTL) return hit.result;

    // A Hindi question searches better as English — the free search engines have
    // far more usable pages in it.
    let searchQuery = query;
    if (/[\u0900-\u097F]/.test(query)) {
      try {
        const english = await toEnglish(query);
        if (english && !/[\u0900-\u097F]/.test(english)) searchQuery = english;
      } catch {
        /* search in Hindi as-is */
      }
    }

    try {
      const search = await getTool('web_search').run({ query: searchQuery });
      const found = search.data || [];
      if (search.ok === false || !found.length) {
        return { ok: false, summary: 'No search results to read.' };
      }

      // snippets first: they are short, clean and often already contain the number
      const ranked = [...found].sort((a, b) => Number(Boolean(b.snippet)) - Number(Boolean(a.snippet)));
      // A snippet that already carries the number (a price, a score, a temperature)
      // answers the question on its own — no need to wait for a page to load.
      const answered = ranked.find((p) => p.snippet.length > 80 && /\d/.test(p.snippet));
      const picks = answered ? [answered] : ranked.slice(0, 2);
      const pages = await Promise.allSettled(picks.map((p) => fetchReadable(p.url, { limit: 3000, timeout: 6000 })));

      const blocks = [];
      picks.forEach((p, i) => {
        const settled = pages[i];
        const read = settled.status === 'fulfilled' ? settled.value : '';
        const snippet = p.snippet ? `Summary: ${p.snippet}\n` : '';
        if (!snippet && !read) return;
        blocks.push(`${p.title}\n${snippet}${read ? `Page: ${read}` : ''}`.trim());
      });
      if (!blocks.length) return { ok: false, summary: 'Nothing readable was found for that question.' };

      const result = {
        ok: true,
        summary: `Web results for "${searchQuery}":\n\n${blocks.join('\n\n---\n\n').slice(0, 6000)}`,
        data: { query: searchQuery, sources: picks.map((p) => p.url) }
      };
      webCache.set(key, { at: Date.now(), result });
      if (webCache.size > 40) webCache.delete(webCache.keys().next().value);
      return result;
    } catch (err) {
      return { ok: false, summary: `Web lookup failed: ${err.message}` };
    }
  }
});

/* ------------------------------------------------------------------ */

export function getTool(name) {
  return registry.find((t) => t.name === name);
}

export function listTools() {
  return registry.map(({ name, desc, risk }) => ({ name, desc, risk }));
}

/** Compact catalog for the system prompt. */
export function toolCatalog() {
  return registry.map((t) => `- ${t.name}: ${t.desc}`).join('\n');
}

/* Argument shapes, used for native model function-calling. */
const PARAMS = {
  get_time: {},
  system_status: {},
  run_powershell: { properties: { command: { type: 'string', description: 'PowerShell command to run' } }, required: ['command'] },
  open_app: { properties: { name: { type: 'string', description: 'Installed app name, e.g. whatsapp, instagram, spotify, notepad, vscode, settings' } }, required: ['name'] },
  open_url: { properties: { url: { type: 'string', description: 'Site name or full URL, e.g. gmail, youtube, https://flipkart.com' } }, required: ['url'] },
  list_dir: { properties: { path: { type: 'string', description: 'Folder path, ~ allowed' } }, required: ['path'] },
  read_file: { properties: { path: { type: 'string' } }, required: ['path'] },
  write_file: { properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  search_files: {
    properties: { query: { type: 'string', description: 'File name or pattern' }, path: { type: 'string', description: 'Folder to search in' } },
    required: ['query']
  },
  screenshot: {},
  look_at_screen: { properties: { question: { type: 'string', description: 'What to look for on the screen' } } },
  media_control: {
    properties: {
      action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute'] }
    },
    required: ['action']
  },
  clipboard: {
    properties: { action: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string' } },
    required: ['action']
  },
  type_text: { properties: { text: { type: 'string' } }, required: ['text'] },
  lock_pc: {},
  sleep_pc: {},
  shutdown_pc: {},
  cancel_shutdown: {},
  set_reminder: {
    properties: {
      text: { type: 'string', description: 'What to remind about' },
      in_minutes: { type: 'number', description: 'Minutes from now' },
      at: { type: 'string', description: 'Absolute local time, YYYY-MM-DD HH:MM' }
    },
    required: ['text']
  },
  list_reminders: {},
  remember: { properties: { text: { type: 'string' } }, required: ['text'] },
  recall: { properties: { query: { type: 'string' } } },
  notify: { properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
  web_search: { properties: { query: { type: 'string' } }, required: ['query'] },
  web_answer: { properties: { query: { type: 'string', description: 'The question or topic to look up' } }, required: ['query'] },
  browse_web: { properties: { url: { type: 'string' }, query: { type: 'string' } }, required: ['url'] }
};

/** Tool definitions in the format Ollama's function calling expects. */
export function toolSchemas() {
  return registry.map((t) => {
    const spec = PARAMS[t.name] || {};
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.desc.split(/\s*args:/)[0].trim(),
        parameters: {
          type: 'object',
          properties: spec.properties || {},
          required: spec.required || []
        }
      }
    };
  });
}

export function needsApproval(name) {
  const t = getTool(name);
  if (!t) return false;
  if (t.risk === 'low') return false;
  const auto = cfg?.autoApproveTools || [];
  return !auto.includes(name);
}
