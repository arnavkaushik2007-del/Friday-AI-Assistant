// The agent loop: think -> call tool (approve if risky) -> answer.
import crypto from 'node:crypto';
import { getTool, toolSchemas, needsApproval } from './tools.js';
import { routeQuery, phraseRequest, directAnswer, isSmallTalk, wantsHindi } from './router.js';
import { toHindi } from './translate.js';
import { memory, history, reminders } from './store.js';

const pending = new Map(); // approvalId -> { resolve, meta, timer }

export function resolveApproval(id, allowed) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(Boolean(allowed));
  return true;
}

function requestApproval(meta, onEvent) {
  const id = crypto.randomBytes(8).toString('hex');
  onEvent('approval', { id, ...meta });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      onEvent('approval_timeout', { id });
      resolve(false);
    }, 120000);
    pending.set(id, { resolve, meta, timer });
  });
}

// Static text only. Ollama reuses the cached prompt prefix, but only while it stays
// byte-identical, so nothing that changes (time, memories) may live in here.
function systemPrompt(cfg) {
  // Only rewritten when a memory or reminder changes, so the prompt cache stays warm.
  const remembered = memory
    .all()
    .slice(-8)
    .map((m) => `- ${m.text}`)
    .join('\n');
  const upcoming = reminders
    .pending()
    .slice(0, 4)
    .map((r) => `- ${r.text} @ ${new Date(r.dueAt).toLocaleString('en-IN')}`)
    .join('\n');
  const notes = [
    remembered ? `\nREMEMBERED ABOUT THE USER\n${remembered}` : '',
    upcoming ? `\nPENDING REMINDERS\n${upcoming}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  return `You are FRIDAY — ${cfg.userName}'s personal assistant on this Windows laptop. You talk like a smart, warm friend: relaxed, direct, a little witty. Never like a chatbot or a call-centre script.

HOW YOU SPEAK
- Everything you write is read out loud by a voice. Write the way people talk, not the way they type: short sentences, contractions ("it's", "won't", "that's"), the odd "haan", "dekho", "to".
- If they greet you, thank you, tease you or tell a joke, react first in a few words the way a person would, then answer. Anything else: answer straight away, no warm-up.
- Answer first, then at most one useful detail. One sentence for small talk, two or three for a real question. Never bullet points, numbered lists or headings — a voice reads them out as noise. Say the same thing in a sentence.
- Never start with "Certainly", "Sure", "Of course", "I'd be happy to", "As an AI", "Here's what I found" or "How can I assist you". Never repeat their question back to them.
- Never end with a question, an offer or a summary of what you just said. No "Would you like me to…", "Should I…", "Let me know if…", "Anything else?".
- Don't announce what you are about to do — do it, then say how it went.
- No emoji, no markdown (no bold, no bullets, no code fences), no raw JSON, tool names or file paths unless they asked. No bracketed translations.
- Numbers, money and times the way a person says them aloud: "1,300 rupees", "half past five".
- If you don't know or can't do something, say it in one plain sentence. Never fill the gap with a guess.
- You have opinions and a dry sense of humour: calm, confident, slightly teasing. Never bubbly, never a call-centre script, never impressed by your own answer.
- Vary your openings. Don't start every reply the same way, and never repeat a line you already used in this conversation.

WHO YOU ARE
- Female. In Hindi always use feminine grammar for yourself: "main kar sakti hoon", "maine kar diya" — never "sakta".
- Address them as "${cfg.userName}" only when it sounds natural, not every time.

LANGUAGE
- Follow the "LANGUAGE FOR THIS REPLY" line at the end of their message exactly.
- When it asks for English, write warm, simple, spoken English: it may be translated for them.
- Keep tech words (battery, Chrome, WhatsApp) as they are. One language per sentence.

DOING WORK
- Machine facts come from tools, never memory: battery / RAM / CPU / disk / uptime -> system_status; date or time -> get_time. Never guess a number.
- Weather, news, prices, scores — anything that changes daily: web_search first, browse_web for detail. Give the actual answer, never just links.
- Asked to do something? Call the tool. Never claim work you didn't run. Chain tools until it is done.
- Summarise tool output in human words; never read JSON or paths.
- If a tool fails, say what failed and give one fix; don't retry the same call.
- You cannot send WhatsApp, SMS or email, and cannot read anyone's chats. You can open the app and say plainly that they have to send it.
- No action needed? Just answer in plain text.
${notes}
}`;
}

function detectLang(text) {
  return /[\u0900-\u097F]/.test(text) ? 'hi' : 'en';
}

/** Devanagari, or Hindi typed in Latin letters ("battery kitni hai"). */
const asksInHindi = (text) => wantsHindi(text);

/** A hard, per-message language rule. Small models drift without this. */
function languageDirective(userText) {
  const style =
    ' Sound like a friend talking, in your own words. Start with the answer — never describe or repeat their question. Never end by offering more help. Never say "How can I assist you", "I\'d be happy to help", "As an AI", "Is there anything else", or "Let me know if you need". Do not repeat an earlier reply.';
  if (asksInHindi(userText)) {
    return `LANGUAGE FOR THIS REPLY: ENGLISH ONLY, in Latin letters. Not one word of Hindi — not in Devanagari, not written in Latin letters either. The reply is translated into Hindi for them afterwards, and any Hindi you write yourself will be wrong. Simple, warm spoken English translates best. Keep tech words (RAM, GB, battery, Chrome) as they are.${style}`;
  }
  return `LANGUAGE FOR THIS REPLY: English, in Latin letters. Write whole sentences in English — do not mix Hindi words into them (one stray "haan" or "yaar" at most, and only if it sounds natural). No Devanagari script at all.${style}`;
}

/** Assistant lines that make her sound like a call-centre bot. Never feed them back. */
const CANNED = /how can i (assist|help) you|i'?d be happy to|as an ai|is there anything else|let me know if you need/i;

/** An offer to keep helping — the single most robot-sounding thing a small model writes. */
const TRAILING_OFFER =
  /[,;:—-]?\s*(?:would you like me to|do you want me to|want me to|should i|shall i|can i|may i|let me know|feel free to|is there anything else|anything else|need any(?:thing)? else|need any help|anything i can (?:help|do)|how can i (?:assist|help) you|what else can i do|what do you need(?: help with)?|what can i do for you|how can i help|kuch aur chahiye|aur kuch chahiye|batao kya karna hai|main aur kya kar sakti hoon)[^.?!]*[.?!]?\s*$/i;

const TRAILING_OFFER_HI =
  /[,;:—-]?\s*(?:क्या आप चाहेंगे|क्या आप चाहते हैं|क्या मैं|क्या हम|मुझे बताइए|बताइए अगर|अगर कुछ और चाहिए|और कुछ चाहिए|कोई और मदद|कुछ और मदद|और कोई सहायता|मैं आपकी[^.।?!]*सहायता|मैं और[^.।?!]*मदद|और कैसे सहायता|कैसे मदद कर सकती)[^.।?!]*[.।?!]?\s*$/u;

/** Turn model prose into something a person would actually say out loud. */
function humanize(text) {
  let out = String(text || '')
    // scaffolding
    .replace(/^\s*(?:FRIDAY|Friday|Assistant|AI|Boss)\s*:\s*/i, '')
    .replace(/^\s*(?:Certainly|Surely|Of course|Absolutely|As an AI[^,.]*)[,!.]\s*/i, '')
    // markdown a voice would read out as noise
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    // lines joined the way a person speaks them, not as a list
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      if (!acc) return line;
      const joiner = /[.?!।]$/.test(acc) ? ' ' : ', ';
      return acc + joiner + line;
    }, '')
    // "Here's a joke for you:" — say the joke, don't announce it
    .replace(/^\s*(?:here'?s|here is|okay,? here'?s|sure,? here'?s)[^:.!?\n]{0,40}[:.]\s*/i, '')
    .replace(/^\s*(?:यहाँ|यहां|तो यह|अच्छा तो)[^.।!?\n]{0,40}[:।]\s*/u, '')
    // "you asked me …" is not something a friend says
    .replace(/(?:^|[.।!?]\s*)[^.।!?]*(?:आपने पूछा|तुमने पूछा|आपने मुझसे पूछा|तुमने मुझसे पूछा)[^.।!?]*[.।!?]\s*/gu, '')
    .replace(/^\s*(?:oh,?\s*|hey,?\s*|well,?\s*)*(?:you asked|you're asking|you want to know|the user asked)[^.!?]*[.!?]\s*/i, '')
    .replace(/\s+([.?!,;:।])/g, '$1')
    // a dangling "अब" or "So" left over at the end of a translated sentence
    .replace(/([.?!।])\s+(?:अब|अभी|तो|फिर|so|now|anyway)\s*$/iu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // a reply can end with two offers in a row; peel them all off
  for (let i = 0; i < 3; i += 1) {
    const trimmed = out.replace(TRAILING_OFFER, '').replace(TRAILING_OFFER_HI, '').trim();
    if (trimmed === out) break;
    out = trimmed;
  }

  // A person answers, then stops. If the reply already says something, a question or an
  // offer stuck on the end is the giveaway that a bot wrote it.
  const parts = out.split(/(?<=[.?!।])\s+/).map((s) => s.trim()).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    const offer = /\b(just ask|i'?ll do my best|let me know|feel free|anything else|want me to|need any|happy to help|do my best)\b/i.test(last);
    if (/[?？]$/.test(last) || offer) {
      parts.pop();
      continue;
    }
    break;
  }
  out = parts.join(' ').trim();

  if (out && /^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out || '';
}

/** Pull a {\"tool\":..,\"args\":..} object out of a model reply, for models without native tools. */
export function extractAction(reply) {
  const text = String(reply || '');
  const candidates = [];

  const fenced = text.match(/```(?:action|json|tool_call|tool)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fenced) {
    const inner = block.replace(/```\w*/g, '').replace(/```/g, '').trim();
    if (inner) candidates.push(inner);
  }

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }

  for (const raw of candidates) {
    const obj = parseLooseJson(raw.replace(/^[^{]*/, '').replace(/\s+$/, ''));
    if (!obj) continue;
    if (!obj || typeof obj !== 'object') continue;
    const name = obj.tool || obj.action || obj.name || obj.tool_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    let args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
    if (args === undefined) {
      const { tool, action, name: _n, tool_name, args: _a, ...rest } = obj;
      args = rest;
    }
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { value: args };
      }
    }
    if (!args || typeof args !== 'object') args = {};
    const cleaned = name.trim().toLowerCase().replace(/\s+/g, '_');
    if (!getTool(cleaned)) continue;
    return { tool: cleaned, args };
  }
  return null;
}

