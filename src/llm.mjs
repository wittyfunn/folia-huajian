// OpenAI-compatible chat calls through `folium.net.fetch` (host-side, no CORS,
// timeout at most 60 s), written to work with whatever endpoint a community user
// brings: OpenAI, Chinese providers, OpenRouter, local Ollama / LM Studio.
//
// Providers disagree on optional fields (JSON mode, how to switch reasoning off,
// max_tokens vs max_completion_tokens, whether temperature is allowed). The
// request starts with all of them and, when the provider rejects one, drops or
// swaps the field its error names and retries. What worked is handed back as a
// `compat` record so the next call for the same endpoint and model starts right.

import { endpointUrl } from './providers.mjs';

const TIMEOUT_MS = 45000;
const MAX_TOKENS = 1200;
const MAX_ATTEMPTS = 6;
const OPTIONAL_FIELDS = ['response_format', 'thinking', 'enable_thinking', 'reasoning_effort', 'temperature'];

const extractJson = (raw) => {
  let text = String(raw ?? '').trim();
  // Some local models wrap their answer in a <think> block even when asked not to.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (text.startsWith('```')) text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  return JSON.parse(text);
};

const contentOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
};

/** Token counts, cache hits and reasoning tokens under the field names in use. */
export const usageOf = (usage) => ({
  input: Number(usage?.prompt_tokens) || 0,
  output: Number(usage?.completion_tokens) || 0,
  cached: Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens) || 0,
  reasoning: Number(usage?.completion_tokens_details?.reasoning_tokens) || 0,
});

const redact = (text, apiKey) => String(text)
  .split(apiKey || '\u0000').join('[已隐藏]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[已隐藏]')
  .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1[已隐藏]');

/* What a status means to someone who just pasted a key in. */
const explainStatus = (status) => ({
  401: '密钥无效或已过期',
  402: '账户余额不足',
  403: '没有权限使用这个模型或接口',
  404: '地址或模型名不对（用“测试连接”看看可用的模型）',
  429: '请求太频繁或额度用完了',
}[status] ?? (status >= 500 ? '服务商那边出错了，稍后再试' : ''));

const headersFor = (apiKey) => ({
  'Content-Type': 'application/json',
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
});

/** The request body for this attempt, from the compat record. */
const bodyFor = ({ model, temperature, thinkingFields, system, user, maxTokens = MAX_TOKENS }, compat) => {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature,
    stream: false,
    response_format: { type: 'json_object' },
    ...thinkingFields,
  };
  body[compat.maxTokensField ?? 'max_tokens'] = maxTokens;
  for (const field of compat.drop ?? []) delete body[field];
  return body;
};

/* Reads a 400/422 body for the field it complains about and returns the next
 * compat record, or null when there is nothing left to try. */
const nextCompat = (compat, body, errorText) => {
  const text = errorText.toLowerCase();
  if ((compat.maxTokensField ?? 'max_tokens') === 'max_tokens' && text.includes('max_tokens')) {
    return { ...compat, maxTokensField: 'max_completion_tokens' };
  }
  const named = OPTIONAL_FIELDS.find((field) => field in body && text.includes(field));
  const field = named ?? OPTIONAL_FIELDS.find((name) => name in body);
  if (!field) return null;
  return { ...compat, drop: [...new Set([...(compat.drop ?? []), field])] };
};

/**
 * @returns {Promise<{ json, usage, ms, thought: boolean, compat }>}
 *   `thought` is true when the model spent tokens reasoning anyway.
 */
export const chatJson = async ({ fetch, baseUrl, apiKey, model, temperature, thinkingFields = {}, system, user, maxTokens, compat: start = {} }) => {
  const url = endpointUrl(baseUrl, 'chat/completions');
  if (!url) throw new Error('还没有选择服务商或填写接口地址');
  if (!model) throw new Error('还没有填写模型名');
  let compat = { drop: [], ...start };
  const started = performance.now();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const body = bodyFor({ model, temperature, thinkingFields, system, user, maxTokens }, compat);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: headersFor(apiKey), body: JSON.stringify(body), timeoutMs: TIMEOUT_MS });
    } catch (error) {
      throw new Error(`连不上接口：${redact(error?.message ?? error, apiKey)}`);
    }
    if (response.ok) {
      let data;
      try {
        data = response.json();
      } catch {
        throw new Error('接口返回的不是 JSON（地址可能填错了）');
      }
      const choice = data?.choices?.[0];
      const text = contentOf(choice?.message);
      const usage = usageOf(data?.usage);
      const thought = Boolean(choice?.message?.reasoning_content || choice?.message?.reasoning || usage.reasoning > 0);
      if (!text) {
        throw new Error(choice?.finish_reason === 'length'
          ? '回答被长度上限截断：这个模型可能在“思考”，在设置里换一种关闭思考的方式，或换个模型'
          : '接口返回了空内容');
      }
      let json;
      try {
        json = extractJson(text);
      } catch {
        throw new Error(`模型没有按要求返回 JSON：${text.slice(0, 120)}`);
      }
      return { json, usage, ms: Math.round(performance.now() - started), thought, compat };
    }
    const errorText = (() => {
      try {
        return redact(response.text(), apiKey);
      } catch {
        return '';
      }
    })();
    const retryable = response.status === 400 || response.status === 422;
    const next = retryable ? nextCompat(compat, body, errorText) : null;
    if (!next) {
      const hint = explainStatus(response.status);
      throw new Error(`接口返回 ${response.status}${hint ? `（${hint}）` : ''}：${errorText.slice(0, 240) || response.statusText}`);
    }
    compat = next;
  }
  throw new Error('接口一直拒绝请求，换个模型试试');
};

/** GET /models, as most OpenAI-compatible servers offer it. */
export const listModels = async ({ fetch, baseUrl, apiKey }) => {
  const url = endpointUrl(baseUrl, 'models');
  if (!url) throw new Error('还没有选择服务商或填写接口地址');
  const response = await fetch(url, { method: 'GET', headers: headersFor(apiKey), timeoutMs: 15000 });
  if (!response.ok) {
    const hint = explainStatus(response.status);
    throw new Error(`获取模型列表失败 ${response.status}${hint ? `（${hint}）` : ''}`);
  }
  const data = response.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
  return list.map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name)).filter(Boolean).sort();
};

const PING_SYSTEM = '只输出一个 JSON 对象：{"ok": true, "word": "一个描述夜晚的中文词"}';

/** "测试连接": the model list (when offered) and one tiny JSON call. */
export const testConnection = async ({ fetch, baseUrl, apiKey, model, thinkingFields, compat }) => {
  const report = { models: null, modelsError: null, modelListed: null, chat: null, chatError: null };
  try {
    report.models = await listModels({ fetch, baseUrl, apiKey });
    report.modelListed = report.models.length === 0 ? null : report.models.includes(model);
  } catch (error) {
    report.modelsError = String(error?.message ?? error);
  }
  if (model) {
    try {
      report.chat = await chatJson({ fetch, baseUrl, apiKey, model, temperature: 0.2, thinkingFields, system: PING_SYSTEM, user: '测试', compat });
    } catch (error) {
      report.chatError = String(error?.message ?? error);
    }
  }
  return report;
};
