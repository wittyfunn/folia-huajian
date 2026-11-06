// Shots: every sung line is a shot with its own layout, motion, camera,
// transition and decorations (the recipe comes from plan.mjs). A shot is built
// shortly before it appears and posed every frame as a pure function of song
// time: characters enter, are sung and leave by the motions in kinetic.mjs,
// the shot's container carries its camera move and transitions, and its
// decorations draw themselves on and off.
//
// Shots overlap during transitions; each has its own container, so a whip,
// a push-through or a dissolve is just two containers moving at once.

import * as PIXI from './vendor/pixi.min.mjs';
import { charTimings } from './lyrics.mjs';
import { GLOW_RES, createGlyphAtlas, createLabelTexture } from './textures.mjs';
import { drawEmblem } from './emblems.mjs';
import { MOVING_KINDS, layoutShot } from './layouts.mjs';
import { ENTER, EXIT, SING, TEMPERAMENTS, blank, fitStagger, ranks, resetTransform } from './kinetic.mjs';
import { hash01, hashString } from './random.mjs';
import { bump, clamp, easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, easeOutExpo, lerp, progress, smoothstep } from './motion.mjs';

const SCRAMBLE = Array.from('#%&@*+=/<>?!$01ΔΣΩ※◇');
// Shots are built this far ahead, one per frame, so a frame never pays for two builds and the
// texture uploads happen in a quiet frame instead of the one where the line appears.
const BUILD_AHEAD = 2.2;
const ATLAS_CACHE = 10;
const easeOutQuart = (t) => 1 - (1 - t) ** 4;
const easeInQuart = (t) => t ** 4;

const whiteSprite = (container) => {
  const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
  container.addChild(sprite);
  return sprite;
};
const poseBar = (sprite, x, y, w, h, alpha, tint, ax = 0.5, ay = 0.5, rotation = 0) => {
  sprite.visible = alpha > 0.003 && Math.abs(w) > 0.05 && Math.abs(h) > 0.05;
  if (!sprite.visible) return;
  sprite.anchor.set(ax, ay);
  sprite.position.set(x, y);
  sprite.width = w;
  sprite.height = h;
  sprite.rotation = rotation;
  sprite.alpha = Math.min(1, alpha);
  sprite.tint = tint;
};
const centered = (container, texture) => {
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  container.addChild(sprite);
  return sprite;
};
const mixNumber = (a, b, t) => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

