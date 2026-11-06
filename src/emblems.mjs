// Line-art emblems drawn behind a shot's main word, after the geometric
// figures of Folia's 商籁 (sonnet): dials, orbits, hexagons, a radar, a
// viewfinder, moon phases, a mandala, a constellation. Every figure is thin
// and thick strokes of one colour (the sprite is tinted), drawn around (0, 0)
// for a radius r, on a PixiJS Graphics.

import { hash01 } from './random.mjs';

const TAU = Math.PI * 2;

/* A closed polyline through points [[x, y], ...]. */
const loop = (g, points) => {
  g.moveTo(points[0][0], points[0][1]);
  for (let k = 1; k < points.length; k += 1) g.lineTo(points[k][0], points[k][1]);
  g.lineTo(points[0][0], points[0][1]);
};
const polygon = (cx, cy, r, sides, turn = 0) => Array.from({ length: sides }, (_, k) => [cx + r * Math.sin((k / sides) * TAU + turn), cy - r * Math.cos((k / sides) * TAU + turn)]);
const ellipse = (rx, ry, tilt, n = 72) => Array.from({ length: n }, (_, k) => {
  const a = (k / n) * TAU;
  const x = Math.cos(a) * rx;
  const y = Math.sin(a) * ry;
  return [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)];
});
const line = (g, x1, y1, x2, y2) => g.moveTo(x1, y1).lineTo(x2, y2);
const W = 0xffffff;

