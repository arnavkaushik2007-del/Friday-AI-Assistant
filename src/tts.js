// FRIDAY's voice. Three free engines, best first:
//   1. piper  - offline neural TTS (female Hindi + English), ~0.3s per sentence
//   2. google - free online TTS (Hindi / Indian English), no key
//   3. sapi   - Windows built-in voices (offline, quality depends on the PC)
// If none work the browser falls back to its own speech synthesis.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { DATA_DIR, ROOT } from './config.js';
import { runPowerShell } from './ps.js';

const CACHE_DIR = path.join(DATA_DIR, 'media', 'tts');
const MAX_CACHE_FILES = 200;

const PIPER_DIR = path.join(ROOT, 'tools', 'piper');
const PIPER_EXE = path.join(PIPER_DIR, 'piper', 'piper.exe');
const PIPER_VOICES = path.join(PIPER_DIR, 'voices');

const PIPER_MODELS = {
  hi: { file: 'hi_IN-priyamvada-medium.onnx', label: 'Priyamvada (Hindi, female)' },
  en: { file: 'en_US-amy-medium.onnx', label: 'Amy (English, female)' }
};

export function piperAvailable() {
  if (!fs.existsSync(PIPER_EXE)) return false;
  return Object.values(PIPER_MODELS).some((m) => fs.existsSync(path.join(PIPER_VOICES, m.file)));
}

function piperVoiceFile(lang) {
  const model = PIPER_MODELS[lang] || PIPER_MODELS.en;
  const file = path.join(PIPER_VOICES, model.file);
  return fs.existsSync(file) ? file : null;
}

/** Turn a written answer into something that sounds natural when spoken. */
export function speechReady(text, maxChars = 700, lang = 'en') {
  const hi = lang === 'hi';
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, '');
  t = t.replace(/^\s*[-*•]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/[#*_`>|]/g, '');
  t = t.replace(/\p{Extended_Pictographic}/gu, '');
  // A line break is a pause in a script, but piper reads it as one long run-on sentence.
  t = t.replace(/[ \t]*\n+[ \t]*/g, (m, offset, whole) => (/[.!?।:]$/.test(whole.slice(0, offset).trimEnd()) ? ' ' : '. '));
  // "32°C" spoken as "thirty-two degrees Celsius" sounds like a person; "32 C" does not.
  t = t.replace(/(-?\d+(?:\.\d+)?)\s*°\s*C\b/g, hi ? '$1 डिग्री सेल्सियस' : '$1 degrees Celsius');
  t = t.replace(/(-?\d+(?:\.\d+)?)\s*°\s*F\b/g, hi ? '$1 डिग्री फ़ारेनहाइट' : '$1 degrees Fahrenheit');
  t = t.replace(/(-?\d+(?:\.\d+)?)\s*°/g, hi ? '$1 डिग्री' : '$1 degrees');
  // Symbols that a voice reads as noise. Spoken out, they make her sound human
  // instead of like a screen reader.
  t = t.replace(/(\d)\s*%/g, hi ? '$1 प्रतिशत' : '$1 percent');
  t = t.replace(/₹\s*(\d)/g, hi ? '$1 रुपये' : '$1 rupees');
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/\s*→\s*/g, hi ? ' से ' : ' to ');
  t = t.replace(/\s*&\s*/g, hi ? ' और ' : ' and ');
  t = t.replace(/\b(e\.g\.|eg)\b/gi, hi ? 'जैसे कि' : 'for example');
  t = t.replace(/\b(i\.e\.|ie)\b/gi, hi ? 'यानी' : 'that is');
  t = t.replace(/\bvs\.?\b/gi, hi ? 'बनाम' : 'versus');
  t = t.replace(/\bapprox\.?\b/gi, hi ? 'लगभग' : 'approximately');
  t = t.replace(/\s+([,.;:!?।])/g, '$1');
  t = t.replace(/([,.;:!?।])(?=[^\s\d])/g, '$1 ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('। '));
    t = lastStop > maxChars * 0.4 ? cut.slice(0, lastStop + 1) : `${cut}…`;
  }
  return t;
}

/* ----------------------------- piper (offline) ----------------------------- */

