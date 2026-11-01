// Hindi replies, done properly.
//
// The local 3B writes beautiful English and invents words when it writes Hindi.
// So for a Hindi turn she answers in English, and this turns that answer into Hindi
// with a free translation service (no key, no account). The "female assistant"
// framing is what makes the translator use feminine first-person grammar.

const GTX = 'https://translate.googleapis.com/translate_a/single';
const CLIENTS5 = 'https://clients5.google.com/translate_a/t';
const MYMEMORY = 'https://api.mymemory.translated.net/get';

/** Common masculine first-person forms the translator picks without a gender cue. */
const FEMININE = [
  ['रहा हूं', 'रही हूं'],
  ['रहा हूँ', 'रही हूँ'],
  ['रहा हू', 'रही हू'],
  ['सकता हूं', 'सकती हूं'],
  ['सकता हूँ', 'सकती हूँ'],
  ['सकता हू', 'सकती हू'],
  ['चुका हूं', 'चुकी हूं'],
  ['चुका हूँ', 'चुकी हूँ'],
  ['करता हूं', 'करती हूं'],
  ['करता हूँ', 'करती हूँ'],
  ['करने वाला', 'करने वाली'],
  ['करूंगा', 'करूंगी'],
  ['करूँगा', 'करूँगी'],
  ['हूंगा', 'हूंगी'],
  ['हूँगा', 'हूँगी'],
  ['दूंगा', 'दूंगी'],
  ['दूँगा', 'दूँगी'],
  ['लूंगा', 'लूंगी'],
  ['लूँगा', 'लूँगी'],
  ['रहा था', 'रही थी'],
  ['मैं अच्छा हूं', 'मैं ठीक हूं'],
  ['मैं अच्छा हूँ', 'मैं ठीक हूँ']
];

function feminize(text) {
  let out = text;
  for (const [from, to] of FEMININE) out = out.split(from).join(to);
  // the translator's own quirks for temperature words
  return out.replace(/सेल्युलर|सेल्सीयस|सेल्सीअस/g, 'सेल्सियस');
}

/** Words that begin a clause — if one runs into the previous word, the space was lost. */
const STARTERS = [
  'मैं', 'मुझे', 'मेरा', 'मेरी', 'आप', 'आपका', 'आपकी', 'तुम', 'तुम्हारा', 'हम', 'हमें',
  'यह', 'ये', 'वह', 'वो', 'और', 'लेकिन', 'पर', 'तो', 'अभी', 'आज', 'कल', 'हाँ', 'नहीं',
  'बहुत', 'थोड़ा', 'क्या', 'कैसे', 'क्यों', 'कहाँ', 'कोई', 'कुछ', 'सब', 'ठीक', 'अच्छा',
  'ज़रूर', 'फिर', 'बस', 'लगता', 'चलो', 'देखो', 'सुनो', 'बताओ'
];

/**
 * The translator returns the answer in chunks and the space at a chunk join goes
 * missing — "नमस्तेमैं फ्रिडा हूं". Put the space back where a word can only start.
 */
function respace(text) {
  // Only after a word-final mark (matra, anusvara, visarga, virama): that keeps
  // "यहाँ" in one piece while still fixing "नमस्तेमैं".
  const re = new RegExp(`([\\u093E-\\u094D\\u0902\\u0903])(?=(?:${STARTERS.join('|')})(?![\\u0900-\\u097F]))`, 'gu');
  return String(text).replace(re, '$1 ').replace(/\s{2,}/g, ' ').trim();
}

