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
  myTeam: [{ cellId: 2, championId: state.championId, assignedPosition: 'middle', spell1Id: 14, spell2Id: 4 }],
  theirTeam: state.enemies.map((championId, i) => ({ cellId: 5 + i, championId })),
  actions: [
    [{ actorCellId: 2, type: 'ban', completed: state.banDone, isInProgress: !state.banDone, championId: state.banDone ? 157 : 0 }],
    [{ actorCellId: 2, type: 'pick', completed: state.pickCompleted, championId: state.championId }],
  ],
});
// Mastery: Ahri, LeBlanc, Syndra (mid) + Lee Sin (jungle, skal filtreres fra til MID)
const MASTERY = [
  { championId: 103, championPoints: 500000 }, { championId: 7, championPoints: 300000 },
  { championId: 134, championPoints: 200000 }, { championId: 64, championPoints: 150000 },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = Buffer.from(`riot:${PASSWORD}`).toString('base64');
    if (req.headers.authorization !== `Basic ${auth}`) { res.writeHead(401); return res.end(); }
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const key = `${req.method} ${req.url}`;
    if (key === 'GET /lol-gameflow/v1/gameflow-phase') return send(200, state.phase);
    if (key === 'GET /lol-gameflow/v1/session') return send(200, { gameData: { queue: { gameMode: 'CLASSIC' } } });
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
    if (key === 'GET /lol-summoner/v1/current-summoner') return send(200, { summonerId: 55, accountId: 77 });
    if (key === 'GET /lol-item-sets/v1/item-sets/55/sets') return send(200, state.itemSets);
    if (key === 'PUT /lol-item-sets/v1/item-sets/55/sets') { state.itemSets = JSON.parse(body); return send(201, state.itemSets); }
    send(404, { message: 'unknown ' + key });
  });
});

