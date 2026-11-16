'use strict';
// Enhedstest af "Mine runer" (validering, klientens side, din side først) og wincon-analysen.
// Kør: node test/wincons-runes.test.js  (intet internet: rune-træet er Data Dragons rigtige runesReforged, patch 16.22.1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');

const file = path.join(__dirname, '..', 'lol-helper.js');
const src = fs.readFileSync(file, 'utf8');
const cut = src.lastIndexOf('\nmain().catch(');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-wc-'));
process.env.LOL_HELPER_HISTORY = path.join(tmp, 'history.json');
process.env.LOL_HELPER_CONFIG = path.join(tmp, 'config.json');
const ctx = vm.createContext({ require: createRequire(file), process, console, Buffer, URL, fetch, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file), __filename: file });
vm.runInContext(src.slice(0, cut), ctx, { filename: file });
const run = (code) => vm.runInContext(code, ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));

// Data Dragon-træet som loadStaticData bygger det (rigtig runesReforged).
const styles = require('./fixtures/runes-reforged.json');
ctx.__styles = styles;
run(`
  dd.trees = __styles.map((st) => ({ id: st.id, name: st.name, slots: st.slots.map((sl) => sl.runes.map((r) => r.id)) }));
  dd.runes = {};
  for (const st of __styles) { dd.runes[st.id] = { name: st.name, icon: null }; for (const sl of st.slots) for (const r of sl.runes) dd.runes[r.id] = { name: r.name, icon: null }; }
  for (const [id, name] of Object.entries(SHARD_NAMES)) dd.runes[id] = { name, icon: null };
  dd.champions = {
    7: { key: '7', id: 'Leblanc', name: 'LeBlanc', tags: ['Assassin', 'Mage'], info: { attack: 1, magic: 10 } },
    222: { key: '222', id: 'Jinx', name: 'Jinx', tags: ['Marksman'], info: { attack: 9, magic: 2 } },
    89: { key: '89', id: 'Leona', name: 'Leona', tags: ['Tank', 'Support'], info: { attack: 4, magic: 3 } },
    23: { key: '23', id: 'Tryndamere', name: 'Tryndamere', tags: ['Fighter', 'Assassin'], info: { attack: 10, magic: 2 } },
    64: { key: '64', id: 'LeeSin', name: 'Lee Sin', tags: ['Fighter', 'Assassin'], info: { attack: 8, magic: 3 } },
    10: { key: '10', id: 'Kayle', name: 'Kayle', tags: ['Fighter', 'Support'], info: { attack: 6, magic: 7 } },
    238: { key: '238', id: 'Zed', name: 'Zed', tags: ['Assassin'], info: { attack: 9, magic: 1 } },
    121: { key: '121', id: 'Khazix', name: "Kha'Zix", tags: ['Assassin'], info: { attack: 9, magic: 1 } },
    51: { key: '51', id: 'Caitlyn', name: 'Caitlyn', tags: ['Marksman'], info: { attack: 8, magic: 2 } },
    117: { key: '117', id: 'Lulu', name: 'Lulu', tags: ['Support', 'Mage'], info: { attack: 2, magic: 7 } },
  };
`);

// LeBlanc med Manaflow Band (Tobias' ønske): Electrocute (Domination) + Sorcery: Manaflow Band + Transcendence.
const LB = { primary_page_id: 8100, primary_rune_ids: [8112, 8143, 8140, 8105], secondary_page_id: 8200, secondary_rune_ids: [8210, 8226], stat_mod_ids: [5008, 5008, 5001] };
const ok = plain(run('validRunePage')(LB));
assert.deepStrictEqual(ok.secondary_rune_ids, [8226, 8210], 'anden gren sorteres efter række (Manaflow række 1, Transcendence række 2)');
assert.strictEqual(run('runeName')(ok.secondary_rune_ids[0]), 'Manaflow Band');
const bad = (p, re, why) => assert.throws(() => run('validRunePage')(p), re, why);
bad({ ...LB, secondary_rune_ids: [8226, 8224] }, /forskellige rækker/, 'to runer fra samme række');
bad({ ...LB, secondary_rune_ids: [8229, 8226] }, /forskellige rækker/, 'keystone i anden gren er ikke tilladt');
bad({ ...LB, secondary_page_id: 8100 }, /forskellige/, 'samme gren to gange');
bad({ ...LB, primary_rune_ids: [8143, 8112, 8140, 8105] }, /hver række/, 'runer i forkert række');
bad({ ...LB, stat_mod_ids: [5011, 5008, 5001] }, /shard/, 'shard i forkert række');
bad({ ...LB, primary_page_id: 1234 }, /ukendt/);