/** Drop the "FRIDAY, a female assistant, says:" scaffolding Google adds. */
function stripPrefix(text) {
  let out = String(text || '').trim();
  const colon = out.indexOf(':');
  if (colon !== -1 && colon < 90) out = out.slice(colon + 1);
  else out = out.replace(/^(?:फ्राइडे|FRIDAY)?[^:]{0,60}?कहती है[:\s]*/i, '');
  return out
    .trim()
    .replace(/^["“'‘]+/, '')
    .replace(/["”'’]+$/, '')
    .trim();
}

/** Same sentence asked twice in a chat should not cost a second request. */
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function remember(key, text) {
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- providers -------------------------------- */

async function viaGtx(source, timeout, to = 'hi') {
  const framed = to === 'hi' ? `Frida, a female assistant, says: ${source}` : source;
  const url = `${GTX}?client=gtx&sl=${to === 'hi' ? 'en' : 'hi'}&tl=${to}&dt=t&q=${encodeURIComponent(framed)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`translate ${res.status}`);
  const data = await res.json();
  const joined = (data?.[0] || []).map((part) => part?.[0] || '').join('');
  return stripPrefix(joined);
}

async function viaClients5(source, timeout, to = 'hi') {
  const url = `${CLIENTS5}?client=dict-chrome-ex&sl=${to === 'hi' ? 'en' : 'hi'}&tl=${to}&q=${encodeURIComponent(source)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`translate (alt) ${res.status}`);
  const data = await res.json();
  // this endpoint answers as [["हिंदी", ...]] or ["हिंदी"]
  const flat = Array.isArray(data?.[0]) ? data[0].join('') : (data || []).join('');
  return stripPrefix(flat);
}

async function viaMyMemory(source, timeout, to = 'hi') {
  const url = `${MYMEMORY}?q=${encodeURIComponent(source.slice(0, 480))}&langpair=${to === 'hi' ? 'en|hi' : 'hi|en'}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`translate (memory) ${res.status}`);
  const data = await res.json();
  const out = data?.responseData?.translatedText || '';
  if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('translate (memory) gave nothing');
  return out;
}

/**
 * Hindi -> English. Used when a search query or a page is in Hindi and the web
 * engines do better with an English phrase.
 */
export async function toEnglish(text, { timeout = 4500 } = {}) {
  const source = String(text || '').trim();
  if (!source || !/[\u0900-\u097F]/.test(source)) return source;
  const providers = [viaGtx, viaClients5, viaGtx, viaMyMemory];
  for (const provider of providers) {
    try {
      const out = String(await provider(source, timeout, 'en')).trim();
      if (out && /[a-z]/i.test(out) && !/[\u0900-\u097F]/.test(out)) return out;
    } catch {
      /* try the next service */
    }
  }
  return source;
}

/**
 * English answer -> natural Hindi. Tries more than one free service, because a
 * single 429 used to send the whole reply through the 3B and come out as gibberish.
 * Throws when every service is unreachable so the caller can fall back.
 */
export async function toHindi(text, { timeout = 5000 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // "FRIDAY" is read as the weekday by the translator; "Frida" is read as her name.
  // "degrees Celsius" becomes "सेल्युलर" ("cellular") in Hindi, so the symbol travels instead.
  const source = raw
    .replace(/\bFRIDAY\b/gi, 'Frida')
    .replace(/(\d+(?:\.\d+)?)\s*(?:degrees?\s*)?Celsius\b/gi, '$1°C')
    .replace(/(\d+(?:\.\d+)?)\s*(?:degrees?\s*)?Fahrenheit\b/gi, '$1°F');

  const hit = cached(source);
  if (hit) return hit;

  const providers = [viaGtx, viaClients5, viaGtx, viaMyMemory];
  let lastErr = null;
  for (const provider of providers) {
    try {
      const out = String(await provider(source, timeout)).trim();
      if (!out || !/[\u0900-\u097F]/.test(out)) throw new Error('not Hindi');
      const fixed = feminize(
        respace(out.replace(/फ्रिडा|फ़्रिडा|फ्राइडा|फ़्राइडा|फ्रीडा|फ़्रीडा|फराइडा|फ्राइडे|फ़्राइडे/g, 'फ्राइडे'))
      );
      remember(source, fixed);
      return fixed;
    } catch (err) {
      lastErr = err;
      // a rate limit clears in a moment; anything else, move on to the next service
      await sleep(/429|502|503/.test(String(err.message)) ? 350 : 60);
    }
  }
  throw lastErr || new Error('no translation service reachable');
}
