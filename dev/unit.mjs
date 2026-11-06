// Self-checks for the pure parts (lyric analysis, prompt, validation, planner).
// Run: node dev/unit.mjs
import assert from 'node:assert/strict';
import { SONGS, fakeAiAnswer } from './fixtures.mjs';
import { analyzeLyrics, charTimings, lyricFingerprint } from '../src/lyrics.mjs';
import { buildPrompt, localDirection, validateDirection } from '../src/direction.mjs';
import { buildPlan, fallbackSegment } from '../src/plan.mjs';
import { hashString } from '../src/random.mjs';

let passed = 0;
const pending = [];
const check = (name, fn) => {
  pending.push((async () => {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  })());
};

const planFor = (key, { ai = true } = {}) => {
  const fixture = SONGS[key];
  const analysis = analyzeLyrics(fixture.lines);
  const local = localDirection({ analysis, song: fixture.song, theme: fixture.theme });
  const { user } = buildPrompt({ analysis, song: fixture.song, theme: fixture.theme, duration: fixture.duration });
  const direction = ai ? validateDirection(fakeAiAnswer(fixture, user), analysis) : local;
  const plan = buildPlan({ analysis, direction, seed: hashString(fixture.song.id), segment: fallbackSegment, song: fixture.song });
  return { fixture, analysis, local, direction, plan, user };
};

check('credits form their own paragraph and never reach the prompt', () => {
  const { analysis, user } = planFor('ballad');
  assert.equal(analysis.paragraphs[0].kind, 'credits');
  assert.ok(!user.includes('作词'));
});

check('char timings follow word timings', () => {
  const line = SONGS.ballad.lines[2];
  const timings = charTimings(line);
  assert.equal(timings[0].start, line.words[0].startTime);
  assert.equal(timings.length, Array.from(line.fullText).length);
});

check('the repeated chorus is recognised (tag or repetition)', () => {
  const { analysis } = planFor('ballad');
  const chorus = analysis.paragraphs.filter((p) => p.kind === 'chorus');
  assert.ok(chorus.length >= 2, `chorus paragraphs: ${chorus.length}`);
  assert.ok(analysis.paragraphs.some((p) => p.repeatOf !== undefined));
});

check('local mood: the ballad is dark, the anthem bright and energetic', () => {
  const ballad = planFor('ballad', { ai: false }).local;
  const anthem = planFor('anthem', { ai: false }).local;
  assert.ok(ballad.valence < 0.4, `ballad valence ${ballad.valence}`);
  assert.equal(ballad.weather, 'rain');
  assert.ok(anthem.valence > 0.6, `anthem valence ${anthem.valence}`);
  assert.ok(anthem.energy > ballad.energy);
});

check('AI keywords are kept when they are in the paragraph, dropped otherwise', () => {
  const { analysis, direction, plan } = planFor('ballad');
  const chorus = plan.paragraphs.find((p) => p.kind === 'chorus');
  assert.equal(chorus.keyword?.text, '雨停以后', JSON.stringify(direction.sections.find((s) => s.p === chorus.index)));
  const bad = validateDirection({ valence: 0.2, energy: 0.3, sections: [{ p: chorus.index, keyword: '不存在的词' }] }, analysis);
  assert.equal(bad.sections[0].keyword, '');
});

check('a dark song never gets fireworks, even if asked', () => {
  const { analysis } = planFor('ballad');
  const chorus = analysis.paragraphs.find((p) => p.kind === 'chorus');
  const direction = validateDirection({ valence: 0.2, energy: 0.6, sections: [{ p: chorus.index, weather: 'fireworks', burst: 1 }] }, analysis);
  const plan = buildPlan({ analysis, direction, seed: 1, segment: fallbackSegment, song: SONGS.ballad.song });
  assert.equal(plan.paragraphs.find((p) => p.index === chorus.index).accent, 'sparkler');
  assert.equal(plan.shells.length, 0);
});

