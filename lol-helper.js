#!/usr/bin/env node
'use strict';
// LoL Rune Helper - sætter runer, summoner spells og et item set automatisk,
// når du låser en champion i champion select. Virker på Windows og macOS.
// Taler kun med League-klientens lokale API (LCU) + OP.GG (builds) + Data Dragon (navne/ikoner).
// Viser anbefalingen i et lokalt vindue (http://127.0.0.1:3399).

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

let sea = null;
try { sea = require('node:sea'); } catch {}
const IS_SEA = Boolean(sea?.isSea?.());
// Som færdig programfil ligger config.json ved siden af programmet.
const APP_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname;

const PREFIX = 'Auto: ';
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const DEFAULT_CONFIG = {
  region: 'GLOBAL',       // OP.GG-region: GLOBAL, EUW, EUNE, NA, KR ...
  buildChoice: 'smart',   // 'smart' = højeste win rate blandt populære builds, 'popular' = mest spillede
  setRunes: true,
  setSpells: true,
  flashKey: 'keep',       // 'keep' = Flash bliver på den tast, du allerede har den på. Ellers 'D' eller 'F'.
  setItemSet: true,
  adaptToEnemies: true,   // tilpas items/støvler til modstanderholdet
  openWindow: true,       // åbn vinduet i browseren ved start
  port: 3399,
  pollMs: 1500,
};

const POSITION_MAP = { top: 'TOP', jungle: 'JUNGLE', middle: 'MID', bottom: 'ADC', utility: 'SUPPORT' };
const POSITIONS = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
const SHARD_NAMES = { 5001: 'Health Scaling', 5005: 'Attack Speed', 5007: 'Ability Haste', 5008: 'Adaptive Force', 5010: 'Move Speed', 5011: 'Health', 5013: 'Tenacity & Slow Resist' };
// Champions med meget healing/sustain (Data Dragon-id). Bruges til at anbefale anti-heal.
const HEALERS = new Set(['Aatrox', 'Briar', 'DrMundo', 'Fiddlesticks', 'Fiora', 'Gwen', 'Illaoi', 'Irelia', 'Maokai', 'Milio', 'Nami', 'Olaf', 'Samira', 'Senna', 'Seraphine', 'Sona', 'Soraka', 'Swain', 'Sylas', 'Trundle', 'Vladimir', 'Volibear', 'Warwick', 'Yuumi', 'Zac', 'Viego', 'Belveth', 'Kayn', 'Nasus', 'Darius', 'Udyr', 'Renekton']);
const BOOTS_ARMOR = 3047;
const BOOTS_MR = 3111;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toTimeString().slice(0, 5);
const pct = (x) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
const logLines = [];
function log(msg) {
  const line = `[${time()}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 60) logLines.shift();
  broadcast();
}

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Kunne ikke læse config.json (${e.message}) - bruger standardindstillinger.`);
    return { ...DEFAULT_CONFIG };
  }
}

function readAsset(name) {
  return IS_SEA ? sea.getAsset(name, 'utf8') : fs.readFileSync(path.join(__dirname, name), 'utf8');
}

// ---------- Find League-klienten ----------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

function lockfileCandidates(cmdline) {
  const list = [];
  const dir = /--install-directory=(.+?)(?="|\s+"?--|$)/m.exec(cmdline);
  if (dir) list.push(path.join(dir[1].trim(), 'lockfile'));
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E']) list.push(`${drive}:\\Riot Games\\League of Legends\\lockfile`);
  } else {
    list.push('/Applications/League of Legends.app/Contents/LoL/lockfile');
  }
  return list;
}

