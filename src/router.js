// Deterministic routing for the plain, unambiguous questions people actually ask.
// A 3B model on a laptop guesses these ~50% of the time and guesses the numbers too.
// Matching them here makes the answer instant, always correct, and free of invented numbers.
// Everything else still goes to the model + tools.

import os from 'node:os';
import path from 'node:path';
import { findSitesInText, findAppsInText, siteForAppName } from './apps.js';

const STATUS_WORDS =
  /\b(battery|charge|power|ram|memory|cpu|processor|disk|storage|drive space|space left|uptime)\b|बैटरी|चार्ज|रैम|मेमोरी|सीपीयू|प्रोसेसर|डिस्क|स्टोरेज|अपटाइम/i;

// "temperature" alone means the weather. Only treat it as a PC question when the
// sentence is actually about the machine, otherwise "Delhi ka temperature" got
// answered with the battery percentage.
const THERMAL_WORDS =
  /\b(temperature|temp|heat|heating|hot|fan|thermal)\b|तापमान|गर्म|फैन/i;
const MACHINE_WORDS =
  /\b(laptop|pc|computer|system|cpu|processor|gpu|machine|windows|fan)\b|लैपटॉप|कंप्यूटर|सिस्टम|मशीन/i;

const ACTION_WORDS =
  /\b(open|close|start|launch|kill|clean|clear|delete|remove|free up|increase|install|uninstall|open karo|kholo|khol do|band karo|banao|bana do|clean karo)\b|खोलो|बंद\s?करो|साफ|डिलीट|हटाओ|बनाओ|क्लियर/i;

