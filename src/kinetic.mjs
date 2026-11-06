// The motion vocabulary: how a character comes in, how it moves while it is
// sung, and how it leaves. Every function writes a transform in em units (a
// fraction of the character's own size) so the same motion reads the same at
// any size, and every motion is a pure function of progress, so it is exact at
// any moment of a seek or an export.
//
// The craft is the classic one: anticipation, squash and stretch, overshoot,
// damped settle, staggered order. Motions are grouped by temperament so a sad
// song gets ink, rain and rack focus, and a loud one gets stamps and glitches.

import { clamp, easeInCubic, easeOutBack, easeOutCubic, easeOutExpo } from './motion.mjs';
import { hash01 } from './random.mjs';

const TAU = Math.PI * 2;
const sat = (x) => clamp(x);
const easeOutQuart = (t) => 1 - (1 - t) ** 4;
const easeInQuad = (t) => t * t;
/** A damped wobble over t in 0..1: the settle after an impact. */
const wobble = (t, frequency, decay) => Math.exp(-decay * t) * Math.sin(frequency * t) * (1 - t);

export const blank = () => ({ dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, skew: 0, alpha: 1, glow: 0, blur: 0, rgb: 0, scramble: 0, ghost: 0, tint: 0 });

const reset = (o) => {
  o.dx = 0; o.dy = 0; o.sx = 1; o.sy = 1; o.rot = 0; o.skew = 0; o.alpha = 1;
  o.glow = 0; o.blur = 0; o.rgb = 0; o.scramble = 0; o.ghost = 0; o.tint = 0;
  return o;
};
const scale = (o, s) => {
  o.sx *= s;
  o.sy *= s;
};

/*
 * ENTER: p is 0..1 through the entrance. `g` carries per-glyph randoms (r1..r3),
 * the shot's travel direction (dirX, dirY), the vector to the block center in em
 * (cx, cy) and the song time (t).
 */