// Klientens side (/lol-perks/v1/currentpage) -> samme form.
const fromClient = plain(run('pageFromClient')({ primaryStyleId: 8100, subStyleId: 8200, selectedPerkIds: [8112, 8143, 8140, 8105, 8226, 8210, 5008, 5008, 5001] }));
assert.deepStrictEqual(plain(run('validRunePage')(fromClient)), ok);

// Din side står først i recommend og er markeret "mine"; uden side er OP.GG's først.
const opggPage = { ...LB, secondary_rune_ids: [8210, 8236], play: 5000, win: 2600 };
ctx.__build = { rune_pages: [{ builds: [opggPage] }], core_items: [], boots: [], starter_items: [], last_items: [], summoner_spells: [] };
run(`dd.items = {}; app.cfg = { ...DEFAULT_CONFIG };`);
let rec = run('recommend(__build, app.cfg, [], null, 11, 7)');
assert.strictEqual(rec.runeOptions.length, 1);
assert(!rec.runeOptions[0].mine);
run(`app.cfg = { ...DEFAULT_CONFIG, myRunes: { 7: ${JSON.stringify(LB)} } };`);
rec = run('recommend(__build, app.cfg, [], null, 11, 7)');
assert.strictEqual(rec.runeOptions[0].mine, true, 'din side først');
assert.deepStrictEqual(plain(rec.runeOptions[0].secondary_rune_ids), [8226, 8210]);
assert.strictEqual(rec.runeOptions.length, 2, 'OP.GG\'s side ligger stadig som fane');
rec = run('recommend(__build, app.cfg, [], null, 11, 222)');
assert(!rec.runeOptions[0].mine, 'siden gælder kun championen');
// En gemt side der ikke passer til patchen bruges ikke (OP.GG's i stedet).
run(`app.cfg = { ...DEFAULT_CONFIG, myRunes: { 7: { ...${JSON.stringify(LB)}, secondary_rune_ids: [8226, 8224] } } };`);
rec = run('recommend(__build, app.cfg, [], null, 11, 7)');
assert(!rec.runeOptions[0].mine);

// Gem i config.json (resten af filen bevares).
fs.writeFileSync(process.env.LOL_HELPER_CONFIG, JSON.stringify({ region: 'EUNE' }));
run(`app.cfg = { ...DEFAULT_CONFIG, region: 'EUNE' }; saveMyRunes(7, validRunePage(${JSON.stringify(LB)}));`);
const saved = JSON.parse(fs.readFileSync(process.env.LOL_HELPER_CONFIG, 'utf8'));
assert.strictEqual(saved.region, 'EUNE');
assert.deepStrictEqual(saved.myRunes['7'].secondary_rune_ids, [8226, 8210]);
run('saveMyRunes(7, null)');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(process.env.LOL_HELPER_CONFIG, 'utf8')).myRunes, {});

// ---------- Wincons ----------
// OP.GG-builds med game_lengths (formen fra et rigtigt svar: [{game_length, rate, average, rank}]).
const gl = (first, last) => [{ game_length: 0, rate: first }, { game_length: 25, rate: (first + last) / 2 }, { game_length: 40, rate: last }];
const curves = { 222: gl(0.47, 0.55), 89: gl(0.5, 0.5), 7: gl(0.53, 0.49), 23: gl(0.5, 0.51), 64: gl(0.53, 0.46),
  10: gl(0.44, 0.57), 238: gl(0.52, 0.48), 121: gl(0.54, 0.47), 51: gl(0.52, 0.49), 117: gl(0.49, 0.51) };
