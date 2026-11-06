/// <reference path="../dev/folium.d.ts" />
// 花笺 — a lyric animation mode for Folia. Editorial typography (outline
// keywords, hairlines, seals, poem-draft and vertical layouts) and a full set
// of light (rain, snow, petals, fireflies, embers, stars, the sparkler,
// fireworks), staged per paragraph by an AI director that reads each song once.
// The director is optional: without it a local reading of the lyric directs.
//
// This file wires settings, commands and the visualizer to the director
// (director.mjs) and the stage (stage.mjs).

import { createStore } from './store.mjs';
import { createDirector } from './director.mjs';
import { mountStage } from './stage.mjs';
import { createEvaluator } from './evaluate.mjs';
import { PROVIDERS } from './providers.mjs';

const T = (zh, en) => ({ 'zh-CN': zh, en });
const PROVIDER_OPTIONS = Object.entries(PROVIDERS).map(([value, provider]) => ({ value, label: T(provider.label, provider.label) }));

/** Settings > Mods > 花笺: the AI endpoint and the director's behaviour. */
const SECTION_SETTINGS = [
  { key: 'ai', type: 'boolean', group: T('AI 导演', 'AI director'), label: T('启用 AI 导演', 'Use the AI director'),
    description: T('每首歌调用一次 AI 读懂歌词，为每个段落安排版式、氛围和火花；结果会记住，同一首歌不再花钱。关掉则完全用本地规则', 'One call per song; remembered afterwards. Off: local rules only'), defaultValue: true },
  { key: 'prefetch', type: 'boolean', group: T('AI 导演', 'AI director'), label: T('提前分析下一首', 'Prepare the next song'),
    description: T('当前歌放着时，就先分析好队列里的下一首（只支持在线歌曲）', 'Analyse the next queued song in the background'), defaultValue: true },
  { key: 'provider', type: 'select', group: T('接口', 'API'), label: T('服务商', 'Provider'),
    description: T('任何兼容 OpenAI 接口的服务都能用；列表里没有的选“自定义”并填接口地址', 'Any OpenAI-compatible API works'), defaultValue: 'custom', options: PROVIDER_OPTIONS },
  { key: 'baseUrl', type: 'text', group: T('接口', 'API'), label: T('接口地址', 'API base URL'),
    description: T('选了服务商可以留空；填了就以这里为准', 'Leave empty to use the provider preset'), defaultValue: '', placeholder: 'https://api.example.com/v1' },
  { key: 'model', type: 'text', group: T('接口', 'API'), label: T('模型', 'Model'),
    description: T('推荐便宜、快、不带思考的模型。不确定就运行命令“花笺：测试 AI 连接”看可用列表', 'A fast model without reasoning'), defaultValue: '', placeholder: 'deepseek-chat / qwen-plus / gpt-4o-mini …' },
  { key: 'apiKey', type: 'secret', group: T('接口', 'API'), label: T('API 密钥', 'API key'),
    description: T('由 Folia 加密保存。本机模型（Ollama、LM Studio）可以不填', 'Stored encrypted by Folia') },
  { key: 'thinking', type: 'select', group: T('接口', 'API'), label: T('关闭“思考”', 'Turn reasoning off'),
    description: T('这个任务用不上思考，开着会慢很多、贵很多。“自动”按服务商选择关闭方式', 'Not needed here; "auto" picks the switch'), defaultValue: 'auto', options: [
      { value: 'auto', label: T('自动（推荐）', 'Auto (recommended)') },
      { value: 'thinking', label: T('thinking: disabled（DeepSeek、智谱、豆包）', 'thinking: disabled') },
      { value: 'enable_thinking', label: T('enable_thinking: false（通义千问、硅基流动）', 'enable_thinking: false') },
      { value: 'reasoning_effort', label: T('reasoning_effort: low（OpenAI、Gemini）', 'reasoning_effort: low') },
      { value: 'none', label: T('不发送（模型本身不思考时）', 'Send nothing') },
    ] },
  { key: 'temperature', type: 'number', group: T('接口', 'API'), label: T('温度', 'Temperature'),
    description: T('越低越稳定，越高越有变化', 'Lower is steadier'), defaultValue: 0.3, min: 0, max: 1, step: 0.05 },
];