// Falsk OP.GG matchup-guide (MCP, JSON-RPC) - registrerer hvad programmet spørger om.
const mcpCalls = [];
const mcpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rpc = JSON.parse(body);
    const a = rpc.params.arguments;
    mcpCalls.push(a);
    const data = {
      opponent_champion_tip: `Testtip: sådan slår ${a.my_champion} ${a.opponent_champion}`,
      lane_advantage_champion: a.opponent_champion === 'ZED' ? 'Zed' : 'EVEN',
      lane_solo_kill_advantage_champion: 'EVEN',
      recommended_play_style: 'defensive',
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
  const body = `<script>self.__next_f.push([1,"4e:[{\\"teamName\\":\\"BLUE\\",\\"data\\":{\\"team_key\\":\\"BLUE\\",\\"routes\\":[${blue.join(',')}],\\"play\\":1000}},{\\"data\\":{\\"team_key\\":\\"RED\\",\\"routes\\":[${red.join(',')}],\\"play\\":500}}]"])</script>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(body);
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

liveServer.listen(0, '127.0.0.1');
mcpServer.listen(0, '127.0.0.1');
opggWeb.listen(0, '127.0.0.1');
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
    LOL_HELPER_CONFIG: path.join(tmp, 'config.json'),
    ...process.env,
    HOME: tmp,
    LOL_HELPER_CACHE: path.join(tmp, 'cache'),
    LOL_HELPER_HISTORY: path.join(tmp, 'history.json'),
    LOL_HELPER_UPDATE_URL: 'http://127.0.0.1:9/ingen-opdatering',
    LOL_HELPER_LCU: `http:${port}:${PASSWORD}`,
    LOL_HELPER_LIVE: `http:${livePort}`,
    LOL_HELPER_PORT: '0',
    LOL_HELPER_NO_WINDOW: '1',
    LOL_HELPER_REMOTE: process.env.NO_REMOTE ? '' : '1',
  };
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
    state.banDone = true;
    state.enemies = [238]; // Zed låst før dig
    for (let i = 0; i < 60 && !(d = (await gui('GET', '/state')).body.draft)?.opponent; i++) await wait(500);
    assert.strictEqual(d.opponent?.name, 'Zed', 'lane-modstander i draft');
    assert.strictEqual(d.myBanTurn, false);
    assert(d.poolVs.length >= 1 && d.counters.length >= 1, `counterpicks: ${JSON.stringify({ poolVs: d.poolVs.length, counters: d.counters.length })}`);
    assert(!d.bans.some((b) => b.name === 'Zed'), 'valgte champions foreslås ikke som ban');
    console.log('Mod Zed:', d.poolVs.map((x) => `${x.name} ${(x.winRate * 100).toFixed(1)}%`).join(', '), '| counters:', d.counters.map((x) => `${x.name} ${(x.winRate * 100).toFixed(1)}%`).join(', '));
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
    console.log('Gameplan:', JSON.stringify({ lane: plan.laneAdvantage, solo: plan.soloKill, stil: plan.playStyle, skalering: plan.scaling, han: plan.oppCore.map((i) => i.name) }));

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
    live.data = liveGame(zhonyaPart);
    await waitFor(() => out.includes('Live: Ahri'), 15000, 'live start');
    await wait(500);
    const L = (await gui('GET', '/state')).body.live;
    assert(L, 'live-visning');
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
    assert.strictEqual(said(), '', `intet siges når kampen starter: ${said()}`);
    live.data.activePlayer.abilities.W.abilityLevel = 2; // nyt level -> ubrugt point igen
    await wait(2500);
    assert(said().includes('Level op: W'), `stemme ved level op: ${said()}`);

    // Stemme: råd til et forslag + en ny fed modstander
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
    assert(said().includes("Zed har købt Serylda's Grudge"), 'stemme om modstanderens køb');
    zed.items.pop();
    console.log('Gameplan lige nu:', lp.now.join(' | '));

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
    assert.strictEqual(L.matchup?.name, 'Zed', 'live lane-modstander ud fra position');
    assert(L.matchup.winRate > 0.3, 'live matchup win rate');
    assert(L.enemy.healers.includes('Soraka') && L.enemy.healers.includes('Darius'), 'healere');
    assert(L.enemy.armorStackers.includes('Darius'), 'Darius bygger armor');
    assert(L.enemy.adShare > 0.6, `AD-tung trussel: ${L.enemy.adShare}`);
    assert(L.advice.length >= 2 && L.advice.length <= 3, `2-3 forslag: ${L.advice.length}`);
    for (const a of L.advice) assert(a.reasons.length && a.cost > 0, 'forslag har begrundelse og pris');
    assert(!L.advice.some((a) => ['1056', '3020', String(zhonyaPart)].includes(a.id)), 'foreslår ikke noget jeg ejer');
    assert(L.advice.some((a) => a.reasons.some((r) => r.includes('Zed er fed'))), 'reagerer på fed Zed');
    assert(L.advice.some((a) => a.reasons.some((r) => r.startsWith('Anti-heal'))), 'anti-heal mod Soraka/Darius');
    assert(L.advice.some((a) => !a.adapted), 'mindst ét fast build-item med');
    const zh = L.advice.find((a) => a.id === '3157');
    assert(zh, "Zhonya's foreslås mod fed AD-Zed");
    assert.strictEqual(zh.cost, items['3157'].gold.total - items[String(zhonyaPart)].gold.total, 'restpris trækker ejet del fra');
    assert.strictEqual(zh.inProgress, items[String(zhonyaPart)].gold.total >= 700, "Zhonya's er 'i gang' med en dyr del");
    if (zh.inProgress) assert.strictEqual(L.advice[0].id, '3157', "item du er i gang med står først");
    console.log('Live-forslag:', JSON.stringify(L.advice.map((a) => ({ item: a.name, cost: a.cost, råd: a.canAfford, del: a.part?.name, hvorfor: a.reasons }))));
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
    assert(L2.advice.every((a) => a.swap && a.adapted && a.reasons[0].startsWith('Fuldt build: byt')), `kun begrundede bytninger: ${JSON.stringify(L2.advice.map((a) => a.reasons))}`);
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
    assert(needSlot.length >= 1 && needSlot.every((a) => ['1056', '1082'].includes(a.sell.id) && a.reasons.some((r) => r.startsWith('Kræver en ledig plads: sælg'))),
      `salg for at få plads: ${JSON.stringify(L2.advice.map((a) => [a.name, a.sell?.name, a.reasons]))}`);
    console.log('Fyldte pladser:', L2.advice.map((a) => `${a.name}${a.sell ? ` (sælg ${a.sell.name})` : ''}`).join(', '));
    live.data = liveGame(zhonyaPart);
    await wait(2500);

    // 7c2) Spillet hakker i 4 sek. (længere end timeout) -> kampen må ikke regnes som slut
    live.stallMs = 4000;
    await wait(9000);
    live.stallMs = 0;
    await wait(2500);
    assert(!out.includes('Kampen er slut.'), 'et hak afslutter ikke kampen');
    assert((await gui('GET', '/state')).body.live, 'stadig live efter hak');

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

    // 8) Kampen slutter
    live.data = null;
    await waitFor(() => out.includes('Kampen er slut.'), 15000, 'kamp slut');
    const after = (await gui('GET', '/state')).body;
    assert.strictEqual(after.live, null);
    // Kampoversigt gemt i historikken
    const g = after.history?.last;
    assert(g, 'kampoversigt');
    assert.strictEqual(g.champion, 'Ahri');
    assert.strictEqual(g.result, 'Sejr', 'resultat fra GameEnd');
    // (7e/7f gav dig også nogle items, så der er flere køb - Zhonya's fra 7d skal være foreslået og tilpasset)
    assert(g.buys.some((b) => b.id === '3157' && b.suggested && b.adapted), `Zhonya-køb markeret som foreslået/tilpasset: ${JSON.stringify(g.buys)}`);
    assert(g.buys.every((b) => isFinite(b.t) && b.id), 'køb har tid og item');
    assert(!g.buys.some((b) => ['1056', '1082', '2003'].includes(b.id)), 'kun færdige items tæller som køb');
    assert(g.followed > 0 && g.followed <= 1, `andel fulgte forslag: ${g.followed}`);
    assert.strictEqual(after.history.champions[0].champion, 'Ahri');
    assert(fs.existsSync(env.LOL_HELPER_HISTORY), 'historik gemt på disk');
    assert(out.includes('Kampoversigt: Ahri'), 'log med kampoversigt');
    if (process.env.HOLD_END) {
      state.phase = 'EndOfGame';
      console.log('HOLD', /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1]);
      await wait(Number(process.env.HOLD_END));
    }

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
    console.error('FEJL:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    server.close();
    liveServer.close();
    mcpServer.close();
    opggWeb.close();
    if (!hadToken) fs.rmSync(tokenFile, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
