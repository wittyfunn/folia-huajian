// The 花笺 stage: one PixiJS canvas, drawn on the host's frame loop only when
// the song clock moved (or something changed), with a frame-cost governor that
// thins particles before the picture ever stutters.
//
// Layers, back to front: a colour field (soft palette lights), the camera (particles behind, the
// shots, particles in front, all through one post pass), a vignette and grain.

import * as PIXI from './vendor/pixi.min.mjs';
import { buildPlan, fallbackSegment, paragraphAt } from './plan.mjs';
import { createParticles } from './particles.mjs';
import { createShots } from './shots.mjs';
import { createPost } from './post.mjs';
import { createEar } from './audio.mjs';
import { createRhythm, keyName } from './rhythm.mjs';
import { createGrainTexture, createParticleAtlas, createRadialTexture } from './textures.mjs';
import { WHITE, desaturate, mix, parseColor, toNumber } from './color.mjs';
import { clamp, damp } from './motion.mjs';
import { hash01, hashString } from './random.mjs';
import { STATUS_TEXT } from './director.mjs';

// Song-time math in shaders and long-lived sprites wants full precision.
PIXI.GlProgram.defaultOptions.preferredFragmentPrecision = 'highp';

const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Source Han Serif", "Songti SC", "STSong", "SimSun", serif';
const SANS = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';
const SEEK_JUMP_SEC = 0.6;

const numberSetting = (values, key, fallback) => (Number.isFinite(Number(values[key])) ? Number(values[key]) : fallback);

/*
 * Destroys one mount's PixiJS app WITHOUT releasing PixiJS's global resources. `app.destroy(true)`
 * would also empty the global batch pool that every mount shares, destroying batches the other
 * mounts are still drawing with (Folia keeps two mounts alive across a song change, plus the
 * mode picker's preview): their next rebuild then fails ("reading 'clear'", "reading 'geometry'"),
 * and every frame after it fails on the half-reset update queue ("reading 'renderPipeId'").
 */
const destroyApp = (app) => {
  app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true, texture: true });
};

