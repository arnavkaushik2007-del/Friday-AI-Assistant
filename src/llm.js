// Talks to a local Ollama server. No API keys, no cloud, no subscription.
export function makeLlm(cfg) {
  const base = (cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');

  async function request(path, body, { timeout = 180000 } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  async function health() {
    try {
      const res = await request('/api/tags', null, { timeout: 12000 });
      const data = await res.json();
      const models = (data.models || []).map((m) => m.name);
      const wanted = cfg.model;
      const hasModel = models.some((m) => m === wanted || m === `${wanted}:latest` || m.startsWith(`${wanted}:`));
      return { online: true, models, model: wanted, hasModel, url: base };
    } catch (err) {
      return { online: false, models: [], model: cfg.model, hasModel: false, url: base, error: err.message };
    }
  }

  function options(overrides = {}) {
    return {
      temperature: cfg.temperature ?? 0.35,
      num_ctx: cfg.numCtx ?? 4096,
      num_predict: cfg.numPredict ?? 700,
      top_p: 0.9,
      repeat_penalty: 1.1,
      ...overrides
    };
  }

  /** Non-streaming completion, returns text. */
  async function chat(messages, { numPredict, temperature, model } = {}) {
    const res = await request('/api/chat', {
      model: model || cfg.model,
      messages,
      stream: false,
      keep_alive: cfg.keepAlive || '30m',
      options: options({ ...(numPredict ? { num_predict: numPredict } : {}), ...(temperature !== undefined ? { temperature } : {}) })
    });
    const data = await res.json();
    if (process.env.FRIDAY_DEBUG) {
      const perSec = (n, d) => (d ? (n / (d / 1e9)).toFixed(0) : '?');
      console.log(
        `[brain] prompt ${data.prompt_eval_count}tok @${perSec(data.prompt_eval_count, data.prompt_eval_duration)}t/s` +
          ` · gen ${data.eval_count}tok @${perSec(data.eval_count, data.eval_duration)}t/s`
      );
    }
    return (data.message?.content || '').trim();
  }

  /** Streaming completion; calls onToken for each piece of text. */
  async function chatStream(messages, onToken, { numPredict, temperature, model } = {}) {
    const res = await request('/api/chat', {
      model: model || cfg.model,
      messages,
      stream: true,
      keep_alive: cfg.keepAlive || '30m',
      options: options({ ...(numPredict ? { num_predict: numPredict } : {}), ...(temperature !== undefined ? { temperature } : {}) })
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
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const piece = obj.message?.content || '';
          if (piece) {
            full += piece;
            onToken(piece);
          }
          if (obj.done) return full;
        } catch {
          /* partial json, ignore */
        }
      }
    }
    return full;
  }

  /**
   * One completion that may return native tool calls.
   * Returns { content, toolCalls: [{ id, name, args }] }.
   */
  async function chatRaw(messages, { tools, numPredict, temperature, model, format } = {}) {
    const res = await request('/api/chat', {
      model: model || cfg.model,
      messages,
      stream: false,
      ...(tools && tools.length ? { tools } : {}),
      ...(format ? { format } : {}),
      keep_alive: cfg.keepAlive || '30m',
      options: options({
        ...(numPredict ? { num_predict: numPredict } : {}),
        ...(temperature !== undefined ? { temperature } : {})
      })
    });
    const data = await res.json();
    const message = data.message || {};
    if (process.env.FRIDAY_DEBUG) {
      const perSec = (n, d) => (d ? (n / (d / 1e9)).toFixed(0) : '?');
      console.log(
        `[brain] prompt ${data.prompt_eval_count}tok @${perSec(data.prompt_eval_count, data.prompt_eval_duration)}t/s` +
          ` · gen ${data.eval_count}tok @${perSec(data.eval_count, data.eval_duration)}t/s` +
          ` · load ${((data.load_duration || 0) / 1e6).toFixed(0)}ms · ${(data.tool_calls || []).length} tool call(s)`
      );
    }
    const toolCalls = (message.tool_calls || []).map((call, i) => {
      const fn = call.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return { id: call.id || `call_${i}`, name: fn.name, args: args && typeof args === 'object' ? args : {} };
    });
    return { content: (message.content || '').trim(), toolCalls, raw: message };
  }

  return { chat, chatStream, chatRaw, health, base };
}

/**
 * Two brains, one interface: the cloud model when you gave it a key, the laptop model
 * otherwise. A broken key or a dead connection drops back to local for a minute instead
 * of breaking the conversation - and never pretends the cloud answered.
 */
export function makeHybridLlm({ cfg, local, cloud }) {
  let offlineUntil = 0;
  let lastCloudError = '';

  const hasKey = () => Boolean(cloud) && Boolean(cfg.cloud?.enabled) && Boolean(cfg.cloud?.apiKey);
  const usingCloud = () => hasKey() && Date.now() > offlineUntil;

  async function route(method, args, localCall) {
    if (!usingCloud()) return localCall();
    try {
      return await cloud[method](...args);
    } catch (err) {
      lastCloudError = String(err.message || err);
      offlineUntil = Date.now() + 60_000;
      console.warn(`[friday] cloud brain unavailable — local model for now :: ${lastCloudError}`);
      return localCall();
    }
  }

  async function health() {
    const localHealth = await local.health();
    if (!hasKey()) {
      return { ...localHealth, mode: 'local', cloud: { online: false, enabled: Boolean(cfg.cloud?.enabled), error: cfg.cloud?.enabled ? 'no API key' : 'off' } };
    }
    let cloudHealth;
    try {
      cloudHealth = await cloud.health();
    } catch (err) {
      cloudHealth = { online: false, error: String(err.message || err) };
    }
    return {
      ...localHealth,
      mode: usingCloud() && cloudHealth.online ? 'cloud' : 'local',
      cloud: { ...cloudHealth, provider: cloud.provider, model: cloud.model },
      cloudError: lastCloudError
    };
  }

  return {
    chat: (messages, opts) => route('chat', [messages, opts], () => local.chat(messages, opts)),
    chatStream: (messages, onToken, opts) =>
      route('chatStream', [messages, onToken, opts], () => local.chatStream(messages, onToken, opts)),
    chatRaw: (messages, opts) => route('chatRaw', [messages, opts], () => local.chatRaw(messages, opts)),
    health,
    get base() {
      return usingCloud() ? cloud.base : local.base;
    },
    get cloudActive() {
      return usingCloud();
    }
  };
}
