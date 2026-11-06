// Test songs for the harness. The lyrics are written for this project (no real
// songs), shaped like real ones: credits at the top, verses, a repeated chorus
// only partly tagged by the "source", a long instrumental break, an outro.

const build = ({ id, title, artist, duration, bpm, lines, tagged = [], theme, ai }) => {
  const rows = lines.map(([start, text], i) => {
    const next = lines[i + 1]?.[0] ?? duration;
    const end = Math.min(next - 0.35, start + Math.max(1.6, Array.from(text).length * 0.32 + 0.8));
    const tokens = /[⺀-鿿]/u.test(text)
      ? Array.from(text).map((char) => char)
      : text.split(/(?<=\s)/);
    const visible = tokens.filter((tok) => tok.trim()).length || 1;
    let cursor = start;
    const step = (end - start) / visible;
    const words = [];
    for (const token of tokens) {
      if (!token.trim()) {
        if (words.length) words[words.length - 1].text += token;
        continue;
      }
      words.push({ text: token, startTime: cursor, endTime: cursor + step * 0.92 });
      cursor += step;
    }
    return {
      fullText: text,
      words,
      startTime: start,
      endTime: end,
      isChorus: tagged.includes(i),
      renderHints: { rawDuration: end - start, timingClass: 'normal', renderEndTime: end + 0.6, lineTransitionMode: 'normal', wordRevealMode: 'normal' },
    };
  });
  return { song: { id, title, artist, album: '花笺测试集', source: 'fixture', ref: null }, duration, bpm, lines: rows, theme, ai };
};

