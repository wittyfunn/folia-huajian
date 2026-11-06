// Developer tool (M1): runs the real pipeline over EVAL_SET inside Folia — lyrics
// from Folia's online sources, the user's own AI endpoint, the planner — and scores
// every song against its mood band, for the AI reading and the local one side by
// side. Nothing touches the player or the per-song memory.
//
// AI answers are cached under `evalDirs`, keyed by the lyric and the prompt, so a
// rerun after tuning the planner or the local reading costs nothing; a prompt
// change invalidates the cache by itself. The report goes to `evalLast`.
//
// Only `node dev/build.mjs --dev` bundles this module; the release build swaps it
// for `createEvaluator = null`, so users get neither the song list nor the code.

import { BANDS, EVAL_SET, EVAL_SET_VERSION, scoreSong } from './eval-set.mjs';
import { analyzeLyrics, lyricFingerprint } from './lyrics.mjs';
import { buildPrompt, localDirection, validateDirection } from './direction.mjs';
import { buildPlan, fallbackSegment } from './plan.mjs';
import { hashString } from './random.mjs';

const normalize = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const count = (list, key) => list.reduce((map, item) => ({ ...map, [item[key]]: (map[item[key]] ?? 0) + 1 }), {});
const round = (value) => Math.round(value * 100) / 100;

