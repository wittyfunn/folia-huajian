// Shot layouts: where every character of a shot sits, relative to the shot's
// center. A line is first cut into phrases (the spaces Chinese lyrics already
// use, then word segments) and each layout arranges phrases with a hierarchy:
// one hero phrase large, the others smaller, the way a poster is set.
//
// Word shots (after Folia's 商籁) set every word of one to four lines around a
// main word three to five times their size: orbit, ribbon, column, scatter,
// impact, tableau. Single lines: centerBig, stack, split, hero, type. Pages set
// a whole paragraph (each line appears when sung and stays): page (a
// manuscript stanza) and vertical (columns read right to left).

import { WIDE } from './lyrics.mjs';
import { hash01 } from './random.mjs';
import { clamp } from './motion.mjs';

const SPACE = /\s/u;
/* Chinese particles and light words that should not lead a headline word. */
const FUNCTION_CHARS = new Set(Array.from('的了着过吗呢吧啊呀嘛么就都也还又在是和与把被让给从向往对'));
const CLOSING = /[，。、；：！？）》」』】〕…—,.;:!?)\]}'"”’]/u;

let probe = null;
const measure = (font, char) => {
  probe ??= document.createElement('canvas').getContext('2d');
  if (probe.font !== font) probe.font = font;
  return probe.measureText(char).width;
};

/* Phrases of a line: runs between spaces; a long CJK run is cut again at word boundaries. */
export const phrasesOf = (chars, segments, maxPieces = 4) => {
  const phrases = [];
  let current = null;
  chars.forEach((char, ci) => {
    if (SPACE.test(char)) {
      current = null;
      return;
    }
    if (!current) {
      current = { start: ci, end: ci + 1 };
      phrases.push(current);
    } else {
      current.end = ci + 1;
    }
  });
  // Cut the longest phrase at a word boundary until there are enough pieces (or none is long).
  const boundaries = segmentMarks(chars, segments).starts;
  const visible = (p) => p.end - p.start;
  for (let guard = 0; guard < 6 && phrases.length < maxPieces; guard += 1) {
    const longest = [...phrases].sort((a, b) => visible(b) - visible(a))[0];
    if (!longest || visible(longest) < 6) break;
    const mid = longest.start + visible(longest) / 2;
    let cut = -1;
    let best = Infinity;
    for (let k = longest.start + 2; k <= longest.end - 2; k += 1) {
      if (!boundaries.has(k)) continue;
      if (Math.abs(k - mid) < best) {
        best = Math.abs(k - mid);
        cut = k;
      }
    }
    if (cut < 0) cut = Math.round(mid);
    const at = phrases.indexOf(longest);
    phrases.splice(at, 1, { start: longest.start, end: cut }, { start: cut, end: longest.end });
  }
  // Merge one-character orphans into a neighbour (a lone 啊 is not a phrase).
  for (let i = phrases.length - 1; i >= 0 && phrases.length > 1; i -= 1) {
    if (visible(phrases[i]) <= 1 && WIDE.test(chars[phrases[i].start])) {
      const into = i > 0 ? i - 1 : 1;
      const a = phrases[Math.min(i, into)];
      const b = phrases[Math.max(i, into)];
      phrases.splice(Math.min(i, into), 2, { start: a.start, end: b.end });
    }
  }
  return phrases;
};

/*
 * Where the segments start, in character (code point) positions, and which characters are
 * punctuation. A segment's own `index` (a UTF-16 offset into the line) is trusted; without one, the
 * segments are taken to follow each other. Folia's segmenter may leave out spaces (jieba, a saved
 * split), so lengths alone cannot be summed.
 */
const segmentMarks = (chars, segments) => {
  const atOffset = new Map();
  let utf16 = 0;
  chars.forEach((char, i) => {
    atOffset.set(utf16, i);
    utf16 += char.length;
  });
  atOffset.set(utf16, chars.length);
  const starts = new Set();
  const punctuation = new Set();
  let next = 0;
  for (const seg of segments ?? []) {
    const start = Number.isInteger(seg.index) && atOffset.has(seg.index) ? atOffset.get(seg.index) : next;
    const length = Array.from(String(seg.segment ?? '')).length;
    starts.add(start);
    if (!seg.isWordLike) for (let k = start; k < start + length; k += 1) punctuation.add(k);
    next = start + length;
  }
  return { starts, punctuation };
};

/* Words of a line, walked character by character so none is ever lost: a new word starts where a
 * segment starts; punctuation joins the word before it; a space ends a word and marks the next as
 * `spaced` (Latin words), otherwise words abut (Chinese). */
const wordsOf = (chars, segments) => {
  const { starts, punctuation } = segmentMarks(chars, segments);
  const words = [];
  let current = null;
  let spaced = false;
  chars.forEach((char, i) => {
    if (SPACE.test(char)) {
      current = null;
      spaced = true;
      return;
    }
    const mark = punctuation.has(i) || /\p{P}/u.test(char);
    if (current && (mark || !starts.has(i))) {
      current.end = i + 1;
      return;
    }
    current = { start: i, end: i + 1, spaced: words.length > 0 && spaced };
    words.push(current);
    spaced = false;
  });
  return words;
};

/* Particles that belong to the word before them. */
const PARTICLES = new Set(Array.from('的了着过吗呢吧啊呀嘛么哦喔哈'));

/*
 * A line cut the way it reads: phrases (a space ends one, as Chinese lyrics mark them; in Latin,
 * punctuation or every third word), each a list of units (words), a single Chinese character never
 * standing alone: a particle joins the word before it, any other the word after it.
 */