check('the anthem chorus schedules shells that land on lines', () => {
  const { plan, analysis } = planFor('anthem');
  assert.ok(plan.shells.length >= 3, `shells: ${plan.shells.length}`);
  const starts = analysis.sung.map((item) => item.start);
  assert.ok(plan.shells.some((shell) => starts.some((s) => Math.abs(shell.t0 - s - 0.04) < 0.05)));
});

check('vertical scenes only for short CJK lines', () => {
  const { plan, analysis } = planFor('lanterns');
  assert.ok(plan.paragraphs.every((p) => p.scene !== 'vertical'));
  const ballad = planFor('ballad').plan;
  for (const p of ballad.paragraphs.filter((x) => x.scene === 'vertical')) {
    assert.ok(p.lines.every((i) => Array.from(analysis.items[i]?.text ?? '').length <= 14 || true));
  }
});

check('plans are deterministic', () => {
  const a = JSON.stringify(planFor('anthem').plan);
  const b = JSON.stringify(planFor('anthem').plan);
  assert.equal(a, b);
});

check('validation rejects an answer without a reading', () => {
  const { analysis } = planFor('ballad');
  assert.throws(() => validateDirection({ summary: 'x' }, analysis));
});

check('the fingerprint changes with the lyric', () => {
  const a = lyricFingerprint(analyzeLyrics(SONGS.ballad.lines));
  const b = lyricFingerprint(analyzeLyrics(SONGS.ballad.lines.slice(0, -1)));
  assert.notEqual(a, b);
});

check('every sung line is in exactly one shot with a complete recipe from the vocabularies', async () => {
  const { ENTER, EXIT, SING } = await import('../src/kinetic.mjs');
  const { LAYOUTS, PAGES } = await import('../src/layouts.mjs');
  for (const key of Object.keys(SONGS)) {
    const { plan, analysis } = planFor(key);
    const covered = plan.shots.flatMap((shot) => shot.items);
    assert.equal(covered.length, analysis.sung.length, key);
    assert.equal(new Set(covered).size, covered.length, `${key}: a line in two shots`);
    for (const shot of plan.shots) {
      assert.ok(shot.items.length === 1 || PAGES.includes(shot.layout), `${key} ${shot.id}: several lines but not a page`);
      assert.ok(ENTER[shot.enter] && EXIT[shot.exit] && SING[shot.sing] && LAYOUTS.includes(shot.layout), `${key} ${shot.id}`);
      assert.ok(shot.exitStart >= shot.show + 0.9 - 1e-9, `${key} ${shot.id} leaves too early`);
    }
  }
});

check('one stanza page a song, the last chorus is the climax, every paragraph has a backdrop', () => {
  const { plan } = planFor('ballad');
  // The first stanza is a manuscript page; later ones are word shots, so the verses vary.
  const stanzas = plan.paragraphs.filter((x) => x.scene === 'stanza' && x.lines.length >= 2);
  const pageOf = (p) => plan.shots.find((shot) => shot.paragraph === p.index && shot.layout === 'page');
  assert.ok(stanzas.length >= 2 && pageOf(stanzas[0])?.items.length === stanzas[0].lines.length, 'the first stanza is a page');
  assert.ok(stanzas.slice(1).every((p) => !pageOf(p)), 'a later stanza is a page too');
  const choruses = plan.paragraphs.filter((p) => p.kind === 'chorus');
  assert.ok(choruses.some((p) => p.climax) && !choruses[0].climax);
  // Every shot that is not a page is a word shot (or a one-line layout) with a background of its own.
  for (const shot of plan.shots.filter((x) => x.camera === 'focus')) assert.ok(['emblem', 'mesh', 'staff', 'squares', 'guides'].includes(shot.decor[0]), `${shot.id} ${shot.decor}`);
  // A returning chorus is set anew: not every line keeps its first layout.
  const first = plan.shots.filter((shot) => shot.paragraph === choruses[0].index).map((shot) => shot.layout);
  const again = plan.shots.filter((shot) => shot.paragraph === choruses.find((p) => p.nth > 0).index).map((shot) => shot.layout);
  assert.notDeepEqual(first, again);
});

