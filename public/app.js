// FRIDAY front-end: chat, streaming, voice in/out, approvals, reminders.

const $ = (id) => document.getElementById(id);

const el = {
  chat: $('chat'),
  input: $('input'),
  send: $('btn-send'),
  mic: $('btn-mic'),
  lang: $('btn-lang'),
  speakBtn: $('btn-speak'),
  webBtn: $('btn-web'),
  toolsBtn: $('btn-tools'),
  shareBtn: $('btn-share'),
  settingsBtn: $('btn-settings'),
  subtitle: $('subtitle'),
  core: $('core'),
  thinking: $('thinking'),
  thinkingText: $('thinking-text'),
  approval: $('approval'),
  approvalTitle: $('approval-title'),
  approvalDesc: $('approval-desc'),
  approvalPreview: $('approval-preview'),
  approveYes: $('approve-yes'),
  approveNo: $('approve-no'),
  approveAlways: $('approve-always'),
  settings: $('settings'),
  tools: $('tools'),
  toolsBody: $('tools-body'),
  toast: $('toast'),
  earsBar: $('ears-bar'),
  earsEnable: $('ears-enable'),
  listenHint: $('listen-hint')
};

const state = {
  voiceOn: true,
  engine: 'auto',
  voiceId: '',
  lang: 'auto', // mic language
  busy: false,
  approvalId: null,
  pendingApproval: null,
  lastLang: 'en',
  webOn: true
};

