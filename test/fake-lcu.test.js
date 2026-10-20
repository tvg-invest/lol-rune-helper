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

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'lol-helper.js')], {
    env: { ...process.env, LOL_HELPER_LCU: `http:${port}:${PASSWORD}` },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await waitFor(() => out.includes('venter på champion select'), 20000, 'forbindelse');
    // Champion select: hover Ahri uden at låse -> intet må ske
    state.phase = 'ChampSelect';
    state.championId = 103;
    await wait(2500);
    assert(!calls.some((c) => c.method === 'POST'), 'må ikke sætte runer før champion er låst');
    // Lås Ahri
    state.pickCompleted = true;
    await waitFor(() => calls.some((c) => c.method === 'PUT'), 20000, 'item set PUT');
    await wait(3500); // giv den tid til evt. dobbelt-anvendelse

    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/lol-perks/v1/pages');
    const finalPage = state.pages.find((p) => p.name.startsWith('Auto: '));
    assert(finalPage, 'auto rune-side oprettet');
    assert.strictEqual(finalPage.selectedPerkIds.length, 9, '9 perks (4+2+3)');
    assert(finalPage.current, 'auto-siden er aktiv');
    assert(!state.pages.some((p) => p.name === 'Min side'), 'fuld: brugerens aktive side erstattet');
    assert(state.pages.some((p) => p.name === 'Preset'), 'preset-side urørt');
    assert.strictEqual(posts.length, 2, 'én fejlet POST + én vellykket');

    const spells = calls.find((c) => c.method === 'PATCH').body;
    assert(spells.spell2Id === 4, `Flash bliver på F (keep): ${JSON.stringify(spells)}`);

    assert.strictEqual(state.itemSets.accountId, 77);
    assert(state.itemSets.itemSets.some((s) => s.title === 'Mit eget set'), 'brugerens eget set bevaret');
    const auto = state.itemSets.itemSets.filter((s) => s.title.startsWith('Auto: '));
    assert.strictEqual(auto.length, 1);
    assert.deepStrictEqual(auto[0].associatedChampions, [103]);
    assert(auto[0].blocks.length >= 4, 'mindst 4 item-blokke');
    assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 1, 'kun anvendt én gang');

    // Næste kamp: ny Ahri-pick genbruger auto-siden og laver ikke et ekstra item set
    state.phase = 'Lobby';
    await wait(2500);
    state.phase = 'ChampSelect';
    await waitFor(() => calls.filter((c) => c.method === 'PUT').length === 2, 20000, 'anden PUT');
    await wait(500);
    assert.strictEqual(state.pages.filter((p) => p.name.startsWith('Auto: ')).length, 1, 'stadig kun én auto-side');
    assert.strictEqual(state.itemSets.itemSets.filter((s) => s.title.startsWith('Auto: ')).length, 1, 'stadig kun ét auto-set');

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
