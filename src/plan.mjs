// The planner: turns a lyric analysis and a direction (AI or local) into the
// exact schedule the stage plays: one scene per paragraph with its energy,
// ambient element, accent (sparkler / fireworks) and keyword, plus every
// firework shell and sparkler with its time and place. Pure and deterministic:
// the same song, lyric and direction always give the same plan, so previews,
// playback, seeking and export agree.

import { clamp } from './motion.mjs';
import { createRandom, hashString, weightedPick } from './random.mjs';
import { WIDE, charTimings } from './lyrics.mjs';
import { ACCENTS, WEATHERS, SCENES } from './direction.mjs';
import { CALM, TEMPERAMENTS, orderFor, temperamentOf } from './kinetic.mjs';
import { EMBLEM_NAMES, QUIET_EMBLEMS } from './emblems.mjs';
import { MOVING_KINDS, pageStyleOf } from './layouts.mjs';

/** A line shows this long before its first word, so the eye is there when it is sung. */
export const LINE_LEAD = 0.45;
/** Ornaments start drawing this long before the paragraph's first line shows. */
const ORNAMENT_LEAD = 0.3;
/** A paragraph's scene stays this long after its last line ends, to fade out. */
const PARAGRAPH_TAIL = 0.9;

const PALETTES = {
  frost: ['#dfe7ef', '#a9bacb', '#7d90a8'],
  mist: ['#e7e3ef', '#b7b4cc', '#8f9ab3'],
  dusk: ['#f3dcc0', '#dcae7a', '#a87a55'],
  blush: ['#f7e0e4', '#e9b9c5', '#fff0dd'],
  dawn: ['#ffe4ad', '#ffb98a', '#f2d8ff'],
  fiesta: ['#ffd166', '#ff7f7f', '#7fd6ff', '#c3a6ff'],
};

const pickPalette = ({ valence, energy, warmth }) => {
  if (valence < 0.4) return warmth < 0.5 ? PALETTES.frost : PALETTES.dusk;
  if (valence < 0.6) return warmth < 0.5 ? PALETTES.mist : PALETTES.blush;
  return energy > 0.6 ? PALETTES.fiesta : PALETTES.dawn;
};

const KIND_ENERGY = { intro: -0.12, verse: 0, lift: 0.08, chorus: 0.2, breath: -0.16, outro: -0.14 };
const TEMPERAMENT_ORDER = ['gentle', 'lyrical', 'dramatic', 'punchy'];

/* Visible characters of a line, as the stage lays them out (raw fullText, not trimmed). */
const charsOf = (item) => Array.from(String(item.line.fullText ?? ''));
const visibleLength = (item) => charsOf(item).filter((char) => !/\s/u.test(char)).length;

/** Where `word` sits in a line: the code-point index of its first character, or -1. */
const indexIn = (item, word) => {
  const chars = charsOf(item);
  const target = Array.from(word);
  const lower = (s) => s.toLowerCase();
  outer: for (let i = 0; i + target.length <= chars.length; i += 1) {
    for (let k = 0; k < target.length; k += 1) if (lower(chars[i + k]) !== lower(target[k])) continue outer;
    return i;
  }
  return -1;
};

const keywordAt = (analysis, paragraph, word) => {
  if (!word) return null;
  for (const index of paragraph.lines) {
    const item = analysis.items[index];
    const at = indexIn(item, word);
    if (at >= 0) {
      const timing = charTimings(item.line)[at] ?? null;
      return { text: word, item: index, charIndex: at, length: Array.from(word).length, start: timing?.start ?? item.start };
    }
  }
  return null;
};

/* The local keyword: the word-like segment that recurs most in the paragraph, longer wins ties. */
const localKeyword = (analysis, paragraph, segment) => {
  const scores = new Map();
  paragraph.lines.forEach((index, order) => {
    for (const seg of segment(analysis.items[index].line)) {
      if (!seg.isWordLike) continue;
      const text = seg.segment.trim();
      const length = Array.from(text).length;
      const wide = WIDE.test(text);
      if (wide ? length < 2 || length > 4 : length < 3) continue;
      const key = text.toLowerCase();
      const prior = scores.get(key) ?? { text, score: 0 };
      prior.score += 2 + length * 0.3 - order * 0.15;
      scores.set(key, prior);
    }
  });
  const best = [...scores.values()].sort((a, b) => b.score - a.score)[0];
  return best ? keywordAt(analysis, paragraph, best.text) : null;
};

const canVertical = (analysis, paragraph) => paragraph.wide >= 0.85
  && paragraph.lines.every((index) => visibleLength(analysis.items[index]) <= 14);