/* ------------------------------- helpers -------------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(text) {
  let html = esc(text);
  html = html.replace(/```[\s\S]*?```/g, (block) => `<code>${block.replace(/```\w*/g, '').replace(/```/g, '').trim()}</code>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return html;
}

function atBottom() {
  return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 140;
}

function scrollDown(force = false) {
  requestAnimationFrame(() => {
    el.chat.scrollTop = el.chat.scrollHeight;
  });
}

function toast(message, ms = 3200) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addUser(text) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.textContent = text;
  el.chat.appendChild(d);
  scrollDown();
}

/** A small speaker on every reply: hear it again without typing anything. */
function addSayAgain(node, text, lang) {
  node.classList.add('friday');
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'say-again';
  again.title = 'Say that again';
  again.setAttribute('aria-label', 'Say that again');
  again.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  again.onclick = () => speak(text, lang, state.voiceId, { force: true });
  node.appendChild(again);
}

function addFriday(text, { speakIt = true, lang } = {}) {
  const d = document.createElement('div');
  d.className = 'msg friday';
  d.innerHTML = md(text);
  const detected = lang || (/[\u0900-\u097F]/.test(text) ? 'hi' : 'en');
  state.lastLang = detected;

  addSayAgain(d, text, detected);

  const stamp = document.createElement('span');
  stamp.className = 'stamp';
  stamp.textContent = nowLabel();
  d.appendChild(stamp);
  el.chat.appendChild(d);
  scrollDown();
  if (speakIt) speak(text, detected);
  return d;
}

function addSystem(text) {
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.textContent = text;
  el.chat.appendChild(d);
  scrollDown();
}

// Tool names mean nothing to a person. Say what she actually did instead.
const TOOL_LABELS = {
  system_status: 'Checked your laptop',
  get_time: 'Checked the time',
  web_search: 'Searched the web',
  browse_web: 'Read a page',
  open_app: 'Opened an app',
  open_url: 'Opened a link',
  close_app: 'Closed an app',
  screenshot: 'Took a screenshot',
  look_at_screen: 'Looked at your screen',
  type_text: 'Typed for you',
  press_keys: 'Pressed keys',
  clipboard: 'Used the clipboard',
  media_control: 'Controlled media',
  set_reminder: 'Set a reminder',
  remember: 'Saved that for later',
  recall: 'Checked her memory',
  notify: 'Sent a notification',
  list_dir: 'Looked in a folder',
  read_file: 'Read a file',
  write_file: 'Saved a file',
  search_files: 'Searched your files'
};

function addTool(name, ok, summary, media) {
  const label = TOOL_LABELS[name] || String(name || '').replace(/_/g, ' ');
  const text = String(summary || '').trim();
  const firstLine = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  const d = document.createElement('div');
  d.className = `tool${ok ? '' : ' fail'}`;
  d.innerHTML = `<span class="ticon" aria-hidden="true"></span>
    <div class="tbody">
      <span class="tname">${esc(ok ? label : `Couldn't ${label.charAt(0).toLowerCase()}${label.slice(1)}`)}</span>
      <span class="tsum">${esc(firstLine.slice(0, 260))}</span>
      <div class="tdetail"></div>
    </div>`;
  const detail = d.querySelector('.tdetail');
  detail.textContent = text.slice(0, 2000);
  if (text.length > 80) {
    d.classList.add('expandable');
    d.tabIndex = 0;
    const toggle = () => d.classList.toggle('open');
    d.addEventListener('click', toggle);
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
  if (media && media.type === 'image') {
    const img = document.createElement('img');
    img.src = media.url;
    img.alt = 'screenshot';
    img.loading = 'lazy';
    d.querySelector('.tbody').appendChild(img);
  }
  el.chat.appendChild(d);
  scrollDown();
}

/** The first screen: a greeting and a few things to try, instead of an empty box. */
function renderWelcome(name = 'boss') {
  const chipList = [
    "What's the weather in Delhi today?",
    'How much battery is left?',
    'Open WhatsApp',
    'मेरी स्क्रीन देखो — क्या गड़बड़ है?',
    'Remind me at 5 to call mom',
    'Koi achhi si joke sunao'
  ];
  const box = document.createElement('div');
  box.className = 'welcome';
  box.innerHTML = `<div class="welcome-orb" aria-hidden="true"></div>
    <h2>Hi ${esc(name)} — batao, kya karna hai?</h2>
    <p>I'm right here on this laptop. I can open apps, hunt through your files, look things up online, and read your screen if you share it.</p>
    <p>Hindi ya English — jo bhi comfortable ho. The mic stays open, so just talk.</p>
    <div class="suggestions"></div>`;
  const list = box.querySelector('.suggestions');
  for (const prompt of chipList) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion';
    chip.textContent = prompt;
    chip.onclick = () => {
      el.input.value = prompt;
      autoGrow();
      send();
    };
    list.appendChild(chip);
  }
  el.chat.appendChild(box);
  scrollDown();
}

/** Header line in plain human words, not a machine label. */
function renderStatus() {
  if (!el.subtitle) return;
  let text;
  if (state.busy) text = 'Soch rahi hoon…';
  else if (speaking) text = 'Bol rahi hoon…';
  else if (listening) text = 'Sun rahi hoon — boliye';
  else if (wantListening) text = 'Reconnecting the mic…';
  else if (micBlocked) text = 'Mic blocked — allow it in the browser';
  else if (listenMode() === 'off') text = 'Ready — type or tap the mic';
  else text = 'Ready — bolo ya likho';
  el.subtitle.textContent = text;
}

function renderListenHint() {
  if (!el.listenHint) return;
  const show = listening && wantListening && !state.busy && !speaking;
  el.listenHint.classList.toggle('hidden', !show);
}

function setThinking(on, label = 'soch rahi hoon…') {
  el.thinkingText.textContent = label;
  el.thinking.classList.toggle('hidden', !on);
  el.core.classList.toggle('busy', on);
  if (on) scrollDown();
  renderStatus();
  renderListenHint();
}

/* --------------------------------- voice -------------------------------- */

const audio = new Audio();
audio.preload = 'auto';
let currentUrl = null;
// While she is talking we must not treat her own voice as your voice.
let speaking = false;
let ignoreUntil = 0;

audio.addEventListener('playing', () => {
  speaking = true;
  renderStatus();
  renderListenHint();
  renderStopTalk();
});
for (const ev of ['ended', 'pause']) {
  audio.addEventListener(ev, () => {
    speaking = false;
    ignoreUntil = Date.now() + 400;
    renderStatus();
    renderListenHint();
    renderStopTalk();
  });
}

/** While she is talking, a quiet "stop" sits above the composer. */
function renderStopTalk() {
  const btn = $('btn-stop-talk');
  if (btn) btn.classList.toggle('hidden', !speaking);
}

function stopAudio() {
  speaking = false;
  ignoreUntil = Date.now() + 300;
  renderStatus();
  renderListenHint();
  renderStopTalk();
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {}
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function browserSpeak(text, lang) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  const want = lang === 'hi' ? /hi/i : /en/i;
  const voices = window.speechSynthesis.getVoices();
  const pick =
    voices.find((v) => want.test(v.lang) && /female|zira|neerja|swara|kalpana|heera/i.test(v.name)) ||
    voices.find((v) => want.test(v.lang));
  if (pick) u.voice = pick;
  u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
  u.rate = 0.98;
  u.pitch = 1;
  u.onstart = () => {
    speaking = true;
    renderStatus();
    renderStopTalk();
  };
  u.onend = () => {
    speaking = false;
    ignoreUntil = Date.now() + 400;
    renderStatus();
    renderListenHint();
    renderStopTalk();
  };
  window.speechSynthesis.speak(u);
}

async function speak(text, lang = 'en', voiceId = state.voiceId, { force = false } = {}) {
  if ((!state.voiceOn && !force) || !String(text || '').trim()) return;
  stopAudio();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, engine: state.engine, voiceId })
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json();
      if (j.browser) browserSpeak(j.text || text, lang);
      return;
    }
    const blob = await res.blob();
    if (blob.size < 600) {
      browserSpeak(text, lang);
      return;
    }
    currentUrl = URL.createObjectURL(blob);
    audio.src = currentUrl;
    await audio.play().catch(() => {});
  } catch {
    browserSpeak(text, lang);
  }
}

/* --------------------------------- chat --------------------------------- */

/* ------------------------------ screen share ----------------------------- */

let shareStream = null;

/** One JPEG of the shared screen, small enough to send but readable. */
function grabFrame() {
  const video = $('share-video');
  if (!shareStream || !video || !video.videoWidth) return '';
  const scale = Math.min(1, 1100 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function stopShare() {
  if (shareStream) shareStream.getTracks().forEach((t) => t.stop());
  shareStream = null;
  const video = $('share-video');
  if (video) video.srcObject = null;
  $('share-preview').classList.add('hidden');
  el.shareBtn.classList.remove('on');
}

async function startShare() {
  if (shareStream) {
    stopShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('This browser cannot share a screen — Chrome or Edge can');
    return;
  }
  try {
    shareStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
  } catch {
    toast('Screen share cancelled');
    return;
  }
  const video = $('share-video');
  video.srcObject = shareStream;
  $('share-preview').classList.remove('hidden');
  el.shareBtn.classList.add('on');
  shareStream.getVideoTracks()[0].addEventListener('ended', stopShare);
  toast('Screen shared — now ask what is wrong');
}

async function streamChat(text, image = '') {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(image ? { text, image } : { text })
  });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const handle = (event, data) => {
    if (event === 'status') {
      setThinking(true, data.text === 'working' ? 'kaam kar rahi hoon…' : 'soch rahi hoon…');
    } else if (event === 'tool') {
      addTool(data.name, data.ok, data.summary, data.media);
    } else if (event === 'approval') {
      openApproval(data);
    } else if (event === 'approval_timeout') {
      closeApproval();
      addSystem('Permission request timed out.');
    } else if (event === 'answer') {
      addFriday(data.text, { lang: data.lang });
    } else if (event === 'error') {
      if (data.setup) showSetup(data.message);
      else addSystem(`Error: ${data.message}`);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          handle(event, JSON.parse(data));
        } catch {}
      }
      idx = buf.indexOf('\n\n');
    }
  }
}

async function send() {
  let text = el.input.value.trim();
  if (state.busy) return;
  let frame = grabFrame();
  // If user asks about screen/problem but not sharing, prompt to share or auto-share
  if (!frame && text) {
    const t = text.toLowerCase();
    if (/screen|dekho|देखो|problem|error|fix|kya hai|kya dikha|दिखा|समस्या/.test(t) || /screen share|share screen/.test(t)) {
      if (!shareStream && navigator.mediaDevices?.getDisplayMedia) {
        try {
          await startShare();
          await new Promise(r => setTimeout(r, 400));
          frame = grabFrame();
        } catch {}
      }
    }
  }
  if (!text && !frame) return;
  if (!text && frame) {
    const hindi = /^hi\b/i.test(navigator.language || '') || /[\u0900-\u097F]/.test(localStorage.getItem('friday.langPref') || '');
    text = hindi
      ? 'मेरी स्क्रीन पर क्या है? इसमें क्या गलती है या मुझे क्या करना चाहिए?'
      : "What's on my screen right now? Look at everything and tell me what's wrong or what I should do.";
  }
  stopAudio();
  el.input.value = '';
  el.input.style.height = 'auto';
  addUser(text);
  state.busy = true;
  setThinking(true);

  try {
    // if a screen is being shared, this message carries a picture of it
    if (frame) addSystem('screen attached', 'note');
    await streamChat(text, frame);
  } catch (err) {
    addSystem(`Could not reach the brain: ${err.message}`);
  } finally {
    state.busy = false;
    setThinking(false);
  }
}

/* ------------------------------- approvals ------------------------------ */

function openApproval(data) {
  state.approvalId = data.id;
  state.pendingApproval = data;
  el.approvalTitle.textContent = data.desc || `Run ${data.tool}?`;
  el.approvalDesc.textContent = data.risk === 'high'
    ? 'This one can change or delete things. Allow it?'
    : 'She needs your permission to do this.';
  el.approvalPreview.textContent = data.preview || `${data.tool}`;
  el.approval.classList.remove('hidden');
  const verb = /\bdelete|remove|format|kill|shutdown|restart/i.test(data.tool + ' ' + JSON.stringify(data.args || {}));
  el.approveYes.textContent = verb ? 'Haan, kar do' : 'Haan';
  el.approval.classList.toggle('danger', verb);
}

function closeApproval() {
  el.approval.classList.add('hidden');
  state.approvalId = null;
  state.pendingApproval = null;
}

async function answerApproval(allow, always = false) {
  const id = state.approvalId;
  const pendingMeta = state.pendingApproval;
  if (!id) return;
  closeApproval();
  try {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, allow, always, tool: pendingMeta?.tool })
    });
  } catch {}
  addSystem(allow ? `Allowed: ${pendingMeta?.tool}` : `Declined: ${pendingMeta?.tool}`);
}

/* ------------------------------ listening ------------------------------ */

// The listener: one continuous recognizer that restarts itself, so you never press the mic.
// Two modes - say "FRIDAY" first, or just talk. She never reacts to her own voice.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recogLangId = null;
let listening = false;
let wantListening = false;
let restartTimer = null;
let restartDelay = 500;
let micBlocked = false;
let lastHeard = '';
let startedAt = 0;
let rapidEnds = 0;

const LANGS = [
  { id: 'auto', sr: 'hi-IN', label: 'auto' },
  { id: 'hi', sr: 'hi-IN', label: 'हिंदी' },
  { id: 'en', sr: 'en-IN', label: 'english' }
];

const WAKE_RE = /(?:\bhey\s+)?\bfriday\b|\bफ्राइडे\b|\bफ़्राइडे\b|\bफराइडे\b|फ्राइडे/i;

function micLang() {
  return LANGS.find((l) => l.id === state.lang) || LANGS[0];
}

function listenMode() {
  return localStorage.getItem('friday.listen') || 'always';
}

function setListenMode(mode) {
  localStorage.setItem('friday.listen', mode);
  if (mode === 'off') {
    stopListening();
    el.earsBar?.classList.add('hidden');
    toast('Always-on listening off');
    return;
  }
  if (localStorage.getItem('friday.mic') !== '1') {
    showEarsPrompt();
    return;
  }
  startListening({ quiet: true });
}

function showEarsPrompt() {
  el.earsBar?.classList.remove('hidden');
}

function renderListen() {
  el.mic.classList.toggle('listening', listening);
  el.mic.classList.toggle('armed', wantListening && !listening);
  document.body.classList.toggle('ears-on', wantListening);
  const mode = listenMode();
  el.mic.title =
    mode === 'off'
      ? 'Start listening'
      : listening
        ? 'Listening — click to stop'
        : wantListening
          ? 'Reconnecting…'
          : 'Start listening';
  renderStatus();
  renderListenHint();
}

function ensureRecog() {
  if (!SR) return null;
  const srLang = micLang().sr;
  if (recog && recogLangId === srLang) return recog;
  if (recog) {
    try {
      recog.onend = null;
      recog.abort();
    } catch {}
  }

  const r = new SR();
  recogLangId = srLang;
  r.lang = srLang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onstart = () => {
    listening = true;
    micBlocked = false;
    startedAt = Date.now();
    localStorage.setItem('friday.mic', '1');
    el.earsBar?.classList.add('hidden');
    renderListen();
  };

  r.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const res = event.results[i];
      if (res.isFinal) finalText += `${res[0].transcript} `;
      else interim += res[0].transcript;
    }
    if (interim && !speaking && !state.busy) {
      el.input.value = interim;
      autoGrow();
    }
    if (finalText.trim()) handleHeard(finalText.trim());
  };

  r.onerror = (e) => {
    listening = false;
    renderListen();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      micBlocked = true;
      wantListening = false;
      localStorage.removeItem('friday.mic');
      toast('Microphone blocked. Click the mic and allow it once for this app.', 6000);
      showEarsPrompt();
    } else if (e.error === 'audio-capture') {
      wantListening = false;
      toast('No microphone found.', 4000);
    } else if (e.error === 'network') {
      // speech recognition needs internet; retry gently instead of dying
      restartDelay = 4000;
      toast('Speech service unreachable — texting still works.', 4000);
    }
    if (e.error === 'no-speech' || e.error === 'aborted') restartDelay = 400;
  };

  r.onend = () => {
    listening = false;
    renderListen();
    if (!wantListening || micBlocked) return;

    // Chrome ends a session when it hears nothing for a while - that is normal and we simply
    // reconnect. But if it keeps dying almost immediately (no mic, driver trouble) back off
    // instead of hot-looping, and after a few tries stop and ask.
    const lived = Date.now() - startedAt;
    if (lived < 1200) {
      rapidEnds += 1;
      restartDelay = Math.min(restartDelay * 2, 8000);
      if (rapidEnds > 5) {
        wantListening = false;
        showEarsPrompt();
        toast('Mic is not picking up audio. Check Windows → Sound → Input, then try again.', 6000);
        renderListen();
        return;
      }
    } else {
      rapidEnds = 0;
      restartDelay = 400;
    }
    scheduleRestart(restartDelay);
  };

  recog = r;
  return r;
}

function scheduleRestart(ms) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!wantListening) return;
    restartDelay = 500;
    try {
      ensureRecog().start();
    } catch {
      scheduleRestart(1200);
    }
  }, ms);
}

function startListening({ quiet = false } = {}) {
  if (!SR) {
    if (!quiet) toast('Voice input needs Chrome or Edge.', 3500);
    return;
  }
  if (!window.isSecureContext) {
    if (!quiet) toast('The mic needs https here. Run "npm run phone" for a secure link.', 6000);
    return;
  }
  wantListening = true;
  const r = ensureRecog();
  if (!r) return;
  try {
    r.start();
  } catch {
    /* already running */
  }
  renderListen();
  if (!quiet) toast(listenMode() === 'wake' ? 'Sun rahi hoon — "FRIDAY" bolo.' : 'Sun rahi hoon…', 2200);
}

function stopListening() {
  wantListening = false;
  clearTimeout(restartTimer);
  try {
    recog?.stop();
  } catch {}
  listening = false;
  renderListen();
}

function restartListening() {
  clearTimeout(restartTimer);
  try {
    recog?.abort();
  } catch {}
  recog = null;
  if (wantListening) startListening({ quiet: true });
}

async function handleHeard(text) {
  let heard = String(text || '').trim();
  if (!heard || heard === lastHeard) return;
  if (speaking || Date.now() < ignoreUntil) return;
  if (heard.length < 2) return;
  lastHeard = heard;

  // hands-free approval: "haan" / "nahi" while the permission sheet is open
  if (state.approvalId) {
    if (/^(haan|han|haa|yes|yeah|ok|okay|allow|karo|kar do|हाँ|हां|हा)\b/i.test(heard)) {
      answerApproval(true, false);
      return;
    }
    if (/^(nahi|na|no|nope|stop|mat karo|नहीं|ना)\b/i.test(heard)) {
      answerApproval(false, false);
      return;
    }
  }

  const mode = listenMode();
  const wake = heard.match(WAKE_RE);

  if (mode === 'wake') {
    if (!wake) return; // not addressed to her
    heard = heard.replace(WAKE_RE, '').replace(/^[\s,.:!?-]+/, '').trim();
    if (!heard) {
      addSystem('Haan boss?');
      speak('Haan boss?', 'hi');
      return;
    }
  } else if (wake) {
    heard = heard.replace(WAKE_RE, '').replace(/^[\s,.:!?-]+/, '').trim() || heard;
  }

  if (state.busy) {
    addSystem(`Suni, par abhi kaam chal raha hai: ${heard}`);
    return;
  }

  el.input.value = heard;
  autoGrow();
  send();
}

function toggleMic() {
  if (wantListening) {
    stopListening();
    toast('Mic off. Press again to talk.');
    return;
  }
  if (localStorage.getItem('friday.mic') !== '1') {
    // first run: this click is the user gesture the browser wants
    showEarsPrompt();
  }
  startListening();
}

el.earsEnable?.addEventListener('click', () => {
  localStorage.setItem('friday.mic', '1');
  startListening();
  el.earsBar?.classList.add('hidden');
});

// Small hook so the listening pipeline can be exercised without a microphone
// (also handy from the console: __friday.heard("फ्राइडे बैटरी कितनी है"))
window.__friday = {
  heard: (text) => handleHeard(text),
  mode: () => listenMode(),
  setMode: (m) => setListenMode(m),
  state: () => ({ listening, wantListening, mode: listenMode(), mic: localStorage.getItem('friday.mic') }),
  // visual checks without wiping the saved chat
  welcome: (name) => renderWelcome(name),
  tool: (name, ok, summary) => addTool(name, ok, summary, null)
};

function bootListening() {
  if (listenMode() === 'off') return;
  if (localStorage.getItem('friday.mic') === '1') {
    // permission already granted once, so we may start without a click
    setTimeout(() => startListening({ quiet: true }), 600);
  } else {
    showEarsPrompt();
  }
}

/* -------------------------------- reminders ----------------------------- */

async function pollReminders() {
  try {
    const res = await fetch('/api/reminders/due');
    if (!res.ok) return;
    const { due } = await res.json();
    for (const r of due || []) {
      const line = `Reminder: ${r.text}`;
      addSystem(line);
      speak(r.text, /[\u0900-\u097F]/.test(r.text) ? 'hi' : 'en');
      toast(line, 6000);
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('FRIDAY', { body: r.text, icon: '/icon.svg' });
      }
    }
  } catch {}
}

/* -------------------------------- setup --------------------------------- */

let setupPoll = null;

function startSetupPolling() {
  if (setupPoll) return;
  setupPoll = setInterval(async () => {
    try {
      const res = await fetch('/api/brain/state');
      const brain = await res.json();
      if (brain.online && brain.hasModel) {
        clearInterval(setupPoll);
        setupPoll = null;
        document.querySelector('.setup')?.remove();
        el.subtitle.title = brain.model || '';
        el.core.classList.remove('off');
        el.core.classList.add('live');
        renderStatus();
        addSystem('Ready. Bolo ya likho.');
        loadState();
        return;
      }
      showSetup(brain.error, brain);
    } catch {}
  }, 2500);
}

function showSetup(message, brain = {}) {
  let panel = document.querySelector('.setup');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'setup';
    el.chat.appendChild(panel);
  }

  const online = Boolean(brain.online);
  const pull = brain.pull;
  let inner = '';

  if (pull && !pull.done) {
    inner = `<h3>Downloading the brain…</h3>
      <p>${esc(pull.status || 'working')}</p>
      <div class="bar"><i style="width:${Math.max(2, pull.percent || 0)}%"></i></div>
      <p>${pull.percent || 0}% · about 2 GB, one time. After this she works offline.</p>`;
  } else if (pull && pull.error) {
    inner = `<h3>Download failed</h3><p>${esc(pull.error)}</p>
      <div class="row"><button class="btn primary" data-act="pull">Try again</button></div>`;
  } else if (online && !brain.hasModel) {
    inner = `<h3>Almost ready</h3>
      <p>Ollama is running. One last step: download the model (about 2 GB, once, free).</p>
      <div class="row"><button class="btn primary" data-act="pull">Download brain</button></div>`;
  } else if (!brain.portable) {
    inner = `<h3>Brain not installed</h3>
      <p>${esc(message || 'The local model runtime is missing.')}</p>
      <p>One command sets it up — no account, no subscription:</p>
      <pre>npm run setup</pre>`;
  } else {
    inner = `<h3>Brain is waking up…</h3>
      <p>${esc(message || 'Starting the local model. This takes a few seconds the first time.')}</p>
      <div class="row"><button class="btn subtle" data-act="start">Start now</button></div>`;
  }

  const changed = panel.innerHTML !== inner;
  if (changed) panel.innerHTML = inner;
  if (changed || !panel.dataset.wired) {
    panel.dataset.wired = '1';
    panel.querySelector('[data-act="pull"]')?.addEventListener('click', async () => {
      panel.innerHTML = '<h3>Starting download…</h3><p>Connecting to the model library.</p>';
      try {
        const r = await fetch('/api/brain/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const j = await r.json();
        if (j.reason && !j.started) toast(j.reason);
      } catch {
        toast('Could not start the download');
      }
      startSetupPolling();
    });
    panel.querySelector('[data-act="start"]')?.addEventListener('click', async () => {
      try {
        await fetch('/api/brain/start', { method: 'POST' });
      } catch {}
      startSetupPolling();
    });
  }

  if (changed) scrollDown();
  startSetupPolling();
}

/* -------------------------------- state --------------------------------- */

async function loadState() {
  const res = await fetch('/api/state');
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const s = await res.json();
  const cfg = s.config || {};
  state.engine = cfg.voice?.engine || 'auto';
  state.voiceId = cfg.voice?.voiceId || '';
  state.voiceOn = cfg.voice?.enabled !== false;

  // header: plain words. The machine and model names live in the tooltip
  const online = Boolean(s.brain?.online);
  el.core.classList.toggle('off', !online);
  el.core.classList.toggle('live', Boolean(online) && !state.busy);
  el.subtitle.title = online ? `${s.host || 'this PC'} · ${cfg.model}` : '';
  if (online && s.brain?.hasModel) renderStatus();
  else el.subtitle.textContent = 'Waking up — one moment…';

  // voice button
  el.speakBtn.classList.toggle('on', state.voiceOn);

  // history
  el.chat.innerHTML = '';
  for (const turn of s.history || []) {
    const d = document.createElement('div');
    if (turn.role === 'user') {
      d.className = 'msg user';
      d.textContent = turn.text ?? turn.content ?? '';
    } else {
      const said = turn.text ?? turn.content ?? '';
      d.className = 'msg friday';
      d.innerHTML = md(said);
      addSayAgain(d, said, /[\u0900-\u097F]/.test(said) ? 'hi' : 'en');
    }
    el.chat.appendChild(d);
  }

  if (!online || !s.brain?.hasModel) showSetup(s.brain?.error, s.brain || {});
  else if (!(s.history || []).length) {
    renderWelcome(cfg.userName || 'boss');
    if (!sessionStorage.getItem('friday.greeted')) {
      sessionStorage.setItem('friday.greeted', '1');
      setTimeout(() => {
        if (state.voiceOn) speak('Hi boss, main ready hoon. Batao, kya karna hai?', 'hi');
      }, 600);
    }
  }

  // tools
  renderSkills(s.tools || []);

  // settings values
  $('set-name').value = cfg.userName || '';
  $('set-model').value = cfg.model || '';
  $('set-voice').value = cfg.voice?.engine || 'auto';
  if ($('set-voice-id')) $('set-voice-id').value = cfg.voice?.voiceId || '';
  $('set-speak').checked = state.voiceOn;
  $('set-allpaths').checked = Boolean(cfg.allowAllPaths);
  $('set-roots').value = (cfg.allowRoots || []).join('\n');
  const list = $('model-list');
  if (list) {
    list.innerHTML = (s.brain?.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  }
  // load available voices
  try {
    const vr = await fetch('/api/voices');
    if (vr.ok) {
      const v = await vr.json();
      const sel = $('set-voice-id');
      if (sel) {
        sel.innerHTML = '<option value="">Auto / default</option>';
        for (const p of ['piper', 'google', 'sapi']) {
          for (const item of v[p] || []) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.label;
            sel.appendChild(opt);
          }
        }
        sel.value = cfg.voice?.voiceId || '';
      }
    }
  } catch {}

  renderCloud(s.cloud);

  const listenSelect = $('set-listen');
  if (listenSelect) listenSelect.value = listenMode();
  const autoBox = $('set-autostart');
  if (autoBox) autoBox.checked = Boolean(s.autostart);

  $('voice-note').textContent = s.voice?.piper
    ? 'Piper installed — offline female Hindi + English voice.'
    : 'Piper not installed; a free online voice or your OS voice will be used.';
  scrollDown(true);
  return s;
}

function renderSkills(tools) {
  const groups = [
    { match: ['open_app', 'close_app', 'list_apps'], title: 'Apps' },
    { match: ['search_files', 'read_file', 'write_file', 'list_dir', 'move_file', 'delete_file', 'make_folder', 'zip_folder'], title: 'Files' },
    { match: ['screenshot', 'clipboard', 'type_text', 'press_keys', 'mouse_click', 'scroll', 'focus_window', 'list_windows'], title: 'Screen & keyboard' },
    { match: ['media_control', 'volume', 'brightness'], title: 'Media & sound' },
    { match: ['system_status', 'battery', 'wifi', 'processes', 'kill_process', 'power'], title: 'System' },
    { match: ['run_powershell', 'open_url', 'web_search'], title: 'Power tools' },
    { match: ['set_reminder', 'list_reminders', 'remember', 'recall', 'get_time', 'notify'], title: 'Memory & time' }
  ];
  const used = new Set();
  let html = '';
  for (const g of groups) {
    const items = tools.filter((t) => g.match.includes(t.name));
    if (!items.length) continue;
    items.forEach((t) => used.add(t.name));
    html += `<div><h3 style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5d6f8c;margin:0 0 8px;font-weight:600">${g.title}</h3>`;
    html += `<div style="display:flex;flex-direction:column;gap:6px">`;
    for (const t of items) {
      const high = t.risk === 'high';
      html += `<div class="skill batch${high ? ' high' : ''}"><h3>${esc(t.name)}</h3><p>${high ? 'asks first' : 'free'}</p></div>`;
    }
    html += '</div></div>';
  }
  const rest = tools.filter((t) => !used.has(t.name));
  if (rest.length) {
    html += `<div><h3 style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5d6f8c;margin:0 0 8px;font-weight:600">More</h3><div style="display:flex;flex-direction:column;gap:6px">`;
    for (const t of rest) {
      html += `<div class="skill batch${t.risk === 'high' ? ' high' : ''}"><h3>${esc(t.name)}</h3><p>${t.risk === 'high' ? 'asks first' : 'free'}</p></div>`;
    }
    html += '</div></div>';
  }
  el.toolsBody.innerHTML = html || '<p class="fineprint">No tools loaded.</p>';
}