export const createEvaluator = ({ folium, store, director }) => {
  let running = false;

  /* Search hits that plausibly are this song, best first (same rule as AI 导演 Plus). */
  const candidatesFor = async (item) => {
    const page = await folium.omni.searchSongs(`${item.title} ${item.artist}`, { limit: 8 });
    const title = normalize(item.title);
    const artists = item.artist.split(/\s+/).map(normalize).filter(Boolean);
    const score = (song) => {
      const found = normalize(song.title);
      const credits = normalize(song.artist);
      const titleScore = found === title ? 2 : (found.includes(title) || title.includes(found) ? 1 : 0);
      const artistScore = artists.some((artist) => credits.includes(artist)) ? 1 : 0;
      return titleScore + artistScore + (credits.startsWith(artists[0] ?? '\u0000') ? 0.5 : 0);
    };
    return [...page.items].filter((song) => score(song) >= 2).sort((a, b) => score(b) - score(a)).slice(0, 3);
  };

  const lyricsFor = async (item) => {
    const candidates = await candidatesFor(item);
    if (candidates.length === 0) throw new Error('在线音源里找不到这首歌');
    for (const song of candidates) {
      const lyrics = await folium.omni.getLyrics(song).catch(() => ({ lines: [], isPureMusic: false }));
      if (lyrics.lines.length > 0 || lyrics.isPureMusic) return { song, lines: lyrics.lines };
    }
    return { song: candidates[0], lines: [] };
  };

  const planOf = (analysis, direction, song) => buildPlan({ analysis, direction, seed: hashString(`${song.title}|${song.artist}`), segment: fallbackSegment, song });

  /* The parts of a plan worth reading in a report. */
  const shape = (direction, plan, score) => ({
    valence: round(direction.valence),
    energy: round(direction.energy),
    warmth: round(direction.warmth),
    weather: plan.weather,
    summary: direction.summary,
    temperaments: count(plan.paragraphs, 'temperament'),
    scenes: count(plan.paragraphs, 'scene'),
    accents: count(plan.paragraphs.filter((p) => p.accent), 'accent'),
    shells: plan.shells.length,
    bandHit: score.bandHit,
    violations: score.violations,
    coverage: score.coverage,
  });

  const summarize = (rows) => {
    const scored = rows.filter((row) => !row.error);
    const rate = (pick) => (scored.length ? Math.round((scored.filter(pick).length / scored.length) * 100) : 0);
    const withAi = scored.filter((row) => row.ai);
    const byBand = {};
    for (const row of scored) {
      const band = (byBand[row.band] ??= { songs: 0, aiHit: 0, localHit: 0 });
      band.songs += 1;
      if (row.ai?.bandHit) band.aiHit += 1;
      if (row.local.bandHit) band.localHit += 1;
    }
    return {
      songs: rows.length,
      scored: scored.length,
      failed: rows.length - scored.length,
      aiBandHit: withAi.length ? Math.round((withAi.filter((row) => row.ai.bandHit).length / withAi.length) * 100) : null,
      localBandHit: rate((row) => row.local.bandHit),
      aiViolations: withAi.reduce((n, row) => n + row.ai.violations.length, 0),
      localViolations: scored.reduce((n, row) => n + row.local.violations.length, 0),
      byBand,
      tokens: rows.reduce((t, row) => ({ input: t.input + (row.tokens?.input ?? 0), output: t.output + (row.tokens?.output ?? 0) }), { input: 0, output: 0 }),
    };
  };

  const evaluate = async ({ force = false } = {}) => {
    if (running) return '评测正在进行中';
    if (typeof folium.omni?.searchSongs !== 'function') return '这个版本的 Folia 没有在线音源接口，无法评测';
    running = true;
    try {
      const useAi = director.configured();
      const stored = (await store.get('evalDirs')) ?? {};
      const cache = force ? {} : stored;
      const rows = [];
      for (const item of EVAL_SET) {
        const row = { title: item.title, artist: item.artist, band: item.band, label: BANDS[item.band]?.label };
        try {
          const { song, lines } = await lyricsFor(item);
          row.found = `${song.title} - ${song.artist}`;
          const analysis = analyzeLyrics(lines);
          row.instrumental = analysis.sung.length === 0;
          row.paragraphs = analysis.paragraphs.length;
          // No lyrics for a song that has them means the search matched a cover or a backing
          // track: a data problem, not a wrong reading, so it is not scored.
          if (row.instrumental && !item.instrumental) throw new Error(`没拿到歌词，可能匹配到了翻唱或伴奏（${row.found}）`);

          const local = localDirection({ analysis, song, theme: null });
          const localPlan = planOf(analysis, local, song);
          row.local = shape(local, localPlan, scoreSong({ band: item.band, direction: local, plan: localPlan, analysis }));

          if (useAi && !row.instrumental) {
            const key = `${item.title}|${item.artist}`;
            const promptKey = `${lyricFingerprint(analysis)}|${hashString(buildPrompt({ analysis, song, theme: null, duration: 0 }).system)}`;
            // The raw answer is cached and validated again on every run, so validation changes need no new
            // call. (Entries from before the raw answer was kept count as missing: asked once more.)
            const cached = cache[key]?.promptKey === promptKey && cache[key].json ? cache[key].json : null;
            let json = cached;
            let direction = cached ? validateDirection(cached, analysis) : null;
            if (!direction) {
              const started = performance.now();
              const answer = await director.requestDirection({ analysis, song, theme: null, duration: lines[lines.length - 1]?.endTime ?? 0 });
              direction = answer.direction;
              json = answer.json;
              row.tokens = { input: answer.result.usage.input, output: answer.result.usage.output };
              row.ms = Math.round(performance.now() - started);
              cache[key] = { promptKey, json };
              await store.set('evalDirs', cache);
            }
            const kept = new Set(direction.sections.filter((s) => s.keyword).map((s) => `${s.p}|${s.keyword}`));
            const dropped = (json?.sections ?? []).filter((s) => s?.keyword && !kept.has(`${s.p}|${String(s.keyword).trim()}`)).map((s) => String(s.keyword));
            row.keywordsDropped = dropped.length;
            if (dropped.length) row.droppedKeywords = dropped.slice(0, 8);
            const aiPlan = planOf(analysis, direction, song);
            row.ai = shape(direction, aiPlan, scoreSong({ band: item.band, direction, plan: aiPlan, analysis }));
          }
        } catch (error) {
          row.error = String(error?.message ?? error).slice(0, 200);
        }
        rows.push(row);
        folium.log.info(`花笺评测 ${rows.length}/${EVAL_SET.length}`, { song: row.title, error: row.error });
      }
      const report = { setVersion: EVAL_SET_VERSION, at: new Date().toISOString(), summary: summarize(rows), rows };
      await store.set('evalLast', report);
      const s = report.summary;
      const ai = s.aiBandHit === null ? '没配 AI，只评了本地' : `AI 情绪判断 ${s.aiBandHit}%、违规 ${s.aiViolations} 处`;
      return `评测完成（${s.scored}/${s.songs} 首有效）：${ai}；本地 ${s.localBandHit}%、违规 ${s.localViolations} 处。完整报告在模组数据文件的 evalLast`;
    } finally {
      running = false;
    }
  };

  return { evaluate };
};
