'use strict';
// Enhedstest af objective-vagten, "omsæt føringen" og wincon i kampgennemgangen.
// Kør: node test/objectives.test.js  (intet internet)
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');

const file = path.join(__dirname, '..', 'lol-helper.js');
const src = fs.readFileSync(file, 'utf8');
const cut = src.lastIndexOf('\nmain().catch(');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-obj-'));
process.env.LOL_HELPER_HISTORY = path.join(tmp, 'history.json');
process.env.LOL_HELPER_CONFIG = path.join(tmp, 'config.json');
const ctx = vm.createContext({ require: createRequire(file), process, console, Buffer, URL, fetch, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file), __filename: file });
vm.runInContext(src.slice(0, cut), ctx, { filename: file });
const run = (code) => vm.runInContext(code, ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));
run(`app.cfg = { ...DEFAULT_CONFIG }; dd.items = {};
  dd.champions = { 7: { key: '7', id: 'Leblanc', name: 'LeBlanc', tags: ['Assassin'] }, 238: { key: '238', id: 'Zed', name: 'Zed', tags: ['Assassin'] },
    10: { key: '10', id: 'Kayle', name: 'Kayle', tags: ['Marksman'] }, 222: { key: '222', id: 'Jinx', name: 'Jinx', tags: ['Marksman'] } };`);
const timers = (events, t, score) => plain(run('objectiveTimers')(events, t, score));
const S0 = { ORDER: { dragons: 0 }, CHAOS: { dragons: 0 } };

// 1) Timere fra kampstart: drage 5:00, voidgrubs 8:00, Herald 15:00, Baron 20:00
let o = timers([], 60, S0);
assert.deepStrictEqual(o.map((x) => [x.key, x.at]), [['dragon', 300], ['grubs', 480], ['herald', 900], ['baron', 1200]]);
assert.strictEqual(o[0].in, 240);
// Drage dræbt 6:10 -> ny 11:10; voidgrubs forsvinder fra listen efter 8:00 (om de er taget, står ikke i live-API'et)
o = timers([{ EventName: 'DragonKill', EventTime: 370 }], 500, S0);
assert.deepStrictEqual(o.map((x) => [x.key, x.at]), [['dragon', 670], ['herald', 900], ['baron', 1200]]);
// Herald oppe 15:00-19:45 hvis ikke dræbt; dræbt -> væk
o = timers([], 1000, S0);
assert(o.find((x) => x.key === 'herald').up);
assert(!timers([{ EventName: 'HeraldKill', EventTime: 950 }], 1000, S0).some((x) => x.key === 'herald'));
assert(!timers([], 1190, S0).some((x) => x.key === 'herald'), 'Herald forsvinder 19:45');
// Baron dræbt 24:00 -> ny 30:00; drage-sjæl (4 drager) -> ingen drage-timer (Elder beregnes ikke)
o = timers([{ EventName: 'BaronKill', EventTime: 1440 }], 1500, { ORDER: { dragons: 4 }, CHAOS: { dragons: 1 } });
assert.deepStrictEqual(o.map((x) => [x.key, x.at]), [['baron', 1800]]);

// 2) Visning + råd
const me = (o2 = {}) => ({ key: 'Mig#EUN', name: 'Mig', champ: run('dd.champions[7]'), team: 'ORDER', position: 'MIDDLE', level: 8, kills: 3, deaths: 0, assists: 1, itemGold: 4000, itemIds: [], isDead: false, respawn: 0, ...o2 });
const opp = (o2 = {}) => ({ key: 'Zed#1', name: 'Zed', champ: run('dd.champions[238]'), team: 'CHAOS', position: 'MIDDLE', level: 6, kills: 0, deaths: 3, assists: 0, itemGold: 2000, itemIds: [], ...o2 });
ctx.__L = { gameTime: 230, me: me(), matchup: { player: opp() }, objectives: timers([], 230, S0) };
let v = plain(run('objectiveView(__L)'));
assert.strictEqual(v.list[0].name, 'Drage');
assert.strictEqual(v.list[0].text, 'om 1:10');
assert(v.list[0].soon);
assert(v.lines.some((l) => /Drage om 1:10: køb nu/.test(l)), v.lines.join(' | '));
assert(!v.lines.some((l) => /foran/.test(l)), 'før 6 min: ingen føringsråd');
// Foran ved 8:00 (drage dræbt 6:10 -> ny 11:10, mere end 2 min væk): pres tårnet
ctx.__L = { gameTime: 480, me: me(), matchup: { player: opp() }, objectives: timers([{ EventName: 'DragonKill', EventTime: 370 }], 480, S0) };
v = plain(run('objectiveView(__L)'));
assert(v.lines.some((l) => /^Du er foran Zed \(.*\)\. Pres tårnet/.test(l)), v.lines.join(' | '));
// Foran og dragen om 1:30: gå til dragen
ctx.__L = { gameTime: 580, me: me(), matchup: { player: opp() }, objectives: timers([{ EventName: 'DragonKill', EventTime: 370 }], 580, S0) };
v = plain(run('objectiveView(__L)'));
assert(v.lines.some((l) => /Drage om 1:30: skub din wave og gå til dragen/.test(l)), v.lines.join(' | '));
// Jungle foran
ctx.__L = { gameTime: 480, me: me({ position: 'JUNGLE' }), matchup: { player: opp({ position: 'JUNGLE' }) }, objectives: timers([{ EventName: 'DragonKill', EventTime: 370 }], 480, S0) };
assert(plain(run('objectiveView(__L)')).lines.some((l) => /Tag fjendens camps/.test(l)));
// Bagud: ingen føringsråd
ctx.__L = { gameTime: 480, me: me({ itemGold: 1500, kills: 0, deaths: 3, level: 6 }), matchup: { player: opp({ itemGold: 4000, kills: 3, deaths: 0, level: 8 }) }, objectives: timers([], 480, S0) };
assert(!plain(run('objectiveView(__L)')).lines.some((l) => /foran/.test(l)));
// Død når dragen spawner
ctx.__L = { gameTime: 270, me: me({ isDead: true, respawn: 45 }), matchup: null, objectives: timers([], 270, S0) };
assert(plain(run('objectiveView(__L)')).lines.some((l) => /Du er død, når dragen spawner \(45 sek\.\)/.test(l)));
// Slået fra
run('app.cfg = { ...DEFAULT_CONFIG, objectiveCoach: false }');
assert.strictEqual(run('objectiveView(__L)'), null);
run('app.cfg = { ...DEFAULT_CONFIG }');