/* ------------------------------- settings ------------------------------- */

/** Fill the big-brain controls from /api/state (the key itself never comes back). */
function renderCloud(cloud) {
  if (!cloud) return;
  const provider = $('set-cloud-provider');
  const key = $('set-cloud-key');
  const model = $('set-cloud-model');
  const base = $('set-cloud-base');
  const on = $('set-cloud-on');
  if (!provider) return;

  provider.value = cloud.provider || 'gemini';
  base.style.display = provider.value === 'custom' ? '' : 'none';
  if (cloud.enabled && cloud.hasKey) on.checked = true;
  if (cloud.model) model.value = cloud.model;
  if (cloud.baseUrl) base.value = cloud.baseUrl;
  key.placeholder = cloud.hasKey ? `saved (${cloud.keyMask}) — paste a new one to replace` : 'paste your API key';

  $('cloud-key-link').href = cloud.keyUrl || 'https://aistudio.google.com/apikey';

  const active = on.checked && cloud.hasKey;
  const status = active
    ? cloud.online === false
      ? `key saved but not reachable: ${cloud.error || 'no connection'}`
      : `${cloud.label || provider.value} · ${model.value} is her brain.`
    : 'No key yet — she thinks with the local model. Add a free key and she gets ChatGPT-level knowledge.';
  $('cloud-note').textContent = `${status}${cloud.note ? ` ${cloud.note}` : ''}`;
  if (active) el.subtitle.title = `${model.value} (cloud)`;
}

