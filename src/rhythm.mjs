// Listens to the whole song while it plays and works out its tempo (BPM, with
// the beat grid's phase) and its key (tonic and major/minor). Everything comes
// from the host's public analyser (ctx.audio), so it works for local and online
// songs alike, with no download.
//
// Tempo: the spectral flux of each frame is laid on a 50 Hz grid indexed by
// song time (so seeking and replays add to the same record), then the grid is
// autocorrelated. The estimator follows bpm-style-director's (MIT, LingShiQwQ):
// detrend, compress, autocorrelate, and prefer a faster harmonic only when it
// is nearly as periodic.
// Key: the analyser's bins from ~500 Hz to ~4 kHz are folded into 12 pitch
// classes over the whole song and correlated with the Krumhansl–Kessler key
// profiles. Both are estimates; each comes with a confidence.

const GRID_HZ = 50;
const MAX_CELLS = GRID_HZ * 900;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const correlate = (a, b) => {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.max(1e-12, Math.sqrt(da * db));
};

/** The key a 12-bin chroma vector correlates best with. */
export const keyOf = (chroma) => {
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const rotated = Array.from({ length: 12 }, (_, pc) => chroma[(pc + tonic) % 12]);
    scores.push({ tonic, mode: 'major', r: correlate(rotated, MAJOR) });
    scores.push({ tonic, mode: 'minor', r: correlate(rotated, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const [best, second] = scores;
  // The relative key (C major / A minor) shares its notes: a close call between those two
  // still knows the key's notes, it is only the mode that is unsure.
  const relative = (best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12) === second.tonic && best.mode !== second.mode;
  // A flat chroma (noise, drums, no clear notes) still correlates with some key: confidence also
  // needs the pitch classes to stand apart (their coefficient of variation).
  const mean = chroma.reduce((s, v) => s + v, 0) / 12;
  const spread = Math.sqrt(chroma.reduce((s, v) => s + (v - mean) ** 2, 0) / 12) / Math.max(1e-9, mean);
  const tonal = Math.max(0, Math.min(1, (spread - 0.08) / 0.2));
  return {
    key: NAMES[best.tonic],
    mode: best.mode,
    keyConfidence: Math.max(0, Math.min(1, best.r * 1.2)) * tonal,
    modeConfidence: Math.max(0, Math.min(1, (relative ? best.r - second.r : best.r - scores.find((s) => s.mode !== best.mode).r) * 6)) * tonal,
  };
};

/**
 * Tempo from a novelty curve sampled at `rate` Hz (`mask` marks the cells that were heard).
 * Returns `{ bpm, confidence, phase, downbeat }` (phase and downbeat in seconds) or null.
 */
export const tempoOf = (novelty, mask, rate) => {
  const n = novelty.length;
  const heard = mask.reduce((s, v) => s + (v ? 1 : 0), 0);
  if (heard < rate * 12) return null;
  // Detrend against a ±0.35 s mean and compress big transients.
  const env = new Float64Array(n);
  const radius = Math.ceil(rate * 0.35);
  let window = 0;
  let count = 0;
  for (let i = 0; i < Math.min(n, radius); i += 1) {
    window += novelty[i];
    count += 1;
  }
  for (let i = 0; i < n; i += 1) {
    const add = i + radius;
    const drop = i - radius - 1;
    if (add < n) {
      window += novelty[add];
      count += 1;
    }
    if (drop >= 0) {
      window -= novelty[drop];
      count -= 1;
    }
    env[i] = mask[i] ? Math.sqrt(Math.max(0, novelty[i] - (0.7 * window) / count)) : 0;
  }
  let mean = 0;
  for (let i = 0; i < n; i += 1) if (mask[i]) mean += env[i];
  mean /= heard;
  for (let i = 0; i < n; i += 1) env[i] = mask[i] ? env[i] - mean : 0;
  // A light [1 2 1] blur: a period that is not a whole number of cells splits each pulse
  // between two cells, which otherwise makes twice the period correlate better.
  const raw = Float64Array.from(env);
  for (let i = 1; i < n - 1; i += 1) env[i] = mask[i] ? 0.25 * raw[i - 1] + 0.5 * raw[i] + 0.25 * raw[i + 1] : 0;

  const minLag = Math.floor((60 * rate) / 220);
  const maxLag = Math.ceil((60 * rate) / 45);
  const corr = new Float64Array(maxLag + 2);
  for (let lag = Math.max(2, minLag - 1); lag <= maxLag + 1; lag += 1) {
    let cross = 0;
    let a = 0;
    let b = 0;
    for (let i = lag; i < n; i += 1) {
      if (!mask[i] || !mask[i - lag]) continue;
      cross += env[i] * env[i - lag];
      a += env[i] * env[i];
      b += env[i - lag] * env[i - lag];
    }
    corr[lag] = cross / Math.max(1e-10, Math.sqrt(a * b));
  }
  const peaks = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (corr[lag] <= corr[lag - 1] || corr[lag] < corr[lag + 1] || corr[lag] < 0.1) continue;
    const a = corr[lag - 1];
    const b = corr[lag];
    const c = corr[lag + 1];
    const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / (a - 2 * b + c || 1)));
    const bpm = (60 * rate) / (lag + delta);
    if (bpm >= 45 && bpm <= 220) peaks.push({ bpm, lag: lag + delta, strength: b });
  }
  if (!peaks.length) return null;
  peaks.sort((x, y) => y.strength - x.strength);
  const strong = peaks.filter((p) => p.strength >= peaks[0].strength * 0.88 && p.bpm >= 65 && p.bpm <= 200);
  let best = strong.length ? strong.sort((x, y) => y.bpm - x.bpm)[0] : peaks[0];
  // Below 70 BPM, a well-supported double tempo is the beat people tap.
  if (best.bpm < 70) {
    const double = peaks.find((p) => Math.abs(p.bpm / 2 - best.bpm) / best.bpm < 0.04 && p.strength >= best.strength * 0.6);
    if (double) best = double;
  }
  const rival = peaks.find((p) => Math.abs(p.bpm - best.bpm) / best.bpm > 0.08
    && Math.abs(p.bpm * 2 - best.bpm) / best.bpm > 0.08 && Math.abs(p.bpm / 2 - best.bpm) / best.bpm > 0.08);
  const contrast = rival ? Math.max(0, best.strength - rival.strength) : best.strength;
  const confidence = Math.min(1, Math.max(0, best.strength * 0.8 + Math.min(0.2, contrast)));

  // Refine: the period within ±1.5 % whose beat comb lines up best with every accent heard
  // (the magnitude of the accents' Fourier component at that rate). Over a whole song this
  // pins the tempo far finer than one grid cell, and its angle gives the beat phase.
  const accents = [];
  for (let i = 0; i < n; i += 1) if (mask[i] && env[i] > 0) accents.push(i, env[i]);
  let period = best.lag;
  let phaseCells = 0;
  let bestPower = -1;
  for (let step = -50; step <= 50; step += 1) {
    const candidate = best.lag * (1 + step * 0.0003);
    let re = 0;
    let im = 0;
    for (let k = 0; k < accents.length; k += 2) {
      const angle = (2 * Math.PI * accents[k]) / candidate;
      re += accents[k + 1] * Math.cos(angle);
      im += accents[k + 1] * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      period = candidate;
      phaseCells = ((((Math.atan2(im, re) / (2 * Math.PI)) * candidate) % candidate) + candidate) % candidate;
    }
  }
  const bars = new Float64Array(4);
  // Downbeat: which beat of four carries the most weight.
  for (let i = 0; i < n; i += 1) {
    if (!mask[i] || env[i] <= 0) continue;
    const beat = Math.round((i - phaseCells) / period);
    if (Math.abs(i - phaseCells - beat * period) < period * 0.15) bars[((beat % 4) + 4) % 4] += env[i];
  }
  const downbeatIndex = bars.indexOf(Math.max(...bars));
  return {
    bpm: Math.round(((60 * rate) / period) * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    phase: phaseCells / rate,
    downbeat: (phaseCells + downbeatIndex * period) / rate,
    alternatives: peaks.slice(0, 4).map((p) => [Math.round(p.bpm * 10) / 10, Math.round(p.strength * 100) / 100]),
  };
};

let deviceRate = null;
const sampleRate = () => {
  if (deviceRate) return deviceRate;
  try {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    const context = new Context();
    deviceRate = context.sampleRate;
    context.close?.();
  } catch {
    deviceRate = 44100;
  }
  return deviceRate;
};

/**
 * One song's listener. `feed` on every played frame; `estimate` whenever a
 * reading is wanted; `snapshot` / `restore` keep what was learned across plays.
 */
export const createRhythm = ({ rate = null } = {}) => {
  let novelty = new Float32Array(GRID_HZ * 240);
  let mask = new Uint8Array(novelty.length);
  let previous = null;
  const chroma = new Float64Array(12);
  let chromaFrames = 0;
  let powerSum = 0;
  let powerFrames = 0;
  let pitchBins = null;
  let fluxEnd = 0;
  let linear = new Float64Array(0);
  const frame = new Float64Array(12);

  const grow = (cells) => {
    if (cells <= novelty.length || cells > MAX_CELLS) return cells <= novelty.length;
    const size = Math.min(MAX_CELLS, Math.max(cells, novelty.length * 2));
    const next = new Float32Array(size);
    next.set(novelty);
    novelty = next;
    const nextMask = new Uint8Array(size);
    nextMask.set(mask);
    mask = nextMask;
    return true;
  };

  /* For every note from C5 to B7 (~520 Hz–4 kHz; coarser bins below blur semitones), the one bin
   * nearest its pitch. One bin per note keeps the twelve pitch classes equally sampled, so noise
   * does not lean toward whichever classes own more bins. */
  const mapBins = (length) => {
    const binHz = (rate ?? sampleRate()) / 2 / length;
    pitchBins = [];
    for (let midi = 72; midi <= 107; midi += 1) {
      const bin = Math.round((440 * 2 ** ((midi - 69) / 12)) / binHz);
      if (bin >= 5 && bin < length - 5) pitchBins.push([bin, midi % 12]);
    }
    fluxEnd = Math.min(length, Math.round(5000 / binHz));
    linear = new Float64Array(length);
  };

  return {
    /** One frame at song time `time` (`dt` since the previous played frame; 0 or a jump breaks the line). */
    feed(time, spectrum, power, dt) {
      if (!spectrum || !(dt > 0) || dt > 0.25) {
        previous = null;
        return;
      }
      if (!pitchBins || previous && previous.length !== spectrum.length) mapBins(spectrum.length);
      if (!previous) {
        previous = Float32Array.from(spectrum);
        return;
      }
      // Positive flux of the log magnitudes (the bytes are already in dB), low end weighted up.
      let flux = 0;
      const lowEnd = Math.round(fluxEnd * 0.05);
      for (let i = 1; i < fluxEnd; i += 1) {
        const rise = spectrum[i] - previous[i];
        if (rise > 0) flux += rise * (i < lowEnd ? 1.5 : 1);
        previous[i] = spectrum[i];
      }
      // Per cell, the mean flux of the frames that fell in it: frames and cells do not line up
      // (60 frames a second on a 50 Hz grid), and summing would add a false rhythm of its own.
      const cell = Math.floor(time * GRID_HZ);
      if (cell >= 0 && grow(cell + 1)) {
        mask[cell] = Math.min(255, mask[cell] + 1);
        novelty[cell] += (flux / 255 - novelty[cell]) / mask[cell];
      }
      // Chroma from spectral peaks only: a note's bin counts by how far it stands above the bins
      // 2–4 away on either side (the next ones share its leakage).
      let total = 0;
      frame.fill(0);
      const first = pitchBins[0][0] - 4;
      const last = pitchBins[pitchBins.length - 1][0] + 4;
      for (let i = Math.max(0, first); i <= Math.min(spectrum.length - 1, last); i += 1) linear[i] = 10 ** (spectrum[i] * 0.02745); // 70 dB over 255 steps
      for (const [bin, pc] of pitchBins) {
        let around = 0;
        for (let k = 2; k <= 4; k += 1) around += linear[bin - k] + linear[bin + k];
        const peak = Math.max(linear[bin], linear[bin - 1] * 0.7, linear[bin + 1] * 0.7);
        const salience = Math.max(0, peak / (around / 6) - 1.3);
        frame[pc] += salience;
        total += salience;
      }
      if (total > 0.5 && power > 0.02) {
        for (let pc = 0; pc < 12; pc += 1) chroma[pc] += frame[pc] / total;
        chromaFrames += 1;
      }
      powerSum += power;
      powerFrames += 1;
    },

    /** Seconds of song heard so far (grid cells with data). */
    get heard() {
      return mask.reduce((s, v) => s + (v ? 1 : 0), 0) / GRID_HZ;
    },

    estimate() {
      const tempo = tempoOf(novelty, mask, GRID_HZ);
      const key = chromaFrames > GRID_HZ * 10 ? keyOf(Array.from(chroma)) : null;
      return {
        heard: Math.round(this.heard),
        bpm: tempo?.bpm ?? null,
        confidence: tempo?.confidence ?? 0,
        phase: tempo?.phase ?? null,
        downbeat: tempo?.downbeat ?? null,
        key: key?.key ?? null,
        mode: key?.mode ?? null,
        keyConfidence: key?.keyConfidence ?? 0,
        modeConfidence: key?.modeConfidence ?? 0,
        loudness: powerFrames ? Math.round((powerSum / powerFrames) * 100) / 100 : null,
      };
    },

    /** What is worth keeping across plays: the chroma totals (the tempo is re-learned each play). */
    snapshot() {
      return { chroma: Array.from(chroma, (v) => Math.round(v * 10) / 10), chromaFrames, powerSum: Math.round(powerSum * 10) / 10, powerFrames };
    },
    restore(saved) {
      if (!saved?.chroma || saved.chroma.length !== 12) return;
      saved.chroma.forEach((v, i) => {
        chroma[i] += v;
      });
      chromaFrames += saved.chromaFrames ?? 0;
      powerSum += saved.powerSum ?? 0;
      powerFrames += saved.powerFrames ?? 0;
    },
  };
};

/** The key as people say it: "C 大调", "A 小调". */
export const keyName = (features) => (features?.key ? `${features.key} ${features.mode === 'minor' ? '小调' : '大调'}` : '');
