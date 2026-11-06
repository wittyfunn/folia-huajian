// The live ear: loudness normalized to the song (Folia's getPower has a narrow
// range, so absolute values say little) and onsets from low-end spectral flux.
// The plan already knows the song's shape; this only adds the moment-to-moment
// swell and the hits that a planned schedule cannot know.

import { clamp } from './motion.mjs';

const LOW_BIN_START = 1;   // ~21 Hz per bin at the host's FFT size
const LOW_BIN_END = 12;    // up to ~260 Hz: kick and bass
const TRACK_SEC = 1.2;     // how fast the onset threshold follows the music
const MIN_GAP_SEC = 0.22;  // fastest onset cadence
const FLOOR = 0.012;       // flux below this is never an onset

export const createEar = () => {
  let previousBins = null;
  let previousLow = 0;
  let mean = 0;
  let variance = 0;
  let lastOnset = -Infinity;
  let peak = 0.3;
  let valley = 0.2;
  let level = 0.5;
  const reading = { level: 0.5, onset: 0, bass: 0, treble: 0, active: false };

  const lowFlux = (audio) => {
    const spectrum = audio.getSpectrum?.();
    if (spectrum && spectrum.length > LOW_BIN_END) {
      const count = LOW_BIN_END - LOW_BIN_START + 1;
      if (!previousBins) previousBins = new Float32Array(count);
      let flux = 0;
      for (let i = 0; i < count; i += 1) {
        const value = spectrum[LOW_BIN_START + i] / 255;
        flux += Math.max(0, value - previousBins[i]);
        previousBins[i] = value;
      }
      return flux / count;
    }
    const bands = audio.getBands();
    const low = 0.7 * bands.bass + 0.3 * bands.lowMid;
    const flux = Math.max(0, low - previousLow);
    previousLow = low;
    return flux;
  };

  return {
    reset() {
      previousBins = null;
      previousLow = 0;
      mean = 0;
      variance = 0;
      lastOnset = -Infinity;
    },

    /** Reads the analyser at song time `time`, `dt` seconds after the previous reading. */
    step(audio, time, dt) {
      reading.onset = 0;
      if (!audio || dt <= 0) return reading;
      const bands = audio.getBands();
      const raw = 0.55 * audio.getPower() + 0.25 * bands.vocal + 0.2 * bands.bass;
      // Song-relative loudness: where `raw` sits between a slow peak and a slow valley.
      peak = Math.max(raw, peak - dt * 0.02, valley + 0.05);
      valley = Math.min(raw, valley + dt * 0.015);
      const target = clamp((raw - valley) / Math.max(0.05, peak - valley));
      level += (target - level) * (1 - Math.exp(-dt / (target > level ? 0.08 : 0.6)));
      reading.level = level;
      reading.bass = bands.bass;
      reading.treble = bands.treble;
      reading.active = raw > 0.01;

      const flux = lowFlux(audio);
      const alpha = 1 - Math.exp(-dt / TRACK_SEC);
      const deviation = Math.sqrt(Math.max(variance, 0));
      const threshold = Math.max(FLOOR, mean + 1.8 * deviation);
      if (flux > threshold && time - lastOnset >= MIN_GAP_SEC) {
        reading.onset = clamp((flux - threshold) / Math.max(1e-3, 3 * deviation + 0.01));
        lastOnset = time;
      }
      mean += alpha * (flux - mean);
      variance += alpha * ((flux - mean) ** 2 - variance);
      return reading;
    },

    /** A neutral reading for previews and hosts without audio. */
    idle() {
      reading.onset = 0;
      reading.level = 0.5;
      reading.active = false;
      return reading;
    },
  };
};
