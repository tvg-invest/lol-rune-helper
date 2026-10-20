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
  actions: [[{ actorCellId: 2, type: 'pick', completed: state.pickCompleted, championId: state.championId }]],
});

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
    if (req.method === 'DELETE' && req.url.startsWith('/lol-perks/v1/pages/')) {
      const id = Number(req.url.split('/').pop());
      state.pages = state.pages.filter((p) => p.id !== id);
      return send(204);
    }
    if (key === 'POST /lol-perks/v1/pages') {
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

// Falsk Live Client Data API (spillets port 2999). Felter som i Riots dokumentation/eksempel.
const live = { data: null };
const liveServer = http.createServer((req, res) => {
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
    activePlayer: { riotId: 'Mig#EUW', riotIdGameName: 'Mig', summonerName: 'Mig#EUW', currentGold: 1400, level: 11 },
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
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const livePort = liveServer.address().port;
  // HELPER_BIN=sti tester den færdige programfil i stedet for scriptet.
  const [cmd, args] = process.env.HELPER_BIN
    ? [path.resolve(process.env.HELPER_BIN), []]
    : [process.execPath, [path.join(__dirname, '..', 'lol-helper.js')]];
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      LOL_HELPER_LCU: `http:${port}:${PASSWORD}`,
      LOL_HELPER_LIVE: `http:${livePort}`,
      LOL_HELPER_PORT: '0',
      LOL_HELPER_NO_WINDOW: '1',
      LOL_HELPER_REMOTE: process.env.NO_REMOTE ? '' : '1',
    },
  });
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

    // 1) Hover Ahri uden at låse -> intet må ske
    state.phase = 'ChampSelect';
    state.championId = 103;
    await wait(2500);
    assert.strictEqual(runePosts(), 0, 'må ikke sætte runer før champion er låst');

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

    // 3) Modstanderne vælger et AD-tungt hold med healing -> kun items opdateres
    state.enemies = [122, 238, 202, 104, 266]; // Darius, Zed, Jhin, Graves, Aatrox
    await waitFor(() => count('PUT') === 2, 20000, 'item set efter modstandere');
    await wait(500);
    assert.strictEqual(runePosts(), 2, 'runer sættes ikke igen når kun modstanderne ændrer sig');
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

    // 6) Næste kamp: auto-siden genbruges, ingen ekstra item sets, rolle-override nulstilles
    state.phase = 'Lobby';
    await wait(2500);
    const putsLobby = count('PUT');
    state.phase = 'ChampSelect';
    await waitFor(() => count('PUT') > putsLobby, 20000, 'anvend i ny kamp');
    await wait(500);
    assert(autoSet().title.endsWith('MID'), 'rolle-override nulstillet');
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
    assert(L2.advice.some((a) => a.adapted && !a.inProgress), 'tilpassede forslag vises stadig');
    console.log('Med Lost Chapter:', JSON.stringify(L2.advice.map((a) => ({ item: a.name, cost: a.cost, hvorfor: a.reasons }))));

    // 7c) Kun en Amplifying Tome (400 g) -> intet låses fast
    setMyItems([1056, 3020, Number(idByName('Amplifying Tome'))]);
    await wait(2500);
    L2 = (await gui('GET', '/state')).body.live;
    assert(!L2.advice.some((a) => a.inProgress), 'en billig del gør ikke et item "i gang"');
    live.data = liveGame(zhonyaPart);
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
    assert.strictEqual((await gui('GET', '/state')).body.live, null);

    // 9) Telefon-adgang: kræver nøgle udefra, POST kun som JSON
    if (process.env.NO_REMOTE) throw new Error('SKIP_REMOTE');
    const base = /Vindue: http:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1];
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal);
    assert(/Telefon \(/.test(out), 'telefon-links i loggen');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
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
    } else {
      console.log('(Intet netværksinterface - springer test af fjernadgang over)');
    }

    assert(!/Fejl:/.test(out), 'ingen fejl i loggen');

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
    if (!hadToken) fs.rmSync(tokenFile, { force: true });
  }
});
