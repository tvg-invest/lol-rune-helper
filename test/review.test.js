'use strict';
// Enhedstest af kampgennemgangen (buildReview) mod klientens RIGTIGE format (test/fixtures/lcu-match.js).
// Kør: node test/review.test.js  (intet internet)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');
const { lcuGame, lcuTimeline, fill, SHAPE } = require('./fixtures/lcu-match');
const kill = (t, killerId, victimId, x, y, assistingParticipantIds = []) => ({ type: 'CHAMPION_KILL', timestamp: t, killerId, victimId, assistingParticipantIds, position: { x, y } });

const file = path.join(__dirname, '..', 'lol-helper.js');
const src = fs.readFileSync(file, 'utf8');
const cut = src.lastIndexOf('\nmain().catch(');
process.env.LOL_HELPER_HISTORY = path.join(require('os').tmpdir(), 'lol-review-test-none.json');
const ctx = vm.createContext({ require: createRequire(file), process, console, Buffer, URL, fetch, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file), __filename: file });
vm.runInContext(src.slice(0, cut), ctx, { filename: file });
const H0 = vm.runInContext('({ buildReview, REVIEW_VERSION, laneAt })', ctx);
// Objekter fra vm-konteksten har andre prototyper - JSON gør dem sammenlignelige (og svarer til det der gemmes).
const H = { ...H0, buildReview: (...a) => JSON.parse(JSON.stringify(H0.buildReview(...a))) };

// 1) Fixturen afviser felter der ikke findes i klientens rigtige format (fx Riot API v5's teamPosition/puuid på deltageren).
assert.throws(() => fill(SHAPE.game.participants[0], { teamPosition: 'MIDDLE' }, 'p'), /teamPosition findes ikke/);
assert.throws(() => fill(SHAPE.game.participants[0], { puuid: 'x' }, 'p'), /puuid findes ikke/);
assert.throws(() => fill(SHAPE.timeline.frames[1].events[0], { itemId: 1, beforeId: 2 }, 'e'), /beforeId findes ikke/, 'ITEM_UNDO-felter findes ikke i klientens timeline');

// 2) Formen har de felter parseren bygger på.
const pfShape = Object.values(SHAPE.timeline.frames[0].participantFrames)[0];
for (const k of ['totalGold', 'minionsKilled', 'jungleMinionsKilled', 'xp', 'position']) assert(k in pfShape, `participantFrames.${k}`);
assert.deepStrictEqual(Object.keys(SHAPE.timeline.frames[0].participantFrames), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 'participantFrames er et objekt med nøglerne 1-10');
for (const k of ['lane', 'role']) assert(k in SHAPE.game.participants[0].timeline, `participants[].timeline.${k}`);
assert('win' in SHAPE.game.participants[0].stats);