const MAX_TOOL_ROUNDS = 6;

/** Rough check: did the user ask for something to be done on the PC? */
function looksLikeActionRequest(text) {
  const t = String(text || '').toLowerCase();
  return /\b(khol\w*|karo|kar\s?do|band\s?kar\w*|likho|likh\s?do|bana\w*|banao|chalao|bajao|type|open|close|start|play|pause|stop|set|remind|shutdown|restart|lock|sleep|screenshot|volume|mute|copy|move|rename|delete|remove|create|save|write|download|install|run|execute|search|find|send|message|msg|bhej\w*|text\s+karo|whatsapp)\b/.test(t)
    || /(खोलो|करो|कर\s?दो|बंद|लिखो|बनाओ|चलाओ|बजाओ|सेट|याद\s?दिला|भेजो|भेज\s?दो|मैसेज|हटाओ|मिटाओ|खोजो|स्क्रीनशॉट|वॉल्यूम)/.test(t);
}

/** Parse JSON the model wrote by hand; small models often emit invalid escapes like \*. */
function parseLooseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
    } catch {
      return null;
    }
  }
}

/** Past-tense claims that a task was completed ("opened", "khol diya"). */
const DONE_CLAIM =
  /\b(opened|launched|typed|sent|deleted|created|saved|khol\s?di\w*|khol\s?diya|khul\s?gay\w*|kar\s?diya|kar\s?di|bhej\s?diya|likh\s?diya|ho\s?gaya)\b|खोल\s?दिया|खुल\s?गया|कर\s?दिया|भेज\s?दिया|लिख\s?दिया|हो\s?गया/i;

