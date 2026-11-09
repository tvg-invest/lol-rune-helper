'use strict';
// Falske kampe i League-klientens RIGTIGE format for /lol-match-history/v1/games/{id} og game-timelines/{id}.
// Formen kommer fra match-shapes.json (logget af programmet mod en rigtig klient 9/11-2026: felter og typer,
// ingen navne). Hvert felt starter med en tom værdi af den rigtige type, og testene må kun sætte felter
// der findes i den rigtige form - ellers fejler de. Så kan testene ikke glide over i et antaget format igen
// (v1.18.0 blev skrevet mod et antaget Riot API v5-agtigt format og fandt hverken modstander, guld eller items).
//
// Vigtigt fra den rigtige klient: timelinen har KUN CHAMPION_KILL, BUILDING_KILL og ELITE_MONSTER_KILL
// (ingen ITEM_PURCHASED), alle events har alle felter (participantId 0 på kills), participantFrames er et
// objekt med nøglerne "1".."10", og participants[].timeline.lane/role er klientens eget (upålidelige) gæt.
const SHAPE = require('./match-shapes.json');

const isCount = (x) => typeof x === 'string' && /^\(\d+ stk\.\)$/.test(x);
// Første rigtige element i et form-array (["number", "(3 stk.)"] -> "number").
const elemOf = (arr) => arr.find((x) => !isCount(x));
function dummy(shape) {
  if (Array.isArray(shape)) return [];
  if (shape && typeof shape === 'object') return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, dummy(v)]));
  if (shape === 'number') return 0;
  if (shape === 'string') return '';
  if (shape === 'boolean') return false;
  return shape; // værdier som formen gemmer (fx gameMode "CLASSIC", type "CHAMPION_KILL")
}
// Læg værdier oven på formen - kun felter der findes i den rigtige klients form.
function fill(shape, values, where) {
  const out = dummy(shape);
  for (const [k, v] of Object.entries(values || {})) {
    if (!(k in shape)) throw new Error(`Feltet ${where}.${k} findes ikke i klientens rigtige format (match-shapes.json)`);
    const s = shape[k];
    if (Array.isArray(s)) {
      if (!Array.isArray(v)) throw new Error(`${where}.${k} skal være en liste`);
      const el = elemOf(s);
      out[k] = v.map((x) => (el && typeof el === 'object' ? fill(el, x, `${where}.${k}[]`) : x));
    } else if (s && typeof s === 'object' && Object.keys(s).length) {
      out[k] = fill(s, v, `${where}.${k}`);
    } else out[k] = v;
  }
  return out;
}

// Skabeloner fra den rigtige form.
const T = {
  game: Object.fromEntries(Object.entries(SHAPE.game).filter(([k]) => !['participants', 'participantIdentities', 'teams'].includes(k))),
  participant: elemOf(SHAPE.game.participants),
  identity: elemOf(SHAPE.game.participantIdentities),
  team: elemOf(SHAPE.game.teams),
  frame: elemOf(SHAPE.timeline.frames),
  pframe: Object.values(elemOf(SHAPE.timeline.frames).participantFrames)[0],
  event: SHAPE.timeline.frames.flatMap((f) => (typeof f === 'object' ? f.events : [])).find((e) => e && typeof e === 'object'),
};
if (!T.participant || !T.identity || !T.team || !T.frame || !T.pframe || !T.event) throw new Error('match-shapes.json mangler dele');

// players: [{ id, champ, team, spells: [4, 11], lane: 'JUNGLE', role: 'NONE', puuid, win }]
function lcuGame({ gameId, duration = 1800, players }) {
  const winner = players.find((p) => p.win)?.team ?? 100;
  return {
    ...fill(T.game, { gameId, gameDuration: duration, mapId: 11, gameMode: 'CLASSIC', queueId: 420 }, 'game'),
    participantIdentities: players.map((p) => fill(T.identity, { participantId: p.id, player: { puuid: p.puuid || `puuid-${p.id}` } }, 'participantIdentities[]')),
    participants: players.map((p) => fill(T.participant, {
      participantId: p.id, championId: p.champ, teamId: p.team, spell1Id: p.spells?.[0] ?? 4, spell2Id: p.spells?.[1] ?? 14,
      stats: { participantId: p.id, win: p.team === winner },
      timeline: { participantId: p.id, lane: p.lane || 'NONE', role: p.role || 'NONE' },
    }, 'participants[]')),
    teams: [100, 200].map((teamId) => fill(T.team, { teamId, win: teamId === winner ? 'Win' : 'Fail' }, 'teams[]')),
  };
}

// frame(m, id) -> felter i participantFrames (totalGold, position, minionsKilled, ...).
// events: [{ type, timestamp, killerId, victimId, assistingParticipantIds, position }] - lagt i det minut de skete i.
function lcuTimeline({ minutes, ids, frame, events = [] }) {
  return {
    frames: Array.from({ length: minutes + 1 }, (_, m) => fill(T.frame, {
      timestamp: m ? m * 60000 + 31 : 0, // rigtige frames ligger lidt efter hele minutter
      participantFrames: Object.fromEntries(ids.map((id) => [String(id), fill(T.pframe, { participantId: id, ...(frame(m, id) || {}) }, 'participantFrames')])),
      events: events.filter((e) => Math.ceil(e.timestamp / 60000) === m).map((e) => fill(T.event, e, 'events[]')),
    }, 'frames[]')),
  };
}

module.exports = { lcuGame, lcuTimeline, fill, SHAPE };