const canCollage = (analysis, paragraph) => paragraph.lines.every((index) => visibleLength(analysis.items[index]) <= 26);

/* Local scene choice: weights by paragraph kind and mood; the previous scene is strongly discouraged. */
const chooseScene = (random, { kind, valence, energy, vertical, collage, previous }) => {
  const sad = 1 - valence;
  const weights = {
    intro: { whisper: 3, center: 1.5, stanza: sad, vertical: vertical ? sad * 1.2 : 0 },
    verse: { center: 1.6, stanza: 1 + sad * 1.8, vertical: vertical ? sad * 1.6 : 0, whisper: 0.35 * (1 - energy), collage: collage && energy > 0.6 && valence > 0.55 ? 0.8 : 0 },
    lift: { center: 1.4, hero: 1.6, collage: collage && energy > 0.6 && valence > 0.55 ? 1.6 : 0 },
    chorus: { hero: 3, collage: collage && energy > 0.55 && valence > 0.5 ? 3 * energy : 0, center: 0.8, stanza: 0.4 * sad },
    breath: { whisper: 3, center: 1 },
    outro: { whisper: 2, center: 1.4, stanza: sad, vertical: vertical ? sad : 0 },
  }[kind] ?? { center: 1 };
  const entries = Object.entries(weights).map(([scene, weight]) => [scene, scene === previous ? weight * 0.12 : weight]);
  return weightedPick(random, entries);
};

/* Read locally, fireworks also need the whole song to be lively: a chorus boost alone is not enough. */
const localAccent = ({ kind, valence, energy, songEnergy }) => {
  const lively = songEnergy >= 0.55;
  if (kind === 'chorus') {
    if (valence > 0.58 && energy > 0.5 && lively) return 'fireworks';
    if (energy > 0.32) return 'sparkler';
  }
  if (kind === 'lift' && valence > 0.62 && energy > 0.62 && lively) return 'fireworks';
  return null;
};

const SHELL_TYPES = {
  bright: ['peony', 'chrysanthemum', 'ring', 'peony'],
  mid: ['chrysanthemum', 'willow', 'peony'],
  dark: ['willow', 'willow', 'chrysanthemum'],
};

/**
 * @param {object} input
 * @param {object} input.analysis from analyzeLyrics
 * @param {object} input.direction from validateDirection or localDirection
 * @param {number} input.seed song seed
 * @param {(line) => {segment: string, isWordLike: boolean}[]} input.segment word segmentation
 * @param {object} [input.song] for the title card
 * @param {{ bpm: number, confidence: number } | null} [input.tempo] what the stage has heard
 */
