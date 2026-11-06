// Endpoint presets for OpenAI-compatible chat APIs. A preset only fills in the
// base URL and knows how that provider switches reasoning off; the model name is
// always the user's (model lists change too often to ship), and "测试连接" can
// fetch the provider's own list. Any other OpenAI-compatible endpoint works
// through "自定义".

export const PROVIDERS = {
  custom: { label: '自定义（填下面的接口地址）', url: '' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', thinking: 'reasoning_effort' },
  deepseek: { label: 'DeepSeek 深度求索', url: 'https://api.deepseek.com', thinking: 'thinking' },
  dashscope: { label: '阿里云百炼（通义千问）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinking: 'enable_thinking' },
  zhipu: { label: '智谱 BigModel（GLM）', url: 'https://open.bigmodel.cn/api/paas/v4', thinking: 'thinking' },
  moonshot: { label: '月之暗面 Kimi', url: 'https://api.moonshot.cn/v1' },
  volcengine: { label: '火山方舟（豆包）', url: 'https://ark.cn-beijing.volces.com/api/v3', thinking: 'thinking' },
  siliconflow: { label: '硅基流动 SiliconFlow', url: 'https://api.siliconflow.cn/v1', thinking: 'enable_thinking' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  gemini: { label: 'Google Gemini（OpenAI 兼容端点）', url: 'https://generativelanguage.googleapis.com/v1beta/openai', thinking: 'reasoning_effort' },
  ollama: { label: 'Ollama（本机）', url: 'http://localhost:11434/v1', local: true },
  lmstudio: { label: 'LM Studio（本机）', url: 'http://localhost:1234/v1', local: true },
};

/** The request fields each way of switching reasoning off sends. */
export const THINKING_OFF = {
  thinking: { thinking: { type: 'disabled' } },
  enable_thinking: { enable_thinking: false },
  reasoning_effort: { reasoning_effort: 'low' },
  none: {},
};

/* Hosts whose switch is known, for "自动" with a custom URL. */
const HOST_RULES = [
  [/deepseek\.com/, 'thinking'],
  [/bigmodel\.cn/, 'thinking'],
  [/volces\.com/, 'thinking'],
  [/dashscope|aliyuncs\.com/, 'enable_thinking'],
  [/siliconflow/, 'enable_thinking'],
  [/api\.openai\.com/, 'reasoning_effort'],
  [/generativelanguage\.googleapis\.com/, 'reasoning_effort'],
];

/** `auto` resolves by preset, then by host; anything else is used as given. */
export const thinkingMethodFor = ({ method, provider, url }) => {
  if (method && method !== 'auto') return method;
  if (PROVIDERS[provider]?.thinking) return PROVIDERS[provider].thinking;
  const host = String(url).toLowerCase();
  return HOST_RULES.find(([pattern]) => pattern.test(host))?.[1] ?? 'none';
};

/** The base URL in effect: the user's own, or the preset's. */
export const baseUrlFor = ({ provider, baseUrl }) => String(baseUrl ?? '').trim() || PROVIDERS[provider]?.url || '';

/** Local servers (Ollama, LM Studio, anything on this machine) need no key. */
export const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(String(url).trim());

/**
 * `<base>/<endpoint>`: a bare host gets `/v1` first (DeepSeek, most gateways);
 * a base that already has a path (`/v1`, `/api/v3`, `/v1beta/openai`) is used
 * as is. A full `.../chat/completions` URL is trimmed back to its base first.
 */
export const endpointUrl = (base, endpoint) => {
  let url = String(base ?? '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const cut = url.search(/[?#]/);
  const query = cut === -1 ? '' : url.slice(cut);
  let path = (cut === -1 ? url : url.slice(0, cut)).replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '');
  if (/^https?:\/\/[^/]+$/i.test(path)) path += '/v1';
  return `${path}/${endpoint}${query}`;
};
