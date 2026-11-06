// A song's "direction": how it feels and how each paragraph should be staged.
// The AI director writes one per song (one call, cached); the local reading in
// mood.mjs stands in when there is no AI, no network, or while the call runs.
// The planner (plan.mjs) turns a direction into the exact scene schedule, so a
// direction only names choices from fixed vocabularies and never draws anything.

import { clamp } from './motion.mjs';
import { localMood } from './mood.mjs';
import { normalizeText, WIDE } from './lyrics.mjs';

export const DIRECTION_VERSION = 1;

export const SCENES = {
  center: '居中独白：一句居中，细线随演唱生长，克制、通用',
  stanza: '诗稿：靠一侧排成竖向堆叠的诗行，旧句变淡上移，像手写稿，适合叙事、回忆、伤感',
  vertical: '竖排：中文竖排从右往左，配印章，古典、留白，适合安静伤感或中国风（只适合中文短句）',
  hero: '巨字：把关键词放成巨大的空心字压在背后，歌词在前，适合副歌、情绪最满的地方',
  collage: '拼贴：词块错落、带色块底板，跳跃热闹，只适合欢快有力的段落',
  whisper: '低语：小字偏在一角，大量留白，适合前奏、间奏、尾声、气口',
};
export const WEATHERS = {
  none: '无',
  dust: '浮尘：缓慢漂浮的光点，最百搭',
  rain: '雨丝：斜落的细雨，伤感、思念',
  snow: '飘雪：慢慢飘落，冷、安静、怀念',
  petals: '落花：飘落的花瓣，温柔、青春、告别',
  fireflies: '萤火：忽明忽暗的光点，夏夜、温柔、童年',
  embers: '余烬：向上飘升的火星，怀旧、燃尽、不舍',
  stars: '星空：闪烁的星和偶尔的流星，夜晚、遥远、孤独',
};
export const MOTIONS = {
  gentle: '静：字像墨晕开、雨滴落下、镜头对焦那样慢慢出现，缓慢推拉，溶解转场',
  lyrical: '抒：字升起、翻转、波浪式出现，演唱时轻轻鼓起，推拉摇移，柔和转场',
  dramatic: '烈而不闹：盖章、冲镜、拉伸、乱码解码，闪白和故障切换，适合伤感或悲壮的高潮',
  punchy: '燃：弹跳、落下回弹、爆开、故障，甩镜和闪切，词块配色板，只适合欢快热烈的段落',
};
export const ACCENTS = {
  sparkler: '线香花火：一点小小的火花噼啪作响，伤感歌的高潮和回忆最合适',
  fireworks: '烟花：在夜空绽放，只用于真正热烈欢快的段落',
};

const SECTION_LABELS = { intro: '前奏后首段', verse: '主歌', lift: '推进', chorus: '副歌', breath: '气口', outro: '尾声' };

const clock = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const list = (vocab) => Object.entries(vocab).map(([key, text]) => `  - ${key}：${text}`).join('\n');

const SYSTEM = `你是歌词动画的视觉导演。读懂一首歌后，为它写一份分镜方向，供渲染器执行。只输出一个 JSON 对象，不要任何解释。

字段：
- summary：一句话（不超过 24 字）说出这首歌的情绪和画面。
- valence：0~1，情绪明暗。0 极度伤感，0.5 平静或复杂，1 明亮欢快。
- energy：0~1，整首歌的能量。0 静谧，1 激烈。
- warmth：0~1，色温。0 冷，1 暖。
- palette：2~4 个 #rrggbb，用于粒子和装饰。要和情绪一致、彼此和谐、偏柔和；只有热烈欢快的歌才用高饱和色。
- weather：整首歌的氛围元素，从下面选一个：
${list(WEATHERS)}
- seal：最能代表这首歌的一个汉字，盖成印章；英文歌可以给空字符串。
- sections：数组。对用户给出的每个段落 P 各给一项：{"p": 段落编号, "energy": 0~1 这一段的能量, "motion": 动态风格, "scene": 版式, "weather": 这一段的元素, "burst": 0~1 火花或烟花的强度, "keyword": 这一段最值得放大的一个词}
  motion 决定字怎么进场、怎么唱、怎么退场，以及镜头和转场的力度，从下面选：
${list(MOTIONS)}
  scene 从下面选：
${list(SCENES)}
  weather 可以沿用整首的元素，也可以从上面的氛围元素或下面的点睛元素里选：
${list(ACCENTS)}
  点睛元素要省着用：一首歌最多 2~4 个段落用 sparkler 或 fireworks，留给副歌和最高潮，其余段落用氛围元素。
  burst 只在 weather 是 sparkler 或 fireworks 时有意义，其他填 0。
  keyword 必须是这一段歌词里原样出现的词（2~6 个字或 1~2 个英文单词），用歌词原文的语言，英文歌给英文、日文歌给日文原文，不要翻译；没有合适的就给空字符串。

导演原则：
1. 以歌词的真实情绪为准。旋律欢快但歌词伤感（悲伤的快歌、强颜欢笑）时，压低 valence，但保留 energy。
2. 整首要有起伏：主歌克制，副歌展开，尾声收束。相邻段落尽量不用同一个 scene。
3. 伤感、安静的歌不要用 fireworks、collage 和 punchy；它的高潮用 dramatic、hero、sparkler 或更浓的氛围元素来表达。
3.1 动态要有层次：前奏和主歌多用 gentle 或 lyrical，副歌升一级，最后一次副歌最强，尾声回到 gentle。
4. 重复出现的副歌可以沿用第一次的 scene，最后一次副歌可以更满。
5. 留白也是表达，不要每段都很满。`;

