// Everything 花笺 draws is made on canvases here, once, then moved and faded as
// sprites: no per-frame drawing. Glyphs are rendered white and tinted on the
// GPU, so a theme change needs no redraw.

import * as PIXI from './vendor/pixi.min.mjs';

const makeCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
};

const sourceOf = (canvas, resolution = 1) => new PIXI.CanvasSource({ resource: canvas, resolution, autoGenerateMipmaps: false });
const sub = (source, x, y, w, h) => new PIXI.Texture({ source, frame: new PIXI.Rectangle(x, y, w, h) });

/**
 * One atlas for every particle shape, so each particle container draws in a
 * single batch. Shapes are white; particles are tinted.
 */
export const createParticleAtlas = () => {
  const canvas = makeCanvas(256, 256);
  const c = canvas.getContext('2d');

  // dot: a soft round glow (0,0,64,64)
  let g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);

  // core: a small bright disc with a short falloff (64,0,32,32)
  g = c.createRadialGradient(80, 16, 0, 80, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(64, 0, 32, 32);

  // streak: a thin vertical line fading at both ends (96,0,8,96)
  g = c.createLinearGradient(0, 0, 0, 96);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(99, 0, 2, 96);
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.fillRect(98, 20, 4, 60);

  // petal: an almond with a soft edge (112,0,48,28)
  c.save();
  c.translate(136, 14);
  g = c.createRadialGradient(-4, -2, 1, 0, 0, 22);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(-22, 0);
  c.quadraticCurveTo(-4, -13, 22, -1);
  c.quadraticCurveTo(-2, 12, -22, 0);
  c.fill();
  c.restore();

  // flare: a four-point glint (160,0,64,64)
  c.save();
  c.translate(192, 32);
  for (const [w, h] of [[30, 1.6], [1.6, 30]]) {
    g = c.createRadialGradient(0, 0, 0, 0, 0, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(-w, -h, w * 2, h * 2);
  }
  c.restore();

  // ring: a bokeh disc, brighter at its rim (0,64,96,96)
  g = c.createRadialGradient(48, 112, 0, 48, 112, 46);
  g.addColorStop(0, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.82, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 64, 96, 96);

  const source = sourceOf(canvas);
  return {
    source,
    dot: sub(source, 0, 0, 64, 64),
    core: sub(source, 64, 0, 32, 32),
    streak: sub(source, 96, 0, 8, 96),
    petal: sub(source, 112, 0, 48, 28),
    flare: sub(source, 160, 0, 64, 64),
    ring: sub(source, 0, 64, 96, 96),
    destroy() {
      source.destroy();
    },
  };
};

/** A radial gradient, white center to transparent: tinted and stretched for the wash and vignette. */
export const createRadialTexture = (inner, outer) => {
  const size = 512;
  const canvas = makeCanvas(size, size);
  const c = canvas.getContext('2d');
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  // Dither the alpha by a step or two: a soft gradient stretched across a screen otherwise shows bands.
  const image = c.getImageData(0, 0, size, size);
  let seed = 987654321;
  for (let i = 3; i < image.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + ((seed >>> 24) % 5) - 2));
  }
  c.putImageData(image, 0, 0);
  return new PIXI.Texture({ source: sourceOf(canvas) });
};