const readingPhrases = (line, li = 0) => {
  const visible = (start, end) => line.chars.slice(start, end).filter((c) => !SPACE.test(c)).length;
  const words = wordsOf(line.chars, line.segments)
    .map((w) => ({ ...w, li, len: visible(w.start, w.end), cjk: WIDE.test(line.chars[w.start]) }))
    .filter((w) => w.len > 0);
  const phrases = [];
  for (const w of words) {
    const last = phrases[phrases.length - 1];
    const prev = last?.words[last.words.length - 1];
    const latinBreak = last && !w.cjk && !prev.cjk && (/[,.;:!?，。；：！？]$/u.test(line.chars.slice(prev.start, prev.end).join('').trim()) || last.words.length >= 3);
    if (!last || (w.spaced && (w.cjk || prev.cjk)) || latinBreak) phrases.push({ li, words: [w] });
    else last.words.push(w);
  }
  const result = [];
  for (const p of phrases) {
    const units = [];
    let run = []; // consecutive single characters
    /* One or two loose characters join the next word (把没 + 说完), or the last word at the end; a
     * longer run (a segmenter that gave up: 比 / 鼓 / 点 / 还) is cut into pairs, the last of three. */
    const flush = (next) => {
      if (!run.length) return next;
      const loose = run;
      run = [];
      if (loose.length <= 2) {
        const start = loose[0].start;
        const end = loose[loose.length - 1].end;
        if (next) return { ...next, start, len: next.len + loose.length };
        if (units.length) {
          units[units.length - 1].end = end;
          units[units.length - 1].len += loose.length;
        } else {
          units.push({ ...loose[0], end, len: loose.length });
        }
        return null;
      }
      for (let k = 0; k < loose.length;) {
        const take = loose.length - k === 3 ? 3 : 2;
        units.push({ ...loose[k], end: loose[k + take - 1].end, len: take, loose: true });
        k += take;
      }
      return next;
    };
    for (const word of p.words) {
      const w = { ...word };
      const single = w.cjk && w.len === 1;
      if (single && PARTICLES.has(line.chars[w.start]) && !run.length && units.length) {
        units[units.length - 1].end = w.end;
        units[units.length - 1].len += 1;
        continue;
      }
      if (single) {
        run.push(w);
        continue;
      }
      units.push(flush(w));
    }
    flush(null);
    // A long phrase with no space in it (心跳比鼓点还要急) is cut once, at the word boundary nearest
    // its middle, so a set has more than one row to work with. The cut is soft: no gap opens there
    // when both halves share a row.
    const total = units.reduce((n, u) => n + u.len, 0);
    let cut = -1;
    if (units.length >= 2 && units[0].cjk && total >= 8) {
      let acc = 0;
      let best = Infinity;
      for (let k = 1; k < units.length; k += 1) {
        acc += units[k - 1].len;
        if (acc >= 3 && total - acc >= 3 && Math.abs(acc - total / 2) < best) {
          best = Math.abs(acc - total / 2);
          cut = k;
        }
      }
    }
    if (cut > 0) {
      units[cut] = { ...units[cut], softStart: true };
      result.push({ li: p.li, units: units.slice(0, cut) }, { li: p.li, units: units.slice(cut) });
    } else {
      result.push({ li: p.li, units });
    }
  }
  return result;
};

/* A row of characters at `size`: advances and glyph centers, from a start x. */
const setRow = (chars, start, end, size, font, tracking = 0) => {
  const entries = [];
  let x = 0;
  let width = 0;
  for (let ci = start; ci < end; ci += 1) {
    const char = chars[ci];
    const glyphWidth = measure(font(size), char);
    if (!SPACE.test(char)) {
      entries.push({ char, ci, x: x + glyphWidth / 2 });
      width = x + glyphWidth;
    }
    x += glyphWidth + (SPACE.test(char) ? 0 : tracking * size);
  }
  return { entries, width };
};

