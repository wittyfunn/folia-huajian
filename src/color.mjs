// Colors as { r, g, b } in 0..1. CSS strings are parsed by the browser's own
// canvas so any theme color (named, rgb(), hsl(), #rgb) works.

import { clamp, lerp } from './motion.mjs';

let probe = null;
const probeContext = () => {
  if (!probe) probe = document.createElement('canvas').getContext('2d');
  return probe;
};

export const parseColor = (css, fallback = '#ffffff') => {
  const context = probeContext();
  context.fillStyle = fallback;
  context.fillStyle = css || fallback;
  const value = String(context.fillStyle);
  if (value.startsWith('#')) {
    const n = parseInt(value.slice(1, 7), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255 };
};

const byte = (v) => Math.round(clamp(v) * 255);
export const toNumber = ({ r, g, b }) => (byte(r) << 16) | (byte(g) << 8) | byte(b);
export const toCss = ({ r, g, b }, alpha = 1) => `rgba(${byte(r)},${byte(g)},${byte(b)},${alpha})`;
export const mix = (a, b, t) => ({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
/** Perceived lightness, 0..1 (Rec. 709 weights on gamma-encoded values: good enough for contrast picks). */
export const luminance = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pulls a color toward its own grey by `amount` (0..1). */
export const desaturate = (color, amount) => {
  const grey = luminance(color);
  return mix(color, { r: grey, g: grey, b: grey }, amount);
};

export const WHITE = { r: 1, g: 1, b: 1 };
export const BLACK = { r: 0, g: 0, b: 0 };
