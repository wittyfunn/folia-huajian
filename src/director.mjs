// The AI director service, shared by every mount of the visualizer. For each
// song it hands out a direction at once (the local reading) and upgrades it
// when the AI's arrives: from the data file when the song was heard before,
// otherwise with one call to the user's OpenAI-compatible endpoint. While the
// mode is on screen it also prepares the next song in the queue, so a song
// change finds its direction already waiting.
//
// Calls are made only from the main window, only while 花笺 is the mode on
// screen (not for previews), one at a time, and a failed song is not retried
// for a few minutes.

import { analyzeLyrics, lyricFingerprint, songKeyOf } from './lyrics.mjs';
import { DIRECTION_VERSION, buildPrompt, localDirection, validateDirection } from './direction.mjs';
import { chatJson, testConnection } from './llm.mjs';
import { THINKING_OFF, baseUrlFor, isLocalUrl, thinkingMethodFor } from './providers.mjs';
import { hashString } from './random.mjs';

const RETRY_AFTER_MS = 5 * 60 * 1000;
const PREFETCH_DELAY_MS = 4000;
const MAX_TOKENS = 1800;

export const STATUS_TEXT = {
  local: '本地导演',
  loading: '读取记忆',
  asking: 'AI 正在读歌',
  ai: 'AI 导演',
  cached: 'AI 导演（记忆）',
  error: 'AI 出错，用本地导演',
  'no-key': '没填密钥，用本地导演',
  off: '本地导演',
};