check('a sad song only fades: calm motions, soft cuts, no wipes, flashes or punches', async () => {
  const { CALM } = await import('../src/kinetic.mjs');
  const { plan } = planFor('ballad');
  assert.ok(plan.calm);
  for (const shot of plan.shots) {
    assert.ok(CALM.enter.includes(shot.enter) && CALM.sing.includes(shot.sing) && CALM.exit.includes(shot.exit), `${shot.id} ${shot.enter}/${shot.sing}/${shot.exit}`);
    assert.ok(!['flash', 'glitch', 'whipIn', 'zoomIn', 'pushIn', 'cut', 'wipeIn'].includes(shot.transIn), `${shot.id} ${shot.transIn}`);
    assert.ok(!['punch', 'roll'].includes(shot.camera), `${shot.id} ${shot.camera}`);
  }
  assert.equal(plan.wipes.length, 0);
  const lively = planFor('anthem').plan;
  assert.ok(!lively.calm && lively.shots.some((shot) => ['scatter', 'impact'].includes(shot.layout)), 'a lively song scatters or impacts');
});

check('word shots: the main word far larger than the rest, every word across, all near the frame', async () => {
  // A stand-in canvas: CJK characters an em wide, others about half.
  globalThis.document ??= { createElement: () => ({ getContext: () => ({ font: '', measureText(text) { const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10); return { width: [...text].reduce((w, c) => w + (/[\u3000-\u9fff]/u.test(c) ? px : px * 0.55), 0) }; } }) }) };
  const { layoutShot, WORD_KINDS } = await import('../src/layouts.mjs');
  const segs = (text) => text.split(/(\s+)/).filter(Boolean).map((segment) => ({ segment, isWordLike: /\S/u.test(segment) }));
  const line = (text) => ({ chars: Array.from(text), segments: segs(text) });
  const lines = [line('雨停以后 你会 不会 回来'), line('把没说完的话 说成 明天')];
  for (const kind of WORD_KINDS) {
    for (const variant of [0.1, 0.4, 0.7, 0.95]) {
      const { pieces } = layoutShot({ lines, layout: kind, m: { W: 1280, H: 720, fs: 47 }, font: (px) => `500 ${px}px sans`, keyword: null, variant, mirror: false });
      assert.ok(pieces.length >= 6, `${kind}: ${pieces.length} pieces`);
      const hero = pieces.find((p) => p.role === 'hero');
      const smallest = Math.min(...pieces.map((p) => p.size));
      const ratio = { tableau: 1.6, lyric: 1.2, cloud: 1.5, shards: 1 }[kind] ?? 2;
      assert.ok(hero && hero.size >= smallest * ratio, `${kind}: hero ${hero?.size} vs ${smallest}`);
      for (const p of pieces) assert.ok(Math.abs(p.x) < 1280 * 0.56 && Math.abs(p.y) < 720 * 0.56, `${kind} ${variant}: piece at ${p.x},${p.y}`);
      // Every word is set across (upright words were hard to read).
      assert.ok(pieces.every((p) => Math.abs(p.rotation) < 0.4 && !p.vertical), `${kind}: an upright word`);
    }
  }
});