export const ENTER = {
  // ---- gentle: for quiet and sad passages
  fade: { dur: 1.0, fn(p, g, o) {
    // Nothing moves: the character simply comes up out of a soft blur.
    o.alpha = sat(p * 1.6) ** 1.3;
    o.blur = (1 - p) ** 1.6 * 0.6;
  } },
  ink: { dur: 1.1, fn(p, g, o) {
    const e = easeOutCubic(p);
    o.alpha = sat(p * 1.8);
    o.blur = (1 - p) ** 1.4;
    scale(o, 1.07 - 0.07 * e);
    o.glow = 0.55 * (1 - e);
  } },
  drift: { dur: 1.0, fn(p, g, o) {
    const e = easeOutCubic(p);
    o.dy = 0.85 * (1 - e);
    o.dx = (g.r1 - 0.5) * 0.25 * (1 - e);
    o.blur = (1 - p) ** 2;
    o.alpha = sat(p * 2);
  } },
  rain: { dur: 0.95, fn(p, g, o) {
    const e = easeOutCubic(p);
    o.dy = -1.7 * (1 - e);
    o.sy = 1 + 0.4 * (1 - e);
    o.sx = 1 - 0.18 * (1 - e);
    o.blur = 0.6 * (1 - p);
    o.alpha = sat(p * 3);
    if (p > 0.6) o.sy *= 1 - 0.06 * wobble((p - 0.6) / 0.4, 12, 3);
  } },
  focus: { dur: 1.0, fn(p, g, o) {
    const e = easeOutExpo(p);
    scale(o, 1.55 - 0.55 * e);
    o.blur = (1 - p) ** 1.1;
    o.alpha = sat(p * 2.4) * (0.6 + 0.4 * e);
  } },
  gather: { dur: 1.2, fn(p, g, o) {
    // Tracking closes in: characters start spread out and gather into the word.
    const e = easeOutQuart(p);
    o.dx = -g.cx * 0.9 * (1 - e);
    o.dy = -g.cy * 0.5 * (1 - e);
    o.blur = 0.7 * (1 - e);
    o.alpha = sat(p * 2);
  } },
  float: { dur: 1.0, fn(p, g, o) {
    const e = easeOutCubic(p);
    o.dy = 0.55 * (1 - e);
    o.rot = (g.r1 - 0.5) * 0.45 * (1 - e);
    o.dx = Math.sin(p * Math.PI) * 0.2 * (g.r2 - 0.5);
    o.blur = 0.5 * (1 - p);
    o.alpha = sat(p * 2.2);
  } },

  // ---- lively: for lyrical and dramatic passages
  rise: { dur: 0.65, fn(p, g, o) {
    const e = easeOutCubic(sat(p / 0.58));
    o.dy = 1.6 * (1 - e);
    if (p < 0.58) {
      o.sy = 1 + 0.5 * (1 - e);
      o.sx = 1 - 0.25 * (1 - e);
    } else {
      const q = (p - 0.58) / 0.42;
      o.sy = 1 - 0.18 * wobble(q, 11, 2.5);
      o.sx = 1 + 0.14 * wobble(q, 11, 2.5);
    }
    o.alpha = sat(p * 4);
  } },
  slide: { dur: 0.6, fn(p, g, o) {
    const e = easeOutQuart(p);
    o.dx = -2.4 * g.dirX * (1 - e);
    o.dy = -2.4 * g.dirY * (1 - e);
    o.sx = 1 + 0.7 * (1 - e) * Math.abs(g.dirX);
    o.sy = 1 + 0.7 * (1 - e) * Math.abs(g.dirY);
    o.skew = -0.35 * (1 - e) * Math.sign(g.dirX || 1);
    o.ghost = (1 - e) ** 3;
    o.alpha = sat(p * 5);
  } },
  flip: { dur: 0.7, fn(p, g, o) {
    const angle = Math.PI * 2.5 * (1 - easeOutCubic(p));
    o.sx = Math.cos(angle);
    o.sy = 1 + 0.08 * Math.sin(angle);
    o.dy = -0.3 * Math.sin(Math.PI * p) * (1 - p);
    o.alpha = sat(p * 6);
  } },
  wave: { dur: 0.85, fn(p, g, o) {
    const k = (1 - p) ** 1.5;
    o.dy = 1.1 * k * Math.cos(p * Math.PI * 3);
    o.rot = 0.4 * k * Math.sin(p * Math.PI * 3);
    o.sy = 1 + 0.18 * k * Math.sin(p * Math.PI * 3 + 0.6);
    o.alpha = sat(p * 4);
  } },
  zoom: { dur: 0.6, fn(p, g, o) {
    const k = 1.8 * (1 - easeOutQuart(p));
    scale(o, 1 + k * 1.5);
    o.dx = -g.cx * k;
    o.dy = -g.cy * k;
    o.blur = (1 - p) ** 1.4;
    o.alpha = sat(p * 3.5);
  } },
  stretch: { dur: 0.6, fn(p, g, o) {
    const k = (1 - p) ** 3;
    o.sx = 1 + 2 * k - 0.16 * wobble(p, 13, 3);
    o.sy = 1 - 0.72 * k + 0.12 * wobble(p, 13, 3);
    o.dx = -1.4 * k * g.dirX;
    o.dy = -1.4 * k * g.dirY;
    o.ghost = k * k;
    o.alpha = sat(p * 5);
  } },
  spiral: { dur: 0.95, fn(p, g, o) {
    const e = easeOutCubic(p);
    const radius = 3.2 * (1 - e);
    const angle = g.r1 * TAU + Math.PI * 2.5 * (1 - e);
    o.dx = Math.cos(angle) * radius;
    o.dy = Math.sin(angle) * radius * 0.8;
    o.rot = -TAU * (1 - e) * (g.r2 < 0.5 ? 1 : -1);
    scale(o, 0.25 + 0.75 * easeOutBack(p, 1.5));
    o.alpha = sat(p * 3);
  } },

  // ---- punchy: for loud and bright passages
  pop: { dur: 0.5, fn(p, g, o) {
    const s = easeOutBack(p, 2.4);
    o.sy = s * (1 + 0.14 * wobble(p, 14, 3));
    o.sx = s * (1 - 0.1 * wobble(p, 14, 3));
    o.rot = (g.r1 - 0.5) * 0.7 * (1 - easeOutCubic(p));
    o.dy = 0.25 * (1 - easeOutCubic(p));
    o.alpha = sat(p * 6);
  } },
  drop: { dur: 0.75, fn(p, g, o) {
    if (p < 0.48) {
      const e = p / 0.48;
      o.dy = -2.4 * (1 - e * e);
      o.sy = 1 + 0.3 * e;
      o.sx = 1 - 0.12 * e;
    } else {
      const e = (p - 0.48) / 0.52;
      o.dy = -0.32 * Math.abs(Math.sin(e * TAU)) * Math.exp(-3 * e) * (1 - e);
      o.sy = 1 - 0.3 * wobble(e, 16, 4);
      o.sx = 1 + 0.22 * wobble(e, 16, 4);
    }
    o.alpha = sat(p * 7);
  } },
  stamp: { dur: 0.5, fn(p, g, o) {
    if (p < 0.5) {
      const e = p / 0.5;
      scale(o, 2.6 - 1.6 * easeInQuad(e));
      o.rot = (g.r1 - 0.5) * 0.35 * (1 - e);
      o.alpha = sat(e * 2.2);
      o.blur = 0.4 * (1 - e);
    } else {
      const e = (p - 0.5) / 0.5;
      o.sx = 1 + 0.22 * wobble(e, 17, 4);
      o.sy = 1 - 0.22 * wobble(e, 17, 4);
      o.glow = 0.9 * Math.exp(-e * 5);
    }
  } },
  burst: { dur: 0.6, fn(p, g, o) {
    const e = easeOutBack(p, 1.8);
    o.dx = g.cx * (1 - e);
    o.dy = g.cy * (1 - e);
    scale(o, 0.2 + 0.8 * easeOutBack(sat(p * 1.3), 1.6));
    o.rot = (g.r3 - 0.5) * 4 * (1 - easeOutCubic(p));
    o.alpha = sat(p * 6);
  } },
  elastic: { dur: 0.95, fn(p, g, o) {
    const angle = g.r1 * TAU;
    const k = Math.exp(-4.2 * p) * Math.cos(p * Math.PI * 4.5) * (1 - p);
    o.dx = Math.cos(angle) * 1.6 * k;
    o.dy = Math.sin(angle) * 1.6 * k;
    o.rot = (g.r2 - 0.5) * 0.8 * k;
    o.sx = 1 + 0.18 * Math.abs(k);
    o.sy = 1 - 0.12 * Math.abs(k);
    o.alpha = sat(p * 5);
  } },
  scramble: { dur: 0.75, fn(p, g, o) {
    o.alpha = sat(p * 8);
    if (p < 0.72) {
      const tick = Math.floor(g.t * 22);
      o.scramble = 1 + Math.floor(hash01(tick, g.id, 1) * 1e6);
      o.dy = (hash01(tick, g.id, 2) - 0.5) * 0.12;
      o.alpha *= 0.75 + 0.25 * hash01(tick, g.id, 3);
    } else {
      scale(o, 1 + 0.16 * (1 - (p - 0.72) / 0.28) ** 2);
    }
  } },
  glitch: { dur: 0.65, fn(p, g, o) {
    if (p >= 0.8) return;
    const tick = Math.floor(g.t * 24);
    const k = 1 - p / 0.8;
    const a = hash01(tick, g.id, 4);
    const b = hash01(tick, g.id, 5);
    o.dx = b > 0.35 ? (a - 0.5) * 0.9 * k : 0;
    o.rgb = (0.4 + 0.6 * hash01(tick, g.id, 6)) * k;
    o.skew = hash01(tick, g.id, 7) > 0.7 ? (a - 0.5) * 0.9 * k : 0;
    o.sx = b > 0.82 ? 1 + 0.4 * k : 1;
    o.alpha = sat(p * 10) * (hash01(tick, g.id, 8) > 0.18 ? 1 : 0.25);
  } },
};