/**
 * `{ system, user }` for one song. Paragraph numbers are the analysis' paragraph
 * indexes; credits are left out; a repeated paragraph is shown once and referenced.
 */
export const buildPrompt = ({ analysis, song, theme, duration, audio = null }) => {
  const rows = [
    `歌名：${clip(song?.title, 60) || '（未知）'}`,
    `歌手：${clip(song?.artist, 60) || '（未知）'}`,
  ];
  if (song?.album) rows.push(`专辑：${clip(song.album, 60)}`);
  if (theme?.description) rows.push(`播放器为这首歌生成的主题：${clip(theme.name, 20)}（${clip(theme.description, 120)}）`);
  if (duration > 0) rows.push(`时长：${clock(duration)}`);
  if (audio?.bpm && audio.confidence >= 0.4) {
    const key = audio.key && audio.keyConfidence >= 0.4 ? `，${audio.key} ${audio.mode === 'minor' ? '小调' : '大调'}` : '';
    rows.push(`本机听出的音频特征：约 ${Math.round(audio.bpm)} BPM${key}（自动估算，可能有半拍或倍拍误差）`);
  }
  rows.push('', '段落（P 编号，[] 里是本地按结构判断的段落类型，仅供参考）：');
  for (const paragraph of analysis.paragraphs) {
    if (paragraph.kind === 'credits') continue;
    const label = SECTION_LABELS[paragraph.kind] ?? paragraph.kind;
    const head = `P${paragraph.index} [${label}] ${clock(paragraph.start)}–${clock(paragraph.end)}`;
    if (paragraph.repeatOf !== undefined) {
      rows.push(`${head}（歌词同 P${paragraph.repeatOf}）`);
      continue;
    }
    rows.push(head);
    for (const index of paragraph.lines) rows.push(`  ${clip(analysis.items[index].text, 60)}`);
  }
  if (!analysis.sung.length) rows.push('（纯音乐，没有歌词：sections 给空数组）');
  return { system: SYSTEM, user: rows.join('\n') };
};

const HEX = /^#[0-9a-f]{6}$/i;
const unit = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : clamp(Number(value)));

/* A keyword is kept only when it is really in the paragraph's lyric. */
const keywordIn = (paragraph, analysis, raw) => {
  const word = String(raw ?? '').trim().replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '');
  // 24: two English words ("summertime sadness") are often longer than 16 characters.
  if (!word || Array.from(word).length > 24) return '';
  const target = normalizeText(word);
  if (target.length < 1) return '';
  const hit = paragraph.lines.some((index) => normalizeText(analysis.items[index].text).includes(target));
  return hit ? word : '';
};

/**
 * Checks and clamps a model's answer. Throws when the song-level reading is
 * missing (nothing usable); drops any section field outside the vocabularies.
 */
export const validateDirection = (json, analysis) => {
  if (!json || typeof json !== 'object') throw new Error('不是 JSON 对象');
  const valence = unit(json.valence);
  const energy = unit(json.energy);
  if (valence === null || energy === null) throw new Error('缺少 valence 或 energy');
  const palette = (Array.isArray(json.palette) ? json.palette : [])
    .map((color) => String(color).trim())
    .filter((color) => HEX.test(color))
    .slice(0, 4);
  const sealChar = Array.from(String(json.seal ?? '')).find((char) => WIDE.test(char)) ?? '';
  const sections = [];
  for (const raw of Array.isArray(json.sections) ? json.sections : []) {
    const p = Number.parseInt(raw?.p ?? String(raw?.P ?? '').replace(/^P/i, ''), 10);
    const paragraph = analysis.paragraphs[p];
    if (!paragraph || paragraph.kind === 'credits' || sections.some((s) => s.p === p)) continue;
    const scene = SCENES[raw.scene] ? raw.scene : null;
    const weather = WEATHERS[raw.weather] || ACCENTS[raw.weather] ? raw.weather : null;
    sections.push({
      p,
      energy: unit(raw.energy),
      motion: MOTIONS[raw.motion] ? raw.motion : null,
      scene,
      weather,
      burst: unit(raw.burst),
      keyword: keywordIn(paragraph, analysis, raw.keyword),
    });
  }
  return {
    v: DIRECTION_VERSION,
    src: 'ai',
    summary: String(json.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    valence,
    energy,
    warmth: unit(json.warmth) ?? 0.5,
    palette: palette.length >= 2 ? palette : [],
    weather: WEATHERS[json.weather] ? json.weather : null,
    seal: sealChar,
    sections,
  };
};

/** The direction without AI: the local mood, no per-section choices (the planner decides). */
export const localDirection = ({ analysis, song, theme, audio = null }) => {
  const mood = localMood({ analysis, song, theme, audio });
  return {
    v: DIRECTION_VERSION,
    src: 'local',
    summary: '',
    valence: mood.valence,
    energy: mood.energy,
    warmth: mood.warmth,
    palette: [],
    weather: mood.weather,
    seal: '',
    sections: [],
  };
};