export const mountStage = ({ folium, container, ctx, director }) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
  container.appendChild(host);
  let disposed = false;
  let cleanup = () => {};

  const start = async () => {
    const app = new PIXI.Application();
    await app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      backgroundAlpha: 0,
      antialias: false,
      preference: 'webgl',
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
      // Only the dev harness keeps the buffer, so screenshots of a still frame are not blank.
      preserveDrawingBuffer: Boolean(globalThis.__HUAJIAN_DEBUG__),
      ...(globalThis.__HUAJIAN_GC_TEST__ ? { gcMaxUnusedTime: 300, gcFrequency: 150 } : {}),
    });
    if (disposed) {
      destroyApp(app);
      return;
    }
    app.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    host.appendChild(app.canvas);

    // ------------------------------------------------------------ state

    let W = Math.max(1, host.clientWidth);
    let H = Math.max(1, host.clientHeight);
    const settings = () => ctx.getSettings();
    const quality = () => String(settings().quality ?? 'auto');
    const live = !ctx.isPreview && !ctx.staticMode && folium.env?.context === 'main';
    const handle = director.attach({ song: ctx.song, lines: ctx.lines, theme: ctx.getTheme(), duration: ctx.getDuration(), live });
    const seed = hashString(ctx.seed ?? `${ctx.song?.title ?? ''}|${ctx.song?.artist ?? ''}`);
    const segment = (line) => {
      try {
        if (typeof folium.lyrics?.segmentWords === 'function') return folium.lyrics.segmentWords(line);
      } catch {
        // The host's segmenter is optional; Intl.Segmenter is close enough.
      }
      return fallbackSegment(line);
    };

    /*
     * Folia's own keyword colours for a line: the theme's wordColors, matched by the host the way its
     * builtin modes match them. Null when the theme has none (the mod's keyword and accent apply).
     */
    const wordColors = (line) => {
      const list = ctx.getTheme().wordColors;
      if (!Array.isArray(list) || !list.length || typeof folium.lyrics?.buildWordColorRanges !== 'function') return null;
      try {
        return folium.lyrics.buildWordColorRanges(String(line?.fullText ?? ''), list)
          .map((range) => ({ start: range.startOffset, end: range.endOffset, color: toNumber(parseColor(range.color)) }));
      } catch {
        return null;
      }
    };

    let plan = null;
    const atlas = createParticleAtlas();
    const particles = createParticles(atlas);
    const ear = createEar();
    // Tempo and key of the whole song, learned while it plays (and remembered across plays).
    const rhythm = createRhythm();
    let grid = null; // { period, phase, downbeat } in song seconds, once the tempo is trusted
    const useGrid = (features) => {
      grid = features?.bpm && features.confidence >= 0.45 && Number.isFinite(features.phase)
        ? { period: 60 / features.bpm, phase: features.phase, downbeat: features.downbeat ?? features.phase }
        : grid;
    };
    if (live) {
      handle.loadAudio().then((record) => {
        if (disposed || !record) return;
        rhythm.restore(record.s);
        useGrid(record.f);
      });
    }
    let estimating = false;
    let lastEstimate = 0;
    /* Estimates in idle time (a whole song's record takes a few to ~20 ms), every 5 s while playing. */
    const estimateSoon = () => {
      if (estimating || performance.now() - lastEstimate < 5000) return;
      estimating = true;
      const run = () => {
        estimating = false;
        lastEstimate = performance.now();
        if (disposed) return;
        const features = rhythm.estimate();
        useGrid(features);
        handle.setAudio(features, rhythm.snapshot());
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
      else setTimeout(run, 0);
    };
    /* A beat of the grid between the last frame and this one: 1 on a downbeat, 0.65 on the others. */
    const gridBeat = (from, to) => {
      if (!grid || !(to > from) || to - from > 0.25) return 0;
      const k = Math.floor((to - grid.phase) / grid.period);
      if (k <= Math.floor((from - grid.phase) / grid.period)) return 0;
      const bar = Math.round((grid.phase + k * grid.period - grid.downbeat) / grid.period);
      return ((bar % 4) + 4) % 4 === 0 ? 1 : 0.65;
    };

    // ------------------------------------------------------------ layers

    const washTexture = createRadialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    const vignetteTexture = createRadialTexture('rgba(0,0,0,0)', 'rgba(0,0,0,1)');
    const grainTexture = createGrainTexture();
    // The colour field: three soft lights in the song's palette, wandering slowly.
    const field = [0, 1, 2].map(() => {
      const light = new PIXI.Sprite(washTexture);
      light.anchor.set(0.5);
      return light;
    });
    const camera = new PIXI.Container();
    const textLayer = new PIXI.Container();
    // The wipe band passes over everything.
    const overlayLayer = new PIXI.Container();
    camera.addChild(particles.back, textLayer, particles.front, overlayLayer);
    const post = createPost();
    camera.filters = [post.filter];
    const vignette = new PIXI.Sprite(vignetteTexture);
    vignette.anchor.set(0.5);
    const grain = new PIXI.TilingSprite({ texture: grainTexture, width: W, height: H });
    app.stage.addChild(...field, camera, vignette, grain);

    // ------------------------------------------------------------ look: fonts, colors, metrics

    const fonts = () => {
      const face = String(settings().typeface ?? 'theme');
      const theme = ctx.getTheme();
      if (face === 'serif') return { family: SERIF, weight: 500, display: SERIF };
      if (face === 'sans') return { family: SANS, weight: 500, display: SERIF };
      const family = typeof folium.theme?.resolveFontStack === 'function' ? folium.theme.resolveFontStack(theme) : SANS;
      const weight = typeof folium.theme?.resolveFontWeight === 'function' ? folium.theme.resolveFontWeight(theme, 500) : 500;
      return { family, weight, display: SERIF };
    };

    let colors = null;
    const computeColors = () => {
      const theme = ctx.getTheme();
      const daylight = Boolean(theme.isDaylight);
      const ink = parseColor(theme.primaryColor, daylight ? '#1b1b1f' : '#f4f1ea');
      const accent = parseColor(theme.accentColor, daylight ? '#8a5a2b' : '#e8c48a');
      const palette = (plan?.palette ?? ['#ffffff']).map((css) => {
        const c = parseColor(css);
        return daylight ? mix(desaturate(c, 0.2), ink, 0.55) : mix(c, accent, 0.22);
      });
      const warm = daylight ? mix(parseColor('#c77a2c'), ink, 0.25) : mix(parseColor('#ffbd6e'), palette[0], 0.2);
      colors = {
        daylight,
        ink: toNumber(ink),
        inkColor: ink,
        accent,
        accentNumber: toNumber(accent),
        glow: toNumber(daylight ? mix(accent, ink, 0.3) : mix(accent, WHITE, 0.25)),
        palette,
        particle: (k) => toNumber(palette[k % palette.length]),
        warm: toNumber(warm),
        hot: toNumber(daylight ? mix(parseColor('#a84f12'), ink, 0.2) : parseColor('#fff2da')),
      };
      particles.setColors({
        palette: palette.map(toNumber),
        warmTint: colors.warm,
        hotTint: colors.hot,
        rain: toNumber(daylight ? mix(parseColor('#5d6f86'), ink, 0.3) : mix(parseColor('#c4d3e6'), ink, 0.15)),
      });
      particles.setDaylight(daylight);
      const surface = ctx.getSurface?.() ?? { transparent: false };
      field.forEach((light, i) => {
        light.visible = !surface.transparent;
        light.tint = toNumber(daylight ? mix(palette[i % palette.length], WHITE, 0.5) : palette[i % palette.length]);
      });
      vignette.visible = !surface.transparent;
      vignette.tint = daylight ? toNumber(mix(ink, WHITE, 0.6)) : 0x000000;
    };

    const metrics = () => {
      const u = Math.min(W, H);
      const scale = numberSetting(settings(), 'fontScale', 1) * (ctx.getDisplay?.().lyricsFontScale ?? 1);
      return { W, H, u, fs: clamp(u * 0.066, 18, 124) * scale, dpr: app.renderer.resolution };
    };

    const scenes = createShots({
      layers: { text: textLayer, overlay: overlayLayer },
      radial: washTexture,
      // Upload a texture now (in the frame that built it) rather than in the frame that first draws it.
      upload: (source) => {
        try {
          app.renderer.texture.initSource(source);
        } catch {
          // Not fatal: the texture uploads on first draw instead.
        }
      },
      particles,
      metrics,
      fonts,
      colors: () => colors,
      settings: () => ({ ornaments: settings().ornaments !== false, motion: numberSetting(settings(), 'motion', 1) * intensityOf() }),
      onError: (error) => onFrameError?.(error),
      segment,
      wordColors,
    });

    const intensityOf = () => ({ calm: 0.8, chaotic: 1.2 }[ctx.getTheme().animationIntensity] ?? 1);

    const applyPlan = () => {
      note(`plan ${handle.entry?.status ?? ''}`);
      plan = buildPlan({ analysis: handle.analysis, direction: handle.direction, seed, segment, song: ctx.song, tempo: handle.entry?.audio ?? null });
      scenes.setPlan(plan, handle.analysis, ctx.song, lastTime ?? (ctx.staticMode ? Infinity : ctx.lyricTime.get()));
      particles.setPlan(plan);
      computeColors();
      dirty = true;
    };

    // ------------------------------------------------------------ geometry

    const layout = () => {
      note(`layout ${host.clientWidth}x${host.clientHeight}`);
      W = Math.max(1, host.clientWidth);
      H = Math.max(1, host.clientHeight);
      app.renderer.resize(W, H);
      vignette.position.set(W / 2, H / 2);
      vignette.width = Math.hypot(W, H) * 1.05;
      vignette.height = Math.hypot(W, H) * 1.05 * (H / W) * 1.15;
      grain.width = W;
      grain.height = H;
      camera.pivot.set(W / 2, H / 2);
      camera.filterArea = new PIXI.Rectangle(0, 0, W, H);
      scenes.rebuild();
      dirty = true;
    };

    // ------------------------------------------------------------ frame loop

    let dirty = true;
    let lastTime = null;
    let lastWall = null;
    let energy = 0.4;
    let punch = 0;
    let pulse = 0;
    let rgbKick = 0;
    const hits = []; // recent strong onsets (song time, strength) for the camera shake
    let lastLiveShell = -Infinity;
    let currentShot = null;
    let autoBudget = 1;
    let cost = 2;
    let peak = 0;
    let rendered = 0;
    let frameCount = 0;
    let particleCount = 0;
    let current = null;

    const staticTime = () => {
      const line = ctx.lines[ctx.staticLineIndex ?? -1] ?? ctx.lines.find((l) => l.fullText?.trim());
      if (!line) return 1;
      return line.startTime + (line.endTime - line.startTime) * 0.62;
    };

    const ambientTargets = (paragraph, level) => {
      const density = numberSetting(settings(), 'particles', 1);
      const name = paragraph?.weather ?? plan.weather;
      const e = paragraph?.energy ?? plan.mood.energy * 0.8;
      const quiet = paragraph?.accent === 'sparkler' ? 0.75 : 1;
      const amount = clamp((0.42 + 0.45 * e) * (0.85 + 0.3 * level) * quiet * Math.min(1.2, density + 0.1));
      return name && name !== 'none' ? { [name]: amount } : {};
    };

    /*
     * The host's lyric clock follows the audio element, which advances in uneven steps. Animating
     * straight off it makes motion judder even at a steady frame rate. This clock advances by the
     * wall time of each frame and leans gently (≈0.2 s) toward the host's time; a jump of more than
     * 0.3 s (a seek) is taken at once, and if the host time stops moving (buffering) it holds.
     */
    let clock = null;
    let hostLast = null;
    let hostStill = 0;
    const smoothClock = (host, wallDt, paused) => {
      if (host !== hostLast) hostStill = 0;
      else hostStill += wallDt;
      hostLast = host;
      if (clock === null || paused || wallDt <= 0 || wallDt > 0.25) {
        clock = host;
        return clock;
      }
      // Where the song really is: the host's last value plus the time since it last changed
      // (a stepped clock is exact at the moment it steps). Past 0.35 s without a step the host
      // has stalled (buffering): hold.
      if (hostStill > 0.35) return clock;
      const estimate = host + hostStill;
      const predicted = clock + wallDt;
      const error = estimate - predicted;
      if (Math.abs(error) > 0.3) {
        clock = estimate;
        return clock;
      }
      // Lean toward the estimate over ~0.4 s; never backwards.
      clock = Math.max(clock, predicted + error * Math.min(1, wallDt / 0.4));
      return clock;
    };

    // ------------------------------------------------------------ diagnostics
    // A short trail of what happened, and the first errors of each mount with their stacks, kept in
    // the mod's data file ("diag") so a failure seen in Folia can be read back exactly.
    const trail = [];
    const note = (what) => {
      trail.push(`${(lastTime ?? 0).toFixed(2)} ${what}`);
      if (trail.length > 30) trail.shift();
    };
    let errorsThisMount = 0;
    const onFrameError = (error) => {
      errorsThisMount += 1;
      const message = String(error?.message ?? error);
      if (errorsThisMount <= 3) {
        const record = {
          at: new Date().toISOString(),
          message,
          stack: String(error?.stack ?? '').slice(0, 2400),
          song: ctx.song?.title ?? '',
          t: lastTime,
          dpr: app.renderer.resolution,
          size: [W, H],
          scene: scenes.debugState?.(),
          trail: [...trail],
        };
        folium.log.error('花笺渲染出错（已自动恢复）', { message, first: record.stack.split('\n').slice(0, 3).join(' | ') });
        Promise.resolve(folium.storage.get('diag')).then((old) => {
          const list = Array.isArray(old) ? old : [];
          list.push(record);
          return folium.storage.set('diag', list.slice(-8));
        }).catch(() => {});
      }
      // An exception inside a render leaves PixiJS's queue of pending updates half processed;
      // left alone, every later frame fails on it. Force a clean rebuild of the instructions.
      const group = app.stage.renderGroup;
      if (group) {
        group.structureDidChange = true;
        if (group.childrenRenderablesToUpdate) {
          group.childrenRenderablesToUpdate.list.length = 0;
          group.childrenRenderablesToUpdate.index = 0;
        }
      }
      dirty = true;
    };

    const frame = () => {
      try {
        renderFrame();
      } catch (error) {
        onFrameError(error);
      }
    };

    const renderFrame = () => {
      if (disposed || !plan) return;
      if (quality() === 'eco' && (frameCount++ & 1)) return;
      const wall = performance.now();
      const wallDt = lastWall === null ? 0 : (wall - lastWall) / 1000;
      const t = ctx.staticMode ? staticTime() : smoothClock(ctx.lyricTime.get(), wallDt, ctx.isPaused());
      const songDt = lastTime === null ? 0 : t - lastTime;
      const seeked = lastTime !== null && (songDt < -0.05 || Math.abs(songDt - wallDt) > SEEK_JUMP_SEC);
      lastTime = t;
      lastWall = wall;
      if (seeked) {
        note(`seek to ${t.toFixed(2)}`);
        particles.onSeek(t);
        scenes.onSeek();
        ear.reset();
      }
      const dt = seeked ? 0 : clamp(songDt, 0, 0.1);
      // Nothing moves while the clock stands still, unless something changed or the user seeked (paused or not).
      if (dt === 0 && !dirty && !seeked) return;

      const begin = performance.now();
      const playing = live && dt > 0 && !ctx.isPaused();
      const reading = playing ? ear.step(ctx.audio, t, dt) : ear.idle();
      if (playing) {
        rhythm.feed(t, ctx.audio.getSpectrum?.() ?? null, ctx.audio.getPower(), dt);
        estimateSoon();
      }
      const paragraph = paragraphAt(plan, t, 1.5) ?? (plan.paragraphs.length === 0 ? { weather: plan.weather, energy: plan.mood.energy, burst: 0.5, accent: plan.mood.valence > 0.6 && plan.mood.energy > 0.6 ? 'fireworks' : null } : null);
      current = paragraph;
      const motion = numberSetting(settings(), 'motion', 1) * intensityOf();
      energy = damp(energy, paragraph?.energy ?? plan.mood.energy * 0.8, 1.5, dt);

      // Live hits: on the beat grid once the tempo is known (steady, and on the beat people feel),
      // otherwise on raw onsets. Silence plays no beats. Shells in fireworks paragraphs, a push of
      // the camera in loud ones.
      const beat = grid && reading.active ? gridBeat(t - dt, t) * (0.6 + 0.6 * reading.level) : 0;
      const onset = (grid ? beat : reading.onset) * motion;
      const shellCue = grid ? beat >= 0.6 * motion && gridBeat(t - dt, t) === 1 : onset > 0.35;
      if (onset > 0 && paragraph?.accent === 'fireworks' && shellCue && t - lastLiveShell > Math.max(0.45, 1.6 - paragraph.burst)) {
        lastLiveShell = t;
        const r = (slot) => hash01(Math.floor(t * 20), slot, seed);
        particles.addLiveShell({ t0: t, x: 0.15 + 0.7 * r(1), y: 0.12 + 0.3 * r(2), type: r(3) < 0.6 ? 'spark' : 'peony', color: Math.floor(r(4) * 8), scale: 0.5 + 0.3 * onset, rise: false, seed: Math.floor(r(5) * 1e9) });
      }
      // How hard a beat lands depends on the passage: a ballad verse only breathes, a loud chorus punches.
      const temperament = paragraph?.temperament ?? 'lyrical';
      // A sad song does not move to the beat at all.
      const beatGain = plan.calm ? 0 : ({ gentle: 0, lyrical: 0.35, dramatic: 0.8, punchy: 1 }[temperament] ?? 0.35);
      if (onset > 0.3 && beatGain > 0) {
        pulse = Math.max(pulse, onset * beatGain);
        punch = Math.max(punch, 0.018 * onset * beatGain);
        if (beatGain >= 0.8) {
          rgbKick = Math.max(rgbKick, 0.006 * onset * beatGain);
          if (onset > 0.55) hits.push([t, onset * beatGain]);
        }
      }
      while (hits.length && t - hits[0][0] > 0.5) hits.shift();
      punch = damp(punch, 0, 0.2, dt);
      pulse = damp(pulse, 0, 0.18, dt);
      rgbKick = damp(rgbKick, 0, 0.12, dt);

      particles.setAmbient(ambientTargets(paragraph, reading.level));
      const showText = ctx.getDisplay?.().showText !== false;
      if (textLayer.visible !== showText) note(`text ${showText ? 'shown' : 'hidden'}`);
      textLayer.visible = showText;
      const effects = scenes.update(t, { level: reading.level, motion, pulse });
      currentShot = scenes.current(t);

      // The camera breathes with the music and drifts slowly; strong hits shake it (damped, ~0.4 s).
      let shakeX = 0;
      let shakeY = 0;
      hits.forEach(([at, strength], i) => {
        const age = t - at;
        const amount = strength * Math.exp(-age / 0.085) * Math.min(W, H) * 0.006 * motion;
        shakeX += amount * Math.sin(age * 96 + i * 1.7);
        shakeY += amount * 0.8 * Math.sin(age * 77 + i * 2.3 + 1);
      });
      const breathe = 0.008 * Math.sin(t * 0.55) * energy * motion;
      camera.position.set(W / 2 + Math.sin(t * 0.05 + (seed % 7)) * W * 0.008 * motion + shakeX, H / 2 + Math.cos(t * 0.043 + (seed % 5)) * H * 0.008 * motion + shakeY);
      camera.scale.set(1 + breathe + punch);
      post.set({
        rgb: (effects.rgb + rgbKick) * motion,
        flash: effects.flash,
        distort: effects.distort * motion,
        flashColor: colors.daylight ? [colors.accent.r, colors.accent.g, colors.accent.b] : [1, 0.97, 0.92],
      });
      // A pure function of song time, so a seek or an export shows the same light.
      const fieldAlpha = (colors.daylight ? 0.07 : 0.085) + 0.07 * energy + 0.04 * reading.level;
      field.forEach((light, i) => {
        const phase = (seed % 11) + i * 2.1;
        light.position.set(W * (0.5 + 0.34 * Math.sin(t * 0.021 + phase)), H * (0.48 + 0.26 * Math.cos(t * 0.017 + phase * 1.3)));
        light.width = W * (0.9 + 0.1 * i);
        light.height = H * (1.05 + 0.1 * i);
        light.alpha = fieldAlpha * (i === 0 ? 1 : 0.75);
      });
      vignette.alpha = colors.daylight ? 0.14 : 0.5;
      const grainOn = settings().grain !== false && autoBudget > 0.45;
      grain.visible = grainOn;
      if (grainOn) {
        const tick = Math.floor(t * 24);
        grain.alpha = colors.daylight ? 0.03 : 0.045;
        grain.tilePosition.set(hash01(tick, 1) * 160, hash01(tick, 2) * 160);
      }

      particleCount = particles.update(t, dt, { width: W, height: H, live: { onset, boost: onset * (paragraph?.burst ?? 0) }, snap: ctx.staticMode || seeked || dt === 0 });
      app.render();
      dirty = false;

      // Governor: the cost of this frame's work (JS + draw submission), averaged.
      // A frame that built a scene (atlases, sprites) is a one-off: capped so it cannot swing the average.
      const spent = performance.now() - begin;
      cost = cost * 0.94 + Math.min(spent, cost * 3 + 2) * 0.06;
      // The worst single frame of the last few seconds: what a stutter would show up as.
      peak = Math.max(spent, peak * Math.exp(-wallDt / 3));
      if (globalThis.__HUAJIAN_DEBUG__) {
        const frames = (globalThis.__huajianFrames ??= []);
        frames.push(+spent.toFixed(2));
        const steps = (globalThis.__huajianSteps ??= []);
        steps.push([+(songDt * 1000).toFixed(1), +(wallDt * 1000).toFixed(1)]);
        if (steps.length > 4000) steps.shift();
        if (spent > 6) (globalThis.__huajianSlow ??= []).push({ ms: +spent.toFixed(1), t: +t.toFixed(2), post: post.filter.enabled, particles: particleCount, built: (globalThis.__huajianBuilds ?? []).filter((b) => Math.abs(b[2] - t) < 0.01).map((b) => b[0]) });
        if (frames.length > 4000) frames.shift();
      }
      rendered += 1;
      if (rendered % 60 === 0 && quality() !== 'high') {
        if (cost > 7 && autoBudget > 0.35) autoBudget *= 0.8;
        else if (cost < 3 && autoBudget < 1) autoBudget = Math.min(1, autoBudget * 1.1);
      }
      const density = numberSetting(settings(), 'particles', 1);
      const qualityScale = quality() === 'eco' ? 0.6 : quality() === 'high' ? 1.25 : 1;
      particles.setBudget(density * qualityScale * autoBudget);
    };

    // ------------------------------------------------------------ director overlay (optional)

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;left:14px;bottom:12px;font:11px/1.5 system-ui,sans-serif;color:rgba(255,255,255,.6);text-shadow:0 1px 2px rgba(0,0,0,.6);white-space:pre;';
    host.appendChild(overlay);
    const SCENE_NAMES = { center: '居中', whisper: '低语', stanza: '诗稿', vertical: '竖排', hero: '巨字', collage: '拼贴' };
    const audioLine = (f) => {
      if (!f?.heard) return '节奏与调性：还在听';
      const bpm = f.bpm ? `${Math.round(f.bpm)} BPM（${f.confidence >= 0.45 ? '已对拍' : '不确定'}）` : '节奏还没听出来';
      const key = f.key && f.keyConfidence >= 0.4 ? ` · ${keyName(f)}` : '';
      return `${bpm}${key} · 已听 ${f.heard} 秒`;
    };
    const TEMPERAMENT_NAMES = { gentle: '静', lyrical: '抒', dramatic: '烈', punchy: '燃' };
    const WEATHER_NAMES = { none: '无', dust: '浮尘', rain: '雨丝', snow: '飘雪', petals: '落花', fireflies: '萤火', embers: '余烬', stars: '星空', sparkler: '线香花火', fireworks: '烟花' };
    const updateOverlay = () => {
      const on = settings().showDirector === true && !ctx.isPreview;
      overlay.style.display = on ? 'block' : 'none';
      if (!on || !plan) return;
      const entry = handle.entry;
      const d = handle.direction;
      const p = current;
      const scene = p?.scene ? SCENE_NAMES[p.scene] : '—';
      const weather = WEATHER_NAMES[p?.weather ?? plan.weather] ?? '';
      const accent = p?.accent ? ` + ${WEATHER_NAMES[p.accent]}` : '';
      const shot = currentShot;
      const recipe = shot ? `${TEMPERAMENT_NAMES[shot.temperament] ?? ''} · ${shot.layout} · 进 ${shot.enter} · 唱 ${shot.sing} · 退 ${shot.exit} · 镜 ${shot.camera} · 转 ${shot.transIn}` : '';
      overlay.textContent = [
        `花笺 · ${STATUS_TEXT[entry.status] ?? entry.status}${d.summary ? ` · ${d.summary}` : ''}`,
        audioLine(entry.audio),
        `明暗 ${d.valence.toFixed(2)}  能量 ${d.energy.toFixed(2)}  冷暖 ${d.warmth.toFixed(2)}  ·  ${scene} / ${weather}${accent}`,
        recipe,
        `平均 ${cost.toFixed(1)} ms · 峰值 ${peak.toFixed(1)} ms · ${particleCount} 粒子 · 预算 ${(autoBudget * 100).toFixed(0)}%`,
      ].join('\n');
    };

    // ------------------------------------------------------------ wiring

    applyPlan();
    layout();
    // Compile the post pass now, while the song is changing anyway: a shader compiled at the first
    // transition would stall that frame.
    post.set({ rgb: 0.001 });
    app.render();
    post.set({});
    // The dev harness sets this flag to inspect the stage; Folia never does.
    if (globalThis.__HUAJIAN_DEBUG__) globalThis.__huajian = { app, camera, post, particles, shots: scenes, PIXI, rhythm, handle };

    const offUpdate = handle.onUpdate(() => applyPlan());
    let lookKey = '';
    const keyOfLook = () => {
      const theme = ctx.getTheme();
      const font = fonts();
      return [font.family, font.weight, theme.primaryColor, theme.accentColor, theme.isDaylight, JSON.stringify(theme.wordColors ?? null), settings().fontScale, settings().typeface, settings().ornaments, ctx.getDisplay?.().lyricsFontScale].join('|');
    };
    lookKey = keyOfLook();
    const offChange = ctx.onChange(() => {
      handle.updateTheme(ctx.getTheme());
      const next = keyOfLook();
      if (next !== lookKey) {
        lookKey = next;
        computeColors();
        note('rebuild');
        scenes.rebuild();
      }
      dirty = true;
    });
    const offResize = ctx.onResize(() => {
      if (host.clientWidth !== W || host.clientHeight !== H) layout();
    });
    const offFrame = ctx.onFrame(frame);
    const offOverlay = ctx.every(500, updateOverlay);
    // Fonts may still be loading on the first frame; redraw the glyphs once they are in.
    document.fonts?.ready?.then(() => {
      if (!disposed) {
        note('rebuild');
        scenes.rebuild();
        dirty = true;
      }
    });

    cleanup = () => {
      offUpdate();
      offChange();
      offResize();
      offFrame();
      offOverlay();
      handle.detach();
      scenes.destroy();
      particles.destroy();
      post.destroy();
      atlas.destroy();
      washTexture.destroy(true);
      vignetteTexture.destroy(true);
      grainTexture.destroy(true);
      destroyApp(app);
    };
  };

  start().catch((error) => {
    folium.log.error('花笺启动失败', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) });
  });

  return () => {
    disposed = true;
    cleanup();
    host.remove();
  };
};