/* SING: s is seconds since the character's own time, d its duration, k the strength (0..1.5). */
export const SING = {
  none: () => {},
  glow(s, d, o) {
    const hold = Math.max(d, 0.25);
    const env = sat(s / 0.08) * (1 - sat((s - hold) / 0.5));
    o.glow += env * 0.9;
    scale(o, 1 + 0.05 * env);
  },
  breath(s, d, o) {
    const env = Math.sin(Math.PI * sat(s / 0.7));
    scale(o, 1 + 0.045 * env);
    o.glow += 0.45 * env;
    o.dy -= 0.04 * env;
  },
  ripple(s, d, o) {
    const env = Math.sin(Math.PI * sat(s / 0.42));
    o.dy -= 0.16 * env;
    o.glow += 0.4 * env;
  },
  swell(s, d, o) {
    const hold = Math.max(d, 0.12);
    scale(o, 1 + 0.24 * easeOutBack(sat(s / 0.18), 2) * (1 - sat((s - hold) / 0.35)));
    o.glow += 0.5 * (1 - sat((s - hold) / 0.35)) * sat(s / 0.05);
  },
  bounce(s, d, o) {
    if (s < 0.3) o.dy -= 0.28 * Math.sin((s / 0.3) * Math.PI);
    const q = s - 0.3;
    if (q >= 0 && q < 0.3) {
      o.sy *= 1 - 0.14 * wobble(q / 0.3, 14, 3);
      o.sx *= 1 + 0.1 * wobble(q / 0.3, 14, 3);
    } else if (s < 0.3) {
      o.sy *= 1 + 0.08 * Math.sin((s / 0.3) * Math.PI);
    }
    o.glow += 0.4 * Math.exp(-s / 0.3);
  },
  jump(s, d, o, g) {
    if (s < 0.42) {
      const q = s / 0.42;
      o.dy -= 0.5 * Math.sin(q * Math.PI);
      o.rot += (g.r1 < 0.5 ? 1 : -1) * 0.22 * Math.sin(q * TAU) * (1 - q);
      o.sy *= 1 + 0.2 * Math.sin(q * Math.PI) * (1 - q);
    } else if (s < 0.77) {
      const q = (s - 0.42) / 0.35;
      o.sy *= 1 - 0.2 * wobble(q, 13, 3);
      o.sx *= 1 + 0.16 * wobble(q, 13, 3);
    }
    o.glow += 0.5 * Math.exp(-s / 0.35);
  },
  shake(s, d, o, g) {
    const hold = Math.max(d, 0.12);
    const env = sat(s / 0.04) * Math.exp(-Math.max(0, s - hold) / 0.08) * (s < hold + 0.4 ? 1 : 0);
    o.dx += 0.07 * Math.sin(s * 61 + g.r1 * 9) * env;
    o.dy += 0.05 * Math.sin(s * 47 + g.r2 * 5) * env;
    o.rot += 0.09 * Math.sin(s * 53 + g.r3 * 7) * env;
    o.glow += 0.5 * env;
  },
  flash(s, d, o) {
    o.glow += 0.8 * Math.exp(-s / 0.14);
    scale(o, 1 + 0.2 * Math.exp(-s / 0.1) * sat(s / 0.03));
  },
  color(s, d, o) {
    // The accent while the word is sung, fading back after it: a word is not left recoloured.
    o.tint = sat(s / 0.1) * (1 - sat((s - Math.max(d, 0.2)) / 0.6));
    scale(o, 1 + 0.14 * Math.exp(-s / 0.12) * sat(s / 0.03));
    o.glow += 0.35 * Math.exp(-s / 0.4);
  },
};