// 3) Stemmen: én gang 1,5 min før, én gang hvis du er død; ikke igen ved næste tjek
const said = [];
ctx.__say = (kind, text) => { said.push(text); return true; };
for (const t of [208, 212, 214]) {
  ctx.__L = { gameTime: t, me: me(), objectives: timers([], t, S0) };
  run('announceObjectives(__L, __say)');
}
assert.deepStrictEqual(said, ['Drage om halvandet minut - køb nu og vær klar']);
for (const t of [270, 272]) {
  ctx.__L = { gameTime: t, me: me({ isDead: true, respawn: 40 }), objectives: timers([], t, S0) };
  run('announceObjectives(__L, __say)');
}
assert.deepStrictEqual(said.slice(1), ['Dragen spawner før du er i live - ping holdet væk']);
// Afvist af stemmens 8-sek.-grænse -> prøves igen
const said2 = [];
let allow = false;
ctx.__say2 = (kind, text) => { if (allow) said2.push(text); return allow; };
run('app.objSpoken = null');
ctx.__L = { gameTime: 1115, me: me(), objectives: timers([], 1115, S0) };
run('announceObjectives(__L, __say2)');
allow = true;
ctx.__L = { gameTime: 1117, me: me(), objectives: timers([], 1117, S0) };
run('announceObjectives(__L, __say2)');
assert.deepStrictEqual(said2, ['Baron om halvandet minut - køb nu og vær klar']);

// 4) Wincon i kampgennemgangen: kills på jer + højeste status, læring og tal på tværs af kampe
ctx.__W = { ally: { wincon: { id: '222', name: 'Jinx' } }, enemy: { wincon: { id: '10', name: 'Kayle' } } };
run('app.wincons = __W');
const P = (key, name, team, k, d, gold, lvl = 9) => ({ key: `${name}#1`, name, champ: run(`dd.champions[${key}]`), team, kills: k, deaths: d, assists: 0, itemGold: gold, level: lvl });
const L = { gameTime: 900, me: P(7, 'Mig', 'ORDER', 1, 2, 3000), allies: [], enemies: [P(10, 'Kayle', 'CHAOS', 5, 0, 6000, 11), P(238, 'Zed', 'CHAOS', 1, 1, 3000)] };
L.allies = [L.me, P(222, 'Jinx', 'ORDER', 0, 3, 2000)];
ctx.__L = L;
ctx.__g = {};
run(`trackWincon(__g, __L, { EventName: 'ChampionKill', EventTime: 400, KillerName: 'Kayle#1', VictimName: 'Mig#1' });
  trackWincon(__g, __L, { EventName: 'ChampionKill', EventTime: 500, KillerName: 'Kayle#1', VictimName: 'Jinx#1' });
  trackWincon(__g, __L, { EventName: 'ChampionKill', EventTime: 510, KillerName: 'Zed#1', VictimName: 'Jinx#1' });
  trackWincon(__g, __L, { EventName: 'ChampionKill', EventTime: 600, KillerName: 'Kayle#1', VictimName: 'Mig#1' });
  trackWincon(__g, __L, null);`);
const g = plain(run('__g'));
assert.deepStrictEqual(g.wincon.enemy.kills.map((k) => k.victim), ['dig', 'Jinx', 'dig']);
assert.strictEqual(g.wincon.enemy.peak, 'fed');
assert.strictEqual(g.wincon.ally.peak, 'behind');
assert.strictEqual(run('winconLesson(__g.wincon)'), 'Deres wincon Kayle: 5/0/0 ved slut, højst FED - 3 kills på jer (dig 2, Jinx 1)');
// Status de første 5 min: kun kills tæller (level 2 mod 1 er ikke "foran")
assert.strictEqual(plain(run(`winconStatus({ kills: 0, deaths: 0, assists: 0, itemGold: 500, level: 3 }, [{ kills: 0, deaths: 0, assists: 0, itemGold: 450, level: 1 }], 120)`)).state, 'even');
// På tværs af kampe (fra 6 kampe med data)
const games = (n, peak, result) => Array.from({ length: n }, () => ({ result, wincon: { enemy: { peak, kills: [{ victim: 'dig' }, { victim: 'Jinx' }] } } }));
ctx.__games = [...games(3, 'fed', 'Nederlag'), ...games(1, 'ahead', 'Sejr'), ...games(2, 'behind', 'Sejr')];
let st = plain(run('winconStats(__games)'));
assert.deepStrictEqual(st.lines, ['Når deres wincon kom foran eller blev fed: 1 sejre af 4 kampe.', 'Når deres wincon blev holdt nede: 2 sejre af 2 kampe.', 'Af deres wincons 12 kills på jer var 6 på dig.']);
ctx.__games = games(5, 'fed', 'Sejr');
st = plain(run('winconStats(__games)'));
assert.deepStrictEqual(st.lines, []);
assert.strictEqual(st.games, 5);
console.log('objectives: alle tests bestået');