/** Under the mode picker: how it looks. */
const VISUAL_SETTINGS = [
  { key: 'motion', type: 'number', label: T('动感', 'Motion'), description: T('字的起伏、镜头呼吸和鼓点反应的幅度', 'How much text and camera move'), defaultValue: 1, min: 0.3, max: 1.6, step: 0.05 },
  { key: 'particles', type: 'number', label: T('粒子密度', 'Particle density'), description: T('雨、雪、光点、火花的多少；0 为不显示', 'How many particles; 0 hides them'), defaultValue: 1, min: 0, max: 1.5, step: 0.05 },
  { key: 'fontScale', type: 'number', label: T('字号', 'Text size'), defaultValue: 1, min: 0.7, max: 1.5, step: 0.05 },
  { key: 'typeface', type: 'select', label: T('字体', 'Typeface'), defaultValue: 'theme', options: [
    { value: 'theme', label: T('跟随主题', 'Theme font') },
    { value: 'serif', label: T('宋体（衬线）', 'Serif') },
    { value: 'sans', label: T('黑体（无衬线）', 'Sans') },
  ] },
  { key: 'ornaments', type: 'boolean', label: T('版式装饰', 'Ornaments'), description: T('细线、边框、页码和印章', 'Hairlines, frames, numerals and seals'), defaultValue: true },
  { key: 'grain', type: 'boolean', label: T('胶片颗粒', 'Film grain'), defaultValue: true },
  { key: 'quality', type: 'select', label: T('画质', 'Quality'), description: T('“自动”在电脑吃力时自动减少粒子；“省电”限制在 30 帧', '"Auto" thins particles under load; "Eco" caps at 30 fps'), defaultValue: 'auto', options: [
    { value: 'auto', label: T('自动', 'Auto') },
    { value: 'high', label: T('高', 'High') },
    { value: 'eco', label: T('省电', 'Eco') },
  ] },
  { key: 'showDirector', type: 'boolean', label: T('显示导演信息', 'Show director info'), description: T('在左下角显示 AI 对这首歌的判断、当前版式和性能', 'Shows the reading, the scene and the frame cost'), defaultValue: false },
];

export default async function activate(folium) {
  if ((folium.host?.folium?.minor ?? 0) < 7) {
    folium.log.warn('花笺需要 Folium 1.7（Folia 0.7.22 起）才能使用 AI 导演；动画仍可用本地导演运行');
  }

  const section = folium.registries.settingsSections.register({
    id: 'main',
    label: T('花笺', 'Huajian'),
    description: T('AI 导演：选服务商、填模型名和 API 密钥，然后运行命令“花笺：测试 AI 连接”', 'Pick a provider, model and key, then run "Huajian: test AI connection"'),
    settings: SECTION_SETTINGS,
  });
  const config = () => {
    const values = section.settings.get();
    return {
      ai: values.ai !== false,
      prefetch: values.prefetch !== false,
      provider: String(values.provider ?? 'custom'),
      baseUrl: String(values.baseUrl ?? '').trim(),
      model: String(values.model ?? '').trim(),
      thinking: String(values.thinking ?? 'auto'),
      temperature: Number(values.temperature ?? 0.5),
    };
  };

  const store = createStore(folium.storage, folium.log);
  const director = createDirector({ folium, store, getConfig: config });
  section.settings.onChange(() => director.onSetupChanged());
  folium.secrets?.subscribe?.((key) => {
    if (key === 'apiKey') director.onSetupChanged();
  });

  folium.registries.visualizers.register({
    id: 'stage',
    label: T('花笺', 'Huajian'),
    order: 420,
    settings: VISUAL_SETTINGS,
    mount: (container, ctx) => mountStage({ folium, container, ctx, director }),
  });

  const command = (id, zh, en, run, keywords = []) => folium.registries.commands.register({
    id,
    label: T(zh, en),
    keywords: ['花笺', 'huajian', '歌词动画', ...keywords],
    run,
  });
  command('test', '花笺：测试 AI 连接', 'Huajian: test AI connection', async () => {
    const report = await director.testConnection();
    if (report.chatError) return `连接失败：${report.chatError}`;
    if (!report.chat) return report.modelsError ? `获取模型失败：${report.modelsError}` : `连接正常，可用模型 ${report.models?.length ?? 0} 个，请在设置里填模型名`;
    return `连接正常：${report.chat.ms} ms${report.chat.thought ? '，但模型在“思考”，建议在设置里换一种关闭思考的方式' : ''}`;
  }, ['测试', '连接']);
  command('reanalyze', '花笺：让 AI 重新分析这首歌', 'Huajian: re-analyse this song', () => director.reanalyze(), ['重新', '分析']);
  command('describe', '花笺：AI 怎么理解这首歌', 'Huajian: how the AI reads this song', () => director.describe(), ['理解', '情绪']);
  command('usage', '花笺：AI 用量', 'Huajian: AI usage', async () => {
    const usage = await director.usage();
    return `已分析 ${usage.calls} 次，记住 ${usage.songs} 首；累计 ${usage.input} 输入 / ${usage.output} 输出 token`;
  }, ['用量', '花费']);

  // Developer builds only (node dev/build.mjs --dev): the release has no evaluator.
  const evaluator = createEvaluator?.({ folium, store, director }) ?? null;
  if (evaluator) {
    command('evaluate', '花笺（开发）：运行评测集', 'Huajian (dev): run the evaluation set', () => evaluator.evaluate(), ['评测', 'eval']);
    command('evaluate-force', '花笺（开发）：重新问 AI 并运行评测集', 'Huajian (dev): re-ask the AI and evaluate', () => evaluator.evaluate({ force: true }), ['评测', 'eval']);
  }

  return () => director.dispose();
}