/** Film grain: mid-grey noise, tiled and shifted every few frames. */
export const createGrainTexture = () => {
  const size = 160;
  const canvas = makeCanvas(size, size);
  const c = canvas.getContext('2d');
  const image = c.createImageData(size, size);
  let seed = 1234567;
  for (let i = 0; i < size * size; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const v = 96 + ((seed >>> 16) & 127);
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  c.putImageData(image, 0, 0);
  const source = sourceOf(canvas);
  source.style.addressMode = 'repeat';
  return new PIXI.Texture({ source });
};

/* Packs cells of the given widths into rows no wider than maxRow; returns positions and the sheet size. */
const pack = (widths, cellH, maxRow) => {
  const spots = [];
  let x = 0;
  let y = 0;
  let width = 1;
  for (const w of widths) {
    if (x + w > maxRow && x > 0) {
      x = 0;
      y += cellH;
    }
    spots.push({ x, y });
    x += w;
    width = Math.max(width, x);
  }
  return { spots, width, height: y + cellH };
};

/** The glow is drawn at this fraction of the size (times the screen's pixel ratio, up to 1.5) and
 *  enlarged on the GPU. Half size keeps it smooth on high-DPI screens; lower read as smeared. */
export const GLOW_RES = 0.5;

/**
 * Glyph atlas for a set of characters: a sharp white copy of each at full resolution, and a glowing
 * copy on a small separate sheet (scale its sprites by 1 / GLOW_RES). `font(px)` gives a CSS font.
 * The glow sheet is drawn by a separate call, `buildGlow()`, so the two can land in different frames.
 * Returns `{ get(char) -> { sharp, glow, width }, sharpSource, buildGlow() -> glowSource, destroy }`.
 */
export const createGlyphAtlas = (chars, { font, size, dpr, glow = 0.42 }) => {
  const unique = [...new Set(chars.filter((char) => !/\s/u.test(char)))];
  const probe = makeCanvas(4, 4).getContext('2d');
  probe.font = font(size);
  const advances = unique.map((char) => probe.measureText(char).width);

  // Sharp sheet: a small pad is enough (no blur).
  const pad = Math.ceil(size * 0.12 + 2);
  const cellH = Math.ceil(size * 1.32 + pad * 2);
  const sharpW = advances.map((a) => Math.ceil(Math.max(a, size * 0.3) + pad * 2));
  const sharp = pack(sharpW, cellH, 2048);
  const sharpCanvas = makeCanvas(sharp.width * dpr, sharp.height * dpr);
  let c = sharpCanvas.getContext('2d');
  c.scale(dpr, dpr);
  c.font = font(size);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffffff';
  // Large glyphs are slow to rasterize: the sheet is filled a few characters per call.
  let drawn = 0;
  const drawSharp = (count = Infinity) => {
    const sharpContext = sharpCanvas.getContext('2d');
    const end = Math.min(unique.length, drawn + count);
    for (; drawn < end; drawn += 1) {
      sharpContext.fillText(unique[drawn], sharp.spots[drawn].x + sharpW[drawn] / 2, sharp.spots[drawn].y + cellH / 2);
    }
    return drawn >= unique.length;
  };

  const sharpSource = sourceOf(sharpCanvas, dpr);
  const map = new Map(unique.map((char, i) => [char, {
    sharp: sub(sharpSource, sharp.spots[i].x, sharp.spots[i].y, sharpW[i], cellH),
    glow: null,
    width: advances[i],
  }]));
  // Glow sheet at GLOW_RES of the size, drawn a few characters per call like the sharp sheet.
  const gr = Math.min(1.5, dpr);
  const small = size * GLOW_RES;
  const blur = Math.max(1.5, small * glow);
  const gPad = Math.ceil(blur * 1.7 + 2);
  const gCellH = Math.ceil(small * 1.32 + gPad * 2);
  const glowW = advances.map((a) => Math.ceil(Math.max(a, size * 0.3) * GLOW_RES + gPad * 2));
  const glowSheet = pack(glowW, gCellH, 1400);
  let glowCanvas = null;
  let glowContext = null;
  let glowDrawn = 0;
  let glowSource = null;
  /** Draws up to `count` more glow characters; returns the source once all are drawn, else null. */
  const buildGlow = (count = Infinity) => {
    if (glowSource) return glowSource;
    if (!glowCanvas) {
      glowCanvas = makeCanvas(glowSheet.width * gr, glowSheet.height * gr);
      glowContext = glowCanvas.getContext('2d');
      glowContext.scale(gr, gr);
      glowContext.font = font(small);
      glowContext.textAlign = 'center';
      glowContext.textBaseline = 'middle';
      glowContext.fillStyle = '#ffffff';
      glowContext.shadowColor = '#ffffff';
      // The shadow blur is in device pixels: it ignores the context transform.
      glowContext.shadowBlur = blur * gr;
    }
    const end = Math.min(unique.length, glowDrawn + count);
    for (; glowDrawn < end; glowDrawn += 1) {
      // Drawn twice: one pass of shadow is too faint to read as light.
      const gx = glowSheet.spots[glowDrawn].x + glowW[glowDrawn] / 2;
      const gy = glowSheet.spots[glowDrawn].y + gCellH / 2;
      glowContext.fillText(unique[glowDrawn], gx, gy);
      glowContext.fillText(unique[glowDrawn], gx, gy);
    }
    if (glowDrawn < unique.length) return null;
    glowSource = sourceOf(glowCanvas, gr);
    unique.forEach((char, i) => {
      map.get(char).glow = sub(glowSource, glowSheet.spots[i].x, glowSheet.spots[i].y, glowW[i], gCellH);
    });
    return glowSource;
  };
  return {
    get: (char) => map.get(char) ?? null,
    sharpSource,
    drawSharp,
    buildGlow,
    destroy() {
      sharpSource.destroy();
      glowSource?.destroy();
    },
  };
};

/** One line of text as a single texture (labels, numerals, captions). */
export const createLabelTexture = (text, { font, size, dpr, letterSpacing = 0 }) => {
  const probe = makeCanvas(4, 4).getContext('2d');
  probe.font = font;
  const chars = Array.from(String(text));
  const widths = chars.map((char) => probe.measureText(char).width);
  const width = widths.reduce((sum, w) => sum + w, 0) + letterSpacing * Math.max(0, chars.length - 1);
  const pad = Math.ceil(size * 0.3);
  const canvas = makeCanvas((width + pad * 2) * dpr, (size * 1.5 + pad * 2) * dpr);
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.font = font;
  c.textBaseline = 'middle';
  c.fillStyle = '#ffffff';
  let x = pad;
  chars.forEach((char, i) => {
    c.fillText(char, x, pad + size * 0.75);
    x += widths[i] + letterSpacing;
  });
  return new PIXI.Texture({ source: sourceOf(canvas, dpr) });
};
