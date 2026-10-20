'use strict';
// Falsk League-klient: spiller en champion select igennem og tjekker hvad lol-helper sender.
// Kør: node test/fake-lcu.test.js  (kræver internet til OP.GG + Data Dragon)
const http = require('http');
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

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  // HELPER_BIN=sti tester den færdige programfil i stedet for scriptet.
  const [cmd, args] = process.env.HELPER_BIN
    ? [path.resolve(process.env.HELPER_BIN), []]
    : [process.execPath, [path.join(__dirname, '..', 'lol-helper.js')]];
  const child = spawn(cmd, args, {
    env: { ...process.env, LOL_HELPER_LCU: `http:${port}:${PASSWORD}`, LOL_HELPER_PORT: '0', LOL_HELPER_NO_WINDOW: '1' },
  });
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

    // Valgfrit: SCREENSHOT=fil.png tager et billede af vinduet med headless Chrome (macOS).
    if (process.env.SCREENSHOT) {
      const base = /Vindue: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
      await new Promise((resolve) => {
        const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${require('os').tmpdir()}/lol-helper-chrome`, `--window-size=${process.env.SCREENSHOT_SIZE || '1100,1250'}`,
          '--timeout=5000', `--screenshot=${path.resolve(process.env.SCREENSHOT)}`, base,
        ]);
        chrome.stderr.on('data', (d) => { if (/written|rror/.test(d)) console.log('chrome:', String(d).trim().slice(0, 200)); });
        const t = setTimeout(() => chrome.kill(), 30000);
        chrome.on('exit', () => { clearTimeout(t); resolve(); });
      });
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
    assert(!/Fejl:/.test(out), 'ingen fejl i loggen');

    console.log(out);
    console.log('ALLE TESTS BESTÅET');
  } catch (e) {
    console.log(out);
    console.error('FEJL:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    server.close();
  }
});