function runPiper(text, modelFile, { lengthScale = 1.0 } = {}) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(DATA_DIR, 'media', `piper-${crypto.randomBytes(6).toString('hex')}.wav`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    // A little breath and a real pause between sentences is what separates a
    // person talking from a text-to-speech robot.
    const args = [
      '-m', modelFile,
      '-f', outFile,
      '--length_scale', lengthScale.toFixed(3),
      '--sentence_silence', '0.32',
      '--noise_scale', '0.68',
      '--noise_w', '0.82',
      '-q'
    ];

    const child = spawn(PIPER_EXE, args, { cwd: path.dirname(PIPER_EXE), windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error('piper timed out'));
    }, 30000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(outFile)) return reject(new Error(`piper failed (${code}): ${stderr.slice(-300)}`));
        const buf = fs.readFileSync(outFile);
        fs.unlinkSync(outFile);
        resolve(buf);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.write(`${text}\n`);
    child.stdin.end();
  });
}

/* ------------------------------ google (free) ------------------------------ */

function chunkForGoogle(text, limit = 190) {
  const parts = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?।])\s+/)) {
    if ((current + ' ' + sentence).trim().length > limit && current) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text.slice(0, limit)];
}

async function googleTts(text, lang) {
  const tl = lang === 'hi' ? 'hi' : 'en-IN';
  const buffers = [];
  for (const part of chunkForGoogle(text)) {
    const res = await fetch(
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(part)}&total=1&idx=0&textlen=${part.length}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          Referer: 'https://translate.google.com/'
        },
        signal: AbortSignal.timeout(9000)
      }
    );
    if (!res.ok) throw new Error(`google tts ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('audio')) throw new Error('google tts blocked');
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(buffers);
}

/* ------------------------------- sapi (win) -------------------------------- */

async function sapiTts(text, lang, voiceId = '', rate = '+0%') {
  const file = path.join(DATA_DIR, 'media', `sapi-${crypto.randomBytes(6).toString('hex')}.wav`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wanted = lang === 'hi' ? 'hi' : 'en';
  const safeText = String(text).replace(/"/g, '`"').replace(/\r?\n/g, ' ');
  // The chosen voice is passed as base64 so a name with quotes or spaces cannot
  // break out of the PowerShell script.
  const wantedName = String(voiceId).startsWith('sapi:') ? String(voiceId).slice(5) : '';
  const nameB64 = wantedName ? Buffer.from(wantedName, 'utf8').toString('base64') : '';
  const pct = Number(String(rate).replace('%', '')) || 0;
  const sapiRate = Math.max(-10, Math.min(10, Math.round(pct / 10)));
  const script = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = $s.GetInstalledVoices() | Where-Object { $_.Enabled }
    $wantName = ${nameB64 ? `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nameB64}'))` : "''"}
    $pick = $null
    if ($wantName) { $pick = $voices | Where-Object { $_.VoiceInfo.Name -eq $wantName } | Select-Object -First 1 }
    if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like '${wanted}*' -and $_.VoiceInfo.Gender -eq 'Female' } | Select-Object -First 1 }
    if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like '${wanted}*' } | Select-Object -First 1 }
    if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Gender -eq 'Female' } | Select-Object -First 1 }
    if (-not $pick) { throw 'no voice installed' }
    $s.SelectVoice($pick.VoiceInfo.Name)
    $s.Rate = ${sapiRate}
    $s.SetOutputToWaveFile('${file}')
    $s.Speak("${safeText}")
    $s.Dispose()
    "ok:" + $pick.VoiceInfo.Name`;
  const result = await runPowerShell(script, { timeout: 30000 });
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) throw new Error(`sapi failed: ${result.stderr.slice(0, 200)}`);
  const buf = fs.readFileSync(file);
  fs.unlinkSync(file);
  return buf;
}

/* -------------------------------- public API ------------------------------- */

function cacheKey(text, lang, engine) {
  return crypto.createHash('sha1').update(`${engine}|${lang}|${text}`).digest('hex');
}

function cacheGet(key) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const ext of ['wav', 'mp3']) {
    const file = path.join(CACHE_DIR, `${key}.${ext}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 512) {
      return { audio: fs.readFileSync(file), mime: ext === 'wav' ? 'audio/wav' : 'audio/mpeg' };
    }
  }
  return null;
}