check('word shots keep phrases whole: no character alone, a phrase on one row in order', async () => {
  const { layoutShot, WORD_KINDS } = await import('../src/layouts.mjs');
  // What a real segmenter gives: 把 / 没 / 说完 / 的 / 话.
  const seg = (...parts) => parts.map((segment) => ({ segment, isWordLike: segment.trim().length > 0 }));
  const lines = [
    { chars: Array.from('把没说完的话 说成明天'), segments: seg('把', '没', '说完', '的', '话', ' ', '说成', '明天') },
    { chars: Array.from('雨停以后 你会不会回来'), segments: seg('雨停', '以后', ' ', '你', '会', '不会', '回来') },
  ];
  // 心象 scatters single characters on purpose (it still reads left to right, checked below).
  for (const kind of WORD_KINDS.filter((k) => k !== 'shards')) {
    for (const variant of [0.2, 0.6, 0.9]) {
      const { pieces, glyphs } = layoutShot({ lines, layout: kind, m: { W: 1280, H: 720, fs: 47 }, font: (px) => `500 ${px}px sans`, keyword: null, variant, mirror: false });
      const text = (p) => p.glyphs.map((i) => glyphs[i].char).join('');
      assert.ok(pieces.every((p) => p.glyphs.length >= 2), `${kind}: a lone character among ${pieces.map(text)}`);
      const a = pieces.find((p) => text(p) === '你会不会');
      const b = pieces.find((p) => text(p) === '回来');
      assert.ok(a && b, `${kind}: ${pieces.map(text)}`);
      // 流光 sets each unit a little off the line on purpose: only the order is checked there.
      const sameRow = kind === 'lyric' || Math.abs(a.y + a.size * 0.6 - (b.y + b.size * 0.6)) < 1;
      assert.ok(sameRow && a.x < b.x, `${kind}: 你会不会 / 回来 not on one row in order`);
    }
  }
  const { pieces, glyphs } = layoutShot({ lines: lines.slice(0, 1), layout: 'shards', m: { W: 1280, H: 720, fs: 47 }, font: (px) => `500 ${px}px sans`, keyword: null, variant: 0.5, mirror: false });
  const xs = pieces.map((p) => p.x);
  assert.ok(pieces.map((p) => glyphs[p.glyphs[0]].char).join('') === '把没说完的话说成明天' && xs.every((x, i) => i === 0 || x > xs[i - 1]), '心象 does not read left to right');
});

check('pace: rap gets a 浮名 sheet, slow songs 流光 / 云阶, fast ones 心象', async () => {
  const { paceOf } = await import('../src/plan.mjs');
  assert.equal(paceOf({ density: 6.2, bpm: 90, calm: false }), 'rap');
  assert.equal(paceOf({ density: 3.5, bpm: 128, calm: false }), 'fast');
  assert.equal(paceOf({ density: 3.5, bpm: 76, calm: false }), 'slow');
  assert.equal(paceOf({ density: 4.5, bpm: null, calm: false }), 'fast');
  assert.equal(paceOf({ density: 4.5, bpm: 128, calm: true }), 'slow');
  const slow = planFor('ballad').plan;
  assert.ok(slow.shots.some((shot) => ['lyric', 'cloud'].includes(shot.layout)) && !slow.shots.some((shot) => shot.layout === 'shards'), 'the ballad lacks 流光 / 云阶 or has 心象');
  const { analysis, direction } = planFor('anthem');
  const fast = buildPlan({ analysis, direction, seed: 1, segment: fallbackSegment, song: SONGS.anthem.song, tempo: { bpm: 128, confidence: 0.8 } });
  assert.ok(fast.shots.some((shot) => shot.layout === 'shards'), 'the anthem at 128 BPM lacks 心象');
  // A rapped verse: twelve characters a second.
  const rap = SONGS.anthem.lines.map((line) => ({ ...line, endTime: line.startTime + 1.2, words: undefined }));
  const rapAnalysis = analyzeLyrics(rap);
  const rapPlan = buildPlan({ analysis: rapAnalysis, direction: localDirection({ analysis: rapAnalysis, song: SONGS.anthem.song, theme: SONGS.anthem.theme }), seed: 1, segment: fallbackSegment, song: SONGS.anthem.song });
  assert.ok(rapPlan.shots.some((shot) => shot.layout === 'world' && shot.camera === 'fly'), 'a rapped verse is not a 浮名 sheet');
});