/** "Connect & test" — proves the key works, then shows the real model list. */
async function testCloud() {
  const note = $('cloud-note');
  const btn = $('btn-cloud-test');
  btn.disabled = true;
  note.textContent = 'testing the key…';
  try {
    const res = await fetch('/api/cloud/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('set-cloud-provider').value,
        model: $('set-cloud-model').value.trim(),
        baseUrl: $('set-cloud-base').value.trim(),
        apiKey: $('set-cloud-key').value.trim()
      })
    });
    const out = await res.json();
    if (!out.ok) {
      note.textContent = `Not connected: ${out.error}`;
      toast('Cloud brain not connected');
      return;
    }
    const list = $('cloud-model-list');
    if (list) list.innerHTML = (out.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    note.textContent = `Connected to ${out.provider} · ${out.model} · ${out.ms} ms · ${(out.models || []).length} models available.`;
    toast('Cloud brain connected');
  } catch (err) {
    note.textContent = `Not connected: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const body = {
    userName: $('set-name').value.trim() || 'boss',
    model: $('set-model').value.trim() || undefined,
    voice: { engine: $('set-voice').value, enabled: $('set-speak').checked, voiceId: $('set-voice-id')?.value || '' },
    allowAllPaths: $('set-allpaths').checked,
    allowRoots: $('set-roots').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    cloud: {
      enabled: $('set-cloud-on').checked,
      provider: $('set-cloud-provider').value,
      model: $('set-cloud-model').value.trim(),
      baseUrl: $('set-cloud-base').value.trim(),
      // an empty box means "keep the key that is already saved"
      apiKey: $('set-cloud-key').value.trim() || undefined
    }
  };
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    toast('Could not save settings');
    return;
  }
  const { config, cloud } = await res.json();
  if (cloud) {
    $('set-cloud-key').value = '';
    renderCloud(cloud);
  }
  state.engine = config.voice?.engine || 'auto';
  state.voiceId = config.voice?.voiceId || '';
  state.voiceOn = config.voice?.enabled !== false;
  el.speakBtn.classList.toggle('on', state.voiceOn);

  // listening lives in this app window, so it is stored locally
  const mode = $('set-listen')?.value || 'wake';
  if (mode !== listenMode()) setListenMode(mode);

  // start-with-Windows is a real shortcut on this PC
  const autoBox = $('set-autostart');
  if (autoBox) {
    try {
      const r = await fetch('/api/autostart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: autoBox.checked })
      });
      const out = await r.json();
      if (!out.ok) {
        toast(`Autostart not changed: ${out.reason || 'failed'}`);
        autoBox.checked = !autoBox.checked;
      }
    } catch {
      toast('Could not change autostart');
    }
  }

  closeDrawers();
  toast(mode === 'always' || mode === 'wake' ? 'Saved — she is listening' : 'Saved');
  await loadState();
}

/* -------------------------------- wiring -------------------------------- */

function closeDrawers() {
  el.settings.classList.add('hidden');
  el.tools.classList.add('hidden');
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 132)}px`;
}

