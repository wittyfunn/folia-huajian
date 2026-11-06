// Seeded randomness. Every scatter, pick and particle in 花笺 comes from here,
// keyed by the song and the song clock, so a frame looks the same after a pause,
// a seek, a remount or in the export window.

/** FNV-1a over code points: a stable 32-bit seed from any text. */
export const hashString = (text) => {
  let h = 2166136261 >>> 0;
  for (const char of String(text ?? '')) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

/** Stateless hash of up to three integers to [0, 1): per-particle constants without storing them. */
export const hash01 = (a, b = 0, c = 0) => {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

/** mulberry32: a small seeded generator for sequences of picks. */
export const createRandom = (seed) => {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const between = (random, min, max) => min + (max - min) * random();

/** `entries` is `[[value, weight], …]`; weights at or below 0 never win. */
export const weightedPick = (random, entries) => {
  const usable = entries.filter(([, weight]) => weight > 0);
  if (usable.length === 0) return entries[0]?.[0];
  const total = usable.reduce((sum, [, weight]) => sum + weight, 0);
  let x = random() * total;
  for (const [value, weight] of usable) {
    x -= weight;
    if (x <= 0) return value;
  }
  return usable[usable.length - 1][0];
};
