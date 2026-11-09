'use strict';
// Falsk League-klient: spiller en champion select igennem og tjekker hvad lol-helper sender.
// Kør: node test/fake-lcu.test.js  (kræver internet til OP.GG + Data Dragon)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const PASSWORD = 'testpw';
const calls = [];
const state = {
  phase: 'Lobby',
  pickCompleted: false,
  banDone: true,
  championId: 0,
  enemies: [],
  pages: [
    { id: 1, name: 'Min side', isDeletable: true, current: true },
    { id: 2, name: 'Preset', isDeletable: false, current: false },
  ],
  maxPages: 1, // fuld: første POST fejler, så "erstat"-stien testes
  itemSets: { accountId: 77, itemSets: [{ title: 'Mit eget set', associatedChampions: [103], blocks: [] }] },
};

const session = () => ({
  localPlayerCellId: 2,
  myTeam: [
    { cellId: 2, championId: state.championId, championPickIntent: state.myIntent || 0, assignedPosition: 'middle', spell1Id: 14, spell2Id: 4, team: 1 },
    // Robusthed: en holdkammerat der har erklæret sit pick (championPickIntent)
    ...(state.mateIntent ? [{ cellId: 1, championId: 0, championPickIntent: state.mateIntent, assignedPosition: 'top', spell1Id: 4, spell2Id: 12 }] : []),
  ],
  theirTeam: state.enemies.map((championId, i) => ({ cellId: 5 + i, championId, team: 2 })),
  actions: [
    [{ actorCellId: 2, type: 'ban', completed: state.banDone, isInProgress: !state.banDone, championId: state.banDone ? 157 : 0 }],
    [{ actorCellId: 2, type: 'pick', completed: state.pickCompleted, championId: state.championId }],
    // Robusthed: en ekstra ban-tur der starter uden at noget andet ændrer sig
    ...(state.secondBan ? [[{ actorCellId: 2, type: 'ban', completed: false, isInProgress: true, championId: 0 }]] : []),
  ],
});
// Mastery: Ahri, LeBlanc, Syndra (mid) + Lee Sin (jungle, skal filtreres fra til MID)
const MASTERY = [
  { championId: 103, championPoints: 500000 }, { championId: 7, championPoints: 300000 },
  { championId: 134, championPoints: 200000 }, { championId: 64, championPoints: 150000 },
];

// Falske kampe i klientens kamphistorik - i det RIGTIGE format (test/fixtures/lcu-match.js bygger dem ud fra
// formen logget fra en rigtig klient og afviser felter der ikke findes dér).
// 4242 = live-kampen (Ahri mid mod Zed), 5555 = en ældre Evelynn jungle-kamp uden gennemgang,
// 6666 = en Syndra mid-kamp med en fejlbehæftet gennemgang fra v1.18.0 (review.v 1: ingen modstander/guld).
// Klientens lane/role er bevidst forkert flere steder (som i de rigtige data) - modstanderen findes ud fra positionerne.
const { lcuGame, lcuTimeline } = require('./fixtures/lcu-match');
const kill = (t, killerId, victimId, x, y, assistingParticipantIds = []) => ({ type: 'CHAMPION_KILL', timestamp: t, killerId, victimId, assistingParticipantIds, position: { x, y } });
const P = (id, champ, team, lane, role, spells) => ({ id, champ, team, lane, role, spells, puuid: id === 1 ? 'me-puuid' : `p${id}` });
const team10 = (list) => list.map(([id, champ, lane, role, smite]) => P(id, champ, id <= 5 ? 100 : 200, lane, role, [4, smite ? 11 : 14]));
const MATCHES = {
  4242: (() => {
    const players = team10([[1, 103, 'MIDDLE', 'SOLO'], [2, 86, 'TOP', 'SOLO'], [3, 254, 'JUNGLE', 'NONE', true], [4, 222, 'BOTTOM', 'CARRY'], [5, 89, 'BOTTOM', 'SUPPORT'],
      [6, 238, 'NONE', 'SUPPORT'], [7, 122, 'JUNGLE', 'NONE'], [8, 104, 'JUNGLE', 'NONE', true], [9, 202, 'BOTTOM', 'CARRY'], [10, 16, 'BOTTOM', 'SUPPORT']]);
    players[5].win = true;
    return {
      game: lcuGame({ gameId: 4242, players }),
      timeline: lcuTimeline({ minutes: 12, ids: players.map((p) => p.id), events: [kill(300000, 6, 1, 7000, 7400)],
        frame: (m, id) => (id === 1 ? { totalGold: 500 + m * 400, minionsKilled: m * 6, xp: m * 300, position: { x: 7000 + m, y: 7400 } }
          : id === 6 ? { totalGold: 500 + m * 450, minionsKilled: m * 7, xp: m * 320, position: { x: 7600, y: 7600 } }
          : { totalGold: 500 + m * 300 }) }),
    };
  })(),
  5555: (() => {
    const players = team10([[1, 28, 'JUNGLE', 'NONE', true], [2, 86, 'TOP', 'SOLO'], [3, 103, 'MIDDLE', 'SOLO'], [4, 222, 'BOTTOM', 'CARRY'], [5, 89, 'BOTTOM', 'SUPPORT'],
      [6, 122, 'JUNGLE', 'NONE'], [7, 64, 'NONE', 'SUPPORT', true], [8, 238, 'MIDDLE', 'SOLO'], [9, 202, 'BOTTOM', 'CARRY'], [10, 16, 'BOTTOM', 'SUPPORT']]);
    players[0].win = true;
    return {
      game: lcuGame({ gameId: 5555, players }),
      timeline: lcuTimeline({ minutes: 10, ids: players.map((p) => p.id),
        events: [kill(240000, 1, 6, 1500, 11000), kill(500000, 2, 7, 5000, 9000, [1])],
        frame: (m, id) => ({ totalGold: 500 + m * 300, ...(id === 1 ? { position: { x: 3000 + m * 300, y: 8000 } } : id === 6 ? { position: { x: 1300, y: 12000 } }
          : id === 7 ? { position: { x: 11000, y: 6000 + m * 200 } } : {}) }) }),
    };
  })(),
  6666: (() => {
    const players = team10([[1, 134, 'NONE', 'SUPPORT'], [2, 86, 'TOP', 'SOLO'], [3, 254, 'JUNGLE', 'NONE', true], [4, 222, 'BOTTOM', 'CARRY'], [5, 89, 'BOTTOM', 'SUPPORT'],
      [6, 55, 'MIDDLE', 'SOLO'], [7, 234, 'JUNGLE', 'NONE', true], [8, 122, 'JUNGLE', 'NONE'], [9, 202, 'BOTTOM', 'CARRY'], [10, 16, 'BOTTOM', 'SUPPORT']]);
    players[0].win = true;
    return {
      game: lcuGame({ gameId: 6666, players }),
      timeline: lcuTimeline({ minutes: 16, ids: players.map((p) => p.id), events: [kill(360000, 6, 1, 7500, 7700, [7])],
        frame: (m, id) => (id === 1 ? { totalGold: 500 + m * 420, minionsKilled: m * 6, position: { x: 7300, y: 7500 } }
          : id === 6 ? { totalGold: 500 + m * 380, minionsKilled: m * 5, position: { x: 7700, y: 7600 } }
          : id === 8 ? { totalGold: 500 + m * 300, position: { x: 1300, y: 10000 } }
          : { totalGold: 500 + m * 300 }) }),
    };
  })(),
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = Buffer.from(`riot:${PASSWORD}`).toString('base64');
    // Anden kopi af programmet (mønster-testen) logger ind med sin egen adgangskode og har sin egen fase.
    const second = req.headers.authorization === `Basic ${Buffer.from('riot:testpw2').toString('base64')}`;
    // Tredje kopi (replay-testen): egen fase og klientens replay-endpoints.
    const third = req.headers.authorization === `Basic ${Buffer.from('riot:testpw3').toString('base64')}`;
    if (req.headers.authorization !== `Basic ${auth}` && !second && !third) { res.writeHead(401); return res.end(); }
    if (second && req.url === '/lol-gameflow/v1/gameflow-phase') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state.phase2)); }
    if (third && fakeReplayLcu(req, res, body)) return;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const key = `${req.method} ${req.url}`;
    if (key === 'GET /lol-gameflow/v1/gameflow-phase') return send(200, state.phase);
    if (key === 'GET /lol-gameflow/v1/session') return send(200, { gameData: { gameId: 4242, queue: { gameMode: 'CLASSIC' } } });
    if (key === 'GET /riotclient/region-locale') return send(200, { locale: 'da_DK', region: 'EUNE', webLanguage: 'da', webRegion: 'eune' });
    // Kamphistorik og timeline (kampgennemgang) - formen som klientens match-history (participants + participantIdentities, frames pr. minut)
    const mh = /^GET \/lol-match-history\/v1\/(games|game-timelines)\/(\d+)$/.exec(key);
    if (mh && MATCHES[mh[2]]) return send(200, MATCHES[mh[2]][mh[1] === 'games' ? 'game' : 'timeline']);
    if (mh) return send(404, { message: 'no game' });
    if (key.startsWith('GET /lol-match-history/v1/products/lol/current-summoner/matches')) return send(200, { games: { games: state.matchList || [] } });
    if (key === 'GET /lol-champ-select/v1/session') return send(200, session());
    if (key === 'PATCH /lol-champ-select/v1/session/my-selection') return send(204);
    if (key === 'GET /lol-perks/v1/pages') return send(200, state.pages);
    if (key === 'GET /lol-champion-mastery/v1/local-player/champion-mastery') return send(200, MASTERY);
    if (key === 'GET /lol-perks/v1/currentpage') return send(200, state.pages.find((p) => p.current) || null);
    if (req.method === 'DELETE' && req.url.startsWith('/lol-perks/v1/pages/')) {
      const id = Number(req.url.split('/').pop());
      state.pages = state.pages.filter((p) => p.id !== id);
      return send(204);
    }
    if (key === 'POST /lol-perks/v1/pages') {
      if (state.failNextPost) { state.failNextPost = false; return send(400, { message: 'Invalid perks' }); }
      if (state.pages.filter((p) => p.isDeletable).length >= state.maxPages) return send(400, { message: 'Max pages reached' });
      const page = { ...JSON.parse(body), id: 100 + calls.length, isDeletable: true };
      state.pages.forEach((p) => (p.current = false));
      state.pages.push(page);
      return send(200, page);
    }
    if (key === 'GET /lol-summoner/v1/current-summoner') return send(200, { summonerId: 55, accountId: 77, puuid: 'me-puuid' });
    if (key === 'GET /lol-item-sets/v1/item-sets/55/sets') return send(200, state.itemSets);
    if (key === 'PUT /lol-item-sets/v1/item-sets/55/sets') { state.itemSets = JSON.parse(body); return send(201, state.itemSets); }
    send(404, { message: 'unknown ' + key });
  });
});

// Falsk OP.GG matchup-guide (MCP, JSON-RPC) - registrerer hvad programmet spørger om.
const mcpCalls = [];
const scoutCalls = [];
const mcpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rpc = JSON.parse(body);
    const a = rpc.params.arguments;
    if (rpc.params.name === 'lol_get_summoner_profile') {
      // OP.GG's kompakte "class"-format (som den rigtige tjeneste svarer med desired_output_fields)
      scoutCalls.push(a);
      const head = 'class LolGetSummonerProfile: data\nclass Data: summoner\nclass Summoner: updated_at,league_stats,ranked_most_champions\n' +
        'class LeagueStat: game_type,tier_info,win,lose\nclass TierInfo: tier,division,lp\nclass RankedMostChampions: game_type,season_id,play,win,my_champion_stats\nclass MyChampionStat: id,play,win\n\n';
      const now = new Date().toISOString();
      const body2 = a.game_name === 'Fedzed'
        ? `LolGetSummonerProfile(Data(Summoner("${now}",[LeagueStat("SOLORANKED",TierInfo("GOLD",2,40),300,280),LeagueStat("FLEXRANKED",TierInfo(null,null,null),null,null)],RankedMostChampions("RANKED",33,500,290,[MyChampionStat(238,340,207),MyChampionStat(91,160,83)]))))`
        : a.game_name === 'Jg'
          ? `LolGetSummonerProfile(Data(Summoner("${now}",[LeagueStat("SOLORANKED",TierInfo("MASTER",1,120),90,80)],RankedMostChampions("RANKED",33,170,90,[MyChampionStat(64,120,60),MyChampionStat(121,50,30)]))))`
          : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body2 ? { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: head + body2 }] } }
        : { jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'Summoner not found' } }));
    }
    mcpCalls.push(a);
    const data = {
      opponent_champion_tip: `Testtip: sådan slår ${a.my_champion} ${a.opponent_champion}`,
      lane_advantage_champion: a.opponent_champion === 'ZED' ? 'Zed' : 'EVEN',
      lane_solo_kill_advantage_champion: 'EVEN',
      recommended_play_style: 'defensive',
      // Robusthed: mod Jhin har guiden kun 13 kampe bag sig
      ...(a.opponent_champion === 'JHIN' ? { summoner_spells: [{ ids: [4, 14], play: 12 }, { ids: [4, 12], play: 1 }] } : {}),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ data }) }] } }));
  });
});

// Falsk OP.GG jungle-paths-side: samme indlejrede (escaped) dataformat som den rigtige side.
const jungleRequests = [];
const route = (camps, play, rank) => `{\\"route\\":[${camps.map((c) => `\\"${c}\\"`).join(',')}],\\"play\\":${play},\\"rank\\":${rank}}`;
const opggWeb = http.createServer((req, res) => {
  jungleRequests.push(req.url);
  const blue = [route(['BLUE', 'GROMP', 'WOLVES', 'RAPTORS', 'RED', 'KRUG'], 600, 1), route(['RED', 'KRUG', 'RAPTORS', 'WOLVES', 'BLUE', 'GROMP'], 300, 2), route(['RAPTORS', 'RED', 'KRUG', 'WOLVES', 'BLUE', 'GROMP'], 100, 3)];
  const red = [route(['RED', 'KRUG', 'RAPTORS', 'WOLVES', 'BLUE', 'GROMP'], 500, 1)];
  const body = `<script>self.__next_f.push([1,"4e:[{\\"teamName\\":\\"BLUE\\",\\"data\\":{\\"team_key\\":\\"BLUE\\",\\"routes\\":[${blue.join(',')}],\\"play\\":1000},\\"rate\\":{\\"team_key\\":\\"BLUE\\",\\"blue\\":52,\\"red\\":17,\\"raptors\\":29}},{\\"data\\":{\\"team_key\\":\\"RED\\",\\"routes\\":[${red.join(',')}],\\"play\\":500}}]"])</script>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(body);
});

// Falsk OBS (WebSocket v5 med adgangskode): tjekker auth-håndtrykket og registrerer forespørgslerne.
const OBS_PASSWORD = 'hemmelig';
const obsLog = { connections: 0, identified: false, authOk: null, requests: [], dir: null, recordDir: null, lastPath: null, active: false, saves: 0, hold: false, release: null };
const obsServer = http.createServer((req, res) => { res.writeHead(426); res.end(); });
obsServer.on('upgrade', (req, socket) => {
  obsLog.connections++;
  const accept = require('crypto').createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    socket.write(Buffer.concat([head, data]));
  };
  const salt = 'saltsalt';
  const challenge = 'udfordring';
  const sha = (x) => require('crypto').createHash('sha256').update(x).digest('base64');
  send({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge, salt } } });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      const masked = buf[1] & 128;
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      off += masked ? 4 : 0;
      const payload = Buffer.from(buf.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(off + len);
      if (opcode === 8) { socket.end(); return; }
      if (opcode !== 1) continue;
      const m = JSON.parse(payload.toString());
      if (m.op === 1) {
        obsLog.authOk = m.d.authentication === sha(sha(OBS_PASSWORD + salt) + challenge);
        if (!obsLog.authOk) { socket.end(); return; }
        obsLog.identified = true;
        send({ op: 2, d: { negotiatedRpcVersion: 1 } });
      } else if (m.op === 6) {
        const t = m.d.requestType;
        obsLog.requests.push(t);
        let data = {};
        if (t === 'GetReplayBufferStatus') data = { outputActive: obsLog.active };
        if (t === 'StartReplayBuffer') obsLog.active = true;
        if (t === 'SaveReplayBuffer') {
          obsLog.saves++;
          // Filen skrives lidt efter (som i OBS) - eller først når testen slipper den (obsLog.hold).
          const n = obsLog.saves;
          const write = () => {
            obsLog.lastPath = path.join(obsLog.dir, `Replay ${n}.mp4`);
            fs.writeFileSync(obsLog.lastPath, Buffer.alloc(2048, 7));
          };
          if (obsLog.hold) obsLog.release = write;
          else setTimeout(write, 500);
        }
        if (t === 'GetLastReplayBufferReplay') data = { savedReplayPath: obsLog.lastPath };
        if (t === 'GetRecordDirectory') data = { recordDirectory: obsLog.recordDir || obsLog.dir };
        send({ op: 7, d: { requestType: t, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData: data } });
      }
    }
  });
  socket.on('error', () => {});
});

// Falsk Live Client Data API (spillets port 2999). Felter som i Riots dokumentation/eksempel.
const live = { data: null };
const liveServer = http.createServer(async (req, res) => {
  if (live.stallMs) await new Promise((r) => setTimeout(r, live.stallMs)); // spillet hakker
  if (req.url === '/liveclientdata/allgamedata' && live.data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(live.data));
  }
  res.writeHead(404);
  res.end();
});
const player = (name, raw, team, position, items, [kills, deaths, assists], level) => ({
  championName: raw, rawChampionName: `game_character_displayname_${raw}`, isBot: false, isDead: false,
  items: items.map((id, slot) => ({ itemID: id, count: 1, slot, displayName: '', price: 0, canUse: false, consumable: false })),
  level, position, riotId: `${name}#EUW`, riotIdGameName: name, riotIdTagLine: 'EUW', summonerName: `${name}#EUW`,
  scores: { kills, deaths, assists, creepScore: 120, wardScore: 5 }, team, respawnTimer: 0, runes: {}, skinID: 0, summonerSpells: {},
});
function liveGame(zhonyaPart) {
  return {
    activePlayer: {
      riotId: 'Mig#EUW', riotIdGameName: 'Mig', summonerName: 'Mig#EUW', currentGold: 1400, level: 11,
      // 10 af 11 skill-points brugt -> ét ubrugt
      abilities: {
        Passive: { displayName: 'Essence Theft', id: 'AhriPassive' },
        Q: { abilityLevel: 5, displayName: 'Orb of Deception', id: 'AhriQ' },
        W: { abilityLevel: 2, displayName: 'Fox-Fire', id: 'AhriW' },
        E: { abilityLevel: 1, displayName: 'Charm', id: 'AhriE' },
        R: { abilityLevel: 2, displayName: 'Spirit Rush', id: 'AhriR' },
      },
    },
    allPlayers: [
      player('Mig', 'Ahri', 'ORDER', 'MIDDLE', [1056, 3020, zhonyaPart], [3, 2, 4], 11),
      player('Topper', 'Garen', 'ORDER', 'TOP', [3047], [1, 3, 2], 10),
      player('Jungle', 'Vi', 'ORDER', 'JUNGLE', [3047], [2, 3, 5], 10),
      player('Adc', 'Jinx', 'ORDER', 'BOTTOM', [3006], [2, 2, 3], 10),
      player('Supp', 'Leona', 'ORDER', 'UTILITY', [3047], [0, 3, 7], 9),
      player('Fedzed', 'Zed', 'CHAOS', 'MIDDLE', [3142, 6692, 3158], [9, 1, 3], 13),
      player('Tank', 'Darius', 'CHAOS', 'TOP', [3075, 4401, 3047], [2, 3, 2], 11),
      player('Jg', 'Graves', 'CHAOS', 'JUNGLE', [3006], [1, 2, 3], 10),
      player('Bot', 'Jhin', 'CHAOS', 'BOTTOM', [3006], [1, 2, 2], 10),
      player('Heal', 'Soraka', 'CHAOS', 'UTILITY', [3158], [0, 2, 6], 9),
    ],
    events: { Events: [
      { EventID: 0, EventName: 'GameStart', EventTime: 0 },
      { EventID: 1, EventName: 'DragonKill', EventTime: 600, DragonType: 'Fire', Stolen: 'False', KillerName: 'Jungle', Assisters: [] },
      { EventID: 2, EventName: 'TurretKilled', EventTime: 700, TurretKilled: 'Turret_T2_C_05_A', KillerName: 'Mig', Assisters: [] },
    ] },
    gameData: { gameMode: 'CLASSIC', gameTime: 1234.5, mapName: 'Map11', mapNumber: 11, mapTerrain: 'Default' },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(200); }
  throw new Error('Timeout: ' + what);
}
const count = (method) => calls.filter((c) => c.method === method).length;
const runePosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/lol-perks/v1/pages').length;
const autoSet = () => state.itemSets.itemSets.find((s) => s.title.startsWith('Auto: '));
const autoPage = () => state.pages.find((p) => p.name.startsWith('Auto: '));
// Læs vinduets SSE-strøm, indtil en besked opfylder pred (eller tiden løber ud).
async function sseUntil(base, pred, ms) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = '';
  let found = null;
  const end = Date.now() + ms;
  try {
    while (!found && Date.now() < end) {
      const r = await Promise.race([reader.read(), wait(end - Date.now()).then(() => null)]);
      if (!r || r.done) break;
      buf += Buffer.from(r.value).toString();
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const m of parts) {
        try { const s = JSON.parse(m.replace(/^data: /, '')); if (pred(s)) { found = s; break; } } catch {}
      }
    }
  } finally { ctrl.abort(); }
  return found;
}