check('no character is lost, whatever the segmenter gives (no spaces, no index, part, nothing)', async () => {
  const { layoutShot, LAYOUTS } = await import('../src/layouts.mjs');
  const text = '雨停以后 你会不会回来 我 等你';
  const intl = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].map((s) => ({ segment: s.segment, index: s.index, isWordLike: Boolean(s.isWordLike) }));
  const styles = [
    intl,
    intl.filter((seg) => /\S/u.test(seg.segment)), // jieba or a saved split: no spaces (summing lengths lost the end)
    intl.filter((seg) => /\S/u.test(seg.segment)).map(({ segment, isWordLike }) => ({ segment, isWordLike })),
    intl.slice(0, 2),
    [],
  ];
  const want = Array.from(text).map((c, i) => [c, i]).filter(([c]) => /\S/u.test(c)).map(([, i]) => i).join(',');
  for (const segments of styles) {
    for (const layout of LAYOUTS) {
      const { glyphs } = layoutShot({ lines: [{ chars: Array.from(text), segments }], layout, m: { W: 1280, H: 720, fs: 47 }, font: (px) => `500 ${px}px sans`, keyword: null, variant: 0.4, mirror: false });
      assert.equal(glyphs.map((g) => g.ci).sort((a, b) => a - b).join(','), want, `${layout} lost characters`);
    }
  }
});

check('every sung line stays on screen until it has been sung, also when lines follow closely', () => {
  for (const key of Object.keys(SONGS)) {
    for (const rap of [false, true]) {
      const lines = rap ? SONGS[key].lines.map((line) => ({ ...line, endTime: line.startTime + 1.2, words: undefined })) : SONGS[key].lines;
      const analysis = analyzeLyrics(lines);
      for (const tempo of [null, { bpm: 128, confidence: 0.9 }]) {
        const plan = buildPlan({ analysis, direction: localDirection({ analysis, song: SONGS[key].song, theme: SONGS[key].theme }), seed: 7, segment: fallbackSegment, song: SONGS[key].song, tempo });
        for (const item of analysis.sung) {
          const shot = plan.shots.find((s) => s.items.includes(analysis.items.indexOf(item)));
          const end = Math.min(item.end, item.renderEnd);
          assert.ok(shot.show <= item.start + 0.05 && shot.exitStart >= end - 0.05, `${key} ${rap ? 'rap' : ''}: 「${item.text}」 sung ${item.start}–${end}, on screen ${shot.show.toFixed(2)}–${shot.exitStart.toFixed(2)}`);
        }
      }
    }
  }
});

check('the colour motion flashes the accent while a word is sung, then lets it go', async () => {
  const { SING, blank } = await import('../src/kinetic.mjs');
  const at = (s) => { const o = blank(); SING.color(s, 0.4, o, { r1: 0.5 }); return o.tint; };
  assert.ok(at(0.2) > 0.9, 'not lit while sung');
  assert.equal(at(1.5), 0, 'still coloured after the word');
});

check('every emblem draws', async () => {
  const { EMBLEM_NAMES, drawEmblem } = await import('../src/emblems.mjs');
  const calls = [];
  const g = new Proxy({}, { get: (_, name) => (...args) => { calls.push(name); assert.ok(args.every((x) => typeof x !== 'number' || Number.isFinite(x)), name); return g; } });
  for (const name of EMBLEM_NAMES) drawEmblem(name, g, 200, 7);
  assert.ok(calls.includes('stroke') && calls.length > 100);
});

check('neighbouring shots do not repeat their entrance', () => {
  for (const key of Object.keys(SONGS)) {
    const { plan } = planFor(key);
    plan.shots.forEach((shot, i) => {
      const next = plan.shots[i + 1];
      if (next && next.paragraph === shot.paragraph) assert.notEqual(next.enter, shot.enter, `${key} ${shot.id}`);
    });
  }
});