ctx.__curves = curves;
run(`
  fetchBuild = async (region, mode, id) => ({ game_lengths: __curves[id], summary: { average_stats: { play: 1000, win_rate: 0.5 }, positions: [] } });
  roleRates = async (cfg, ids) => Object.fromEntries(ids.map((id) => [id, { 10: { TOP: 0.9 }, 238: { MID: 0.9 }, 121: { JUNGLE: 0.95 }, 51: { ADC: 0.95 }, 117: { SUPPORT: 0.95 } }[id] || {}]));
`);
(async () => {
  const allies = [{ id: 23, position: 'TOP' }, { id: 64, position: 'JUNGLE' }, { id: 7, position: 'MID' }, { id: 222, position: 'ADC' }, { id: 89, position: 'SUPPORT' }];
  const enemies = [10, 238, 121, 51, 117].map((id) => ({ id, position: null }));
  const W = plain(await run('analyzeWincons')(run('app.cfg'), allies, enemies, 7));
  assert.strictEqual(W.ally.wincon.name, 'Jinx', 'marksman der skalerer = jeres wincon');
  assert.strictEqual(W.enemy.wincon.name, 'Kayle', 'Kayle (+13 pp fra kort til lang kamp) = deres wincon');
  assert.strictEqual(W.enemy.wincon.position, 'TOP', 'rolle fra OP.GG\'s rollefordeling');
  assert.strictEqual(W.enemy.early.name, "Kha'Zix", 'carry hvis win rate falder mest = farligst tidligt');
  assert.strictEqual(W.ally.members.find((m) => m.id === '89').weight, 1 * 0.4, 'tank-support vejer lidt (Tank 1 x 0.4)');
  ctx.__W = W;
  run('app.wincons = __W; app.cfg = { ...DEFAULT_CONFIG };');
  let v = plain(run('winconsView()'));
  assert(v.advice.some((l) => /Kayle må ikke blive fed/.test(l)));
  assert(v.advice.some((l) => /Kayle bliver stærkere med tiden/.test(l)));
  assert(v.advice.some((l) => /Spil omkring Jinx/.test(l)));
  assert(v.enemy.wincon.reasons.some((r) => /\+13,0 procentpoint/.test(r)));

  // I kampen: Kayle 5/0 med mest guld = FED; ny trussel når en anden er fed.
  const P = (key, team, k, d, a, gold, lvl = 9) => ({ champ: run(`dd.champions[${key}]`), name: String(key), team, kills: k, deaths: d, assists: a, itemGold: gold, level: lvl });
  const L = {
    me: P(7, 'ORDER', 2, 2, 2, 4000),
    allies: [P(23, 'ORDER', 1, 2, 1, 3500), P(64, 'ORDER', 1, 3, 2, 3000), null, P(222, 'ORDER', 0, 3, 1, 2500), P(89, 'ORDER', 0, 2, 3, 1500)],
    enemies: [P(10, 'CHAOS', 5, 0, 1, 6000, 11), P(238, 'CHAOS', 2, 1, 1, 3500), P(121, 'CHAOS', 2, 1, 3, 3500), P(51, 'CHAOS', 1, 1, 1, 3000), P(117, 'CHAOS', 0, 1, 4, 1500)],
  };
  L.allies[2] = L.me;
  ctx.__L = L;
  let live = plain(run('winconLive(__L, app.wincons)'));
  assert.strictEqual(live.enemy.state, 'fed');
  assert.strictEqual(live.ally.state, 'behind', 'Jinx 0/3 med mindst guld');
  run('app.live = __L');
  v = plain(run('winconsView()'));
  assert.strictEqual(v.enemy.wincon.state.label, 'FED');
  assert(v.advice.some((l) => /Kayle er fed/.test(l)));
  assert(v.advice.some((l) => /Jeres wincon Jinx er bagud/.test(l)));
  // Zed bliver fed i stedet: står som ny trussel.
  L.enemies[0] = P(10, 'CHAOS', 0, 3, 1, 2500, 8);
  L.enemies[1] = P(238, 'CHAOS', 7, 1, 2, 7000, 12);
  live = plain(run('winconLive(__L, app.wincons)'));
  assert.strictEqual(live.enemy.state, 'behind');
  assert.strictEqual(live.enemyNew.name, 'Zed');
  v = plain(run('winconsView()'));
  assert(v.advice.some((l) => /Zed \(7\/1\/2\) bærer dem nu/.test(l)));

  // Du er selv wincon'en.
  ctx.__W2 = { ...W, ally: { ...W.ally, wincon: W.ally.members.find((m) => m.id === '7') } };
  run('app.live = null; app.wincons = __W2;');
  v = plain(run('winconsView()'));
  assert(v.ally.wincon.me);
  assert(v.advice.some((l) => /Du er jeres wincon/.test(l)));

  // Holdets skalering: jeres gennemsnit vs. deres.
  assert(v.advice.some((l) => /Deres hold skalerer bedre|Jeres hold skalerer bedre/.test(l)) || Math.abs(W.ally.avgCurve - W.enemy.avgCurve) < 0.01);

  // Slået fra i config: intet kort.
  run('app.cfg = { ...DEFAULT_CONFIG, wincons: false };');
  assert.strictEqual(run('winconsView()'), null);
  console.log('wincons-runes: alle tests bestået');
})().catch((e) => { console.error(e); process.exit(1); });