function cachePut(key, audio, mime) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.${ext}`), audio);
    const files = fs
      .readdirSync(CACHE_DIR)
      .map((f) => ({ f: path.join(CACHE_DIR, f), t: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    if (files.length > MAX_CACHE_FILES) files.slice(0, files.length - MAX_CACHE_FILES).forEach((x) => fs.unlinkSync(x.f));
  } catch {
    /* cache is a nice-to-have */
  }
}

export async function listVoices() {
  const out = {
    piper: [],
    sapi: [],
    google: [{ id: 'google-hi', label: 'Google Hindi (female)', lang: 'hi' }, { id: 'google-en', label: 'Google English (Indian female)', lang: 'en' }]
  };
  if (piperAvailable()) {
    for (const [lang, m] of Object.entries(PIPER_MODELS)) {
      if (fs.existsSync(path.join(PIPER_VOICES, m.file))) {
        out.piper.push({ id: `piper:${lang}`, label: m.label, lang });
      }
    }
  }
  if (process.platform === 'win32') {
    try {
      const script = `
        Add-Type -AssemblyName System.Speech
        $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
          @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() }
        } | ConvertTo-Json -Compress
      `;
      const r = await runPowerShell(script, { timeout: 8000 });
      const data = JSON.parse(r.stdout || '[]');
      const list = Array.isArray(data) ? data : [data];
      for (const v of list) {
        out.sapi.push({ id: `sapi:${v.name}`, label: `${v.name} (${v.culture}, ${v.gender})`, lang: v.culture?.startsWith('hi') ? 'hi' : 'en', name: v.name });
      }
    } catch {}
  }
  return out;
}

export function voiceStatus() {
  return {
    piper: piperAvailable(),
    google: true,
    sapi: process.platform === 'win32',
    defaultEngine: piperAvailable() ? 'piper' : 'google',
    hindiVoice: piperAvailable() ? PIPER_MODELS.hi.label : 'Google Hindi (female)'
  };
}

/**
 * Speak text. Returns { audio: Buffer, mime, engine } or throws.
 * engine: 'auto' | 'piper' | 'google' | 'sapi' | 'browser'
 */
export async function speak(text, { lang = 'en', engine = 'auto', rate = '+0%', voiceId = '' } = {}) {
  const spoken = speechReady(text, 700, lang);
  if (!spoken) throw new Error('Nothing to speak');
  const chosen = String(voiceId || '');

  const known = ['auto', 'piper', 'google', 'sapi', 'browser'];
  const wanted = known.includes(engine) ? engine : 'auto';
  const order =
    wanted !== 'auto'
      ? [wanted]
      : [piperAvailable() ? 'piper' : null, 'google', process.platform === 'win32' ? 'sapi' : null].filter(Boolean);

  if (wanted === 'browser') return { browser: true, text: spoken };

  let lastErr = null;
  for (const candidate of order) {
    const key = cacheKey(spoken, `${lang}|${chosen}`, candidate);
    const cached = cacheGet(key);
    if (cached) return { ...cached, engine: candidate, text: spoken };

    try {
      if (candidate === 'piper') {
        const pickedLang = chosen.startsWith('piper:') ? chosen.split(':')[1] : lang;
        const model = piperVoiceFile(pickedLang === 'hi' ? 'hi' : 'en') || piperVoiceFile(lang);
        if (!model) throw new Error('piper voice for this language is not installed');
        const pct = Number(String(rate).replace('%', '')) || 0;
        // A touch slower than default reads warmer, less like an announcement. Hindi
        // needs a bit more room still or the conjunctions slur together.
        const base = lang === 'hi' ? 1.09 : 1.04;
        const lengthScale = Math.min(2, Math.max(0.6, base / (1 + pct / 100)));
        const audio = await runPiper(spoken, model, { lengthScale });
        cachePut(key, audio, 'audio/wav');
        return { audio, mime: 'audio/wav', engine: candidate, text: spoken };
      }
      if (candidate === 'google') {
        const audio = await googleTts(spoken, lang);
        cachePut(key, audio, 'audio/mpeg');
        return { audio, mime: 'audio/mpeg', engine: candidate, text: spoken };
      }
      if (candidate === 'sapi') {
        const audio = await sapiTts(spoken, lang, chosen, rate);
        cachePut(key, audio, 'audio/wav');
        return { audio, mime: 'audio/wav', engine: candidate, text: spoken };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No speech engine available');
}