/* EXIT: p is 0..1 through the exit. */
export const EXIT = {
  // gentle
  fade: { dur: 0.9, fn(p, g, o) {
    o.alpha *= (1 - p) ** 1.4;
    o.blur = Math.max(o.blur, 0.7 * p);
  } },
  driftUp: { dur: 0.9, fn(p, g, o) {
    o.dy -= 0.8 * easeInCubic(p);
    o.alpha *= 1 - p ** 1.4;
    o.blur = Math.max(o.blur, p);
  } },
  dissolve: { dur: 0.85, fn(p, g, o) {
    const flicker = hash01(Math.floor(g.t * 20), g.id, 9);
    o.alpha *= (1 - p) ** 1.3 * (1 - 0.45 * p * flicker);
    scale(o, 1 + 0.14 * easeOutCubic(p));
    o.dy -= 0.35 * easeOutCubic(p);
    o.blur = Math.max(o.blur, p);
  } },
  sink: { dur: 1.0, fn(p, g, o) {
    o.dy += 0.6 * easeInCubic(p);
    o.sy *= 1 + 0.25 * p;
    o.alpha *= 1 - p;
    o.blur = Math.max(o.blur, 0.8 * p);
  } },
  // lively
  fall: { dur: 0.8, fn(p, g, o) {
    const e = easeInCubic(p);
    o.dy += 3 * e;
    o.dx += 0.28 * Math.sin(p * TAU + g.r1 * 6) * p;
    o.rot += (g.r2 - 0.5) * 1.2 * e;
    o.sy *= 1 + 0.4 * e;
    o.sx *= 1 - 0.25 * e;
    o.alpha *= 1 - p ** 1.6;
  } },
  slide: { dur: 0.5, fn(p, g, o) {
    const e = easeInCubic(p);
    o.dx += g.dirX * 7 * e;
    o.dy += g.dirY * 7 * e;
    o.sx *= 1 + 0.45 * easeInQuad(p) * Math.abs(g.dirX);
    o.skew -= 0.45 * easeInQuad(p) * Math.sign(g.dirX || 1);
    o.ghost = Math.max(o.ghost, e * e);
    o.alpha *= 1 - sat((p - 0.45) / 0.55) ** 1.5;
  } },
  shrink: { dur: 0.55, fn(p, g, o) {
    const s = p < 0.2 ? 1 + 0.16 * Math.sin((p / 0.2) * Math.PI / 2) : 1.16 * (1 - easeInCubic((p - 0.2) / 0.8));
    scale(o, Math.max(0, s));
    o.rot += (g.r1 - 0.5) * 0.9 * p;
    o.alpha *= p > 0.8 ? (1 - p) / 0.2 : 1;
  } },
  zoomPast: { dur: 0.55, fn(p, g, o) {
    const e = easeInCubic(p);
    scale(o, 1 + 3 * e);
    o.dx -= g.cx * 2 * e;
    o.dy -= g.cy * 2 * e;
    o.blur = Math.max(o.blur, p);
    o.alpha *= 1 - p;
  } },
  // punchy
  scatter: { dur: 0.7, fn(p, g, o) {
    let vx = -g.cx + (g.r1 - 0.5) * 2;
    let vy = -g.cy + (g.r2 - 0.5) * 2;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len;
    vy /= len;
    const e = easeOutCubic(p);
    const reach = 2.4 + g.r3 * 1.8;
    o.dx += vx * reach * e;
    o.dy += vy * reach * e;
    o.rot += (g.r2 - 0.5) * 3.2 * e;
    scale(o, 1 - 0.65 * e);
    o.alpha *= 1 - p ** 1.6;
  } },
  ascend: { dur: 0.65, fn(p, g, o) {
    const e = easeInCubic(p);
    o.dy += (p < 0.22 ? Math.sin((p / 0.22) * Math.PI) * 0.12 : 0) - 2.8 * e;
    o.dx += (g.r1 - 0.5) * 0.7 * e;
    o.sy *= 1 + 0.45 * e;
    o.sx *= 1 - 0.22 * e;
    o.alpha *= 1 - easeInQuad(p);
  } },
  blink: { dur: 0.5, fn(p, g, o) {
    const on = p < 0.14 || (p >= 0.24 && p < 0.4) || (p >= 0.5 && p < 0.6) || (p >= 0.7 && p < 0.76) || (p >= 0.82 && p < 0.85);
    o.alpha *= on && p < 1 ? 1 : 0;
  } },
};