export const buildPlan = ({ analysis, direction, seed, segment, song, tempo = null }) => {
  const mood = { valence: direction.valence, energy: direction.energy, warmth: direction.warmth };
  // Sad and still: no collage, no bounce, whatever the direction says.
  const quietSad = mood.valence < 0.4 && mood.energy < 0.6;
  // A sad song (not a dark driving one): its words fade in and out without bounce, punch or flash.
  const calm = mood.valence < 0.45 && mood.energy < 0.65;
  const palette = direction.palette?.length >= 2 ? direction.palette : pickPalette(mood);
  const base = WEATHERS[direction.weather] ? direction.weather : 'dust';
  const sections = new Map((direction.sections ?? []).map((section) => [section.p, section]));

  const paragraphs = [];
  const shells = [];
  const sparklers = [];
  const firstByRepeat = new Map();
  let previous = null;

  for (const paragraph of analysis.paragraphs) {
    if (paragraph.kind === 'credits') continue;
    const random = createRandom((seed ^ hashString(`p${paragraph.index}`)) >>> 0);
    const ai = sections.get(paragraph.index) ?? (paragraph.repeatOf !== undefined ? sections.get(paragraph.repeatOf) : undefined);
    const energy = clamp(ai?.energy ?? mood.energy + (KIND_ENERGY[paragraph.kind] ?? 0), 0.05, 1);
    const vertical = canVertical(analysis, paragraph);
    const collage = canCollage(analysis, paragraph);

    let scene = ai?.scene ?? null;
    if (!scene && paragraph.repeatOf !== undefined && firstByRepeat.has(paragraph.repeatOf)) scene = firstByRepeat.get(paragraph.repeatOf);
    if (!scene) scene = chooseScene(random, { kind: paragraph.kind, valence: mood.valence, energy, vertical, collage, previous });
    if (scene === 'vertical' && !vertical) scene = 'stanza';
    // A quiet sad song gets no collage even if asked (the M1 evaluation caught the AI doing it once).
    if (scene === 'collage' && (!collage || quietSad)) scene = 'hero';
    if (!SCENES[scene]) scene = 'center';
    firstByRepeat.set(paragraph.index, scene);

    let accent = null;
    let weather = base;
    if (ai?.weather) {
      if (ACCENTS[ai.weather]) accent = ai.weather;
      else weather = ai.weather;
    } else {
      accent = localAccent({ kind: paragraph.kind, valence: mood.valence, energy, songEnergy: mood.energy });
    }
    // Fireworks in a dark song read as a celebration it is not: the sparkler says it quietly.
    if (accent === 'fireworks' && mood.valence < 0.4) accent = 'sparkler';
    const burst = accent ? clamp(ai?.burst ?? (accent === 'fireworks' ? 0.45 + 0.5 * energy : 0.55), 0.15, 1) : 0;

    let keyword = keywordAt(analysis, paragraph, ai?.keyword);
    const wantsKeyword = scene === 'hero' || scene === 'collage' || paragraph.kind === 'chorus';
    if (!keyword && wantsKeyword) keyword = localKeyword(analysis, paragraph, segment);
    if (!keyword && scene === 'hero') {
      const first = analysis.items[paragraph.lines[0]];
      const head = segment(first.line).find((seg) => seg.isWordLike);
      keyword = head ? keywordAt(analysis, paragraph, head.segment.trim()) : null;
      if (!keyword) scene = 'center';
    }

    const firstLine = analysis.items[paragraph.lines[0]];
    const show = Math.max(0, firstLine.start - LINE_LEAD - ORNAMENT_LEAD);
    const end = paragraph.end + PARAGRAPH_TAIL;
    const mirror = random() < 0.5;

    let temperament = TEMPERAMENTS[ai?.motion] ? ai.motion : temperamentOf(energy, mood.valence);
    // A sad song is never bouncy. A dark but driving one (hard rap, angry rock) may be:
    // the 22 real directions so far gave those valence ~0.3 with energy 0.7+.
    if (temperament === 'punchy' && quietSad) temperament = 'dramatic';
    // Read locally, a chorus boost alone must not make a mid-energy love song bounce.
    if (temperament === 'punchy' && !ai?.motion && mood.energy < 0.6) temperament = 'dramatic';

    paragraphs.push({
      index: paragraph.index,
      kind: paragraph.kind,
      ordinal: paragraph.ordinal,
      repeatOf: paragraph.repeatOf,
      wide: paragraph.wide,
      temperament,
      lines: paragraph.lines,
      show,
      end,
      scene,
      weather,
      accent,
      energy,
      burst,
      keyword,
      mirror,
      variant: random(),
    });

    if (accent === 'fireworks') {
      const types = mood.valence > 0.65 ? SHELL_TYPES.bright : mood.valence > 0.45 ? SHELL_TYPES.mid : SHELL_TYPES.dark;
      const add = (t0, rise) => {
        if (shells.some((shell) => Math.abs(shell.t0 - t0) < 0.3)) return;
        shells.push({
          t0,
          x: 0.16 + 0.68 * random(),
          y: 0.14 + 0.24 * random(),
          type: types[Math.floor(random() * types.length)],
          color: Math.floor(random() * 16),
          scale: 0.8 + 0.45 * random() * (0.5 + burst),
          rise,
          seed: Math.floor(random() * 1e9),
        });
      };
      // A volley that lands on the first sung word, then shells on line starts and on the keyword.
      const volley = 1 + Math.round(burst * 2);
      for (let k = 0; k < volley; k += 1) add(firstLine.start + 0.04 + k * 0.34, true);
      paragraph.lines.slice(1).forEach((index) => {
        if (random() < burst * 0.75) add(analysis.items[index].start + 0.02, random() < 0.5);
      });
      if (keyword) add(keyword.start, true);
    }
    if (accent === 'sparkler') {
      // Held at the side away from the text, about mid-height: outside every scene's text and frame.
      sparklers.push({ t0: show + 0.35, t1: end - 0.3, x: mirror ? 0.09 : 0.91, y: 0.5, intensity: burst });
    }
    previous = scene;
  }

  // The chorus is never calmer than the verses: lift it to their average (rounded up).
  const rank = (temperament) => TEMPERAMENT_ORDER.indexOf(temperament);
  const verses = paragraphs.filter((p) => p.kind === 'verse').map((p) => rank(p.temperament));
  if (verses.length) {
    const floor = Math.ceil(verses.reduce((a, b) => a + b, 0) / verses.length);
    for (const p of paragraphs) if (p.kind === 'chorus' && rank(p.temperament) < floor) p.temperament = TEMPERAMENT_ORDER[floor];
  }

  // How many times a paragraph's words came before; the last return of a chorus is the climax.
  const roots = paragraphs.map((p) => p.repeatOf ?? p.index);
  paragraphs.forEach((p, i) => {
    p.nth = roots.slice(0, i).filter((root) => root === roots[i]).length;
    p.climax = p.kind === 'chorus' && p.nth > 0 && !roots.slice(i + 1).includes(roots[i]);
  });

  const bpm = tempo?.bpm && tempo.confidence >= 0.4 ? tempo.bpm : null;
  const shots = buildShots({ analysis, paragraphs, seed, calm, segment, bpm });
  const { wipes } = stageParagraphs({ paragraphs, shots, seed, calm });

  // Title card: the song's name (and its credits) while the intro plays, when there is room.
  const firstSung = analysis.sung[0];
  const credits = analysis.paragraphs.find((p) => p.kind === 'credits')?.lines ?? [];
  const introEnd = firstSung ? firstSung.start - LINE_LEAD - 0.6 : 8;
  const title = introEnd >= 2.6 ? { show: 0.25, end: Math.min(introEnd, 0.25 + 10), credits } : null;

  return {
    source: direction.src,
    summary: direction.summary ?? '',
    mood,
    palette,
    weather: base,
    calm,
    paragraphs,
    shots,
    wipes,
    shells: shells.sort((a, b) => a.t0 - b.t0),
    sparklers,
    title,
  };
};

