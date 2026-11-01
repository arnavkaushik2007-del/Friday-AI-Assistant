# FRIDAY

A local, bilingual (हिंदी + English) voice assistant that actually operates your Windows PC.
Free forever — no subscription, no account, no mandatory API key. Her brain runs on your laptop;
if you want ChatGPT-level knowledge you can *optionally* paste a free-tier key (section 4).

Talk to her in Hindi, English, or mixed Hinglish. She answers out loud in a female voice and
does the work: opens apps, finds files, takes screenshots, sets reminders, controls volume,
checks battery, runs commands, and asks your permission before anything risky.

## What this project is

FRIDAY is a self-hosted Windows assistant built with Node.js. The browser interface provides
chat, microphone input, approvals, settings, and phone access. A local Ollama model handles
conversation and tool selection, while a direct command router makes common tasks fast and
predictable. The server exposes a token-protected HTTP interface on the local network, so a
phone can use the same assistant without installing a separate app.

The project is designed to be local-first:

- The model, conversation history, reminders, and assistant memory are stored on the PC.
- Windows actions are implemented as explicit tools with permission checks.
- Cloud LLM providers are optional and disabled by default.
- Generated configuration, downloaded models, logs, recordings, screenshots, and browser data
  are intentionally ignored by Git.

## Requirements

- Windows 10 or later
- Node.js 20.11 or later
- Chrome or Edge for microphone input
- Approximately 2 GB for the default local model, plus space for the optional voice engine

No database, administrator account, or paid subscription is required.

## Install from a clone

```powershell
npm install
npm run setup
```

`npm run setup` downloads the portable local runtime, the default model, and the offline Hindi
and English voices. It does not install a system service. After setup, start the assistant with:

```powershell
npm start
```

Alternatively, double-click `Start FRIDAY.bat`. On first launch, FRIDAY creates
`friday.config.json` with a random access token and creates private runtime state under `data/`.
Those files are local-only and must not be committed.

---

## 1. Start her

Double-click **`Start FRIDAY.bat`**. That is the whole install ritual:

- the assistant starts **in the background** (no black console window),
- her **app window** opens — no tabs, no address bar, just FRIDAY,
- and she keeps running after you close or minimise that window? No — the window *is* her ears.
  Keep it open (minimised is fine); she keeps listening and working. Quit from ⚙ → **Quit FRIDAY**
  when you actually want her gone.

Running it twice is safe: it reuses the server that is already up and just opens the window again.
Prefer a terminal? `npm start` still works and prints the plain localhost link.

There is also a **FRIDAY icon on your Desktop**. Double-click it any time — if she is already
running it just brings her window up, and if she is not, it starts her. The icon is generated
by the project (`npm run shortcut`), so delete it by mistake or move the folder and you can
recreate it with that one command.

If the brain isn't installed yet, the app shows a **Download brain** button — it fetches
~2 GB once and then works offline forever. (Or run `npm run setup` if you prefer the terminal.)

## 2. Talk to her (no button pressing)

She listens all the time by default. Just talk:

- **"बैटरी कितनी है?"** → answered out loud in under a second.
- **Say "FRIDAY" first** if you switch to wake-word mode (⚙ → Listening). Only speech after the
  wake word is acted on, so TV chatter and other people are ignored.
- **Always mode** (default) — every sentence is treated as yours. Best when you're alone with
  the PC; switch to wake word when you're not.
- **She never hears herself**: while her voice is playing, incoming audio is ignored, so she
  can't answer her own reply.
- **Hands-free approvals** — when she asks permission, just say **"haan"** or **"nahi"**.
- **Mic button** — pauses/resumes the ears. **Space+Shift** works too.

Listening uses the browser's built-in speech recognition, so it needs **internet** (the same free
service Chrome/Edge already use). Her brain, voice and files stay local.

Other controls:

- **Type** — the box at the bottom, Enter to send.
- **Mic language tag** (`auto` / `हिंदी` / `english`) — tap to cycle if she mis-hears you.
- **Speaker button** — mute or unmute her voice.
- **Skills** — everything she can do, listed by category.
- **⚙** — your name, model, voice engine, **listening mode**, **Start with Windows**, which
  folders she may touch, and **Quit FRIDAY**.

Try:
- "Chrome kholo aur YouTube pe lofi laga do"
- "Screenshot le ke dikhao"
- "Aaj ki battery kitni hai?"
- "Remind me at 6 pm to call mom"
- "Downloads folder mein jo PDF hain unki list banao"
- "Volume 30 kar do"

## 3. Her voice (free, female, both languages)

