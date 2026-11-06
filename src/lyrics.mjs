// Lyric analysis shared by the planner and the stage: which lines are credits,
// which belong to the chorus, when each character lights up, and how the song
// falls into paragraphs (the unit a scene is chosen for).
//
// Paragraphs follow the rules Folia's own paragraph analysis uses: split where
// the gap between lines is well above the song's usual gap (median × 2.5,
// clamped to 1.25–3.5 s) or where the source's song part changes; a paragraph
// longer than 6 lines or 18 s is split again at its largest gap.

import { clamp } from './motion.mjs';

const CREDIT_PATTERN = /^\s*(作词|作曲|编曲|词|曲|制作人|监制|出品|发行|混音|母带|录音|和声|和音|配唱|吉他|贝斯|鼓|键盘|弦乐|钢琴|企划|统筹|OP|SP|ISRC|Lyrics?|Lyricist|Composer|Compose[rd]?|Arrange[rd]?|Arrangement|Producer|Produced|Mix(?:ed|ing)?|Master(?:ed|ing)?)\s*(by)?\s*[:：]/i;
const NOTICE_PATTERN = /(未经|著作权|版权所有|享有本翻译作品|TME|QQ音乐|网易云音乐|酷狗)/;
export const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;
const SPACE = /\s/u;
const LIFT_PUNCT = /[!?！？…]/g;

const MAX_LINES = 6;
const MAX_SPAN_SEC = 18;

/** Per-song key: `source:id`, or `title|artist` when there is no id (Folium's advice). */
export const songKeyOf = (song) => {
  if (!song) return null;
  if (song.id) return `${song.source ?? 'unknown'}:${song.id}`;
  if (song.title) return `t:${song.title}|${song.artist ?? ''}`;
  return null;
};

export const normalizeText = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
export const isCredit = (text) => CREDIT_PATTERN.test(text) || NOTICE_PATTERN.test(text);

/** Share of wide (CJK) characters among the visible ones. */
export const wideShare = (text) => {
  const chars = Array.from(String(text)).filter((char) => !SPACE.test(char));
  if (chars.length === 0) return 0;
  return chars.filter((char) => WIDE.test(char)).length / chars.length;
};