el.send.onclick = send;
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
el.input.addEventListener('input', autoGrow);

el.mic.onclick = toggleMic;

el.lang.onclick = () => {
  const i = LANGS.findIndex((l) => l.id === state.lang);
  state.lang = LANGS[(i + 1) % LANGS.length].id;
  el.lang.textContent = micLang().label;
  if (wantListening) restartListening();
  toast(`Mic language: ${micLang().label}`);
};

el.speakBtn.onclick = () => {
  state.voiceOn = !state.voiceOn;
  el.speakBtn.classList.toggle('on', state.voiceOn);
  el.speakBtn.setAttribute('aria-pressed', String(state.voiceOn));
  if (!state.voiceOn) stopAudio();
  else speak('Voice on.', 'en');
};

if (el.webBtn) {
  el.webBtn.onclick = () => {
    state.webOn = !state.webOn;
    el.webBtn.classList.toggle('on', state.webOn);
    el.webBtn.setAttribute('aria-pressed', String(state.webOn));
    toast(state.webOn ? 'Web search enabled' : 'Web search disabled');
  };
}

el.shareBtn.onclick = startShare;
$('share-stop').onclick = stopShare;
$('btn-stop-talk').onclick = stopAudio;

el.toolsBtn.onclick = () => {
  el.settings.classList.add('hidden');
  el.tools.classList.toggle('hidden');
};