| Engine | What it is | When it's used |
|---|---|---|
| **Piper** | Offline neural voice, ~0.3 s per reply. Hindi female = *Priyamvada*, English = *Amy* | default, installed by setup |
| **Google TTS** | Free online voice | fallback if Piper is missing |
| **Windows SAPI** | Built-in OS voices | last resort, quality varies |
| **Browser** | Your phone's own voice | on iPhone if the PC is unreachable |

Pick one in ⚙ → Voice engine. Piper is the fast one and needs no internet.

## 4. Give her a big brain (free, optional)

Out of the box she thinks with a small model on your laptop: great at commands, thin on general
knowledge. You can give her **ChatGPT-level knowledge for ₹0** by pasting a free-tier API key:

1. Open **⚙ Settings → Big brain**, pick a provider:
   - **Google Gemini** — free tier, no card. *Recommended.* Get the key at
     [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   - **Groq** — free tier, very fast Llama 70B: [console.groq.com/keys](https://console.groq.com/keys)
   - **OpenRouter** — pick any model ending in `:free`: [openrouter.ai/keys](https://openrouter.ai/keys)
   - **OpenAI** — the actual ChatGPT models, but this one costs money
   - **Custom** — point it at LM Studio / vLLM / another PC on your wifi
2. Paste the key, press **Connect & test**. She calls the provider and shows you the real model
   list, so you can see it works before trusting it.
3. Tick **Use the big brain** and save.

What changes: her general knowledge, reasoning and Hindi all jump a level, and she picks tools
far more reliably. What does not change: the fast paths (time, battery, "gmail kholo") still
answer locally in milliseconds, and the PC tools are still hers.

Privacy and safety:

- The key is stored in `friday.config.json` on your PC and **never sent to the browser** — the
  settings screen only shows a mask like `AIza…9fQ2`.
- With the big brain on, your **message + the tool results she needs** go to that provider. Your
  files, screenshots and memory are not uploaded on their own.
- If the key is wrong, the free limit runs out or you have no internet, she **falls back to the
  local model for a minute** and keeps working, instead of erroring at you.
- Free tiers are rate limited (requests per minute). If you talk a lot, expect the occasional
  "free limit reached" and her local answers until it resets.

No key? Nothing breaks. She simply stays fully local and offline.

## 5. Your iPhone

iPhone Safari only allows the microphone on **https**, so:

```bash
npm run phone
```

That prints a free temporary `https://…` link with your access key inside it. Open it on the
phone (same wifi or mobile data), then **Share → Add to Home Screen**. Now she works from your
pocket exactly like on the PC — same brain, same files, same memory.

What iPhone access means here: you talk to the same assistant from your phone, check on your PC,
and have her do PC work from anywhere. iOS does **not** let any browser app read your iPhone's
files, messages or apps — Apple blocks that for everything except native apps. So "access my
iPhone" means control the PC from the iPhone, not hoover up iPhone data.

The plain `http://192.168.x.x:4173` link on your wifi also works for typing, just not for the mic.

## 6. What she can do on the PC

- **Apps** — "WhatsApp kholo", "insta open karo", "open vs code". She reads the list of apps
  actually installed on this PC, so Store apps and nicknames both work
- **Websites** — "gmail kholo", "open youtube", "open flipkart.com" — these open in **Chrome**,
  as many at once as you name ("open gmail aur youtube"). If a name is both an app and a site
  (whatsapp), say *"web"* to force the browser: "whatsapp web kholo"
- **Open, close, list running apps**
- **Files** — search, read, write, move, delete, make folders, zip (inside allowed folders)
- **Screen** — screenshot, type text, press keys, click, scroll, focus windows
- **Media** — play/pause, next/prev, volume, brightness
- **System** — CPU/RAM/disk, battery, wifi, top processes, kill a process, lock/sleep/restart
- **Power tools** — PowerShell command, open a URL, web search
- **Memory** — remember facts about you, recall them, reminders with spoken alerts
- **Time** — current date/time in your timezone

Dangerous ones (delete, kill, shutdown, arbitrary commands, typing into other windows) always
ask first. Press **Hamesha allow** if you never want to be asked about that one again.

## 7. Privacy and safety

- The model, the conversation history, your memory notes and files stay on this PC (`data/`).
- Nothing is sent anywhere except: model download (once), optional free Google TTS, and web
  search when you ask for it.
- The web UI is protected by a random token that lives in `friday.config.json`. Anyone on your
  wifi without the link cannot get in.
- `allowAllPaths` is **off** by default: she stays inside your home folder. Turn it on in ⚙ if
  you want her to reach other drives.
- `friday.config.json` and `data/` are gitignored — never share them.

## 8. Why she answers so fast

Two things make her feel instant, and both matter more than model size:

1. **Direct answers.** Battery, RAM, CPU, disk, time and folder listings are matched on your
   words and answered straight from the real reading — no model guesswork, so the numbers are
   never invented. Time and folder answers land in **12–70 ms**; battery/RAM in ~2–3 s (mostly
   PowerShell reading the hardware).
2. **A warm prompt cache.** Everything that changes per message rides inside your message, so
   the model reuses its cached prompt instead of re-reading ~1,600 tokens every turn. That alone
   took warm replies from 20–36 s down to 2–4 s.

Measured on this laptop (Ryzen 5 5600H + GTX 1650 4 GB, 16 GB RAM):

| | default `qwen2.5:3b-instruct` | `qwen2.5:7b-instruct` |
|---|---|---|
| battery / RAM / folder question | ~2.7 s / ~3 s / 20 ms | same (also direct) |
| time | 14 ms | 14 ms |
| open app + type | ~3.5 s | ~6 s |
| small talk / advice | 2.5–5 s | 8–45 s |
| Hindi quality | understandable, sometimes rough | better grammar, still not native |
| fit | fully on the GPU, 36 tok/s | spills to CPU, 8 tok/s |

That is why the **3B is the default**: on a 4 GB card the 7B cannot fit, so it drops to 8 tok/s and
turns a joke into a 30 s wait. Switch in ⚙ → Brain model whenever you want better Hindi and can
wait. Everything (model, voice, context) stays warm for 2 h, so only the first reply after a
restart is slow.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Brain is waking up…" forever | `npm run setup`, or check `tools/ollama/ollama.exe` exists and port 11434 is free |
| No sound | Press the speaker button; in ⚙ try engine `Google`; check Windows volume mixer |
| Mic does nothing on iPhone | You're on `http://` — run `npm run phone` and use the https link |
| Mic does nothing on PC | Allow microphone for `localhost` in the browser's site settings |
| She answers in the wrong language | She mirrors your last message's script, and a check rewrites the reply if the script slipped; the mic language tag also matters |
| "Mic is not picking up audio" | Windows → Sound → Input: choose the right microphone and raise its level, then press the mic button again |
| She listens but nothing happens | Check ⚙ → Listening is not **Off**, and that the app window is open (it holds the microphone) |
| A command did nothing but she said it worked | Ask again plainly ("notepad kholo aur likho hi"); the direct path handles open+type without the model |
| Port already in use | `node server.js --port 4174` |
| She refuses a folder | Add it under ⚙ → Allowed folders, or enable whole-disk access |

Logs appear in the terminal window that runs her.

## 10. Honest limits

- Without a cloud key she is a 3B model on a laptop, not a datacenter model. Short commands and
  the direct answers are solid; long reasoning chains, open-ended advice and polished Hindi prose
  are not her strength — "कोई जोक सुनाओ" can come out clumsy. That is exactly what section 4
  fixes, for free.
- With the big brain on, answers depend on your internet, your provider's free limits, and their
  uptime. She is designed to degrade to the local model rather than stop working.
- No local model of this size is a reliable tool-chooser on its own, which is why the common
  commands are routed directly instead of left to her judgement.
- She can't read your iPhone's data or control iOS apps — Apple doesn't allow it.
- She can't send WhatsApp/iMessage messages for you without extra automation; she can open the
  app and put the text on your clipboard.
- The browser asks for the microphone **once** per browser profile (click "Enable always-on" the
  first time). After that she listens without any press. Recognition itself uses Chrome's free
  service, so listening needs internet; her brain and voice do not.
- The `npm run phone` link is a free public tunnel: keep the window open, and stop it when done.

## 11. Files

```
server.js              starts everything, prints your links
public/                the UI (chat, mic, approvals, settings)
src/brain.js           personality, planning, tool loop, permission gate
src/router.js          direct answers (battery, time, folders, open+type, open app/site) — the fast path
src/tools.js           everything she can do on Windows
src/apps.js            finds installed apps by name and opens sites in Chrome
src/cloud.js           optional big brain: Gemini / Groq / OpenRouter / OpenAI / custom
scripts/desktop-icon.js  draws assets/friday.ico + puts the shortcut on your Desktop
assets/friday.ico      her icon (16 to 256 px)
src/tts.js             voices (Piper / Google / SAPI / browser)
src/runtime.js         starts the local brain, downloads the model
src/config.js          settings + access token
scripts/app.ps1        starts her in the background + opens the app window
src/autostart.js       "Start with Windows" shortcut (no admin needed)
scripts/setup.ps1      one-time install
scripts/phone.js       free https link for the iPhone
scripts/selftest.js    checks tools, voice, brain
```