// ---------------------------------------------------------------- shots

/*
 * Word-shot kinds by passage (after 商籁): a sad song stays with hanging columns, magazine columns,
 * a quiet orbit or a ribbon, its chorus may set one word huge; a lively one adds scattered words
 * and impacts. A single line may also take a one-line layout.
 */
const KINDS = {
  calm: ['tableau', 'stairs', 'drop', 'split', 'orbit', 'column', 'rhythm', 'ribbon'],
  calmChorus: ['orbit', 'impact', 'drop', 'split', 'column'],
  gentle: ['tableau', 'stairs', 'drop', 'orbit', 'split', 'ribbon'],
  lyrical: ['orbit', 'stairs', 'drop', 'split', 'rhythm', 'column', 'ribbon'],
  dramatic: ['impact', 'split', 'drop', 'rhythm', 'column', 'scatter', 'orbit'],
  punchy: ['impact', 'rhythm', 'split', 'scatter', 'ribbon', 'drop', 'orbit'],
};
const SINGLE_LINE = { calm: ['type'], lively: ['type', 'hero'] };
const SCENE_KINDS = { whisper: ['tableau'], hero: ['impact', 'orbit'], collage: ['impact', 'ribbon', 'orbit', 'scatter'] };
/* The background each kind draws: a line-art emblem, a magazine grid, a staff, a few squares. */
const BACKGROUND = { column: 'mesh', ribbon: 'staff', tableau: 'squares', drop: 'mesh', rhythm: 'squares', cloud: 'guides' };
/* One guide around the main word. */
const GUIDES = { calm: ['arches', 'underline', 'frame', 'rule'], lively: ['frame', 'crosshair', 'diamondFrame', 'arches', 'underline'] };
/* How a shot comes in: the first of a paragraph opens bigger than the ones inside it. */
const OPENERS = {
  gentle: ['dissolve', 'zoomIn', 'dissolve', 'leak'],
  lyrical: ['pushIn', 'dissolve', 'zoomIn', 'leak'],
  dramatic: ['flash', 'pushIn', 'zoomIn', 'glitch'],
  punchy: ['flash', 'whipIn', 'zoomIn', 'glitch'],
};
/* Cuts inside a paragraph: 商籁's quick blur most often. */
const CUTS = {
  gentle: ['flick', 'dissolve', 'flick'],
  lyrical: ['flick', 'pushIn', 'whipIn', 'flick', 'drift'],
  dramatic: ['flick', 'whipIn', 'cut', 'zoomIn', 'glitch'],
  punchy: ['flick', 'whipIn', 'cut', 'zoomIn', 'glitch'],
};
/* A sad song's shots: soft cuts, no camera tilt, quiet emblems. */
const CALM_SHOTS = { opener: ['dissolve', 'leak', 'dissolve'], cut: ['blurIn', 'dissolve', 'blurIn'] };
const PAGE_DECOR = { page: ['margin'], vertical: ['grid'], world: ['squares'] };

/*
 * How fast a paragraph is sung: Chinese characters a second (a Latin word counts as 1.8, about its
 * syllables), over the time its lines are actually sung.
 */
