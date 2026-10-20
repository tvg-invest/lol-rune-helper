#!/usr/bin/env node
'use strict';
// LoL Rune Helper - sætter runer, summoner spells og et item set automatisk,
// når du låser en champion i champion select. Virker på Windows og macOS.
// Taler kun med League-klientens lokale API (LCU) + OP.GG (builds) + Data Dragon (navne).

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const PREFIX = 'Auto: ';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  region: 'GLOBAL',     // OP.GG-region: GLOBAL, EUW, EUNE, NA, KR ...
  setRunes: true,
  setSpells: true,
  flashKey: 'keep',     // 'keep' = Flash bliver på den tast, du allerede har den på. Ellers 'D' eller 'F'.
  setItemSet: true,
  pollMs: 1500,
};

const POSITION_MAP = { top: 'TOP', jungle: 'JUNGLE', middle: 'MID', bottom: 'ADC', utility: 'SUPPORT' };
const SPELL_NAMES = { 1: 'Cleanse', 3: 'Exhaust', 4: 'Flash', 6: 'Ghost', 7: 'Heal', 11: 'Smite', 12: 'Teleport', 13: 'Clarity', 14: 'Ignite', 21: 'Barrier', 32: 'Mark' };
const SHARD_NAMES = { 5001: 'Health Scaling', 5005: 'Attack Speed', 5007: 'Ability Haste', 5008: 'Adaptive Force', 5010: 'Move Speed', 5011: 'Health', 5013: 'Tenacity & Slow Resist' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toTimeString().slice(0, 5);
const log = (msg) => console.log(`[${time()}] ${msg}`);
const pct = (x) => `${(x * 100).toFixed(1).replace('.', ',')}%`;

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Kunne ikke læse config.json (${e.message}) - bruger standardindstillinger.`);
    return { ...DEFAULT_CONFIG };
  }
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

// ---------- Statiske data (navne) og builds ----------

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lol-rune-helper' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const names = { champions: {}, items: {}, runes: {} };

async function loadStaticData() {
  const [version] = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const base = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US`;
  const [champs, items, styles] = await Promise.all([
    getJson(`${base}/champion.json`), getJson(`${base}/item.json`), getJson(`${base}/runesReforged.json`),
  ]);
  for (const c of Object.values(champs.data)) names.champions[c.key] = c.name;
  for (const [id, it] of Object.entries(items.data)) names.items[id] = it.name;
  for (const style of styles) {
    names.runes[style.id] = style.name;
    for (const slot of style.slots) for (const r of slot.runes) names.runes[r.id] = r.name;
  }
  Object.assign(names.runes, SHARD_NAMES);
  return version;
}

const buildCache = new Map();

async function fetchBuild(region, mode, championId, position) {
  const key = `${mode}:${championId}:${position}`;
  if (!buildCache.has(key)) {
    const url = `https://lol-api-champion.op.gg/api/${region}/champions/${mode}/${championId}/${position}`;
    buildCache.set(key, getJson(url).then((j) => ({ ...j.data, version: j.meta?.version })).catch((e) => {
      buildCache.delete(key);
      throw e;
    }));
  }
  return buildCache.get(key);
}

