// Optional "big brain": any OpenAI-compatible chat API (Gemini, Groq, OpenRouter, OpenAI).
//
// Why this exists: the local 3B is fine for commands but knows little. A cloud model
// gives ChatGPT-level knowledge. Free tiers exist, so this stays subscription-free --
// if no key is set, nothing changes and she runs entirely on the laptop.
//
// She never sends your files or screenshots on her own: only the conversation, the tool
// results she needs, and your message.
const publicError = (err) => String(err?.message || err || 'unknown error').replace(/\bsk-[\w-]+/g, '[key]');

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini — free tier, no card',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: true,
    note: 'Free tier with a per-minute request limit. Best knowledge per rupee here.'
  },
  groq: {
    label: 'Groq — free tier, very fast',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    free: true,
    note: 'Llama 70B on fast hardware. Free tier has a daily token cap.'
  },
  openrouter: {
    label: 'OpenRouter — free models',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
    free: true,
    note: 'Pick any model ending in ":free". Free models are rate limited.'
  },
  openai: {
    label: 'OpenAI — paid, needs credit',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    free: false,
    note: 'The real ChatGPT models. Costs money per message.'
  },
  custom: {
    label: 'Custom OpenAI-compatible server',
    baseUrl: '',
    model: '',
    keyUrl: '',
    free: true,
    note: 'Ollama on another PC, LM Studio, vLLM, anything that speaks /v1/chat/completions.'
  }
};

/** Fill in baseUrl/model from the provider preset unless the user overrode them. */
export function resolveCloud(cloud = {}) {
  const provider = PROVIDERS[cloud.provider] ? cloud.provider : 'gemini';
  const preset = PROVIDERS[provider];
  return {
    enabled: Boolean(cloud.enabled),
    provider,
    baseUrl: String(cloud.baseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
    model: String(cloud.model || preset.model || ''),
    apiKey: String(cloud.apiKey || ''),
    maxTokens: Number(cloud.maxTokens) > 0 ? Number(cloud.maxTokens) : 900,
    temperature: cloud.temperature !== undefined ? Number(cloud.temperature) : 0.4
  };
}

/** What the browser is allowed to see: everything except the key itself. */
export function publicCloud(cloud = {}) {
  const resolved = resolveCloud(cloud);
  const { apiKey, ...rest } = resolved;
  const preset = PROVIDERS[resolved.provider] || {};
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    // locally stored keys are echoed back only as bullets, never as text
    keyMask: apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '',
    label: preset.label || '',
    keyUrl: preset.keyUrl || '',
    note: preset.note || '',
    free: preset.free !== false
  };
}

const TIMEOUT_MS = 45000;