// ---------- "Se det i replayet": falske replay-endpoints i klienten + falsk Replay API (spillets port) ----------
// Formen er den rigtige klients (LCU /help?format=Full, patch 16.22): configuration, rofls/path, metadata/{id}
// ({state, gameId, downloadProgress}; 404 før der er bedt om download), rofls/{id}/download og /watch ({componentType}).
const rp = { phase: 'Lobby', conf: null, dir: null, meta: {}, expired: new Set(), downloads: [], watches: [], list: [],
  apiUp: false, apiUpAt: 0, time: 0, playbackPosts: [], liveHits: 0, other: [] };
const rpConf = () => ({ gameVersion: '16.22.834.8910', isInTournament: false, isLoggedIn: true, isPatching: false, isPlayingGame: false, isPlayingReplay: false,
  isReplaysEnabled: true, isReplaysForEndOfGameEnabled: true, isReplaysForMatchHistoryEnabled: true, minServerVersion: '', minutesUntilReplayConsideredLost: 30 });
function fakeReplayLcu(req, res, body) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); return true; };
  const key = `${req.method} ${req.url}`;
  if (key === 'GET /lol-gameflow/v1/gameflow-phase') return send(200, rp.phase);
  if (key === 'GET /lol-replays/v1/configuration') return send(200, rp.conf);
  if (key === 'GET /lol-replays/v1/rofls/path') return send(200, rp.dir);
  if (key.startsWith('GET /lol-match-history/v1/products/lol/current-summoner/matches')) return send(200, { games: { games: rp.list } });
  let m = /^GET \/lol-replays\/v1\/metadata\/(\d+)$/.exec(key);
  if (m) {
    const x = rp.meta[m[1]];
    if (!x) return send(404, { errorCode: 'RPC_ERROR', httpStatus: 404, message: 'Plugin found no local metadata. Try using the POST metadata create endpoint first.' });
    const out = { ...x };
    if (x.state === 'downloading') rp.meta[m[1]] = { ...x, state: 'watch', downloadProgress: 100 }; // næste opslag: klar
    return send(200, out);
  }
  m = /^POST \/lol-replays\/v1\/rofls\/(\d+)\/(download|watch)$/.exec(key);
  if (m) {
    const b = body ? JSON.parse(body) : undefined;
    if (m[2] === 'download') {
      rp.downloads.push({ id: Number(m[1]), body: b });
      rp.meta[m[1]] = rp.expired.has(Number(m[1])) ? { state: 'missingOrExpired', gameId: Number(m[1]), downloadProgress: 0 } : { state: 'downloading', gameId: Number(m[1]), downloadProgress: 40 };
    } else {
      rp.watches.push({ id: Number(m[1]), body: b });
      rp.conf.isPlayingReplay = true;
      rp.apiUpAt = Date.now() + 300; // spillet indlæser replayet
      rp.apiUp = true;
    }
    return send(204);
  }
  if (req.url.startsWith('/lol-replays/')) { rp.other.push(key); return send(404, { message: 'ukendt' }); }
  return false;
}
// Falsk spil-port (2999): Replay API'et + Live Client Data, kun "oppe" mens et replay kører. Nede = forbindelsen lukkes (som en lukket port).
const replayServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!rp.apiUp || Date.now() < rp.apiUpAt) return req.socket.destroy();
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/liveclientdata/allgamedata' || req.url === '/liveclientdata/gamestats') { rp.liveHits++; return send(200, liveGame(3191)); }
    if (req.url === '/replay/game') return send(200, { processID: 4242 });
    if (req.url === '/replay/playback' && req.method === 'GET') return send(200, { paused: false, seeking: false, time: rp.time, speed: 1, length: 1560 });
    if (req.url === '/replay/playback' && req.method === 'POST') {
      const b = JSON.parse(body);
      rp.playbackPosts.push(b);
      if (typeof b.time === 'number') rp.time = b.time;
      return send(200, { paused: false, seeking: false, time: rp.time, speed: 1, length: 1560 });
    }
    send(404, {});
  });
});

// Klip der ikke blev koblet til kampen (ældre version, genstart midt i kampen, klip færdigt for sent): programmet finder
// dem i OBS' optagemappe ud fra filens tid og parrer dem med dødsfaldene. Tobias' rigtige kampe og filer: fixtures/obs-clips.js.
async function clipTest(cmd, args, baseEnv, tmp) {
  const OC = require('./fixtures/obs-clips');
  const dir = path.join(tmp, 'cliptest');
  const videos = path.join(dir, 'Videos'); // standardmappen (kendes uden OBS)
  const obsDir = path.join(dir, 'OBS-optagelser'); // kendes kun via OBS' GetRecordDirectory
  fs.mkdirSync(videos, { recursive: true });
  fs.mkdirSync(obsDir);
  const touch = (d, name, at) => { const p = path.join(d, name); fs.writeFileSync(p, Buffer.alloc(256, 1)); fs.utimesSync(p, new Date(at), new Date(at)); return p; };
  // OBS' standardnavn i lokal tid (CET om vinteren), som de rigtige filer.
  const obsName = (at) => { const d = new Date(at + 3600e3).toISOString(); return `Replay ${d.slice(0, 10)} ${d.slice(11, 19).replace(/:/g, '-')}.mp4`; };
  const clipAt = (d, start, sec) => { const at = start + sec * 1000; return touch(d, obsName(at), at); };
  for (const f of OC.files) touch(videos, f.name, Date.parse(f.mtime));
  const review = (start, dur, deaths) => ({ v: 5, start, dur, gv: '16.22.834.8910', pf: 'EUN1', side: 'BLUE', win: false,
    deaths: deaths.map((t) => ({ t, x: 7000, y: 7000, killer: '238', by: 'lane', n: 1, zone: 'Mid', own: true, lvl: 9, dead: 20 })),
    gold: [], team: [], at: {}, path: [], jgPath: [], ganks: [], objectives: [], roams: [] });
  const game = (o) => ({ championId: 7, champion: 'LeBlanc', gameMode: 'CLASSIC', mapNumber: 11, position: 'MID', result: 'Nederlag', kills: 1, assists: 1,
    cs: 150, csPerMin: 6, items: [], buys: [], ...o, deaths: o.review.deaths.length });
  const at = (iso) => Date.parse(iso);
  // A + B: Tobias' rigtige kampe, gemt (som af v1.21/v1.22.0) uden klip: 10 dødsfald/10 filer og 7/7.
  const real = (g) => game({ date: g.date, result: g.result, duration: g.duration, deathLog: g.live.map(([t]) => ({ t, killer: 'Malzahar', helpers: 0 })),
    review: review(g.start, g.dur, g.deaths) });
  // C: 5 dødsfald, 3 klip + 1 klip uden dødsfald (indlæsning + gemme-forsinkelse = 52,6 sek. efter gameCreation).
  const C0 = at('2026-11-08T18:00:00Z');
  const c = [300, 700, 1500].map((t) => clipAt(videos, C0, 52.6 + t));
  const cStray = clipAt(videos, C0, 52 + 1000);
  // D: 3 dødsfald, 1 klip - hvilket dødsfald kan ikke afgøres.
  const D0 = at('2026-11-08T16:00:00Z');
  const dOnly = clipAt(videos, D0, 60 + 900);
  // E: genstart midt i kampen. 5:00-klippet blev gemt før genstarten (pendingClips), 10:00 efter (deathLog),
  // og 15:00-klippet nåede programmet aldrig at få stien på (kun filen findes).
  const E0 = at('2026-11-08T14:00:00Z');
  const e300 = clipAt(videos, E0, 45 + 300.2 + 3.5);
  const e600 = clipAt(videos, E0, 45 + 600.4 + 3.5);
  const e900 = clipAt(videos, E0, 45 + 900 + 3.6);
  // F: klippene ligger i en mappe, som kun OBS kender.
  const F0 = at('2026-11-08T12:00:00Z');
  const f = [500, 1000].map((t) => clipAt(obsDir, F0, 43 + t));
  // Filer der ikke må kobles: ikke et replay-klip, og et replay-klip uden for alle kampe.
  const notClip = touch(videos, 'Min video.mp4', Date.parse(OC.games[0].date) - 600e3);
  const outside = clipAt(videos, at('2026-11-07T10:00:00Z'), 0);
  const running = path.join(videos, 'Replay kamp der kører.mp4');
  fs.writeFileSync(running, 'x');
  const games = [
    real(OC.games[1]), real(OC.games[0]),
    game({ date: new Date(C0 + 1830e3).toISOString(), duration: 1800, deathLog: [], review: review(C0, 1800, [300, 700, 1100, 1500, 1700]) }),
    game({ date: new Date(D0 + 1530e3).toISOString(), duration: 1500, review: review(D0, 1500, [400, 900, 1300]) }),
    game({ date: new Date(E0 + 1680e3).toISOString(), duration: 1600, deathLog: [{ t: 600.4, killer: 'Zed', helpers: 0, clip: e600 }], review: review(E0, 1600, [300, 600, 900, 1200]) }),
    game({ date: new Date(F0 + 1460e3).toISOString(), duration: 1400, review: review(F0, 1400, [500, 1000]) }),
  ];
  const pendingClips = [
    { file: e300, t: 300.2, at: E0 + (45 + 300.2) * 1000, gameId: null, killer: 'Zed' },
    { file: running, t: 100, at: Date.now() - 60e3, gameId: null, killer: 'Zed' }, // kampen kører stadig - bliver stående
  ];
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ games, recent: [], pendingClips }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ obsClips: true, obsPassword: OBS_PASSWORD }));
  const env = { ...baseEnv, LOL_HELPER_HISTORY: path.join(dir, 'history.json'), LOL_HELPER_CONFIG: path.join(dir, 'config.json'),
    LOL_HELPER_SHAPES: path.join(dir, 'lcu-shapes.json'), LOL_HELPER_LCU: 'http:9:ingen', LOL_HELPER_LIVE: 'http:9', LOL_HELPER_REMOTE: '',
    LOL_HELPER_CLIP_DIR: videos };
  const hist = () => JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8'));
  const names = (rv) => rv.review.deaths.map((d) => (d.clip ? d.clip.name : null));
  const start = () => {
    const child = spawn(cmd, args, { env });
    const p = { child, out: '' };
    child.stdout.on('data', (d) => (p.out += d));
    child.stderr.on('data', (d) => (p.out += d));
    p.base = () => /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(p.out)[1];
    p.st = async () => (await fetch(p.base() + '/state')).json();
    return p;
  };
  const connBefore = obsLog.connections;
  let p = start();
  try {
    await waitFor(() => /Data Dragon .* hentet/.test(p.out), 30000, 'klip-kopien starter');
    let s;
    for (let i = 0; i < 30 && !((s = await p.st()).reviews?.length === 6); i++) await wait(200);
    const rv = (iso) => s.reviews.find((r) => r.date === iso);
    // A og B: hvert klip ved det dødsfald, programmet selv koblede det til under kampen (facit), 1:1 i tidsorden.
    for (const g of OC.games) {
      assert.deepStrictEqual(names(rv(g.date)), g.live.map(([, n]) => n), `rigtig kamp ${g.date}: klip ved dødsfaldene`);
      assert.deepStrictEqual(rv(g.date).clips, [], 'ingen løse klip');
    }
    assert.strictEqual(s.reviews.filter((r) => r.review.deaths.some((d) => d.clip)).length, 4, 'A, B, C og E har klip');
    // C: 3 klip ved deres dødsfald (forskydningen fundet i data), klippet uden dødsfald står for sig med anslået tid.
    const C = s.reviews.find((r) => r.review.start === C0) || rv(new Date(C0 + 1830e3).toISOString());
    assert.deepStrictEqual(names(C), [path.basename(c[0]), path.basename(c[1]), null, path.basename(c[2]), null], 'C: klip ved 5:00, 11:40 og 25:00');
    assert.deepStrictEqual(C.clips.map((x) => [x.t, x.name]), [[null, path.basename(cStray)]], 'C: andre klip fra kampen');
    assert(Math.abs(C.clips[0].est - 1000) <= 2, `C: anslået kamptid ${C.clips[0].est}`);
    // D: 1 klip og 3 dødsfald - der gættes ikke.
    const D = rv(new Date(D0 + 1530e3).toISOString());
    assert.deepStrictEqual(names(D), [null, null, null], 'D: intet dødsfald gættet');
    assert.deepStrictEqual(D.clips.map((x) => [x.t, x.est, x.name]), [[null, null, path.basename(dOnly)]], 'D: klippet vises som andet klip');
    // E: genstart midt i kampen - klippet fra før genstarten (pendingClips) og filen uden sti kobles.
    const E = rv(new Date(E0 + 1680e3).toISOString());
    assert.deepStrictEqual(names(E), [path.basename(e300), path.basename(e600), path.basename(e900), null], 'E: klip efter genstart');
    let h = hist();
    const hE = h.games.find((g) => g.date === E.date);
    assert.deepStrictEqual(hE.clipLog.map((x) => [x.t, path.basename(x.file), x.how]), [[300.2, path.basename(e300), 'live'], [900, path.basename(e900), 'anchor']], 'E gemt i history.json');
    assert.deepStrictEqual(h.games.find((g) => g.date === OC.games[0].date).clipLog.map((x) => x.how), Array(10).fill('order'), 'A gemt i history.json');
    assert.deepStrictEqual(h.pendingClips.map((x) => x.file), [running], 'klip fra en kamp der ikke er gemt endnu, bliver stående');
    // F: mappen kendes ikke uden OBS.
    const F = rv(new Date(F0 + 1460e3).toISOString());
    assert.deepStrictEqual(names(F), [null, null], 'F: OBS-mappen er ikke gennemgået endnu');
    assert.strictEqual(obsLog.connections, connBefore, 'ingen OBS-forbindelse uden for kampen ved start');
    // Kun klip der hører til en kamp kan afspilles.
    const play = async (file) => (await fetch(`${p.base()}/clip?f=${encodeURIComponent(file)}`)).status;
    assert.strictEqual(await play(path.join(videos, OC.games[0].live[0][1])), 200, 'fundet klip kan afspilles');
    assert.strictEqual(await play(dOnly), 200, 'andet klip fra kampen kan afspilles');
    assert.strictEqual(await play(notClip), 403, 'andre videoer i mappen afvises');
    assert.strictEqual(await play(outside), 403, 'replay-klip uden for dine kampe afvises');
    assert.strictEqual(await play(running), 403, 'klip fra en kamp der ikke er gemt, afvises');

    // "Find klip til mine kampe": OBS fortæller optagemappen (GetRecordDirectory) - uden at starte replay bufferen.
    obsLog.recordDir = obsDir;
    const reqBefore = obsLog.requests.length;
    const res = await fetch(p.base() + '/api/find-clips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.obsDir, obsDir);
    assert.deepStrictEqual(body.games.map((x) => [x.date, x.files, x.paired, x.other, x.how]), [[new Date(F0 + 1460e3).toISOString(), 2, 2, 0, 'order']], JSON.stringify(body.games));
    const after = obsLog.requests.slice(reqBefore);
    assert(after.includes('GetRecordDirectory'), `GetRecordDirectory: ${after}`);
    assert(!after.includes('StartReplayBuffer') && !after.includes('GetReplayBufferStatus'), `replay bufferen røres ikke: ${after}`);
    assert(!p.out.includes(OBS_PASSWORD), 'adgangskoden logges aldrig');
    s = await p.st();
    assert.deepStrictEqual(names(rv(new Date(F0 + 1460e3).toISOString())), f.map((x) => path.basename(x)), 'F: klip fra OBS-mappen');
    assert.strictEqual(hist().clipDir, obsDir, 'OBS-mappen huskes');
    assert(/Klip fundet til LeBlanc .*: 10 af 10 koblet til et dødsfald \(samme antal klip og dødsfald - parret i tidsorden\)/.test(p.out), 'loggen siger hvordan');

    // Genstart: intet kobles to gange, og alt står der stadig.
    h = hist();
    p.child.kill();
    await wait(500);
    p = start();
    await waitFor(() => /Data Dragon .* hentet/.test(p.out), 30000, 'klip-kopien starter igen');
    for (let i = 0; i < 30 && !((s = await p.st()).reviews?.length === 6); i++) await wait(200);
    assert.deepStrictEqual(hist().games.map((g) => (g.clipLog || []).length), h.games.map((g) => (g.clipLog || []).length), 'intet koblet to gange efter genstart');
    assert.deepStrictEqual(names(rv(OC.games[0].date)), OC.games[0].live.map(([, n]) => n), 'A efter genstart');
    assert(!/Klip fundet/.test(p.out), 'intet nyt at finde efter genstart');
    console.log(`Klip: A ${OC.games[0].live.length}/${OC.games[0].deaths.length}, B ${OC.games[1].live.length}/${OC.games[1].deaths.length}, C 3+1, D 0+1, E genstart, F via OBS - OK`);
  } catch (e) {
    console.log(p.out);
    throw e;
  } finally {
    p.child.kill();
    obsLog.recordDir = null;
  }
}