// Finder build for championen. Uden tildelt rolle (blind pick) bruges championens hovedrolle.
async function getBuild(cfg, championId, assignedPosition, gameMode) {
  if (gameMode === 'ARAM') return { build: await fetchBuild(cfg.region, 'aram', championId, 'none'), position: 'ARAM' };
  let position = POSITION_MAP[assignedPosition];
  if (position) return { build: await fetchBuild(cfg.region, 'ranked', championId, position), position };
  const probe = await fetchBuild(cfg.region, 'ranked', championId, 'MID');
  position = probe.summary?.positions?.[0]?.name || 'MID';
  return { build: position === 'MID' ? probe : await fetchBuild(cfg.region, 'ranked', championId, position), position };
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

function itemBlock(type, ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return { type, hideIfSummonerSpell: '', showIfSummonerSpell: '', items: [...counts].map(([id, count]) => ({ id: String(id), count })) };
}

function buildItemBlocks(build) {
  const blocks = [];
  const used = new Set();
  const skills = build.skill_masteries?.[0];
  const start = build.starter_items?.[0];
  if (start) blocks.push(itemBlock(`Start${skills ? ` - max ${skills.ids.join(' > ')}` : ''}`, start.ids));
  const core = build.core_items?.[0];
  if (core) {
    blocks.push(itemBlock(`Core build (${pct(core.win / core.play)} WR)`, core.ids));
    core.ids.forEach((id) => used.add(id));
  }
  const boots = (build.boots || []).slice(0, 2).map((b) => b.ids[0]);
  if (boots.length) {
    blocks.push(itemBlock('Støvler', boots));
    boots.forEach((id) => used.add(id));
  }
  const alt = [];
  for (const c of (build.core_items || []).slice(1, 4)) for (const id of c.ids) if (!used.has(id) && !alt.includes(id)) alt.push(id);
  if (alt.length) blocks.push(itemBlock('Alternative core', alt));
  alt.forEach((id) => used.add(id));
  const late = (build.last_items || []).map((x) => x.ids[0]).filter((id) => !used.has(id)).slice(0, 8);
  if (late.length) blocks.push(itemBlock('Situationelle items', late));
  blocks.push(itemBlock('Forbrug', [2003, 2055]));
  return blocks;
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

// ---------- Champion select ----------

async function handlePick(client, cfg, session, me) {
  const flow = await lcu(client, 'GET', '/lol-gameflow/v1/session').catch(() => null);
  const gameMode = flow?.gameData?.queue?.gameMode || flow?.map?.gameMode || 'CLASSIC';
  const champName = names.champions[me.championId] || `Champion ${me.championId}`;
  if (gameMode === 'CHERRY') return log(`${champName}: Arena har ingen runer - springer over.`);

  const { build, position } = await getBuild(cfg, me.championId, me.assignedPosition, gameMode);
  const stats = build.summary?.average_stats;
  const title = `${champName} ${position}`;
  log(`${champName} (${position}) - patch ${build.version || '?'}` +
    (stats ? `, ${stats.play.toLocaleString('da-DK')} kampe, ${pct(stats.win_rate)} WR` : ''));

  const rune = build.rune_pages?.[0]?.builds?.[0] || build.runes?.[0];
  if (cfg.setRunes && rune) {
    await applyRunes(client, rune, title);
    const n = (ids) => ids.map((id) => names.runes[id] || id).join(', ');
    log(`  Runer: ${names.runes[rune.primary_page_id]}: ${n(rune.primary_rune_ids)} | ${names.runes[rune.secondary_page_id]}: ${n(rune.secondary_rune_ids)} | ${n(rune.stat_mod_ids)}`);
  }

  const spells = build.summoner_spells?.[0];
  if (cfg.setSpells && spells) {
    const [a, b] = await applySpells(client, cfg, me, spells.ids);
    log(`  Summoners: ${SPELL_NAMES[a] || a} (D) + ${SPELL_NAMES[b] || b} (F)`);
  }

  const blocks = buildItemBlocks(build);
  if (cfg.setItemSet) await applyItemSet(client, me.championId, title, blocks);
  for (const block of blocks) {
    const items = block.items.map((i) => (i.count > 1 ? `${i.count}x ` : '') + (names.items[i.id] || i.id)).join(', ');
    log(`  ${block.type}: ${items}`);
  }
  if (cfg.setItemSet) log(`  Item set "${PREFIX}${title}" ligger i butikken i spillet.`);
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Kræver Node 18 eller nyere (du har ${process.versions.node}). Hent den på https://nodejs.org`);
    process.exit(1);
  }
  const cfg = loadConfig();
  log('LoL Rune Helper starter...');
  const ddVersion = await loadStaticData();
  log(`Data Dragon ${ddVersion} hentet. Builds fra OP.GG (${cfg.region}).`);

  let client = null;
  let lastKey = null;
  let lastStatus = '';
  const status = (msg) => { if (msg !== lastStatus) { lastStatus = msg; log(msg); } };

  for (;;) {
    try {
      if (!client) {
        client = await findClient();
        if (!client) { status('Venter på League-klienten...'); await sleep(3000); continue; }
      }
      const phase = await lcu(client, 'GET', '/lol-gameflow/v1/gameflow-phase');
      if (phase !== 'ChampSelect') {
        status(phase === 'InProgress' ? 'I kamp - held og lykke!' : 'Forbundet til klienten - venter på champion select.');
        lastKey = null;
      } else {
        status('Champion select - venter på at du låser en champion.');
        const session = await lcu(client, 'GET', '/lol-champ-select/v1/session');
        const me = session.myTeam?.find((m) => m.cellId === session.localPlayerCellId);
        const pickPending = (session.actions || []).flat()
          .some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && !a.completed);
        const key = me && `${me.championId}:${me.assignedPosition}`;
        if (me?.championId > 0 && !pickPending && key !== lastKey) {
          lastKey = key;
          await handlePick(client, cfg, session, me);
        }
      }
    } catch (e) {
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e.code)) {
        client = null;
        status('Mistede forbindelsen til klienten - leder igen...');
      } else {
        log(`Fejl: ${e.message}`);
      }
    }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
