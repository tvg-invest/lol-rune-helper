'use strict';
// Enhedstest af vinder-estimatet (draft + din form + spillerne i kampen) og kalibreringen.
// Kør: node test/estimate.test.js  (intet internet)
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');

const file = path.join(__dirname, '..', 'lol-helper.js');
const src = fs.readFileSync(file, 'utf8');
const cut = src.lastIndexOf('\nmain().catch(');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-est-'));
process.env.LOL_HELPER_HISTORY = path.join(tmp, 'history.json');
process.env.LOL_HELPER_CONFIG = path.join(tmp, 'config.json');
const ctx = vm.createContext({ require: createRequire(file), process, console, Buffer, URL, fetch, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file), __filename: file });
vm.runInContext(src.slice(0, cut), ctx, { filename: file });
const run = (code) => vm.runInContext(code, ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));
run('app.cfg = { ...DEFAULT_CONFIG };');
const close = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

const M = (id, position, winRate, games, counters = []) => ({ id: String(id), name: `C${id}`, position, winRate, games, counters });
const even = (ids, wr = 0.5) => ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'].map((pos, i) => M(ids[i], pos, wr, 100000));
const est = (a, e, myId = null, myPos = null, games = []) => plain(run('draftEstimate')(a, e, myId, myPos, games));

// 1) Lige hold = 50 %; færre end 5 mod 5 = intet estimat
close(est(even([1, 2, 3, 4, 5]), even([6, 7, 8, 9, 10])).p, 0.5);
assert.strictEqual(run('draftEstimate')(even([1, 2, 3, 4, 5]).slice(0, 4), even([6, 7, 8, 9, 10])), null);

// 2) Én champion med 53 % WR i 100.000 kampe: ca. 53 % (krympning næsten 0 ved mange kampe)
let a = even([1, 2, 3, 4, 5]);
a[2] = M(3, 'MID', 0.53, 100000);
let r = est(a, even([6, 7, 8, 9, 10]));
assert(r.p > 0.529 && r.p < 0.53, String(r.p));
// Samme WR i 200 kampe: krympes kraftigt (200/(200+2000))
a[2] = M(3, 'MID', 0.53, 200);
r = est(a, even([6, 7, 8, 9, 10]));
assert(r.p > 0.502 && r.p < 0.504, String(r.p));
// Modstanderens stærke champion trækker ned
const e = even([6, 7, 8, 9, 10]);
e[0] = M(6, 'TOP', 0.53, 100000);
assert(est(even([1, 2, 3, 4, 5]), e).p < 0.471);

// 3) Lane-matchup: kun den del der ikke allerede ligger i championernes egen styrke
a = even([1, 2, 3, 4, 5]);
a[2] = M(3, 'MID', 0.5, 100000, [{ champion_id: 8, play: 100000, win: 55000 }]);
r = est(a, even([6, 7, 8, 9, 10]));
const lane = r.parts.find((x) => x.kind === 'lane');
assert.strictEqual(lane.label, 'MID: jeres C3 mod deres C8');
assert(r.p > 0.549 && r.p < 0.55, String(r.p));
// Matchup med få kampe: lille vægt (50 kampe -> 50/550)
a[2] = M(3, 'MID', 0.5, 100000, [{ champion_id: 8, play: 50, win: 40 }]);
r = est(a, even([6, 7, 8, 9, 10]));
assert(r.p > 0.53 && r.p < 0.56, String(r.p));
// Matchup mod en champion i en anden rolle tæller ikke
a[2] = M(3, 'MID', 0.5, 100000, [{ champion_id: 9, play: 100000, win: 60000 }]);
close(est(a, even([6, 7, 8, 9, 10])).p, 0.5);