export const SONGS = {
  ballad: build({
    id: 'ballad',
    title: '雨停以后',
    artist: '花笺测试',
    duration: 140,
    bpm: 70,
    theme: { name: '雨夜思念', description: '雨夜里的思念与告别，安静克制', backgroundColor: '#0d1016', primaryColor: '#f1ede4', accentColor: '#d9b77e', secondaryColor: '#9aa3b2', fontStyle: 'sans', animationIntensity: 'normal', isDaylight: false },
    tagged: [12, 13],
    lines: [
      [0.5, '作词：花笺测试'],
      [1.2, '作曲：花笺测试'],
      [14.0, '窗外的雨还在下'],
      [18.2, '像那年你走的晚上'],
      [22.6, '我把伞留在门口'],
      [27.0, '却再也等不到回响'],
      [33.0, '街灯一盏一盏地亮'],
      [37.2, '照着空空的长巷'],
      [41.6, '我学着一个人走路'],
      [46.0, '学着不去想'],
      [52.0, '雨停以后 你会不会回来'],
      [57.0, '把没说完的话 说成明天'],
      [62.2, '雨停以后 我会不会明白'],
      [67.2, '有些人 只能放在从前'],
      [82.0, '旧照片里的光'],
      [86.0, '还停在你的肩上'],
      [90.4, '我轻轻擦去灰尘'],
      [94.6, '擦不掉那年夏天'],
      [101.0, '雨停以后 你会不会回来'],
      [106.0, '把没说完的话 说成明天'],
      [111.2, '雨停以后 我会不会明白'],
      [116.2, '有些人 只能放在从前'],
      [124.0, '雨停了'],
      [128.0, '天亮了'],
      [132.0, '你不在了'],
    ],
    ai: {
      summary: '雨夜里等一个不会回来的人',
      valence: 0.18, energy: 0.34, warmth: 0.32,
      palette: ['#dbe4ee', '#9fb3c8', '#e6c79a'],
      weather: 'rain', seal: '念',
      byKind: {
        intro: { scene: 'vertical', motion: 'gentle', weather: 'rain', energy: 0.22, burst: 0 },
        verse: { scene: 'stanza', motion: 'gentle', weather: 'rain', energy: 0.3, burst: 0 },
        chorus: { scene: 'hero', motion: 'dramatic', weather: 'sparkler', energy: 0.62, burst: 0.65 },
        breath: { scene: 'whisper', motion: 'gentle', weather: 'stars', energy: 0.15, burst: 0 },
        outro: { scene: 'whisper', motion: 'gentle', weather: 'stars', energy: 0.15, burst: 0 },
      },
    },
  }),

  anthem: build({
    id: 'anthem',
    title: '向光奔跑',
    artist: '花笺测试',
    duration: 92,
    bpm: 128,
    theme: { name: '盛夏', description: '热烈奔放的夏日', backgroundColor: '#140d12', primaryColor: '#fff8ec', accentColor: '#ffb35c', secondaryColor: '#c9b7a8', fontStyle: 'sans', animationIntensity: 'chaotic', isDaylight: false },
    tagged: [7, 8],
    lines: [
      [0.4, '作词：花笺测试'],
      [8.0, '推开窗 风在叫我的名字'],
      [11.6, '鞋带系紧 就别再犹豫'],
      [15.2, '街角的光 一路追着影子'],
      [18.8, '心跳比鼓点还要急'],
      [22.6, '再快一点！再高一点！'],
      [26.2, '把昨天远远甩在身后！'],
      [30.0, '向光奔跑 我们一起燃烧'],
      [33.8, '烟花在头顶 为我们闪耀'],
      [37.6, '向光奔跑 谁也不能阻挠'],
      [41.4, '这一秒 就是最好'],
      [47.0, '汗水落在 滚烫的跑道'],
      [50.6, '笑声比阳光还要骄傲'],
      [54.2, '不管明天 会有多少风暴'],
      [57.8, '我们都会 准时报到'],
      [62.0, '向光奔跑 我们一起燃烧'],
      [65.8, '烟花在头顶 为我们闪耀'],
      [69.6, '向光奔跑 谁也不能阻挠'],
      [73.4, '这一秒 就是最好'],
      [80.0, 'Run to the light'],
      [83.6, '我们一起 Yeah!'],
    ],
    ai: {
      summary: '盛夏里一起奔向光',
      valence: 0.86, energy: 0.82, warmth: 0.8,
      palette: ['#ffd166', '#ff8a6b', '#7fd6ff', '#c9a7ff'],
      weather: 'dust', seal: '燃',
      byKind: {
        intro: { scene: 'center', motion: 'lyrical', weather: 'dust', energy: 0.6, burst: 0 },
        verse: { scene: 'center', motion: 'lyrical', weather: 'dust', energy: 0.62, burst: 0 },
        lift: { scene: 'collage', motion: 'punchy', weather: 'embers', energy: 0.8, burst: 0 },
        breath: { scene: 'collage', motion: 'punchy', weather: 'embers', energy: 0.8, burst: 0 },
        chorus: { scene: 'collage', motion: 'punchy', weather: 'fireworks', energy: 0.95, burst: 0.9 },
        outro: { scene: 'hero', motion: 'punchy', weather: 'fireworks', energy: 0.7, burst: 0.6 },
      },
    },
  }),

  lanterns: build({
    id: 'lanterns',
    title: 'Paper Lanterns',
    artist: 'Huajian Test',
    duration: 44,
    bpm: 84,
    theme: { name: 'Lanterns', description: 'tender, warm, a night by the river', backgroundColor: '#0f0d0b', primaryColor: '#f6efe2', accentColor: '#f0b56a', secondaryColor: '#b9ab98', fontStyle: 'serif', animationIntensity: 'calm', isDaylight: false },
    lines: [
      [6.0, 'We folded paper lanterns'],
      [10.0, 'and let them float away'],
      [14.0, 'every light a little promise'],
      [18.0, 'that we would find our way'],
      [23.0, 'Hold on, hold on to the glow'],
      [27.0, "even when the river's slow"],
      [31.0, 'Hold on, hold on to the glow'],
      [35.0, 'I will meet you where they go'],
    ],
    ai: {
      summary: 'a quiet promise on a night river',
      valence: 0.55, energy: 0.4, warmth: 0.75,
      palette: ['#ffe2b0', '#f3b77a', '#fff4e2'],
      weather: 'fireflies', seal: '',
      byKind: {
        intro: { scene: 'stanza', motion: 'gentle', weather: 'fireflies', energy: 0.35, burst: 0 },
        verse: { scene: 'center', motion: 'lyrical', weather: 'fireflies', energy: 0.45, burst: 0 },
        chorus: { scene: 'hero', motion: 'lyrical', weather: 'embers', energy: 0.5, burst: 0 },
        outro: { scene: 'whisper', motion: 'gentle', weather: 'fireflies', energy: 0.3, burst: 0 },
      },
    },
  }),
};

/** A stand-in for the AI: reads the paragraph list in the prompt and answers as the fixture says. */
export const fakeAiAnswer = (fixture, prompt) => {
  const sections = [];
  const pattern = /^P(\d+) \[([^\]]+)\]/gm;
  const kinds = { 前奏后首段: 'intro', 主歌: 'verse', 推进: 'lift', 副歌: 'chorus', 气口: 'breath', 尾声: 'outro' };
  for (const match of prompt.matchAll(pattern)) {
    const kind = kinds[match[2]] ?? 'verse';
    const pick = fixture.ai.byKind[kind] ?? fixture.ai.byKind.verse;
    const block = prompt.slice(match.index).split('\n').slice(1, 2)[0]?.trim() ?? '';
    // Like a model would: the first real word of the chorus (here, the first space-separated phrase).
    const keyword = kind === 'chorus' || kind === 'outro' ? (block.split(/\s+/)[0] ?? '') : '';
    sections.push({ p: Number(match[1]), ...pick, keyword });
  }
  const { byKind, ...song } = fixture.ai;
  return { ...song, sections };
};