const EMBLEMS = {
  /* A dial: a double ring and radial ticks. */
  dial(g, r) {
    g.circle(0, 0, r).stroke({ color: W, width: 5, alpha: 0.8 });
    g.circle(0, 0, r * 0.965).stroke({ color: W, width: 1.5, alpha: 0.45 });
    for (let k = 0; k < 36; k += 1) {
      const a = (k / 36) * TAU;
      const inner = r * (k % 3 === 0 ? 0.74 : 0.84);
      line(g, Math.cos(a) * inner, Math.sin(a) * inner, Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92);
    }
    g.stroke({ color: W, width: 1, alpha: 0.35 });
  },
  /* Nested diamonds on a cross. */
  diamond(g, r) {
    loop(g, polygon(0, 0, r, 4));
    g.stroke({ color: W, width: 5, alpha: 0.8 });
    loop(g, polygon(0, 0, r * 0.95, 4));
    g.stroke({ color: W, width: 1.5, alpha: 0.4 });
    loop(g, polygon(0, 0, r * 0.42, 4));
    g.stroke({ color: W, width: 1, alpha: 0.6 });
    line(g, -r * 1.25, 0, r * 1.25, 0);
    line(g, 0, -r * 1.25, 0, r * 1.25);
    g.stroke({ color: W, width: 1, alpha: 0.3 });
  },
  /* A hexagon with an inner hexagon and spokes between them. */
  hexagon(g, r) {
    loop(g, polygon(0, 0, r, 6));
    g.stroke({ color: W, width: 5, alpha: 0.8 });
    loop(g, polygon(0, 0, r * 0.95, 6));
    g.stroke({ color: W, width: 1.5, alpha: 0.4 });
    loop(g, polygon(0, 0, r * 0.4, 6));
    g.stroke({ color: W, width: 1, alpha: 0.5 });
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * TAU + Math.PI / 6;
      line(g, Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36, Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86);
    }
    g.stroke({ color: W, width: 2, alpha: 0.4 });
  },
  /* Three orbits around a nucleus. */
  atom(g, r) {
    for (let k = 0; k < 3; k += 1) {
      loop(g, ellipse(r, r * 0.2, (k / 3) * Math.PI));
      g.stroke({ color: W, width: 1.5, alpha: 0.45 });
    }
    g.circle(0, 0, r * 0.07).fill({ color: W, alpha: 0.8 });
    g.circle(r * 0.92, 0, r * 0.035).fill({ color: W, alpha: 0.7 });
  },
  /* A ringed planet with a small moon. */
  planet(g, r) {
    g.circle(0, 0, r * 0.38).fill({ color: W, alpha: 0.08 }).stroke({ color: W, width: 2.5, alpha: 0.8 });
    loop(g, ellipse(r * 0.95, r * 0.22, -0.4));
    g.stroke({ color: W, width: 4, alpha: 0.5 });
    loop(g, ellipse(r * 1.08, r * 0.27, -0.4));
    g.stroke({ color: W, width: 1, alpha: 0.3 });
    g.circle(0, 0, r * 1.15).stroke({ color: W, width: 1, alpha: 0.18 });
    g.circle(Math.cos(0.8) * r * 1.15, Math.sin(0.8) * r * 1.15, r * 0.04).fill({ color: W, alpha: 0.7 });
  },
  /* A radar: rings, a crosshair, a swept sector and a scale of ticks. */
  radar(g, r, seed) {
    for (let k = 1; k <= 5; k += 1) g.circle(0, 0, r * 0.19 * k).stroke({ color: W, width: k % 2 === 0 ? 2 : 1, alpha: 0.18 + (k % 3) * 0.08 });
    line(g, -r * 1.12, 0, r * 1.12, 0);
    line(g, 0, -r * 1.12, 0, r * 1.12);
    g.stroke({ color: W, width: 1, alpha: 0.4 });
    const from = hash01(seed, 3) * TAU;
    g.moveTo(0, 0).arc(0, 0, r * 0.95, from, from + Math.PI / 4).lineTo(0, 0).fill({ color: W, alpha: 0.08 }).stroke({ color: W, width: 1.5, alpha: 0.5 });
    for (let k = 0; k < 72; k += 1) {
      const a = (k / 72) * TAU;
      const reach = k % 18 === 0 ? 0.13 : k % 6 === 0 ? 0.07 : 0.035;
      line(g, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * r * (1 + reach), Math.sin(a) * r * (1 + reach));
    }
    g.stroke({ color: W, width: 1, alpha: 0.4 });
  },
  /* A viewfinder: corner brackets with rulers, a small crosshair in the middle. */
  viewfinder(g, r) {
    const w = r * 1.25;
    const h = r * 0.82;
    const arm = r * 0.22;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      g.moveTo(sx * w, sy * h + -sy * arm).lineTo(sx * w, sy * h).lineTo(sx * w - sx * arm, sy * h);
    }
    g.stroke({ color: W, width: 3.5, alpha: 0.75 });
    for (let x = -w + r * 0.12; x < w - r * 0.1; x += r * 0.12) {
      const long = Math.round((x + w) / (r * 0.12)) % 5 === 0;
      line(g, x, -h, x, -h - r * (long ? 0.07 : 0.035));
      line(g, x, h, x, h + r * (long ? 0.07 : 0.035));
    }
    g.stroke({ color: W, width: 1, alpha: 0.45 });
    g.circle(0, 0, r * 0.1).stroke({ color: W, width: 1.5, alpha: 0.4 });
    line(g, -r * 0.16, 0, r * 0.16, 0);
    line(g, 0, -r * 0.16, 0, r * 0.16);
    g.stroke({ color: W, width: 1, alpha: 0.4 });
  },
  /* Concentric orbits with beads on them. */
  orbits(g, r, seed) {
    for (let k = 1; k <= 5; k += 1) {
      const radius = r * 0.2 * k;
      g.circle(0, 0, radius).stroke({ color: W, width: k === 5 ? 3 : 1, alpha: k === 5 ? 0.6 : 0.25 });
      const a = hash01(seed, k, 5) * TAU;
      g.circle(Math.cos(a) * radius, Math.sin(a) * radius, r * (0.018 + 0.012 * (k % 2))).fill({ color: W, alpha: 0.75 });
    }
  },
  /* Moon phases on a ring around a large crescent. */
  phases(g, r) {
    const big = r * 0.42;
    g.moveTo(0, -big).arc(0, 0, big, -Math.PI / 2, Math.PI / 2).quadraticCurveTo(-big * 0.45, 0, 0, -big).fill({ color: W, alpha: 0.6 });
    g.circle(0, 0, big).stroke({ color: W, width: 1, alpha: 0.3 });
    g.circle(0, 0, r).stroke({ color: W, width: 1, alpha: 0.2 });
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * TAU - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      const s = r * 0.055;
      g.circle(x, y, s).stroke({ color: W, width: 1, alpha: 0.5 });
      if (k === 4) g.circle(x, y, s * 0.8).fill({ color: W, alpha: 0.75 });
      else if (k !== 0) g.moveTo(x, y - s * 0.8).arc(x, y, s * 0.8, -Math.PI / 2, Math.PI / 2, k > 4).lineTo(x, y - s * 0.8).fill({ color: W, alpha: 0.5 });
    }
  },
  /* A mandala of petals in three rings. */
  petals(g, r) {
    for (let ring = 0; ring < 3; ring += 1) {
      const count = 8 + ring * 4;
      const reach = r * (1 - ring * 0.22);
      const width = 0.28 - ring * 0.05;
      for (let k = 0; k < count; k += 1) {
        const a = (k / count) * TAU + (Math.PI / count) * ring;
        const tip = [Math.cos(a) * reach, Math.sin(a) * reach];
        const c1 = [Math.cos(a - width) * reach * 0.5, Math.sin(a - width) * reach * 0.5];
        const c2 = [Math.cos(a + width) * reach * 0.5, Math.sin(a + width) * reach * 0.5];
        g.moveTo(0, 0).quadraticCurveTo(c1[0], c1[1], tip[0], tip[1]).quadraticCurveTo(c2[0], c2[1], 0, 0);
      }
      g.stroke({ color: W, width: 1, alpha: 0.7 - ring * 0.18 });
    }
    g.circle(0, 0, r * 0.07).stroke({ color: W, width: 2, alpha: 0.8 });
  },
  /* Overlapping circles (the flower of life), faint outer ones. */
  flower(g, r) {
    const s = r * 0.33;
    g.circle(0, 0, s).stroke({ color: W, width: 1.5, alpha: 0.4 });
    for (let k = 0; k < 6; k += 1) g.circle(Math.cos((k / 6) * TAU) * s, Math.sin((k / 6) * TAU) * s, s).stroke({ color: W, width: 1.5, alpha: 0.28 });
    for (let k = 0; k < 12; k += 1) {
      const d = k % 2 === 0 ? s * 2 : s * Math.sqrt(3);
      const a = (k / 12) * TAU;
      g.circle(Math.cos(a) * d, Math.sin(a) * d, s).stroke({ color: W, width: 1, alpha: 0.1 });
    }
    g.circle(0, 0, s * 3).stroke({ color: W, width: 2, alpha: 0.3 });
  },
  /* Stars joined to their near neighbours. */
  constellation(g, r, seed) {
    const stars = Array.from({ length: 15 }, (_, k) => {
      const d = r * (0.15 + 0.85 * hash01(seed, k, 1));
      const a = hash01(seed, k, 2) * TAU;
      return [Math.cos(a) * d, Math.sin(a) * d];
    });
    stars.forEach(([x, y], k) => {
      for (let j = k + 1; j < stars.length; j += 1) {
        const dist = Math.hypot(stars[j][0] - x, stars[j][1] - y);
        if (dist < r * 0.5) line(g, x, y, stars[j][0], stars[j][1]);
      }
    });
    g.stroke({ color: W, width: 1, alpha: 0.32 });
    for (const [x, y] of stars) {
      g.circle(x, y, 2.6).fill({ color: W, alpha: 0.8 });
      g.circle(x, y, 6).stroke({ color: W, width: 1, alpha: 0.3 });
    }
    g.circle(0, 0, r * 1.08).stroke({ color: W, width: 1, alpha: 0.16 });
  },
};

export const EMBLEM_NAMES = Object.keys(EMBLEMS);
/** The quiet ones, for a sad song: no sweep, no crosshair. */
export const QUIET_EMBLEMS = ['orbits', 'phases', 'flower', 'dial', 'petals', 'constellation'];

/** Draws an emblem of radius r on a Graphics (white; tint it). */
export const drawEmblem = (name, g, r, seed = 1) => {
  (EMBLEMS[name] ?? EMBLEMS.dial)(g, r, seed);
  return g;
};
