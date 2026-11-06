// The M1 evaluation set: songs across moods, languages and genres, each with the
// mood band a listener would put it in. Only titles and artists are stored; lyrics
// are fetched live through Folia's online sources when the evaluation runs, so no
// lyric text ships with the mod (the release build leaves this file out entirely).
//
// A band says what the reading must get right and what the staging must never do.
// Bump EVAL_SET_VERSION whenever songs or bands change, so results stay comparable.

export const EVAL_SET_VERSION = 2; // v2: two songs that matched lyric-less versions replaced; 爱人错过 relabelled

/** valence / energy: the range the song-level reading should land in; forbid: never in the plan. */
export const BANDS = {
  sad: { label: '伤感', valence: [0, 0.45], forbid: ['fireworks', 'punchy', 'collage'] },
  tender: { label: '抒情', valence: [0.3, 0.8], energy: [0, 0.62], forbid: ['fireworks', 'punchy'] },
  bright: { label: '欢快', valence: [0.55, 1] },
  hype: { label: '热血', energy: [0.6, 1] },
  darkFast: { label: '悲伤快歌', valence: [0, 0.5], energy: [0.5, 1], forbid: ['fireworks'] },
  rap: { label: '说唱', energy: [0.5, 1] },
  instrumental: { label: '纯音乐', instrumental: true },
  long: { label: '长篇多段', valence: [0, 1] },
};

export const EVAL_SET = [
  { title: '演员', artist: '薛之谦', band: 'sad' },
  { title: '十年', artist: '陈奕迅', band: 'sad' },
  { title: '富士山下', artist: '陈奕迅', band: 'sad' },
  { title: 'Lemon', artist: '米津玄師', band: 'sad' },
  { title: '消愁', artist: '毛不易', band: 'sad' },
  { title: 'Summertime Sadness', artist: 'Lana Del Rey', band: 'sad' },
  { title: 'A COLD PLAY', artist: 'The Kid LAROI', band: 'sad' },
  { title: '红豆', artist: '王菲', band: 'tender' },
  { title: '遇见', artist: '孙燕姿', band: 'tender' },
  { title: '月亮代表我的心', artist: '邓丽君', band: 'tender' },
  { title: 'First Love', artist: '宇多田ヒカル', band: 'tender' },
  { title: '贝加尔湖畔', artist: '李健', band: 'tender' },
  { title: '晴天', artist: '周杰伦', band: 'tender' },
  { title: '告白气球', artist: '周杰伦', band: 'bright' },
  { title: '今天你要嫁给我', artist: '陶喆 蔡依林', band: 'bright' },
  { title: 'Love Story', artist: 'Taylor Swift', band: 'bright' },
  { title: 'Clumsy', artist: 'Fergie', band: 'bright' },
  { title: '爱人错过', artist: '告五人', band: 'darkFast' }, // upbeat tune, regretful words
  { title: '倔强', artist: '五月天', band: 'hype' },
  { title: '海阔天空', artist: 'Beyond', band: 'hype' },
  { title: 'DDU-DU DDU-DU', artist: 'BLACKPINK', band: 'hype' },
  { title: 'Wake Me Up', artist: 'Avicii', band: 'hype' },
  { title: '夜に駆ける', artist: 'YOASOBI', band: 'darkFast' },
  { title: 'Yellow Rain', artist: 'Oliver Jiang', band: 'darkFast' },
  { title: '野狼disco', artist: '宝石Gem', band: 'rap' },
  { title: '目不转睛', artist: '王以太', band: 'rap' },
  { title: 'STACK IT UP', artist: 'Kenny Mason', band: 'rap' },
  { title: 'Summer', artist: '久石让', band: 'instrumental', instrumental: true },
  { title: 'Bohemian Rhapsody', artist: 'Queen', band: 'long' },
  { title: '罗刹海市', artist: '刀郎', band: 'long' },
];

const TEMPERAMENT_RANK = { gentle: 0, lyrical: 1, dramatic: 2, punchy: 3 };
const inRange = (value, range) => !range || (value >= range[0] && value <= range[1]);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/**
 * Checks one song: does the reading land in its band, and does the plan keep the
 * band's rules? `plan` is from buildPlan, `analysis` from analyzeLyrics. Pure, so
 * the unit checks can run it on the fixtures.
 * @returns {{ bandHit: boolean, violations: string[], coverage: number|null }}
 */
export const scoreSong = ({ band, direction, plan, analysis }) => {
  const rules = BANDS[band] ?? {};
  const violations = [];
  const bandHit = rules.instrumental
    ? analysis.sung.length === 0
    : inRange(direction.valence, rules.valence) && inRange(direction.energy, rules.energy);

  const forbid = rules.forbid ?? [];
  if (forbid.includes('fireworks') && plan.shells.length > 0) violations.push(`放了 ${plan.shells.length} 朵烟花`);
  if (forbid.includes('punchy')) {
    const punchy = plan.shots.filter((shot) => shot.temperament === 'punchy').length;
    if (punchy) violations.push(`${punchy} 个镜头是“燃”`);
  }
  if (forbid.includes('collage') && plan.paragraphs.some((p) => p.scene === 'collage')) violations.push('用了拼贴');

  // A chorus should not be calmer than the verses around it.
  const rank = (kind) => mean(plan.paragraphs.filter((p) => p.kind === kind).map((p) => TEMPERAMENT_RANK[p.temperament] ?? 1));
  const chorus = rank('chorus');
  const verse = rank('verse');
  if (chorus !== null && verse !== null && chorus < verse) violations.push('副歌比主歌还平');

  // Vertical type only for CJK paragraphs.
  for (const shot of plan.shots) {
    if (shot.layout === 'vertical' && analysis.items[shot.item].wide < 0.85) {
      violations.push('非中文用了竖排');
      break;
    }
  }

  // How many sung paragraphs the AI answered for (null for a local reading).
  const sungParagraphs = analysis.paragraphs.filter((p) => p.kind !== 'credits');
  const coverage = direction.src === 'ai' && sungParagraphs.length
    ? Math.round((direction.sections.length / sungParagraphs.length) * 100)
    : null;
  if (coverage !== null && coverage < 90) violations.push(`AI 只给了 ${coverage}% 的段落`);

  return { bandHit, violations, coverage };
};
