// Every particle in 花笺: the ambient elements (dust, rain, snow, petals,
// fireflies, embers, stars), the sparkler (線香花火), firework shells and the
// light that leaves the characters when a line fades.
//
// Nothing here is simulated step by step. Each particle's place is a closed
// formula of the song clock and a per-particle hash, so pausing freezes it,
// seeking jumps to the right picture, and two renders of the same moment
// match. Ambient elements cross-fade through levels; shells and sparklers are
// events with a start time, from the plan (known in advance, so a shell can be
// launched early and burst exactly on the word) or from live onsets.
//
// Two particle containers (behind and in front of the text) share one atlas,
// so all of it is two draw calls.

import * as PIXI from './vendor/pixi.min.mjs';
import { hash01 } from './random.mjs';
import { clamp, damp, smoothstep, wrap } from './motion.mjs';

const TAU = Math.PI * 2;
const AMBIENTS = ['dust', 'rain', 'snow', 'petals', 'fireflies', 'embers', 'stars'];
const COUNTS = { dust: 64, rain: 150, snow: 110, petals: 40, fireflies: 34, embers: 52, stars: 130 };
const LEVEL_TAU = 1.8;

const SHELLS = {
  peony: { n: 84, radius: 0.2, drag: 3.0, gravity: 0.1, life: 1.75, ghosts: 2, spacing: 0.045, twoTone: true },
  chrysanthemum: { n: 72, radius: 0.22, drag: 2.6, gravity: 0.12, life: 2.1, ghosts: 4, spacing: 0.04 },
  willow: { n: 56, radius: 0.18, drag: 1.5, gravity: 0.36, life: 3.6, ghosts: 7, spacing: 0.065, gold: true },
  ring: { n: 52, radius: 0.17, drag: 2.8, gravity: 0.08, life: 1.6, ghosts: 2, spacing: 0.05, ring: true },
  spark: { n: 26, radius: 0.075, drag: 3.4, gravity: 0.12, life: 0.95, ghosts: 1, spacing: 0.04 },
};
const RISE_SEC = 0.85;

const createLayer = () => {
  const container = new PIXI.ParticleContainer({
    dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
  });
  container.blendMode = 'add';
  return { container, pool: [], used: 0 };
};