/** The order characters move in: a rank per glyph (0 first). `random` is a seeded shuffle. */
export const ranks = (order, count, seed) => {
  const indexes = Array.from({ length: count }, (_, i) => i);
  if (order === 'reverse') return indexes.map((i) => count - 1 - i);
  if (order === 'center') {
    const mid = (count - 1) / 2;
    return indexes.map((i) => Math.round(Math.abs(i - mid) * 2) / 2);
  }
  if (order === 'edges') {
    const mid = (count - 1) / 2;
    return indexes.map((i) => Math.round((mid - Math.abs(i - mid)) * 2) / 2);
  }
  if (order === 'random') {
    const shuffled = [...indexes].sort((a, b) => hash01(seed, a, 77) - hash01(seed, b, 77));
    const rank = new Array(count);
    shuffled.forEach((glyph, position) => {
      rank[glyph] = position;
    });
    return rank;
  }
  return indexes;
};

/** Which order suits a motion: scrambles land at random, zooms from the middle out. */
export const orderFor = (enter, random) => {
  if (enter === 'scramble' || enter === 'glitch') return 'random';
  if (enter === 'zoom' || enter === 'burst' || enter === 'gather') return 'center';
  if (enter === 'rain') return random < 0.5 ? 'random' : 'forward';
  return random < 0.2 ? 'reverse' : random < 0.32 ? 'center' : 'forward';
};