el.settingsBtn.onclick = () => {
  el.tools.classList.add('hidden');
  el.settings.classList.toggle('hidden');
};

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.onclick = () => closeDrawers();
});

$('settings-save').onclick = saveSettings;

const cloudTestBtn = $('btn-cloud-test');
if (cloudTestBtn) cloudTestBtn.onclick = testCloud;

const voiceTestBtn = $('btn-voice-test');
if (voiceTestBtn) {
  voiceTestBtn.onclick = async () => {
    const chosen = $('set-voice-id')?.value || '';
    const prevEngine = state.engine;
    state.engine = $('set-voice').value || 'auto';
    voiceTestBtn.disabled = true;
    voiceTestBtn.textContent = 'Testing…';
    try {
      const lang = chosen.startsWith('piper:hi') || !chosen ? 'hi' : 'en';
      await speak('Namaste boss, main FRIDAY hoon. Aap kaise hain?', lang, chosen);
      toast('That is how I sound');
    } catch (e) {
      toast('Voice test failed');
    } finally {
      voiceTestBtn.disabled = false;
      voiceTestBtn.textContent = 'Test voice';
      state.engine = prevEngine;
    }
  };
}

// picking a provider updates the hint + the "where to get a key" link immediately
const cloudProvider = $('set-cloud-provider');
if (cloudProvider) {
  cloudProvider.onchange = () => {
    const links = {
      gemini: 'https://aistudio.google.com/apikey',
      groq: 'https://console.groq.com/keys',
      openrouter: 'https://openrouter.ai/keys',
      openai: 'https://platform.openai.com/api-keys',
      custom: ''
    };
    const href = links[cloudProvider.value];
    const link = $('cloud-key-link');
    if (link) {
      link.href = href || '#';
      link.style.display = href ? '' : 'none';
    }
    const custom = cloudProvider.value === 'custom';
    $('set-cloud-base').style.display = custom ? '' : 'none';
    $('cloud-note').textContent = custom
      ? 'Point this at any server that speaks /v1/chat/completions (LM Studio, vLLM, another PC).'
      : 'Press “Connect & test” after pasting the key.';
  };
}