export const createParticles = (atlas) => {
  const back = createLayer();
  const front = createLayer();
  const levels = Object.fromEntries(AMBIENTS.map((name) => [name, 0]));
  const targets = Object.fromEntries(AMBIENTS.map((name) => [name, 0]));
  let plan = null;
  let tints = [0xffffff];
  let warm = 0xffc27a;
  let hot = 0xfff1d6;
  let rainTint = 0xbfd0e6;
  let budget = 1;
  let cap = 2600;
  const runtimeShells = [];
  const glyphBursts = new Map();
  let pulse = 0;

  // Frame-local geometry, set at the top of update().
  let W = 1;
  let H = 1;
  let k = 1;
  let u = 1;

  const put = (layer, texture, x, y, w, h, alpha, tint, rotation = 0) => {
    if (alpha <= 0.004 || layer.used >= cap) return;
    if (x < -w - 40 || x > W + w + 40 || y < -h - 40 || y > H + h + 40) return;
    let particle = layer.pool[layer.used];
    if (!particle) {
      particle = new PIXI.Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
      layer.pool.push(particle);
    }
    particle.texture = texture;
    particle.x = x;
    particle.y = y;
    particle.scaleX = w / texture.frame.width;
    particle.scaleY = h / texture.frame.height;
    particle.rotation = rotation;
    particle.tint = tint;
    particle.alpha = Math.min(1, alpha);
    layer.used += 1;
  };

  const commit = (layer) => {
    const children = layer.container.particleChildren;
    if (children.length === layer.used) return;
    if (children.length < layer.used) {
      for (let i = children.length; i < layer.used; i += 1) children.push(layer.pool[i]);
    } else {
      children.length = layer.used;
    }
    layer.container.update();
  };

  const tintOf = (i) => tints[i % tints.length];

  // ---------------------------------------------------------------- ambient elements

  const countFor = (name, level) => Math.ceil(COUNTS[name] * budget * Math.min(1, level * 1.4));

  const drawDust = (t, level) => {
    const n = countFor('dust', level);
    for (let i = 0; i < n; i += 1) {
      const depth = 0.25 + 0.75 * hash01(i, 1);
      const bokeh = hash01(i, 7) < 0.1;
      const vx = (hash01(i, 3) - 0.5) * 14 * k * depth;
      const vy = -(3 + 9 * depth) * k;
      const x = wrap(hash01(i, 2) * W * 1.2 + t * vx + Math.sin(t * (0.07 + 0.1 * hash01(i, 4)) + hash01(i, 5) * TAU) * 36 * k * depth, W * 1.2) - W * 0.1;
      const y = wrap(hash01(i, 6) * H * 1.2 + t * vy, H * 1.2) - H * 0.1;
      const twinkle = 0.62 + 0.38 * Math.sin(t * (0.4 + 0.9 * hash01(i, 8)) + hash01(i, 4) * TAU);
      const size = bokeh ? (26 + 38 * hash01(i, 9)) * k : (3 + 9 * depth * depth) * k;
      const alpha = level * (bokeh ? 0.05 + 0.06 * hash01(i, 9) : 0.1 + 0.34 * depth) * twinkle * (1 + pulse * 0.6);
      put(back, bokeh ? atlas.ring : atlas.dot, x, y, size, size, alpha, tintOf(i));
    }
  };

  const drawRain = (t, level) => {
    const n = countFor('rain', level);
    const angle = 0.2;
    const slope = Math.tan(angle);
    const travel = H * 1.3;
    for (let i = 0; i < n; i += 1) {
      const depth = 0.3 + 0.7 * hash01(i, 11);
      const speed = H * (1.05 + 0.9 * depth);
      const y = wrap(hash01(i, 12) + (t * speed) / travel, 1) * travel - H * 0.15;
      const x = hash01(i, 13) * (W + H * 0.5) - H * 0.3 + (y + H * 0.15) * slope;
      const length = (34 + 74 * depth) * k;
      const width = (3 + 2.5 * depth) * k;
      put(back, atlas.streak, x, y, width, length, level * (0.07 + 0.22 * depth), rainTint, -angle);
    }
  };

  const drawSnow = (t, level) => {
    const n = countFor('snow', level);
    for (let i = 0; i < n; i += 1) {
      const depth = 0.25 + 0.75 * hash01(i, 21);
      const fall = (16 + 46 * depth) * k;
      const y = wrap(hash01(i, 22) * H * 1.2 + t * fall, H * 1.2) - H * 0.1;
      const sway = Math.sin(t * (0.25 + 0.5 * hash01(i, 24)) + hash01(i, 25) * TAU) * (10 + 26 * depth) * k;
      const x = wrap(hash01(i, 23) * W * 1.1 + sway + t * (hash01(i, 26) - 0.5) * 10 * k, W * 1.1) - W * 0.05;
      const size = (4 + 10 * depth) * k;
      put(back, atlas.dot, x, y, size, size, level * (0.22 + 0.5 * depth), 0xf4f7fb);
    }
  };

  const drawPetals = (t, level) => {
    const n = countFor('petals', level);
    for (let i = 0; i < n; i += 1) {
      const depth = 0.3 + 0.7 * hash01(i, 31);
      const fall = (22 + 40 * depth) * k;
      const drift = (14 + 30 * hash01(i, 37)) * k;
      const y = wrap(hash01(i, 32) * H * 1.25 + t * fall, H * 1.25) - H * 0.12;
      const x = wrap(hash01(i, 33) * W * 1.3 + t * drift + Math.sin(t * (0.6 + 0.8 * hash01(i, 34)) + hash01(i, 35) * TAU) * 24 * k, W * 1.3) - W * 0.15;
      const spin = hash01(i, 36) * TAU + t * (0.5 + 1.1 * hash01(i, 38)) * (hash01(i, 39) < 0.5 ? -1 : 1);
      const flip = 0.25 + 0.75 * Math.abs(Math.cos(t * (0.9 + 1.6 * hash01(i, 40)) + hash01(i, 41) * TAU));
      const size = (9 + 9 * depth) * k;
      put(back, atlas.petal, x, y, size * 1.7, size * flip, level * (0.32 + 0.45 * depth), tintOf(i), spin);
    }
  };

  const drawFireflies = (t, level) => {
    const n = countFor('fireflies', level);
    for (let i = 0; i < n; i += 1) {
      const x = W * (0.06 + 0.88 * hash01(i, 51))
        + Math.sin(t * (0.11 + 0.12 * hash01(i, 52)) + hash01(i, 53) * TAU) * W * 0.05
        + Math.sin(t * (0.43 + 0.3 * hash01(i, 54)) + hash01(i, 55) * TAU) * 14 * k;
      const y = H * (0.22 + 0.7 * hash01(i, 56))
        + Math.cos(t * (0.09 + 0.1 * hash01(i, 57)) + hash01(i, 58) * TAU) * H * 0.05
        + Math.cos(t * (0.37 + 0.2 * hash01(i, 59)) + hash01(i, 53) * 3) * 10 * k;
      const blink = smoothstep(0.15, 0.95, Math.sin(t * (0.55 + 0.8 * hash01(i, 60)) + hash01(i, 61) * TAU) * 0.5 + 0.5);
      const alpha = level * blink * (0.55 + 0.45 * hash01(i, 62));
      const halo = (26 + 20 * hash01(i, 62)) * k;
      put(back, atlas.dot, x, y, halo, halo, alpha * 0.32, warm);
      put(back, atlas.core, x, y, 5 * k, 5 * k, alpha, hot);
    }
  };

  const drawEmbers = (t, level) => {
    const n = countFor('embers', level);
    const travel = H * 1.15;
    for (let i = 0; i < n; i += 1) {
      const depth = 0.3 + 0.7 * hash01(i, 71);
      const rise = (30 + 60 * depth) * k;
      const phase = wrap(hash01(i, 72) + (t * rise) / travel, 1);
      const y = H * 1.05 - phase * travel;
      const x = hash01(i, 73) * W + Math.sin(t * (0.7 + 0.9 * hash01(i, 74)) + hash01(i, 75) * TAU) * (10 + 20 * depth) * k
        + phase * travel * 0.12 * (hash01(i, 76) - 0.35);
      const flicker = 0.55 + 0.45 * Math.sin(t * (7 + 6 * hash01(i, 77)) + hash01(i, 78) * 30);
      const alpha = level * (1 - smoothstep(0.45, 0.95, phase)) * smoothstep(0, 0.06, phase) * flicker * (0.4 + 0.6 * depth);
      const size = (2 + 3 * depth) * k;
      put(back, atlas.dot, x, y, size * 5, size * 5, alpha * 0.28, warm);
      put(back, atlas.core, x, y, size, size, alpha, hot);
    }
  };

  const drawStars = (t, level) => {
    const n = countFor('stars', level);
    for (let i = 0; i < n; i += 1) {
      const x = hash01(i, 81) * W;
      const y = hash01(i, 82) * H * 0.78;
      const twinkle = 0.55 + 0.45 * Math.sin(t * (0.6 + 2.2 * hash01(i, 83)) + hash01(i, 84) * TAU);
      const bright = hash01(i, 85);
      const size = (2.4 + 7 * bright ** 3) * k;
      const alpha = level * (0.15 + 0.7 * hash01(i, 86) ** 2) * twinkle;
      put(back, atlas.dot, x, y, size, size, alpha, 0xf3f1ff);
      if (bright > 0.93) put(back, atlas.flare, x, y, 18 * k, 18 * k, alpha * 0.55, 0xffffff);
    }
    // A shooting star now and then.
    const period = 8.5;
    const cycle = Math.floor(t / period);
    const local = t - cycle * period;
    if (hash01(cycle, 91) < 0.55 && local < 1) {
      const x0 = W * (0.3 + 0.6 * hash01(cycle, 92));
      const y0 = H * (0.05 + 0.25 * hash01(cycle, 93));
      const fade = Math.sin(Math.PI * local);
      for (let j = 0; j < 16; j += 1) {
        const d = local * W * 0.5 - j * 9 * k;
        if (d < 0) break;
        put(back, atlas.core, x0 - d * 0.86, y0 + d * 0.5, (3.4 - j * 0.18) * k, (3.4 - j * 0.18) * k, level * fade * (1 - j / 16), 0xffffff);
      }
    }
  };

  const AMBIENT_DRAW = { dust: drawDust, rain: drawRain, snow: drawSnow, petals: drawPetals, fireflies: drawFireflies, embers: drawEmbers, stars: drawStars };

  // ---------------------------------------------------------------- sparkler (線香花火)

  const drawSparkler = (s, index, t, boost) => {
    const age = t - s.t0;
    const duration = s.t1 - s.t0;
    if (age < 0 || age > duration + 1.4) return;
    const ax = s.x * W;
    const ay = s.y * H;
    const ignite = smoothstep(0, 0.7, age);
    const drop = Math.max(0, age - duration);
    const beadAlpha = 1 - smoothstep(0, 0.9, drop);
    const beadY = ay + 0.5 * 900 * k * drop * drop;
    // The paper twist it hangs from.
    put(front, atlas.streak, ax, ay - 80 * k, 4 * k, 150 * k, 0.22 * ignite * beadAlpha, warm);
    const swell = 1 + 0.12 * Math.sin(t * 23) + 0.25 * boost;
    put(front, atlas.dot, ax, beadY, 46 * k * swell * ignite, 46 * k * swell * ignite, 0.5 * beadAlpha, warm);
    put(front, atlas.core, ax, beadY, 9 * k * ignite, 9 * k * ignite, 0.95 * beadAlpha, hot);

    // Sparks: a fixed cadence, thinned by intensity, so each spark is a function of its index.
    const rate = 90 * budget;
    const maxLife = 0.6;
    const first = Math.max(0, Math.ceil((age - maxLife) * rate));
    const last = Math.floor(Math.min(age, duration) * rate);
    for (let n = first; n <= last; n += 1) {
      const born = n / rate;
      const sparkAge = age - born;
      // Busiest in the middle of the burn (松葉), sparse while it catches and as it dies (散り菊).
      const phase = born / Math.max(0.1, duration);
      const density = (0.25 + 0.75 * Math.sin(Math.PI * clamp(phase * 1.05))) * (0.45 + 0.55 * s.intensity) * smoothstep(0.2, 0.9, born);
      if (hash01(n, index, 1) > Math.min(1, density + boost * 0.4)) continue;
      const life = 0.2 + 0.4 * hash01(n, index, 2);
      if (sparkAge > life) continue;
      const f = sparkAge / life;
      const angle = hash01(n, index, 3) * TAU;
      const speed = (100 + 220 * hash01(n, index, 4)) * k;
      const travel = (speed * (1 - Math.exp(-4 * sparkAge))) / 4;
      const vx = Math.cos(angle) * speed * Math.exp(-4 * sparkAge);
      const vy = Math.sin(angle) * speed * Math.exp(-4 * sparkAge) + 240 * k * sparkAge;
      const x = ax + Math.cos(angle) * travel;
      const y = ay + Math.sin(angle) * travel + 120 * k * sparkAge * sparkAge;
      put(front, atlas.streak, x, y, 3 * k, (5 + 12 * (1 - f)) * k, (1 - f) * 0.9, hot, Math.atan2(vy, vx) - Math.PI / 2);
      // Most sparks fork into three as they slow (the branching that makes 線香花火).
      if (hash01(n, index, 5) < 0.75 && f > 0.4) {
        const splitAge = life * 0.4;
        const splitTravel = (speed * (1 - Math.exp(-4 * splitAge))) / 4;
        const sx = ax + Math.cos(angle) * splitTravel;
        const sy = ay + Math.sin(angle) * splitTravel + 120 * k * splitAge * splitAge;
        const childAge = sparkAge - splitAge;
        for (let c = 0; c < 3; c += 1) {
          const ca = angle + (hash01(n, index, 10 + c) - 0.5) * 2.4;
          const cs = (40 + 70 * hash01(n, index, 20 + c)) * k;
          const cx = sx + Math.cos(ca) * cs * childAge;
          const cy = sy + Math.sin(ca) * cs * childAge + 60 * k * childAge * childAge;
          put(front, atlas.core, cx, cy, 2.6 * k, 2.6 * k, (1 - childAge / (life * 0.6)) * 0.85, hot);
        }
      }
    }
  };

  // ---------------------------------------------------------------- firework shells

  const drawShell = (shell, t) => {
    const spec = SHELLS[shell.type] ?? SHELLS.peony;
    const tau = t - shell.t0;
    const sx = shell.x * W;
    const sy = shell.y * H;
    if (tau < 0) {
      if (!shell.rise || tau < -RISE_SEC) return;
      const p = 1 + tau / RISE_SEC;
      for (let j = 0; j < 7; j += 1) {
        const q = p - j * 0.028;
        if (q < 0) break;
        const ease = 1 - (1 - q) ** 2.2;
        const x = sx + Math.sin(q * 9 + shell.seed) * 2 * k;
        const y = H * 1.04 + (sy - H * 1.04) * ease;
        put(back, atlas.core, x, y, (3.6 - j * 0.35) * k, (3.6 - j * 0.35) * k, 0.9 * (1 - j / 7), hot);
        if (j === 0) put(back, atlas.dot, x, y, 16 * k, 16 * k, 0.3, warm);
      }
      return;
    }
    if (tau > spec.life * 1.2) return;
    const radius = spec.radius * u * shell.scale;
    if (tau < 0.18) {
      const flash = (1 - tau / 0.18) ** 2;
      put(back, atlas.dot, sx, sy, radius * 1.5, radius * 1.5, flash * 0.5, hot);
    }
    const n = Math.max(8, Math.round(spec.n * budget * Math.min(1.2, shell.scale)));
    const c1 = spec.gold ? warm : tintOf(shell.color);
    const c2 = spec.twoTone ? tintOf(shell.color + 1) : c1;
    const tilt = hash01(shell.seed, 7) * Math.PI;
    for (let i = 0; i < n; i += 1) {
      const theta = hash01(shell.seed, i, 1) * TAU;
      let dx;
      let dy;
      let depth;
      if (spec.ring) {
        const cx = Math.cos((i / n) * TAU);
        const cy = Math.sin((i / n) * TAU) * 0.42;
        dx = cx * Math.cos(tilt) - cy * Math.sin(tilt);
        dy = cx * Math.sin(tilt) + cy * Math.cos(tilt);
        depth = 0.5 + 0.5 * Math.sin((i / n) * TAU);
      } else {
        // Points on a sphere seen from the front: denser at the rim, as real shells look.
        const z = hash01(shell.seed, i, 2) * 2 - 1;
        const r = Math.sqrt(1 - z * z);
        dx = Math.cos(theta) * r;
        dy = Math.sin(theta) * r;
        depth = (z + 1) / 2;
      }
      const jitter = 0.9 + 0.1 * hash01(shell.seed, i, 3);
      const life = spec.life * (0.85 + 0.3 * hash01(shell.seed, i, 4));
      const f = tau / life;
      if (f >= 1) continue;
      // Drag-slowed travel plus gravity, computed inline (no per-star closures: this runs for
      // thousands of stars a frame, and garbage here would surface as periodic GC pauses).
      const reach = (radius * jitter) * (1 - Math.exp(-spec.drag * tau));
      const fall = 0.5 * spec.gravity * u;
      const x = sx + dx * reach;
      const y = sy + dy * reach + fall * tau * tau;
      const sparkle = f > 0.5 ? 0.6 + 0.4 * Math.sin(tau * 38 + i * 1.7) : 1;
      const alpha = (1 - smoothstep(0.55, 1, f)) * sparkle * (0.55 + 0.45 * depth);
      const color = f < 0.55 ? c1 : c2;
      const size = (2.2 + 1.8 * (1 - f)) * k * (0.75 + 0.5 * depth);
      put(back, atlas.dot, x, y, size * 4, size * 4, alpha * 0.45, color);
      put(back, atlas.core, x, y, size, size, alpha, f < 0.25 ? hot : color);
      for (let j = 1; j <= spec.ghosts; j += 1) {
        const ghostAge = tau - j * spec.spacing;
        if (ghostAge <= 0) break;
        const ghostReach = (radius * jitter) * (1 - Math.exp(-spec.drag * ghostAge));
        const gx = sx + dx * ghostReach;
        const gy = sy + dy * ghostReach + fall * ghostAge * ghostAge;
        put(back, atlas.core, gx, gy, size * (1 - j * 0.08), size * (1 - j * 0.08), alpha * 0.55 * (1 - j / (spec.ghosts + 1)), color);
      }
    }
  };

  // ---------------------------------------------------------------- light leaving the characters

  // A shared hash helper for the burst loop (set the key, then read slots), so the loop allocates nothing.
  let hashKey = 0;
  let hashM = 0;
  const hashSlot = (slot) => hash01(hashKey, hashM, slot);

  const drawGlyphBurst = (burst, t) => {
    const tau = t - burst.t0;
    if (tau < 0 || tau > 3.2) return;
    for (let j = 0; j < burst.points.length; j += 1) {
      const point = burst.points[j];
      const per = burst.style === 'sparks' ? 3 : burst.style === 'embers' ? 2 : hash01(burst.seed, j, 9) < 0.5 ? 2 : 1;
      const key = burst.seed + j * 31;
      for (let m = 0; m < per; m += 1) {
        const h = hashSlot;
        hashKey = key;
        hashM = m;
        if (burst.style === 'sparks') {
          const life = 0.55 + 0.45 * h(1);
          const f = tau / life;
          if (f >= 1) continue;
          const angle = h(2) * TAU;
          const speed = (60 + 140 * h(3)) * k;
          const d = (speed * (1 - Math.exp(-3.5 * tau))) / 3.5;
          const x = point.x + Math.cos(angle) * d;
          const y = point.y + Math.sin(angle) * d + 70 * k * tau * tau;
          put(front, atlas.core, x, y, 2.8 * k, 2.8 * k, (1 - f) * 0.9, f < 0.3 ? hot : burst.tint);
        } else if (burst.style === 'embers') {
          const life = 1.4 + 1.0 * h(1);
          const f = tau / life;
          if (f >= 1) continue;
          const x = point.x + (h(2) - 0.5) * 30 * k * tau + Math.sin(tau * (2 + 2 * h(3)) + h(4) * TAU) * 8 * k;
          const y = point.y - (24 + 40 * h(5)) * k * tau;
          const flicker = 0.6 + 0.4 * Math.sin(tau * (9 + 5 * h(6)) + h(7) * 20);
          const alpha = (1 - f) ** 1.2 * flicker;
          put(front, atlas.dot, x, y, 12 * k, 12 * k, alpha * 0.3, warm);
          put(front, atlas.core, x, y, 2.6 * k, 2.6 * k, alpha, hot);
        } else {
          const life = 1.6 + 1.0 * h(1);
          const f = tau / life;
          if (f >= 1) continue;
          const angle = -Math.PI / 2 + (h(2) - 0.5) * 2.2;
          const d = (16 + 30 * h(3)) * k * tau;
          const x = point.x + Math.cos(angle) * d;
          const y = point.y + Math.sin(angle) * d;
          const size = (5 + 6 * h(4)) * k;
          put(front, atlas.dot, x, y, size, size, Math.sin(Math.PI * f) * 0.55, burst.tint);
        }
      }
    }
  };

  // ---------------------------------------------------------------- public

  return {
    back: back.container,
    front: front.container,

    setPlan(nextPlan) {
      plan = nextPlan;
    },

    /** Particle tints: the plan palette mixed with the theme, plus the warm and hot tones of fire. */
    setColors({ palette, warmTint, hotTint, rain }) {
      tints = palette.length ? palette : [0xffffff];
      warm = warmTint;
      hot = hotTint;
      rainTint = rain;
    },

    /** Additive light vanishes on a light background: there particles are painted normally. */
    setDaylight(daylight) {
      back.container.blendMode = daylight ? 'normal' : 'add';
      front.container.blendMode = daylight ? 'normal' : 'add';
    },

    setBudget(value) {
      budget = clamp(value, 0.2, 1.6);
      cap = Math.round(2600 * budget);
    },

    /** Target level (0..1) of each ambient element; the rest fade to 0. */
    setAmbient(targetLevels) {
      for (const name of AMBIENTS) targets[name] = clamp(targetLevels[name] ?? 0);
    },

    /** A shell from a live onset (energetic paragraphs only), bursting now. */
    addLiveShell(shell) {
      runtimeShells.push(shell);
      if (runtimeShells.length > 12) runtimeShells.shift();
    },

    /** Light leaving a line's characters at `t0`; the same `id` replaces the earlier one. */
    addGlyphBurst(id, burst) {
      glyphBursts.set(id, burst);
    },

    onSeek() {
      runtimeShells.length = 0;
    },

    /**
     * Draws the frame at song time `t`. `live` is `{ onset, boost }` from the ear;
     * `snap` sets levels at once (previews).
     */
    update(t, dt, { width, height, live, snap }) {
      W = width;
      H = height;
      u = Math.min(W, H);
      k = u / 800;
      back.used = 0;
      front.used = 0;
      pulse = damp(pulse, 0, 0.35, dt);
      if (live?.onset) pulse = Math.max(pulse, live.onset);

      for (const name of AMBIENTS) {
        levels[name] = snap ? targets[name] : damp(levels[name], targets[name], LEVEL_TAU, dt);
        if (levels[name] > 0.01) AMBIENT_DRAW[name](t, levels[name]);
      }
      if (plan) {
        plan.sparklers.forEach((sparkler, index) => drawSparkler(sparkler, index, t, live?.boost ?? 0));
        for (const shell of plan.shells) {
          if (shell.t0 - RISE_SEC > t) break;
          if (t - shell.t0 < 4.5) drawShell(shell, t);
        }
      }
      for (let i = runtimeShells.length - 1; i >= 0; i -= 1) {
        const shell = runtimeShells[i];
        if (t - shell.t0 > 4.5 || t < shell.t0 - 1) runtimeShells.splice(i, 1);
        else drawShell(shell, t);
      }
      for (const [id, burst] of glyphBursts) {
        if (t - burst.t0 > 3.5 || burst.t0 - t > 180) glyphBursts.delete(id);
        else drawGlyphBurst(burst, t);
      }
      commit(back);
      commit(front);
      return back.used + front.used;
    },

    destroy() {
      back.container.destroy({ children: true });
      front.container.destroy({ children: true });
    },
  };
};
