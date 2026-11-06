// The local reading of a song, used until (or instead of) the AI director: how
// dark or bright, how still or intense, how cold or warm, and which imagery
// the words keep returning to. Inputs are the lyric, the title and Folia's own
// AI theme (its name and description, e.g. “雨夜思念”), which is free to read.

import { clamp } from './motion.mjs';

const SAD = ['泪', '哭', '痛', '伤', '孤单', '孤独', '寂寞', '离开', '分手', '再见', '告别', '遗憾', '回忆', '想念', '思念', '错过', '失去',
  '后悔', '心碎', '难过', '悲', '等待', '放手', '不再', '曾经', '叹', '苦', '碎', '散', '忘', '梦醒', '一个人', '空', '冷', '黑夜', '凋',
  'lonely', 'cry', 'tears', 'goodbye', 'miss', 'alone', 'broken', 'sorry', 'lost', 'pain', 'hurt', 'gone', 'cold', 'regret', 'fade', 'empty', 'sad'];
const BRIGHT = ['笑', '快乐', '开心', '阳光', '自由', '飞', '跳', '奔跑', '梦想', '青春', '燃', '嗨', '耶', '幸福', '甜', '希望', '未来', '一起',
  '派对', '舞', '庆祝', 'happy', 'smile', 'sunshine', 'dance', 'party', 'free', 'fly', 'shine', 'yeah', 'fun', 'alive', 'tonight', 'together', 'jump'];
const CALM = ['轻', '慢', '静', '温柔', '晚风', '安静', '呼吸', '睡', '摇篮', 'soft', 'slow', 'quiet', 'gentle', 'breeze', 'calm', 'sleep'];
const INTENSE = ['燃', '冲', '炸', '狂', '吼', '战', 'burn', 'loud', 'wild', 'shout', 'fight', 'rock'];
const WARM = ['阳光', '火', '夏', '暖', '金', '黄昏', '夕阳', '灯', 'sun', 'summer', 'warm', 'gold', 'fire'];
const COLD = ['冷', '雪', '冬', '蓝', '雨', '夜', '冰', '霜', '海', 'cold', 'snow', 'winter', 'blue', 'rain', 'ice', 'night'];

/** Imagery → the ambient element that draws it. */
const IMAGERY = {
  rain: ['雨', 'rain'],
  snow: ['雪', 'snow', '冬天', 'winter'],
  petals: ['花', '樱', 'flower', 'bloom', 'petal', 'blossom', '春天'],
  stars: ['星', '银河', '宇宙', '月', 'star', 'galaxy', 'moon', 'universe'],
  fireflies: ['萤', '夏夜', 'firefly', 'fireflies', '灯火'],
  embers: ['火', '烟', '灰烬', '余烬', '落叶', '秋', 'fire', 'ember', 'ash', 'autumn'],
};

const LATIN = /^[a-z' ]+$/;
const patternCache = new Map();
const patternOf = (word) => {
  if (!patternCache.has(word)) {
    // Latin words match at a word start, so "sad" counts "sadness" and "cry" counts "crying".
    patternCache.set(word, LATIN.test(word) ? new RegExp(`\\b${word}`, 'g') : new RegExp(word, 'g'));
  }
  return patternCache.get(word);
};
const count = (text, words) => words.reduce((sum, word) => sum + (text.match(patternOf(word))?.length ?? 0), 0);

/**
 * `{ valence, energy, warmth, weather, imagery }`, each 0..1 but weather (an
 * ambient element name). `theme` is the Folia theme (may be null).
 */
export const localMood = ({ analysis, song, theme, audio = null }) => {
  const lyric = analysis.sung.map((item) => item.text).join('\n').toLowerCase();
  const themeText = `${theme?.name ?? ''} ${theme?.description ?? ''}`.toLowerCase();
  const title = String(song?.title ?? '').toLowerCase();
  // The title and the theme description say more per word than any one line: counted three times.
  const text = `${lyric}\n${themeText}\n${themeText}\n${themeText}\n${title}\n${title}\n${title}`;

  const sad = count(text, SAD);
  const bright = count(text, BRIGHT);
  // Shrunk toward neutral when the words say little: one sad word must not make a love song tragic.
  const valence = clamp(0.5 + 0.5 * ((bright - sad) / (bright + sad + 3)), 0.05, 0.95);

  // Energy from how densely the words are sung, exclamations and word choice.
  const singing = analysis.sung.reduce((sum, item) => sum + Math.max(0.2, item.end - item.start), 0);
  // Sung syllables, not characters: a CJK character is one, a Latin word about 1.3 (counting letters
  // made every English song read as energetic).
  const chars = analysis.sung.reduce((sum, item) => {
    const latinWords = item.text.match(/[A-Za-zÀ-ɏ']+/g)?.length ?? 0;
    const others = Array.from(item.text.replace(/[A-Za-zÀ-ɏ'\s]+/g, '')).length;
    return sum + others + latinWords * 1.3;
  }, 0);
  const density = singing > 0 ? chars / singing : 3;
  const exclaim = (lyric.match(/[!！]/g)?.length ?? 0) / Math.max(1, analysis.sung.length);
  let energy = 0.18 + clamp((density - 2) / 5) * 0.5 + clamp(exclaim) * 0.15;
  energy += 0.08 * Math.tanh((count(text, INTENSE) - count(text, CALM)) / 3);
  energy += (valence - 0.5) * 0.25;
  const intensity = theme?.animationIntensity;
  if (intensity === 'chaotic') energy += 0.1;
  if (intensity === 'calm') energy -= 0.1;
  // Calibrated on the M1 evaluation: lyrics alone read ~0.3 lower than the AI (which also knows
  // the songs) across all 28 songs, and quiet songs bottomed out at 0.05. A plain affine lift.
  energy = clamp(0.3 + 0.75 * clamp(energy, 0.05, 0.95), 0.05, 0.95);

  // What the song sounded like, when it has been heard: tempo and loudness lift or calm the energy,
  // a clear major or minor key nudges the brightness. shortcut: uncalibrated weights, refit them
  // against the AI's readings (dir:* entries) once enough songs have audio features.
  if (audio?.bpm && audio.confidence >= 0.4) {
    const tempo = clamp((audio.bpm - 70) / 90);
    const loud = audio.loudness === null ? 0.5 : clamp((audio.loudness - 0.35) / 0.4);
    energy = clamp(0.5 * energy + 0.5 * (0.15 + 0.45 * tempo + 0.4 * loud), 0.05, 0.95);
  }
  let shade = 0;
  if (audio?.mode && audio.modeConfidence >= 0.3) shade = (audio.mode === 'major' ? 0.06 : -0.06) * audio.modeConfidence;

  const warmth = clamp(0.5 + 0.3 * Math.tanh((count(text, WARM) - count(text, COLD)) / 3) + (valence - 0.5) * 0.35, 0.05, 0.95);

  const imagery = Object.entries(IMAGERY)
    .map(([weather, words]) => [weather, count(text, words)])
    .sort((a, b) => b[1] - a[1]);
  const [topWeather, topCount] = imagery[0];
  let weather;
  if (topCount >= 2) weather = topWeather;
  else if (valence < 0.42) weather = 'dust';
  else if (valence > 0.62 && energy > 0.55) weather = 'dust';
  else weather = warmth > 0.55 ? 'fireflies' : 'dust';

  return { valence: clamp(valence + shade, 0.05, 0.95), energy, warmth, weather, imagery: imagery.filter(([, n]) => n > 0).map(([name]) => name) };
};
