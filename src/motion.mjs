// Easing and small numeric helpers. Motion in 花笺 is a function of song time:
// these turn "seconds since something began" into eased progress.

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/** Progress of `t` through `[start, start + duration]`, 0..1. */
export const progress = (t, start, duration) => clamp((t - start) / Math.max(1e-6, duration));

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInCubic = (t) => t * t * t;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeOutQuint = (t) => 1 - (1 - t) ** 5;
export const easeOutBack = (t, overshoot = 1.5) => 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
/** 0 → 1 → 0 over t in 0..1, a soft hump. */
export const bump = (t) => (t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t));

/** Moves `current` toward `target` with time constant `tau` seconds, independent of frame rate. */
export const damp = (current, target, tau, dt) => (tau <= 0 ? target : target + (current - target) * Math.exp(-Math.max(0, dt) / tau));

/** Positive modulo, for wrapping particle fields. */
export const wrap = (value, size) => ((value % size) + size) % size;