/* Words in a line, counting a CJK character as half a word (about how fast they are sung). */
const wordCount = (text) => {
  const latin = String(text).match(/[A-Za-z0-9À-ɏ']+/g)?.length ?? 0;
  const wide = Array.from(String(text)).filter((char) => WIDE.test(char)).length;
  return latin + wide / 2;
};

/**
 * When each character lights up: one entry per character of `Array.from(line.fullText)`,
 * `{ start, end }` in lyric seconds, or null for spaces. Word timings are used when they
 * match the visible characters; otherwise the line's time is spread evenly.
 */
export const charTimings = (line) => {
  const chars = Array.from(String(line?.fullText ?? ''));
  const visible = chars.filter((char) => !SPACE.test(char)).length;
  const fromWords = [];
  for (const word of line?.words ?? []) {
    const wordChars = Array.from(String(word.text ?? '')).filter((char) => !SPACE.test(char));
    const duration = Math.max(0.001, word.endTime - word.startTime);
    wordChars.forEach((_, index) => {
      fromWords.push({
        start: word.startTime + (duration * index) / wordChars.length,
        end: word.startTime + (duration * (index + 1)) / wordChars.length,
      });
    });
  }
  const useWords = fromWords.length === visible && visible > 0;
  const start = Number(line?.startTime) || 0;
  const span = Math.max(0.2, ((Number(line?.endTime) || start + 1) - start) * 0.85);
  let cursor = 0;
  return chars.map((char) => {
    if (SPACE.test(char)) return null;
    const index = cursor;
    cursor += 1;
    if (useWords) return fromWords[index];
    return { start: start + (span * index) / visible, end: start + (span * (index + 1)) / visible };
  });
};

/* Lengths of runs of equal chorus marks, so a lone repeated line does not split a paragraph. */
const runLengths = (flags) => {
  const lengths = new Array(flags.length).fill(1);
  let begin = 0;
  for (let i = 1; i <= flags.length; i += 1) {
    if (i === flags.length || flags[i] !== flags[begin]) {
      for (let k = begin; k < i; k += 1) lengths[k] = i - begin;
      begin = i;
    }
  }
  return lengths;
};

const splitLong = (group, items) => {
  const span = items[group[group.length - 1]].end - items[group[0]].start;
  if (group.length < 2 || (group.length <= MAX_LINES && span <= MAX_SPAN_SEC)) return [group];
  let best = 1;
  let bestScore = -Infinity;
  for (let k = 1; k < group.length; k += 1) {
    const gap = items[group[k]].start - items[group[k - 1]].end;
    const balance = 1 - Math.abs(k - group.length / 2) / group.length;
    const score = gap + balance * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return [...splitLong(group.slice(0, best), items), ...splitLong(group.slice(best), items)];
};

const kindOf = (paragraph, items, isFirst, isLast) => {
  const lines = paragraph.lines.map((index) => items[index]);
  const chorusShare = lines.filter((item) => item.chorus).length / lines.length;
  const span = paragraph.end - paragraph.start;
  const text = lines.map((item) => item.text).join(' ');
  const words = wordCount(text);
  const singing = lines.reduce((sum, item) => sum + Math.max(0.2, item.end - item.start), 0);
  if (chorusShare >= 0.5) return 'chorus';
  if (span <= 3.5 || words <= 3) return 'breath';
  if (isLast) return 'outro';
  if (isFirst) return 'intro';
  if ((text.match(LIFT_PUNCT)?.length ?? 0) >= 2 || words / singing > 2.5) return 'lift';
  return 'verse';
};

/**
 * `{ items, paragraphs, sung }`: items are the non-empty lines with their timing and
 * marks; paragraphs index into items. Credits at the top of the lyric form their own
 * `credits` paragraph.
 */
export const analyzeLyrics = (lines) => {
  const items = [];
  (Array.isArray(lines) ? lines : []).forEach((line, index) => {
    const text = String(line?.fullText ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const start = Number(line.startTime) || 0;
    const end = Math.max(start + 0.2, Number(line.endTime) || start + 0.2);
    const renderEnd = Math.max(end, Number(line.renderHints?.renderEndTime) || end);
    items.push({ index, line, text, start, end, renderEnd, credit: isCredit(text), wide: wideShare(text), chorus: false });
  });

  // Credits count only before the first sung line; later look-alikes are lyrics.
  let sungYet = false;
  for (const item of items) {
    if (!item.credit) sungYet = true;
    else if (sungYet) item.credit = false;
  }

  // Chorus: the source's mark, or a recurring line inside a run of recurring lines
  // (sources tag only part of the chorus; a lone repeated "oh" is not one).
  const counts = new Map();
  for (const item of items) {
    const key = normalizeText(item.text);
    if (!item.credit && key.length >= 2) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = items.map((item) => !item.credit && (counts.get(normalizeText(item.text)) ?? 0) >= 2);
  items.forEach((item, i) => {
    item.chorus = Boolean(item.line.isChorus) || (repeated[i] && (repeated[i - 1] || repeated[i + 1]));
  });

  const paragraphs = [];
  const creditIndexes = items.map((_, i) => i).filter((i) => items[i].credit);
  if (creditIndexes.length > 0) paragraphs.push({ lines: creditIndexes, kind: 'credits' });

  const sung = items.map((_, i) => i).filter((i) => !items[i].credit);
  if (sung.length > 0) {
    const gaps = [];
    for (let k = 0; k < sung.length - 1; k += 1) gaps.push(Math.max(0, items[sung[k + 1]].start - items[sung[k]].end));
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;
    const threshold = clamp(median * 2.5, 1.25, 3.5);
    const runs = runLengths(sung.map((i) => items[i].chorus));

    const groups = [];
    let group = [sung[0]];
    for (let k = 1; k < sung.length; k += 1) {
      const a = items[sung[k - 1]];
      const b = items[sung[k]];
      const partChange = Boolean(a.line.songPart && b.line.songPart && a.line.songPart !== b.line.songPart);
      const blockChange = Number.isFinite(a.line.blockIndex) && Number.isFinite(b.line.blockIndex) && a.line.blockIndex !== b.line.blockIndex;
      const chorusChange = a.chorus !== b.chorus && runs[k] >= 2 && runs[k - 1] >= 2;
      if (gaps[k - 1] > threshold || partChange || blockChange || chorusChange) {
        groups.push(group);
        group = [];
      }
      group.push(sung[k]);
    }
    groups.push(group);
    for (const g of groups) for (const part of splitLong(g, items)) paragraphs.push({ lines: part, kind: null });
  }

  const sungParagraphs = paragraphs.filter((p) => p.kind !== 'credits');
  let ordinal = 0;
  paragraphs.forEach((paragraph, index) => {
    const lineItems = paragraph.lines.map((i) => items[i]);
    paragraph.index = index;
    paragraph.start = Math.min(...lineItems.map((item) => item.start));
    paragraph.end = Math.max(...lineItems.map((item) => item.renderEnd));
    paragraph.text = lineItems.map((item) => item.text).join('\n');
    paragraph.wide = lineItems.reduce((sum, item) => sum + item.wide, 0) / lineItems.length;
    paragraph.chorus = lineItems.filter((item) => item.chorus).length * 2 >= lineItems.length;
    if (paragraph.kind !== 'credits') {
      paragraph.ordinal = ordinal;
      ordinal += 1;
      const position = sungParagraphs.indexOf(paragraph);
      paragraph.kind = kindOf(paragraph, items, position === 0, position === sungParagraphs.length - 1 && sungParagraphs.length > 2);
    } else {
      paragraph.ordinal = -1;
    }
  });

  // Same text as an earlier paragraph (a chorus coming back): remember which.
  const firstByText = new Map();
  for (const paragraph of paragraphs) {
    const key = normalizeText(paragraph.text);
    if (firstByText.has(key)) paragraph.repeatOf = firstByText.get(key);
    else firstByText.set(key, paragraph.index);
  }

  return { items, paragraphs, sung: items.filter((item) => !item.credit) };
};

/** A fingerprint of the sung text: cached directions are only reused for the same lyric. */
export const lyricFingerprint = (analysis) => {
  let h = 2166136261 >>> 0;
  for (const item of analysis.sung) {
    for (const char of normalizeText(item.text)) {
      h ^= char.codePointAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return `${analysis.paragraphs.length}:${h.toString(36)}`;
};