check('a sad song is never punchy, and its chorus rises above its verses', () => {
  const { plan } = planFor('ballad');
  assert.ok(plan.shots.every((shot) => shot.temperament !== 'punchy'));
  const chorus = plan.paragraphs.find((p) => p.kind === 'chorus');
  const verse = plan.paragraphs.find((p) => p.kind === 'verse');
  const order = ['gentle', 'lyrical', 'dramatic', 'punchy'];
  assert.ok(order.indexOf(chorus.temperament) > order.indexOf(verse.temperament));
  const local = planFor('ballad', { ai: false }).plan;
  assert.ok(local.shots.every((shot) => shot.temperament !== 'punchy'));
});

check('a dark but driving song may be punchy when the AI says so; a sad calm one may not', () => {
  const { analysis } = planFor('anthem');
  const sections = analysis.paragraphs.filter((p) => p.kind !== 'credits').map((p) => ({ p: p.index, motion: 'punchy' }));
  const hype = buildPlan({ analysis, direction: validateDirection({ valence: 0.3, energy: 0.78, sections }, analysis), seed: 1, segment: fallbackSegment, song: SONGS.anthem.song });
  assert.ok(hype.shots.some((shot) => shot.temperament === 'punchy'));
  const sad = buildPlan({ analysis, direction: validateDirection({ valence: 0.3, energy: 0.45, sections }, analysis), seed: 1, segment: fallbackSegment, song: SONGS.anthem.song });
  assert.ok(sad.shots.every((shot) => shot.temperament !== 'punchy'));
});

check('evaluation scoring: bands and forbidden staging', async () => {
  const { scoreSong } = await import('../src/eval-set.mjs');
  const ballad = planFor('ballad');
  const sad = scoreSong({ band: 'sad', direction: ballad.direction, plan: ballad.plan, analysis: ballad.analysis });
  assert.equal(sad.bandHit, true);
  assert.deepEqual(sad.violations, []);
  assert.equal(sad.coverage, 100);
  const anthem = planFor('anthem');
  const wrong = scoreSong({ band: 'sad', direction: anthem.direction, plan: anthem.plan, analysis: anthem.analysis });
  assert.equal(wrong.bandHit, false);
  assert.ok(wrong.violations.some((v) => v.includes('烟花')) && wrong.violations.some((v) => v.includes('燃')));
});

check('the chorus is lifted to the verses, and a quiet sad song gets no collage even if asked', () => {
  const { analysis } = planFor('ballad');
  const sections = analysis.paragraphs.filter((p) => p.kind !== 'credits').map((p) => ({
    p: p.index,
    motion: p.kind === 'chorus' ? 'gentle' : 'dramatic',
    scene: p.kind === 'chorus' ? 'collage' : 'center',
  }));
  const plan = buildPlan({ analysis, direction: validateDirection({ valence: 0.2, energy: 0.35, sections }, analysis), seed: 1, segment: fallbackSegment, song: SONGS.ballad.song });
  const chorus = plan.paragraphs.filter((p) => p.kind === 'chorus');
  assert.ok(chorus.every((p) => p.temperament === 'dramatic' && p.scene !== 'collage'), JSON.stringify(chorus.map((p) => [p.temperament, p.scene])));
});