/* Wraps phrases into rows no wider than maxWidth (phrases are never split across rows). */
const wrapPhrases = (chars, phrases, size, font, maxWidth, tracking) => {
  const rows = [];
  let row = null;
  for (const phrase of phrases) {
    const candidate = row ? { start: row.start, end: phrase.end } : { start: phrase.start, end: phrase.end };
    const width = setRow(chars, candidate.start, candidate.end, size, font, tracking).width;
    if (row && width > maxWidth && !CLOSING.test(chars[phrase.start])) {
      rows.push(row);
      row = { start: phrase.start, end: phrase.end };
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(row);
  return rows;
};

/* Wraps into as few rows as maxWidth allows, then evens them out (no lone word on the last row):
 * the narrowest width that still gives that many rows. */
const wrapBalanced = (chars, phrases, size, font, maxWidth, tracking) => {
  let rows = wrapPhrases(chars, phrases, size, font, maxWidth, tracking);
  if (rows.length < 2) return rows;
  let lo = maxWidth * 0.45;
  let hi = maxWidth;
  for (let k = 0; k < 6; k += 1) {
    const mid = (lo + hi) / 2;
    const tried = wrapPhrases(chars, phrases, size, font, mid, tracking);
    if (tried.length > rows.length) lo = mid;
    else {
      hi = mid;
      rows = tried;
    }
  }
  return rows;
};

/**
 * @param {object} input
 * @param {{ chars: string[], segments: object[] }[]} input.lines shot lines (several on a page)
 * @param {string} input.layout layout name
 * @param {object} input.m metrics { W, H, fs }
 * @param {(size:number, weight?:number)=>string} input.font CSS font for a size
 * @param {{ line: number, charIndex: number, length: number } | null} input.keyword
 * @param {number} input.variant 0..1, picks among a layout's arrangements
 * @param {boolean} input.mirror
 * @param {boolean} [input.calm] a sad song: word shots enter without travel
 * @returns {{ glyphs: object[], pieces: object[] }}
 */
export const layoutShot = ({ lines, layout, m, font, keyword, variant, mirror, calm = false }) => {
  const { W, H, fs } = m;
  const glyphs = [];
  const pieces = [];
  const side = mirror ? -1 : 1;

  /* Adds a row of characters as one piece, anchored by `align` at (x, y). */
  const addPiece = (lineIndex, start, end, { x, y, size, align = 'center', rotation = 0, role = 'support', tracking = 0 }) => {
    const { chars } = lines[lineIndex];
    const row = setRow(chars, start, end, size, font, tracking);
    const left = align === 'center' ? -row.width / 2 : align === 'right' ? -row.width : 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const piece = { index: pieces.length, x: x + (left + row.width / 2) * cos, y: y + (left + row.width / 2) * sin, w: row.width, h: size * 1.25, rotation, size, role, line: lineIndex, glyphs: [] };
    for (const entry of row.entries) {
      const lx = left + entry.x;
      piece.glyphs.push(glyphs.length);
      glyphs.push({ char: entry.char, ci: entry.ci, line: lineIndex, x: x + lx * cos, y: y + lx * sin, size, rotation, role, piece: piece.index });
    }
    pieces.push(piece);
    return piece;
  };

  const main = 0;

  /*
   * Word shots, after Folia's 商籁, set the way the lines read: each line is cut into phrases (a
   * space ends one, as Chinese lyrics mark them; in Latin, punctuation or every third word), and a
   * phrase is never broken across rows. One unit of one phrase, the main word, is set two to five
   * times the rest, in place in its phrase, so the sentence still reads straight through. The kinds
   * differ in how the rows sit: centred (orbit, impact), flush left and stepped (column), one row
   * per sung line (tableau), one row for all (ribbon), phrases around the main one (scatter).
   */
  const arrangeWords = (kind, calm) => {
    const seed = Math.round(variant * 1e5);
    const units = [];
    const phrases = [];
    lines.forEach((line, li) => {
      for (const p of readingPhrases(line, li)) {
        for (const u of p.units) u.phrase = phrases.length;
        phrases.push(p);
        units.push(...p.units);
      }
    });
    if (!units.length) return false;

    // The keyword is one unit even where segmentation cut it (向光奔跑 → 向 / 光 / 奔跑).
    if (keyword) {
      const inside = units.map((u, i) => (u.li === keyword.line && u.end > keyword.charIndex && u.start < keyword.charIndex + keyword.length ? i : -1)).filter((i) => i >= 0);
      if (inside.length > 1 && inside.every((i) => units[i].phrase === units[inside[0]].phrase)) {
        const first = units[inside[0]];
        const merged = { ...first, end: units[inside[inside.length - 1]].end, len: inside.reduce((n, i) => n + units[i].len, 0) };
        const p = phrases[first.phrase];
        p.units.splice(p.units.indexOf(p.units.find((u) => u.start === first.start)), inside.length, merged);
        units.splice(inside[0], inside.length, merged);
      }
    }
    let hero = keyword ? units.findIndex((u) => u.li === keyword.line && keyword.charIndex >= u.start && keyword.charIndex < u.end) : -1;
    if (hero < 0) {
      // A unit that can be set huge: two to four characters (three to nine letters), a whole short
      // phrase best, not one led by a particle; the longest such, nearest the middle.
      const mid = (units.length - 1) / 2;
      const fits = (u) => (u.cjk ? u.len >= 2 && u.len <= 4 : u.len >= 3 && u.len <= 9);
      const whole = (u) => phrases[u.phrase].units.length === 1;
      const particle = (u) => u.cjk && FUNCTION_CHARS.has(lines[u.li].chars[u.start]);
      // Nor one ending in 的 (你的, 我的): a possessive is no headline either.
      const possessive = (u) => u.cjk && u.len <= 3 && lines[u.li].chars[u.end - 1] === '的';
      const score = (u, i) => (fits(u) ? 100 : 0) + (whole(u) ? 12 : 0) - (particle(u) ? 60 : 0) - (possessive(u) ? 50 : 0) - (u.loose ? 30 : 0) + u.len - Math.abs(i - mid) * 0.01;
      hero = 0;
      units.forEach((u, i) => {
        if (score(u, i) > score(units[hero], hero)) hero = i;
      });
      // A whole short Chinese phrase (雨停以后, 说成明天) is the most natural thing to set large: it
      // is chosen over a word inside a phrase, so no phrase is cut where segmentation went wrong.
      const lengthOf = (p) => p.units.reduce((n, u) => n + u.len, 0);
      const short = phrases.filter((p) => p.units.length > 1 && p.units[0].cjk && !p.units.some((u) => u.loose) && lengthOf(p) >= 2 && lengthOf(p) <= 5);
      if (short.length && !whole(units[hero])) {
        const p = short.reduce((best, q) => (lengthOf(q) > lengthOf(best) ? q : best));
        const first = p.units[0];
        const merged = { ...first, end: p.units[p.units.length - 1].end, len: lengthOf(p) };
        hero = units.indexOf(first);
        units.splice(hero, p.units.length, merged);
        p.units = [merged];
      }
    }
    const h0 = units[hero];
    const [heroScale, otherScale, kindScale] = WORD_SCALES[kind];
    const userScale = fs / clamp(Math.min(W, H) * 0.066, 18, 124);
    // The base size, as 商籁 sizes it from the word count, but small enough for the main word to
    // keep its full scale within the frame (the hierarchy is the point); never below legibility.
    const heroRun = setRow(lines[h0.li].chars, h0.start, h0.end, 100, font, 0.02).width;
    const heroBase = (W * 0.62 * 100) / Math.max(1, heroRun * heroScale);
    const base = Math.max(fs * 0.42, Math.min(clamp((W / Math.max(7, units.length * 2.15)) * kindScale, 24, 112) * userScale, heroBase));
    const stack = base * 0.3;

    /* Sets a unit, shrunk if it alone would not fit (the main word may take most of the width). */
    const measure = (u, scale) => {
      u.size = base * scale;
      const size = () => {
        [u.w, u.h] = [setRow(lines[u.li].chars, u.start, u.end, u.size, font, 0.02).width, u.size * 1.2];
      };
      size();
      const k = Math.min(1, (W * (u === h0 ? 0.62 : 0.8)) / u.w, (H * 0.5) / u.h);
      if (k < 1) {
        u.size *= k;
        size();
      }
    };
    units.forEach((u) => measure(u, u === h0 ? heroScale : otherScale));
    /* The space before a unit in a row: a word space inside a phrase (none in Chinese), wider between phrases. */
    const gapBefore = (prev, u) => {
      const size = Math.min(prev.size, u.size);
      if (prev.phrase !== u.phrase && !u.softStart) return size * 0.55;
      return u.cjk && prev.cjk ? size * 0.04 : size * 0.28;
    };
    const widthOf = (row) => row.reduce((sum, u, i) => sum + u.w + (i ? gapBefore(row[i - 1], u) : 0), 0);
    const heightOf = (row) => Math.max(0, ...row.map((u) => u.h));
    /* Phrases (lists of units) packed into rows no wider than `limit`, never splitting a phrase. */
    const pack = (list, limit) => {
      const rows = [];
      for (const p of list) {
        const row = rows[rows.length - 1];
        if (row && widthOf([...row, ...p.units]) <= limit) row.push(...p.units);
        else rows.push([...p.units]);
      }
      return rows;
    };
    const heroPhrase = phrases[h0.phrase];
    const limit = W * (kind === 'tableau' ? 0.7 : 0.6);
    const linesBefore = phrases.filter((p) => p.li < h0.li);
    const linesAfter = phrases.filter((p) => p.li > h0.li);
    const sameBefore = phrases.filter((p) => p.li === h0.li && phrases.indexOf(p) < h0.phrase);
    const sameAfter = phrases.filter((p) => p.li === h0.li && phrases.indexOf(p) > h0.phrase);
    const enter = (u, x, y) => {
      u.enterX = calm ? 0 : x;
      u.enterY = calm ? 0 : y;
    };
    /* Lays a row from x with its units' feet on one line (y is the row's centre). */
    const lay = (row, x, y, from) => {
      const foot = y + heightOf(row) / 2;
      row.forEach((u, i) => {
        if (i) x += gapBefore(row[i - 1], u);
        [u.x, u.y] = [x + u.w / 2, foot - u.h / 2];
        x += u.w;
        enter(u, u === h0 ? 0 : from[0], u === h0 ? base * 0.6 : from[1]);
      });
    };
    /* Stacks rows top to bottom; `x0` gives each row's left edge from its index and width. */
    const stackRows = (rows, x0, from = (k, heroAt) => [0, k < heroAt ? -30 : 30]) => {
      const heroAt = rows.findIndex((row) => row.includes(h0));
      const total = rows.reduce((sum, row) => sum + heightOf(row), 0) + stack * (rows.length - 1);
      let y = -total / 2;
      rows.forEach((row, k) => {
        lay(row, x0(k, widthOf(row), heroAt), y + heightOf(row) / 2, from(k, heroAt));
        y += heightOf(row) + stack;
      });
    };
    const centreRows = () => [
      ...pack(linesBefore, limit),
      ...pack(sameBefore, limit),
      [...heroPhrase.units],
      ...pack(sameAfter, limit),
      ...pack(linesAfter, limit),
    ].filter((row) => row.length);

    switch (kind) {
      case 'lyric': {
        // 流光 (after Folia's classic): each sung line one large centred row, every unit a little off
        // the line, tilted and sized its own way; sung units turn further (shots.mjs).
        const tilt = calm ? 0.35 : 1;
        units.forEach((u, i) => {
          if (u !== h0) measure(u, otherScale * (0.88 + 0.3 * hash01(seed, i, 51)));
          u.rot = (hash01(seed, i, 52) - 0.5) * 0.16 * tilt;
          u.lift = (hash01(seed, i, 53) - 0.5) * 0.3 * tilt;
        });
        const rows = [];
        for (const li of [...new Set(phrases.map((p) => p.li))]) rows.push(...pack(phrases.filter((p) => p.li === li), W * 0.82));
        stackRows(rows, (k, w) => -w / 2, () => [0, 24]);
        for (const u of units) u.y += u.lift * u.size;
        break;
      }
      case 'cloud': {
        // 云阶 (after Folia's partita): each phrase a block of its own, stepping down in alternate
        // offsets like a stair in cloud, each a little tilted; a hair line beside each (shots.mjs).
        const rows = phrases.map((p) => [...p.units]);
        const offsets = rows.map((_, k) => (k % 2 === 0 ? -1 : 1) * W * (0.05 + 0.1 * hash01(seed, k, 61)));
        stackRows(rows, (k, w) => -w / 2 + offsets[k], (k) => [(k % 2 === 0 ? -40 : 40), 0]);
        rows.forEach((row, k) => {
          for (const u of row) u.rot = (hash01(seed, k, 62) - 0.5) * (calm ? 0.03 : 0.1);
        });
        break;
      }
      case 'shards': {
        // 心象 (after Folia's cadenza): every character (every word, in Latin) a fragment of its own,
        // scattered across the frame along a wandering path that still reads left to right; the
        // main word's characters larger. They swim, turn and drift in shots.mjs.
        const fragments = [];
        for (const u of units) {
          if (u.cjk) {
            for (let ci = u.start; ci < u.end; ci += 1) {
              if (SPACE.test(lines[u.li].chars[ci])) continue;
              fragments.push({ ...u, start: ci, end: ci + 1, len: 1, hero: u === h0 });
            }
          } else {
            fragments.push({ ...u, hero: u === h0 });
          }
        }
        const n = fragments.length;
        const bands = n > 14 ? 2 : 1;
        const perBand = Math.ceil(n / bands);
        const phase = hash01(seed, 71) * Math.PI * 2;
        fragments.forEach((f, i) => {
          measure(f, (f.hero ? heroScale * 0.62 : otherScale) * (0.85 + 0.45 * hash01(seed, i, 72)));
          f.rot = (hash01(seed, i, 75) - 0.5) * 0.4;
          f.enterX = 0;
          f.enterY = 0;
        });
        // Each band laid left to right by the fragments' own widths with a loose gap, so none overlap
        // across; the path then wanders up and down.
        for (let band = 0; band < bands; band += 1) {
          const row = fragments.slice(band * perBand, (band + 1) * perBand);
          let x = 0;
          row.forEach((f, j) => {
            if (j) x += row[j - 1].w / 2 + f.w / 2 + base * (0.12 + 0.3 * hash01(seed, band * perBand + j, 73));
            f.x = x;
          });
          const bandY = bands === 1 ? 0 : (band === 0 ? -1 : 1) * H * 0.2;
          row.forEach((f, j) => {
            const along = row.length > 1 ? j / (row.length - 1) : 0.5;
            f.x -= x / 2;
            f.y = bandY + Math.sin(along * Math.PI * 2 + phase) * H * (bands === 1 ? 0.14 : 0.07) + (hash01(seed, band * perBand + j, 74) - 0.5) * H * 0.05;
          });
        }
        units.splice(0, units.length, ...fragments);
        break;
      }
      case 'stairs': {
        // A staircase: each row steps further across as it goes down, the main word's row larger.
        const rows = centreRows();
        const step = base * (1.2 + 0.6 * hash01(seed, 9));
        const down = hash01(seed, 31) < 0.5 ? 1 : -1;
        const widest = Math.max(...rows.map(widthOf));
        stackRows(rows, (k, w) => (down > 0 ? -widest / 2 + k * step : widest / 2 - w - k * step), () => [-down * 30, 0]);
        break;
      }
      case 'split': {
        // Corner to corner: what comes before the main word flush left at the top, the main word
        // large in the middle, what follows flush right at the bottom.
        const top = [...pack(linesBefore, limit), ...pack(sameBefore, limit)].filter((row) => row.length);
        const bottom = [...pack(sameAfter, limit), ...pack(linesAfter, limit)].filter((row) => row.length);
        const rows = [...top, [...heroPhrase.units], ...bottom];
        const widest = Math.max(...rows.map(widthOf), W * 0.56);
        stackRows(rows, (k, w) => (k < top.length ? -widest / 2 : k > top.length ? widest / 2 - w : -w / 2), (k) => [k < top.length ? -40 : k > top.length ? 40 : 0, 0]);
        break;
      }
      case 'drop': {
        // A drop head: the main word large to one side, what follows it as short rows beside it,
        // what comes before it in a row above, flush with it.
        const heroRow = [...heroPhrase.units];
        const beside = [...pack(sameAfter, W * 0.32), ...pack(linesAfter, W * 0.32)].filter((row) => row.length);
        const above = [...pack(linesBefore, W * 0.7), ...pack(sameBefore, W * 0.7)].filter((row) => row.length);
        const right = hash01(seed, 31) < 0.5;
        const hw = widthOf(heroRow);
        const hx = right ? W * 0.12 - hw / 2 : -W * 0.12 - hw / 2;
        lay(heroRow, hx, 0, [0, 0]);
        const sideH = beside.reduce((sum, row) => sum + heightOf(row) + stack, -stack);
        let y = -sideH / 2;
        for (const row of beside) {
          const w = widthOf(row);
          lay(row, right ? hx - base * 0.8 - w : hx + hw + base * 0.8, y + heightOf(row) / 2, [right ? -30 : 30, 0]);
          y += heightOf(row) + stack;
        }
        y = -heightOf(heroRow) / 2 - stack;
        for (let k = above.length - 1; k >= 0; k -= 1) {
          const row = above[k];
          lay(row, right ? hx + hw - widthOf(row) : hx, y - heightOf(row) / 2, [0, -30]);
          y -= heightOf(row) + stack;
        }
        break;
      }
      case 'rhythm': {
        // A headline rhythm: every phrase its own row, large and small in turn, left and right in turn.
        phrases.forEach((p, k) => {
          if (p !== heroPhrase && k % 2 === 1) for (const u of p.units) measure(u, otherScale * 1.6);
        });
        const rows = phrases.map((p) => [...p.units]);
        const widest = Math.max(...rows.map(widthOf));
        const lead = hash01(seed, 31) < 0.5 ? 1 : -1;
        stackRows(rows, (k, w) => ((k % 2 === 0) === lead > 0 ? -widest / 2 : widest / 2 - w), (k) => [((k % 2 === 0) === lead > 0 ? -30 : 30), 0]);
        break;
      }
      case 'ribbon':
        // Everything in one row, the main word large in its place.
        stackRows([units], (k, w) => -w / 2, () => [-40, 0]);
        break;
      case 'tableau': {
        // A short poem: each sung line its own row (wrapped only between phrases), flush left.
        const rows = [];
        for (const li of [...new Set(phrases.map((p) => p.li))]) rows.push(...pack(phrases.filter((p) => p.li === li), limit));
        const widest = Math.max(...rows.map(widthOf));
        stackRows(rows, () => -widest / 2, () => [0, 0]);
        break;
      }
      case 'column': {
        // Flush left and stepped, like an editorial page: the rows before the main one step in,
        // the ones after step out again.
        const rows = centreRows();
        const step = base * (0.8 + 0.6 * hash01(seed, 7));
        const widest = Math.max(...rows.map(widthOf));
        const flushLeft = hash01(seed, 31) < 0.5;
        stackRows(rows, (k, w, heroAt) => (flushLeft ? -widest / 2 + Math.abs(k - heroAt) * step : widest / 2 - w - Math.abs(k - heroAt) * step), (k, heroAt) => [k < heroAt ? 30 : -30, 0]);
        break;
      }
      case 'scatter': {
        // The other phrases find places around the main one's row, in the order they are sung,
        // starting at its upper left, none overlapping.
        const heroRow = [...heroPhrase.units];
        lay(heroRow, -widthOf(heroRow) / 2, 0, [0, 0]);
        const taken = [{ l: -widthOf(heroRow) / 2, r: widthOf(heroRow) / 2, t: -heightOf(heroRow) / 2, b: heightOf(heroRow) / 2 }];
        const clear = (a, c) => Math.max(a.l - c.r, c.l - a.r, a.t - c.b, c.t - a.b) >= base * 0.25;
        let angle = Math.PI * 1.15 + hash01(seed, 41) * 0.4;
        phrases.filter((p) => p !== heroPhrase).forEach((p, k) => {
          const row = [...p.units];
          const w = widthOf(row);
          const h = heightOf(row);
          let radius = Math.hypot(widthOf(heroRow), heightOf(heroRow)) / 2 + stack + base * (0.1 + ((k * 0.29) % 0.6));
          let at = null;
          for (let tries = 0; tries < 12 && !at; tries += 1) {
            for (let step = 0; step < 90 && !at; step += 1) {
              const cx = Math.cos(angle) * radius;
              const cy = Math.sin(angle) * radius * 0.7;
              const box = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
              if (taken.every((t) => clear(t, box))) {
                taken.push(box);
                at = [cx, cy];
              } else {
                angle += 0.07;
              }
            }
            if (!at) radius += base * 0.35;
          }
          const [cx, cy] = at ?? [0, radius];
          lay(row, cx - w / 2, cy, [Math.cos(angle) * 60, Math.sin(angle) * 60]);
          angle += 0.6;
        });
        break;
      }
      default:
        // orbit / impact: rows centred, in reading order, the main word's row in the middle.
        stackRows(centreRows(), (k, w) => -w / 2);
        break;
    }

    // Fit the whole arrangement into the frame, centred.
    const left = Math.min(...units.map((u) => u.x - u.w / 2));
    const right = Math.max(...units.map((u) => u.x + u.w / 2));
    const top = Math.min(...units.map((u) => u.y - u.h / 2));
    const bottom = Math.max(...units.map((u) => u.y + u.h / 2));
    const k = Math.min(1, (W * 0.86) / Math.max(1, right - left), (H * 0.8) / Math.max(1, bottom - top));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    units.forEach((u, i) => {
      const piece = addPiece(u.li, u.start, u.end, { x: (u.x - cx) * k, y: (u.y - cy) * k, size: u.size * k, role: u === h0 || u.hero ? 'hero' : 'support', align: 'center', rotation: u.rot ?? 0, tracking: 0.02 });
      piece.enterX = (u.enterX ?? 0) * k;
      piece.enterY = (u.enterY ?? 0) * k;
      // The order a piece is set in, for the motions of the classic, partita and cadenza kinds.
      piece.order = i;
    });
    return true;
  };
  const heroOf = (lineIndex, phrases) => {
    if (keyword && keyword.line === lineIndex) {
      const at = phrases.findIndex((p) => keyword.charIndex >= p.start && keyword.charIndex < p.end);
      if (at >= 0) return at;
    }
    // Otherwise the longest phrase, ties to the first.
    let best = 0;
    phrases.forEach((p, i) => {
      if (p.end - p.start > phrases[best].end - phrases[best].start) best = i;
    });
    return best;
  };

  /* Plain wrapped text, every line of the shot one after another. */
  const flowing = ({ size, align, x, y, maxWidth, tracking = 0, lineGap = 1.36 }) => {
    const blocks = lines.map((line, li) => ({ li, rows: wrapBalanced(line.chars, phrasesOf(line.chars, line.segments, 1), size, font, maxWidth, tracking) }));
    const total = blocks.reduce((n, b) => n + b.rows.length, 0);
    let row = 0;
    for (const block of blocks) {
      for (const r of block.rows) {
        const ry = y + (row - (total - 1) / 2) * size * lineGap;
        addPiece(block.li, r.start, r.end, { x, y: ry, size, align, tracking, role: 'support' });
        row += 1;
      }
    }
  };

  /* Fits a set of pieces into a box by scaling sizes (used by poster layouts before placing). */
  const fitScale = (items, maxWidth, maxHeight) => {
    const widest = Math.max(...items.map((it) => setRow(lines[it.li].chars, it.start, it.end, it.size, font, it.tracking ?? 0).width));
    const height = items.reduce((sum, it) => sum + it.size * 1.08, 0);
    return Math.min(1, maxWidth / Math.max(1, widest), maxHeight / Math.max(1, height));
  };

  const posterItems = (sizeHero, sizeOther) => {
    const li = Math.max(0, main);
    const { chars, segments } = lines[li];
    const phrases = phrasesOf(chars, segments, 4);
    const hero = heroOf(li, phrases);
    return phrases.map((p, i) => ({
      li,
      start: p.start,
      end: p.end,
      role: i === hero ? 'hero' : 'support',
      size: fs * (i === hero ? sizeHero : sizeOther * (0.82 + 0.3 * hash01(Math.round(variant * 1e4), i, 3))),
    }));
  };

  if (WORD_KINDS.includes(layout) && arrangeWords(layout, calm)) return { glyphs, pieces };

  switch (layout) {
    case 'type': {
      // After Folia's 凝彩: the line's words set in rows, one long word large and the rest small,
      // each row its own width, nudged and tilted a little, the whole fitted into the frame.
      const seed = Math.round(variant * 1e5);
      const { chars } = lines[0];
      const words = readingPhrases(lines[0], 0).flatMap((p, phrase) => p.units.map((u) => ({ ...u, phrase })));
      if (!words.length) {
        flowing({ size: fs * 1.3, align: 'center', x: 0, y: 0, maxWidth: W * 0.8 });
        break;
      }
      const lengths = words.map((w) => w.len);
      const longest = Math.max(...lengths);
      const inKeyword = keyword ? words.findIndex((w) => keyword.charIndex >= w.start && keyword.charIndex < w.end) : -1;
      const longOnes = words.map((_, i) => i).filter((i) => lengths[i] >= Math.max(2, longest - 1));
      const hero = inKeyword >= 0 ? inKeyword : longOnes.length ? longOnes[Math.floor(hash01(seed, 1) * longOnes.length) % longOnes.length] : 0;
      // The main word large; the others sized by phrase, so a phrase keeps one size.
      const scales = words.map((w, i) => (i === hero ? 1.4 + 0.22 * hash01(seed, i, 2) : 0.72 + 0.14 * hash01(seed, w.phrase, 3)));
      const align = ['center', 'left', 'right'][Math.floor(hash01(seed, 4) * 3)];
      const regionW = W * 0.8;
      const regionH = H * 0.66;
      let base = fs * 1.7;
      let rows = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        rows = [];
        let row = null;
        words.forEach((w, i) => {
          const size = base * scales[i];
          const width = setRow(chars, w.start, w.end, size, font, 0.01).width;
          const prev = words[i - 1];
          const newPhrase = !prev || (prev.phrase !== w.phrase && !w.softStart);
          const gap = newPhrase ? base * 0.3 : w.cjk && prev.cjk ? base * 0.035 : base * 0.26;
          const limit = regionW * (0.72 + 0.28 * hash01(seed, rows.length, 5));
          // A row breaks only between phrases; a long phrase is shrunk to fit instead.
          if (row && newPhrase && row.width + gap + width > limit) {
            rows.push(row);
            row = null;
          }
          if (!row) row = { items: [], width: 0, height: 0 };
          row.width += (row.items.length ? gap : 0) + width;
          row.items.push({ i, w, size, width, gap: row.items.length ? gap : 0 });
          row.height = Math.max(row.height, size * 1.08);
        });
        if (row) rows.push(row);
        const total = rows.reduce((h, r) => h + r.height, 0);
        const widest = Math.max(...rows.map((r) => r.width));
        const k = Math.min(1, regionH / total, regionW / widest);
        if (k > 0.999) break;
        base *= k;
      }
      const tilt = (hash01(seed, 6) - 0.5) * 0.05;
      let y = -rows.reduce((h, r) => h + r.height, 0) / 2;
      rows.forEach((row, r) => {
        const rowY = y + row.height / 2;
        y += row.height;
        const nudge = (hash01(seed, r, 7) - 0.5) * W * 0.05;
        const left = align === 'center' ? -row.width / 2 + nudge : align === 'left' ? -regionW / 2 + Math.abs(nudge) * 0.6 : regionW / 2 - row.width - Math.abs(nudge) * 0.6;
        const rowTilt = tilt + (hash01(seed, r, 8) - 0.5) * 0.05;
        const cx = left + row.width / 2;
        let cursor = left;
        for (const item of row.items) {
          cursor += item.gap;
          // Each word sits on the row's tilted line, a little off it.
          const dx = cursor - cx;
          const lift = (hash01(seed, item.i, 9) - 0.5) * base * 0.09;
          addPiece(0, item.w.start, item.w.end, {
            x: cx + dx * Math.cos(rowTilt),
            y: rowY + dx * Math.sin(rowTilt) + lift,
            size: item.size,
            align: 'left',
            rotation: rowTilt + (hash01(seed, item.i, 10) - 0.5) * 0.06,
            role: item.i === hero ? 'hero' : 'support',
            tracking: 0.01,
          });
          cursor += item.width;
        }
      });
      break;
    }
    case 'centerBig':
      flowing({ size: fs * 1.42, align: 'center', x: 0, y: -H * 0.02, maxWidth: W * 0.84, tracking: 0.02, lineGap: 1.2 });
      break;
    case 'stack': {
      const items = posterItems(1.95, 1);
      const k = fitScale(items, W * 0.8, H * 0.64);
      const pattern = variant < 0.34 ? 'stairs' : variant < 0.67 ? 'alternate' : 'center';
      let y = -items.reduce((s, it) => s + it.size * k * 1.08, 0) / 2;
      items.forEach((it, i) => {
        const size = it.size * k;
        y += size * 0.54;
        let x = 0;
        let align = 'center';
        if (pattern === 'stairs') {
          align = 'left';
          x = side * (-W * 0.3 + i * W * 0.07);
          if (side < 0) align = 'right';
        } else if (pattern === 'alternate') {
          align = i % 2 === 0 ? 'left' : 'right';
          x = (i % 2 === 0 ? -1 : 1) * W * 0.3 * side;
          if (side < 0) align = align === 'left' ? 'right' : 'left';
        }
        addPiece(it.li, it.start, it.end, { x, y, size, align, role: it.role, rotation: 0 });
        y += size * 0.54;
      });
      break;
    }
    case 'split': {
      const li = Math.max(0, main);
      const { chars, segments } = lines[li];
      let phrases = phrasesOf(chars, segments, 2);
      if (phrases.length > 2) phrases = [{ start: phrases[0].start, end: phrases[Math.ceil(phrases.length / 2) - 1].end }, { start: phrases[Math.ceil(phrases.length / 2)].start, end: phrases[phrases.length - 1].end }];
      const size = fs * 1.2;
      if (phrases.length === 1) {
        addPiece(li, phrases[0].start, phrases[0].end, { x: 0, y: 0, size, role: 'hero' });
      } else {
        addPiece(li, phrases[0].start, phrases[0].end, { x: -side * W * 0.36, y: -H * 0.14, size, align: side > 0 ? 'left' : 'right', role: 'hero' });
        addPiece(li, phrases[1].start, phrases[1].end, { x: side * W * 0.36, y: H * 0.14, size: size * 0.92, align: side > 0 ? 'right' : 'left', role: 'support' });
      }
      break;
    }
    case 'hero': {
      const li = Math.max(0, main);
      const { chars, segments } = lines[li];
      const phrases = phrasesOf(chars, segments, 3);
      const hero = heroOf(li, phrases);
      const heroPhrase = phrases[hero];
      const heroWidth = setRow(chars, heroPhrase.start, heroPhrase.end, 100, font).width;
      const heroSize = clamp((W * 0.78 * 100) / Math.max(1, heroWidth), fs * 1.3, Math.min(fs * 3.2, H * 0.3));
      const heroY = -H * 0.06;
      addPiece(li, heroPhrase.start, heroPhrase.end, { x: 0, y: heroY, size: heroSize, role: 'hero' });
      const rest = phrases.filter((_, i) => i !== hero);
      if (rest.length) {
        const smallSize = fs * 0.62;
        const restY = heroY + heroSize * 0.78 + smallSize * 0.4;
        const before = rest.filter((p) => p.start < heroPhrase.start);
        const after = rest.filter((p) => p.start > heroPhrase.start);
        if (before.length) addPiece(li, before[0].start, before[before.length - 1].end, { x: 0, y: heroY - heroSize * 0.78 - smallSize * 0.2, size: smallSize, role: 'support', tracking: 0.12 });
        if (after.length) addPiece(li, after[0].start, after[after.length - 1].end, { x: 0, y: restY, size: smallSize, role: 'support', tracking: 0.12 });
      }
      break;
    }
    case 'vertical': {
      // A page of columns, first line on the right, all hanging from one top edge like a scroll.
      const perColumn = 12;
      const columns = [];
      lines.forEach((line, li) => {
        const visible = line.chars.map((c, ci) => ({ c, ci })).filter(({ c }) => !SPACE.test(c));
        for (let col = 0; col * perColumn < visible.length; col += 1) columns.push({ li, slice: visible.slice(col * perColumn, (col + 1) * perColumn) });
      });
      const pitch = 1.85;
      const tallest = Math.max(1, ...columns.map((c) => c.slice.length));
      const size = Math.min(fs * 1.3, (W * 0.66) / Math.max(1, (columns.length - 1) * pitch + 1), (H * 0.78) / (tallest * 1.08));
      const top = (-tallest * size * 1.08) / 2;
      let columnX = ((columns.length - 1) * size * pitch) / 2 - side * W * 0.06;
      for (const { li, slice } of columns) {
        const height = slice.length * size * 1.08;
        const piece = { index: pieces.length, x: columnX, y: top + height / 2, w: size, h: height, rotation: 0, size, role: 'support', line: li, glyphs: [] };
        slice.forEach(({ c, ci }, k) => {
          const closing = CLOSING.test(c);
          piece.glyphs.push(glyphs.length);
          glyphs.push({ char: c, ci, line: li, x: columnX + (closing ? size * 0.3 : 0), y: top + (k + 0.5) * size * 1.08 - (closing ? size * 0.3 : 0), size, rotation: WIDE.test(c) ? 0 : Math.PI / 2, role: 'support', piece: piece.index });
        });
        pieces.push(piece);
        columnX -= size * pitch;
      }
      break;
    }
    case 'world': {
      // 浮名 (after Folia's fume): the whole paragraph on one sheet larger than the frame, line after
      // line, each its own size, side and tilt; the camera flies from line to line (shots.mjs).
      const seed = Math.round(variant * 1e5);
      const entries = [];
      let y = 0;
      lines.forEach((line, li) => {
        const big = keyword && keyword.line === li;
        const size = fs * (big ? 2.8 : 1.6 + 0.8 * hash01(seed, li, 3));
        const rows = wrapBalanced(line.chars, phrasesOf(line.chars, line.segments, 1), size, font, W * 0.8, 0.02);
        const x = (li % 2 === 0 ? -1 : 1) * side * W * (0.06 + 0.16 * hash01(seed, li, 4));
        const rotation = (hash01(seed, li, 5) - 0.5) * 0.08;
        rows.forEach((r, k) => entries.push({ li, r, x, y: y + k * size * 1.15, size, rotation }));
        y += rows.length * size * 1.15 + size * 0.7;
      });
      const middle = (y - fs) / 2;
      for (const e of entries) addPiece(e.li, e.r.start, e.r.end, { x: e.x, y: e.y - middle, size: e.size, align: 'center', rotation: e.rotation, role: keyword && keyword.line === e.li ? 'hero' : 'support', tracking: 0.02 });
      break;
    }
    case 'page': {
      // A manuscript stanza: every line of the paragraph down one margin, wrapped lines kept tight.
      const right = mirror;
      const align = right ? 'right' : 'left';
      const wrapAll = (size) => lines.map((line, li) => ({ li, rows: wrapBalanced(line.chars, phrasesOf(line.chars, line.segments, 1), size, font, W * 0.62, 0.02) }));
      const heightOf = (blocks, size) => blocks.reduce((h, b) => h + (b.rows.length - 1) * size * 1.3, 0) + (blocks.length - 1) * size * 1.85;
      let size = fs * 1.2;
      let blocks = wrapAll(size);
      const room = H * 0.72;
      if (heightOf(blocks, size) > room) {
        size = Math.max(fs * 0.6, (size * room) / heightOf(blocks, size));
        blocks = wrapAll(size);
      }
      // Down one margin, or each line in turn flush left and flush right (a dialogue), or each line
      // stepped further in (a stair down the page).
      const style = pageStyleOf(variant);
      const placeOf = (li) => {
        if (style === 'zigzag') {
          const r = (li % 2 === 1) !== right;
          return { x: (r ? 1 : -1) * W * 0.36, align: r ? 'right' : 'left' };
        }
        if (style === 'steps') {
          const step = Math.min(W * 0.06, (W * 0.24) / Math.max(1, blocks.length - 1));
          return { x: (right ? 1 : -1) * (W * 0.36 - li * step), align };
        }
        return { x: (right ? 1 : -1) * W * 0.31, align };
      };
      let y = -heightOf(blocks, size) / 2;
      blocks.forEach((block) => {
        const { x, align: side } = placeOf(block.li);
        block.rows.forEach((r, k) => {
          addPiece(block.li, r.start, r.end, { x, y, size, align: side, tracking: 0.02 });
          if (k < block.rows.length - 1) y += size * 1.3;
        });
        y += size * 1.85;
      });
      break;
    }
    case 'center':
    default:
      flowing({ size: fs * 1.3, align: 'center', x: 0, y: -H * 0.02, maxWidth: W * 0.8 });
      break;
  }
  return { glyphs, pieces };
};

/** Layouts that set several lines' words around one main word (after 商籁). */
export const WORD_KINDS = ['orbit', 'ribbon', 'column', 'scatter', 'impact', 'tableau', 'stairs', 'split', 'drop', 'rhythm', 'lyric', 'cloud', 'shards'];
/** Word kinds whose pieces move on their own (流光, 云阶, 心象): see shots.mjs. */
export const MOVING_KINDS = ['lyric', 'cloud', 'shards'];
export const LAYOUTS = ['center', 'centerBig', 'stack', 'split', 'hero', 'type', 'page', 'vertical', 'world', ...WORD_KINDS];
/** Layouts that set a whole paragraph in one shot. */
export const PAGES = ['page', 'vertical', 'world'];

/* Per word kind: the main word's scale, the others', and the base size's. */
const WORD_SCALES = {
  impact: [5, 1.45, 1.4],
  scatter: [3.2, 1.3, 1],
  column: [3.6, 1.2, 1],
  ribbon: [3.2, 1.4, 1],
  orbit: [3, 1.15, 1],
  tableau: [2.4, 1.1, 0.85],
  stairs: [2.6, 1.3, 1],
  split: [3.4, 1.3, 1],
  drop: [3.6, 1.25, 1],
  rhythm: [2.8, 1.15, 1],
  lyric: [1.7, 1.25, 1.35],
  cloud: [2.2, 1.25, 1.1],
  shards: [2.2, 1.3, 1.2],
};

/** A stanza page's style, from its variant: down a margin, lines in turn left and right, or stepped. */
export const pageStyleOf = (variant) => ['margin', 'zigzag', 'steps'][Math.floor(variant * 3) % 3];