export const createShots = (env) => {
  const live = new Map();
  let plan = null;
  let analysis = null;
  let song = null;
  const tmp = blank();

  const fonts = () => env.fonts();
  const fontAt = (weight) => (size) => `${weight} ${Math.max(1, size).toFixed(2)}px ${fonts().family}`;

  // ---------------------------------------------------------------- decorations
  // Each returns update(t, s) and draws in the shot's own coordinates (0,0 = shot center).

  /* A guide drawn around the main word: it grows in from small and turns a little over the shot. */
  const guide = (s, g, { turn = 0.15, alpha = 0.6 } = {}) => {
    const piece = s.heroPiece;
    const spin = (hash01(hashString(s.shot.id), 53) - 0.5) * turn;
    return (t) => {
      const grow = easeOutExpo(progress(t, s.shot.show + 0.15, 0.9));
      g.alpha = alpha * s.presence(t) * grow;
      g.visible = g.alpha > 0.003;
      if (!g.visible) return;
      g.position.set(piece.x, piece.y);
      g.scale.set(0.7 + 0.3 * grow);
      g.rotation = piece.rotation + spin * progress(t, s.shot.show, Math.max(1, s.exitEnd - s.shot.show));
    };
  };

  const DECOR = {
    /* A line-art emblem behind the main word (after 商籁): grows in, then turns slowly. */
    emblem(s, { colors, W, H }) {
      const seed = hashString(s.shot.id);
      const g = drawEmblem(s.shot.emblem, new PIXI.Graphics(), Math.min(W, H) * 0.36, seed);
      g.tint = colors.ink;
      s.back.addChild(g);
      // On a page the emblem sits in the open half, away from the text; elsewhere behind the main word.
      const page = s.shot.layout === 'page' || s.shot.layout === 'vertical';
      const away = (s.shot.mirror ? -1 : 1) * (s.shot.layout === 'vertical' ? -1 : 1);
      const piece = page ? { x: away * W * 0.26, y: 0 } : s.heroPiece;
      const turn0 = hash01(seed, 52) * Math.PI * 2;
      const spin = (hash01(seed, 51) - 0.5) * (s.shot.calm ? 0.12 : 0.35);
      const swing = s.shot.calm ? 0 : 0.35;
      const base = (colors.daylight ? 0.5 : 0.42) * (s.shot.calm ? 0.75 : 1);
      return (t) => {
        const grow = easeOutCubic(progress(t, s.shot.show, s.shot.calm ? 2 : 1.2));
        const life = progress(t, s.shot.show, Math.max(1, s.exitEnd - s.shot.show));
        g.alpha = base * s.presence(t) * (0.3 + 0.7 * grow);
        g.visible = g.alpha > 0.003;
        if (!g.visible) return;
        g.position.set(piece.x, piece.y);
        g.scale.set(0.84 + 0.16 * grow + 0.04 * life);
        g.rotation = turn0 + spin * life + (1 - grow) * swing;
      };
    },

    /* A magazine grid over the frame and a heavy inset frame (商籁's editorial column). */
    mesh(s, { colors, W, H }) {
      const g = new PIXI.Graphics();
      for (let k = 1; k <= 6; k += 1) g.moveTo(-W / 2 + (k / 7) * W, -H / 2).lineTo(-W / 2 + (k / 7) * W, H / 2);
      for (let k = 1; k <= 4; k += 1) g.moveTo(-W / 2, -H / 2 + (k / 5) * H).lineTo(W / 2, -H / 2 + (k / 5) * H);
      g.stroke({ color: 0xffffff, width: 1, alpha: 0.12 });
      g.rect(-W * 0.3, -H * 0.3, W * 0.6, H * 0.6).stroke({ color: 0xffffff, width: 3, alpha: 0.38 });
      g.tint = colors.ink;
      s.back.addChild(g);
      return (t) => {
        const d = easeOutExpo(progress(t, s.shot.show, 1.2));
        g.alpha = s.presence(t) * (0.4 + 0.6 * d);
        g.visible = g.alpha > 0.003;
        g.scale.set(1.05 - 0.05 * d);
      };
    },

    /* A five-line staff under a ribbon of words, a note for each word lighting as it is sung. */
    staff(s, { colors, W }) {
      const piece = s.heroPiece;
      const step = Math.max(7, piece.size * 0.11);
      const width = W * 0.86;
      const g = new PIXI.Graphics();
      for (let k = 0; k < 5; k += 1) g.moveTo(-width / 2, (k - 2) * step).lineTo(width / 2, (k - 2) * step);
      g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.3 });
      for (let k = 1; k < 4; k += 1) g.moveTo(-width / 2 + (k / 4) * width, -2 * step).lineTo(-width / 2 + (k / 4) * width, 2 * step);
      g.stroke({ color: 0xffffff, width: 1, alpha: 0.16 });
      g.moveTo(-width / 2 + 6, -2 * step).lineTo(-width / 2 + 6, 2 * step).stroke({ color: 0xffffff, width: 4, alpha: 0.45 });
      g.moveTo(width / 2 - 8, -2 * step).lineTo(width / 2 - 8, 2 * step).stroke({ color: 0xffffff, width: 1.5, alpha: 0.45 });
      g.moveTo(width / 2 - 2, -2 * step).lineTo(width / 2 - 2, 2 * step).stroke({ color: 0xffffff, width: 5, alpha: 0.45 });
      g.tint = colors.ink;
      const root = new PIXI.Container();
      root.addChild(g);
      const seed = hashString(s.shot.id);
      const notes = s.wordInfo.map((word, k) => {
        const note = new PIXI.Graphics();
        const line = Math.floor(hash01(seed, k, 71) * 9) - 4;
        const up = line < 0;
        note.ellipse(0, 0, step * 0.62, step * 0.44).fill({ color: 0xffffff });
        note.moveTo(up ? -step * 0.58 : step * 0.58, 0).lineTo(up ? -step * 0.58 : step * 0.58, up ? step * 3.2 : -step * 3.2).stroke({ color: 0xffffff, width: 1.5 });
        note.position.set(-width / 2 + ((k + 0.5) / s.wordInfo.length) * width * 0.92 + width * 0.04, (line * step) / 2);
        note.rotation = -0.3;
        note.tint = colors.accentNumber;
        root.addChild(note);
        return { note, at: word.at };
      });
      s.back.addChild(root);
      return (t) => {
        const a = s.presence(t);
        root.visible = a > 0.003;
        if (!root.visible) return;
        root.position.set(0, piece.y + piece.h * 0.7);
        g.alpha = a * easeOutExpo(progress(t, s.shot.show, 1));
        for (const { note, at } of notes) {
          const lit = t >= at ? 1 : 0;
          const pop = lit ? Math.exp(-(t - at) / 0.25) : 0;
          note.alpha = a * (0.25 + 0.65 * lit);
          note.scale.set(1 + 0.35 * pop);
        }
      };
    },

    /* A few small squares set about the frame, appearing one after another (商籁's quiet tableau). */
    squares(s, { colors, W, H }) {
      const seed = hashString(s.shot.id);
      const marks = Array.from({ length: 5 }, (_, k) => ({
        sprite: whiteSprite(s.back),
        x: (hash01(seed, k, 61) - 0.5) * W * 0.7,
        y: (hash01(seed, k, 62) - 0.5) * H * 0.6,
        size: 7 + 9 * hash01(seed, k, 63),
        at: s.shot.show + 0.2 + k * 0.18,
      }));
      return (t) => {
        for (const m of marks) poseBar(m.sprite, m.x, m.y, m.size, m.size, 0.4 * s.presence(t) * smoothstep(m.at, m.at + 0.6, t), colors.accentNumber);
      };
    },

    /* 云阶's hair lines: a thin rule beside each block, drawn out as the block is sung. */
    guides(s, { colors }) {
      const marks = s.pieces.map((piece) => ({ piece, bar: whiteSprite(s.back), left: (piece.order ?? piece.index) % 2 === 0 }));
      return (t) => {
        for (const { piece, bar, left } of marks) {
          const grow = easeOutCubic(progress(t, piece.first - 0.2, 0.4));
          const x = piece.x + (left ? -1 : 1) * (piece.w / 2 + piece.size * 0.35);
          poseBar(bar, x, piece.y, 1.2, piece.h * 0.9 * grow, 0.5 * s.presence(t), colors.accentNumber, 0.5, 0.5, piece.rotation);
        }
      };
    },

    /* A ring with a crosshair through the main word. */
    crosshair(s, { colors }) {
      const piece = s.heroPiece;
      const r = Math.max(piece.w, piece.h) * 0.6;
      const g = new PIXI.Graphics();
      g.circle(0, 0, r).stroke({ color: 0xffffff, width: 1.5, alpha: 0.7 });
      g.circle(0, 0, r * 1.07).stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.moveTo(dx * r * 0.85, dy * r * 0.85).lineTo(dx * r * 1.35, dy * r * 1.35);
      g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.7 });
      g.tint = colors.accentNumber;
      s.back.addChild(g);
      return guide(s, g, { turn: 0.5 });
    },

    /* A square frame turned to a diamond around the main word. */
    diamondFrame(s, { colors }) {
      const piece = s.heroPiece;
      const side = Math.max(piece.w, piece.h) * 0.92;
      const g = new PIXI.Graphics();
      g.rect(-side / 2, -side / 2, side, side).stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
      g.rect(-side * 0.46, -side * 0.46, side * 0.92, side * 0.92).stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
      const wrap = new PIXI.Container();
      g.rotation = Math.PI / 4;
      wrap.addChild(g);
      g.tint = colors.ink;
      s.back.addChild(wrap);
      return guide(s, wrap, { turn: 0.3, alpha: 0.7 });
    },

    /* Two arches, one over and one under the main word. */
    arches(s, { colors }) {
      const piece = s.heroPiece;
      const r = Math.max(piece.w, piece.h) * 0.55;
      const off = Math.min(piece.w, piece.h) * 0.62;
      const g = new PIXI.Graphics();
      g.arc(0, -off, r, Math.PI, Math.PI * 2).stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
      g.arc(0, off, r, 0, Math.PI).stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
      g.arc(0, -off, r * 1.08, Math.PI * 1.1, Math.PI * 1.9).stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
      g.tint = colors.ink;
      s.back.addChild(g);
      return guide(s, g, { turn: 0.08, alpha: 0.65 });
    },

    underline(s, { colors }) {
      const piece = s.heroPiece;
      const bar = whiteSprite(s.front);
      const glyphs = s.glyphs.filter((g) => g.g.piece === piece.index);
      const first = Math.min(...glyphs.map((g) => g.timing.start));
      const last = Math.max(...glyphs.map((g) => g.timing.end));
      return (t) => {
        const sung = easeOutCubic(progress(t, first, Math.max(0.3, last - first)));
        const out = easeInCubic(progress(t, s.exitStart, 0.4));
        poseBar(bar, piece.x - piece.w / 2, piece.y + piece.h * 0.52, piece.w * sung * (1 - out), Math.max(1.5, piece.size * 0.035), 0.85 * s.presence(t), colors.accentNumber, 0, 0.5, piece.rotation);
      };
    },

    frame(s, { colors }) {
      const piece = s.heroPiece;
      const variant = Math.floor(hash01(hashString(s.shot.id), 41) * 3);
      const pad = piece.size * 0.32;
      const w = piece.w + pad * 2;
      const h = piece.h + pad * 0.8;
      const cos = Math.cos(piece.rotation);
      const sin = Math.sin(piece.rotation);
      const at = (dx, dy) => [piece.x + dx * cos - dy * sin, piece.y + dx * sin + dy * cos];
      if (variant === 0) {
        // Corner brackets, growing out of each corner.
        const bars = Array.from({ length: 8 }, () => whiteSprite(s.front));
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        return (t) => {
          const draw = easeOutExpo(progress(t, s.shot.show + 0.2, 0.7));
          const arm = Math.min(w, h) * 0.3 * draw;
          const a = 0.7 * s.presence(t);
          corners.forEach(([sx, sy], c) => {
            const [x, y] = at((sx * w) / 2, (sy * h) / 2);
            poseBar(bars[c * 2], x, y, arm, 1.2, a, colors.ink, sx < 0 ? 0 : 1, 0.5, piece.rotation);
            poseBar(bars[c * 2 + 1], x, y, 1.2, arm, a, colors.ink, 0.5, sy < 0 ? 0 : 1, piece.rotation);
          });
        };
      }
      // A box drawn edge by edge (solid) or in dashes.
      const dashed = variant === 2;
      const edges = [[-w / 2, -h / 2, w / 2, -h / 2], [w / 2, -h / 2, w / 2, h / 2], [w / 2, h / 2, -w / 2, h / 2], [-w / 2, h / 2, -w / 2, -h / 2]];
      const dash = piece.size * 0.18;
      const segments = [];
      edges.forEach(([x0, y0, x1, y1], e) => {
        const length = Math.hypot(x1 - x0, y1 - y0);
        const count = dashed ? Math.max(1, Math.floor(length / (dash * 1.7))) : 1;
        for (let k = 0; k < count; k += 1) {
          const f0 = dashed ? k / count : 0;
          const f1 = dashed ? f0 + (dash / length) : 1;
          segments.push({ e, f0, f1, x0, y0, x1, y1, bar: whiteSprite(s.front) });
        }
      });
      return (t) => {
        const a = 0.6 * s.presence(t);
        for (const seg of segments) {
          const local = clamp(progress(t, s.shot.show + 0.15 + seg.e * 0.12, 0.35));
          const reach = clamp((local - seg.f0) / Math.max(1e-3, seg.f1 - seg.f0));
          const fx = seg.x0 + (seg.x1 - seg.x0) * seg.f0;
          const fy = seg.y0 + (seg.y1 - seg.y0) * seg.f0;
          const len = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) * (seg.f1 - seg.f0) * reach;
          const angle = Math.atan2(seg.y1 - seg.y0, seg.x1 - seg.x0) + piece.rotation;
          const [x, y] = at(fx, fy);
          poseBar(seg.bar, x, y, len, 1.2, a, colors.ink, 0, 0.5, angle);
        }
      };
    },

    /* A manuscript margin: a rule down the page, a tick on it as each line arrives. */
    margin(s, { colors }) {
      const right = s.shot.mirror;
      const size = s.pieces[0].size;
      const edge = right ? Math.max(...s.pieces.map((p) => p.x + p.w / 2)) + size * 0.8 : Math.min(...s.pieces.map((p) => p.x - p.w / 2)) - size * 0.8;
      const top = Math.min(...s.pieces.map((p) => p.y - p.h / 2)) - size * 0.2;
      const bottom = Math.max(...s.pieces.map((p) => p.y + p.h / 2)) + size * 0.2;
      const rule = whiteSprite(s.front);
      const ticks = s.lineInfo.map((line) => ({ ...line, bar: whiteSprite(s.front) }));
      return (t) => {
        const a = s.presence(t);
        poseBar(rule, edge, top, 1, (bottom - top) * easeOutExpo(progress(t, s.shot.show, 1.8)), 0.3 * a, colors.ink, 0.5, 0);
        for (const tick of ticks) {
          const p = easeOutCubic(progress(t, tick.enterAt, 0.5));
          const now = t < tick.pastAt ? 1 : 1 - 0.6 * smoothstep(tick.pastAt, tick.pastAt + 0.6, t);
          poseBar(tick.bar, edge, tick.y, size * 0.45 * p, 1.3, 0.75 * a * now, colors.accentNumber, right ? 0 : 1, 0.5);
        }
      };
    },

    /* Manuscript paper for a vertical page: column lines and a top and bottom rule, drawn right to left. */
    grid(s, { colors }) {
      const columns = s.pieces;
      const size = columns[0].size;
      const half = size * 0.925;
      const top = Math.min(...columns.map((p) => p.y - p.h / 2)) - size * 0.45;
      const bottom = Math.max(...columns.map((p) => p.y + p.h / 2)) + size * 0.45;
      const xs = [columns[0].x + half, ...columns.map((p) => p.x - half)];
      const lines = xs.map((x, i) => ({ x, i, bar: whiteSprite(s.back) }));
      const edges = [top, bottom].map((y) => ({ y, bar: whiteSprite(s.back) }));
      return (t) => {
        const a = s.presence(t);
        for (const line of lines) poseBar(line.bar, line.x, top, 1, (bottom - top) * easeOutExpo(progress(t, s.shot.show + line.i * 0.08, 1.4)), 0.22 * a, colors.accentNumber, 0.5, 0);
        const across = easeOutExpo(progress(t, s.shot.show + 0.1, 1.6));
        for (const edge of edges) poseBar(edge.bar, xs[0], edge.y, (xs[0] - xs[xs.length - 1]) * across, 1, 0.3 * a, colors.accentNumber, 1, 0.5);
      };
    },

    rule(s, { colors, H }) {
      const piece = s.mainPiece;
      const right = s.shot.mirror;
      const x = right ? piece.x + piece.w / 2 + piece.size * 0.7 : piece.x - piece.w / 2 - piece.size * 0.7;
      const bar = whiteSprite(s.front);
      return (t) => {
        const draw = easeOutExpo(progress(t, s.shot.show, 1.2));
        poseBar(bar, x, piece.y + piece.size * 0.7, 1, H * 0.46 * draw, 0.35 * s.presence(t), colors.ink, 0.5, 1);
      };
    },

    leak(s, { colors, W, H }) {
      const sprite = centered(s.back, env.radial);
      sprite.blendMode = colors.daylight ? 'normal' : 'add';
      sprite.tint = colors.warm;
      const side = s.shot.mirror ? -1 : 1;
      return (t) => {
        const p = progress(t, s.shot.show - 0.2, 2.4);
        sprite.visible = p > 0 && p < 1;
        if (!sprite.visible) return;
        sprite.position.set(side * lerp(-W * 0.55, W * 0.55, easeInOutCubic(p)), lerp(-H * 0.1, H * 0.05, p));
        sprite.width = W * 0.9;
        sprite.height = H * 0.9;
        sprite.alpha = (colors.daylight ? 0.12 : 0.22) * bump(p);
      };
    },
  };

  // ---------------------------------------------------------------- atlases

  /** When a shot is gone for good: its exit plus the longest possible stagger. */
  const endOf = (shot) => shot.exitStart + (EXIT[shot.exit]?.dur ?? 1) + 0.45;

  /* Glyph atlases by font, size and characters: a returning chorus reuses its glyphs. */
  const atlases = new Map();
  /* A generator: each heavy part (drawing a sheet, uploading it) is its own step. */
  const acquireAtlas = function* (chars, font, size, dpr) {
    const key = `${font(size)}|${dpr}|${[...new Set(chars)].sort().join('')}`;
    let entry = atlases.get(key);
    if (!entry) {
      const atlas = createGlyphAtlas(chars, { font, size, dpr });
      // Bigger glyphs, fewer per step.
      const perStep = Math.max(1, Math.round(1100 / Math.max(1, size * dpr)));
      while (!atlas.drawSharp(perStep)) yield;
      yield;
      env.upload(atlas.sharpSource);
      yield;
      let glowSource;
      while (!(glowSource = atlas.buildGlow(perStep))) yield;
      env.upload(glowSource);
      yield;
      entry = atlases.get(key) ?? { atlas, refs: 0, key };
      if (entry.atlas !== atlas) atlas.destroy();
      entry.atlas.key = key;
    }
    atlases.delete(key);
    atlases.set(key, entry); // most recently used last
    entry.refs += 1;
    // Unused atlases beyond the cache size go, oldest first.
    for (const [otherKey, other] of atlases) {
      if (atlases.size <= ATLAS_CACHE) break;
      if (other.refs === 0) {
        other.atlas.destroy();
        atlases.delete(otherKey);
      }
    }
    return entry.atlas;
  };
  const releaseAtlas = (atlas) => {
    const entry = atlases.get(atlas.key);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
  };
  const clearAtlases = () => {
    for (const entry of atlases.values()) entry.atlas.destroy();
    atlases.clear();
  };

  // ---------------------------------------------------------------- building a shot

  /* Builds a shot step by step (a generator): the scheduler runs a few milliseconds of it per frame.
   * `job` collects what to clean up if the build is abandoned half way. */
  const buildShotSteps = function* (shot, shotIndexInParagraph, job) {
    const { W, H, fs, dpr } = env.metrics();
    const colors = env.colors();
    const pools = TEMPERAMENTS[shot.temperament] ?? TEMPERAMENTS.lyrical;
    const lines = (shot.items ?? [shot.item]).map((index) => {
      const item = analysis.items[index];
      const chars = Array.from(String(item.line.fullText ?? ''));
      // Where each character starts in UTF-16, to match Folia's keyword colour ranges.
      const offsets = [];
      let offset = 0;
      for (const char of chars) {
        offsets.push(offset);
        offset += char.length;
      }
      return { item, chars, offsets, colorRanges: env.wordColors?.(item.line) ?? null, segments: env.segment(item.line), timings: charTimings(item.line) };
    });
    const mark = globalThis.__HUAJIAN_DEBUG__ ? [['start', performance.now()]] : null;
    const lap = (name) => {
      mark?.push([name, performance.now()]);
      job.label = `after ${name}`;
    };
    // A sad song keeps the regular weight; a loud passage sets its words bold.
    const bold = !shot.calm && (shot.temperament === 'punchy' || (shot.temperament === 'dramatic' && shot.layout !== 'vertical'));
    const weight = bold ? Math.max(fonts().weight, 700) : fonts().weight;
    // Vertical columns are set in the book face (Song), as a scroll would be.
    const family = shot.layout === 'vertical' ? fonts().display : fonts().family;
    const font = (size) => `${weight} ${Math.max(1, size).toFixed(2)}px ${family}`;
    const { glyphs: placed, pieces } = layoutShot({ lines, layout: shot.layout, m: { W, H, fs }, font, keyword: shot.keyword, variant: shot.variant, mirror: shot.mirror, calm: shot.calm });

    lap('layout');
    yield;
    const root = new PIXI.Container();
    job.root = root;
    const back = new PIXI.Container();
    const shadowLayer = new PIXI.Container();
    const glowLayer = new PIXI.Container();
    const rgbLayer = new PIXI.Container();
    const sharpLayer = new PIXI.Container();
    const front = new PIXI.Container();
    glowLayer.blendMode = colors.daylight ? 'normal' : 'add';
    rgbLayer.blendMode = colors.daylight ? 'normal' : 'add';
    root.addChild(back, shadowLayer, glowLayer, rgbLayer, sharpLayer, front);
    // Set type (凝彩) carries a print shadow.
    const printed = shot.layout === 'type';

    // Two glyph sheets: the large words drawn at their own size (sharp even at 340 px), the rest at
    // theirs, so a word shot's few huge characters do not make every small one a huge texture.
    const largest = Math.max(fs, ...placed.map((g) => g.size));
    const bigCut = largest * 0.6;
    const bigSize = Math.min(340, largest);
    const smallSize = Math.min(200, Math.max(fs * 0.5, ...placed.filter((g) => g.size <= bigCut).map((g) => g.size)));
    const extra = shot.enter === 'scramble' ? SCRAMBLE : [];
    const bigChars = placed.filter((g) => g.size > bigCut).map((g) => g.char);
    const smallChars = placed.filter((g) => g.size <= bigCut).map((g) => g.char);
    const disposables = [];
    job.disposables = disposables;
    const bigAtlas = bigChars.length ? yield* acquireAtlas(bigChars.concat(extra), font, bigSize, dpr) : null;
    if (bigAtlas) disposables.push({ destroy: () => releaseAtlas(bigAtlas) });
    const smallAtlas = smallChars.length ? yield* acquireAtlas(smallChars.concat(extra), font, smallSize, dpr) : null;
    if (smallAtlas) disposables.push({ destroy: () => releaseAtlas(smallAtlas) });
    lap('atlas');

    // Each line comes in on its own time (a page holds several): its order, stagger and lead.
    const byLine = lines.map(() => []);
    placed.forEach((g, i) => byLine[g.line].push(i));
    const lineShow = lines.map(({ item }) => Math.max(shot.show, item.start - pools.lead));
    const rankOf = new Array(placed.length).fill(0);
    const staggerOf = lines.map((line, li) => {
      const order = ranks(shot.order, byLine[li].length, hashString(shot.id) + li);
      byLine[li].forEach((index, k) => {
        rankOf[index] = order[k];
      });
      return fitStagger(shot.enter, Math.max(0, ...order), pools.stagger, line.item.start - lineShow[li] + 0.35).stagger;
    });
    const enterDuration = ENTER[shot.enter]?.dur ?? 0.6;
    // On a page, a line steps back once the next one starts.
    const pastAt = lines.map((_, li) => (li < lines.length - 1 ? lines[li + 1].item.start - 0.15 : Infinity));
    const exitRank = lines.length > 1 ? placed.map((_, i) => i) : rankOf;
    const maxExitRank = Math.max(0, ...exitRank);
    const exitSpec = EXIT[shot.exit] ?? EXIT.dissolve;
    const exitStagger = Math.min(0.035, 0.4 / Math.max(1, maxExitRank));
    const useRgb = shot.enter === 'glitch' || shot.enter === 'scramble';
    const useGhost = shot.enter === 'slide' || shot.enter === 'stretch' || shot.exit === 'slide';

    const glyphs = placed.map((g, i) => {
      const line = lines[g.line];
      const big = g.size > bigCut;
      const atlas = big ? bigAtlas : smallAtlas;
      const entry = atlas.get(g.char);
      const glow = centered(glowLayer, entry.glow);
      const sharp = centered(sharpLayer, entry.sharp);
      // Keyword colour: Folia's own (the theme's wordColors) when the theme has them, as every
      // builtin mode shows them; otherwise the director's keyword in the accent colour.
      const ranged = line.colorRanges?.find((range) => line.offsets[g.ci] >= range.start && line.offsets[g.ci] < range.end);
      const isKeyword = line.colorRanges ? Boolean(ranged) : shot.keyword && g.line === shot.keyword.line && g.ci >= shot.keyword.charIndex && g.ci < shot.keyword.charIndex + shot.keyword.length;
      const piece = pieces[g.piece];
      const timing = line.timings[g.ci] ?? { start: line.item.start, end: line.item.end };
      const glyph = {
        g,
        sharp,
        glow,
        timing,
        id: (hashString(shot.id) + i * 7919) | 0,
        r1: hash01(hashString(shot.id), i, 1),
        r2: hash01(hashString(shot.id), i, 2),
        r3: hash01(hashString(shot.id), i, 3),
        cx: (piece.x - g.x) / g.size,
        cy: (piece.y - g.y) / g.size,
        rank: rankOf[i],
        baseTint: ranged ? ranged.color : isKeyword ? colors.accentNumber : colors.ink,
        glowTint: colors.glow,
        dim: pools.dim,
        glowScale: isKeyword ? 1.1 : 0.85,
        scaleBase: g.size / (big ? bigSize : smallSize),
        pastAt: pastAt[g.line],
        pastFade: shot.pastFade,
      };
      // A word shot's word travels in from its own side as it settles (商籁).
      glyph.offX = piece.enterX ?? 0;
      glyph.offY = piece.enterY ?? 0;
      if (printed) {
        glyph.shadow = centered(shadowLayer, entry.sharp);
        glyph.shadow.tint = colors.daylight ? colors.ink : 0x000000;
      }
      glyph.enterAt = shot.mode === 'sung' ? Math.max(lineShow[g.line], timing.start - enterDuration * 0.55) : lineShow[g.line] + glyph.rank * staggerOf[g.line];
      glyph.exitAt = shot.exitStart + exitRank[i] * exitStagger;
      glow.tint = colors.glow;
      sharp.tint = glyph.baseTint;
      if (useRgb) {
        glyph.red = centered(rgbLayer, entry.sharp);
        glyph.blue = centered(rgbLayer, entry.sharp);
        glyph.red.tint = 0xff3355;
        glyph.blue.tint = 0x33d0ff;
      }
      if (useGhost) {
        glyph.ghosts = [centered(rgbLayer, entry.sharp), centered(rgbLayer, entry.sharp)];
        for (const ghost of glyph.ghosts) ghost.tint = glyph.baseTint;
      }
      glyph.scrambleTextures = shot.enter === 'scramble' ? SCRAMBLE.map((c) => atlas.get(c)?.sharp).filter(Boolean) : null;
      glyph.sharpTexture = entry.sharp;
      return glyph;
    });

    lap('sprites');
    yield;
    const exitEnd = shot.exitStart + maxExitRank * exitStagger + exitSpec.dur;
    const heroPiece = pieces.find((p) => p.role === 'hero') ?? pieces[0];
    const mainPiece = pieces[0];
    // Per line: where it sits (the page camera follows it) and when it arrives and steps back.
    let last = { x: 0, y: 0 };
    const lineInfo = lines.map((line, li) => {
      const own = pieces.filter((p) => p.line === li);
      if (own.length) last = { x: own.reduce((sum, p) => sum + p.x, 0) / own.length, y: own[0].y };
      const enterAt = Math.min(Infinity, ...byLine[li].map((index) => glyphs[index].enterAt));
      return { ...last, at: line.item.start, enterAt: Number.isFinite(enterAt) ? enterAt : lineShow[li], pastAt: pastAt[li] };
    });
    for (const piece of pieces) {
      const own = piece.glyphs.map((index) => glyphs[index].timing);
      piece.first = Math.min(...own.map((timing) => timing.start));
      piece.last = Math.max(...own.map((timing) => timing.end));
    }
    // Each word's centre and the moment it is first sung, in order: the staff's notes use them.
    const wordInfo = pieces
      .map((p) => ({ x: p.x, y: p.y, at: Math.min(...p.glyphs.map((index) => glyphs[index].timing.start)) }))
      .sort((a, b) => a.at - b.at);
    const s = {
      shot,
      key: shot.id,
      wordInfo,
      root,
      back,
      front,
      glyphs,
      pieces,
      heroPiece,
      mainPiece,
      disposables,
      exitStart: shot.exitStart,
      exitEnd,
      enterDuration,
      lineInfo,
      shotIndexInParagraph,
      presence: (t) => smoothstep(shot.show, shot.show + 0.45, t) * (1 - smoothstep(shot.exitStart, shot.exitStart + 0.45, t)),
      decor: [],
    };
    if (env.settings().ornaments && heroPiece) {
      const ctx = { colors, fs, dpr, W, H };
      const kinds = [...shot.decor];
      if (shot.transIn === 'leak') kinds.push('leak');
      for (const kind of kinds) {
        const update = DECOR[kind]?.(s, ctx);
        if (update) s.decor.push(update);
        yield;
      }
    }
    lap('decor');
    env.layers.text.addChild(root);
    registerBursts(s);
    if (mark) (globalThis.__huajianLaps ??= []).push([shot.id, shot.layout, ...mark.slice(1).map(([n, at], i) => `${n} ${(at - mark[i][1]).toFixed(1)}`)]);
    return s;
  };

  /* Where a transition moves the frame along: its angle as a unit vector. */
  const along = (angle) => [Math.cos(angle ?? 0), Math.sin(angle ?? 0)];

  /* The wipe band (after 凝彩): a chevron of solid colour wider than the frame's diagonal sweeps
   * across, covering the old paragraph and uncovering the new one, a thin stripe of a second
   * colour trailing it. */
  let band = null;
  const poseBand = (t) => {
    const wipe = plan.wipes?.find((w) => t > w.t - 0.36 && t < w.t + 0.36);
    if (!wipe) {
      if (band) band.root.visible = false;
      return;
    }
    const { W, H } = env.metrics();
    const colors = env.colors();
    const key = `${W}x${H}`;
    if (!band || band.key !== key) {
      band?.root.destroy({ children: true });
      const diagonal = Math.hypot(W, H);
      const point = diagonal * 0.08;
      const length = diagonal + point * 2;
      const e = -diagonal / 2 - point;
      const n = diagonal / 2;
      const chevron = (from, to) => [from, -n, to, -n, to + point, 0, to, n, from, n, from + point, 0];
      const root = new PIXI.Container();
      const main = new PIXI.Graphics().poly(chevron(e, e + length)).fill({ color: 0xffffff });
      const stripe = new PIXI.Graphics().poly(chevron(e - length * 0.1, e - length * 0.04)).fill({ color: 0xffffff });
      root.addChild(stripe, main);
      env.layers.overlay.addChild(root);
      band = { key, root, main, stripe, length };
    }
    const q = clamp((t - (wipe.t - 0.36)) / 0.72);
    const amount = q < 0.5 ? easeInCubic(q * 2) : 1 + easeOutCubic((q - 0.5) * 2);
    const u = (amount - 1) * band.length * 1.12;
    const [dx, dy] = along(wipe.angle);
    band.root.visible = true;
    band.root.position.set(W / 2 + dx * u, H / 2 + dy * u);
    band.root.rotation = wipe.angle;
    band.main.tint = colors.particle(wipe.tone);
    band.stripe.tint = colors.particle(wipe.tone + 1);
  };

  /* The light leaving a line's characters, registered with its exact time and places. */
  const registerBursts = (s) => {
    const style = s.shot.accentWeather === 'fireworks' ? 'sparks'
      : s.shot.accentWeather === 'sparkler' || s.shot.weather === 'embers' ? 'embers'
        : s.shot.weather === 'none' ? null : 'motes';
    if (!style || s.shot.transOut === 'cutOut') return;
    const { W, H } = env.metrics();
    const colors = env.colors();
    const main = s.glyphs;
    const step = Math.max(1, Math.ceil(main.length / 20));
    env.particles.addGlyphBurst(`shot:${s.key}`, {
      t0: s.exitStart + 0.08,
      points: main.filter((_, i) => i % step === 0).map((glyph) => ({ x: W / 2 + glyph.g.x, y: H / 2 + glyph.g.y })),
      style,
      tint: style === 'sparks' ? colors.particle(s.shot.paragraph) : colors.accentNumber,
      seed: hashString(s.key),
    });
  };

  // ---------------------------------------------------------------- posing

  /*
   * How a piece of a 流光, 云阶 or 心象 shot moves as a whole (after Folia's classic, partita and
   * cadenza): a turn, a scale, a shift and an alpha, around the piece's centre. A sad song keeps a
   * third of each motion.
   */
  const pieceMotion = (shot, piece, t, out) => {
    const k = (shot.calm ? 0.3 : 1);
    const size = piece.size;
    const i = piece.order ?? piece.index;
    const sung = smoothstep(piece.first - 0.05, piece.first + 0.15, t);
    const passed = smoothstep(piece.last, piece.last + 0.6, t);
    out.rot = 0;
    out.scale = 1;
    out.dx = 0;
    out.dy = 0;
    out.alpha = 1;
    if (shot.layout === 'lyric') {
      // 流光: the line breathes; a unit lights up a little as it is sung and turns once it has been.
      out.dy = Math.sin(t * 1.1 + i * 1.7) * size * 0.035 * k;
      out.scale = 1 + 0.07 * k * bump(progress(t, piece.first - 0.05, Math.max(0.3, piece.last - piece.first + 0.3)));
      out.rot = (i % 2 === 0 ? 1 : -1) * 0.2 * k * passed;
    } else if (shot.layout === 'cloud') {
      // 云阶: a block waits small and faint, grows to full when sung, then tilts aside, odd and even in turn.
      const grow = shot.calm ? easeOutCubic(sung) : easeOutBack(sung, 1.4);
      out.scale = 0.85 + 0.15 * grow;
      out.alpha = 0.55 + 0.45 * sung;
      out.rot = (i % 2 === 0 ? 1 : -1) * 0.1 * k * passed;
    } else if (shot.layout === 'shards') {
      // 心象: a fragment waits turned aside, swells as it is sung, then drifts off; all of them swim.
      // Drifting off upward, a little to either side, so a fragment does not run into its neighbour.
      const angle = -Math.PI / 2 + ((i * 0.61) % 1.2 - 0.6);
      out.rot = 0.35 * k * (1 - sung);
      out.scale = (0.9 + 0.1 * sung) * (1 + 0.3 * k * bump(progress(t, piece.first - 0.05, Math.max(0.35, piece.last - piece.first + 0.3))));
      out.dx = Math.cos(angle) * size * 0.25 * passed * k + Math.sin(t * 1.2 + i) * size * 0.05 * k;
      out.dy = Math.sin(angle) * size * 0.25 * passed * k + Math.cos(t * 1.5 + i * 1.3) * size * 0.05 * k;
      out.alpha = 1 - 0.3 * passed;
    }
    return out;
  };
  const motionOut = { rot: 0, scale: 1, dx: 0, dy: 0, alpha: 1 };

  const hideGlyph = (glyph) => {
    glyph.sharp.visible = false;
    glyph.glow.visible = false;
    if (glyph.shadow) glyph.shadow.visible = false;
    if (glyph.red) glyph.red.visible = glyph.blue.visible = false;
    if (glyph.ghosts) glyph.ghosts[0].visible = glyph.ghosts[1].visible = false;
  };

  const placeSprite = (sprite, alpha, x, y, sx, sy, rotation, skew) => {
    sprite.visible = alpha > 0.003;
    if (!sprite.visible) return;
    sprite.position.set(x, y);
    sprite.scale.set(sx, sy);
    sprite.rotation = rotation;
    sprite.skew.x = skew;
    sprite.alpha = Math.min(1, alpha);
  };

  const poseCamera = (s, t, W, H) => {
    const { shot } = s;
    const life = progress(t, shot.show, Math.max(0.6, s.exitEnd - shot.show));
    const side = shot.mirror ? -1 : 1;
    s.transBlur = 0;
    let x = W / 2;
    let y = H / 2;
    let scale = 1;
    let rotation = 0;
    let alpha = 1;
    switch (shot.camera) {
      case 'drift': x += lerp(-1, 1, life) * W * 0.014 * side; y += lerp(1, -1, life) * H * 0.008; break;
      case 'push': scale *= 1 + 0.08 * easeInOutCubic(life); break;
      case 'pull': scale *= 1.1 - 0.1 * easeOutCubic(life); break;
      case 'pan': x += lerp(1, -1, easeInOutCubic(life)) * W * 0.035 * side; break;
      case 'rise': y += lerp(1, -1, easeInOutCubic(life)) * H * 0.035; break;
      case 'roll': rotation = lerp(-1, 1, easeInOutCubic(life)) * 0.035 * side; scale *= 1.03; break;
      case 'punch': {
        const hit = t >= shot.start - 0.03 ? 1 - easeOutExpo(progress(t, shot.start - 0.03, 0.5)) : 0;
        scale *= 1 + 0.13 * hit + 0.04 * life;
        break;
      }
      case 'focus':
        // A word shot: the camera sits a little close and pushes in slowly; it does not chase words.
        scale *= (shot.zoom ?? 1.04) + 0.03 * easeInOutCubic(life);
        x += lerp(-1, 1, life) * W * 0.006 * side;
        rotation += (shot.tilt ?? 0) * (1 - 0.5 * life);
        break;
      case 'fly': {
        // 浮名: the sheet is larger than the frame; the camera flies to each line as it is sung.
        const lines = s.lineInfo;
        let fx = lines[0].x;
        let fy = lines[0].y;
        for (let k = 1; k < lines.length; k += 1) {
          const e = easeInOutCubic(progress(t, lines[k].at - 0.45, 0.6));
          fx += (lines[k].x - fx) * e;
          fy += (lines[k].y - fy) * e;
        }
        scale *= 1.08;
        x -= fx * scale;
        y -= fy * scale;
        rotation += (shot.mirror ? -1 : 1) * 0.015 * Math.sin(life * Math.PI);
        break;
      }
      case 'track': {
        // A page: the view eases toward the line being sung and closes in slowly over the page.
        const lines = s.lineInfo;
        let fx = lines[0].x;
        let fy = lines[0].y;
        for (let k = 1; k < lines.length; k += 1) {
          const e = easeInOutCubic(progress(t, lines[k].at - 1, 1.8));
          fx += (lines[k].x - fx) * e;
          fy += (lines[k].y - fy) * e;
        }
        const vertical = shot.layout === 'vertical';
        // Only a drift toward the line being sung, slow enough not to read as the frame moving.
        x -= fx * (vertical ? 0.08 : 0.03);
        y -= fy * (vertical ? 0.02 : 0.08);
        scale *= 1 + 0.045 * easeInOutCubic(life);
        break;
      }
      default: break;
    }
    const enterP = progress(t, shot.show, 0.6);
    switch (shot.transIn) {
      case 'pushIn': scale *= 0.86 + 0.14 * easeOutCubic(enterP); break;
      case 'zoomIn': scale *= 1.4 - 0.4 * easeOutExpo(enterP); break;
      case 'whipIn': {
        const k = 1 - easeOutQuart(progress(t, shot.show, 0.42));
        x += shot.dir.x * W * 0.45 * k;
        y += shot.dir.y * H * 0.45 * k;
        break;
      }
      case 'drift': x += side * W * 0.06 * (1 - easeOutCubic(enterP)); break;
      case 'panIn': {
        // The whole frame pans: the new paragraph slides in from where the old one slid away.
        const k = 1 - easeInOutCubic(progress(t, shot.show, 0.7));
        const [ax, ay] = along(shot.angle);
        x += ax * W * k;
        y += ay * H * k;
        alpha *= smoothstep(0, 0.15, 1 - k);
        break;
      }
      case 'blurIn': {
        const e = easeOutCubic(progress(t, shot.show, 0.6));
        const [ax, ay] = along(shot.angle);
        x -= ax * W * 0.04 * (1 - e);
        y -= ay * H * 0.04 * (1 - e);
        scale *= 1 + 0.06 * (1 - e);
        s.transBlur = Math.max(s.transBlur, 1 - e);
        break;
      }
      case 'wipeIn': if (t < shot.wipeAt) alpha = 0; break;
      case 'flick': {
        // 商籁's quick blur: a fifth of a second from soft to sharp.
        const e = easeOutCubic(progress(t, shot.show, 0.22));
        s.transBlur = Math.max(s.transBlur, 1 - e);
        scale *= 1 + 0.05 * (1 - e);
        alpha *= 0.25 + 0.75 * e;
        break;
      }
      default: break;
    }
    const outP = progress(t, shot.exitStart, 0.5);
    switch (shot.transOut) {
      case 'pushOut': scale *= 1 + 0.4 * easeInCubic(outP); alpha *= 1 - easeInCubic(outP); break;
      case 'whipOut': {
        const k = easeInQuart(progress(t, shot.exitStart, 0.38));
        x -= shot.nextDir.x * W * 0.45 * k;
        y -= shot.nextDir.y * H * 0.45 * k;
        break;
      }
      case 'cutOut': if (t > shot.exitStart + 0.03) alpha = 0; break;
      case 'panOut': {
        const k = easeInOutCubic(progress(t, shot.exitStart, 0.7));
        const [ax, ay] = along(shot.angle);
        x -= ax * W * k;
        y -= ay * H * k;
        alpha *= 1 - smoothstep(0.85, 1, k);
        break;
      }
      case 'blurOut': {
        const e = easeInCubic(progress(t, shot.exitStart, 0.5));
        const [ax, ay] = along(shot.angle);
        x += ax * W * 0.04 * e;
        y += ay * H * 0.04 * e;
        scale *= 1 + 0.06 * e;
        alpha *= 1 - smoothstep(0.55, 1, e);
        s.transBlur = Math.max(s.transBlur, e);
        break;
      }
      case 'wipeOut': if (t >= shot.wipeAt) alpha = 0; break;
      case 'flickOut': {
        const e = easeInCubic(progress(t, shot.exitStart, 0.22));
        s.transBlur = Math.max(s.transBlur, e);
        alpha *= 1 - e;
        break;
      }
      default: break;
    }
    s.root.position.set(x, y);
    s.root.scale.set(scale);
    s.root.rotation = rotation;
    s.root.alpha = alpha;
    s.root.visible = alpha > 0.003;
  };

  const poseShot = (s, t, frame) => {
    const { W, H } = env.metrics();
    if (t < s.shot.show - 0.05) {
      s.root.visible = false;
      return;
    }
    poseCamera(s, t, W, H);
    if (!s.root.visible) return;
    const { shot } = s;
    const enterSpec = ENTER[shot.enter] ?? ENTER.rise;
    const exitSpec = EXIT[shot.exit] ?? EXIT.dissolve;
    const sing = SING[shot.sing] ?? SING.glow;
    const daylight = env.colors().daylight;
    const glowScale = daylight ? 0.3 : 1;
    const motion = frame.motion;
    const g = { t, id: 0, r1: 0, r2: 0, r3: 0, cx: 0, cy: 0, dirX: shot.dir.x, dirY: shot.dir.y };
    const moving = MOVING_KINDS.includes(shot.layout);
    for (const glyph of s.glyphs) {
      const o = resetTransform(tmp);
      g.id = glyph.id;
      g.r1 = glyph.r1;
      g.r2 = glyph.r2;
      g.r3 = glyph.r3;
      g.cx = glyph.cx;
      g.cy = glyph.cy;
      let sungness = 0;
      const enterP = (t - glyph.enterAt) / s.enterDuration;
      if (enterP < 0) {
        hideGlyph(glyph);
        continue;
      }
      if (enterP < 1) enterSpec.fn(enterP, g, o);
      const since = t - glyph.timing.start;
      const duration = Math.max(0.12, glyph.timing.end - glyph.timing.start);
      if (since >= 0) {
        sing(since, duration, o, g);
        sungness = easeOutCubic(clamp(since / Math.min(0.5, Math.max(0.16, duration))));
      }
      // A page line that has been sung steps back so the current one leads.
      const past = t > glyph.pastAt ? smoothstep(glyph.pastAt, glyph.pastAt + 0.7, t) : 0;
      const exitP = (t - glyph.exitAt) / exitSpec.dur;
      if (exitP >= 1) {
        hideGlyph(glyph);
        continue;
      }
      if (exitP > 0) exitSpec.fn(exitP, g, o);
      if (s.transBlur > 0) o.blur = Math.max(o.blur, s.transBlur);

      // Motion strength: the user's setting scales displacement, never the timing.
      const size = glyph.g.size;
      const dx = o.dx * size * motion;
      const dy = o.dy * size * motion;
      const pulse = sungness > 0 ? 1 + 0.06 * frame.pulse : 1;
      let sx = glyph.scaleBase * (1 + (o.sx - 1) * motion) * pulse;
      let sy = glyph.scaleBase * (1 + (o.sy - 1) * motion) * pulse;
      let rotation = glyph.g.rotation + o.rot * motion;
      const travel = enterP < 1 ? (1 - easeOutCubic(enterP)) * motion : 0;
      let x = glyph.g.x + dx + glyph.offX * travel;
      let y = glyph.g.y + dy + glyph.offY * travel;
      let pieceAlpha = 1;
      if (moving) {
        // The piece moves as one: the glyph turns and scales about the piece's centre.
        const piece = s.pieces[glyph.g.piece];
        const m = pieceMotion(shot, piece, t, motionOut);
        const c = Math.cos(m.rot * motion);
        const n = Math.sin(m.rot * motion);
        const px = x - piece.x;
        const py = y - piece.y;
        x = piece.x + m.dx * motion + (px * c - py * n) * m.scale;
        y = piece.y + m.dy * motion + (px * n + py * c) * m.scale;
        rotation += m.rot * motion;
        sx *= m.scale;
        sy *= m.scale;
        pieceAlpha = m.alpha;
      }
      const dim = glyph.dim;
      const blur = clamp(o.blur);
      const visibility = o.alpha * pieceAlpha * (dim + (1 - dim) * sungness) * (1 - (glyph.pastFade ?? 0.6) * past);
      placeSprite(glyph.sharp, visibility * (1 - 0.4 * blur), x, y, sx, sy, rotation, o.skew);
      if (glyph.shadow) placeSprite(glyph.shadow, visibility * (1 - blur) * (daylight ? 0.18 : 0.34), x + size * 0.06, y + size * 0.08, sx, sy, rotation, o.skew);
      const glowAlpha = o.alpha * (o.glow + blur * 0.5 + (sungness > 0 ? 0.1 + 0.1 * frame.level : 0)) * glyph.glowScale * glowScale * (1 - past);
      const glowScaleUp = (1 + 0.15 * blur) / GLOW_RES;
      placeSprite(glyph.glow, glowAlpha, x, y, sx * glowScaleUp, sy * glowScaleUp, rotation, o.skew);
      glyph.sharp.tint = o.tint > 0 ? mixNumber(glyph.baseTint, env.colors().accentNumber, o.tint) : glyph.baseTint;
      if (o.scramble && glyph.scrambleTextures?.length) {
        glyph.sharp.texture = glyph.scrambleTextures[o.scramble % glyph.scrambleTextures.length];
      } else if (glyph.sharp.texture !== glyph.sharpTexture) {
        glyph.sharp.texture = glyph.sharpTexture;
      }
      if (glyph.red) {
        const split = o.rgb * size * 0.12;
        placeSprite(glyph.red, visibility * o.rgb * 0.8, x + split, y, sx, sy, rotation, o.skew);
        placeSprite(glyph.blue, visibility * o.rgb * 0.8, x - split, y, sx, sy, rotation, o.skew);
      }
      if (glyph.ghosts) {
        // Motion trail: copies behind the direction of travel.
        const trailX = -Math.sign(o.dx || shot.dir.x) * size * 0.55 * o.ghost;
        const trailY = -Math.sign(o.dy || shot.dir.y) * size * 0.55 * o.ghost * (shot.dir.y ? 1 : 0);
        placeSprite(glyph.ghosts[0], visibility * 0.22 * o.ghost, x + trailX, y + trailY, sx, sy, rotation, o.skew);
        placeSprite(glyph.ghosts[1], visibility * 0.1 * o.ghost, x + trailX * 2, y + trailY * 2, sx, sy, rotation, o.skew);
      }
    }
    for (const update of s.decor) update(t, s);
  };

  /* Screen effects the shots on stage ask for at time t (deterministic: from their own times). */
  const effectsAt = (t) => {
    let flash = 0;
    let rgb = 0;
    let distort = 0;
    for (const s of live.values()) {
      const { shot } = s;
      if (!shot) continue;
      if (shot.transIn === 'flash' && t >= shot.start - 0.06) flash = Math.max(flash, 0.5 * Math.exp(-(t - shot.start + 0.06) / 0.11));
      if (shot.transIn === 'glitch' && t >= shot.show) rgb = Math.max(rgb, 0.03 * Math.exp(-(t - shot.show) / 0.16));
      if (shot.transIn === 'whipIn') rgb = Math.max(rgb, 0.012 * bump(progress(t, shot.show, 0.42)));
      if (shot.transIn === 'zoomIn') distort = Math.max(distort, 0.35 * (1 - easeOutExpo(progress(t, shot.show, 0.6))) * (t >= shot.show ? 1 : 0));
      if (shot.transOut === 'pushOut') distort = Math.max(distort, 0.3 * easeInCubic(progress(t, shot.exitStart, 0.5)) * (t < shot.exitStart + 0.5 ? 1 : 0));
      if (shot.enter === 'glitch' && t >= shot.show) rgb = Math.max(rgb, 0.008 * Math.exp(-(t - shot.show) / 0.3));
    }
    return { flash, rgb, distort };
  };

  // ---------------------------------------------------------------- title card

  const buildTitle = () => {
    const title = plan.title;
    const { W, H, fs, dpr } = env.metrics();
    const colors = env.colors();
    const root = new PIXI.Container();
    const front = new PIXI.Container();
    root.addChild(front);
    env.layers.text.addChild(root);
    const disposables = [];
    const entries = [];
    const add = (text, size, fontCss, y, delay, alpha, spacing) => {
      if (!text) return;
      const texture = createLabelTexture(text, { font: fontCss, size, dpr, letterSpacing: size * spacing });
      disposables.push(texture);
      env.upload(texture.source);
      const sprite = centered(front, texture);
      sprite.tint = colors.ink;
      entries.push({ sprite, y, delay, alpha, size, chars: Array.from(text).length });
    };
    const name = String(song?.title ?? '').trim();
    const nameSize = fs * 0.66;
    add(name, nameSize, `500 ${nameSize.toFixed(2)}px ${fonts().display}`, H * 0.44, 0, 0.95, 0.34);
    add(String(song?.artist ?? '').trim(), fs * 0.3, fontAt(400)(fs * 0.3), H * 0.44 + fs * 0.98, 0.45, 0.6, 0.3);
    title.credits.slice(0, 4).forEach((index, i) => add(analysis.items[index]?.text ?? '', fs * 0.24, fontAt(400)(fs * 0.24), H * 0.64 + i * fs * 0.46, 0.9 + i * 0.15, 0.42, 0.12));
    const rule = whiteSprite(front);
    const update = (t) => {
      for (const entry of entries) {
        const p = progress(t, title.show + entry.delay, 1.6);
        const a = smoothstep(title.show + entry.delay, title.show + entry.delay + 1, t) * (1 - smoothstep(title.end - 0.9, title.end, t));
        entry.sprite.visible = a > 0.003;
        entry.sprite.position.set(W / 2, entry.y + (1 - easeOutCubic(p)) * fs * 0.3);
        // Tracking closes in as the title settles.
        entry.sprite.scale.set(1.12 - 0.12 * easeOutExpo(p), 1);
        entry.sprite.alpha = entry.alpha * a;
      }
      const draw = easeOutExpo(progress(t, title.show + 0.3, 1.8));
      poseBar(rule, W / 2, H * 0.44 + fs * 0.56, fs * 3.2 * draw, 1, 0.38 * (1 - smoothstep(title.end - 0.9, title.end, t)) * smoothstep(title.show, title.show + 0.5, t), colors.ink);
    };
    return { key: 'title', root, disposables, update, exitEnd: title.end + 0.1 };
  };

  const jobs = new Map();
  const failed = new Set();
  const SLICE_MS = 3;
  /* Drops a half-built shot (a seek, a resize): whatever it already made is released. */
  const abandon = (key, job) => {
    job.steps.return?.();
    job.root?.destroy({ children: true });
    for (const item of job.disposables) item.destroy?.(true);
    jobs.delete(key);
  };

  const destroy = (s) => {
    s.root.destroy({ children: true });
    for (const item of s.disposables) item.destroy?.(true);
  };

  // ---------------------------------------------------------------- public

  return {
    setPlan(nextPlan, nextAnalysis, nextSong, now = -Infinity) {
      // Shots already on screen keep their recipe; the ones not yet shown are rebuilt.
      for (const [key, s] of live) {
        if (key === 'title') continue;
        if (now < (s.shot?.show ?? s.show)) {
          destroy(s);
          live.delete(key);
        }
      }
      for (const [key, job] of jobs) abandon(key, job);
      failed.clear();
      plan = nextPlan;
      analysis = nextAnalysis;
      song = nextSong;
    },

    rebuild() {
      for (const s of live.values()) destroy(s);
      live.clear();
      for (const [key, job] of jobs) abandon(key, job);
      clearAtlases();
      band?.root.destroy({ children: true });
      band = null;
    },

    onSeek() {
      for (const s of live.values()) if (s.shot) registerBursts(s);
    },

    /** Poses every shot on stage at time t; returns the screen effects they ask for. */
    update(t, frame) {
      if (!plan) return { flash: 0, rgb: 0, distort: 0 };
      const wanted = new Map();
      if (plan.title && t >= plan.title.show - BUILD_AHEAD && t <= plan.title.end + 0.2) wanted.set('title', null);
      const counts = new Map();
      for (const shot of plan.shots) {
        const k = counts.get(shot.paragraph) ?? 0;
        counts.set(shot.paragraph, k + 1);
        if (shot.show - BUILD_AHEAD > t) break;
        // The same bound decides "still needed" whether or not the shot is built (a shot's exit
        // staggers at most 0.4 s), so a finished shot is never rebuilt and dropped again.
        if (t <= endOf(shot)) wanted.set(shot.id, { shot, k, show: shot.show });
      }
      for (const [key, s] of live) {
        if (!wanted.has(key)) {
          destroy(s);
          live.delete(key);
        }
      }
      for (const [key, job] of jobs) {
        if (!wanted.has(key)) abandon(key, job);
      }
      // Builds run a few milliseconds per frame, the earliest shot first; a shot that is due now is
      // finished at once (that only happens after a seek or a very short gap).
      let started = false;
      for (const [key, value] of wanted) {
        if (live.has(key) || failed.has(key)) continue;
        if (key === 'title') {
          live.set(key, buildTitle());
          continue;
        }
        const due = t >= value.show - 0.3;
        if (!due && started) continue;
        started = true;
        let job = jobs.get(key);
        if (!job) {
          job = { root: null, disposables: [], spent: 0 };
          job.steps = buildShotSteps(value.shot, value.k, job);
          jobs.set(key, job);
        }
        const sliceStart = performance.now();
        const until = due ? Infinity : sliceStart + SLICE_MS;
        let step;
        try {
          do {
            const stepAt = globalThis.__HUAJIAN_DEBUG__ ? performance.now() : 0;
            step = job.steps.next();
            if (stepAt && performance.now() - stepAt > 4) (globalThis.__huajianHeavySteps ??= []).push([key, +(performance.now() - stepAt).toFixed(1), job.label ?? ""]);
          } while (!step.done && performance.now() < until);
        } catch (error) {
          // A shot that cannot be built is skipped (its line simply does not appear) rather than
          // leaving a broken job that would fail again every frame.
          abandon(key, job);
          failed.add(key);
          env.onError?.(error);
          continue;
        }
        job.spent += performance.now() - sliceStart;
        if (step.done) {
          jobs.delete(key);
          live.set(key, step.value);
          if (globalThis.__HUAJIAN_DEBUG__) (globalThis.__huajianBuilds ??= []).push([key, +job.spent.toFixed(1), +t.toFixed(2)]);
        }
      }
      for (const s of live.values()) {
        if (s.shot) poseShot(s, t, frame);
        else s.update(t);
      }
      poseBand(t);
      return effectsAt(t);
    },

    /** What is built and being built, for the diagnostic record. */
    debugState() {
      return { live: [...live.keys()], building: [...jobs.keys()], atlases: atlases.size };
    },

    /** The shot whose words are on screen now (for the director overlay). */
    current(t) {
      let found = null;
      for (const s of live.values()) if (s.shot && t >= s.shot.show && t < s.exitStart) found = s.shot;
      return found;
    },

    destroy() {
      this.rebuild();
    },
  };
};