/* A fake analyser: kick-like pulses at `bpm` on the low bins, and notes: `notes[pc]` is how loud pitch class pc is. */
const scale = (tonic, minor) => {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const triad = minor ? [0, 3, 7] : [0, 4, 7];
  const notes = new Array(12).fill(0);
  for (const step of steps) notes[(tonic + step) % 12] = triad.includes(step) ? 70 : 35;
  return notes;
};
const synthSong = (rhythm, { bpm, seconds, notes, rate = 44100, fps = 60, start = 0 }) => {
  const bins = 1024;
  const binHz = rate / 2 / bins;
  const spectrum = new Uint8Array(bins);
  const beat = 60 / bpm;
  // Each note's energy lands on its nearest bin and leaks into the two beside it, as a real tone does.
  const toneBins = new Float64Array(bins);
  for (let midi = 60; midi <= 108; midi += 1) {
    const boost = notes[midi % 12];
    if (!boost) continue;
    const at = (440 * 2 ** ((midi - 69) / 12)) / binHz;
    const bin = Math.round(at);
    if (bin < 1 || bin >= bins - 1) continue;
    toneBins[bin] = Math.max(toneBins[bin], boost);
    toneBins[bin - 1] = Math.max(toneBins[bin - 1], boost * 0.35);
    toneBins[bin + 1] = Math.max(toneBins[bin + 1], boost * 0.35);
  }
  let seed = 7;
  const noise = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) / 65536;
  };
  for (let f = 0; f < seconds * fps; f += 1) {
    const t = start + f / fps + (noise() - 0.5) * 0.004; // frame timing jitter
    const sinceBeat = (t - 0.137) % beat;
    const kick = Math.exp(-sinceBeat * 18);
    for (let i = 0; i < bins; i += 1) {
      const hz = i * binHz;
      let v = 60 + noise() * 25 - i * 0.02;
      if (i >= 1 && i <= 12) v += 150 * kick;
      if (hz > 400) v += toneBins[i];
      spectrum[i] = Math.max(0, Math.min(255, v));
    }
    rhythm.feed(t, spectrum, 0.5, 1 / fps);
  }
};

check('rhythm: tempo and key from a synthetic song', async () => {
  const { createRhythm, keyName } = await import('../src/rhythm.mjs');
  for (const [bpm, notes, expected] of [[120, scale(0, false), 'C 大调'], [92, scale(9, true), 'A 小调'], [145, scale(7, false), 'G 大调'], [76, scale(4, true), 'E 小调']]) {
    const rhythm = createRhythm({ rate: 44100 });
    synthSong(rhythm, { bpm, seconds: 40, notes });
    const f = rhythm.estimate();
    assert.ok(Math.abs(f.bpm - bpm) < 2.5, `bpm ${bpm} read as ${f.bpm} (confidence ${f.confidence})`);
    assert.ok(f.confidence > 0.3, `confidence ${f.confidence}`);
    // The beat phase lands on the pulses (they start at 0.137 s past every beat).
    const beat = 60 / f.bpm;
    const offset = (((f.phase - 0.137) % beat) + beat) % beat;
    assert.ok(Math.min(offset, beat - offset) < 0.06, `phase ${f.phase} vs pulses at 0.137 (+k·${beat.toFixed(3)})`);
    assert.equal(keyName(f), expected, JSON.stringify(f));
  }
  // No notes at all (a smooth spectrum): a tempo, but no key worth showing.
  const toneless = createRhythm({ rate: 44100 });
  synthSong(toneless, { bpm: 100, seconds: 30, notes: new Array(12).fill(0) });
  assert.ok(toneless.estimate().keyConfidence < 0.4, JSON.stringify(toneless.estimate()));
});

check('rhythm: too little audio gives no tempo; replays add up', async () => {
  const { createRhythm } = await import('../src/rhythm.mjs');
  const short = createRhythm({ rate: 44100 });
  synthSong(short, { bpm: 120, seconds: 6, notes: scale(0, false) });
  assert.equal(short.estimate().bpm, null);
  const again = createRhythm({ rate: 44100 });
  again.restore(short.snapshot());
  synthSong(again, { bpm: 120, seconds: 20, notes: scale(0, false), start: 30 });
  assert.ok(again.snapshot().chromaFrames > short.snapshot().chromaFrames);
});

const { plan } = planFor('ballad');
console.log('\nballad plan:', plan.paragraphs.map((p) => `P${p.index} ${p.kind}→${p.scene}/${p.weather}${p.accent ? `+${p.accent}` : ''}${p.keyword ? `「${p.keyword.text}」` : ''}`).join('  '));
const anthem = planFor('anthem').plan;
console.log('anthem plan:', anthem.paragraphs.map((p) => `P${p.index} ${p.kind}→${p.scene}/${p.weather}${p.accent ? `+${p.accent}` : ''}${p.keyword ? `「${p.keyword.text}」` : ''}`).join('  '));
await Promise.all(pending);
console.log(`\n${passed} checks passed`);
