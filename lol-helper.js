#!/usr/bin/env node
'use strict';
// LoL Rune Helper - sætter runer, summoner spells og et item set automatisk,
// når du låser en champion i champion select. Virker på Windows og macOS.
// Under kampen læser den Riots Live Client Data API (kun det du også ser på TAB)
// og viser 2-3 begrundede købsforslag + scoreboard.
// Taler kun med League-klientens lokale API'er + OP.GG (builds) + Data Dragon (navne/ikoner).
// Viser det hele i et lokalt vindue (http://127.0.0.1:3399).

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID, randomBytes } = require('crypto');

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
  liveAdvice: true,       // købsforslag + scoreboard under kampen
  openWindow: true,       // åbn vinduet i browseren ved start
  remoteAccess: false,    // true = vinduet kan åbnes fra telefonen (Tailscale/wifi) med en hemmelig nøgle
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
  const headers = { Authorization: 'Basic ' + Buffer.from(`riot:${client.password}`).toString('base64') };
  return localJson(client.protocol, client.port, method, urlPath, headers, body, 10000);
}

// Spillets Live Client Data API (port 2999) - kun tilgængelig mens en kamp kører.
const LIVE = (() => {
  const [protocol, port] = (process.env.LOL_HELPER_LIVE || 'https:2999').split(':');
  return { protocol, port: Number(port) };
})();
const liveGet = (urlPath) => localJson(LIVE.protocol, LIVE.port, 'GET', urlPath, {}, undefined, 3000);

