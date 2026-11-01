// She can look at your screen and tell you what is wrong.
//
// Seeing needs a vision model, and there are only two honest ways to get one here:
//   1. a local vision model in Ollama  (gemma3:4b is already on this laptop and can read
//      images, plus llava / moondream / qwen2.5vl if you download one)
//   2. the cloud brain, if you pasted a key and the provider can see images
// With neither, she says she cannot see rather than inventing what is on your screen.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { runPowerShell } from './ps.js';

// smallest-good-first: a small model answers in a couple of seconds, a 7B+ one takes much longer
const LOCAL_VISION_PREFERENCE = [
  'qwen2.5vl:3b',
  'gemma3:4b',
  'gemma3:latest',
  'moondream',
  'llava:7b',
  'llava',
  'minicpm-v',
  'llama3.2-vision',
  'llama3.2-vision:11b'
];

let cachedLocal = null;
let cachedAt = 0;

// the cloud brain is created once in server.js; vision needs the same instance
let cloudRef = null;
export function setVisionCloud(cloud) {
  cloudRef = cloud || null;
}

/** Which local vision model, if any, is installed. Cached for a minute. */
export async function localVisionModel(cfg, { force = false } = {}) {
  if (!force && cachedLocal !== null && Date.now() - cachedAt < 60_000) return cachedLocal;
  cachedAt = Date.now();
  cachedLocal = null;
  try {
    const res = await fetch(`${(cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    for (const wanted of LOCAL_VISION_PREFERENCE) {
      const hit = names.find((n) => n === wanted || n.startsWith(`${wanted}`));
      if (hit) {
        cachedLocal = hit;
        return hit;
      }
    }
  } catch {
    /* ollama not running */
  }
  return null;
}

/** What can see right now — used by the UI so the button is honest. */
export async function visionStatus({ cfg, cloud }) {
  const local = await localVisionModel(cfg);
  const cloudReady = Boolean(cfg.cloud?.enabled && cfg.cloud?.apiKey);
  return {
    // Gemini / OpenAI / OpenRouter models can see; Groq's Llama 3.3 cannot
    cloud: cloudReady ? cfg.cloud.provider !== 'groq' : false,
    cloudProvider: cloudReady ? cfg.cloud.provider : '',
    local: Boolean(local),
    localModel: local || ''
  };
}

/** One JPEG of the whole desktop, base64 (no data: prefix). */
export async function captureScreen() {
  const dir = path.join(DATA_DIR, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const name = `screen-${Date.now()}.jpg`;
  const file = path.join(dir, name);
  const target = file.replace(/\\/g, '/').replace(/'/g, "''");
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    # shrink to something a model can chew on: 1400px wide is enough to read text
    $scale = [Math]::Min(1.0, 1100.0 / $bmp.Width)
    $w = [int]($bmp.Width * $scale)
    $h = [int]($bmp.Height * $scale)
    $small = New-Object System.Drawing.Bitmap($w, $h)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.DrawImage($bmp, 0, 0, $w, $h)
    # plain JPEG writer: the encoder-parameter route trips Windows Defender's script scanner
    $small.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()`;
  const r = await runPowerShell(script, { timeout: 25000 });
  if (!fs.existsSync(file)) {
    throw new Error(`Could not capture the screen. ${String(r.stderr || '').slice(0, 200)}`);
  }
  return { base64: fs.readFileSync(file).toString('base64'), name };
}

const prompt = (question, language) => `You are FRIDAY, looking at a screenshot of the user's Windows screen.
The user asked: "${question}"

Answer what is actually visible. If there is an error, a dialog, or a problem, say what it is and
what to click or type to fix it. Be concrete and short: 2-4 sentences, no preamble, no lists unless
the steps need them. If the screenshot does not show anything relevant, say that plainly.
${language === 'hi' ? 'Reply in Devanagari Hindi.' : 'Reply in English (or Hinglish if the question was Hinglish).'}`;

function stripDataUrl(image) {
  const raw = String(image || '');
  const comma = raw.indexOf(',');
  return raw.startsWith('data:') && comma > -1 ? raw.slice(comma + 1) : raw;
}

/**
 * Answer a question about a picture of the screen.
 * @returns {{ok: boolean, text: string, engine: string, model?: string, ms: number, hint?: string}}
 */
export async function lookAtImage({ image, question, cfg, cloud }) {
  cloud = cloud || cloudRef;
  const started = Date.now();
  const base64 = stripDataUrl(image);
  if (!base64 || base64.length < 200) {
    return { ok: false, text: '', engine: 'none', ms: 0, hint: 'No image arrived.' };
  }
  const hindi = /[\u0900-\u097F]/.test(question || '');
  const ask = prompt(String(question || 'What is on my screen?'), hindi ? 'hi' : 'en');

  // 1. the cloud brain sees best, if it is on and the provider supports images
  let cloudError = '';
  const cloudReady = Boolean(cfg.cloud?.enabled && cfg.cloud?.apiKey) && cfg.cloud?.provider !== 'groq';
  if (cloudReady && cloud) {
    try {
      const text = await cloud.chat([
        { role: 'system', content: 'You are FRIDAY, a concise assistant who answers about screenshots.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: ask },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
          ]
        }
      ]);
      if (text) return { ok: true, text, engine: 'cloud', model: cfg.cloud.model, ms: Date.now() - started };
    } catch (err) {
      // fall through to the local model instead of failing the turn
      cloudError = String(err.message || err).slice(0, 160);
    }
  }

  // 2. a local vision model
  const model = await localVisionModel(cfg, { force: true });
  if (model) {
    const startedLocal = Date.now();
    try {
      const res = await fetch(`${(cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: cfg.keepAlive || '30m',
          messages: [{ role: 'user', content: ask, images: [base64] }],
          options: { temperature: 0.2, num_predict: 200, num_ctx: 4096 }
        }),
        signal: AbortSignal.timeout(180000)
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = String(data.message?.content || '').trim();
      if (text) {
        return { ok: true, text, engine: 'local', model, ms: Date.now() - started, took: Date.now() - startedLocal };
      }
      throw new Error('the vision model returned nothing');
    } catch (err) {
      return {
        ok: false,
        text: '',
        engine: 'local',
        model,
        ms: Date.now() - started,
        hint: `The local vision model could not read the screen: ${String(err.message || err).slice(0, 160)}`
      };
    }
  }

  return {
    ok: false,
    text: '',
    engine: 'none',
    ms: Date.now() - started,
    hint:
      (cloudError ? `Cloud vision failed: ${cloudError}. ` : '') +
      'No vision model is available. Either add a free Gemini key in Settings, or download one with:  ollama pull gemma3:4b'
  };
}

/** Voice path: grab the screen, then look at it. */
export async function lookAtScreen({ question, cfg, cloud }) {
  cloud = cloud || cloudRef;
  let shot;
  try {
    shot = await captureScreen();
  } catch (err) {
    return { ok: false, text: '', engine: 'none', ms: 0, hint: err.message, media: null };
  }
  const out = await lookAtImage({ image: shot.base64, question, cfg, cloud });
  return { ...out, media: { type: 'image', url: `/media/${shot.name}`, path: path.join(DATA_DIR, 'media', shot.name) } };
}