export function makeCloudLlm(cfg) {
  let cloud = resolveCloud(cfg.cloud || {});
  let lastError = '';

  function errorFor(status, body) {
    const text = String(body || '').slice(0, 300);
    if (status === 401 || status === 403) return `API key rejected by ${cloud.provider} — paste it again in Settings.`;
    if (status === 404) return `Model "${cloud.model}" is not available at ${cloud.provider} — open Settings and fetch the model list.`;
    if (status === 429) return `Free limit reached on ${cloud.provider}. She will use the local model until it resets.`;
    if (status === 400) return `The request was rejected (400): ${text}`;
    return `Cloud brain error ${status}: ${text}`;
  }

  async function request(path, { body, timeout = TIMEOUT_MS } = {}) {
    if (!cloud.baseUrl) throw new Error('No cloud address set — pick a provider in Settings.');
    if (!cloud.apiKey) throw new Error('No API key set for the cloud brain.');
    let res;
    try {
      res = await fetch(`${cloud.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${cloud.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      const hint = err.name === 'TimeoutError' ? 'The cloud took too long to answer.' : 'No internet connection?';
      throw new Error(`${hint} (${cloud.provider}) ${publicError(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(errorFor(res.status, text));
    }
    return res;
  }

  /** OpenAI-shaped messages; also converts the local tool-message style. */
  function toMessages(messages) {
    let seenSystem = false;
    return (messages || []).map((m) => {
      if (m.role === 'system') {
        if (!seenSystem) {
          seenSystem = true;
          return { role: 'system', content: String(m.content ?? '') };
        }
        // most OpenAI-compatible endpoints only accept one system message, at the start
        return { role: 'user', content: `[system note] ${String(m.content ?? '')}` };
      }
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id || m.tool_name || 'call_0',
          content: String(m.content ?? '')
        };
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((c, i) => {
            const fn = c.function || {};
            const args = fn.arguments ?? c.args ?? {};
            return {
              id: c.id || `call_${i}`,
              type: 'function',
              function: { name: fn.name || c.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
            };
          })
        };
      }
      // vision turns send structured parts (text + image_url); pass those through untouched
      return { role: m.role, content: typeof m.content === 'string' ? m.content : (m.content ?? '') };
    });
  }

  async function health() {
    if (!cloud.baseUrl || !cloud.apiKey) {
      return { online: false, models: [], model: cloud.model, hasModel: false, url: cloud.baseUrl, error: 'no key set' };
    }
    try {
      const res = await request('/models', { timeout: 12000 });
      const data = await res.json();
      const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
      const wanted = cloud.model;
      return {
        online: true,
        models,
        model: wanted,
        hasModel: models.length ? models.some((m) => m === wanted || m.startsWith(`${wanted}`)) : true,
        url: cloud.baseUrl,
        provider: cloud.provider
      };
    } catch (err) {
      lastError = err.message;
      return { online: false, models: [], model: cloud.model, hasModel: false, url: cloud.baseUrl, error: err.message };
    }
  }

  async function listModels() {
    const res = await request('/models', { timeout: 15000 });
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  }

  function body(messages, { tools, model, temperature, maxTokens } = {}) {
    const out = {
      model: model || cloud.model,
      messages: toMessages(messages),
      temperature: temperature !== undefined ? temperature : cloud.temperature,
      max_tokens: maxTokens || cloud.maxTokens
    };
    if (tools && tools.length) {
      out.tools = tools;
      out.tool_choice = 'auto';
    }
    return out;
  }

  async function chat(messages, { temperature, numPredict, model } = {}) {
    const res = await request('/chat/completions', {
      body: body(messages, { temperature, model, maxTokens: numPredict })
    });
    const data = await res.json();
    return String(data.choices?.[0]?.message?.content || '').trim();
  }

  async function chatRaw(messages, { tools, temperature, numPredict, model } = {}) {
    const res = await request('/chat/completions', {
      body: body(messages, { tools, temperature, model, maxTokens: numPredict })
    });
    const data = await res.json();
    const message = data.choices?.[0]?.message || {};
    const toolCalls = (message.tool_calls || []).map((call, i) => {
      let args = call.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {}; // a malformed argument blob must not become a fake call
        }
      }
      return { id: call.id || `call_${i}`, name: call.function?.name, args: args && typeof args === 'object' ? args : {} };
    });
    if (process.env.FRIDAY_DEBUG) {
      console.log(`[cloud] ${cloud.provider}/${cloud.model} · ${toolCalls.length} tool call(s) · ${data.usage?.total_tokens ?? '?'} tok`);
    }
    return { content: String(message.content || '').trim(), toolCalls, raw: message };
  }

  async function chatStream(messages, onToken, { temperature, numPredict, model } = {}) {
    const res = await request('/chat/completions', {
      body: { ...body(messages, { temperature, model, maxTokens: numPredict }), stream: true }
    });
    let full = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const piece = obj.choices?.[0]?.delta?.content || '';
          if (piece) {
            full += piece;
            onToken(piece);
          }
        } catch {
          /* partial json */
        }
      }
    }
    return full;
  }

  return {
    chat,
    chatRaw,
    chatStream,
    health,
    listModels,
    get base() {
      return cloud.baseUrl;
    },
    get provider() {
      return cloud.provider;
    },
    get model() {
      return cloud.model;
    },
    reload(next) {
      cloud = resolveCloud(next || {});
    },
    get lastError() {
      return lastError;
    }
  };
}