function localJson(protocol, port, method, urlPath, extraHeaders, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const mod = protocol === 'http' ? http : https;
    // Klienten og spillet bruger selvsignerede certifikater på 127.0.0.1, derfor rejectUnauthorized: false.
    const req = mod.request({ host: '127.0.0.1', port, path: urlPath, method, headers, rejectUnauthorized: false, timeout }, (res) => {
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

const dd = { version: '', champions: {}, championKeyById: {}, items: {}, runes: {}, spells: {} };

async function loadStaticData() {
  const [version] = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const base = `https://ddragon.leagueoflegends.com/cdn/${version}`;
  const [champs, items, styles, spells] = await Promise.all(
    ['champion', 'item', 'runesReforged', 'summoner'].map((f) => getJson(`${base}/data/en_US/${f}.json`)),
  );
  dd.version = version;
  for (const c of Object.values(champs.data)) {
    dd.champions[c.key] = { key: c.key, id: c.id, name: c.name, tags: c.tags, info: c.info, icon: `${base}/img/champion/${c.image.full}` };
    dd.championKeyById[c.id.toLowerCase()] = c.key;
  }
  for (const [id, it] of Object.entries(items.data)) {
    dd.items[id] = {
      name: it.name,
      tags: it.tags || [],
      antiheal: /Grievous Wounds/.test(it.description || ''),
      icon: `${base}/img/item/${id}.png`,
      gold: it.gold?.total || 0,
      from: it.from || [],
      into: it.into || [],
      depth: it.depth || 1,
      stats: it.stats || {},
      purchasable: it.gold?.purchasable !== false,
      maps: it.maps || {},
    };
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

// ---------- Live i kampen ----------
// Bruger kun det spilleren selv kan se (TAB-scoreboard, kill-feed, eget guld) - jf. Riots regler
// giver vi 2-3 begrundede forslag i stedet for at bestemme for spilleren.

const LIVE_POSITION = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', BOTTOM: 'ADC', UTILITY: 'SUPPORT' };
const OBJECTIVES = { DragonKill: 'dragons', BaronKill: 'barons', HeraldKill: 'heralds' };

const playerName = (p) => p.riotId || p.summonerName || '';
const shortName = (p) => p.riotIdGameName || playerName(p).split('#')[0];

function championOf(p) {
  const raw = /game_character_displayname_(.+)$/.exec(p.rawChampionName || '')?.[1];
  const key = (raw && dd.championKeyById[raw.toLowerCase()])
    || Object.values(dd.champions).find((c) => c.name === p.championName)?.key;
  return key ? dd.champions[key] : null;
}

const isCompleted = (it) => it && !it.tags.includes('Consumable') && !it.tags.includes('Trinket') &&
  (it.tags.includes('Boots') ? it.depth >= 2 : it.into.length === 0 && it.gold >= 1500);

// Skadetype ud fra de items de faktisk har købt (fanger fx AP Shaco); ellers championens profil.
function damageProfile(champ, itemIds) {
  let ad = 0;
  let ap = 0;
  for (const id of itemIds) {
    const it = dd.items[id];
    if (!it) continue;
    const phys = it.stats.FlatPhysicalDamageMod > 0 || it.tags.includes('CriticalStrike');
    const magic = it.stats.FlatMagicDamageMod > 0;
    if (phys && magic) { ad += it.gold / 2; ap += it.gold / 2; } else if (phys) ad += it.gold; else if (magic) ap += it.gold;
  }
  if (ad + ap >= 2500) return { ad: ad / (ad + ap), ap: ap / (ad + ap) };
  const total = (champ?.info.attack || 5) + (champ?.info.magic || 5);
  return { ad: (champ?.info.attack || 5) / total, ap: (champ?.info.magic || 5) / total };
}

function livePlayer(p) {
  const champ = championOf(p);
  const itemIds = [];
  for (const i of p.items || []) for (let n = 0; n < (i.count || 1); n++) itemIds.push(String(i.itemID));
  const itemGold = itemIds.reduce((sum, id) => sum + (dd.items[id]?.gold || 0), 0);
  const s = p.scores || {};
  return {
    key: playerName(p),
    name: shortName(p),
    champ,
    team: p.team,
    level: p.level || 1,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
    assists: s.assists || 0,
    cs: s.creepScore || 0,
    isDead: Boolean(p.isDead),
    itemIds,
    itemGold,
    dmg: damageProfile(champ, itemIds),
    armor: itemIds.reduce((sum, id) => sum + (dd.items[id]?.stats.FlatArmorMod || 0), 0),
    mr: itemIds.reduce((sum, id) => sum + (dd.items[id]?.stats.FlatSpellBlockMod || 0), 0),
    healing: HEALERS.has(champ?.id) || itemIds.some((id) => dd.items[id]?.tags.some((t) => t === 'LifeSteal' || t === 'SpellVamp')),
  };
}

// Pris tilbage når de dele du allerede ejer trækkes fra (hver ejet del tælles én gang).
function remainingCost(id, ownedIds) {
  const owned = [...ownedIds];
  let cost = dd.items[id]?.gold || 0;
  // Ejer du en del, trækkes hele dens pris fra; ellers kigges på dens egne dele.
  const take = (x) => {
    for (const c of dd.items[x]?.from || []) {
      const i = owned.indexOf(c);
      if (i !== -1) { owned.splice(i, 1); cost -= dd.items[c].gold; } else take(c);
    }
  };
  take(id);
  return Math.max(0, cost);
}

function affordablePart(id, ownedIds, gold) {
  const parts = new Set();
  const walk = (x) => { for (const c of dd.items[x]?.from || []) { parts.add(c); walk(c); } };
  walk(id);
  return [...parts]
    .filter((p) => !ownedIds.includes(p) && dd.items[p]?.gold <= gold)
    .sort((a, b) => dd.items[b].gold - dd.items[a].gold)[0] || null;
}

function threatOf(p) {
  return p.itemGold + p.kills * 300 + p.assists * 100 + p.level * 150 - p.deaths * 100;
}

function analyzeLive(data, build) {
  const all = (data.allPlayers || []).map(livePlayer);
  const activeName = data.activePlayer?.riotId || data.activePlayer?.summonerName || '';
  const me = all.find((p) => p.key === activeName) || all.find((p) => activeName && activeName.split('#')[0] === p.name);
  if (!me) return null;
  const allies = all.filter((p) => p.team === me.team);
  const enemies = all.filter((p) => p.team !== me.team);
  const gold = Math.floor(data.activePlayer?.currentGold || 0);

  // Objectives fra kill-feedet
  const teamOf = new Map();
  for (const p of data.allPlayers || []) for (const n of [playerName(p), shortName(p), p.summonerName]) if (n) teamOf.set(n, p.team);
  const score = { ORDER: { dragons: 0, barons: 0, heralds: 0, turrets: 0 }, CHAOS: { dragons: 0, barons: 0, heralds: 0, turrets: 0 } };
  for (const e of data.events?.Events || []) {
    if (OBJECTIVES[e.EventName]) {
      const team = teamOf.get(e.KillerName);
      if (team && score[team]) score[team][OBJECTIVES[e.EventName]]++;
    } else if (e.EventName === 'TurretKilled') {
      // Turret_T1_... tilhører ORDER, så CHAOS får point (og omvendt).
      const owner = /_T([12])_/.exec(e.TurretKilled || '')?.[1];
      if (owner) score[owner === '1' ? 'CHAOS' : 'ORDER'].turrets++;
    }
  }

  // Modstanderne
  const threats = enemies.map((p) => ({ p, t: threatOf(p) }));
  const avgThreat = threats.reduce((s, x) => s + x.t, 0) / (threats.length || 1);
  const fed = threats
    .filter(({ p, t }) => (p.kills - p.deaths >= 3 && p.kills >= 4) || (t >= avgThreat * 1.4 && p.kills >= 3))
    .sort((a, b) => b.t - a.t).map((x) => x.p);
  const totalThreat = threats.reduce((s, x) => s + Math.max(x.t, 1), 0) || 1;
  const adShare = threats.reduce((s, x) => s + Math.max(x.t, 1) * x.p.dmg.ad, 0) / totalThreat;
  const apShare = 1 - adShare;
  const armorStackers = enemies.filter((p) => p.armor >= 40);
  const mrStackers = enemies.filter((p) => p.mr >= 40);
  const healers = enemies.filter((p) => p.healing);
  // Pen-items først når mindst 2 stacker forsvar, eller én stacker meget (én tank med ét item er normalt).
  const armorHeavy = armorStackers.length >= 2 || armorStackers.some((p) => p.armor >= 80);
  const mrHeavy = mrStackers.length >= 2 || mrStackers.some((p) => p.mr >= 80);
  const enemy = { fed, adShare, apShare, armorStackers, mrStackers, armorHeavy, mrHeavy, healers };

  const advice = liveAdvice(build, me, enemy, gold, data.gameData?.mapNumber || 11);
  return { me, allies, enemies, gold, gameTime: data.gameData?.gameTime || 0, gameMode: data.gameData?.gameMode, score, enemy, advice };
}

// 2-3 forslag fra championens egen item-pulje, scoret efter popularitet + modstandernes faktiske builds.
function liveAdvice(build, me, enemy, gold, mapNumber) {
  if (!build) return [];
  const pop = new Map();
  for (const c of build.core_items || []) for (const id of c.ids) pop.set(String(id), (pop.get(String(id)) || 0) + (c.pick_rate || 0));
  for (const x of build.last_items || []) { const id = String(x.ids[0]); pop.set(id, Math.max(pop.get(id) || 0, x.pick_rate || 0)); }
  for (const x of build.boots || []) { const id = String(x.ids[0]); pop.set(id, Math.max(pop.get(id) || 0, x.pick_rate || 0)); }

  const owned = me.itemIds;
  const hasBoots = owned.some((id) => dd.items[id]?.tags.includes('Boots') && dd.items[id].depth >= 2);
  const hasAntiheal = owned.some((id) => dd.items[id]?.antiheal);
  const iAmAD = me.dmg.ad >= 0.5;
  const names = (list) => list.slice(0, 3).map((p) => p.champ?.name || p.name).join(', ');
  const kda = (p) => `${p.kills}/${p.deaths}/${p.assists}`;

  // Healere men intet anti-heal i championens pulje: tag det anti-heal-item der passer til din skadetype.
  const poolHasAntiheal = [...pop].some(([id, p]) => p >= 0.02 && dd.items[id]?.antiheal && isCompleted(dd.items[id]));
  if (enemy.healers.length && !hasAntiheal && !poolHasAntiheal) {
    const stat = iAmAD ? 'FlatPhysicalDamageMod' : 'FlatMagicDamageMod';
    const fallback = Object.keys(dd.items).find((id) => {
      const it = dd.items[id];
      return it.antiheal && isCompleted(it) && it.purchasable && it.maps[mapNumber] !== false && it.stats[stat] > 0;
    });
    if (fallback) pop.set(fallback, -1); // -1 = fallback, slipper for minimums-popularitet
  }

  const scored = [];
  for (const [id, popularity] of pop) {
    const it = dd.items[id];
    if (!isCompleted(it) || !it.purchasable || it.maps[mapNumber] === false || owned.includes(id)) continue;
    if (hasBoots && it.tags.includes('Boots')) continue;
    if (hasAntiheal && it.antiheal) continue;
    // Sjældne køb i puljen (fx Randuin's på en mage) passer sjældent til championen.
    if (popularity >= 0 && popularity < 0.02) continue;
    let score = Math.max(popularity, 0) * 100;
    const reasons = [];
    if (it.antiheal && enemy.healers.length) { score += 30 + 15 * enemy.healers.length; reasons.push(`Anti-heal mod ${names(enemy.healers)}`); }
    if (it.tags.includes('ArmorPenetration') && iAmAD && enemy.armorHeavy) { score += 35; reasons.push(`${names(enemy.armorStackers)} bygger armor`); }
    if (it.tags.includes('MagicPenetration') && !iAmAD && enemy.mrHeavy) { score += 35; reasons.push(`${names(enemy.mrStackers)} bygger magic resist`); }
    const fedAD = enemy.fed.find((p) => p.dmg.ad >= 0.6);
    const fedAP = enemy.fed.find((p) => p.dmg.ap >= 0.6);
    if (it.tags.includes('Armor') && fedAD) { score += 30; reasons.push(`${fedAD.champ?.name || fedAD.name} er fed (${kda(fedAD)}) og laver AD-skade`); }
    if (it.tags.includes('SpellBlock') && fedAP) { score += 30; reasons.push(`${fedAP.champ?.name || fedAP.name} er fed (${kda(fedAP)}) og laver AP-skade`); }
    if (it.tags.includes('Armor') && enemy.adShare >= 0.65) { score += 15; reasons.push(`${pct(enemy.adShare)} af deres trussel er AD`); }
    if (it.tags.includes('SpellBlock') && enemy.apShare >= 0.55) { score += 15; reasons.push(`${pct(enemy.apShare)} af deres trussel er AP`); }
    if (!reasons.length) reasons.push(`Fast del af buildet (${pct(Math.min(popularity, 1))} køber det)`);
    const cost = remainingCost(id, owned);
    const part = cost > gold ? affordablePart(id, owned, gold) : null;
    scored.push({ id, score, reasons, cost, canAfford: cost <= gold, part, adapted: reasons.length && !reasons[0].startsWith('Fast del') });
  }
  scored.sort((a, b) => b.score - a.score);
  // Op til 2 tilpassede forslag (der er en konkret grund), resten fyldes med det bedste fra buildet.
  // Max ét anti-heal-item.
  const out = [];
  const add = (s) => {
    if (out.includes(s) || out.length === 3) return;
    if (dd.items[s.id].antiheal && out.some((o) => dd.items[o.id].antiheal)) return;
    out.push(s);
  };
  scored.filter((s) => s.adapted).slice(0, 2).forEach(add);
  scored.forEach(add);
  return out.sort((a, b) => b.score - a.score);
}

async function updateLive(data) {
  const activeName = data.activePlayer?.riotId || data.activePlayer?.summonerName || '';
  const meRaw = (data.allPlayers || []).find((p) => playerName(p) === activeName)
    || (data.allPlayers || []).find((p) => activeName && activeName.split('#')[0] === shortName(p));
  const champ = meRaw && championOf(meRaw);
  if (!champ) { app.live = null; return; }

  // Genbrug buildet fra champion select; ellers hent det (fx hvis programmet startes midt i kampen).
  if (app.liveBuild?.championKey !== champ.key) {
    let build = null;
    if (app.build && app.pick?.championId === Number(champ.key)) build = app.build.build;
    else {
      const aram = data.gameData?.gameMode === 'ARAM';
      try {
        build = (await getBuild(app.cfg, Number(champ.key), aram ? null : LIVE_POSITION[meRaw.position] || null, aram ? 'ARAM' : 'CLASSIC')).build;
      } catch (e) { log(`Kunne ikke hente build til live-forslag: ${e.message}`); }
    }
    app.liveBuild = { championKey: champ.key, build };
  }
  const first = !app.live;
  app.live = analyzeLive(data, app.liveBuild.build);
  if (first && app.live) log(`Live: ${champ.name} - forslag og scoreboard vises i vinduet.`);
  broadcast();
}

async function liveLoop() {
  for (;;) {
    let wait = 2000;
    try {
      const data = await liveGet('/liveclientdata/allgamedata');
      if (data?.allPlayers?.length && data.activePlayer) await updateLive(data);
    } catch (e) {
      if (app.live) {
        app.live = null;
        app.liveBuild = null;
        log('Kampen er slut.');
      }
      wait = 3000;
    }
    await sleep(wait);
  }
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
  live: null,          // analyse af den igangværende kamp
  liveBuild: null,     // { championKey, build }
  remote: { enabled: false, token: null, urls: [] },
};

// Kører LCU-ændringer én ad gangen, så vinduet og løkken ikke kolliderer.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

function liveView() {
  const L = app.live;
  if (!L) return null;
  const item = (id) => ({ id, name: itemName(id), icon: dd.items[id]?.icon });
  const player = (p) => ({
    name: p.name,
    champion: { name: p.champ?.name || '?', icon: p.champ?.icon },
    level: p.level, kills: p.kills, deaths: p.deaths, assists: p.assists, cs: p.cs,
    isDead: p.isDead,
    items: p.itemIds.filter((id) => !dd.items[id]?.tags.includes('Trinket')).map(item),
    itemGold: p.itemGold,
    fed: L.enemy.fed.includes(p),
    me: p === L.me,
  });
  const team = (players, side) => ({
    players: players.map(player),
    kills: players.reduce((s, p) => s + p.kills, 0),
    itemGold: players.reduce((s, p) => s + p.itemGold, 0),
    ...L.score[side],
  });
  const enemySide = L.me.team === 'ORDER' ? 'CHAOS' : 'ORDER';
  const names = (list) => list.map((p) => p.champ?.name || p.name);
  return {
    gameTime: L.gameTime,
    gameMode: L.gameMode,
    gold: L.gold,
    me: player(L.me),
    allies: team(L.allies, L.me.team),
    enemies: team(L.enemies, enemySide),
    advice: L.advice.map((a) => ({
      ...item(a.id),
      cost: a.cost,
      canAfford: a.canAfford,
      reasons: a.reasons,
      adapted: a.adapted,
      part: a.part && { ...item(a.part), cost: dd.items[a.part].gold },
    })),
    enemy: {
      adShare: L.enemy.adShare,
      apShare: L.enemy.apShare,
      fed: names(L.enemy.fed),
      armorStackers: names(L.enemy.armorStackers),
      mrStackers: names(L.enemy.mrStackers),
      healers: names(L.enemy.healers),
    },
  };
}

function viewModel() {
  const { pick, build: b, rec } = app;
  const base = {
    status: app.status,
    log: logLines.slice(-12),
    positions: POSITIONS,
    ddVersion: dd.version,
    live: liveView(),
    remote: app.remote.enabled ? { urls: app.remote.urls } : null,
  };
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Telefon-adgang: hemmelig nøgle gemt ved siden af programmet, så QR-koden virker igen næste gang.
function setupRemote(cfg) {
  if (!cfg.remoteAccess) return;
  const file = path.join(APP_DIR, 'remote-token.txt');
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!/^[a-f0-9]{32}$/.test(token || '')) {
    token = randomBytes(16).toString('hex');
    try { fs.writeFileSync(file, token); } catch { log('Kunne ikke gemme telefon-nøglen - den skifter ved næste start.'); }
  }
  app.remote = { enabled: true, token, urls: [] };
}

function remoteUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const label = x === 100 && y >= 64 && y <= 127 ? 'Tailscale' : 'Wifi/netværk';
      urls.push({ label, url: `http://${a.address}:${port}/?token=${app.remote.token}` });
    }
  }
  return urls.sort((a, b) => (a.label === 'Tailscale' ? -1 : 1) - (b.label === 'Tailscale' ? -1 : 1));
}

function startWindowServer(port) {
  const html = readAsset('gui.html');
  const server = http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!LOOPBACK.has(req.socket.remoteAddress)) {
      const { token } = app.remote;
      const query = new URL(req.url, 'http://x').searchParams.get('token');
      if (token && query === token) {
        res.writeHead(302, { 'Set-Cookie': `lrh=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
        return res.end();
      }
      if (!token || !(req.headers.cookie || '').split(/;\s*/).includes(`lrh=${token}`)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Mangler nøgle - scan QR-koden i vinduet på computeren.');
      }
    }
    // POST kun som JSON: en fremmed hjemmeside kan ikke sende det uden CORS-forespørgsel, som vi ikke besvarer.
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return json(415, { error: 'Kun JSON' });
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
      // Uden telefon-adgang kun 127.0.0.1: vinduet kan ikke nås fra andre maskiner.
      server.listen(p, app.remote.enabled ? '0.0.0.0' : '127.0.0.1', () => resolve(server.address().port));
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
  if (process.env.LOL_HELPER_REMOTE) app.cfg.remoteAccess = true;
  log('LoL Rune Helper starter...');
  const ddVersion = await loadStaticData();
  log(`Data Dragon ${ddVersion} hentet. Builds fra OP.GG (${app.cfg.region}, ${app.cfg.buildChoice}).`);
  setupRemote(app.cfg);
  const port = await startWindowServer(app.cfg.port);
  const url = `http://127.0.0.1:${port}`;
  log(`Vindue: ${url}`);
  if (app.remote.enabled) {
    app.remote.urls = remoteUrls(port);
    for (const u of app.remote.urls) log(`Telefon (${u.label}): ${u.url}`);
  }
  if (app.cfg.openWindow) openBrowser(url);
  if (app.cfg.liveAdvice) liveLoop();

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