// 4) Din form: kun fra 5 kampe på championen i rollen; 2 sejre af 10 trækker ned
const hist = (n, wins, champ = 3, position = 'MID') => Array.from({ length: n }, (_, i) => ({ championId: champ, position, result: i < wins ? 'Sejr' : 'Nederlag' }));
r = est(even([1, 2, 3, 4, 5]), even([6, 7, 8, 9, 10]), 3, 'MID', hist(4, 0));
assert(!r.parts.some((x) => x.kind === 'me'), 'under 5 kampe: ingen form');
r = est(even([1, 2, 3, 4, 5]), even([6, 7, 8, 9, 10]), 3, 'MID', hist(10, 2));
const me = r.parts.find((x) => x.kind === 'me');
assert.strictEqual(me.detail, '2 sejre af 10 kampe (dine kampe)');
assert(r.p < 0.5 && r.p > 0.3, String(r.p));
assert(!est(even([1, 2, 3, 4, 5]), even([6, 7, 8, 9, 10]), 3, 'MID', hist(10, 2, 3, 'TOP')).parts.some((x) => x.kind === 'me'), 'anden rolle tæller ikke');

// 5) I kampen: spillernes form lægges oven i draften
ctx.__W = { estimate: est(even([1, 2, 3, 4, 5]), even([6, 7, 8, 9, 10])), ally: { members: even([1, 2, 3, 4, 5]) }, enemy: { members: even([6, 7, 8, 9, 10]) } };
run('app.wincons = __W; app.live = {}; app.game = { estPlayers: new Map() };');
run(`app.game.estPlayers.set('x', { status: 'ok', part: { kind: 'player', side: 'enemy', label: 'Deres C8-spiller', v: -0.2, detail: 'd' } });
  app.game.estPlayers.set('y', { status: 'loading', part: null });`);
let c = plain(run('currentEstimate()'));
close(c.draft, 0.5);
close(c.live, 1 / (1 + Math.exp(0.2)));
assert.deepStrictEqual(c.players, { done: 1, total: 2 });
let v = plain(run('estimateView()'));
assert.strictEqual(v.parts[0].pp, -5, 'v -0,2 = ca. -5 procentpoint');
run('app.cfg = { ...DEFAULT_CONFIG, winEstimate: false }');
assert.strictEqual(run('currentEstimate()'), null);
run('app.cfg = { ...DEFAULT_CONFIG }; app.live = null; app.game = null;');

// 6) Kalibrering: vises fra 10 kampe, dom fra 30, Brier mod 0,25
const g = (p, win) => ({ result: win ? 'Sejr' : 'Nederlag', winEstimate: { draft: p, live: null } });
ctx.__games = Array.from({ length: 9 }, () => g(0.6, true));
assert.deepStrictEqual(plain(run('estimateCalibration(__games)')).lines, []);
ctx.__games = [...Array.from({ length: 6 }, () => g(0.6, true)), ...Array.from({ length: 4 }, () => g(0.6, false)), g(0.4, false), g(0.4, false), g(0.5, true)];
let cal = plain(run('estimateCalibration(__games)'));
assert.strictEqual(cal.games, 13);
assert.strictEqual(cal.lines[0], 'Favorit (over 52 %): 6 sejre af 10 (estimat i snit 60,0%)');
assert.strictEqual(cal.lines[1], 'Jævnt (48-52 %): 1 sejre af 1 (estimat i snit 50,0%)');
assert.strictEqual(cal.lines[2], 'Underdog (under 48 %): 0 sejre af 2 (estimat i snit 40,0%)');
assert(/For få kampe til en dom endnu \(13 af 30\)/.test(cal.verdict));
// 30 kampe hvor et sikkert estimat altid tager fejl: "brug det ikke"
ctx.__games = Array.from({ length: 30 }, (_, i) => g(0.6, i % 3 === 0));
assert(/IKKE ramt bedre/.test(plain(run('estimateCalibration(__games)')).verdict));
ctx.__games = Array.from({ length: 30 }, (_, i) => g(i % 2 ? 0.6 : 0.4, i % 2 === 1));
assert(/ramt bedre end 50\/50/.test(plain(run('estimateCalibration(__games)')).verdict));
// Live-estimatet bruges når det findes
ctx.__games = Array.from({ length: 10 }, () => ({ result: 'Sejr', winEstimate: { draft: 0.4, live: 0.7 } }));
assert(/estimat i snit 70,0%/.test(plain(run('estimateCalibration(__games)')).lines[0]));
console.log('estimate: alle tests bestået');