const quitBtn = $('quit-app');
if (quitBtn) {
  quitBtn.onclick = async () => {
    if (!confirm('Stop FRIDAY? She stays offline until you start her again.')) return;
    try {
      await fetch('/api/quit', { method: 'POST' });
    } catch {}
    stopListening();
    stopAudio();
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;font:15px system-ui;color:#8fa3bf;background:#05070d;text-align:center;padding:24px">FRIDAY is off.<br><span style="font-size:12px;color:#5d6f8c">Start her again with Start FRIDAY.bat</span></div>';
    setTimeout(() => window.close(), 400);
  };
}

$('clear-history').onclick = async () => {
  if (!confirm('Clear the whole chat history?')) return;
  await fetch('/api/history', { method: 'DELETE' });
  el.chat.innerHTML = '';
  addSystem('History cleared.');
  closeDrawers();
};

el.approveYes.onclick = () => answerApproval(true, false);
el.approveNo.onclick = () => answerApproval(false, false);
el.approveAlways.onclick = () => answerApproval(true, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.approvalId) answerApproval(false);
    closeDrawers();
    stopAudio();
  }
  // hold space when not typing to talk
  if (e.code === 'Space' && e.shiftKey && document.activeElement !== el.input) {
    e.preventDefault();
    toggleMic();
  }
});

// pause speech when the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAudio();
});

// keep the phone screen from sleeping while she talks is overkill; skip.

(async function boot() {
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      Notification.requestPermission();
    } catch {}
  }
  try {
    await loadState();
  } catch (err) {
    el.subtitle.textContent = 'cannot reach FRIDAY';
    addSystem(`Connection failed: ${err.message}`);
  }
  setInterval(pollReminders, 30000);
  pollReminders();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  // ears on: keep listening without ever pressing the mic
  bootListening();
})();