// 3) Bot-lanen: to fjender i bot - modstanderen er den med samme rolle (carry/support efter CS ved 10 min),
// selv om klienten kalder begge BOTTOM/DUO. Mid-spilleren står i LCU'en som TOP/SOLO.
const players = [
  [1, 222, 100, 'BOTTOM', 'DUO'], [2, 89, 100, 'BOTTOM', 'DUO'], [3, 103, 100, 'TOP', 'SOLO'], [4, 86, 100, 'TOP', 'SOLO'], [5, 254, 100, 'JUNGLE', 'NONE'],
  [6, 202, 200, 'BOTTOM', 'DUO'], [7, 16, 200, 'BOTTOM', 'DUO'], [8, 238, 200, 'MIDDLE', 'SOLO'], [9, 122, 200, 'TOP', 'SOLO'], [10, 104, 200, 'JUNGLE', 'NONE'],
].map(([id, champ, team, lane, role]) => ({ id, champ, team, lane, role, spells: [4, id === 5 || id === 10 ? 11 : 14], puuid: `p${id}`, win: id === 1 }));
const BOT = { x: 10000, y: 1300 }; const MID = { x: 7400, y: 7400 }; const TOP = { x: 1300, y: 10000 };
const posOf = (id) => ([1, 2, 6, 7].includes(id) ? BOT : [3, 8].includes(id) ? MID : [4, 9].includes(id) ? TOP : { x: 5000, y: 9500 });
const csOf = (id) => ({ 1: 8, 2: 1, 6: 7, 7: 1 }[id] ?? 6);
const game = lcuGame({ gameId: 9, players });
const tl = lcuTimeline({ minutes: 20, ids: players.map((p) => p.id),
  events: [{ type: 'CHAMPION_KILL', timestamp: 125000, killerId: 0, victimId: 1, assistingParticipantIds: [], position: { x: 12000, y: 1300 } },
    { type: 'BUILDING_KILL', timestamp: 600000, killerId: 1, teamId: 200, position: { x: 10500, y: 1000 }, buildingType: 'TOWER_BUILDING', laneType: 'BOT_LANE' }],
  frame: (m, id) => ({ totalGold: 500 + m * (id <= 5 ? 400 : 350), minionsKilled: m * csOf(id), position: posOf(id) }) });

const adc = H.buildReview(game, tl, { championId: 222, position: 'ADC', puuid: 'p1' });
assert.strictEqual(adc.v, H.REVIEW_VERSION);
assert.strictEqual(adc.opp, '202', 'ADC mod fjendens carry');
assert.strictEqual(adc.oppBy, 'position');
assert.strictEqual(adc.win, true);
assert.deepStrictEqual(adc.deaths, [{ t: 125, x: 12000, y: 1300, killer: null, by: 'other', n: 0, zone: 'Bot', own: true, lvl: 1, dead: 10 }], 'tårn-død (killerId 0) på din halvdel');
assert.deepStrictEqual(adc.at['10'], { cs: 80, oppCs: 70, gold: 500, xp: 0 });
assert.deepStrictEqual(adc.team.find((x) => x[0] === 20), [20, 5 * 20 * 50], 'holdets guldforskel');
assert.strictEqual(adc.path.length, 14);
assert.strictEqual(adc.jg, '104', 'fjendens jungler med Smite');

const sup = H.buildReview(game, tl, { championId: 89, position: 'SUPPORT', puuid: 'p2' });
assert.strictEqual(sup.opp, '16', 'support mod fjendens support');
const mid = H.buildReview(game, tl, { championId: 103, position: 'MID', puuid: 'p3' });
assert.strictEqual(mid.opp, '238', 'mid fundet ud fra positionerne, selv om klienten skriver TOP/SOLO');
const jg = H.buildReview(game, tl, { championId: 254, position: 'JUNGLE', puuid: 'p5' });
assert.strictEqual(jg.opp, '104');
assert.strictEqual(jg.path.length, 8, 'junglere: minut 1-8');

// 4) Ingen positioner (fx en meget kort kamp): klientens lane/role som sidste udvej - kun ved ét entydigt bud.
const flat = lcuTimeline({ minutes: 3, ids: players.map((p) => p.id), frame: () => ({ totalGold: 500 }) });
const midNoPos = H.buildReview(game, flat, { championId: 103, position: 'MID', puuid: 'p3' });
assert.strictEqual(midNoPos.opp, null, 'ingen gæt: klienten siger TOP for en mid-spiller');
const topNoPos = H.buildReview(game, flat, { championId: 86, position: 'TOP', puuid: 'p4' });
assert.strictEqual(topNoPos.oppBy, 'client');

// 5) Live-registreret modstander vinder over positionerne.
const live = H.buildReview(game, tl, { championId: 103, position: 'MID', puuid: 'p3', oppChampionId: 122 });
assert.deepStrictEqual([live.opp, live.oppBy], ['122', 'live']);

