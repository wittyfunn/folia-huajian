// The AI director's memory in the mod's data file (1 MB cap): one direction per
// song (about 1 KB), most recently used first, plus per-endpoint request
// quirks and usage totals. A song heard before costs nothing.

const SONG_PREFIX = 'dir:';
const AUDIO_PREFIX = 'aud:';
const AUDIO_INDEX = 'audIndex';
const INDEX_KEY = 'index';
const MAX_SONGS = 500;

export const createStore = (storage, log) => {
  let index = null; // song keys, most recent first

  const loadIndex = async () => {
    if (index) return index;
    const stored = await storage.get(INDEX_KEY).catch(() => null);
    index = Array.isArray(stored) ? stored : [];
    return index;
  };

  /* A write past the cap fails: drop the oldest third once and retry. */
  const safeSet = async (key, value) => {
    try {
      await storage.set(key, value);
    } catch (error) {
      log.warn('写入数据文件失败，清理最旧的三分之一后重试', { message: String(error?.message ?? error) });
      const keys = await loadIndex();
      const dropped = keys.splice(Math.floor((keys.length * 2) / 3));
      await Promise.all(dropped.map((songKey) => storage.delete(`${SONG_PREFIX}${songKey}`).catch(() => {})));
      await storage.set(INDEX_KEY, keys);
      await storage.set(key, value);
    }
  };

  const touch = async (songKey) => {
    const keys = await loadIndex();
    const at = keys.indexOf(songKey);
    if (at !== -1) keys.splice(at, 1);
    keys.unshift(songKey);
    const evicted = keys.splice(MAX_SONGS);
    await Promise.all(evicted.map((key) => storage.delete(`${SONG_PREFIX}${key}`).catch(() => {})));
    await safeSet(INDEX_KEY, keys);
  };

  return {
    /** `{ fp, d, at }`: the lyric fingerprint it was made for, the direction, when. */
    getDirection: async (songKey) => (songKey ? (await storage.get(`${SONG_PREFIX}${songKey}`).catch(() => null)) ?? null : null),
    putDirection: async (songKey, fingerprint, direction) => {
      await safeSet(`${SONG_PREFIX}${songKey}`, { fp: fingerprint, d: direction, at: Date.now() });
      await touch(songKey);
    },
    forget: async (songKey) => {
      await storage.delete(`${SONG_PREFIX}${songKey}`).catch(() => {});
      const keys = await loadIndex();
      const at = keys.indexOf(songKey);
      if (at !== -1) {
        keys.splice(at, 1);
        await safeSet(INDEX_KEY, keys);
      }
    },
    /** Tempo and key heard for a song (`{ f: features, s: rhythm snapshot }`), kept for the last MAX_SONGS songs. */
    getAudio: async (songKey) => (songKey ? (await storage.get(`${AUDIO_PREFIX}${songKey}`).catch(() => null)) ?? null : null),
    putAudio: async (songKey, record) => {
      await safeSet(`${AUDIO_PREFIX}${songKey}`, record);
      const keys = (await storage.get(AUDIO_INDEX).catch(() => null)) ?? [];
      const at = keys.indexOf(songKey);
      if (at !== -1) keys.splice(at, 1);
      keys.unshift(songKey);
      const evicted = keys.splice(MAX_SONGS);
      await Promise.all(evicted.map((key) => storage.delete(`${AUDIO_PREFIX}${key}`).catch(() => {})));
      await safeSet(AUDIO_INDEX, keys);
    },
    count: async () => (await loadIndex()).length,
    get: (key) => storage.get(key).catch(() => undefined),
    set: (key, value) => safeSet(key, value),
  };
};