export const createDirector = ({ folium, store, getConfig }) => {
  const log = folium.log;
  const entries = new Map();
  const liveMounts = new Set();
  const queue = [];
  let working = false;
  let compat = null;
  let usage = null;
  let prefetchTimer = null;
  let disposed = false;

  const loadCompat = async () => {
    compat ??= (await store.get('compat')) ?? {};
    return compat;
  };
  const loadUsage = async () => {
    usage ??= (await store.get('usage')) ?? { calls: 0, input: 0, output: 0 };
    return usage;
  };

  const notify = (entry) => {
    for (const listener of entry.listeners) {
      try {
        listener(entry);
      } catch (error) {
        log.warn('导演更新的监听出错', { message: String(error?.message ?? error) });
      }
    }
  };
  const setStatus = (entry, status, error = '') => {
    entry.status = status;
    entry.error = error;
    notify(entry);
  };

  const configured = () => {
    const config = getConfig();
    return config.ai && folium.env?.context === 'main' && Boolean(config.model) && Boolean(baseUrlFor(config));
  };

  /* One entry per song and lyric: a new lyric for the same song starts over. */
  const ensure = ({ song, lines, theme, duration }) => {
    const analysis = analyzeLyrics(lines);
    const fingerprint = lyricFingerprint(analysis);
    const key = songKeyOf(song) ?? `lyric:${hashString(fingerprint)}`;
    let entry = entries.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = {
        key,
        song,
        analysis,
        fingerprint,
        theme,
        duration,
        local: localDirection({ analysis, song, theme }),
        ai: null,
        status: 'local',
        error: '',
        listeners: entry?.listeners ?? new Set(),
        loaded: null,
        failedAt: 0,
        queued: false,
        audio: null,
        audioState: null,
        audioLoaded: null,
      };
      entries.set(key, entry);
      // Keep memory small: forget songs nobody watches, beyond the last few.
      if (entries.size > 12) {
        for (const [otherKey, other] of entries) {
          if (entries.size <= 12) break;
          if (other !== entry && other.listeners.size === 0) entries.delete(otherKey);
        }
      }
    } else if (duration > 0) {
      entry.duration = duration;
    }
    return entry;
  };

  const loadStored = (entry) => {
    entry.loaded ??= (async () => {
      setStatus(entry, entry.ai ? entry.status : 'loading');
      try {
        const record = await store.getDirection(entry.key);
        if (record?.d?.v === DIRECTION_VERSION && record.fp === entry.fingerprint) {
          entry.ai = record.d;
          setStatus(entry, 'cached');
          return;
        }
      } catch (error) {
        log.warn('读取导演记忆失败', { message: String(error?.message ?? error) });
      }
      if (!entry.ai) setStatus(entry, 'local');
    })();
    return entry.loaded;
  };

  const runQueue = async () => {
    if (working) return;
    working = true;
    try {
      while (queue.length > 0 && !disposed) {
        const entry = queue.shift();
        entry.queued = false;
        if (entry.ai) continue;
        await ask(entry);
      }
    } finally {
      working = false;
    }
  };

  const enqueue = (entry, urgent) => {
    if (entry.ai || entry.queued || !configured()) return;
    if (Date.now() - entry.failedAt < RETRY_AFTER_MS) return;
    entry.queued = true;
    if (urgent) queue.unshift(entry);
    else queue.push(entry);
    runQueue();
  };

  const hasKey = async () => {
    const apiKey = await folium.secrets.get('apiKey').catch(() => null);
    return { apiKey, ok: Boolean(apiKey) || isLocalUrl(baseUrlFor(getConfig())) };
  };

  /** One AI call for one lyric: the validated direction, the raw answer and the call's cost. Throws on failure. */
  const requestDirection = async ({ analysis, song, theme, duration, audio = null }) => {
    const config = getConfig();
    const baseUrl = baseUrlFor(config);
    const { apiKey } = await hasKey();
    const compatKey = `${baseUrl}|${config.model}`;
    const quirks = await loadCompat();
    const { system, user } = buildPrompt({ analysis, song, theme, duration, audio });
    const method = thinkingMethodFor({ method: config.thinking, provider: config.provider, url: baseUrl });
    const result = await chatJson({
      fetch: (url, init) => folium.net.fetch(url, init),
      baseUrl,
      apiKey,
      model: config.model,
      temperature: config.temperature,
      thinkingFields: THINKING_OFF[method] ?? {},
      system,
      user,
      maxTokens: MAX_TOKENS,
      compat: quirks[compatKey],
    });
    quirks[compatKey] = result.compat;
    store.set('compat', quirks).catch(() => {});
    const totals = await loadUsage();
    totals.calls += 1;
    totals.input += result.usage.input;
    totals.output += result.usage.output;
    store.set('usage', totals).catch(() => {});
    return { direction: validateDirection(result.json, analysis), json: result.json, result };
  };

  const ask = async (entry) => {
    if (!(await hasKey()).ok) {
      setStatus(entry, 'no-key');
      return;
    }
    if (entry.analysis.sung.length === 0) {
      setStatus(entry, 'local');
      return;
    }
    setStatus(entry, 'asking');
    try {
      const { direction, result } = await requestDirection(entry);
      entry.ai = direction;
      entry.lastCall = { ms: result.ms, input: result.usage.input, output: result.usage.output, thought: result.thought };
      setStatus(entry, 'ai');
      await store.putDirection(entry.key, entry.fingerprint, direction);
      log.info('AI 导演完成', { song: entry.song?.title, ms: result.ms, tokens: result.usage.input + result.usage.output });
    } catch (error) {
      entry.failedAt = Date.now();
      const message = String(error?.message ?? error).slice(0, 200);
      log.warn('AI 导演失败，继续用本地导演', { song: entry.song?.title, message });
      setStatus(entry, 'error', message);
    }
  };

  /* Takes a reading; the local direction is redone only when it would really change (a first lock,
   * or the tempo moving by more than 3 %), so the stage does not rebuild shots every few seconds. */
  const applyAudio = (entry, features, state) => {
    const before = entry.audio;
    entry.audio = features;
    entry.audioState = state ?? entry.audioState;
    const locked = (f) => Boolean(f?.bpm) && f.confidence >= 0.4;
    const moved = locked(features) && (!locked(before) || Math.abs(features.bpm - before.bpm) / before.bpm > 0.03);
    if (!moved) return;
    entry.local = localDirection({ analysis: entry.analysis, song: entry.song, theme: entry.theme, audio: features });
    // The plan follows the tempo too (流光 / 云阶 for slow songs, 心象 for fast ones), so a first lock
    // re-plans the shots not yet shown, AI direction or not.
    notify(entry);
  };

  // ------------------------------------------------------------ the next song

  /* The song after this one, as the queue and the repeat mode say (same rule as AI 导演 Plus). */
  const nextSong = () => {
    const playback = folium.playback;
    if (typeof playback?.getQueue !== 'function') return null;
    const queueSnapshot = playback.getQueue({ limit: 1 });
    if (queueSnapshot.kind === 'stage' || queueSnapshot.currentIndex < 0 || queueSnapshot.length === 0) return null;
    const loop = playback.getLoopMode?.() ?? 'off';
    if (loop === 'one') return null;
    let index = queueSnapshot.currentIndex + 1;
    if (index >= queueSnapshot.length) {
      if (loop !== 'all') return null;
      index = 0;
    }
    return playback.getQueue({ offset: index, limit: 1 }).items.find((item) => item.index === index)?.song ?? null;
  };

  const prefetch = async () => {
    prefetchTimer = null;
    if (disposed || liveMounts.size === 0 || !getConfig().prefetch || !configured()) return;
    if (working || queue.length > 0) {
      schedulePrefetch();
      return;
    }
    const song = nextSong();
    const key = songKeyOf(song);
    if (!song?.ref || !key || entries.get(key)?.ai) return;
    if (typeof folium.omni?.getLyrics !== 'function') return;
    try {
      const stored = await store.getDirection(key);
      if (stored?.d?.v === DIRECTION_VERSION) return;
      const lyrics = await folium.omni.getLyrics(song);
      if (!lyrics?.lines?.length) return;
      const entry = ensure({ song, lines: lyrics.lines, theme: null, duration: 0 });
      await loadStored(entry);
      enqueue(entry, false);
    } catch (error) {
      log.info('下一首拿不到歌词，播放时再分析', { message: String(error?.code ?? error?.message ?? error) });
    }
  };

  const schedulePrefetch = () => {
    if (prefetchTimer || disposed) return;
    prefetchTimer = setTimeout(() => prefetch(), PREFETCH_DELAY_MS);
  };

  // ------------------------------------------------------------ public

  return {
    /**
     * For one mount: the song's direction now, and updates as better ones arrive.
     * `live` is false for previews and the export window, which never call the AI.
     */
    attach({ song, lines, theme, duration, live }) {
      const entry = ensure({ song, lines, theme, duration });
      const handle = {
        get entry() {
          return entry;
        },
        get direction() {
          return entry.ai ?? entry.local;
        },
        get analysis() {
          return entry.analysis;
        },
        onUpdate(listener) {
          entry.listeners.add(listener);
          return () => entry.listeners.delete(listener);
        },
        /** The theme changed (Folia's AI theme often lands after the song starts): re-read the local mood. */
        updateTheme(nextTheme) {
          if (entry.ai || !nextTheme?.description || nextTheme.description === entry.theme?.description) return;
          entry.theme = nextTheme;
          entry.local = localDirection({ analysis: entry.analysis, song: entry.song, theme: nextTheme, audio: entry.audio });
          notify(entry);
        },
        /** What was heard of this song so far (from the data file, then refined while it plays). */
        loadAudio() {
          entry.audioLoaded ??= store.getAudio(entry.key).then((record) => {
            if (record?.f && !entry.audio) applyAudio(entry, record.f, record.s);
            return record;
          }).catch(() => null);
          return entry.audioLoaded;
        },
        /** A new reading from the stage; kept (throttled) and, for a local direction, used at once. */
        setAudio(features, state) {
          applyAudio(entry, features, state);
          const now = Date.now();
          if (now - (entry.audioSavedAt ?? 0) > 20000) {
            entry.audioSavedAt = now;
            store.putAudio(entry.key, { f: features, s: state }).catch(() => {});
          }
        },
        detach() {
          liveMounts.delete(handle);
        },
      };
      if (live) liveMounts.add(handle);
      loadStored(entry).then(() => {
        if (!live || entry.ai) {
          if (live) schedulePrefetch();
          return;
        }
        if (!configured()) return;
        enqueue(entry, true);
      });
      if (live) {
        const offPrefetch = handle.onUpdate((updated) => {
          if (updated.status === 'ai' || updated.status === 'cached') schedulePrefetch();
        });
        const detach = handle.detach;
        handle.detach = () => {
          offPrefetch();
          detach();
        };
      }
      return handle;
    },

    /** The entry of the song playing now, if a mount has seen it. */
    current() {
      const key = songKeyOf(folium.playback?.getState?.().song ?? null);
      return key ? entries.get(key) ?? null : null;
    },

    /** Forgets the stored direction of the song playing now and asks again. */
    async reanalyze() {
      const entry = this.current();
      if (!entry) return '先在播放页用花笺放一首有歌词的歌';
      if (!configured()) return '还没有配置 AI：在 设置 → 模组 → 花笺 里选服务商、填模型和密钥';
      await store.forget(entry.key);
      entry.ai = null;
      entry.failedAt = 0;
      notify(entry);
      enqueue(entry, true);
      return 'AI 正在重新读这首歌，几秒后画面会跟着变';
    },

    describe() {
      const entry = this.current();
      if (!entry) return '还没有用花笺放过这首歌';
      const d = entry.ai ?? entry.local;
      const head = `${STATUS_TEXT[entry.status] ?? entry.status}${entry.error ? `（${entry.error.slice(0, 60)}）` : ''}`;
      const mood = `明暗 ${d.valence.toFixed(2)} · 能量 ${d.energy.toFixed(2)} · 冷暖 ${d.warmth.toFixed(2)}`;
      return [head, d.summary, mood].filter(Boolean).join('\n');
    },

    async testConnection() {
      const config = getConfig();
      const baseUrl = baseUrlFor(config);
      const apiKey = await folium.secrets.get('apiKey').catch(() => null);
      const quirks = await loadCompat();
      const method = thinkingMethodFor({ method: config.thinking, provider: config.provider, url: baseUrl });
      return testConnection({
        fetch: (url, init) => folium.net.fetch(url, init),
        baseUrl,
        apiKey,
        model: config.model,
        thinkingFields: THINKING_OFF[method] ?? {},
        compat: quirks[`${baseUrl}|${config.model}`],
      });
    },

    /** For the developer evaluation: ask the AI about any lyric without touching per-song memory. */
    requestDirection,
    configured,

    async usage() {
      return { ...(await loadUsage()), songs: await store.count() };
    },

    onSetupChanged() {
      for (const entry of entries.values()) entry.failedAt = 0;
      for (const handle of liveMounts) enqueue(handle.entry, true);
    },

    dispose() {
      disposed = true;
      clearTimeout(prefetchTimer);
      queue.length = 0;
    },
  };
};