export const densityOf = (analysis, paragraph) => {
  let amount = 0;
  let time = 0;
  for (const index of paragraph.lines) {
    const item = analysis.items[index];
    const text = String(item.line.fullText ?? '');
    const wide = Array.from(text).filter((c) => WIDE.test(c)).length;
    const latin = text.replace(/[^\s\p{L}'’]/gu, ' ').split(/\s+/).filter((w) => w && !WIDE.test(w)).length;
    amount += wide + latin * 1.8;
    // The time the line is actually sung (its own end), not the time it stays on screen.
    const end = item.end > item.start + 0.3 ? item.end : item.renderEnd;
    time += Math.max(0.6, end - item.start);
  }
  return amount / Math.max(0.6, time);
};

/* When a line has been sung to its end: its own end time, or when the host hides it. */
const sungEndOf = (item) => (item.end > item.start + 0.3 ? Math.min(item.end, item.renderEnd + 1) : item.renderEnd);

/**
 * A paragraph's pace: 'rap' when it is sung very densely, else from the heard tempo (or the density
 * until the tempo is heard): 'fast', 'slow' or 'mid'. A sad song is always taken slowly.
 */
export const paceOf = ({ density, bpm, calm }) => {
  if (density >= 5.5) return 'rap';
  if (calm) return 'slow';
  if (bpm ? bpm >= 112 : density >= 4.2) return 'fast';
  if (bpm ? bpm < 92 : density < 3) return 'slow';
  return 'mid';
};
/* The kinds a pace brings in (after Folia's modes): 流光 and 云阶 for slow songs, 心象 for fast ones. */
const PACE_KINDS = { slow: ['lyric', 'cloud', 'lyric', 'cloud'], mid: ['lyric', 'cloud'], fast: ['shards', 'shards'], rap: ['shards'] };
const DIRECTIONS = [[1, 0], [-1, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

const pickAvoiding = (random, list, avoid = []) => {
  const pool = list.filter((x) => !avoid.includes(x));
  const from = pool.length ? pool : list;
  return from[Math.floor(random() * from.length) % from.length];
};

/* Phrase count without measuring: space-separated runs, or a long run counted as two. */
const phraseCount = (item) => {
  const runs = String(item.line.fullText ?? '').trim().split(/\s+/).filter(Boolean);
  return runs.reduce((n, run) => n + (Array.from(run).length >= 6 ? 2 : 1), 0);
};

const layoutFits = (layout, item, paragraph) => {
  const visible = visibleLength(item);
  // The line itself must be CJK: a mixed line ("Oh yeah …") would turn its Latin sideways.
  if (layout === 'vertical') return paragraph.wide >= 0.85 && item.wide >= 0.85 && visible <= 14;
  if (layout === 'stack' || layout === 'split') return phraseCount(item) >= 2;
  if (layout === 'hero') return visible >= 2;
  if (layout === 'type') return visible >= 4 && visible <= 28;
  return true;
};

/* Whether a paragraph is set as one page (every line stays on it), and which page. */
const pageFor = (paragraph, analysis) => {
  const items = paragraph.lines.map((index) => analysis.items[index]);
  if (items.length < 2 || items.length > 8) return null;
  if (paragraph.scene === 'stanza') return 'page';
  if (paragraph.scene === 'vertical') return items.length <= 7 && items.every((item) => layoutFits('vertical', item, paragraph)) ? 'vertical' : 'page';
  return null;
};

/* Lines grouped into word shots the way 商籁 groups them: up to four lines and six seconds, and here
 * at most a dozen words, so each word can be set large. */
const groupLines = (analysis, paragraph, segment) => {
  const groups = [];
  let group = [];
  let words = 0;
  for (const index of paragraph.lines) {
    const item = analysis.items[index];
    const count = Math.max(1, segment(item.line).filter((seg) => seg.isWordLike).length);
    if (group.length && (group.length >= 4 || item.renderEnd - analysis.items[group[0]].start > 6 || words + count > 12)) {
      groups.push(group);
      group = [];
      words = 0;
    }
    group.push(index);
    words += count;
  }
  if (group.length) groups.push(group);
  return groups;
};

/**
 * Shots. A stanza or a vertical scroll is one page for its whole paragraph. Every other paragraph
 * is cut into word shots of one to four lines (after 商籁): all their words set around one main
 * word, each appearing as it is sung, on a line-art emblem, a grid or a staff, the camera a little
 * close and pushing in slowly. Neighbouring shots never repeat a kind; a returning chorus keeps its
 * motions but is set anew; its last return is set as big as it gets.
 */
const buildShots = ({ analysis, paragraphs, seed, calm, segment, bpm }) => {
  const shots = [];
  const recipesByParagraph = new Map();
  let previous = null;
  let earlier = null;
  let stanzaPaged = false;
  for (const paragraph of paragraphs) {
    const random = createRandom((seed ^ hashString(`s${paragraph.index}`)) >>> 0);
    const temperament = paragraph.temperament;
    const pools = calm ? { ...TEMPERAMENTS[temperament], ...CALM } : TEMPERAMENTS[temperament];
    const openers = calm ? CALM_SHOTS.opener : OPENERS[temperament];
    const cuts = calm ? CALM_SHOTS.cut : CUTS[temperament];
    const source = paragraph.repeatOf !== undefined ? recipesByParagraph.get(paragraph.repeatOf) : null;
    const recipes = [];
    const common = { paragraph: paragraph.index, temperament, calm, energy: paragraph.energy, accentWeather: paragraph.accent, weather: paragraph.weather, climax: paragraph.climax };

    // Only the first stanza of a song is a manuscript page: with every stanza a page, the verses read
    // line after line (the user found that monotonous). Later ones get word shots; a repeat keeps its page.
    const pace = paceOf({ density: densityOf(analysis, paragraph), bpm, calm });
    let page = pageFor(paragraph, analysis);
    // A rapped verse (浮名): the whole paragraph on one sheet, the camera flying line to line.
    if (pace === 'rap' && paragraph.kind !== 'chorus' && paragraph.lines.length >= 2 && paragraph.lines.length <= 12) page = 'world';
    if (page === 'page' && stanzaPaged && !source?.page) page = null;
    if (page === 'page') stanzaPaged = true;
    if (page) {
      const base = source?.page ? source[0] : null;
      const items = paragraph.lines.map((index) => analysis.items[index]);
      const variant = base?.variant ?? random();
      const recipe = {
        variant,
        layout: page,
        enter: base?.enter ?? pickAvoiding(random, pools.enter, [previous?.enter]),
        // Quiet pages are written as they are sung; louder ones set each line as it arrives.
        mode: calm || temperament === 'gentle' || temperament === 'lyrical' ? 'sung' : 'line',
        sing: base?.sing ?? pickAvoiding(random, pools.sing, [previous?.sing]),
        exit: base?.exit ?? pickAvoiding(random, pools.exit, [previous?.exit]),
        camera: page === 'world' ? 'fly' : 'track',
        transIn: pickAvoiding(random, openers),
        order: 'forward',
        decor: [...(page === 'page' && pageStyleOf(variant) !== 'margin' ? [] : PAGE_DECOR[page]), 'emblem'],
        emblem: pickAvoiding(random, calm ? QUIET_EMBLEMS : EMBLEM_NAMES, [previous?.emblem]),
      };
      recipes.push(recipe);
      recipes.page = true;
      recipesByParagraph.set(paragraph.index, recipes);
      const [dirX, dirY] = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
      const kwLine = paragraph.keyword ? paragraph.lines.indexOf(paragraph.keyword.item) : -1;
      const shot = {
        id: `${paragraph.index}:page`,
        ...common,
        item: paragraph.lines[0],
        items: paragraph.lines,
        first: true,
        last: true,
        ...recipe,
        mirror: paragraph.mirror !== Boolean(base),
        dir: { x: dirX, y: dirY },
        keyword: kwLine >= 0 ? { line: kwLine, charIndex: paragraph.keyword.charIndex, length: paragraph.keyword.length } : null,
        show: Math.max(0, items[0].start - pools.lead),
        start: items[0].start,
        lastStart: items[items.length - 1].start,
        renderEnd: items[items.length - 1].renderEnd,
        sungEnd: sungEndOf(items[items.length - 1]),
      };
      shots.push(shot);
      earlier = previous;
      previous = shot;
      continue;
    }

    const groups = groupLines(analysis, paragraph, segment);
    const chorusLike = paragraph.kind === 'chorus' || paragraph.climax;
    const kindPool = SCENE_KINDS[paragraph.scene]
      ?? (calm ? (chorusLike ? KINDS.calmChorus : KINDS.calm) : KINDS[temperament] ?? KINDS.lyrical);
    groups.forEach((group, k) => {
      const items = group.map((index) => analysis.items[index]);
      const base = source && !source.page ? source[k] : null;
      const words = group.reduce((n, index) => n + segment(analysis.items[index].line).filter((seg) => seg.isWordLike).length, 0);
      // The pool for this shot: word kinds, a one-line layout for a single line, the climax's own.
      let pool = paragraph.climax ? ['impact', 'scatter', 'orbit'] : kindPool;
      if (calm) pool = pool.filter((kind) => kind !== 'scatter');
      // A ribbon is one row: only a few words fit it at a size worth having.
      if (words > 7 || items.reduce((n, item) => n + visibleLength(item), 0) > 10) pool = pool.filter((kind) => kind !== 'ribbon');
      if (!paragraph.wide || paragraph.wide < 0.85) pool = pool.filter((kind) => kind !== 'tableau');
      if (group.length === 1 && random() < 0.35) pool = [...pool, ...(calm ? SINGLE_LINE.calm : SINGLE_LINE.lively).filter((name) => layoutFits(name, items[0], paragraph))];
      pool = [...pool, ...PACE_KINDS[pace]];
      if (calm) pool = pool.filter((kind) => kind !== 'shards');
      if (!pool.length) pool = ['orbit'];
      // A returning chorus is set anew: another kind than the first time.
      const layout = pickAvoiding(random, pool, [previous?.layout, earlier?.layout, base?.layout]);
      const enter = base?.enter ?? pickAvoiding(random, pools.enter, [previous?.enter]);
      const emblems = calm ? QUIET_EMBLEMS : EMBLEM_NAMES;
      const guides = calm ? GUIDES.calm : GUIDES.lively;
      const background = BACKGROUND[layout] ?? 'emblem';
      const recipe = {
        layout,
        enter,
        // 流光, 云阶 and 心象 set the whole line out at once and light each unit as it is sung.
        mode: MOVING_KINDS.includes(layout) ? 'line' : 'sung',
        sing: base?.sing ?? pickAvoiding(random, pools.sing, [previous?.sing]),
        exit: base?.exit ?? pickAvoiding(random, pools.exit, [previous?.exit]),
        camera: 'focus',
        transIn: k === 0
          ? (paragraph.climax ? (calm ? 'leak' : temperament === 'gentle' || temperament === 'lyrical' ? 'zoomIn' : 'flash') : pickAvoiding(random, openers))
          : pickAvoiding(random, cuts, [previous?.transIn]),
        order: orderFor(enter, random()),
        decor: [background, pickAvoiding(random, guides, [previous?.decor?.[1]])],
        emblem: pickAvoiding(random, emblems, [previous?.emblem, base?.emblem]),
      };
      recipes.push(recipe);

      const [dirX, dirY] = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
      const kw = paragraph.keyword && group.includes(paragraph.keyword.item)
        ? { line: group.indexOf(paragraph.keyword.item), charIndex: paragraph.keyword.charIndex, length: paragraph.keyword.length }
        : null;
      const shot = {
        id: `${paragraph.index}:${k}`,
        ...common,
        item: group[0],
        items: group,
        first: k === 0,
        last: k === groups.length - 1,
        ...recipe,
        variant: random(),
        mirror: ((k % 2 === 1) !== paragraph.mirror) !== Boolean(base),
        dir: { x: dirX, y: dirY },
        keyword: kw,
        // The camera sits close and leans a little; a sad song's barely moves.
        zoom: calm ? 1.01 + 0.02 * random() : 1.03 + 0.04 * random() + (paragraph.climax ? 0.03 : 0),
        tilt: calm ? 0 : (random() - 0.5) * 0.04,
        // Words already sung stay; only a page's earlier lines step back further.
        pastFade: 0.3,
        show: Math.max(0, items[0].start - pools.lead),
        start: items[0].start,
        lastStart: items[items.length - 1].start,
        renderEnd: items[items.length - 1].renderEnd,
        sungEnd: sungEndOf(items[items.length - 1]),
      };
      shots.push(shot);
      earlier = previous;
      previous = shot;
    });
    recipesByParagraph.set(paragraph.index, recipes);
  }

  // Timing: a shot leaves as the next one arrives (they overlap for the transition), or when the host
  // would hide its line, but never before its last line has been sung to its end (leaving earlier
  // took the end of a line away, or words that had not appeared yet, wherever lines follow closely).
  // The next shot shows at most 0.35 s before that, yet is in place 0.15 s before its own line.
  shots.forEach((shot, i) => {
    const next = shots[i + 1];
    if (next) next.show = Math.max(next.show, Math.min(shot.sungEnd - 0.35, next.start - 0.15), shot.show + 0.25);
    const nextShow = next ? next.show : Infinity;
    const leave = Math.min(shot.renderEnd + 0.15, nextShow + 0.12);
    shot.exitStart = Math.max(shot.show + 0.9, shot.sungEnd, Math.min(leave, shot.lastStart + 30));
    shot.transOut = next && next.show - shot.exitStart < 0.5
      ? ({ whipIn: 'whipOut', pushIn: 'pushOut', zoomIn: 'pushOut', glitch: 'cutOut', flash: 'cutOut', cut: 'cutOut', flick: 'flickOut', blurIn: 'blurOut' }[next.transIn] ?? 'none')
      : 'none';
    shot.nextDir = next?.dir ?? shot.dir;
  });
  return shots;
};

// ---------------------------------------------------------------- paragraph transitions

/* How one paragraph hands over to the next (after 凝彩 and 商籁): a colour band wiping across the
 * frame, a pan of the whole frame, or a blur dissolve. A sad song only blurs or pans, slowly. */
const TRANSITIONS = {
  calm: [['blur', 3], ['pan', 1.2]],
  gentle: [['blur', 2], ['pan', 1]],
  lyrical: [['pan', 1.4], ['blur', 1.1], ['wipe', 0.9]],
  dramatic: [['wipe', 1.5], ['pan', 1.2], ['blur', 0.7]],
  punchy: [['wipe', 1.8], ['pan', 1.2], ['blur', 0.4]],
};
const ANGLES = [0, Math.PI, Math.PI / 2, -Math.PI / 2, 0.35, Math.PI - 0.35, -0.35, Math.PI + 0.35];

/** Transitions between paragraphs; returns the wipe bands to draw. */
const stageParagraphs = ({ paragraphs, shots, seed, calm }) => {
  const random = createRandom((seed ^ hashString('staging')) >>> 0);
  const shotsOf = (p) => shots.filter((shot) => shot.paragraph === p.index);
  const wipes = [];
  for (let i = 1; i < paragraphs.length; i += 1) {
    const before = shotsOf(paragraphs[i - 1]);
    const after = shotsOf(paragraphs[i]);
    if (!before.length || !after.length) continue;
    const old = before[before.length - 1];
    const next = after[0];
    // A lively song keeps some of its openers (flash, glitch, zoom) for variety.
    if (!calm && random() < 0.3) continue;
    const kind = weightedPick(random, TRANSITIONS[calm ? 'calm' : paragraphs[i].temperament] ?? TRANSITIONS.lyrical);
    const angle = ANGLES[Math.floor(random() * ANGLES.length)];
    const adjacent = next.show - old.exitStart < 0.6;
    next.angle = angle;
    // A wipe hides the whole frame and a pan carries it off: only once the old line has been sung.
    const done = old.sungEnd <= next.show + 0.05;
    if (kind === 'wipe' && !done) {
      next.transIn = 'blurIn';
      if (adjacent) {
        old.transOut = 'blurOut';
        old.angle = angle;
      }
    } else if (kind === 'wipe') {
      // The band covers the frame at `at`: the old shot goes under it, the new one comes out.
      const at = next.show + 0.2;
      wipes.push({ t: at, angle, tone: i % 4 });
      next.transIn = 'wipeIn';
      next.wipeAt = at;
      if (old.exitStart > at - 0.45) {
        old.exitStart = Math.min(old.exitStart, at);
        old.transOut = 'wipeOut';
        old.wipeAt = at;
      }
    } else {
      next.transIn = kind === 'pan' ? 'panIn' : 'blurIn';
      if (adjacent) {
        old.transOut = kind === 'pan' ? 'panOut' : 'blurOut';
        old.angle = angle;
        // A pan moves both frames as one strip: the old one starts leaving as the new one arrives.
        if (kind === 'pan' && done) old.exitStart = Math.max(old.show + 0.9, next.show);
        else if (kind === 'pan') old.transOut = 'blurOut';
      }
    }
  }
  return { wipes };
};

/** The paragraph on screen (or coming up within `ahead` seconds) at time `t`, or null. */
export const paragraphAt = (plan, t, ahead = 0) => {
  let found = null;
  for (const paragraph of plan.paragraphs) {
    if (t >= paragraph.show - ahead && t <= paragraph.end) found = paragraph;
    if (paragraph.show - ahead > t) break;
  }
  return found;
};

/** Plain Intl.Segmenter word split, for hosts or tests without `folium.lyrics.segmentWords`. */
export const fallbackSegment = (() => {
  let segmenter = null;
  return (line) => {
    const text = String(line?.fullText ?? '');
    if (typeof Intl?.Segmenter === 'function') {
      segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
      return [...segmenter.segment(text)].map((s) => ({ segment: s.segment, index: s.index, isWordLike: Boolean(s.isWordLike) }));
    }
    return text.split(/(\s+)/).map((segment) => ({ segment, index: 0, isWordLike: /\S/.test(segment) }));
  };
})();