async function findClient() {
  // Test-hook: LOL_HELPER_LCU="http:PORT:PASSWORD" peger på en falsk klient.
  if (process.env.LOL_HELPER_LCU) {
    const [protocol, port, password] = process.env.LOL_HELPER_LCU.split(':');
    return { protocol, port: Number(port), password };
  }

  let cmdline;
  if (process.platform === 'win32') {
    cmdline = await run('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]);
  } else {
    cmdline = (await run('ps', ['-A', '-ww', '-o', 'args'])).split('\n').filter((l) => l.includes('LeagueClientUx')).join('\n');
  }
  if (!cmdline.trim()) return null;

  const port = /--app-port=(\d+)/.exec(cmdline);
  const token = /--remoting-auth-token=([\w-]+)/.exec(cmdline);
  if (port && token) return { protocol: 'https', port: Number(port[1]), password: token[1] };

  for (const file of lockfileCandidates(cmdline)) {
    try {
      const [, , p, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
      return { protocol, port: Number(p), password };
    } catch {}
  }
  return null;
}

function lcu(client, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`riot:${client.password}`).toString('base64'),
      Accept: 'application/json',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const mod = client.protocol === 'http' ? http : https;
    // Klienten bruger et selvsigneret certifikat på 127.0.0.1, derfor rejectUnauthorized: false.
    const req = mod.request({ host: '127.0.0.1', port: client.port, path: urlPath, method, headers, rejectUnauthorized: false, timeout: 10000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(text ? JSON.parse(text) : null); } catch { resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath} timeout`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- Statiske data (navne, ikoner) og builds ----------

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lol-rune-helper' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const dd = { version: '', champions: {}, items: {}, runes: {}, spells: {} };

async function loadStaticData() {
  const [version] = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const base = `https://ddragon.leagueoflegends.com/cdn/${version}`;
  const [champs, items, styles, spells] = await Promise.all(
    ['champion', 'item', 'runesReforged', 'summoner'].map((f) => getJson(`${base}/data/en_US/${f}.json`)),
  );
  dd.version = version;
  for (const c of Object.values(champs.data)) {
    dd.champions[c.key] = { id: c.id, name: c.name, tags: c.tags, info: c.info, icon: `${base}/img/champion/${c.image.full}` };
  }
  for (const [id, it] of Object.entries(items.data)) {
    dd.items[id] = { name: it.name, tags: it.tags || [], antiheal: /Grievous Wounds/.test(it.description || ''), icon: `${base}/img/item/${id}.png` };
  }
  for (const style of styles) {
    dd.runes[style.id] = { name: style.name, icon: `https://ddragon.leagueoflegends.com/cdn/img/${style.icon}` };
    for (const slot of style.slots) {
      for (const r of slot.runes) dd.runes[r.id] = { name: r.name, icon: `https://ddragon.leagueoflegends.com/cdn/img/${r.icon}` };
    }
  }
  for (const [id, name] of Object.entries(SHARD_NAMES)) dd.runes[id] = { name, icon: null };
  for (const s of Object.values(spells.data)) dd.spells[s.key] = { name: s.name, icon: `${base}/img/spell/${s.image.full}` };
  return version;
}

const runeName = (id) => dd.runes[id]?.name || String(id);
const itemName = (id) => dd.items[id]?.name || String(id);
const spellName = (id) => dd.spells[id]?.name || String(id);

const buildCache = new Map();

async function fetchBuild(region, mode, championId, position) {
  const key = `${region}:${mode}:${championId}:${position}`;
  if (!buildCache.has(key)) {
    const url = `https://lol-api-champion.op.gg/api/${region}/champions/${mode}/${championId}/${position}`;
    buildCache.set(key, getJson(url).then((j) => ({ ...j.data, version: j.meta?.version })).catch((e) => {
      buildCache.delete(key);
      throw e;
    }));
  }
  return buildCache.get(key);
}

// Finder build for championen. Uden rolle (blind pick) bruges championens hovedrolle.
async function getBuild(cfg, championId, position, gameMode) {
  if (gameMode === 'ARAM') return { build: await fetchBuild(cfg.region, 'aram', championId, 'none'), position: 'ARAM' };
  if (position) return { build: await fetchBuild(cfg.region, 'ranked', championId, position), position };
  const probe = await fetchBuild(cfg.region, 'ranked', championId, 'MID');
  position = probe.summary?.positions?.[0]?.name || 'MID';
  return { build: position === 'MID' ? probe : await fetchBuild(cfg.region, 'ranked', championId, position), position };
}

// Kampe/win rate for den valgte rolle. Spiller man championen off-role, findes kun tallet for alle roller.
function roleStats(b) {
  const role = b.build.summary?.positions?.find((p) => p.name === b.position)?.stats;
  if (role) return { play: role.play, winRate: role.win_rate, scope: b.position };
  const all = b.build.summary?.average_stats;
  return all ? { play: all.play, winRate: all.win_rate, scope: 'alle roller' } : null;
}

// OP.GG sorterer efter popularitet. 'smart' tager den højeste win rate blandt
// muligheder med mindst 25% af den mest spillede muligheds kampe (og mindst 100 kampe).
function rankOptions(options, cfg) {
  if (!options?.length) return [];
  if (cfg.buildChoice === 'popular') return options;
  const top = Math.max(...options.map((o) => o.play));
  const min = Math.max(100, top * 0.25);
  const wr = (o) => o.win / o.play;
  const solid = options.filter((o) => o.play >= min).sort((a, b) => wr(b) - wr(a));
  return [...solid, ...options.filter((o) => o.play < min)];
}

// ---------- Modstanderholdet ----------

function analyzeEnemies(enemyIds) {
  const champs = enemyIds.map((id) => dd.champions[id]).filter(Boolean);
  const n = champs.length;
  let ad = 0;
  let ap = 0;
  for (const c of champs) {
    const total = c.info.attack + c.info.magic || 1;
    ad += c.info.attack / total;
    ap += c.info.magic / total;
  }
  const healers = champs.filter((c) => HEALERS.has(c.id));
  const ccHeavy = champs.filter((c) => c.tags.includes('Tank') || c.tags.includes('Support')).length >= 3;
  return {
    champions: champs,
    adShare: n ? ad / n : 0,
    apShare: n ? ap / n : 0,
    adHeavy: n >= 2 && ad / n >= 0.68,
    apHeavy: n >= 2 && ap / n >= 0.5,
    healers,
    ccHeavy,
  };
}

// Vælger kun items, som championen faktisk bygger (OP.GG's item-pulje), så forslagene passer til klassen.
function counterItems(build, enemy, used) {
  const pool = [];
  for (const x of [...(build.last_items || []), ...(build.core_items || [])]) {
    for (const id of x.ids) if (!pool.includes(id) && !used.has(id) && !dd.items[id]?.tags.includes('Boots')) pool.push(id);
  }
  const picks = [];
  const notes = [];
  const take = (pred, count, why) => {
    const found = pool.filter((id) => !picks.includes(id) && pred(dd.items[id] || { tags: [] })).slice(0, count);
    if (found.length) {
      picks.push(...found);
      notes.push(`${why}: ${found.map(itemName).join(', ')}`);
    }
  };
  if (enemy.healers.length) take((it) => it.antiheal, 1, `Anti-heal mod ${enemy.healers.map((c) => c.name).join(', ')}`);
  if (enemy.adHeavy) take((it) => it.tags.includes('Armor'), 2, `Armor (${pct(enemy.adShare)} AD)`);
  if (enemy.apHeavy) take((it) => it.tags.includes('SpellBlock'), 2, `Magic resist (${pct(enemy.apShare)} AP)`);
  return { picks, notes };
}

function chooseBoots(build, enemy, cfg) {
  const options = rankOptions(build.boots, cfg).map((b) => b.ids[0]);
  if (!options.length) return { boots: [], note: null };
  const has = (id) => options.includes(id);
  let main = options[0];
  let note = null;
  if (enemy?.adHeavy && has(BOOTS_ARMOR)) { main = BOOTS_ARMOR; note = 'Plated Steelcaps mod AD-tungt hold'; }
  else if (enemy && (enemy.apHeavy || enemy.ccHeavy) && has(BOOTS_MR)) { main = BOOTS_MR; note = `Mercury's Treads mod ${enemy.apHeavy ? 'AP' : 'meget CC'}`; }
  return { boots: [main, ...options.filter((id) => id !== main).slice(0, 1)], note };
}

// ---------- Anbefaling ----------

function itemBlock(type, ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return { type, hideIfSummonerSpell: '', showIfSummonerSpell: '', items: [...counts].map(([id, count]) => ({ id: String(id), count })) };
}

function recommend(build, cfg, enemyIds) {
  const enemy = cfg.adaptToEnemies && enemyIds.length ? analyzeEnemies(enemyIds) : null;
  const blocks = [];
  const notes = [];
  const used = new Set();
  const addUsed = (ids) => ids.forEach((id) => used.add(id));

  const skillOrder = build.skills?.[0]?.order || [];
  const skills = { start: skillOrder.slice(0, 3), max: build.skill_masteries?.[0]?.ids || [] };

  const start = rankOptions(build.starter_items, { buildChoice: 'popular' })[0];
  if (start) blocks.push(itemBlock(`Start${skills.max.length ? ` - max ${skills.max.join(' > ')}` : ''}`, start.ids));

  const cores = rankOptions(build.core_items, cfg);
  const core = cores[0];
  if (core) {
    blocks.push(itemBlock(`Core build (${pct(core.win / core.play)} WR)`, core.ids));
    addUsed(core.ids);
  }

  const { boots, note: bootsNote } = chooseBoots(build, enemy, cfg);
  if (bootsNote) notes.push(bootsNote);
  addUsed(boots);

  if (enemy) {
    const counter = counterItems(build, enemy, used);
    if (counter.picks.length) {
      blocks.push(itemBlock('Mod deres hold', counter.picks));
      addUsed(counter.picks);
      notes.push(...counter.notes);
    }
  }
  if (boots.length) blocks.push(itemBlock('Støvler', boots));

  const alt = [];
  for (const c of cores.slice(1, 4)) for (const id of c.ids) if (!used.has(id) && !alt.includes(id)) alt.push(id);
  if (alt.length) blocks.push(itemBlock('Alternative core', alt));
  addUsed(alt);
  const late = (build.last_items || []).map((x) => x.ids[0]).filter((id) => !used.has(id)).slice(0, 8);
  if (late.length) blocks.push(itemBlock('Situationelle items', late));
  blocks.push(itemBlock('Forbrug', [2003, 2055]));

  const runePages = (build.rune_pages || []).flatMap((p) => p.builds || []);
  const runeOptions = rankOptions(runePages.length ? runePages : build.runes, cfg).slice(0, 3);
  const spells = rankOptions(build.summoner_spells, { buildChoice: 'popular' })[0]?.ids || null;

  return { blocks, notes, skills, runeOptions, spells, enemy };
}

// ---------- Anvend på klienten ----------

async function applyRunes(client, rune, title) {
  const page = {
    name: (PREFIX + title).slice(0, 25),
    primaryStyleId: rune.primary_page_id,
    subStyleId: rune.secondary_page_id,
    selectedPerkIds: [...rune.primary_rune_ids, ...rune.secondary_rune_ids, ...rune.stat_mod_ids],
    current: true,
  };
  const pages = await lcu(client, 'GET', '/lol-perks/v1/pages');
  const editable = pages.filter((p) => p.isDeletable);
  // Genbrug vores egen side hvis den findes, så vi aldrig fylder dine sider op.
  const ours = editable.find((p) => p.name?.startsWith(PREFIX));
  if (ours) await lcu(client, 'DELETE', `/lol-perks/v1/pages/${ours.id}`);
  try {
    await lcu(client, 'POST', '/lol-perks/v1/pages', page);
  } catch (e) {
    // Alle rune-sider er i brug: overskriv den aktive (eller sidste) redigerbare side.
    const victim = editable.find((p) => p.current && p.id !== ours?.id) || editable.filter((p) => p.id !== ours?.id).pop();
    if (!victim) throw e;
    log(`  Alle rune-sider er fulde - erstatter siden "${victim.name}" (sker kun første gang).`);
    await lcu(client, 'DELETE', `/lol-perks/v1/pages/${victim.id}`);
    await lcu(client, 'POST', '/lol-perks/v1/pages', page);
  }
}

async function applySpells(client, cfg, me, spellIds) {
  let [a, b] = spellIds;
  const flashFirst = cfg.flashKey === 'D' || (cfg.flashKey === 'keep' && me.spell1Id === 4);
  const flashSecond = cfg.flashKey === 'F' || (cfg.flashKey === 'keep' && me.spell2Id === 4);
  if ((b === 4 && flashFirst) || (a === 4 && flashSecond)) [a, b] = [b, a];
  await lcu(client, 'PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: a, spell2Id: b });
  return [a, b];
}

async function applyItemSet(client, championId, title, blocks) {
  const summoner = await lcu(client, 'GET', '/lol-summoner/v1/current-summoner');
  const url = `/lol-item-sets/v1/item-sets/${summoner.summonerId}/sets`;
  const current = (await lcu(client, 'GET', url)) || {};
  // Behold dine egne sets; erstat kun vores tidligere auto-set for samme champion.
  const itemSets = (current.itemSets || []).filter((s) => !(s.title?.startsWith(PREFIX) && s.associatedChampions?.includes(championId)));
  itemSets.unshift({
    uid: randomUUID(),
    title: PREFIX + title,
    type: 'custom',
    map: 'any',
    mode: 'any',
    startedFrom: 'blank',
    sortrank: 0,
    associatedChampions: [championId],
    associatedMaps: [],
    preferredItemSlots: [],
    blocks,
  });
  await lcu(client, 'PUT', url, { accountId: current.accountId ?? summoner.accountId, itemSets, timestamp: Date.now() });
}

// ---------- Tilstand + vindue ----------

const app = {
  cfg: DEFAULT_CONFIG,
  client: null,
  status: 'Starter...',
  pick: null,          // { championId, assignedPosition, gameMode, me, enemyIds }
  roleOverride: null,
  runeIndex: 0,
  build: null,         // { build, position }
  rec: null,
  applied: { pickKey: null, itemKey: null },
};

// Kører LCU-ændringer én ad gangen, så vinduet og løkken ikke kolliderer.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

function viewModel() {
  const { pick, build: b, rec } = app;
  const base = { status: app.status, log: logLines.slice(-12), positions: POSITIONS, ddVersion: dd.version };
  if (!pick || !b || !rec) return base;
  const champ = dd.champions[pick.championId] || { name: `Champion ${pick.championId}` };
  const stats = roleStats(b);
  const rune = (id) => ({ name: runeName(id), icon: dd.runes[id]?.icon || null });
  return {
    ...base,
    champion: { name: champ.name, icon: champ.icon },
    position: b.position,
    roleOverride: app.roleOverride,
    gameMode: pick.gameMode,
    patch: b.build.version,
    games: stats?.play,
    winRate: stats?.winRate,
    statsScope: stats?.scope,
    runeIndex: app.runeIndex,
    runeOptions: rec.runeOptions.map((r) => ({
      primary: rune(r.primary_page_id),
      secondary: rune(r.secondary_page_id),
      primaryRunes: r.primary_rune_ids.map(rune),
      secondaryRunes: r.secondary_rune_ids.map(rune),
      shards: r.stat_mod_ids.map(runeName),
      games: r.play,
      winRate: r.win / r.play,
    })),
    spells: (app.appliedSpells || rec.spells || []).map((id) => ({ name: spellName(id), icon: dd.spells[id]?.icon })),
    skills: rec.skills,
    blocks: rec.blocks.map((bl) => ({
      title: bl.type,
      items: bl.items.map((i) => ({ id: i.id, count: i.count, name: itemName(i.id), icon: dd.items[i.id]?.icon })),
    })),
    notes: rec.notes,
    enemy: rec.enemy && {
      champions: rec.enemy.champions.map((c) => ({ name: c.name, icon: c.icon })),
      adShare: rec.enemy.adShare,
      apShare: rec.enemy.apShare,
    },
  };
}

const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(viewModel())}\n\n`;
  for (const res of sseClients) res.write(data);
}

function setStatus(msg) {
  if (msg === app.status) return;
  app.status = msg;
  log(msg);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function startWindowServer(port) {
  const html = readAsset('gui.html');
  const server = http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && req.url === '/state') return json(200, viewModel());
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(viewModel())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/rune') {
      const { index } = await readBody(req);
      if (!app.rec?.runeOptions[index] || !app.client) return json(400, { error: 'Ingen rune-side at vælge' });
      try {
        await serial(() => applyRuneChoice(index));
        return json(200, { ok: true });
      } catch (e) {
        log(`Fejl: ${e.message}`);
        return json(500, { error: e.message });
      }
    }
    if (req.method === 'POST' && req.url === '/api/role') {
      const { position } = await readBody(req);
      if (position !== null && !POSITIONS.includes(position)) return json(400, { error: 'Ukendt rolle' });
      app.roleOverride = position;
      app.applied.pickKey = null; // løkken anvender igen med ny rolle
      log(position ? `Rolle sat manuelt til ${position}.` : 'Rolle: automatisk.');
      return json(200, { ok: true });
    }
    json(404, { error: 'Ikke fundet' });
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attempts) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempts > 0) return tryListen(p + 1, attempts - 1);
        reject(e);
      });
      // Kun 127.0.0.1: vinduet kan ikke nås fra andre maskiner.
      server.listen(p, '127.0.0.1', () => resolve(server.address().port));
    };
    tryListen(port, 10);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

// ---------- Champion select ----------

function titleFor() {
  const champ = dd.champions[app.pick.championId]?.name || `Champion ${app.pick.championId}`;
  return `${champ} ${app.build.position}`;
}

async function applyRuneChoice(index) {
  const rune = app.rec.runeOptions[index];
  await applyRunes(app.client, rune, titleFor());
  app.runeIndex = index;
  log(`  Runer: ${runeName(rune.primary_page_id)}: ${rune.primary_rune_ids.map(runeName).join(', ')} | ${runeName(rune.secondary_page_id)}: ${rune.secondary_rune_ids.map(runeName).join(', ')} | ${rune.stat_mod_ids.map(runeName).join(', ')}`);
}

async function applyItems() {
  const { cfg, rec } = app;
  if (cfg.setItemSet) await applyItemSet(app.client, app.pick.championId, titleFor(), rec.blocks);
  for (const note of rec.notes) log(`  Tilpasset: ${note}`);
  for (const block of rec.blocks) {
    const items = block.items.map((i) => (i.count > 1 ? `${i.count}x ` : '') + itemName(i.id)).join(', ');
    log(`  ${block.type}: ${items}`);
  }
  if (cfg.setItemSet) log(`  Item set "${PREFIX}${titleFor()}" ligger i butikken i spillet.`);
}

async function handlePick(pick, pickKey, itemKey) {
  const { cfg } = app;
  const fullApply = pickKey !== app.applied.pickKey;
  app.pick = pick;
  const champName = dd.champions[pick.championId]?.name || `Champion ${pick.championId}`;
  if (pick.gameMode === 'CHERRY') {
    app.applied = { pickKey, itemKey };
    return log(`${champName}: Arena har ingen runer - springer over.`);
  }

  // Sæt nøglerne først, så en fejl ikke giver en uendelig gentagelse (rolle-knappen i vinduet prøver igen).
  app.applied = { pickKey, itemKey };
  if (fullApply) {
    app.build = null;
    app.rec = null;
    app.runeIndex = 0;
    app.appliedSpells = null;
    const position = app.roleOverride || POSITION_MAP[pick.assignedPosition];
    app.build = await getBuild(cfg, pick.championId, position, pick.gameMode);
  }
  if (!app.build) return;
  app.rec = recommend(app.build.build, cfg, pick.enemyIds);

  if (fullApply) {
    const stats = roleStats(app.build);
    log(`${champName} (${app.build.position}) - patch ${app.build.build.version || '?'}` +
      (stats ? `, ${stats.play.toLocaleString('da-DK')} kampe, ${pct(stats.winRate)} WR (${stats.scope})` : ''));
    if (cfg.setRunes && app.rec.runeOptions.length) await applyRuneChoice(0);
    if (cfg.setSpells && app.rec.spells) {
      app.appliedSpells = await applySpells(app.client, cfg, pick.me, app.rec.spells);
      log(`  Summoners: ${spellName(app.appliedSpells[0])} (D) + ${spellName(app.appliedSpells[1])} (F)`);
    }
    if (app.rec.skills.start.length) log(`  Skills: start ${app.rec.skills.start.join(' > ')}, max ${app.rec.skills.max.join(' > ')}`);
  } else {
    log(`Modstanderholdet ændrede sig - opdaterer items for ${champName}.`);
  }
  await applyItems();
}

async function tick() {
  const { cfg } = app;
  if (!app.client) {
    app.client = await findClient();
    if (!app.client) { setStatus('Venter på League-klienten...'); return 3000; }
  }
  const phase = await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase');
  if (phase !== 'ChampSelect') {
    setStatus(phase === 'InProgress' ? 'I kamp - held og lykke!' : 'Forbundet til klienten - venter på champion select.');
    if (app.applied.pickKey) {
      app.applied = { pickKey: null, itemKey: null };
      app.roleOverride = null;
    }
    return cfg.pollMs;
  }
  const session = await lcu(app.client, 'GET', '/lol-champ-select/v1/session');
  const me = session.myTeam?.find((m) => m.cellId === session.localPlayerCellId);
  const pickPending = (session.actions || []).flat()
    .some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && !a.completed);
  if (!(me?.championId > 0) || pickPending) {
    setStatus('Champion select - venter på at du låser en champion.');
    return cfg.pollMs;
  }
  setStatus('Champion select - build sat.');
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0).sort((a, b) => a - b);
  const pickKey = `${me.championId}:${me.assignedPosition}:${app.roleOverride || ''}`;
  const itemKey = `${pickKey}|${enemyIds.join(',')}`;
  if (pickKey !== app.applied.pickKey || (cfg.adaptToEnemies && itemKey !== app.applied.itemKey)) {
    const gameMode = pickKey === app.applied.pickKey && app.pick ? app.pick.gameMode
      : await lcu(app.client, 'GET', '/lol-gameflow/v1/session').then(
        (f) => f?.gameData?.queue?.gameMode || f?.map?.gameMode || 'CLASSIC', () => 'CLASSIC');
    await serial(() => handlePick({ championId: me.championId, assignedPosition: me.assignedPosition, gameMode, me, enemyIds }, pickKey, itemKey));
    broadcast();
  }
  return cfg.pollMs;
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Kræver Node 18 eller nyere (du har ${process.versions.node}). Hent den på https://nodejs.org`);
    process.exit(1);
  }
  app.cfg = loadConfig();
  if (process.env.LOL_HELPER_PORT) app.cfg.port = Number(process.env.LOL_HELPER_PORT);
  if (process.env.LOL_HELPER_NO_WINDOW) app.cfg.openWindow = false;
  log('LoL Rune Helper starter...');
  const ddVersion = await loadStaticData();
  log(`Data Dragon ${ddVersion} hentet. Builds fra OP.GG (${app.cfg.region}, ${app.cfg.buildChoice}).`);
  const port = await startWindowServer(app.cfg.port);
  const url = `http://127.0.0.1:${port}`;
  log(`Vindue: ${url}`);
  if (app.cfg.openWindow) openBrowser(url);

  for (;;) {
    let wait = app.cfg.pollMs;
    try {
      wait = await tick();
    } catch (e) {
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e.code)) {
        app.client = null;
        setStatus('Mistede forbindelsen til klienten - leder igen...');
      } else {
        log(`Fejl: ${e.message}`);
      }
    }
    await sleep(wait);
  }
}

main().catch((e) => {
  console.error(e);
  if (IS_SEA) setTimeout(() => process.exit(1), 30000); // hold vinduet åbent så fejlen kan læses
  else process.exit(1);
});