const TIME_WORDS =
  /\b(what('?s| is) the (time|date)|time (hai|h|is it)|kitne baje|kitna baja|kitna time|time kya|samay kya|tarikh|date today|what day|today'?s date|din kya|aaj kaun sa din)\b|(क्या\s*समय|समय\s*क्या|टाइम\s*क्या|कितना\s*समय)|कितने बजे|तारीख|आज कौन\s?सा दिन|दिनांक/i;

const LISTING_WORDS =
  /\b(kya hai|kya h|kya-kya|what'?s in|whats in|what is in|list|dikhao|dikha do|batao|show me|contents?)\b|क्या है|क्या\s?क्या|दिखाओ|बताओ|लिस्ट/i;

const FOLDERS = [
  [/\b(downloads?|download folder)\b|डाउनलोड/i, 'Downloads'],
  [/\b(desktop)\b|डेस्कटॉप/i, 'Desktop'],
  [/\b(documents?|docs)\b|डॉक्युमेंट|दस्तावेज़/i, 'Documents'],
  [/\b(pictures?|photos?|images?)\b|फोटो|तस्वीर/i, 'Pictures'],
  [/\b(music|songs?)\b|संगीत|गाने/i, 'Music'],
  [/\b(videos?|movies?)\b|वीडियो|मूवी/i, 'Videos'],
  [/\bhome folder\b|होम फोल्डर/i, '.']
];

/** Resolve "downloads" / "D drive" / an explicit path to a real directory. */
function resolveFolder(text) {
  const drive = text.match(/\b([a-z])(?::|\s+drive\b)(?:\\|\/)?/i);
  if (drive) return `${drive[1].toUpperCase()}:\\`;

  for (const [re, name] of FOLDERS) {
    if (re.test(text)) {
      const home = os.homedir();
      return name === '.' ? home : path.join(home, name);
    }
  }
  return null;
}

const APP_NAMES = [
  ['notepad', /notepad|नोटपैड/i],
  ['chrome', /chrome|क्रोम/i],
  ['word', /\bword\b|एमएस\s?वर्ड/i],
  ['excel', /excel|एक्सेल/i],
  ['paint', /\bpaint\b|पेंट/i],
  ['calculator', /calculator|calc\b|कैलकुलेटर/i],
  ['explorer', /file explorer|explorer|फ़ाइल एक्सप्लोरर/i],
  ['cmd', /command prompt|\bcmd\b|terminal/i]
];

/** "open notepad and type hello world" -> [open_app, type_text] without asking the model. */
function routeOpenAndType(text) {
  const t = String(text || '');
  const openWord = /\b(open|launch|start|khol\w*)\b|खोलो|खोल\s?दो|चालू/i.test(t);
  const typeWord = /\b(type|write|likh\w*|enter)\b|लिखो|टाइप/i.test(t);
  if (!typeWord) return null;

  let app = null;
  for (const [name, re] of APP_NAMES) {
    if (re.test(t)) {
      app = name;
      break;
    }
  }
  if (!app) return null;

  const quoted = t.match(/["“'‘]([^"”'’]{1,120})["”'’]/);
  let payload = quoted ? quoted[1] : '';
  if (!payload) {
    const after = t.match(/(?:type|write|likh\w*|लिखो|टाइप)\s+(?:in\s+|mein\s+|me\s+)?(.{1,120})$/i);
    payload = after ? after[1] : '';
    payload = payload
      .replace(/^(?:into|in|mein|me)\s+(?:the\s+)?(?:notepad|word|chrome|paint|excel|नोटपैड)\s*/i, '')
      .replace(/^(?:करो|कर\s?दो|likho|लिखो|type|टाइप)\s+/i, '')
      .replace(/\s*(?:notepad|नोटपैड)?\s*(?:में|me|mein)?\s*$/i, '')
      .replace(/\b(please|karo|kar do|करो|कर\s?दो)\b[\s.!?]*$/i, '')
      .trim();
  }
  if (!payload) return null;

  // "type X into notepad" with the app already open: just type
  if (!openWord) return [{ name: 'type_text', args: { text: payload } }];

  return [
    { name: 'open_app', args: { name: app } },
    { name: 'type_text', args: { text: payload } }
  ];
}

/* "gmail kholo", "open instagram", "youtube aur drive khol do" -> open_url / open_app.
   Opening things is the most common voice command after the time, and a 3B model
   picks the wrong tool or invents an app name often enough to be annoying. Deciding
   it here makes it instant and predictable. */
const OPEN_VERB =
  /\b(open|launch|khol\w*|khol\s?do|chala\s?do|chalao|chalu\s?karo)\b|खोलो|खोल\s?दो|ओपन|चालू\s?करो/i;

const SITE_WORD = /\b(website|web\s?site|site|web|online|browser)\b|वेबसाइट|वेब|ब्राउज़र/i;

// Anything that means "a file on disk" is left to the model, which can search for it.
const FILE_ISH =
  /[\\/:*?"<>|]|\.(pdf|docx?|xlsx?|pptx?|txt|png|jpe?g|mp4|mp3|zip|csv|md|exe)\b|\b(folders?|files?|downloads?|desktop|documents?|pictures?|videos?|music)\b|फ़ाइल|फोल्डर|डाउनलोड/i;

const FILLER =
  /\b(open|launch|kholo|khol|do|karo|kar|dedo|de|please|plz|mujhe|mera|meri|zara|thoda|abhi|ek|koi|naam|se|app|application|the|a|an|my|me|for|in|chalao|chala)\b/gi;

/** "open minecraft please" -> "minecraft", when it is not something on disk. */
function openTargetName(text) {
  if (FILE_ISH.test(text)) return null;
  const words = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(FILLER, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (!words.length || words.length > 3) return null;
  return words.slice(0, 3).join(' ');
}

/** Steps that open apps/websites, in the order the user named them. */
export function routeOpenCommand(text) {
  const t = String(text || '');
  if (!OPEN_VERB.test(t)) return null;

  const wantsWeb = SITE_WORD.test(t);
  const appHits = findAppsInText(t);
  // "open google chrome": the site "google" is inside the app name, so drop it
  const siteHits = findSitesInText(t).filter(
    (s) => !appHits.some((a) => a.at <= s.at && a.at + a.len >= s.at + s.len)
  );

  const steps = [];
  const seen = new Set();

  for (const hit of siteHits) {
    if (seen.has(hit.def.url)) continue;
    seen.add(hit.def.url);
    steps.push({ at: hit.at, name: 'open_url', args: { url: hit.def.url }, label: hit.def.name });
  }

  for (const hit of appHits) {
    const def = hit.def;
    const site = siteForAppName(def.name);
    if (wantsWeb && site) {
      if (!seen.has(site.url)) {
        seen.add(site.url);
        steps.push({ at: hit.at, name: 'open_url', args: { url: site.url }, label: site.name });
      }
      continue;
    }
    steps.push({ at: hit.at, name: 'open_app', args: { name: def.name }, label: def.label });
  }

  if (!steps.length) {
    // not in the catalog, but it may still be installed: "open minecraft"
    const name = openTargetName(t);
    if (!name) return null;
    return [{ name: 'open_app', args: { name }, label: name }];
  }

  // a site already opens in Chrome, so "chrome mein gmail kholo" is one step, not two
  const opensSite = steps.some((s) => s.name === 'open_url');
  const useful = steps.filter((s) => !(opensSite && s.name === 'open_app' && s.args.name === 'chrome'));

  return useful
    .sort((a, b) => a.at - b.at)
    .slice(0, 3)
    .map((s) => ({ name: s.name, args: s.args, label: s.label }));
}

/* "screen pe kya hai", "what is wrong on my screen" -> look_at_screen.
   Deterministic, because a 3B model will happily describe a screen it never looked at. */
function routeScreenLook(text) {
  const t = String(text || '');
  if (!/\b(screen|display|monitor)\b|स्क्रीन/i.test(t)) return null;
  const asks =
    /\b(kya|what|problem|error|issue|wrong|dekho|dekha|dikha|help|samajh|batao|read|see)\b|क्या|देखो|देख|दिखा|समस्या|गलती|मदद|समझ|बताओ/i.test(t);
  if (!asks) return null;
  // "take a screenshot" is a different job, handled by the screenshot tool
  const asksAboutContent = /\b(kya|what|problem|error|issue|wrong)\b|क्या|गलती|समस्या|दिक्कत/i.test(t);
  if (/\b(screenshot|screen shot)\b|स्क्रीनशॉट/i.test(t) && !asksAboutContent) return null;
  return [{ name: 'look_at_screen', args: { question: t } }];
}

/* Things that change by the hour: weather, news, prices, scores. Her model memory of
   these is always out of date, so they get looked up on the web instead of guessed. */
const LIVE_WORDS =
  /\b(weather|forecast|raining|rain|humidity|aqi|air quality|news|headlines|breaking|stock price|share price|price of|gold rate|silver rate|petrol|diesel|exchange rate|scorecard|cricket score|ipl|match result|who won|trending|mausam|barish|barsaat|khabar|samachar|taja samachar|kimat|keemat|bhav)\b|मौसम|बारिश|तापमान|नमी|समाचार|खबर|सोने का भाव|चांदी|पेट्रोल|डीज़ल|कीमत|भाव|स्कोर|मैच|क्रिकेट|ताज़ा/i;

/** "Friday, mujhe batao what's the weather in Delhi yaar?" -> "weather in Delhi today" */
function liveQuery(text) {
  let q = String(text || '')
    .replace(/\b(hey|hi|friday|please|plz|tell me|can you|could you|what'?s|what is|whats|how'?s|how is|give me|show me|do you know|any idea)\b/gi, ' ')
    .replace(/मुझे|बताओ|बता\s?दो|ज़रा|जरा|क्या\s?है|कैसा\s?है|कैसी\s?है|फ्राइडे|फ़्राइडे/gu, ' ')
    .replace(/[?!.।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) q = String(text || '').trim();
  if (/weather|forecast|temperature|rain|aqi|मौसम|बारिश|तापमान/i.test(text) && !/\b(today|now|tonight|tomorrow|aaj|abhi)\b|आज|अभी/i.test(q)) {
    q += ' today';
  }
  return q.slice(0, 140);
}

/**
 * @returns {Array<{name: string, args: object}> | null} tools to run directly, bypassing the model.
 */
export function routeQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const chain = routeOpenAndType(t);
  if (chain) return chain;

  const open = routeOpenCommand(t);
  if (open) return open;

  const screen = routeScreenLook(t);
  if (screen) return screen;

  if (TIME_WORDS.test(t) && !/\b(set|remind|alarm|timer)\b|सेट|अलार्म/i.test(t)) {
    return [{ name: 'get_time', args: {} }];
  }

  if (STATUS_WORDS.test(t) && !ACTION_WORDS.test(t)) {
    return [{ name: 'system_status', args: {} }];
  }

  // CPU heat is a PC question; the weather is not.
  if (THERMAL_WORDS.test(t) && MACHINE_WORDS.test(t) && !ACTION_WORDS.test(t)) {
    return [{ name: 'system_status', args: {} }];
  }

  if (LISTING_WORDS.test(t)) {
    const dir = resolveFolder(t);
    if (dir) return [{ name: 'list_dir', args: { path: dir } }];
  }

  if (LIVE_WORDS.test(t) && !ACTION_WORDS.test(t)) {
    return [{ name: 'web_answer', args: { query: liveQuery(t) }, label: 'the web' }];
  }

  return null;
}

/* Hindi typed in Latin letters ("battery kitni hai") is still Hindi. She should answer it
   in Hindi, not in half-and-half Hinglish — which is what the small model writes. */
const HINGLISH =
  /\b(hai|hain|kya|kyu|kyun|koi|kuch|batao|bata\s?do|karo|kar\s?do|mujhe|mera|meri|tum|tumhara|tumhari|aap|aapka|aapki|kaisa|kaisi|kaise|nahi|nahin|haan|achha|accha|chahiye|kab|kahan|kal|aaj|abhi|dekho|suno|bolo|kholo|band|kitna|kitni|mausam|thoda|zara|sunao|lagao|bajao|chalao|bhej\w*|samajh|matlab|jaldi|raha|rahi|hoga|hua|hui|gaya|gayi|dena|dedo|lelo|pasand|kaam|karna|karne|sakta|sakti|bolti|bolta)\b/i;

/** Devanagari or Hinglish — either way the user is speaking Hindi. */
export function wantsHindi(text) {
  const t = String(text || '');
  return /[\u0900-\u097F]/.test(t) || HINGLISH.test(t);
}

const hasHindi = (t) => wantsHindi(t);

const SMALL_TALK =
  /\b(joke|chutkula|funny|kya haal|kaise ho|how are you|who are you|tum kaun|good morning|good night|thanks|thank you|shukriya|love you|bore ho raha)\b|जोक|चुटकुला|कैसे हो|क्या हाल|कौन हो|धन्यवाद|शुक्रिया|गुड मॉर्निंग|गुड नाइट/i;

/** Pure conversation: no tool can help, so do not offer any. */
export function isSmallTalk(text) {
  const t = String(text || '');
  if (!SMALL_TALK.test(t)) return false;
  return !STATUS_WORDS.test(t) && !TIME_WORDS.test(t) && !LISTING_WORDS.test(t) && !ACTION_WORDS.test(t);
}

function hindiTime(date) {
  // "रविवार, 1 नवंबर को 10:21 pm बजे है" is how a form letter talks, not a person.
  const weekday = date.toLocaleDateString('hi-IN', { weekday: 'long' });
  const day = date.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long' });
  const h24 = date.getHours();
  const part = h24 < 4 ? 'रात' : h24 < 12 ? 'सुबह' : h24 < 16 ? 'दोपहर' : h24 < 20 ? 'शाम' : 'रात';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mins = date.getMinutes();
  const clock = mins === 0 ? `${h12}` : `${h12}:${String(mins).padStart(2, '0')}`;
  return `अभी ${weekday}, ${day} — ${part} ${clock} बजे हैं।`;
}

function englishTime(date) {
  const s = date.toLocaleString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  return `It's ${s}.`;
}

/**
 * Build the final sentence locally for the queries people ask most.
 * Deterministic, so the numbers are always the ones the PC reported and the
 * grammar is correct even on a 3B model. Returns null when it cannot do better
 * than the model.
 */
export function directAnswer(userText, toolName, result, args = {}) {
  const hi = hasHindi(userText);
  if (!result || result.ok === false) return null;

  if (toolName === 'get_time') return hi ? hindiTime(new Date()) : englishTime(new Date());

  if (toolName === 'system_status' && result.data) {
    const d = result.data;
    const t = String(userText).toLowerCase();
    const wants = (re) => re.test(t);
    const ramUsed = d.totalRamGB != null && d.freeRamGB != null ? (d.totalRamGB - d.freeRamGB).toFixed(1) : null;
    const disk = (d.disks || [])[0];
    const batt = d.battery;

    if (wants(/battery|charge|बैटरी|चार्ज/) && batt) {
      return hi
        ? `बैटरी ${batt.percent}% है${batt.charging ? ' और चार्ज हो रही है' : ''}।`
        : `Battery is at ${batt.percent}%${batt.charging ? ' and charging' : ''}.`;
    }
    if (wants(/ram|memory|रैम|मेमोरी/) && ramUsed) {
      return hi
        ? `रैम में से ${ramUsed} GB इस्तेमाल हो रहा है, ${d.freeRamGB} GB खाली है।`
        : `${ramUsed} of ${d.totalRamGB} GB RAM is in use, ${d.freeRamGB} GB free.`;
    }
    if (wants(/cpu|processor|सीपीयू|प्रोसेसर/) && d.cpuPercent != null) {
      return hi ? `CPU लोड ${d.cpuPercent}% है।` : `CPU load is ${d.cpuPercent}%.`;
    }
    if (wants(/disk|storage|drive|space|डिस्क|स्टोरेज/) && disk) {
      return hi
        ? `डिस्क ${disk.name} में ${disk.freeGB} GB खाली है।`
        : `Disk ${disk.name} has ${disk.freeGB} GB free.`;
    }
    if (wants(/uptime|chal|चालू|uptime/) && d.uptimeHours != null) {
      return hi ? `लैपटॉप ${d.uptimeHours} घंटे से चालू है।` : `The PC has been on for ${d.uptimeHours} hours.`;
    }

    // no specific ask: give the two things people usually mean
    if (batt && ramUsed) {
      return hi
        ? `बैटरी ${batt.percent}% है, रैम में ${d.freeRamGB} GB खाली है।`
        : `Battery ${batt.percent}%, ${d.freeRamGB} GB RAM free.`;
    }
    if (batt) return hi ? `बैटरी ${batt.percent}% है।` : `Battery ${batt.percent}%.`;
    if (ramUsed) return hi ? `रैम में ${d.freeRamGB} GB खाली है।` : `${d.freeRamGB} GB RAM free.`;
    return null;
  }

  if (toolName === 'look_at_screen') {
    // the vision model already answered in the right language; do not paraphrase it
    const seen = result.data?.text;
    return seen ? String(seen).replace(/\*\*/g, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim() : null;
  }

  if (toolName === 'open_url' || toolName === 'open_app') {
    const label = result.data?.label || result.data?.app || args.url || args.name || '';
    if (result.ok) {
      if (!hi) return String(result.summary || `Opened ${label}.`);
      return result.data?.browser === 'chrome'
        ? `${label} Chrome में खुल गया है।`
        : `${label} खुल गया है।`;
    }
    return hi ? `माफ़ कीजिए, ${label || 'वह'} नहीं खुल पाया।` : String(result.summary || 'Could not open that.');
  }

  if (toolName === 'list_dir') {
    const lines = String(result.summary || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('[dir]') || l.startsWith('[file]'));
    const folder = String(args.path || '').split(/[\\/]/).filter(Boolean).pop() || 'folder';
    if (!lines.length) {
      return hi ? `${folder} खाली है।` : `${folder} is empty.`;
    }
    const names = lines.slice(0, 6).map((l) => l.replace(/^\[(dir|file)\]\s*/, '').replace(/ \(.*\)$/, ''));
    const more = lines.length > names.length ? (hi ? ` और ${lines.length - names.length} चीज़ें` : ` and ${lines.length - names.length} more`) : '';
    // the tool caps its listing, so 60 entries means "at least 60"
    const count = lines.length >= 60 ? (hi ? '60 से ज़्यादा' : 'more than 60') : lines.length;
    return hi
      ? `${folder} में ${count} चीज़ें हैं — ${names.join(', ')}${more}।`
      : `${folder} has ${count} items — ${names.join(', ')}${more}.`;
  }

  return null;
}

/** One short, language-matched sentence describing a tool result. Used to phrase routed answers. */
export function phraseRequest(userText, toolName, summary) {
  const hindi = /[\u0900-\u097F]/.test(userText);
  if (hindi) {
    // she will be translated to Hindi afterwards; warm spoken English translates best
    return `ENGLISH ONLY — Latin letters, no Hindi, no Devanagari, not one word.\n\nYou just looked this up for the user. Their question: "${userText}".\nWhat you found:\n${summary}\n\nAnswer out loud the way a friend would: one or two short sentences of simple, warm English. Lead with the actual answer — the temperature, the price, the score, the headline. Keep RAM, GB, %, CPU, battery, °C as they are. No lists, no extra stats, no invented numbers, and never mention searching, results, tools or JSON.`;
  }
  return `You just looked this up for the user. Their question: "${userText}".\nWhat you found:\n${summary}\n\nAnswer out loud the way a friend would: one or two short spoken sentences, in English (or Hinglish if they wrote Hinglish). Lead with the actual answer — the temperature, the price, the score, the headline. Skip anything irrelevant. No lists, no extra stats. Never invent a number, and never mention searching, results, the tool or JSON.`;
}