/** Seconds between ranks, fitted so the last character lands within `window` seconds. */
export const fitStagger = (enter, maxRank, preferred, window) => {
  const duration = ENTER[enter]?.dur ?? 0.6;
  if (maxRank <= 0) return { stagger: 0, duration };
  const room = Math.max(0.05, window - duration);
  return { stagger: Math.min(preferred, room / maxRank), duration };
};

/**
 * Temperaments: which motions a passage may use. The planner picks from these,
 * so a ballad never stamps and a festival song never seeps in like ink.
 */
export const TEMPERAMENTS = {
  gentle: {
    enter: ['ink', 'drift', 'rain', 'focus', 'gather', 'float'],
    sing: ['glow', 'breath', 'ripple'],
    exit: ['driftUp', 'dissolve', 'sink'],
    mode: [['line', 1]],
    stagger: 0.085,
    lead: 0.95,
    dim: 0.3,
  },
  lyrical: {
    enter: ['rise', 'float', 'focus', 'slide', 'flip', 'wave', 'ink', 'gather'],
    sing: ['swell', 'glow', 'ripple', 'breath', 'color'],
    exit: ['driftUp', 'dissolve', 'slide', 'shrink', 'fall'],
    mode: [['line', 3], ['sung', 1]],
    stagger: 0.05,
    lead: 0.75,
    dim: 0.34,
  },
  dramatic: {
    enter: ['stamp', 'zoom', 'focus', 'slide', 'rise', 'stretch', 'spiral', 'scramble'],
    sing: ['flash', 'swell', 'shake', 'color', 'glow'],
    exit: ['dissolve', 'scatter', 'zoomPast', 'fall', 'slide'],
    mode: [['line', 2], ['sung', 1]],
    stagger: 0.04,
    lead: 0.6,
    dim: 0.4,
  },
  punchy: {
    enter: ['pop', 'drop', 'stamp', 'spiral', 'scramble', 'glitch', 'elastic', 'stretch', 'burst', 'flip', 'wave', 'zoom'],
    sing: ['bounce', 'jump', 'shake', 'flash', 'swell', 'color'],
    exit: ['scatter', 'slide', 'ascend', 'shrink', 'blink', 'fall', 'zoomPast'],
    mode: [['line', 1], ['sung', 1]],
    stagger: 0.032,
    lead: 0.5,
    dim: 0.5,
  },
};

/**
 * A sad song's motions, whatever its temperament: characters fade up out of a blur, at most drift a
 * little, glow while sung and fade away. Its intensity shows in size, light and staging, not motion.
 */
export const CALM = {
  enter: ['fade', 'ink', 'drift', 'fade'],
  sing: ['glow', 'breath'],
  exit: ['fade', 'driftUp', 'fade'],
};

/** The temperament of a passage from its energy and the song's brightness. */
export const temperamentOf = (energy, valence) => {
  if (energy < 0.38) return 'gentle';
  if (energy < 0.62) return 'lyrical';
  return valence < 0.5 ? 'dramatic' : 'punchy';
};

export const resetTransform = reset;