// 6) v3 (klatre-tjek): dødstid efter wikiens formel, objectives med hold og "mens du var død", stats og CS pr. minut.
const K = vm.runInContext('({ respawnSeconds, gameLeaks, metricSplit, CLIMB_METRICS, streakStats, tiltGuard, tiltThreshold, climbView, climbFocus, history, app, deathPhases, leadLine, COACH_ADVICE, coachSplit, coachFor, coachGame, epicTakes })', ctx);
assert.strictEqual(K.respawnSeconds(1, 60), 10);
assert.strictEqual(K.respawnSeconds(18, 14 * 60), 52.5, 'ingen TIF før 15 min');
assert(Math.abs(K.respawnSeconds(10, 20 * 60) - 32.5 * (1 + 10 * 0.425 / 100)) < 1e-9, 'TIF 15-30 min: ceil(2 x (min - 15)) x 0,425 %');
assert(Math.abs(K.respawnSeconds(18, 60 * 60) - 52.5 * 1.5) < 1e-9, 'loft på 50 %');
{
  const ps = players.map((p) => ({ ...p }));
  const g3 = lcuGame({ gameId: 10, duration: 1500, players: ps });
  g3.participants[2].stats = { ...g3.participants[2].stats, visionScore: 20, wardsPlaced: 9, wardsKilled: 2, visionWardsBoughtInGame: 1, kills: 3, deaths: 2, assists: 4, totalMinionsKilled: 150, neutralMinionsKilled: 10 };
  g3.participants[0].stats = { ...g3.participants[0].stats, kills: 5 };
  const tl3 = lcuTimeline({ minutes: 25, ids: ps.map((p) => p.id),
    events: [
      kill(600000, 8, 3, 7400, 7400, [10]), // mid (id 3) dør ved 10:00 mod 2 fjender
      { type: 'ELITE_MONSTER_KILL', timestamp: 610000, killerId: 10, monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', position: { x: 9800, y: 4400 } }, // fjenden tager drage mens du er død
      { type: 'ELITE_MONSTER_KILL', timestamp: 900000, killerId: 5, monsterType: 'HORDE', position: { x: 4800, y: 10200 } }, // dit hold
      { type: 'BUILDING_KILL', timestamp: 1200000, killerId: 0, teamId: 100, buildingType: 'TOWER_BUILDING', towerType: 'OUTER_TURRET', laneType: 'MID_LANE', position: { x: 5800, y: 6400 } }, // fjenden tager dit tårn (minions)
    ].map((e) => ({ assistingParticipantIds: [], ...e })),
    frame: (m, id) => ({ totalGold: 500 + m * 400, minionsKilled: m * 6, level: Math.min(18, 1 + Math.floor(m / 2)), position: posOf(id) }) });
  const r3 = H.buildReview(g3, tl3, { championId: 103, position: 'MID', puuid: 'p3' });
  assert.strictEqual(r3.v, H.REVIEW_VERSION);
  assert.strictEqual(r3.dur, 1500);
  assert.deepStrictEqual(r3.deaths.map((d) => [d.t, d.n, d.lvl, d.dead]), [[600, 2, 6, 16]], 'level 6 ved 10:00 -> 16 sek. dødstid');
  // v4: store monstre har near (du, i live, inden for 3.000 enheder i minut-billedet før/efter) og al/en (hvor mange fra hvert hold stod tæt på).
  // Bot-lanen (10.000, 1.300) er 3.106 enheder fra dragen (9.800, 4.400) - for langt væk. Begge junglere står ved voidgrubs.
  assert.deepStrictEqual(r3.objectives, [{ t: 610, k: 'DRAGON', mine: false, dead: true, near: false, al: 0, en: 0 }, { t: 900, k: 'HORDE', mine: true, dead: false, near: false, al: 1, en: 1 }, { t: 1200, k: 'TOWER', mine: false, dead: false }]);
  assert.deepStrictEqual([r3.stats.vision, r3.stats.controlWards, r3.stats.cs, r3.stats.teamKills], [20, 1, 160, 8]);
  assert.strictEqual(r3.csm.length, 26);
  assert.strictEqual(r3.csm[14], 84);
}

// 7) Klatre-tjekket på en syntetisk historik: median som skillelinje, sejre på hver side, op til 3 huller,
// referencetal fra kilden, tilt fra klientens kamphistorik.
K.app.cfg = { ...K.app.cfg, climbCheck: true, matchReview: true };
const mkGame = (i, o) => ({
  date: new Date(Date.parse('2026-11-01T20:00:00Z') - i * 3600e3).toISOString(), championId: 7, champion: 'LeBlanc', gameMode: 'CLASSIC', position: 'MID',
  result: o.win ? 'Sejr' : 'Nederlag', duration: 1800, kills: 5, deaths: o.deaths ?? 5, assists: 5, csPerMin: 6, buys: [],
  review: { v: 3, dur: 1800, deaths: Array.from({ length: o.multi }, (_, k) => ({ t: 900 + k * 60, n: 2 })).concat(o.early ? [{ t: 300, n: 1 }] : []),
    stats: { vision: o.vision * 30, controlWards: o.cw }, csm: Array.from({ length: 31 }, (_, m) => m * 6 + (m > 14 ? (m - 14) * (o.cs - 6) : 0)),
    objectives: Array.from({ length: o.obj }, () => ({ t: 1000, k: 'TOWER', mine: false, dead: true })),
    at: { 10: { gold: o.lead } }, team: [[10, 0], [20, o.team20]] },
});
// 12 kampe: sejrene har få dødsfald mod 2+ og ingen objectives tabt mens død; nederlagene det modsatte.
const gamesK = [];
for (let i = 0; i < 12; i++) {
  const win = i % 2 === 0;
  gamesK.push(mkGame(i, { win, multi: win ? 1 : 4, early: !win, vision: win ? 0.7 : 0.5, cw: win ? 2 : 0, cs: win ? 7 : 5, obj: win ? 0 : 3, lead: 500, team20: win ? 2000 : -2000 }));
}
K.history.games.splice(0, K.history.games.length, ...gamesK);
const multi = K.metricSplit(K.CLIMB_METRICS.find((m) => m.key === 'multi'), gamesK);
assert.deepStrictEqual([multi.med, multi.bad, multi.badWins, multi.good, multi.goodWins], [2.5, 6, 0, 6, 6], 'median 2,5 - over: 0 af 6, ellers 6 af 6');
const leaks = JSON.parse(JSON.stringify(K.gameLeaks(gamesK[1])));
assert.strictEqual(leaks.leaks.length, 3, 'højst 3 huller');
assert(leaks.leaks.every((l) => l.tip && /^Næste kamp/.test(l.tip.text) && /^https:\/\//.test(l.tip.url)), 'hvert hul har et forsøg + kilde');
assert.deepStrictEqual(leaks.leaks.map((l) => l.key), ['early', 'multi', 'objDead'], 'lige dyre huller i fast rækkefølge');
assert.strictEqual(leaks.leaks[1].text, 'Dødsfald mod 2+ fjender: 4 - din median er 1.');
assert.strictEqual(leaks.leaks[1].wins, 'I dine MID-kampe: flere end medianen 0 af 5 sejre - ellers 6 af 6.', 'kampen selv tæller ikke med i sammenligningen');
const thrownGame = { ...gamesK[0], review: { ...gamesK[0].review, team: [[10, 0], [20, -2000]] } };
const th = JSON.parse(JSON.stringify(K.gameLeaks(thrownGame))).leaks;
assert.deepStrictEqual(th.map((l) => l.key), ['thrown']);
assert.strictEqual(th[0].text, 'Foran i lanen ved 10 min (+500 g), men holdet var 2.000 g bagud ved 20 min.');
assert(leaks.refs.some((r) => /^5 dødsfald - MID i snit i sejre \/ nederlag: Gold 5,0 \/ 7,8$/.test(r)), JSON.stringify(leaks.refs));
assert.strictEqual(JSON.parse(JSON.stringify(K.gameLeaks(gamesK[0]))).leaks.length, 0, 'en god kamp har ingen huller');
assert.strictEqual(K.leadLine(gamesK), 'Foran i lanen ved 10 min i 12 af 12 kampe - vandt 6 af de 12. I 6 af dem var holdet bagud ved 20 min (0 sejre). Holdet bagud ved 20 min i alt: 0 af 6 sejre.');
const ph = JSON.parse(JSON.stringify(K.deathPhases(gamesK)));
assert.deepStrictEqual(ph.rows.map((r) => r.deaths), [6, 30, 0], 'dødsfald pr. fase (0-14, 14-25, 25+)');
// Tilt: 12 kampe i én session (10 min pause): V T T T V T T V ... -> efter 2 tab i træk
const t0 = Date.now() - 12 * 40 * 60e3;
const seq = [1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0];
K.history.recent = seq.map((w, i) => ({ id: i, start: t0 + i * 40 * 60e3, dur: 1800, win: Boolean(w) }));
const st = JSON.parse(JSON.stringify(K.streakStats()));
assert.deepStrictEqual(st.after.map((r) => [r.games, r.wins]), [[5, 2], [3, 0], [3, 1], [1, 1]], JSON.stringify(st.after));
assert.strictEqual(st.current, 3, '3 tab i træk lige nu');
const guard = K.tiltGuard(st);
assert(/^3 tab i træk\./.test(guard.text) && /iTero/.test(guard.text) && guard.url, `tilt-vagten bruger kilden når dine egne tal er for få: ${JSON.stringify(guard)}`);
assert(!/blok|stop|må ikke/i.test(guard.text), 'ingen blokering');
const view = JSON.parse(JSON.stringify(K.climbView()));
assert.strictEqual(view.costs.length, 3);
assert(view.trends.length === 0, 'udvikling kræver 15 kampe');
const focus = JSON.parse(JSON.stringify(K.climbFocus('MID')));
assert(focus.focus && focus.guard, JSON.stringify(focus));

// 8) Coachen: hvert råd målt i en syntetisk v4-historik, hvor sejre og nederlag adskiller sig på netop det råd.
{
  K.app.cfg = { ...K.app.cfg, coach: true };
  // JUNGLE-kampene adskiller sig kun på ganks (alt andet som en sejr), MID-kampene på alt andet.
  const mk = (i, role, result) => {
    const win = role === "JUNGLE" ? true : result; const gankWin = result;
    const o = (t, k, mine, near) => ({ t, k, mine, dead: false, near, al: near ? 3 : 1, en: 2 });
    return {
      date: new Date(Date.parse('2026-11-01T20:00:00Z') - i * 3600e3).toISOString(), championId: role === 'MID' ? 7 : 64, champion: role === 'MID' ? 'LeBlanc' : 'Lee Sin',
      gameMode: 'CLASSIC', position: role, result: result ? 'Sejr' : 'Nederlag', duration: 1800, buys: [],
      review: { v: 4, dur: 1800, at: { 10: { gold: 300 } },
        deaths: win ? [] : [{ t: 290, dead: 30, n: 2, zone: 'Mid' }, { t: 1500, dead: 40, n: 1, zone: 'Top', alone: true, x: 1300, y: 10000 }],
        // Voidgrubs: 3 events inden for 60 sek. = ét objective.
        objectives: [o(300, 'DRAGON', win, win), o(480, 'HORDE', win, win), o(490, 'HORDE', win, win), o(500, 'HORDE', win, win),
          ...(win ? [{ t: 700, k: 'TOWER', mine: true, dead: false }] : [])],
        roams: win ? [{ t: 400, lane: 'Bot', kill: true }] : [],
        ganks: gankWin ? [{ t: 200, lane: 'Top', kill: true, died: false }] : [{ t: 200, lane: 'Top', kill: false, died: true }] } };
  };
  const coachGames = [];
  for (let i = 0; i < 12; i++) coachGames.push(mk(i, 'MID', i % 2 === 0));
  for (let i = 0; i < 12; i++) coachGames.push(mk(12 + i, 'JUNGLE', i % 2 === 0));
  K.history.games.splice(0, K.history.games.length, ...coachGames);
  assert.strictEqual(K.epicTakes(coachGames[0].review, ['HORDE']).length, 1, 'voidgrubs lige efter hinanden tæller som ét');
  const mids = coachGames.filter((g) => g.position === 'MID');
  const jgs = coachGames.filter((g) => g.position === 'JUNGLE');
  for (const a of K.COACH_ADVICE) {
    const s = K.coachSplit(a, a.roles.includes('MID') ? mids : jgs);
    assert(s && s.agrees && s.cost === 1, `rådet ${a.key} udløses: ${JSON.stringify(s && { agg: s.agg, cost: s.cost, agrees: s.agrees })}`);
  }
  const midC = JSON.parse(JSON.stringify(K.coachFor('MID', 7)));
  assert.strictEqual(midC.advice.length, 5, 'højst 5 råd');
  assert.strictEqual(midC.scope, 'dine LeBlanc MID-kampe');
  assert.deepStrictEqual(midC.advice.map((a) => a.key), ['dragon', 'topside', 'objDeath', 'sideAlone', 'outnumbered'], 'lige stærke råd i fast rækkefølge');
  assert.strictEqual(midC.advice[0].evidence, 'Du var ved 0 af 6 drager i dine nederlag mod 6 af 6 i dine sejre.');
  assert.strictEqual(midC.advice[0].extra, 'Med dig ved dragen tog dit hold den i 6 af 6 - uden dig i 0 af 6 (og uden dig var I færre end fjenden ved dragen i 6 af de 6).');
  assert.strictEqual(midC.advice[0].split, 'Kampe under din median (50 %): 0 af 6 sejre - ellers 6 af 6.');
  assert(midC.advice.every((a) => a.next && /^https:\/\//.test(a.url) && a.source), 'næste kamp + kilde');
  const jgC = JSON.parse(JSON.stringify(K.coachFor('JUNGLE', 64)));
  assert(jgC.advice.some((a) => a.key === 'gank') && !jgC.advice.some((a) => a.key === 'roam'), 'ganks for junglere, roams kun for lanere');
  const gank = jgC.advice.find((a) => a.key === 'gank');
  assert.strictEqual(gank.extra, 'Dine kills/assists i lanes før 10 min: 12 top, 0 mid, 0 bot - i 6 af de 12 døde du selv inden for 30 sek.');
  const conv = K.coachSplit(K.COACH_ADVICE.find((a) => a.key === 'convert'), mids);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(conv.agg)), { lossSum: 0, winSum: 6 }, 'kun objectives mellem 10 og 20 min tæller (tårnet ved 11:40, ikke dragen ved 5:00)');
  // Efter kampen: et nederlag har 3 råd med kampens egne tal; en sejr ingen.
  const lossGame = JSON.parse(JSON.stringify(K.coachGame(mids[1])));
  assert.strictEqual(lossGame.advice.length, 3);
  assert.strictEqual(lossGame.advice[0].game, 'I denne kamp var du ved 0 af 1 drager.');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(K.coachGame(mids[0]))).advice, []);
  // For få kampe i rollen: "spil N kampe mere".
  K.history.games.splice(0, K.history.games.length, ...mids.slice(0, 4));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(K.coachFor('MID', 7))), { role: 'MID', scope: 'dine MID-kampe', games: 4, need: 6, advice: [] });
}

console.log('Kampgennemgang (rigtigt format): alle tests bestået');