async function replayTest(cmd, args, baseEnv, tmp) {
  const dir = path.join(tmp, 'replay');
  fs.mkdirSync(path.join(dir, 'Config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'clips'));
  fs.mkdirSync(path.join(dir, 'Replays'));
  rp.dir = path.join(dir, 'Replays');
  rp.conf = rpConf();
  // League's game.cfg (CRLF som på Windows). Må ikke røres uden opt-in.
  const cfgFile = path.join(dir, 'Config', 'game.cfg');
  const cfgOrig = '[General]\r\nEnableReplayApi=0\r\nWindowMode=2\r\n[HUD]\r\nShowTimestamps=1\r\n';
  fs.writeFileSync(cfgFile, cfgOrig);
  const cfgNow = () => fs.readFileSync(cfgFile, 'utf8');
  // Kampe i klientens rigtige format: 8001 (patch 16.22, med klip), 8002 (patch 16.21), 8003 (16.22, udløbet hos Riot).
  const start = Date.parse('2026-11-09T12:00:00Z');
  const versions = { 8001: '16.22.834.8910', 8002: '16.21.830.1234', 8003: '16.22.834.8910' };
  const games = [];
  for (const id of [8001, 8002, 8003]) {
    MATCHES[id] = coachMatch(id, 'MID', false);
    MATCHES[id].game.gameVersion = versions[id];
    MATCHES[id].game.platformId = 'EUN1';
  }
  rp.expired.add(8003);
  const clip = (n) => { const p = path.join(dir, 'clips', `Replay ${n}.mp4`); fs.writeFileSync(p, Buffer.alloc(1024, n)); return p; };
  const g0 = { date: new Date(start).toISOString(), championId: 7, champion: 'LeBlanc', gameMode: 'CLASSIC', mapNumber: 11, position: 'MID', result: 'Nederlag',
    duration: 1560, kills: 2, deaths: 3, assists: 1, cs: 180, csPerMin: 6.9, items: [], buys: [], gameId: 8001,
    // Live-tiden ligger lidt fra timelinens (som i de rigtige kampe: højst 1 sek.) - og ét klip uden dødsfald i timelinen.
    deathLog: [{ t: 305.4, killer: 'Zed', helpers: 0, clip: clip(1) }, { t: 800.7, killer: 'Zed', helpers: 1, clip: clip(2) }, { t: 1500, killer: 'Darius', helpers: 0, clip: clip(3) }],
    review: { v: 3, side: 'BLUE', deaths: [], gold: [], team: [], at: {}, path: [], jgPath: [], ganks: [], objectives: [] } };
  games.push(g0);
  for (const [i, id] of [[1, 8002], [2, 8003]]) {
    games.push({ ...g0, date: new Date(start - i * 3600e3).toISOString(), gameId: id, deathLog: [] });
  }
  // Champion-puljen: LeBlanc MID 9 af 15 (3 ovenfor + 12 her), Ahri MID 1 af 1, Syndra MID 0 af 2, Lee Sin JUNGLE 2 af 3.
  const extra = (champ, championId, position, win, i) => games.push({ date: new Date(start - (10 + i) * 3600e3).toISOString(), championId, champion: champ, gameMode: 'CLASSIC',
    mapNumber: 11, position, result: win ? 'Sejr' : 'Nederlag', duration: 1700, kills: 1, deaths: 1, assists: 1, cs: 150, csPerMin: 6, items: [], buys: [] });
  let k = 0;
  for (let i = 0; i < 12; i++) extra('LeBlanc', 7, 'MID', i < 9, k++);
  extra('Ahri', 103, 'MID', true, k++);
  extra('Syndra', 134, 'MID', false, k++); extra('Syndra', 134, 'MID', false, k++);
  for (let i = 0; i < 3; i++) extra('Lee Sin', 64, 'JUNGLE', i < 2, k++);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ games }));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  // Klientens kamphistorik (kun dig som deltager, som den rigtige liste).
  rp.list = [8001, 8002, 8003].map((id, i) => ({ ...MATCHES[id].game, gameCreation: start - i * 3600e3 - 1700e3, gameDuration: 1560, participants: [MATCHES[id].game.participants[0]] }));
  rp.phase = 'Lobby';
  const env = { ...baseEnv, LOL_HELPER_HISTORY: path.join(dir, 'history.json'), LOL_HELPER_CONFIG: path.join(dir, 'config.json'),
    LOL_HELPER_SHAPES: path.join(dir, 'lcu-shapes.json'), LOL_HELPER_LCU: baseEnv.LOL_HELPER_LCU.replace(/:[^:]+$/, ':testpw3'), LOL_HELPER_REMOTE: '',
    // Spillets port: Replay API og live-data på samme port (som 2999 i virkeligheden).
    LOL_HELPER_LIVE: `http:${replayServer.address().port}`, LOL_HELPER_GAME_CFG: cfgFile, LOL_HELPER_REPLAY_POLL_MS: '100' };
  const child = spawn(cmd, args, { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = () => /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
  const st = async () => (await fetch(base() + '/state')).json();
  const api = async (p, b) => { const r = await fetch(base() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const until = async (fn, ms, what) => { let s; const end = Date.now() + ms; while (Date.now() < end) { s = await st(); if (fn(s)) return s; await wait(200); } throw new Error(`Timeout: ${what}: ${JSON.stringify(s?.replay)}`); };
  try {
    await waitFor(() => /Vindue: http/.test(out), 30000, 'replay-kopien starter');
    // Klientens replay-indstillinger + gennemgange i v5 (med patch) hentes i lobbyen.
    let s = await until((x) => x.replay?.clientPatch === '16.22' && x.reviews?.length >= 3 && x.reviews.every((r) => r.review), 30000, 'replay-tilstand og gennemgange');
    assert.strictEqual(cfgNow(), cfgOrig, 'game.cfg er ikke rørt uden opt-in');
    assert.strictEqual(s.replay.jump, false);
    assert.strictEqual(s.replay.optIn, false);
    assert.strictEqual(s.replay.cfgFound, true);
    assert.strictEqual(s.replay.block, null, `ingen blokering i lobbyen: ${s.replay.block}`);
    const saved = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).games;
    assert.deepStrictEqual(saved.slice(0, 3).map((g) => [g.review.v, g.review.gv, g.review.pf]), [[5, '16.22.834.8910', 'EUN1'], [5, '16.21.830.1234', 'EUN1'], [5, '16.22.834.8910', 'EUN1']], 'v5 med patch og platform');
    const rv = (id) => s.reviews.find((r) => r.gameId === id);
    assert.strictEqual(rv(8001).replay.ok, true);
    assert.strictEqual(rv(8002).replay.ok, false);
    assert(/patch 16\.21 - klienten er på 16\.22/.test(rv(8002).replay.reason), rv(8002).replay.reason);
    // OBS-klip ved dødsfaldene i gennemgangen (live-tid 305,4 og 800,7 mod timelinens 305 og 800); klippet ved 25:00 har intet dødsfald.
    assert.deepStrictEqual(rv(8001).review.deaths.map((d) => [d.t, d.clip && d.clip.name]), [[305, 'Replay 1.mp4'], [800, 'Replay 2.mp4'], [1320, null]], 'klip ved dødsfald');
    assert.deepStrictEqual(rv(8001).clips.map((c) => c.name), ['Replay 3.mp4'], 'kun klip uden dødsfald står for sig');
    const clipRes = await fetch(`${base()}/clip?f=${encodeURIComponent(rv(8001).review.deaths[0].clip.file)}`);
    assert.strictEqual(clipRes.status, 200, 'klippet ved dødsfaldet kan afspilles');

    // Champion-puljen (din egen historik + klientens liste + mastery).
    const pool = s.pool;
    assert(pool, 'pulje-kort');
    const mid = pool.roles.find((r) => r.role === 'MID');
    assert.strictEqual(mid.games, 18);
    assert.deepStrictEqual(mid.champions.map((c) => [c.name, c.wins, c.games, c.few]), [['LeBlanc', 9, 15, true], ['Ahri', 1, 1, true], ['Syndra', 0, 2, true]], 'Wilson: 9 af 15 før 1 af 1');
    assert.deepStrictEqual(mid.best, [7, 103], 'du vinder mest med LeBlanc og Ahri (Syndra har ingen sejre)');
    assert.strictEqual(mid.distinct, 3);
    assert.strictEqual(mid.last, 18);
    assert.deepStrictEqual(mid.champions[0].form, [false, false, false, true, true], 'form: nyeste først');
    assert.deepStrictEqual(mid.champions[0].mastery, { points: 300000, level: null }, 'mastery fra klienten');
    assert.strictEqual(mid.topVsRest, null, 'under 3 kampe uden for top 2 -> ingen sammenligning');
    assert.deepStrictEqual(pool.client && [pool.client.games, pool.client.champions[0].name], [3, 'LeBlanc'], 'klientens liste');
    assert(pool.sources[0].url.includes('itero.gg'));

    // Champion select: én linje når du hover - bedste champion, en anden, og en ny champion.
    rp.phase = 'ChampSelect';
    state.myIntent = 7;
    s = await until((x) => x.poolPick?.championId === 7, 15000, 'pulje-linje for LeBlanc');
    assert.strictEqual(s.poolPick.text, 'LeBlanc: din bedste MID-champion (9 af 15)');
    assert(/få kampe \(under 20\) · 300\.000 mastery-point/.test(s.poolPick.extra), s.poolPick.extra);
    assert.strictEqual(s.replay.block, 'Ikke under champion select.');
    const busy = await api('/api/replay', { gameId: 8001, t: 305 });
    assert.strictEqual(busy.status, 409, 'replay afvises i champion select');
    assert.strictEqual(busy.body.error, 'Ikke under champion select.');
    const busyJump = await api('/api/replay-jump', { enabled: true });
    assert.strictEqual(busyJump.status, 409, 'opt-in afvises i champion select');
    assert.strictEqual(cfgNow(), cfgOrig, 'game.cfg uændret');
    state.myIntent = 103;
    s = await until((x) => x.poolPick?.championId === 103, 15000, 'pulje-linje for Ahri');
    assert.strictEqual(s.poolPick.text, 'Ahri: 1 af 1 i MID - nr. 2 af dine 3 MID-champions (bedste: LeBlanc 9 af 15)');
    state.myIntent = 61;
    s = await until((x) => x.poolPick?.championId === 61, 15000, 'pulje-linje for Orianna');
    assert.strictEqual(s.poolPick.text, 'Ny champion for dig: 0 kampe i rollen MID');
    state.myIntent = 0;
    rp.phase = 'Lobby';
    s = await until((x) => !x.poolPick && x.replay?.block === null, 15000, 'tilbage i lobbyen');
    assert.strictEqual(rp.downloads.length + rp.watches.length, 0, 'intet replay startet indtil nu');

    // 1) Uden opt-in: replayet hentes og startes, men der hoppes ikke (game.cfg røres ikke, ingen kald til Replay API'et).
    let r = await api('/api/replay', { gameId: 8001, t: 305 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    s = await until((x) => x.replay.job?.done || x.replay.job?.error, 15000, 'replay uden spring');
    assert.strictEqual(s.replay.job.error, null, s.replay.job.error);
    assert(/Spol selv til 4:55 \(10 sek\. før 5:05\)/.test(s.replay.job.step), s.replay.job.step);
    assert.deepStrictEqual(rp.downloads, [{ id: 8001, body: { componentType: 'replay-button_match-history' } }], 'download med componentType');
    assert.deepStrictEqual(rp.watches, [{ id: 8001, body: { componentType: 'replay-button_match-history' } }], 'watch med componentType');
    assert.strictEqual(rp.playbackPosts.length, 0, 'uden opt-in: intet hop');
    assert.strictEqual(cfgNow(), cfgOrig, 'game.cfg uændret uden opt-in');
    // Replayet kører på spillets port: live-løkken må ikke tage det for en kamp.
    await waitFor(() => rp.liveHits > 0 || Date.now() - rp.apiUpAt > 4000, 8000, 'live-løkken ser porten');
    await wait(1500);
    s = await st();
    assert.strictEqual(s.live, null, 'et replay er ikke en kamp');
    assert(!/Live: /.test(out), 'ingen live-kamp i loggen');
    // Mens spillet/replayet kører, kan replay-spring ikke slås til.
    const running = await api('/api/replay-jump', { enabled: true });
    assert.strictEqual(running.status, 409);
    assert(/Luk spillet/.test(running.body.error), running.body.error);
    assert.strictEqual(cfgNow(), cfgOrig);
    // Replayet lukkes.
    rp.apiUp = false; rp.conf.isPlayingReplay = false;

    // 2) Udløbet hos Riot.
    r = await api('/api/replay', { gameId: 8003, t: 100 });
    assert.strictEqual(r.status, 200);
    s = await until((x) => x.replay.job?.gameId === 8003 && (x.replay.job.done || x.replay.job.error), 15000, 'udløbet replay');
    assert.strictEqual(s.replay.job.error, 'Riot har ikke replayet længere (udløbet).');
    // Gammel patch afvises før noget kald.
    r = await api('/api/replay', { gameId: 8002, t: 100 });
    assert.strictEqual(r.status, 409);
    assert(/Replays kan kun ses på samme patch/.test(r.body.error));
    assert.strictEqual(rp.downloads.filter((d) => d.id === 8002).length, 0);
    // Ukendt kamp (ikke i din historik) afvises.
    assert.strictEqual((await api('/api/replay', { gameId: 999, t: 1 })).status, 409);

    // 3) Opt-in: backup + EnableReplayApi=1 (kun den linje), CRLF bevaret.
    r = await api('/api/replay-jump', { enabled: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cfgNow(), cfgOrig.replace('EnableReplayApi=0', 'EnableReplayApi=1'), 'kun den ene linje ændret');
    assert.strictEqual(fs.readFileSync(cfgFile + '.lrh-backup', 'utf8'), cfgOrig, 'backup af den oprindelige fil');
    let conf = JSON.parse(fs.readFileSync(env.LOL_HELPER_CONFIG, 'utf8'));
    assert.strictEqual(conf.replayJump, true);
    assert.strictEqual(conf.replayApiBefore, '0', 'den gamle værdi huskes');
    s = await until((x) => x.replay.jump && x.replay.optIn, 10000, 'replay-spring til');

    // 4) Med opt-in: replayet (allerede hentet) startes, programmet venter på Replay API'et og hopper til 10 sek. før.
    const dl = rp.downloads.length;
    r = await api('/api/replay', { gameId: 8001, t: 800 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    s = await until((x) => x.replay.job?.t === 800 && (x.replay.job.done || x.replay.job.error), 20000, 'replay med spring');
    assert.strictEqual(s.replay.job.error, null, s.replay.job.error);
    assert.strictEqual(s.replay.job.step, 'Replayet står på 13:10 - 10 sek. før 13:20.');
    assert.strictEqual(rp.downloads.length, dl, 'allerede hentet: ingen ny download');
    assert.deepStrictEqual(rp.playbackPosts, [{ time: 790, paused: false }], 'POST /replay/playback {time, paused}');
    // Samme replay kører stadig: næste knap hopper bare (ingen ny watch).
    const w = rp.watches.length;
    r = await api('/api/replay', { gameId: 8001, t: 1320 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    s = await until((x) => x.replay.job?.t === 1320 && (x.replay.job.done || x.replay.job.error), 20000, 'hop i kørende replay');
    assert.strictEqual(s.replay.job.step, 'Replayet står på 21:50 - 10 sek. før 22:00.');
    assert.strictEqual(rp.watches.length, w, 'ingen ny watch');
    assert.strictEqual(rp.playbackPosts.at(-1).time, 1310);
    rp.apiUp = false; rp.conf.isPlayingReplay = false;

    // 5) Slå fra: den gamle værdi tilbage - filen er som før.
    r = await api('/api/replay-jump', { enabled: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cfgNow(), cfgOrig, 'game.cfg som før opt-in');
    conf = JSON.parse(fs.readFileSync(env.LOL_HELPER_CONFIG, 'utf8'));
    assert.strictEqual(conf.replayJump, false);
    assert(!('replayApiBefore' in conf));
    assert.deepStrictEqual(rp.other, [], `ingen ukendte replay-endpoints: ${rp.other}`);
    assert(!/Fejl/.test(out), `ingen fejl i replay-kopien: ${out}`);
    console.log('Replay:', rp.downloads.length, 'download,', rp.watches.length, 'watch, hop:', JSON.stringify(rp.playbackPosts));
    console.log('Champion-pulje (MID):', mid.champions.map((c) => `${c.name} ${c.wins}/${c.games}`).join(', '));
  } catch (e) {
    console.log(out);
    throw e;
  } finally {
    state.myIntent = 0;
    child.kill();
  }
}

// "Dine mønstre" fra en syntetisk historik (12 LeBlanc mid-kampe) + gennemgang af en ældre kamp fra klientens kamphistorik.
// Kører som en ekstra kopi af programmet (egen config og historik, egen fase i den falske klient).
async function patternsTest(cmd, args, baseEnv, tmp) {
  const dir = path.join(tmp, 'mønstre');
  fs.mkdirSync(dir);
  const games = [];
  const start = Date.parse('2026-11-01T18:00:00Z');
  for (let i = 0; i < 12; i++) {
    const early = i % 2 === 1; // dødsfald før 14 min i de ulige kampe
    games.push({
      date: new Date(start - i * 3600 * 1000).toISOString(), championId: 7, champion: 'LeBlanc', gameMode: 'CLASSIC', mapNumber: 11, position: 'MID',
      result: i < 7 ? 'Sejr' : 'Nederlag', duration: 1800, kills: 5, deaths: early ? 3 : 1, assists: 4, cs: 200, csPerMin: 6.7, items: ['6655'],
      buys: [{ id: '3020', t: 300, suggested: true, adapted: false }, { id: '6655', t: 600 + i * 30, suggested: true, adapted: false }],
      deathLog: early ? [{ t: 300, killer: 'Lee Sin', helpers: 0, context: null }, { t: 1000, killer: 'Zed', helpers: 0, context: null }] : [{ t: 1000, killer: 'Zed', helpers: 0, context: null }],
      // Gennemgang i det nuværende format (v2): sejre stiger i holdguld, nederlag topper ved 20 min og falder sent.
      review: {
        v: 2, side: 'BLUE', win: i < 7, lane: 'Mid', opp: '238', oppBy: 'live', jg: '64', path: [], pathTo: 14, jgPath: [], ganks: [],
        deaths: (early ? [{ t: 300, x: 2000, y: 9000, killer: '64', by: 'jungle', n: 1, zone: 'Top', own: true }] : [])
          .concat([{ t: 1000, x: 9000, y: 2000, killer: '238', by: 'lane', n: 3, zone: 'Bot', own: false }]),
        gold: [[10, i < 7 ? 300 : -300]],
        team: i < 7 ? [[0, 0], [10, 1000], [14, 1500], [20, 2500], [25, 3000], [30, 4000]]
          : [[0, 0], [10, -500], [14, 500], [20, 3000 + (i - 7) * 1000], [25, 1000], [30, -3000]],
        at: { 10: { cs: 50 + i, oppCs: 50, gold: i < 7 ? 300 : -300, xp: 0 } },
      },
    });
  }
  // En ældre Evelynn jungle-kamp uden kampens id og uden gennemgang (fra før v1.18)
  const evDate = Date.parse('2026-11-02T20:00:00Z');
  games.unshift({ date: new Date(evDate).toISOString(), championId: 28, champion: 'Evelynn', gameMode: 'CLASSIC', mapNumber: 11, position: 'JUNGLE',
    result: 'Sejr', duration: 1800, kills: 8, deaths: 2, assists: 6, cs: 150, csPerMin: 5, items: [], buys: [] });
  state.matchList = [{ gameId: 5555, gameCreation: evDate - 1800 * 1000, gameDuration: 1800, participants: [{ championId: 28 }] }];
  // Klientens kamphistorik til tilt-tallene (klatre-tjekket): 12 kampe i træk i dag, de sidste 2 tabt.
  // Formen som den rigtige liste (list.json fra klienten): participants[0].stats.win, mapId, gameMode, queueId.
  const now = Date.now();
  const winSeq = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0];
  winSeq.forEach((w, i) => state.matchList.push({ gameId: 9000 + i, gameCreation: now - (winSeq.length - i) * 40 * 60e3, gameDuration: 1800, mapId: 11, gameMode: 'CLASSIC',
    queueId: 420, endOfGameResult: 'GameComplete', participants: [{ championId: 7, stats: { win: Boolean(w) } }] }));
  // En ARAM-kamp tæller ikke med.
  state.matchList.push({ gameId: 8999, gameCreation: now - 20 * 3600e3, gameDuration: 900, mapId: 12, gameMode: 'ARAM', queueId: 450, participants: [{ championId: 7, stats: { win: true } }] });
  // En Syndra mid-kamp med en gennemgang fra v1.18.0 (v1: ingen modstander, intet guld, ingen rute for mid, intet resultat).
  games.unshift({ date: '2026-11-03T20:00:00.000Z', championId: 134, champion: 'Syndra', gameMode: 'CLASSIC', mapNumber: 11, position: 'MID',
    result: null, duration: 1000, kills: 3, deaths: 1, assists: 2, cs: 100, csPerMin: 6, items: [], buys: [{ id: '6655', t: 700, suggested: true, adapted: false }], gameId: 6666,
    review: { v: 1, side: 'BLUE', opp: null, jg: '234', deaths: [{ t: 360, x: 7500, y: 7700, killer: '55', by: 'other' }], gold: [], path: [], jgPath: [], ganks: [], items: [] } });
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ games }));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  state.phase2 = 'Lobby';
  const env = { ...baseEnv, LOL_HELPER_HISTORY: path.join(dir, 'history.json'), LOL_HELPER_CONFIG: path.join(dir, 'config.json'),
    LOL_HELPER_SHAPES: path.join(dir, 'lcu-shapes.json'), LOL_HELPER_LCU: baseEnv.LOL_HELPER_LCU.replace(/:[^:]+$/, ':testpw2'), LOL_HELPER_REMOTE: '' };
  const child = spawn(cmd, args, { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await waitFor(() => out.includes('venter på champion select'), 30000, 'mønster-kopien starter');
    const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
    const st = async () => (await fetch(base + '/state')).json();
    const p = (await st()).patterns;
    assert(p && p.groups.length === 1, `mønstre: ${JSON.stringify(p)}`);
    const g = p.groups[0];
    assert.strictEqual(g.champion.name, 'LeBlanc');
    assert.strictEqual(g.position, 'MID');
    assert.strictEqual(g.games, 12);
    assert.strictEqual(g.reviewed, 12, 'kampe med gennemgang');
    const has = (line) => assert(g.lines.includes(line), `mangler "${line}" i ${JSON.stringify(g.lines, null, 1)}`);
    assert(g.lines.some((l) => l.startsWith('Første færdige item (din median 12:45): før: 6 af 6 sejre - senere: 1 af 6 (oftest ')), JSON.stringify(g.lines));
    has('Dødsfald før 14 min: ingen: 4 af 6 sejre - mindst ét: 3 af 6');
    has('Dødsfald før 14 min (6 i 12 kampe): 0 til lane-modstanderen, 6 til fjendens jungler, 0 til andre');
    has('Hvor: 6 af 6 i en lane, 0 i jungle/flod - 0 på fjendens halvdel af kortet');
    has('Alle 18 dødsfald (12 kampe): 6 mod én, 0 mod to, 12 mod tre eller flere');
    has('Før dit første færdige item: 6 dødsfald (0,4 pr. 10 min) - efter: 12 (0,6 pr. 10 min), 12 kampe');
    has('Guld mod lane-modstanderen ved 10 min: foran: 7 af 7 sejre - bagud: 0 af 5 (median +300 g)');
    has('CS ved 10 min (din median 56): over: 1 af 6 sejre - median eller under: 6 af 6');
    has('Holdets guld ved 10 min: foran: 7 af 7 sejre - bagud: 0 af 5');
    has('I 5 nederlag faldt holdets guld mest (pr. minut): tidligt (0-14 min) 0, midt (14-25 min) 0, sent (25+ min) 5');
    has('Tabte føringer: 3 af 5 nederlag hvor holdet var mere end 4.000 g foran (din median for største føring)');
    assert(!g.lines.some((l) => l.startsWith('Dueller') || l.startsWith('Holdets guld ved 20')), 'ingen linje uden data på begge sider');
    assert(p.pending.some((x) => x.champion.name === 'Evelynn' && x.games === 1), `grupper med for få kampe vises med antal: ${JSON.stringify(p.pending)}`);
    console.log('Mønstre:', g.lines.join(' | '));

    // Gennemgang fra v1.18.0 (review.v 1) hentes igen af sig selv i lobbyen: modstanderen findes ud fra
    // positionerne (klientens lane/role siger NONE/SUPPORT), guld/CS ved 10 min, rute for mid og resultatet.
    let sy;
    for (let i = 0; i < 40 && !((sy = (await st()).reviews.find((x) => x.champion === 'Syndra'))?.review); i++) await wait(500);
    assert(sy?.review, `v1-gennemgangen blev hentet igen: ${JSON.stringify(sy)}`);
    assert.strictEqual(sy.review.opp?.name, 'Katarina', 'lane-modstander ud fra positionerne');
    assert.strictEqual(sy.review.oppBy, 'position');
    assert.strictEqual(sy.review.jg?.name, 'Viego');
    assert.deepStrictEqual(sy.review.gold.find((x) => x[0] === 10), [10, 400], 'guld mod modstanderen ved 10 min');
    assert.deepStrictEqual(sy.review.at['10'], { cs: 60, oppCs: 50, gold: 400, xp: 0 });
    assert.strictEqual(sy.review.path.length, 14, 'din position minut 1-14 også for mid');
    assert.deepStrictEqual(sy.review.deaths.map((d) => [d.t, d.killer, d.by, d.n, d.zone, d.own, d.beforeItem]), [[360, 'Katarina', 'lane', 2, 'Mid', false, true]]);
    assert.deepStrictEqual(sy.review.items.map((x) => [x.id, x.t]), [['6655', 700]], 'items fra live-data (klientens timeline har ingen køb)');
    assert.strictEqual(sy.result, 'Sejr', 'manglende resultat udfyldt fra klienten');
    const syHist = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).games.find((x) => x.gameId === 6666);
    assert.strictEqual(syHist.review.v, 5, 'gennemgangen er gemt i det nye format');
    assert(syHist.review.stats && Array.isArray(syHist.review.csm) && Array.isArray(syHist.review.objectives), 'v3: stats, CS pr. minut og objectives');

    // Klatre-tjekket: de 12 LeBlanc-kampe (v2-gennemgange vises stadig) + tilt fra klientens kamphistorik.
    let climb;
    for (let i = 0; i < 40 && !((climb = (await st()).climb)?.tilt); i++) await wait(500);
    assert(climb?.tilt, `klatre-tjek med tilt: ${JSON.stringify(climb)}`);
    assert.strictEqual(climb.scope, 'dine MID-kampe');
    assert.strictEqual(climb.tilt.games, 12, 'kun Summoner\'s Rift-kampe fra klientens liste');
    assert.deepStrictEqual(climb.tilt.after.map((r) => [r.games, r.wins]), [[7, 3], [4, 2], [1, 1], [0, 0]]);
    // Ingen "koster"-linje her: med Syndra-kampen er medianen for dødsfald før 14 min 1, så ingen kampe ligger over den.
    assert(Array.isArray(climb.costs) && climb.costs.every((c) => /\d+ af \d+ sejre/.test(c.text) && c.tip?.url), JSON.stringify(climb.costs));
    // Sidste kamp (Syndra, v3): 1 dødsfald før 14 min mod din median 0,5 i de andre MID-kampe.
    assert.strictEqual(climb.last?.champion, 'Syndra');
    assert.deepStrictEqual(climb.last.leaks.map((l) => [l.text, l.wins]), [['Dødsfald før 14 min: 1 - din median er 0,5.', 'I dine MID-kampe: flere end medianen 3 af 6 sejre - ellers 4 af 6.']]);
    assert(climb.last.leaks[0].tip?.url && climb.last.refs.includes('1 dødsfald - MID i snit i sejre / nederlag: Gold 5,0 / 7,8'), JSON.stringify(climb.last));
    const syRv = (await st()).reviews.find((x) => x.champion === 'Syndra');
    assert.strictEqual(syRv.review.climb?.leaks.length, 1, 'samme tjek i kampgennemgangen');
    assert(/^Foran i lanen ved 10 min i 8 af 13 kampe - vandt 8 af de 8\./.test(climb.lead), climb.lead);
    const guard = (await st()).climbGuard;
    assert(guard && /^2 tab i træk\./.test(guard.text), `tilt-vagten efter 2 tab i træk: ${JSON.stringify(guard)}`);
    const saved = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8'));
    assert.strictEqual(saved.recent.length, 12, 'klientens kamphistorik gemt kompakt i history.json');
    assert.deepStrictEqual(Object.keys(saved.recent[0]).sort(), ['champ', 'dur', 'gv', 'id', 'queue', 'start', 'win']);
    console.log('Klatre-tjek:', climb.last.leaks[0].text, '|', climb.lead, '|', guard.text);

    // Ældre kamp: kampens id findes i klientens kamphistorik (samme champion + sluttidspunkt), gennemgangen hentes
    const r = await (await fetch(base + '/api/review-old', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    // Evelynn mangler gennemgang; de 12 LeBlanc-kampe har v2 (uden klatre-tjekkets tal) og prøves også, men findes ikke i klienten.
    assert.deepStrictEqual([r.found, r.tried], [1, 13], `ældre kampe: ${JSON.stringify(r)}`);
    const ev = (await st()).reviews.find((x) => x.champion === 'Evelynn');
    assert(ev?.review, 'gennemgang af den ældre kamp');
    assert.strictEqual(ev.review.path.length, 8, 'din rute minut 1-8');
    assert.deepStrictEqual(ev.review.path[0], [3300, 8000]);
    assert.strictEqual(ev.review.jg?.name, 'Lee Sin', 'fjendens jungler = den eneste med Smite');
    assert.strictEqual(ev.review.opp?.name, 'Lee Sin', 'en junglers modstander er fjendens jungler');
    assert.deepStrictEqual(ev.review.gold.find((x) => x[0] === 10), [10, 0]);
    assert.strictEqual(ev.review.jgPath.length, 8, 'fjendens junglers rute');
    assert.deepStrictEqual(ev.review.ganks.map((x) => [x.t, x.lane, x.kill, x.victim]), [[240, 'Top', true, 'Darius']], 'ganks i lanes før 10 min (ikke kills i junglen)');
    assert.strictEqual(JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).games.find((x) => x.champion === 'Evelynn').gameId, 5555, 'id gemt');

    // Champion select: du låser LeBlanc mid -> 1-2 linjer om dine mønstre
    state.championId = 7;
    state.pickCompleted = true;
    state.enemies = [];
    state.phase2 = 'ChampSelect';
    let pick = null;
    for (let i = 0; i < 60 && !(pick = (await st()).patternsPick); i++) await wait(500);
    assert(pick && pick.games === 12 && pick.lines.length === 2, `mønstre i champion select: ${JSON.stringify(pick)}`);
    const cp = (await st()).climbPick;
    // Intet fokus-hul her (ingen af hullerne skiller sejre fra nederlag i de 13 MID-kampe - se ovenfor), men tilt-vagten.
    assert(cp && cp.focus === null && /^2 tab i træk/.test(cp.guard?.text), `klatre-tjek i champion select: ${JSON.stringify(cp)}`);
    assert.strictEqual(cp.mastery, null, 'LeBlanc har 300.000 mastery - ingen erfarings-linje');
    console.log('Klatre-tjek i champion select:', cp.guard.text);
    console.log('Mønstre i champion select:', pick.lines.join(' | '));
    assert(!/Fejl/.test(out), `ingen fejl i mønster-kopien: ${out}`);
  } catch (e) {
    console.log(out);
    throw e;
  } finally {
    state.phase2 = 'Lobby';
    child.kill();
  }
}

// Coachen: falske kampe i klientens RIGTIGE format (lcuGame/lcuTimeline), der udløser hvert råd.
// Sejre og nederlag adskiller sig på præcis de ting coachen måler:
//   MID-sejre: ved dragen (minut-billedet før/efter), roam-kill i bot før 14 min, holdet tager tårne 10-20 min.
//   MID-nederlag: bliver i mid (3.840 enheder fra dragen), dør lige før fjendens drage, dør mod 2 fjender,
//                 dør alene i top-lanen efter 20 min.
//   JUNGLE-sejre: gank i top uden at dø bagefter. JUNGLE-nederlag: gank i top og dør selv 15 sek. efter.
// Kampene ligger i historikken med en v3-gennemgang (uden coachens tal) og hentes igen fra klienten i lobbyen.
const DRAGON_PIT = { x: 9800, y: 4400 };
const POS = { mid: { x: 7400, y: 7400 }, top: { x: 1300, y: 10000 }, bot: { x: 10000, y: 1300 }, jg: { x: 5000, y: 9500 }, base: { x: 500, y: 500 }, ebase: { x: 14300, y: 14300 } };
function coachMatch(gameId, role, win) {
  const meChamp = role === 'MID' ? 7 : 64;
  // id 1 = dig. MID: 3 er din jungler. JUNGLE: 3 er din mid. Fjenderne: 6 mid, 7 jungle, 8 top, 9-10 bot.
  const players = team10([[1, meChamp, 'NONE', 'SUPPORT', role === 'JUNGLE'], [2, 86, 'TOP', 'SOLO'], [3, role === 'MID' ? 254 : 103, 'JUNGLE', 'NONE', role === 'MID'],
    [4, 222, 'BOTTOM', 'CARRY'], [5, 89, 'BOTTOM', 'SUPPORT'], [6, 238, 'MIDDLE', 'SOLO'], [7, 234, 'JUNGLE', 'NONE', true], [8, 122, 'TOP', 'SOLO'],
    [9, 202, 'BOTTOM', 'CARRY'], [10, 16, 'BOTTOM', 'SUPPORT']]);
  players[win ? 0 : 5].win = true;
  const ev = [];
  const dragon = (t, killerId) => ({ type: 'ELITE_MONSTER_KILL', timestamp: t, killerId, assistingParticipantIds: [], monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', position: DRAGON_PIT });
  const tower = (t, ownerTeam, x, y) => ({ type: 'BUILDING_KILL', timestamp: t, killerId: 0, assistingParticipantIds: [], teamId: ownerTeam, buildingType: 'TOWER_BUILDING', towerType: 'OUTER_TURRET', laneType: 'MID_LANE', position: { x, y } });
  if (role === 'MID') {
    if (win) {
      ev.push(dragon(320000, 3), dragon(620000, 3));
      ev.push(kill(420000, 1, 9, 10000, 1300, [4])); // roam til bot før 14 min
      ev.push(tower(720000, 200, 8900, 8900), tower(900000, 200, 10500, 1100)); // holdet tager tårne 10-20 min
    } else {
      ev.push(kill(305000, 6, 1, 7400, 7400), dragon(310000, 7)); // dør 5:05, fjenden tager dragen 5:10 mens du er død
      ev.push(dragon(620000, 7));
      ev.push(kill(800000, 6, 1, 7400, 7400, [7])); // mod 2 fjender
      ev.push(kill(1320000, 8, 1, 1300, 10000)); // alene i top-lanen efter 20 min
    }
  } else if (win) {
    ev.push(kill(210000, 1, 8, 1300, 10000, [2]), dragon(620000, 1)); // gank i top, ingen død bagefter
  } else {
    ev.push(kill(210000, 2, 8, 1300, 10000, [1]), kill(225000, 7, 1, 1400, 10100)); // gank i top - du dør 15 sek. efter
    ev.push(dragon(620000, 7));
  }
  const atDragon = (m) => role === 'MID' && win && [5, 6, 10, 11].includes(m);
  const frame = (m, id) => {
    let p;
    if (id === 1) {
      if (role === 'MID') p = atDragon(m) ? DRAGON_PIT : m === 22 || m === 23 ? POS.top : m >= 2 ? POS.mid : POS.base;
      else p = m >= 2 ? POS.jg : POS.base;
    } else if (id === 3) p = role === 'MID' ? POS.jg : (m >= 2 ? POS.mid : POS.base);
    else if (id === 6) p = m >= 2 ? POS.mid : POS.ebase;
    else if (id === 2 || id === 8) p = POS.top;
    else if (id === 7) p = POS.jg;
    else p = POS.bot;
    // Sent i kampen står dine holdkammerater samlet i bot (langt fra top-lanen).
    if (m >= 21 && id >= 2 && id <= 5) p = POS.bot;
    // Lane-guld: du er foran din lane-modstander (6 / fjendens jungler 7) ved 10 min.
    return { totalGold: 500 + m * (id === 1 ? 420 : 380), minionsKilled: m * (id === 1 ? 7 : 6), level: Math.min(18, 1 + Math.floor(m / 2)), position: p };
  };
  return {
    game: lcuGame({ gameId, duration: 1560, players }),
    timeline: lcuTimeline({ minutes: 26, ids: players.map((p) => p.id), events: ev, frame }),
  };
}

async function coachTest(cmd, args, baseEnv, tmp) {
  const dir = path.join(tmp, 'coach');
  fs.mkdirSync(dir);
  const games = [];
  const start = Date.parse('2026-11-05T18:00:00Z');
  const add = (gameId, role, win, i) => {
    MATCHES[gameId] = coachMatch(gameId, role, win);
    games.push({ date: new Date(start - i * 3600e3).toISOString(), championId: role === 'MID' ? 7 : 64, champion: role === 'MID' ? 'LeBlanc' : 'Lee Sin', gameMode: 'CLASSIC',
      mapNumber: 11, position: role, result: win ? 'Sejr' : 'Nederlag', duration: 1560, kills: 3, deaths: 3, assists: 3, cs: 180, csPerMin: 6.9, items: [], buys: [], gameId,
      review: { v: 3, side: 'BLUE', deaths: [], gold: [], team: [], at: {}, path: [], jgPath: [], ganks: [], objectives: [] } });
  };
  // 12 MID-kampe (LeBlanc, 6 sejre) og 11 JUNGLE-kampe (Lee Sin, 6 sejre) - nyeste først: en MID-sejr og et MID-nederlag.
  for (let i = 0; i < 12; i++) add(7000 + i, 'MID', i % 2 === 0, i);
  // OBS-klip af dødsfaldene i MID-nederlaget 7001 (live-tid lidt fra timelinens 5:05, 13:20 og 22:00).
  fs.mkdirSync(path.join(dir, 'clips'));
  const coachClip = (n) => { const p = path.join(dir, 'clips', `Replay c${n}.mp4`); fs.writeFileSync(p, Buffer.alloc(512, n)); return p; };
  games[1].deathLog = [{ t: 305.6, killer: 'Zed', helpers: 0, clip: coachClip(1) }, { t: 799.5, killer: 'Zed', helpers: 1, clip: coachClip(2) }, { t: 1320.9, killer: 'Viktor', helpers: 0, clip: coachClip(3) }];
  for (let i = 0; i < 11; i++) add(7100 + i, 'JUNGLE', i % 2 === 0, 12 + i);
  // 3 TOP-kampe med coachens tal (v4) - for få til råd: "Spil 7 kampe mere med rollen".
  for (let i = 0; i < 3; i++) {
    games.push({ date: new Date(start - (30 + i) * 3600e3).toISOString(), championId: 23, champion: 'Tryndamere', gameMode: 'CLASSIC', mapNumber: 11, position: 'TOP',
      result: i ? 'Nederlag' : 'Sejr', duration: 1800, kills: 1, deaths: 1, assists: 1, cs: 200, csPerMin: 7, items: [], buys: [],
      review: { v: 4, side: 'BLUE', dur: 1800, deaths: [], gold: [], team: [], at: {}, path: [], jgPath: [], ganks: [], roams: [], objectives: [] } });
  }
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ games }));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  state.phase2 = 'Lobby';
  state.championId = 0; state.pickCompleted = false; state.enemies = [];
  const env = { ...baseEnv, LOL_HELPER_HISTORY: path.join(dir, 'history.json'), LOL_HELPER_CONFIG: path.join(dir, 'config.json'),
    LOL_HELPER_SHAPES: path.join(dir, 'lcu-shapes.json'), LOL_HELPER_LCU: baseEnv.LOL_HELPER_LCU.replace(/:[^:]+$/, ':testpw2'), LOL_HELPER_REMOTE: '' };
  const child = spawn(cmd, args, { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await waitFor(() => out.includes('venter på champion select'), 30000, 'coach-kopien starter');
    const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
    const st = async () => (await fetch(base + '/state')).json();
    // v3-gennemgangene hentes igen af sig selv i lobbyen (v4 har coachens tal).
    let coach;
    const ready = (c) => c?.main?.advice?.length && c.others.find((o) => o.role === 'JUNGLE')?.top;
    for (let i = 0; i < 60 && !ready(coach = (await st()).coach); i++) await wait(500);
    assert(coach?.main?.advice?.length, `coach-kort: ${JSON.stringify(coach)}\n${out}`);
    const saved = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).games;
    assert(saved.filter((g) => g.gameId >= 7000).every((g) => g.review.v === 5), 'alle 23 kampe hentet igen i v5');
    const m = coach.main;
    assert.strictEqual(m.role, 'MID');
    assert.strictEqual(m.scope, 'dine LeBlanc MID-kampe', 'championen har 10+ kampe i rollen');
    assert.strictEqual(m.games, 12);
    const keys = m.advice.map((a) => a.key);
    assert(keys.length >= 3 && keys.length <= 5, `3-5 råd: ${keys}`);
    for (const k of ['dragon', 'objDeath', 'sideAlone', 'outnumbered', 'roam', 'convert']) assert(keys.includes(k) || keys.length === 5, `råd ${k} mangler: ${keys}`);
    assert(m.advice.every((a) => /\d+ (af|i) \d+/.test(a.evidence) && a.next && /^https:\/\//.test(a.url) && a.source), `tal + næste kamp + kilde: ${JSON.stringify(m.advice, null, 1)}`);
    const dragon = m.advice.find((a) => a.key === 'dragon');
    if (dragon) {
      assert.strictEqual(dragon.title, 'Vær ved dragen');
      assert.strictEqual(dragon.evidence, 'Du var ved 0 af 12 drager i dine nederlag mod 12 af 12 i dine sejre.');
      assert(/^Skub mid-bølgen/.test(dragon.next), 'MID-rådet om dragen');
    }
    const od = m.advice.find((a) => a.key === 'objDeath');
    if (od) assert.strictEqual(od.evidence, 'Dødsfald der gav fjenden et stort monster: 6 i 6 nederlag (1 pr. kamp) mod 0 i 6 sejre (0 pr. kamp).');
    const alone = m.advice.find((a) => a.key === 'sideAlone');
    if (alone) assert.strictEqual(alone.evidence, 'Dødsfald alene i en sidelane efter 20 min: 6 i 6 nederlag (1 pr. kamp) mod 0 i 6 sejre (0 pr. kamp).');
    // Klip ved rådene: hvert råd får klippene af netop de dødsfald det handler om.
    const clipsOf = (key) => m.advice.find((a) => a.key === key)?.media.clips.map((c) => [c.t, c.clip.name, c.gameId]);
    if (od) assert.deepStrictEqual(clipsOf('objDeath'), [[305, 'Replay c1.mp4', 7001]], 'dø før objective -> klippet fra 5:05');
    if (keys.includes('outnumbered')) assert.deepStrictEqual(clipsOf('outnumbered'), [[800, 'Replay c2.mp4', 7001]], '1 mod 2 -> klippet fra 13:20');
    if (alone) assert.deepStrictEqual(clipsOf('sideAlone'), [[1320, 'Replay c3.mp4', 7001]], 'alene i sidelane -> klippet fra 22:00');
    if (od) assert(/fjenden tog drage 5:10, mens du var død/.test(m.advice.find((a) => a.key === 'objDeath').media.clips[0].what));
    // Ingen klip til dragen (du var ikke død) - men replay-knapper til de drager du ikke var ved.
    if (dragon) {
      const md = m.advice.find((a) => a.key === 'dragon').media;
      assert.strictEqual(md.clips.length, 0);
      assert(md.replay && md.replay.gameId === 7001 && md.replay.moments.length === 2, `replay ved dragen: ${JSON.stringify(md)}`);
      assert.deepStrictEqual(md.replay.moments.map((x) => [x.t, x.what]), [[310, 'Drage 5:10 uden dig - fjenden tog den'], [620, 'Drage 10:20 uden dig - fjenden tog den']]);
    }
    assert(!keys.includes('gank'), 'ganks er kun et jungle-råd');
    // Jungle: ganks (lykkede = ingen død inden for 30 sek.) - og ikke roams.
    const jg = coach.others.find((o) => o.role === 'JUNGLE');
    assert(jg && jg.games === 11 && jg.top, `jungle-rollen: ${JSON.stringify(coach.others)}`);
    const top = coach.others.find((o) => o.role === 'TOP');
    assert(!top, 'TOP er ikke blandt de seneste 20 kampe');
    console.log('Coach (MID):', m.advice.map((a) => `${a.title} - ${a.evidence}`).join(' | '));
    console.log('Coach (JUNGLE):', jg.top.title, '-', jg.top.evidence);

    // Efter kampen: den nyeste kamp (MID-sejr) har intet på den dårlige side; nederlaget (nr. 2) har op til 3 råd.
    const rv = (await st()).reviews;
    const winRv = rv.find((x) => x.date === games[0].date);
    assert.deepStrictEqual(winRv.review.coach?.advice, [], `en god kamp: ${JSON.stringify(winRv.review.coach)}`);
    const lossRv = rv.find((x) => x.date === games[1].date);
    const ga = lossRv.review.coach?.advice || [];
    assert(ga.length === 3, `3 ting fra kampen: ${JSON.stringify(lossRv.review.coach)}`);
    assert(ga.every((a) => /^I denne kamp/.test(a.game) && a.next && a.url), JSON.stringify(ga));
    // Kampgennemgangen: klip ved dødsfaldene og ved rådene fra netop denne kamp.
    assert.deepStrictEqual(lossRv.review.deaths.map((d) => d.clip && d.clip.name), ['Replay c1.mp4', 'Replay c2.mp4', 'Replay c3.mp4']);
    assert.deepStrictEqual(lossRv.clips, [], 'alle klip hører til et dødsfald');
    for (const a of ga) {
      const want = { objDeath: ['Replay c1.mp4'], outnumbered: ['Replay c2.mp4'], sideAlone: ['Replay c3.mp4'] }[a.key];
      if (want) assert.deepStrictEqual(a.moments.filter((x) => x.clip).map((x) => x.clip.name), want, `klip ved ${a.key}`);
    }
    console.log('Coach efter kampen:', ga.map((a) => `${a.title}: ${a.game}`).join(' | '));
    // Jungle-nederlaget: ganks i kampgennemgangen har died = true.
    const jgHist = saved.find((g) => g.gameId === 7101);
    assert.deepStrictEqual(jgHist.review.ganks.map((x) => [x.lane, x.died]), [['Top', true]], 'gank i top, død 15 sek. efter');
    assert.deepStrictEqual(saved.find((g) => g.gameId === 7100).review.ganks.map((x) => [x.lane, x.died]), [['Top', false]]);
    assert.deepStrictEqual(saved.find((g) => g.gameId === 7000).review.roams, [{ t: 420, lane: 'Bot', kill: true }], 'roam-kill i bot');
    assert.deepStrictEqual(saved.find((g) => g.gameId === 7001).review.deaths.filter((d) => d.alone).map((d) => [d.t, d.zone]), [[1320, 'Top']], 'alene i top efter 20 min');
    assert(JSON.stringify(saved.find((g) => g.gameId === 7001).review).length < 6000, 'kort uddrag i history.json');

    // Champion select: du låser LeBlanc mid -> én coach-linje (rollen + championen).
    state.championId = 7;
    state.pickCompleted = true;
    state.phase2 = 'ChampSelect';
    let pick = null;
    for (let i = 0; i < 60 && !(pick = (await st()).coachPick); i++) await wait(500);
    assert(pick && pick.title === m.advice[0].title && pick.next && pick.url && pick.scope === 'dine LeBlanc MID-kampe', `coach i champion select: ${JSON.stringify(pick)}`);
    console.log('Coach i champion select:', `${pick.title}: ${pick.next}`);
    // Tving rollen TOP: kun 3 kampe med coachens tal -> "Spil 7 kampe mere".
    await fetch(base + '/api/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: 'TOP' }) });
    let topPick = null;
    for (let i = 0; i < 40 && !((topPick = (await st()).coachPick)?.need); i++) await wait(500);
    assert.deepStrictEqual(topPick, { need: 7, role: 'TOP' }, `for få TOP-kampe: ${JSON.stringify(topPick)}`);
    await fetch(base + '/api/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: null }) });
    assert(!/Fejl/.test(out), `ingen fejl i coach-kopien: ${out}`);
  } catch (e) {
    console.log(out);
    throw e;
  } finally {
    state.phase2 = 'Lobby';
    state.championId = 0; state.pickCompleted = false;
    child.kill();
  }
}

liveServer.listen(0, '127.0.0.1');
mcpServer.listen(0, '127.0.0.1');
opggWeb.listen(0, '127.0.0.1');
obsServer.listen(0, '127.0.0.1');
replayServer.listen(0, '127.0.0.1');
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const livePort = liveServer.address().port;
  // HELPER_BIN=sti tester den færdige programfil i stedet for scriptet.
  const [cmd, args] = process.env.HELPER_BIN
    ? [path.resolve(process.env.HELPER_BIN), []]
    : [process.execPath, [path.join(__dirname, '..', 'lol-helper.js')]];
  // Midlertidig cache og hjemmemappe, så testen ikke rører rigtige filer (fx autostart i ~/Library).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-helper-test-'));
  // Falsk "say": skriver det programmet siger til en fil i stedet for højttaleren.
  const saidFile = path.join(tmp, 'said.txt');
  const sayCmd = path.join(tmp, 'say.sh');
  fs.writeFileSync(sayCmd, `#!/bin/sh\necho "$1" >> "${saidFile}"\n`, { mode: 0o755 });
  const said = () => { try { return fs.readFileSync(saidFile, 'utf8'); } catch { return ''; } };
  const env = {
    LOL_HELPER_MCP: `http://127.0.0.1:${mcpServer.address().port}/mcp`,
    LOL_HELPER_OPGG_WEB: `http://127.0.0.1:${opggWeb.address().port}`,
    LOL_HELPER_SAY_CMD: sayCmd,
    LOL_HELPER_OBS: `ws://127.0.0.1:${obsServer.address().port}`,
    LOL_HELPER_REVIEW_RETRY_MS: '500',
    LOL_HELPER_CONFIG: path.join(tmp, 'config.json'),
    ...process.env,
    HOME: tmp,
    LOL_HELPER_CACHE: path.join(tmp, 'cache'),
    LOL_HELPER_HISTORY: path.join(tmp, 'history.json'),
    LOL_HELPER_SHAPES: path.join(tmp, 'lcu-shapes.json'),
    LOL_HELPER_UPDATE_URL: 'http://127.0.0.1:9/ingen-opdatering',
    LOL_HELPER_LCU: `http:${port}:${PASSWORD}`,
    LOL_HELPER_LIVE: `http:${livePort}`,
    LOL_HELPER_PORT: '0',
    LOL_HELPER_NO_WINDOW: '1',
    LOL_HELPER_REMOTE: process.env.NO_REMOTE ? '' : '1',
    LOL_HELPER_CLIP_DIR: path.join(tmp, 'Videos'),
  };
  // config.json med BOM (som Notesblok/PowerShell kan gemme) skal kunne læses. remoteLan: telefon-testen bruger wifi-adressen.
  fs.writeFileSync(env.LOL_HELPER_CONFIG, `\uFEFF{ "remoteLan": true, "obsPassword": "${OBS_PASSWORD}" }\n`);
  obsLog.dir = path.join(tmp, 'replays');
  fs.mkdirSync(obsLog.dir);
  obsLog.lastPath = path.join(obsLog.dir, 'Replay gammel.mp4'); // et klip fra før - må ikke kunne hentes via vinduet
  fs.writeFileSync(obsLog.lastPath, 'gammel');
  const oldClip = obsLog.lastPath;
  fs.utimesSync(oldClip, new Date(Date.now() - 2 * 86400e3), new Date(Date.now() - 2 * 86400e3));
  const child = spawn(cmd, args, { env });
  const tokenFile = path.join(process.env.HELPER_BIN ? path.dirname(cmd) : path.join(__dirname, '..'), 'remote-token.txt');
  const hadToken = fs.existsSync(tokenFile);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const gui = async (method, p, body) => {
    const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: p === '/' ? await res.text() : await res.json() };
  };
  try {
    await waitFor(() => out.includes('venter på champion select'), 20000, 'forbindelse');
    const page = await gui('GET', '/');
    assert(page.body.includes('LoL Rune Helper'), 'vinduet serveres');
    // Robusthed: Data Dragon gemt på disken (start uden internet bruger den)
    assert(fs.existsSync(path.join(env.LOL_HELPER_CACHE, 'ddragon.json')), 'Data Dragon gemt til offline-start');
    // Stemme/overlay/policy: overlayet viser intet om modstandernes items eller "fed", QR-scriptet har SRI-hash
    // enemyAlerts (standard til): overlayet kan vise "Fed:" og modstanderens seneste køb, scoreboardet FED-mærke
    assert(page.body.includes("'Fed: '") && page.body.includes('plan.log[0]'), 'overlay med modstander-notifikationer');
    assert(page.body.includes('fedtag'), 'FED-mærke på scoreboardet');
    assert(/sc\.integrity = 'sha384-/.test(page.body), 'QR-script med SRI');
    assert(page.body.includes('function morph('), 'vinduet opdateres uden at blive bygget forfra');
    const st0 = (await gui('GET', '/state')).body;
    assert.strictEqual(st0.minGames, 150, 'grænse for få matchup-kampe sendes til vinduet');

    // 0) Draft: din tur til at banne -> ban-forslag ud fra din pulje; Zed vælges -> counterpicks
    state.phase = 'ChampSelect';
    state.banDone = false;
    let d;
    for (let i = 0; i < 60 && !(d = (await gui('GET', '/state')).body.draft)?.bans; i++) await wait(500);
    assert(d, 'draft-visning');
    assert.strictEqual(d.position, 'MID');
    assert.strictEqual(d.myBanTurn, true, 'din tur til at banne');
    const poolNames = d.pool.map((c) => c.name);
    assert(poolNames.includes('Ahri') && poolNames.includes('Syndra'), `pulje: ${poolNames}`);
    assert(!poolNames.includes('Lee Sin'), 'jungle-champion filtreret fra til MID');
    assert(d.bans.length >= 1 && d.bans.every((b) => b.reason.includes(' vinder ')), `ban-forslag: ${JSON.stringify(d.bans)}`);
    console.log('Ban-forslag:', d.bans.map((b) => `${b.name}: ${b.reason}`).join(' | '));
    assert.strictEqual(d.bansFor, null, 'uden hover: bans mod puljen');
    // 0b) Du hover Ahri (erklæret pick) -> bans mod netop Ahri
    state.myIntent = 103;
    for (let i = 0; i < 60 && (d = (await gui('GET', '/state')).body.draft)?.bansFor?.name !== 'Ahri'; i++) await wait(500);
    assert.strictEqual(d.bansFor?.name, 'Ahri', `bans til hovered champion: ${JSON.stringify(d.bansFor)}`);
    assert(d.bans.length >= 1 && d.bans.every((b) => b.reason.startsWith('Ahri vinder kun ') && b.name !== 'Ahri'), `bans mod Ahri: ${JSON.stringify(d.bans)}`);
    console.log('Bans til Ahri:', d.bans.map((b) => `${b.name}: ${b.reason}`).join(' | '));
    state.myIntent = 0;
    for (let i = 0; i < 60 && (d = (await gui('GET', '/state')).body.draft)?.bansFor; i++) await wait(500);
    assert.strictEqual(d.bansFor, null, 'hover fjernet: tilbage til puljen');
    state.banDone = true;
    state.enemies = [238]; // Zed låst før dig
    for (let i = 0; i < 60 && !(d = (await gui('GET', '/state')).body.draft)?.opponent; i++) await wait(500);
    assert.strictEqual(d.opponent?.name, 'Zed', 'lane-modstander i draft');
    assert.strictEqual(d.myBanTurn, false);
    assert(d.poolVs.length >= 1 && d.counters.length >= 1, `counterpicks: ${JSON.stringify({ poolVs: d.poolVs.length, counters: d.counters.length })}`);
    assert(!d.bans.some((b) => b.name === 'Zed'), 'valgte champions foreslås ikke som ban');
    console.log('Mod Zed:', d.poolVs.map((x) => `${x.name} ${(x.winRate * 100).toFixed(1)}%`).join(', '), '| counters:', d.counters.map((x) => `${x.name} ${(x.winRate * 100).toFixed(1)}%`).join(', '));
    assert(fs.existsSync(path.join(env.LOL_HELPER_CACHE, 'GLOBAL_roles.json')), 'rollefordeling hentet i ét kald');

    // 0-robust a) En holdkammerats erklærede pick foreslås ikke som ban
    if (d.bans.length) {
      const mateBan = d.bans[0];
      state.mateIntent = mateBan.id;
      for (let i = 0; i < 40 && (d = (await gui('GET', '/state')).body.draft)?.bans?.some((b) => b.id === mateBan.id); i++) await wait(500);
      assert(!d.bans.some((b) => b.id === mateBan.id), `holdkammeratens pick (${mateBan.name}) foreslås ikke som ban`);
      state.mateIntent = 0;
    }
    // 0-robust b) Ny ban-tur uden andre ændringer -> vinduet får besked med det samme (SSE), ikke først ved næste ændring
    {
      const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
      await wait(2000); // lad draften falde til ro
      const seen = sseUntil(base, (s) => s.draft?.myBanTurn === true, 6000);
      await wait(300);
      state.secondBan = true;
      assert(await seen, 'din tur til at banne vises straks i vinduet');
      state.secondBan = false;
    }
    if (process.env.HOLD_DRAFT) {
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_DRAFT));
    }
    state.enemies = [];

    // 1) Hover Ahri uden at låse -> intet sættes, men buildet hentes allerede (disk-cache)
    state.phase = 'ChampSelect';
    state.championId = 103;
    await wait(2500);
    assert.strictEqual(runePosts(), 0, 'må ikke sætte runer før champion er låst');
    assert(fs.existsSync(path.join(env.LOL_HELPER_CACHE, 'GLOBAL_ranked_103_MID.json')), 'build hentet på forhånd under hover');

    // 2) Lås Ahri
    state.pickCompleted = true;
    await waitFor(() => count('PUT') === 1, 20000, 'item set PUT');
    await wait(3500); // giv den tid til evt. dobbelt-anvendelse
    assert.strictEqual(autoPage().selectedPerkIds.length, 9, '9 perks (4+2+3)');
    assert(autoPage().current, 'auto-siden er aktiv');
    assert(!state.pages.some((p) => p.name === 'Min side'), 'fuld: brugerens aktive side erstattet');
    assert(state.pages.some((p) => p.name === 'Preset'), 'preset-side urørt');
    assert.strictEqual(runePosts(), 2, 'én fejlet POST + én vellykket');
    const spells = calls.find((c) => c.method === 'PATCH').body;
    assert.strictEqual(spells.spell2Id, 4, `Flash bliver på F (keep): ${JSON.stringify(spells)}`);
    assert.strictEqual(state.itemSets.accountId, 77);
    assert(state.itemSets.itemSets.some((s) => s.title === 'Mit eget set'), 'brugerens eget set bevaret');
    assert.deepStrictEqual(autoSet().associatedChampions, [103]);
    assert.strictEqual(count('PUT'), 1, 'kun anvendt én gang');
    // Robusthed: klientens dataformat gemt én gang (felter og typer, ingen navne)
    await waitFor(() => fs.existsSync(env.LOL_HELPER_SHAPES), 10000, 'lcu-shapes.json');
    const shapes = JSON.parse(fs.readFileSync(env.LOL_HELPER_SHAPES, 'utf8'));
    assert(shapes.champSelect?.actions && shapes.champSelect.myTeam?.[0]?.cellId === 2, `LCU-format: ${JSON.stringify(shapes).slice(0, 300)}`);
    assert(Array.isArray(shapes.pages) && shapes.itemSets, 'rune-sider og item sets med i formatet');

    // 3) Modstanderne vælger et AD-tungt hold med healing -> items opdateres, Zed gættes som lane-modstander,
    //    og runerne skiftes kun til matchup-siden (auto-siden er urørt)
    state.enemies = [122, 238, 202, 104, 266]; // Darius, Zed, Jhin, Graves, Aatrox
    await waitFor(() => count('PUT') === 2, 20000, 'item set efter modstandere');
    await wait(500);
    let st3 = (await gui('GET', '/state')).body;
    assert.strictEqual(st3.matchup?.name, 'Zed', `lane-modstander gættet: ${JSON.stringify(st3.matchup)}`);
    assert(st3.matchup.winRate > 0.3 && st3.matchup.games > 100, 'matchup win rate fra OP.GG');
    assert(st3.notes.some((n) => n.startsWith('Mod Zed:')), 'matchup-note');
    if (st3.runeOptions[0].matchup) {
      assert.strictEqual(st3.runeOptions[0].matchup, 'Zed');
      // Den aktive side er matchup-siden: enten skiftet nu, eller den var allerede identisk.
      assert.strictEqual(st3.runeIndex, 0, 'matchup-siden er den aktive');
      if (runePosts() === 3) assert(out.includes('Runer skiftet til matchuppet mod Zed'), 'log om matchup-runer');
      else assert.strictEqual(runePosts(), 2, 'samme side -> intet at skifte');
    } else {
      assert.strictEqual(runePosts(), 2, 'ingen matchup-rune -> runer røres ikke');
    }
    // Gameplan mod Zed (matchup-guide + tal)
    let plan;
    for (let i = 0; i < 40 && (plan = (await gui('GET', '/state')).body.plan)?.opponent?.name !== 'Zed'; i++) await wait(500);
    assert.strictEqual(plan?.opponent?.name, 'Zed', `gameplan mod Zed: ${JSON.stringify(plan)?.slice(0, 200)}`);
    assert(mcpCalls.some((c) => c.my_champion === 'AHRI' && c.opponent_champion === 'ZED' && c.position === 'mid'), `MCP-kald: ${JSON.stringify(mcpCalls)}`);
    assert(plan.tip.startsWith('Testtip'), plan.tip);
    assert.strictEqual(plan.laneAdvantage, 'Zed');
    assert.strictEqual(plan.soloKill, 'jævn');
    assert.strictEqual(plan.playStyle, 'Defensiv');
    assert(plan.winRate > 0.3 && plan.games > 100, 'matchup win rate i planen');
    assert(plan.myCore.length >= 2 && plan.oppCore.length >= 2, 'core builds for begge');
    assert(plan.scaling && /skalerer/.test(plan.scaling), `skalering: ${plan.scaling}`);
    assert.strictEqual(plan.now, null, 'ingen "lige nu" før kampen');
    // Matchup-plan i faser
    const phase = (k) => plan.phases.find((x) => x.key === k);
    assert(phase('lane')?.lines.some((l) => l.startsWith('Zed har lane-fordel')), `laning-fase: ${JSON.stringify(plan.phases)}`);
    assert(phase('lane').lines.some((l) => /^Start/.test(l)) && phase('lane').lines.some((l) => /^(Max|Mod Zed maxer)/.test(l)), 'start og skill-max i laning-fasen');
    assert(phase('spike')?.lines.some((l) => l.startsWith('Dit første power spike: ')), 'første power spike');
    assert(phase('late')?.lines.some((l) => /skalerer/.test(l)), 'skalering i lategame-fasen');
    assert.strictEqual(plan.phaseNow, null, 'ingen aktuel fase før kampen');
    console.log('Faser:', plan.phases.map((x) => `${x.title}: ${x.lines.join(' / ')}`).join(' || '));
    console.log('Gameplan:', JSON.stringify({ lane: plan.laneAdvantage, solo: plan.soloKill, stil: plan.playStyle, skalering: plan.scaling, han: plan.oppCore.map((i) => i.name) }));

    // Fjendens jungler i champion select: gættet ud fra holdet (Graves), side fra myTeam[].team (1 = blå -> fjenden er rød)
    let ej;
    for (let i = 0; i < 40 && !(ej = (await gui('GET', '/state')).body.enemyJungle); i++) await wait(500);
    assert.strictEqual(ej?.champion?.name, 'Graves', `fjendens jungler: ${JSON.stringify(ej)}`);
    assert.strictEqual(ej.guessed, true);
    assert(jungleRequests.includes('/lol/champions/graves/jungle-paths/jungle'), `URL: ${jungleRequests}`);
    assert.deepStrictEqual(ej.sides.map((x) => x.side), ['RED'], 'kun fjendens side');
    assert.strictEqual(ej.sides[0].text, 'Graves (rød side): starter på top-siden i 100% af kampene, første clear ender på bot-siden i 100%');
    assert.strictEqual(ej.sides[0].games, 500);
    assert.deepStrictEqual(ej.sides[0].routes[0].camps, ['Red', 'Krugs', 'Raptors', 'Wolves', 'Blue', 'Gromp']);
    console.log('Fjendens jungler:', ej.sides[0].text);

    const titles = autoSet().blocks.map((b) => b.type);
    assert(titles.includes('Mod deres hold'), `counter-blok mangler: ${titles}`);
    const boots = autoSet().blocks.find((b) => b.type === 'Støvler');
    assert.strictEqual(boots.items[0].id, '3047', 'Plated Steelcaps mod AD-tungt hold');

    // 4) Vinduet: state + vælg rune-side nr. 2
    let st = (await gui('GET', '/state')).body;
    assert.strictEqual(st.champion.name, 'Ahri');
    assert(st.runeOptions.length >= 2, 'mindst 2 rune-alternativer');
    assert(st.notes.length >= 1, 'noter om tilpasning');
    assert.strictEqual(st.enemy.champions.length, 5);
    const r = await gui('POST', '/api/rune', { index: 1 });
    assert.strictEqual(r.status, 200);
    st = (await gui('GET', '/state')).body;
    assert.strictEqual(st.runeIndex, 1);
    assert.strictEqual(autoPage().selectedPerkIds[0], calls.filter((c) => c.method === 'POST').pop().body.selectedPerkIds[0]);
    assert.strictEqual(state.pages.filter((p) => p.name.startsWith('Auto: ')).length, 1, 'stadig kun én auto-side');

    // 4a) En rune-side du selv har lavet slettes ikke, hvis klienten afviser auto-siden af en anden grund
    state.maxPages = 5;
    state.pages.push({ id: 50, name: 'Min nye side', isDeletable: true, current: false });
    state.failNextPost = true;
    assert.strictEqual((await gui('POST', '/api/rune', { index: 0 })).status, 500, 'fejl meldes');
    assert(state.pages.some((p) => p.name === 'Min nye side'), 'din egen side er urørt');
    assert.strictEqual((await gui('POST', '/api/rune', { index: 1 })).status, 200, 'virker igen bagefter');
    state.pages = state.pages.filter((p) => p.id !== 50);
    state.maxPages = 1;

    // 4b) Du ændrer selv rune-siden, og vælger så Zed som modstander manuelt -> din side røres ikke
    autoPage().selectedPerkIds = [...autoPage().selectedPerkIds].reverse();
    const postsBeforeManual = runePosts();
    assert.strictEqual((await gui('POST', '/api/opponent', { championId: 999 })).status, 400, 'ukendt modstander afvises');
    const putsOpp = count('PUT');
    assert.strictEqual((await gui('POST', '/api/opponent', { championId: 202 })).status, 200);
    await waitFor(() => count('PUT') > putsOpp, 20000, 'opdatering efter manuel modstander');
    st = (await gui('GET', '/state')).body;
    assert.strictEqual(st.matchup.name, 'Jhin');
    assert.strictEqual(st.matchup.manual, true);
    for (let i = 0; i < 40 && (await gui('GET', '/state')).body.plan?.opponent?.name !== 'Jhin'; i++) await wait(500);
    assert.strictEqual((await gui('GET', '/state')).body.plan?.opponent?.name, 'Jhin', 'gameplan følger manuelt valgt modstander');
    // Robusthed: guiden mod Jhin har kun 13 kampe -> ingen lane-fordel/spillestil, men tippet vises
    const jhinPlan = (await gui('GET', '/state')).body.plan;
    assert.strictEqual(jhinPlan.laneAdvantage, null, 'ingen lane-fordel på 13 kampe');
    assert.strictEqual(jhinPlan.playStyle, null, 'ingen spillestil på 13 kampe');
    assert(jhinPlan.tip?.startsWith('Testtip'), 'tippet vises stadig');
    assert.strictEqual(runePosts(), postsBeforeManual, 'din egen rune-side overskrives ikke');
    const putsAuto = count('PUT');
    await gui('POST', '/api/opponent', { championId: null });
    await waitFor(() => count('PUT') > putsAuto, 20000, 'tilbage til automatisk modstander');
    st = (await gui('GET', '/state')).body;
    assert.strictEqual(st.matchup.name, 'Zed', 'automatisk igen');
    assert.strictEqual(runePosts(), postsBeforeManual, 'stadig ikke overskrevet');

    // 4c) Kun én kopi: en ny start på samme port lukker sig selv
    const winPort = /Vindue: http:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1];
    const second = spawn(cmd, [...args, '--autostart'], { env: { ...env, LOL_HELPER_PORT: winPort } });
    let out2 = '';
    second.stdout.on('data', (d) => (out2 += d));
    const code2 = await new Promise((resolve) => { const t = setTimeout(() => { second.kill(); resolve('timeout'); }, 10000); second.on('exit', (c) => { clearTimeout(t); resolve(c); }); });
    assert.strictEqual(code2, 0, `anden kopi skal lukke: ${code2} ${out2}`);
    assert(out2.includes('kører allerede'), out2);

    // 4d) Autostart til/fra (macOS: LaunchAgent i den midlertidige hjemmemappe)
    if (process.platform === 'darwin') {
      const plist = path.join(tmp, 'Library', 'LaunchAgents', 'dk.tvginvest.lolrunehelper.plist');
      assert.strictEqual(st.autostart, false);
      assert.strictEqual((await gui('POST', '/api/autostart', { enabled: true })).body.enabled, true);
      const xml = fs.readFileSync(plist, 'utf8');
      assert(xml.includes('<string>--autostart</string>') && xml.includes(`<string>${cmd}</string>`), xml);
      assert.strictEqual((await gui('GET', '/state')).body.autostart, true);
      assert.strictEqual((await gui('POST', '/api/autostart', { enabled: false })).body.enabled, false);
      assert(!fs.existsSync(plist), 'plist fjernet');
    }

    // Valgfrit: HOLD_SELECT=ms holder champion select åben, fx til node test/screenshot.js <url>.
    if (process.env.HOLD_SELECT) {
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_SELECT));
    }

    // 5) Vinduet: skift rolle til TOP -> alt sættes igen med TOP-data
    const putsBefore = count('PUT');
    assert.strictEqual((await gui('POST', '/api/role', { position: 'TOP' })).status, 200);
    await waitFor(() => count('PUT') > putsBefore, 20000, 'anvend efter rolleskift');
    await wait(300);
    st = (await gui('GET', '/state')).body;
    assert.strictEqual(st.position, 'TOP');
    assert(autoSet().title.endsWith('TOP'), autoSet().title);
    assert.strictEqual((await gui('POST', '/api/role', { position: 'XYZ' })).status, 400, 'ukendt rolle afvises');

    // 5b) Rolle JUNGLE -> jungle-ruter fra OP.GG's side (Data Dragon-id med små bogstaver i URL'en)
    assert.strictEqual((await gui('POST', '/api/role', { position: 'JUNGLE' })).status, 200);
    let jg;
    for (let i = 0; i < 40 && !(jg = (await gui('GET', '/state')).body.jungle); i++) await wait(500);
    assert(jg, 'jungle-ruter vises');
    assert(jungleRequests.includes('/lol/champions/ahri/jungle-paths/jungle'), `URL: ${jungleRequests}`);
    assert.deepStrictEqual(jg.BLUE[0].camps, ['Blue', 'Gromp', 'Wolves', 'Raptors', 'Red', 'Krugs']);
    assert(Math.abs(jg.BLUE[0].share - 0.6) < 0.001, `andel: ${jg.BLUE[0].share}`);
    assert.strictEqual(jg.BLUE.length, 3);
    assert.strictEqual(jg.RED[0].games, 500);
    assert.deepStrictEqual(jg.rate?.BLUE, { blue: 52, red: 17, raptors: 29 }, `start-camps: ${JSON.stringify(jg.rate)}`);
    assert(!jg.rate.RED, 'ingen start-camps for rød side i den falske side');
    // 5c) Robusthed: rolle tilbage til MID -> rutekortet forsvinder
    const putsMid = count('PUT');
    assert.strictEqual((await gui('POST', '/api/role', { position: 'MID' })).status, 200);
    await waitFor(() => count('PUT') > putsMid, 20000, 'anvend efter rolle MID');
    let stMid;
    for (let i = 0; i < 40 && ((stMid = (await gui('GET', '/state')).body).position !== 'MID' || stMid.jungle); i++) await wait(500);
    assert.strictEqual(stMid.position, 'MID');
    assert.strictEqual(stMid.jungle, null, 'ingen jungle-ruter efter skift væk fra JUNGLE');

    // 6) Næste kamp: auto-siden genbruges, ingen ekstra item sets, rolle-override nulstilles
    state.phase = 'Lobby';
    await wait(2500);
    const putsLobby = count('PUT');
    state.phase = 'ChampSelect';
    await waitFor(() => count('PUT') > putsLobby, 20000, 'anvend i ny kamp');
    await wait(500);
    assert(autoSet().title.endsWith('MID'), 'rolle-override nulstillet');
    assert.strictEqual((await gui('GET', '/state')).body.jungle, null, 'ingen jungle-ruter når du ikke spiller jungle');
    assert.strictEqual(state.pages.filter((p) => p.name.startsWith('Auto: ')).length, 1, 'stadig kun én auto-side');
    assert.strictEqual(state.itemSets.itemSets.filter((s) => s.title.startsWith('Auto: ')).length, 1, 'stadig kun ét auto-set');
    // 7) Kampen starter: live-forslag + scoreboard
    const items = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${st.ddVersion}/data/en_US/item.json`)).json()).data;
    const zhonyaPart = Number(items['3157'].from[0]);
    state.phase = 'InProgress';
    // 7-start) Kampstart: 500 g, kun trinket -> startitems (fra matchuppet hvis nok kampe), stemmen siger dem én gang
    const startGame = liveGame(zhonyaPart);
    startGame.gameData.gameTime = 15;
    startGame.activePlayer.currentGold = 500;
    startGame.allPlayers[0].items = [{ itemID: 3340, count: 1, slot: 6 }]; // Stealth Ward (trinket)
    live.data = startGame;
    await waitFor(() => out.includes('Live: Ahri'), 15000, 'live start');
    await wait(2500);
    const S0 = (await gui('GET', '/state')).body.live;
    const starter = S0.inventory.starter;
    assert(starter && starter.items.length >= 1, `startitems ved kampstart: ${JSON.stringify(S0.inventory)}`);
    assert(starter.cost > 0 && starter.cost <= 500 && starter.canAfford, `pris og råd: ${JSON.stringify(starter)}`);
    assert(starter.items.every((i) => i.name && i.icon && i.count >= 1));
    // Startitems siges når gameplanen mod lane-modstanderen er klar (højst 5 sek. efter kampstart).
    await waitFor(() => /^Start: /m.test(said()), 10000, 'stemme ved kampstart');
    console.log('Startitems:', starter.items.map((i) => `${i.count}x ${i.name}`).join(', '), `(${starter.cost} g)`, starter.vs ? `mod ${starter.vs}` : '(generelle)');
    // Spejder: Zed (lane) og Graves (jungler) slås op på OP.GG med klientens region (EUNE fra /riotclient/region-locale)
    let sc = [];
    for (let i = 0; i < 40 && (sc = (await gui('GET', '/state')).body.live?.scout || []).length < 2; i++) await wait(500);
    const zedScout = sc.find((x) => x.champion.name === 'Zed');
    assert.strictEqual(zedScout?.text, 'Zed: 340 ranked-kampe, 61% WR denne sæson (68% af spillerens ranked-kampe)', JSON.stringify(sc));
    assert.strictEqual(zedScout.rank, 'Gold 2');
    assert.strictEqual(zedScout.role, 'lane');
    const jgScout = sc.find((x) => x.champion.name === 'Graves');
    assert.strictEqual(jgScout?.text, 'Ingen ranked-kampe på Graves denne sæson (170 ranked-kampe på andre champions)', JSON.stringify(sc));
    assert.strictEqual(jgScout.rank, 'Master 120 LP');
    assert.strictEqual(jgScout.role, 'jungle');
    assert(scoutCalls.some((c) => c.game_name === 'Fedzed' && c.tag_line === 'EUW' && c.region === 'EUNE'), JSON.stringify(scoutCalls));
    assert(!scoutCalls.some((c) => ['Topper', 'Mig', 'Jungle', 'Bot', 'Tank'].includes(c.game_name)), 'kun lane-modstander og jungler');
    await waitFor(() => said().includes('Zed: 340 kampe, 61 procent win rate'), 10000, 'spejder-stemme');
    const ejLive = (await gui('GET', '/state')).body.enemyJungle;
    assert(ejLive && ejLive.guessed === false && ejLive.sides[0].side === 'RED' && ejLive.champion.name === 'Graves', `fjendens jungler live: ${JSON.stringify(ejLive)}`);
    console.log('Spejder:', sc.map((x) => `${x.text} · ${x.rank}`).join(' | '));
    if (process.env.HOLD_START) {
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_START));
    }
    await wait(2500);
    assert.strictEqual(said().split('\n').filter((l) => l.startsWith('Start: ')).length, 1, 'startitems siges kun én gang');

    live.data = liveGame(zhonyaPart);
    await wait(2500);
    const L = (await gui('GET', '/state')).body.live;
    assert(L, 'live-visning');
    assert.strictEqual(L.inventory.starter, null, 'ingen startitems når du har købt');
    assert.strictEqual(L.gold, 1400);
    assert.strictEqual(L.allies.players.length, 5);
    assert.strictEqual(L.enemies.players.length, 5);
    assert(L.allies.players.find((p) => p.me).champion.name === 'Ahri', 'jeg er markeret');
    assert.strictEqual(L.allies.dragons, 1, 'drage til mit hold');
    assert.strictEqual(L.allies.turrets, 1, 'tårn (T2) til mit hold');
    assert.deepStrictEqual(L.enemy.fed, ['Zed'], 'Zed er fed');
    assert.strictEqual(L.skill.unspent, 1, 'ét ubrugt skill-point');
    assert(['Q', 'W', 'E', 'R'].includes(L.skill.next), `næste skill: ${L.skill.next}`);
    console.log('Næste skill ved Q5/W2/E1/R2 (level 11):', L.skill.next, L.skill.names[L.skill.next]);
    live.data.activePlayer.abilities.W.abilityLevel = 3; // pointet brugt
    await wait(2500);
    const Lspent = (await gui('GET', '/state')).body.live;
    assert.strictEqual(Lspent.skill.unspent, 0);
    assert.strictEqual(Lspent.skill.next, null, 'intet forslag uden ubrugte points');
    // Ved kampstart siges kun startitems (ikke alt det andet der allerede gælder)
    assert.strictEqual(said().split('\n').filter((l) => l && !l.startsWith('Start: ') && !l.startsWith('Zed: 340 kampe')).join('|'), '', `kun startitems (og spejderen) siges ved kampstart: ${said()}`);
    live.data.activePlayer.abilities.W.abilityLevel = 2; // nyt level -> ubrugt point igen
    await wait(2500);
    assert(said().includes('Level op: W'), `stemme ved level op: ${said()}`);

    // Stemme: råd til et forslag + en ny fed modstander (enemyAlerts)
    live.data.activePlayer.currentGold = 5000;
    await wait(2500);
    assert(/Råd til /.test(said()), `stemme ved råd nu: ${said()}`);
    live.data.activePlayer.currentGold = 1400;
    const darius = live.data.allPlayers.find((p) => p.championName === 'Darius');
    darius.scores.kills = 10;
    await wait(2500);
    assert(said().includes('Darius er fed'), `stemme ved ny fed modstander: ${said()}`);
    darius.scores.kills = 2;
    // Stemme fra/til gemmes i config
    assert.strictEqual((await gui('POST', '/api/voice', { enabled: false })).body.enabled, false);
    assert.strictEqual(JSON.parse(fs.readFileSync(env.LOL_HELPER_CONFIG, 'utf8')).voice, false);
    assert.strictEqual((await gui('GET', '/state')).body.voice, false);
    await gui('POST', '/api/voice', { enabled: true });
    await wait(2500);
    console.log('Stemmen sagde:', said().trim().split('\n').join(' | '));

    // Gameplan live: "lige nu" + Zed køber et nyt item -> ændringslog og stemme
    let lp = (await gui('GET', '/state')).body.plan;
    assert.strictEqual(lp?.opponent?.name, 'Zed', 'gameplan mod Zed under kampen');
    assert(lp.now && lp.now[0].startsWith('Level: dig 11, Zed 13'), `lige nu: ${JSON.stringify(lp.now)}`);
    assert(lp.now.some((l) => l.startsWith('Items: dig')) && lp.now.some((l) => l.startsWith('KDA: dig')), 'items og KDA');
    const zed = live.data.allPlayers.find((p) => p.championName === 'Zed');
    zed.items.push({ itemID: 6694, count: 1, slot: 4 });
    await wait(2500);
    lp = (await gui('GET', '/state')).body.plan;
    assert(lp.log[0]?.text === "Zed har købt Serylda's Grudge", `ændringslog: ${JSON.stringify(lp.log)}`);
    assert(said().includes("Zed har købt Serylda's Grudge"), `stemme om modstanderens køb: ${said()}`);
    zed.items.pop();
    console.log('Gameplan lige nu:', lp.now.join(' | '));

    // Styrkeforhold + fase (øjebliksbilledet med Serylda's): Zed er 2 level og 3 færdige items foran -> fordel Zed; 20 min -> midgame
    assert.strictEqual(lp.balance?.side, 'opp', `styrkeforhold: ${JSON.stringify(lp.balance)}`);
    assert.strictEqual(lp.balance.label, 'Fordel Zed');
    assert(lp.balance.why.includes('2 level bagud') && lp.balance.why.includes('3 færdige items bagud'), JSON.stringify(lp.balance.why));
    assert.strictEqual(lp.phaseNow, 'mid', 'midgame efter 14 min');
    // Det skifter (2 tjek i træk) -> stemmen siger det
    const zedKeep = { items: zed.items, level: zed.level };
    zed.items = [];
    zed.level = 1;
    await wait(5000);
    lp = (await gui('GET', '/state')).body.plan;
    assert.strictEqual(lp.balance.side, 'me', JSON.stringify(lp.balance));
    assert(said().includes('Fordel dig mod Zed: 10 level foran, du har ult'), `stemme om styrkeforhold: ${said()}`);
    assert(lp.log.some((l) => l.text.startsWith('Fordel dig mod Zed')), 'styrkeforhold i ændringsloggen');
    Object.assign(zed, zedKeep);

    // Dueller fra kill-feedet: du dør til Zed (solo), du dræber Zed (med hjælp); gamle kills ignoreres
    live.data.events.Events.push(
      { EventID: 20, EventName: 'ChampionKill', EventTime: 100, KillerName: 'Fedzed', VictimName: 'Mig', Assisters: [] },
      { EventID: 21, EventName: 'ChampionKill', EventTime: 1230, KillerName: 'Fedzed', VictimName: 'Mig', Assisters: [] },
      { EventID: 22, EventName: 'ChampionKill', EventTime: 1233, KillerName: 'Mig', VictimName: 'Fedzed', Assisters: ['Jungle'] },
      { EventID: 23, EventName: 'ChampionKill', EventTime: 1233, KillerName: 'Mig', VictimName: 'Tank', Assisters: [] });
    await wait(2500);
    lp = (await gui('GET', '/state')).body.plan;
    assert.deepStrictEqual(lp.duels.map((d) => [d.t, d.won, d.solo]), [[1230, false, true], [1233, true, false]], `dueller: ${JSON.stringify(lp.duels)}`);
    assert(/^level 11 mod 13, [\d.]+ g bagud i items$/.test(lp.duels[0].context), lp.duels[0].context);
    assert(lp.log.some((l) => l.text.startsWith('Du døde til Zed - level 11 mod 13')), `duel i loggen: ${JSON.stringify(lp.log)}`);
    assert(lp.log.some((l) => l.text.startsWith('Du dræbte Zed (med hjælp)')), 'kill i loggen');

    // OBS-klip (obsClips, standard fra): ingen forbindelse og ingen beskeder - heller ikke ved dit dødsfald (1230)
    await wait(3500);
    assert.strictEqual(obsLog.connections, 0, 'OBS slået fra: ingen forbindelsesforsøg');
    assert(!/OBS/.test(out), 'OBS slået fra: ingen beskeder');
    assert.strictEqual((await gui('GET', '/state')).body.obs, null, 'ingen OBS-status når slået fra');
    // Slå til i vinduet -> forbinder med adgangskode (sha256-håndtryk), starter replay bufferen
    assert.strictEqual((await gui('POST', '/api/obs', { enabled: true })).body.enabled, true);
    await waitFor(() => obsLog.requests.includes('StartReplayBuffer'), 10000, 'OBS replay buffer startet');
    assert.strictEqual(obsLog.authOk, true, 'auth-håndtryk godkendt');
    assert.strictEqual(JSON.parse(fs.readFileSync(env.LOL_HELPER_CONFIG, 'utf8')).obsClips, true, 'obsClips gemt i config.json');
    await waitFor(() => out.includes('OBS forbundet'), 5000, 'OBS-status');
    // Du dør (til Darius) -> efter ca. 3 sek. SaveReplayBuffer, og klippets sti hentes
    const diedAt = Date.now();
    live.data.events.Events.push({ EventID: 24, EventName: 'ChampionKill', EventTime: 1234, KillerName: 'Tank', VictimName: 'Mig', Assisters: [] });
    await waitFor(() => obsLog.requests.includes('SaveReplayBuffer'), 10000, 'SaveReplayBuffer');
    assert(Date.now() - diedAt >= 2500, 'venter ca. 3 sek. efter dødsfaldet');
    await waitFor(() => out.includes('OBS: klip af dødsfaldet 20:34 gemt (Replay 1.mp4)'), 15000, 'klip gemt');
    assert.strictEqual(obsLog.saves, 1, 'ét klip pr. dødsfald');
    {
      const pend = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).pendingClips || [];
      assert.deepStrictEqual(pend.map((p) => [p.t, path.basename(p.file), p.killer]), [[1234, 'Replay 1.mp4', 'Darius']], `klip gemt under kampen: ${JSON.stringify(pend)}`);
      assert(Math.abs(pend[0].at - diedAt) < 3000, 'væg-tiden for dødsfaldet gemt');
    }
    assert(!out.includes(OBS_PASSWORD), 'adgangskoden logges aldrig');
    assert.strictEqual(obsLog.connections, 1, 'én forbindelse');
    // Lanes lige nu: alle 5 lanes med styrkeforhold
    const liveState = (await gui('GET', '/state')).body;
    assert.strictEqual(liveState.coach, null, 'ingen coach-råd under kampen (kun før og efter)');
    const lanes = liveState.live.lanes;
    assert.deepStrictEqual(lanes?.rows.map((r) => r.lane), ['Top', 'Jungle', 'Mid', 'Bot', 'Support'], JSON.stringify(lanes));
    assert(!lanes.jungle && lanes.rows[2].me && lanes.rows[2].label === 'Fordel Zed', JSON.stringify(lanes.rows[2]));
    assert.strictEqual(lanes.rows[0].label, 'Fordel Darius', JSON.stringify(lanes.rows[0]));

    // Live-API'et uden roller -> lane-modstanderen fra champion select bruges stadig
    const meLive = live.data.allPlayers[0];
    meLive.position = '';
    zed.position = '';
    await wait(2500);
    assert.strictEqual((await gui('GET', '/state')).body.live.matchup?.name, 'Zed', 'modstander fra champion select når roller mangler');
    meLive.position = 'MIDDLE';
    zed.position = 'MIDDLE';

    // Du færdiggør et item fra dit core build -> stemmen siger det (eget power spike)
    const coreItem = lp.myCore[0];
    const keepItems = meLive.items;
    meLive.items = [...keepItems, { itemID: Number(coreItem.id), count: 1, slot: 5 }];
    await wait(2500);
    assert(said().includes(`${coreItem.name} færdig - 1 af ${lp.myCore.length} i dit core build`), `stemme ved core-item: ${said()}`);
    meLive.items = keepItems;

    // Stemme-ui) Dit eget level 6 siges én gang; side og Oracle Lens-info (kun for camouflage-champions)
    const Lside = (await gui('GET', '/state')).body.live;
    assert.strictEqual(Lside.side, 'BLUE', 'ORDER = blå side');
    assert.strictEqual(Lside.vision, null, 'ingen Oracle Lens-linje for Ahri');
    meLive.level = 5;
    live.data.activePlayer.level = 5;
    await wait(2500);
    meLive.level = 6;
    live.data.activePlayer.level = 6;
    await wait(2500);
    assert(said().includes('Level 6 - R'), `stemme ved dit level 6: ${said()}`);
    meLive.level = 11;
    live.data.activePlayer.level = 11;
    await wait(2500);
    assert.strictEqual(said().split('\n').filter((l) => l.startsWith('Level 6')).length, 1, 'level 6 siges kun én gang');
    assert(!/Stemmen fejlede/.test(out), 'ingen fejl fra stemmen');
    assert.strictEqual(L.matchup?.name, 'Zed', 'live lane-modstander ud fra position');
    assert(L.matchup.winRate > 0.3, 'live matchup win rate');
    assert(L.enemy.healers.includes('Soraka') && L.enemy.healers.includes('Darius'), 'healere');
    assert(L.enemy.armorStackers.includes('Darius'), 'Darius bygger armor');
    assert(L.enemy.adShare > 0.6, `AD-tung trussel: ${L.enemy.adShare}`);
    assert(L.advice.length >= 2 && L.advice.length <= 3, `2-3 forslag: ${L.advice.length}`);
    for (const a of L.advice) assert(a.reasons.length && a.cost > 0, 'forslag har begrundelse og pris');
    assert(!L.advice.some((a) => ['1056', '3020', String(zhonyaPart)].includes(a.id)), 'foreslår ikke noget jeg ejer');
    assert(L.advice.some((a) => a.reasons.some((r) => r.startsWith('Zed er fed (9/1/3) og laver AD-skade'))), 'reagerer på fed Zed');
    assert(L.advice.some((a) => a.reasons.some((r) => r.startsWith('Anti-heal'))), 'anti-heal mod Soraka/Darius');
    assert(L.advice.some((a) => !a.adapted), 'mindst ét fast build-item med');
    const zh = L.advice.find((a) => a.id === '3157');
    assert(zh, "Zhonya's foreslås mod fed AD-Zed");
    assert.strictEqual(zh.cost, items['3157'].gold.total - items[String(zhonyaPart)].gold.total, 'restpris trækker ejet del fra');
    assert.strictEqual(zh.inProgress, items[String(zhonyaPart)].gold.total >= 700, "Zhonya's er 'i gang' med en dyr del");
    if (zh.inProgress) assert.strictEqual(L.advice[0].id, '3157', "item du er i gang med står først");
    console.log('Live-forslag:', JSON.stringify(L.advice.map((a) => ({ item: a.name, cost: a.cost, råd: a.canAfford, del: a.part?.name, hvorfor: a.reasons }))));
    // enemyAlerts (standard til): forslag drevet af modstanderne giver stemme/bip og vises med begrundelse i overlayet
    const antiheal = L.advice.filter((a) => a.reasons.length && a.reasons.every((r) => r.startsWith('Anti-heal')));
    assert(antiheal.length >= 1 && antiheal.every((a) => !a.quiet && a.overlayReason && a.overlayReason.startsWith('Anti-heal')), `anti-heal-forslag med overlay-begrundelse: ${JSON.stringify(antiheal)}`);
    // Byggerækkefølge: ingen færdige items endnu (kun støvler) -> "Typisk 1. item"
    assert(L.advice.some((a) => a.reasons.some((r) => r.startsWith('Typisk 1. item'))), 'næste item i byggerækkefølgen');
    // Control Ward-påmindelse: 20 min, 1.400 g, plads og ingen ward
    assert.strictEqual(L.inventory.wardTip?.id, '2055', 'påmindelse om Control Ward');
    assert(L.inventory.wardTip.icon && L.inventory.wardTip.name === 'Control Ward');

    // 7b) Halvt købt item: Lost Chapter (1.200 g) -> det item den bruges i står først, kun ét forslag bruger delen
    const idByName = (name) => Object.keys(items).find((id) => items[id].name === name && items[id].maps['11']);
    const lostChapter = Number(idByName('Lost Chapter'));
    const setMyItems = (ids) => { live.data.allPlayers[0].items = ids.map((id, slot) => ({ itemID: id, count: 1, slot })); };
    setMyItems([1056, 3020, lostChapter]);
    await wait(2500);
    let L2 = (await gui('GET', '/state')).body.live;
    const first = L2.advice[0];
    assert(first.inProgress, `første forslag er "i gang": ${first.name}`);
    assert(first.reasons[0].startsWith('Du er i gang') && first.reasons[0].includes('Lost Chapter'), first.reasons[0]);
    assert(items[first.id].from.includes(String(lostChapter)) || JSON.stringify(items[first.id].from).includes(String(lostChapter)), 'bruger Lost Chapter');
    assert.strictEqual(L2.advice.filter((a) => a.inProgress).length, 1, 'kun ét forslag gør krav på Lost Chapter');
    if (first.part) {
      assert(first.part.id !== String(lostChapter) && !items[String(lostChapter)].from.includes(first.part.id),
        `foreslår ikke en del du ejer (eller dens under-dele): ${first.part.name}`);
    }
    assert(L2.advice.some((a) => a.adapted && !a.inProgress), 'tilpassede forslag vises stadig');
    console.log('Med Lost Chapter:', JSON.stringify(L2.advice.map((a) => ({ item: a.name, cost: a.cost, hvorfor: a.reasons }))));

    // 7c) Kun en Amplifying Tome (400 g) -> intet låses fast
    setMyItems([1056, 3020, Number(idByName('Amplifying Tome'))]);
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(!L2.advice.some((a) => a.inProgress), 'en billig del gør ikke et item "i gang"');

    // 7d0) Ingen færdige støvler efter 20 min -> støvler fremhæves; med Malignance færdig -> "Typisk 2. item efter Malignance"
    setMyItems([1056, 3118]);
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.bootsTip?.minutes, 20, `støvle-påmindelse: ${JSON.stringify(L2.inventory)}`);
    assert(L2.inventory.bootsTip.name && L2.inventory.bootsTip.cost > 0, 'støvler fra dit build med pris');
    assert(L2.advice.some((a) => a.reasons.some((r) => r.startsWith('Typisk 2. item efter Malignance'))), `næste item efter Malignance: ${JSON.stringify(L2.advice.map((a) => [a.name, a.reasons]))}`);
    console.log('Efter Malignance, uden støvler:', L2.advice.map((a) => `${a.name}: ${a.reasons[0]}`).join(' | '));

    // 7e) Fuldt build (6 færdige items): ingen almindelige køb, kun begrundede bytninger + elixir
    const passivesOf = (id) => [...(items[id]?.description || '').matchAll(/<passive>([^<]+)<\/passive>/g)].map((m) => m[1].trim());
    const fullBuild = [3118, 4645, 3157, 3089, 3135, 3020];
    setMyItems(fullBuild);
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.full, true, 'fuldt build genkendt');
    assert.strictEqual(L2.inventory.slotsUsed, 6);
    assert.strictEqual(L2.inventory.elixir?.id, '2139', `elixir til AP: ${JSON.stringify(L2.inventory.elixir)}`);
    assert(L2.advice.length <= 2, 'højst 2 bytte-forslag');
    assert(L2.advice.every((a) => a.swap && a.adapted && a.reasons[0].startsWith('Fuldt build: mulighed for at bytte')), `kun begrundede bytninger: ${JSON.stringify(L2.advice.map((a) => a.reasons))}`);
    assert(!L2.advice.some((a) => fullBuild.map(String).includes(a.id)), 'foreslår ikke noget du har');
    const ownedPassives = new Set(fullBuild.flatMap((id) => passivesOf(String(id))));
    assert(!L2.advice.some((a) => passivesOf(a.id).some((p) => ownedPassives.has(p))), 'ingen dobbelt unik passiv');
    console.log('Fuldt build:', JSON.stringify({ elixir: L2.inventory.elixir.name, byt: L2.advice.map((a) => `${a.swap.name} -> ${a.name}`) }));

    // 7f) Alle 6 pladser brugt (starter-items + potions) -> nye items kræver salg, ingen del-forslag
    setMyItems([1056, 1082, 3020, 3157, 3089, 2003]);
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.full, false);
    assert.strictEqual(L2.inventory.slotsUsed, 6);
    assert(L2.advice.length >= 1, 'stadig forslag');
    assert(L2.advice.every((a) => !a.part), 'ingen "råd nu til delen" uden plads');
    const needSlot = L2.advice.filter((a) => a.sell);
    assert(needSlot.length >= 1 && needSlot.every((a) => ['1056', '1082', '2003'].includes(a.sell.id) && a.reasons.some((r) => r.startsWith('Kræver en ledig plads, fx ved salg af'))),
      `salg for at få plads: ${JSON.stringify(L2.advice.map((a) => [a.name, a.sell?.name, a.reasons]))}`);
    console.log('Fyldte pladser:', L2.advice.map((a) => `${a.name}${a.sell ? ` (sælg ${a.sell.name})` : ''}`).join(', '));

    // 7g) Items-pakken (review 2026-10-21): Gunmetal = støvler, anti-heal med "Wounds", komponent skjuler ikke anti-heal,
    // Control Ward kan sælges, jungle-pet + 5 items = fuldt, ARAM uden ward-påmindelse, Arena uden item-råd.
    const isAntiheal = (id) => /\bWounds\b/.test(items[id]?.description || '');
    setMyItems([1056, 3172]); // Gunmetal Greaves (tier 3 Berserker's, uden Boots-tag)
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.bootsTip, null, `ingen støvle-påmindelse med Gunmetal: ${JSON.stringify(L2.inventory.bootsTip)}`);
    assert(!L2.advice.some((a) => (items[a.id].tags || []).includes('Boots')), `ingen nye støvler med Gunmetal: ${L2.advice.map((a) => a.name)}`);
    setMyItems([1056, 3020, Number(idByName('Oblivion Orb'))]); // anti-heal-komponent
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(L2.advice.some((a) => isAntiheal(a.id)), `anti-heal-item foreslås trods Oblivion Orb: ${L2.advice.map((a) => a.name)}`);
    setMyItems([1056, 3020, 3075]); // Thornmail: "Wounds" (ikke "Grievous Wounds") er anti-heal
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(!L2.advice.some((a) => isAntiheal(a.id)), `Thornmail tæller som anti-heal: ${L2.advice.map((a) => a.name)}`);
    setMyItems([3118, 4645, 3157, 3089, 3135, 2055]); // 5 items + Control Ward
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.full, false, 'Control Ward kan sælges -> ikke fuldt');
    assert(L2.advice.length >= 1 && L2.advice.filter((a) => a.sell).every((a) => a.sell.id === '2055'), `sælg Control Ward for plads: ${JSON.stringify(L2.advice.map((a) => [a.name, a.sell?.name]))}`);
    setMyItems([3118, 4645, 3157, 3089, 3020, 1101]); // 5 items + jungle-pet
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(L2.inventory.full && L2.inventory.elixir, `pet + 5 items = fuldt build med elixir: ${JSON.stringify(L2.inventory)}`);
    setMyItems([1056, 3020]);
    live.data.gameData.mapNumber = 12; // ARAM: Control Ward findes ikke i butikken
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert.strictEqual(L2.inventory.wardTip, null, 'ingen Control Ward-påmindelse i ARAM');
    live.data.gameData.mapNumber = 30; // Arena: ingen råd ud fra et Summoner's Rift-build
    live.data.gameData.gameMode = 'CHERRY';
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(L2.advice.length === 0 && !L2.inventory.wardTip && !L2.inventory.bootsTip, `Arena uden item-råd: ${JSON.stringify(L2.inventory)}`);
    live.data = liveGame(zhonyaPart);
    await wait(2500);

    // 7c2) Spillet hakker i 4 sek. (længere end timeout) -> kampen må ikke regnes som slut
    live.stallMs = 4000;
    await wait(9000);
    live.stallMs = 0;
    await wait(2500);
    assert(!out.includes('Kampen er slut.'), 'et hak afslutter ikke kampen');
    assert((await gui('GET', '/state')).body.live, 'stadig live efter hak');

    // 7c3) Robusthed: spillet crasher (porten svarer ikke), men klienten er stadig i kamp (Reconnect)
    //      -> kampen er ikke slut; spillet kommer tilbage og samme kamp fortsætter
    {
      const keep = live.data;
      state.phase = 'Reconnect';
      live.data = null;
      await waitFor(() => out.includes('venter på at du genforbinder'), 15000, 'genforbindelse');
      await wait(3000);
      assert(!out.includes('Kampen er slut.'), 'crash/genforbindelse afslutter ikke kampen');
      live.data = keep;
      state.phase = 'InProgress';
      await waitFor(() => out.includes('Spillet er tilbage'), 15000, 'spillet tilbage');
      await wait(2500);
      assert((await gui('GET', '/state')).body.live, 'live igen efter genforbindelse');
      assert(!out.includes('Kampen er slut.'), 'stadig samme kamp');
    }

    // 7d) Du køber Zhonya's (var foreslået + tilpasset mod Zed), og kampen vindes
    setMyItems([1056, 3020, 3157]);
    await wait(2500);
    live.data.events.Events.push({ EventID: 9, EventName: 'GameEnd', EventTime: 1800, Result: 'Win' });
    await wait(2500);
    setMyItems([1056, 3020, zhonyaPart]); // tilbage til udgangspunktet for resten af testen
    live.data.events.Events.pop();
    await wait(2500);

    // Valgfrit: HOLD_LIVE=ms holder kampen åben, fx til node test/screenshot.js <url>.
    if (process.env.HOLD_LIVE) {
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_LIVE));
    }

    // Vinduet må ikke få nye data hvert 2. sekund, når intet har ændret sig (unødig gentegning).
    {
      const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
      const ctrl = new AbortController();
      const res = await fetch(base + '/events', { signal: ctrl.signal });
      const reader = res.body.getReader();
      const msgs = new Set();
      let buf = '';
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        const r = await Promise.race([reader.read(), wait(end - Date.now()).then(() => null)]);
        if (!r || r.done) break;
        buf += Buffer.from(r.value).toString();
        for (const m of buf.split('\n\n').slice(0, -1)) msgs.add(m);
        buf = buf.split('\n\n').pop();
      }
      ctrl.abort();
      assert(msgs.size <= 1, `vinduet fik ${msgs.size} forskellige beskeder uden ændringer`);
    }

    // 8) Du dør lige før kampen slutter, og OBS skriver først klippet, efter at kampen er gemt.
    obsLog.hold = true;
    live.data.events.Events.push({ EventID: 25, EventName: 'ChampionKill', EventTime: 1250, KillerName: 'Tank', VictimName: 'Mig', Assisters: [] });
    await waitFor(() => obsLog.saves === 2, 10000, 'SaveReplayBuffer for det sidste dødsfald');
    // 8) Kampen slutter
    live.data = null;
    await waitFor(() => out.includes('Kampen er slut.'), 15000, 'kamp slut');
    {
      const h = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8'));
      assert.deepStrictEqual(h.games[0].deathLog.map((d) => [d.t, d.clip ? path.basename(d.clip) : null]), [[1230, null], [1234, 'Replay 1.mp4'], [1250, null]], 'kampen gemt før klippet er færdigt');
      assert.deepStrictEqual(h.pendingClips, [], 'klip der står i kampen, er ikke længere midlertidige');
    }
    obsLog.hold = false;
    obsLog.release();
    await waitFor(() => out.includes('OBS: klip af dødsfaldet 20:50 gemt (Replay 2.mp4)'), 15000, 'sent klip gemt');
    {
      const h = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8'));
      assert.deepStrictEqual(h.games[0].deathLog.map((d) => [d.t, d.clip ? path.basename(d.clip) : null]), [[1230, null], [1234, 'Replay 1.mp4'], [1250, 'Replay 2.mp4']], 'sent klip gemt i history.json');
    }
    const after = (await gui('GET', '/state')).body;
    assert.strictEqual(after.live, null);
    // Kampoversigt gemt i historikken
    const g = after.history?.last;
    assert(g, 'kampoversigt');
    assert.strictEqual(g.champion, 'Ahri');
    assert.strictEqual(g.result, 'Sejr', 'resultat fra GameEnd');
    assert.strictEqual(g.gameMode, 'CLASSIC', 'spiltype gemt i historikken');
    // (7e/7f gav dig også nogle items, så der er flere køb - Zhonya's fra 7d skal være foreslået og tilpasset)
    assert(g.buys.some((b) => b.id === '3157' && b.suggested && b.adapted), `Zhonya-køb markeret som foreslået/tilpasset: ${JSON.stringify(g.buys)}`);
    assert(g.buys.every((b) => isFinite(b.t) && b.id), 'køb har tid og item');
    assert(!g.buys.some((b) => ['1056', '1082', '2003'].includes(b.id)), 'kun færdige items tæller som køb');
    assert(g.followed > 0 && g.followed <= 1, `andel fulgte forslag: ${g.followed}`);
    assert.strictEqual(after.history.champions[0].champion, 'Ahri');
    assert(fs.existsSync(env.LOL_HELPER_HISTORY), 'historik gemt på disk');
    assert(out.includes('Kampoversigt: Ahri'), 'log med kampoversigt');
    assert.deepStrictEqual(g.duels?.map((d) => d.won), [false, true], `dueller i historikken: ${JSON.stringify(g.duels)}`);
    assert.strictEqual(g.balanceEnd, 'Fordel Zed', 'styrkeforhold ved slut');
    assert.deepStrictEqual(g.deathLog?.map((d) => [d.t, d.killer, d.helpers]), [[1230, 'Zed', 0], [1234, 'Darius', 0], [1250, 'Darius', 0]], `dødsfald: ${JSON.stringify(g.deathLog)}`);
    assert(/^level 11 mod 13/.test(g.deathLog[0].context), g.deathLog[0].context);
    assert(g.lessons?.[0]?.startsWith('Sammenligning med dine egne kampe kommer efter 3 kampe med Ahri'), JSON.stringify(g.lessons));
    assert(out.includes('dueller mod Zed: 1-1'), 'dueller i kampoversigten');

    // Kampgennemgang: kampens id fra klienten (gameflow-session), kamp + timeline hentet efter kampen
    let rv;
    for (let i = 0; i < 40 && !((rv = (await gui('GET', '/state')).body.reviews?.[0])?.review); i++) await wait(500);
    assert(rv?.review, `kampgennemgang: ${JSON.stringify(rv)}`);
    assert.strictEqual(rv.champion, 'Ahri');
    assert.deepStrictEqual(rv.review.deaths.map((d) => [d.t, d.killer, d.by, d.x, d.y]), [[300, 'Zed', 'lane', 7000, 7400]], `dødsfald: ${JSON.stringify(rv.review.deaths)}`);
    assert.strictEqual(rv.review.opp?.name, 'Zed');
    assert.strictEqual(rv.review.jg?.name, 'Graves');
    assert.strictEqual(rv.review.gold.length, 13);
    assert.deepStrictEqual(rv.review.gold[10], [10, -500], 'guldforskel ved 10 min');
    assert.strictEqual(rv.review.oppBy, 'live', 'modstanderen fra live-API\'et under kampen');
    assert.deepStrictEqual(rv.review.at['10'], { cs: 60, oppCs: 70, gold: -500, xp: -200 }, 'guld/CS/XP ved 10 min');
    assert.strictEqual(rv.review.team.length, 13, 'holdets guldforskel pr. minut');
    assert.deepStrictEqual(rv.review.items.map((i) => i.id), g.buys.slice(0, 4).map((b) => b.id), 'første items fra live-data');
    assert.strictEqual(rv.review.path.length, 12, 'din position minut 1-12 (kampen varede 12 min)');
    const hist = JSON.parse(fs.readFileSync(env.LOL_HELPER_HISTORY, 'utf8')).games[0];
    assert.strictEqual(hist.gameId, 4242, 'kampens id gemt');
    assert(!JSON.stringify(hist).includes('participantFrames') && JSON.stringify(hist.review).length < 4000, 'kun et kort uddrag i history.json');
    // Video af dødsfaldet: liste i gennemgangen + afspilning kun af programmets egne klip
    assert.deepStrictEqual(rv.clips.map((c) => [c.t, c.killer, c.name]), [[1234, 'Darius', 'Replay 1.mp4'], [1250, 'Darius', 'Replay 2.mp4']], `klip: ${JSON.stringify(rv.clips)}`);
    const base8 = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
    const clipRes = await fetch(`${base8}/clip?f=${encodeURIComponent(rv.clips[0].file)}`);
    assert.strictEqual(clipRes.status, 200, 'klip kan afspilles');
    assert.strictEqual((await clipRes.arrayBuffer()).byteLength, 2048);
    const ranged = await fetch(`${base8}/clip?f=${encodeURIComponent(rv.clips[0].file)}`, { headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(ranged.status, 206, 'spoling (Range)');
    assert.strictEqual((await ranged.arrayBuffer()).byteLength, 100);
    assert.strictEqual((await fetch(`${base8}/clip?f=${encodeURIComponent(oldClip)}`)).status, 403, 'andre filer i replay-mappen afvises');
    assert.strictEqual((await fetch(`${base8}/clip?f=${encodeURIComponent(env.LOL_HELPER_CONFIG)}`)).status, 403, 'filer uden for replay-mappen afvises');
    assert.strictEqual((await fetch(`${base8}/clip?f=${encodeURIComponent(path.join(obsLog.dir, '..', 'replays', '..', 'config.json'))}`)).status, 403, '.. i stien afvises');
    console.log('Kampgennemgang:', JSON.stringify({ død: rv.review.deaths, guld10: rv.review.gold[10], items: rv.review.items.map((i) => i.name), klip: rv.clips.map((c) => c.name) }));
    if (process.env.HOLD_END) {
      state.phase = 'EndOfGame';
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_END));
    }

    // 8z) config.json: BOM-filen blev læst, og stemme-knappen bevarede resten af indstillingerne
    assert(!out.includes('Kunne ikke læse config.json'), 'config.json med BOM læses');
    assert.strictEqual(JSON.parse(fs.readFileSync(env.LOL_HELPER_CONFIG, 'utf8')).remoteLan, true, 'stemme-knappen bevarer de andre indstillinger');

    // 8p) Dine mønstre + ældre kampes gennemgang: en ekstra kopi af programmet med en syntetisk historik
    await patternsTest(cmd, args, env, tmp);

    // 8q) Coachen: 3-5 konkrete råd fra falske kampe i klientens rigtige format (endnu en kopi af programmet)
    await coachTest(cmd, args, env, tmp);

    // 8r) "Se det i replayet", klip ved rådene og champion-puljen (endnu en kopi, falsk Replay API)
    await replayTest(cmd, args, env, tmp);

    // 8s) Klip der ikke blev koblet til kampen: Tobias' rigtige filer (10/10 og 7/7), skæve tilfælde og genstart midt i kampen
    await clipTest(cmd, args, env, tmp);

    // 9) Telefon-adgang: kræver nøgle udefra, POST kun som JSON
    if (process.env.NO_REMOTE) throw new Error('SKIP_REMOTE');
    const base = /Vindue: http:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1];
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal);
    assert(/Telefon \(/.test(out), 'telefon-links i loggen');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const rawGet = (host, p, headers) => new Promise((resolve) => {
      const r = http.request({ host, port: Number(base), path: p, headers }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', (e) => resolve(e.code));
      r.end();
    });
    assert.strictEqual(await rawGet('127.0.0.1', '/state', { Host: 'ondsindet.example:80' }), 403, 'fremmed Host-header afvises (DNS-rebinding)');
    const noJson = await fetch(`http://127.0.0.1:${base}/api/role`, { method: 'POST', body: 'position=TOP', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(noJson.status, 415, 'POST uden JSON afvises');
    if (lan) {
      const remote = `http://${lan.address}:${base}`;
      assert.strictEqual((await fetch(remote + '/state')).status, 403, 'ingen nøgle -> 403');
      assert.strictEqual((await fetch(remote + '/?token=forkert', { redirect: 'manual' })).status, 403, 'forkert nøgle -> 403');
      const login = await fetch(`${remote}/?token=${token}`, { redirect: 'manual' });
      assert.strictEqual(login.status, 302, 'rigtig nøgle -> redirect');
      const cookie = login.headers.get('set-cookie').split(';')[0];
      assert.strictEqual((await fetch(remote + '/state', { headers: { cookie } })).status, 200, 'cookie giver adgang');
      // Mærkelig sti udefra (gav "Invalid URL" og crash før) -> afvises, programmet lever videre
      const weird = await rawGet(lan.address, '//', {});
      assert.strictEqual(weird, 403, `mærkelig sti: ${weird}`);
      assert.strictEqual((await gui('GET', '/state')).status, 200, 'programmet kører stadig');
    } else {
      console.log('(Intet netværksinterface - springer test af fjernadgang over)');
    }

    const errors = out.split('\n').filter((l) => /Fejl/.test(l) && !l.includes('Invalid perks')); // den ene er fremprovokeret i 4a
    assert(!errors.length, `ingen fejl i loggen: ${errors.join(' | ')}`);

    console.log(out);
    console.log('ALLE TESTS BESTÅET');
  } catch (e) {
    if (e.message === 'SKIP_REMOTE') {
      console.log('ALLE TESTS BESTÅET (uden telefon-adgang)');
      return;
    }
    console.log(out);
    console.error('FEJL:', e.message, (e.stack || '').split('\n').find((l) => l.includes('.test.js')) || '');
    process.exitCode = 1;
  } finally {
    child.kill();
    server.close();
    liveServer.close();
    mcpServer.close();
    opggWeb.close();
    obsServer.close();
    replayServer.close();
    if (!hadToken) fs.rmSync(tokenFile, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