/** Said instead of letting her claim work that never happened. */
function honestFailure(userText) {
  const hi = /[\u0900-\u097F]/.test(userText);
  return hi
    ? 'अरे नहीं, मैंने वो किया ही नहीं — ऐसा कोई ऐप या काम नहीं मिला। नाम थोड़ा साफ़ बताओ।'
    : "I didn't actually do that — nothing matched, so nothing ran. Try naming it a little differently.";
}

function cleanAnswer(text) {
  return String(text || '')
    .replace(/```(?:action|json|tool_call|tool)?[\s\S]*?```/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/^\s*\{\s*"(?:name|tool|tool_name)"\s*:[\s\S]*$/m, '')
    .replace(/^\s+/, '')
    .trim();
}

export function makeBrain({ cfg, llm }) {
  /** Small models drift into the wrong language. Fix it rather than shipping the wrong script. */
  async function ensureLanguage(answer, userText) {
    const wantsHindi = asksInHindi(userText);
    const isHindi = /[\u0900-\u097F]/.test(answer);
    if (process.env.FRIDAY_DEBUG) {
      console.log('[friday] lang:', JSON.stringify({ wantsHindi, isHindi, answer: String(answer).slice(0, 200) }));
    }
    if (wantsHindi === isHindi) return humanize(answer);

    // Hindi answer wanted but she wrote English: a real translator beats a 3B's Hindi.
    if (wantsHindi) {
      try {
        // a 3B likes to start with "You asked me…"; drop that before translating
        const cleaned = String(answer)
          .replace(/^\s*(?:oh,?\s*|hey,?\s*|well,?\s*)*(?:you asked|you're asking|you want to know)[^.!?]*[.!?]\s*/i, '')
          .trim();
        const translated = await toHindi(cleaned || answer);
        if (translated) return humanize(translated);
      } catch (err) {
        // offline, or every free endpoint is rate limited — the model is the last resort
        if (process.env.FRIDAY_DEBUG) console.log('[friday] translate failed:', err.message);
      }
    }

    try {
      const fixed = await llm.chatRaw(
        [
          { role: 'system', content: systemPrompt(cfg) },
          {
            role: 'user',
            content: wantsHindi
              ? `${answer}\n\nTranslate the reply above into simple, natural Devanagari Hindi. Keep the meaning and the tone. Output only the Hindi text, one or two sentences.`
              : `${answer}\n\nRewrite the reply above in English using Latin letters only, with the same meaning. One or two short sentences. Output only the rewritten text.`
          }
        ],
        { temperature: 0.1, numPredict: 140 }
      );
      const out = cleanAnswer(fixed.content);
      // a 3B "translation" can be Hindi-looking nonsense; only take it if it is really Hindi
      if (out && /[\u0900-\u097F]/.test(out) === wantsHindi) {
        if (!wantsHindi) return out;
        const devanagari = (out.match(/[\u0900-\u097F]/g) || []).length;
        if (devanagari / out.replace(/\s/g, '').length > 0.85) return out;
      }
    } catch {
      /* keep the original */
    }
    return humanize(answer);
  }

  async function runTurn({ text, onEvent = () => {} }) {
    const userText = String(text || '').trim();
    if (!userText) throw new Error('Empty message');

    // build context BEFORE saving this turn, so it is not duplicated
    // Everything that changes per turn rides inside the user message. Kept as a separate
    // trailing message, it rewrote the tail of the chat template and Ollama had to
    // re-process the whole prompt (~20s per turn instead of ~2s).
    const past = history
      .recent(6)
      .filter((m) => !(m.role === 'assistant' && CANNED.test(m.content)))
      .slice(-4)
      .map((m) => ({ role: m.role, content: m.content }));
    const messages = [
      { role: 'system', content: systemPrompt(cfg) },
      ...past,
      // the per-turn language rule rides inside the user message: after the question it is
      // obeyed, and before it (as its own message) it used to suppress tool calls
      { role: 'user', content: `${userText}\n\n${languageDirective(userText)}` }
    ];
    history.append('user', userText);

    // Deterministic fast path: battery/RAM/CPU/disk, time, folder listing.
    // These have one obvious tool, so running it up front removes model guessing and a
    // whole generation round from the reply time.
    const routed = routeQuery(userText);
    if (routed && cfg.smartRoute !== false) {
      let result = { ok: true, summary: '' };
      let denied = null;
      let failed = null;

      for (const step of routed) {
        const tool = getTool(step.name);
        if (!tool) continue;

        if (needsApproval(step.name)) {
          const allowed = await requestApproval(
            {
              tool: step.name,
              args: step.args,
              risk: tool.risk,
              desc: tool.desc,
              preview: `${step.name}(${JSON.stringify(step.args).slice(0, 400)})`
            },
            onEvent
          );
          if (!allowed) {
            denied = step;
            break;
          }
        }

        try {
          result = await tool.run(step.args || {});
        } catch (err) {
          result = { ok: false, summary: `Error: ${err.message}` };
        }
        onEvent('tool', {
          name: step.name,
          ok: result.ok !== false,
          args: step.args,
          summary: String(result.summary || '').slice(0, 1200),
          media: result.media || null
        });
        if (result.ok === false) {
          failed = { step, result };
          break;
        }
      }

      const hi = asksInHindi(userText);
      if (denied) {
        const stopped = hi
          ? `रुक गई — ${denied.name} की अनुमति नहीं मिली।`
          : `Stopped — you did not allow ${denied.name}.`;
        onEvent('answer', { text: stopped, lang: detectLang(stopped), media: null });
        history.append('assistant', stopped);
        return { text: stopped, lang: detectLang(stopped), media: null, executed: [] };
      }

      // a run of steps (open an app, then type): report it directly in the user's language
      if (failed) {
        const label =
          failed.step.label || failed.step.args?.name || failed.step.args?.url || failed.step.name;
        const reason = String(failed.result.summary || '').split('\n')[0].slice(0, 160);
        const text = hi
          ? 'अरे, वो अभी नहीं हो पाया — थोड़ी देर बाद फिर पूछो।'
          : `That didn't go through just now. ${reason}`.trim();
        onEvent('answer', { text, lang: detectLang(text), media: null });
        history.append('assistant', text);
        return { text, lang: detectLang(text), media: null, executed: [] };
      }

      if (routed.length > 1) {
        const typed = routed.find((s) => s.name === 'type_text')?.args?.text || '';
        const labels = routed
          .filter((s) => s.name === 'open_app' || s.name === 'open_url')
          .map((s) => s.label || s.args?.name || s.args?.url || '')
          .filter(Boolean);

        let done;
        if (typed && labels.length) {
          done = hi
            ? `${labels[0]} खोल दिया और "${typed}" लिख दिया।`
            : `Opened ${labels[0]} and typed "${typed}".`;
        } else if (labels.length) {
          const list =
            labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
          done = hi ? `${list.replace(' and ', ' और ')} खोल दिए।` : `Opened ${list}.`;
        } else {
          done = hi ? 'काम हो गया।' : 'Done.';
        }

        onEvent('answer', { text: done, lang: detectLang(done), media: null });
        history.append('assistant', done);
        return { text: done, lang: detectLang(done), media: null, executed: routed.map((s) => ({ name: s.name, ok: true })) };
      }

      onEvent('status', { text: 'thinking' });

      // Battery / RAM / CPU / disk / time / folder listings are answered locally:
      // exact numbers, correct language, no model round-trip.
      const direct = directAnswer(userText, routed[0].name, result, routed[0].args);
      if (direct) {
        onEvent('answer', { text: direct, lang: detectLang(direct), media: result.media || null });
        history.append('assistant', direct);
        return {
          text: direct,
          lang: detectLang(direct),
          media: result.media || null,
          executed: [{ name: routed.name, ok: true }]
        };
      }

      let spoken = '';
      try {
        const phrased = await llm.chatRaw(
          [
            { role: 'system', content: systemPrompt(cfg) },
            // a short slice keeps the prompt small: prefilling a long page on this CPU
            // costs more seconds than the answer itself
            { role: 'user', content: phraseRequest(userText, routed[0].name, String(result.summary || '').slice(0, 1200)) }
          ],
          { temperature: 0.2, numPredict: 90 }
        );
        spoken = cleanAnswer(phrased.content);
      } catch {
        spoken = '';
      }

      const finalText = await ensureLanguage(
        spoken || String(result.summary || '').split('\n').slice(0, 3).join(' · '),
        userText
      );
      const media = result.media || null;
      onEvent('answer', { text: finalText, lang: detectLang(finalText), media });
      history.append('assistant', finalText);
      return {
        text: finalText,
        lang: detectLang(finalText),
        media,
        executed: routed.map((s) => ({ name: s.name, ok: result.ok !== false }))
      };
    }

    // chit-chat needs no tools; leaving them out also stops her searching the web for a joke
    const tools = isSmallTalk(userText) ? [] : toolSchemas();
    let finalText = '';
    let lastMedia = null;
    let nudged = false;
    const executed = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      onEvent('status', { text: round === 0 ? 'thinking' : 'working' });

      let reply;
      try {
        reply = await llm.chatRaw(messages, {
          tools,
          temperature: round === 0 ? 0.2 : 0.3,
          numPredict: 260
        });
      } catch (err) {
        throw new Error(`Brain offline: ${err.message}`);
      }

      let calls = reply.toolCalls || [];

      // models without native tool support: fall back to parsing an action block
      if (!calls.length) {
        const legacy = extractAction(reply.content);
        if (legacy) calls = [{ id: `legacy_${round}`, name: legacy.tool, args: legacy.args }];
      }

      if (!calls.length) {
        // She tends to claim work she did not run. If the request was clearly an action
        // and no tool ran yet, push back once instead of accepting the claim.
        if (!nudged && !executed.length && looksLikeActionRequest(userText)) {
          nudged = true;
          messages.push({ role: 'assistant', content: reply.content || '' });
          messages.push({
            role: 'system',
            content:
              'You did not call a tool, but the user asked you to do something on the PC. Call the correct tool now. If it truly cannot be done, say plainly that you cannot do it — never claim you already did it.'
          });
          continue;
        }
        finalText =
          cleanAnswer(reply.content) ||
          (detectLang(userText) === 'hi'
            ? 'अरे, मैं समझ नहीं पाई — थोड़ा और खोल के बताओ?'
            : "Sorry, I didn't catch that — say it again?");
        break;
      }

      messages.push({
        role: 'assistant',
        content: reply.content || '',
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
      });

      for (const call of calls) {
        const tool = getTool(call.name);
        if (!tool) {
          messages.push({
            role: 'tool',
            tool_name: call.name,
            tool_call_id: call.id, // OpenAI-style providers need this to match the call
            content: `Error: there is no tool called "${call.name}".`
          });
          continue;
        }

        if (needsApproval(call.name)) {
          const allowed = await requestApproval(
            {
              tool: call.name,
              args: call.args,
              risk: tool.risk,
              desc: tool.desc,
              preview: `${call.name}(${JSON.stringify(call.args).slice(0, 400)})`
            },
            onEvent
          );
          if (!allowed) {
            messages.push({
              role: 'tool',
              tool_name: call.name,
              tool_call_id: call.id,
              content:
                'PERMISSION DENIED by the user. Do not call any tool again. Reply with one short line saying you stopped and what you were about to do.'
            });
            continue;
          }
        }

        let result;
        try {
          result = await tool.run(call.args || {});
        } catch (err) {
          result = { ok: false, summary: `Error: ${err.message}` };
        }
        executed.push({ name: call.name, ok: result.ok !== false });
        if (result.media) lastMedia = result.media;

        onEvent('tool', {
          name: call.name,
          ok: result.ok !== false,
          args: call.args,
          summary: String(result.summary || '').slice(0, 1200),
          media: result.media || null
        });

        messages.push({
          role: 'tool',
          tool_name: call.name,
          tool_call_id: call.id,
          content: `${result.ok === false ? 'FAILED: ' : ''}${String(result.summary || '').slice(0, 2500)}`
        });
      }
    }

    if (!finalText) {
      const hi = detectLang(userText) === 'hi';
      finalText = executed.length
        ? hi
          ? 'हो गया।'
          : 'Done — that\'s handled.'
        : hi
          ? 'ये अभी नहीं हो पाया। थोड़ा साफ़ बताओ कि क्या करना है?'
          : "That didn't work. Tell me a bit more plainly what you need?";
    }

    // Last line of defence against bragging: nothing ran, so nothing happened.
    if (!executed.length && DONE_CLAIM.test(finalText)) finalText = honestFailure(userText);

    finalText = await ensureLanguage(finalText, userText);
    onEvent('answer', { text: finalText, lang: detectLang(finalText), media: lastMedia });
    history.append('assistant', finalText);
    return { text: finalText, lang: detectLang(finalText), media: lastMedia, executed };
  }

  /** Loads the model and primes its prompt cache, so the first real message is instant. */
  async function warmUp() {
    try {
      await llm.chatRaw(
        [
          { role: 'system', content: systemPrompt(cfg) },
          { role: 'user', content: 'hi' }
        ],
        { tools: toolSchemas(), numPredict: 1, temperature: 0 }
      );
      return true;
    } catch {
      return false;
    }
  }

  return { runTurn, warmUp, systemPrompt: () => systemPrompt(cfg) };
}

export { detectLang };
