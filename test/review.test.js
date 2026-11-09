'use strict';
// Enhedstest af kampgennemgangen (buildReview) mod klientens RIGTIGE format (test/fixtures/lcu-match.js).
// Kør: node test/review.test.js  (intet internet)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');
const { lcuGame, lcuTimeline, fill, SHAPE } = require('./fixtures/lcu-match');

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
assert.deepStrictEqual(adc.deaths, [{ t: 125, x: 12000, y: 1300, killer: null, by: 'other', n: 0, zone: 'Bot', own: true }], 'tårn-død (killerId 0) på din halvdel');
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

console.log('Kampgennemgang (rigtigt format): alle tests bestået');
