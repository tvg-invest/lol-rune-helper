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
const { execFile, spawn } = require('child_process');
const { randomUUID, randomBytes } = require('crypto');

let sea = null;
try { sea = require('node:sea'); } catch {}
const IS_SEA = Boolean(sea?.isSea?.());
// Som færdig programfil ligger config.json ved siden af programmet.
const APP_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname;

const PREFIX = 'Auto: ';
const CONFIG_PATH = process.env.LOL_HELPER_CONFIG || path.join(APP_DIR, 'config.json');
const DEFAULT_CONFIG = {
  region: 'GLOBAL',       // OP.GG-region: GLOBAL, EUW, EUNE, NA, KR ...
  buildChoice: 'smart',   // 'smart' = højeste win rate blandt populære builds, 'popular' = mest spillede
  setRunes: true,
  setSpells: true,
  flashKey: 'keep',       // 'keep' = Flash bliver på den tast, du allerede har den på. Ellers 'D' eller 'F'.
  setItemSet: true,
  adaptToEnemies: true,   // tilpas items/støvler til modstanderholdet
  liveAdvice: true,       // købsforslag + scoreboard under kampen
  voice: true,            // sig "Råd til ...", "Level op: Q", "X er fed" højt (virker også i ægte fuldskærm)
  voiceEnemy: true,       // sig også når din lane-modstander køber et item eller når level 6 (ren fakta fra TAB)
  openWindow: true,       // åbn vinduet i browseren ved start
  remoteAccess: false,    // true = vinduet kan åbnes fra telefonen (Tailscale/wifi) med en hemmelig nøgle
  autoUpdate: true,       // tjek for nye versioner (opdatering sker først når du klikker)
  port: 3399,
  pollMs: 1500,
};

const POSITION_MAP = { top: 'TOP', jungle: 'JUNGLE', middle: 'MID', bottom: 'ADC', utility: 'SUPPORT' };
const POSITIONS = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
const SHARD_NAMES = { 5001: 'Health Scaling', 5005: 'Attack Speed', 5007: 'Ability Haste', 5008: 'Adaptive Force', 5010: 'Move Speed', 5011: 'Health', 5013: 'Tenacity & Slow Resist' };
// Champions med meget healing/sustain (Data Dragon-id). Bruges til at anbefale anti-heal.
const HEALERS = new Set(['Aatrox', 'Briar', 'DrMundo', 'Fiddlesticks', 'Fiora', 'Gwen', 'Illaoi', 'Irelia', 'Maokai', 'Milio', 'Nami', 'Olaf', 'Samira', 'Senna', 'Seraphine', 'Sona', 'Soraka', 'Swain', 'Sylas', 'Trundle', 'Vladimir', 'Volibear', 'Warwick', 'Yuumi', 'Zac', 'Viego', 'Belveth', 'Kayn', 'Nasus', 'Darius', 'Udyr', 'Renekton', 'Tryndamere']);
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

// Gem én indstilling i config.json (resten af filen bevares).
function saveConfigValue(key, value) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  current[key] = value;
  try { fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(current, null, 2)}\n`); } catch (e) { log(`Kunne ikke gemme indstillingen: ${e.message}`); }
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
    // Lockfilen findes kun mens klienten kører og er gratis at læse - prøv den før PowerShell.
    const fromLockfile = readLockfile(lockfileCandidates(''));
    if (fromLockfile) return fromLockfile;
    // PowerShell tager ~0,5 sek. CPU at starte: højst hvert 15. sekund når klienten ikke er fundet.
    if (Date.now() - (findClient.lastPs || 0) < 15000) return null;
    findClient.lastPs = Date.now();
    cmdline = await run('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]);
  } else {
    cmdline = (await run('ps', ['-A', '-ww', '-o', 'args'])).split('\n').filter((l) => l.includes('LeagueClientUx')).join('\n');
  }
  if (!cmdline.trim()) return null;

  const port = /--app-port=(\d+)/.exec(cmdline);
  const token = /--remoting-auth-token=([\w-]+)/.exec(cmdline);
  if (port && token) return { protocol: 'https', port: Number(port[1]), password: token[1] };

  return readLockfile(lockfileCandidates(cmdline));
}

// Lockfile-format: LeagueClient:<pid>:<port>:<password>:<protocol>
function readLockfile(files) {
  for (const file of files) {
    try {
      const [, , p, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
      if (Number(p) > 0 && password) return { protocol, port: Number(p), password };
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
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${text.slice(0, 300)}`), { status: res.statusCode }));
        }
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
  const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const [version] = versions;
  dd.versions = versions.slice(0, 10);
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
      sell: it.gold?.sell || 0,
      // Navngivne passiver ("Spellblade", "Lifeline", "Cleave" ...): to items med samme navn virker ikke sammen.
      passives: [...new Set([...(it.description || '').matchAll(/<passive>([^<]+)<\/passive>/g)].map((m) => m[1].trim()))],
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

// Builds caches i hukommelsen og på disken i 6 timer: champion select bliver øjeblikkelig,
// og programmet kan køre i dagevis uden at hænge fast på en gammel patch.
const buildCache = new Map();
const CACHE_TTL = 6 * 3600 * 1000;
const CACHE_DIR = process.env.LOL_HELPER_CACHE || path.join(APP_DIR, 'cache');

// Højst 4 OP.GG-kald ad gangen (draft kan ellers sende 20+ på én gang).
let activeRequests = 0;
const requestQueue = [];
async function limited(fn) {
  if (activeRequests >= 4) await new Promise((resolve) => requestQueue.push(resolve));
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    requestQueue.shift()?.();
  }
}

// Ryd udløbne builds i hukommelsen og gamle filer i cache-mappen (kører hver time).
function pruneCache() {
  for (const [key, hit] of buildCache) if (Date.now() - hit.at > CACHE_TTL) buildCache.delete(key);
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const file = path.join(CACHE_DIR, f);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.rmSync(file, { force: true });
    }
  } catch {}
}

// Fælles cache for OP.GG-data: hukommelse + fil i cache-mappen, 6 timer.
function cachedJson(key, loader) {
  const hit = buildCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
  const file = path.join(CACHE_DIR, `${key}.json`);
  const promise = (async () => {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    const data = await limited(loader);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {}
    return data;
  })().catch((e) => {
    buildCache.delete(key);
    throw e;
  });
  buildCache.set(key, { promise, at: Date.now() });
  return promise;
}

// I starten af en ny patch har OP.GG næsten ingen kampe (fx 280 i stedet for 80.000).
// Så bruges den forrige patch, indtil den nye har nok data.
const THIN_PATCH_GAMES = 20000;

// Forrige patch ud fra Data Dragons versionsliste: "16.21" -> "16.20".
function previousPatch(version) {
  const majorMinor = (v) => String(v || '').split('.').slice(0, 2).join('.');
  const current = majorMinor(version);
  const prev = (dd.versions || []).map(majorMinor).find((v) => v && v !== current && /^\d+\.\d+$/.test(v));
  return current && prev ? prev : null;
}

function fetchBuild(region, mode, championId, position, target) {
  const key = `${region}_${mode}_${championId}_${position}${target ? `_vs${target}` : ''}`;
  return cachedJson(key, async () => {
    const url = `https://lol-api-champion.op.gg/api/${region}/champions/${mode}/${championId}/${position}` +
      (target ? `?target_champion=${target}` : '');
    const j = await getJson(url);
    const data = { ...j.data, version: j.meta?.version };
    const games = data.summary?.average_stats?.play || 0;
    const prev = games < THIN_PATCH_GAMES ? previousPatch(j.meta?.version) : null;
    if (prev) {
      try {
        const p = await getJson(`${url}${url.includes('?') ? '&' : '?'}version=${prev}`);
        const prevGames = p.data?.summary?.average_stats?.play || 0;
        if (prevGames >= games * 3) return { ...p.data, version: p.meta?.version || prev, newestVersion: j.meta?.version, thinPatch: true };
      } catch {} // forrige patch utilgængelig: brug de tynde data
    }
    return data;
  });
}

// OP.GG's matchup-guide (via deres offentlige MCP-tjeneste): tip-tekst + lane-/solo-kill-fordel + spillestil.
// Udokumenteret - fejler den, laves gameplanen bare uden.
const MCP_URL = process.env.LOL_HELPER_MCP || 'https://mcp-api.op.gg/mcp';
const GUIDE_POSITION = { TOP: 'top', JUNGLE: 'jungle', MID: 'mid', ADC: 'adc', SUPPORT: 'support' };
// "Kha'Zix" -> KHAZIX, "Dr. Mundo" -> DR_MUNDO, "Nunu & Willump" -> NUNU_WILLUMP
const mcpName = (name) => name.toUpperCase().replace(/['’.]/g, '').replace(/&/g, ' ').trim().replace(/\s+/g, '_');

function fetchMatchupGuide(myKey, oppKey, position) {
  const me = dd.champions[myKey];
  const opp = dd.champions[oppKey];
  const pos = GUIDE_POSITION[position];
  if (!me || !opp || !pos) return Promise.resolve(null);
  return cachedJson(`guide_${myKey}_vs${oppKey}_${pos}`, async () => {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'lol-rune-helper' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'lol_get_lane_matchup_guide', arguments: { position: pos, my_champion: mcpName(me.name), opponent_champion: mcpName(opp.name) } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    if (j.error || j.result?.isError) throw new Error(`Matchup-guide: ${JSON.stringify(j.error || j.result.content?.[0]?.text).slice(0, 200)}`);
    const d = JSON.parse(j.result.content[0].text).data || {};
    return {
      tip: d.opponent_champion_tip || '',
      laneAdvantage: d.lane_advantage_champion || null,
      soloKill: d.lane_solo_kill_advantage_champion || null,
      playStyle: d.recommended_play_style || null,
    };
  });
}

// Lane-modstanderen: den modstander der oftest spiller din rolle (OP.GG's rollefordeling).
async function laneOpponent(cfg, position, enemyIds) {
  if (!POSITIONS.includes(position) || !enemyIds.length) return null;
  const rates = await Promise.all(enemyIds.map(async (id) => {
    try {
      const probe = await fetchBuild(cfg.region, 'ranked', id, 'MID');
      return { id, rate: probe.summary?.positions?.find((p) => p.name === position)?.stats?.role_rate || 0 };
    } catch {
      return { id, rate: 0 };
    }
  }));
  const best = rates.sort((a, b) => b.rate - a.rate)[0];
  return best && best.rate >= 0.25 ? best.id : null;
}

// ---------- Gameplan mod din lane-modstander ----------
// Fast del: OP.GG's matchup-guide + tal. Live del: fakta om jer to (level, items, core) + valg fra dit build.
// Bevidst ingen "engage nu"-råd: Riot tillader ikke apps der træffer beslutninger for spilleren.

const PLAY_STYLE = { defensive: 'Defensiv', aggressive: 'Aggressiv', even: 'Jævn' };
const genitive = (name) => (/[sxz]$/i.test(name) ? `${name}'` : `${name}s`);
const coreOf = (build) => (build?.core_items?.[0]?.ids || []).map(String);

// Hvem skalerer bedst: hvor meget win rate ændrer sig fra korte (<25 min) til lange (40+ min) kampe.
function scalingNote(myBuild, oppBuild, oppName) {
  const curve = (b) => {
    const g = b?.game_lengths || [];
    return g.length >= 2 ? g[g.length - 1].rate - g[0].rate : null;
  };
  const mine = curve(myBuild);
  const his = curve(oppBuild);
  if (mine == null || his == null) return null;
  if (mine - his > 0.02) return `Du skalerer bedre end ${oppName} (din win rate stiger mere jo længere kampen varer).`;
  if (his - mine > 0.02) return `${oppName} skalerer bedre end dig - din bedste chance i kampen er før 25 min.`;
  return `I skalerer nogenlunde ens.`;
}

async function buildPlan(myKey, oppKey, position, myBuild) {
  const oppName = dd.champions[oppKey]?.name || '?';
  const myName = dd.champions[myKey]?.name || '';
  const [guide, oppBuild] = await Promise.all([
    fetchMatchupGuide(myKey, oppKey, position).catch((e) => { log(`  ${e.message}`); return null; }),
    POSITIONS.includes(position) ? fetchBuild(app.cfg.region, 'ranked', oppKey, position).catch(() => null) : null,
  ]);
  const who = (x) => {
    if (!x) return null;
    if (x === 'EVEN') return 'jævn';
    if (x.toLowerCase() === oppName.toLowerCase()) return oppName;
    if (x.toLowerCase() === myName.toLowerCase()) return 'dig';
    return x;
  };
  return {
    key: `${myKey}_${oppKey}_${position}`,
    myKey: String(myKey),
    oppKey: String(oppKey),
    opponent: oppName,
    position,
    stats: matchupStats(myBuild, oppKey),
    laneAdvantage: who(guide?.laneAdvantage),
    soloKill: who(guide?.soloKill),
    playStyle: guide?.playStyle ? PLAY_STYLE[guide.playStyle] || guide.playStyle : null,
    tip: guide?.tip || null,
    scaling: scalingNote(myBuild, oppBuild, oppName),
    myCore: coreOf(myBuild),
    oppCore: coreOf(oppBuild),
    // Items du faktisk bygger: core + sene items som mindst 2% køber (ikke fx Randuin's på en mage).
    myPool: [
      ...(myBuild?.core_items || []).flatMap((x) => x.ids.map(String)),
      ...(myBuild?.last_items || []).filter((x) => (x.pick_rate || 0) >= 0.02).map((x) => String(x.ids[0])),
    ],
    seen: null, // modstanderens items/level ved sidste tjek
    log: [],    // ændringer under kampen
  };
}

// Laves én gang pr. matchup (champion select eller live) og bruges videre ind i kampen.
function ensurePlan(myKey, oppKey, position, myBuild) {
  if (!myKey || !oppKey || !myBuild) return;
  const key = `${myKey}_${oppKey}_${position}`;
  if (app.planKey === key) return;
  app.planKey = key;
  buildPlan(myKey, oppKey, position, myBuild)
    .then((plan) => {
      if (app.planKey !== key) return;
      app.plan = plan;
      log(`Gameplan klar: ${dd.champions[myKey]?.name} mod ${plan.opponent}.`);
      broadcast();
    })
    .catch((e) => log(`Gameplan fejlede: ${e.message}`));
}

// Modstanderens nye færdige items og level 6 -> ændringslog (+ stemme hvis slået til).
function trackOpponent(L) {
  const plan = app.plan;
  const opp = L.matchup?.player;
  if (!plan || !opp || String(opp.champ?.key) !== plan.oppKey) return;
  const completed = opp.itemIds.filter((id) => isCompleted(dd.items[id]));
  const add = (kind, text) => {
    plan.log.unshift({ t: L.gameTime, text });
    plan.log.length = Math.min(plan.log.length, 12);
    if (app.cfg.voiceEnemy) speak(kind, text);
  };
  if (plan.seen) {
    const before = [...plan.seen.items];
    for (const id of completed) {
      const i = before.indexOf(id);
      if (i !== -1) before.splice(i, 1);
      else add('opp-item', `${plan.opponent} har købt ${itemName(id)}`);
    }
    // Bevidst ingen besked når han når level 6: Riot/Overwolf forbyder notifikationer om modstanderens power spikes.
  }
  plan.seen = { items: completed, level: opp.level };
}

// "Lige nu": kun fakta om jer to + hvilke items i DIT build der svarer på hans.
function planNow(plan, L) {
  const opp = L?.matchup?.player;
  if (!opp || String(opp.champ?.key) !== plan.oppKey) return null;
  const me = L.me;
  const n = plan.opponent;
  const num = (x) => Math.round(x).toLocaleString('da-DK');
  const lines = [];
  // Kun levels (står på TAB) - ingen "han har ult"-fortolkning (modstanderens power spikes må ikke fremhæves).
  lines.push(`Level: dig ${me.level}, ${n} ${opp.level}`);
  const diff = me.itemGold - opp.itemGold;
  lines.push(`Items: dig ${num(me.itemGold)} g, ${n} ${num(opp.itemGold)} g (${diff >= 0 ? '+' : ''}${num(diff)} til dig)`);
  lines.push(`KDA: dig ${me.kills}/${me.deaths}/${me.assists}, ${n} ${opp.kills}/${opp.deaths}/${opp.assists}`);
  const progress = (core, items) => core.filter((id) => items.includes(id));
  const mine = progress(plan.myCore, me.itemIds);
  const his = progress(plan.oppCore, opp.itemIds);
  if (plan.myCore.length) lines.push(`Dit core build: ${mine.length}/${plan.myCore.length}${mine.length ? ` (${mine.map(itemName).join(', ')})` : ''}`);
  if (plan.oppCore.length) lines.push(`${genitive(n)} typiske core: ${his.length}/${plan.oppCore.length}${his.length ? ` (${his.map(itemName).join(', ')})` : ''}`);
  // Items i dit eget build (ikke ejet) med et bestemt tag - som valg, ikke ordre.
  const options = (pred) => [...new Set(plan.myPool)]
    .filter((id) => !me.itemIds.includes(id) && isCompleted(dd.items[id]) && pred(dd.items[id]))
    .slice(0, 2).map(itemName);
  const withOptions = (text, opts, label) => text + (opts.length ? `. ${label}: ${opts.join(', ')}` : '');
  const iAmAD = me.dmg.ad >= 0.5;
  if (iAmAD && opp.armor >= 40) lines.push(withOptions(`${n} har ${opp.armor} armor fra items`, options((it) => it.tags.includes('ArmorPenetration')), 'Armor pen i dit build'));
  if (!iAmAD && opp.mr >= 40) lines.push(withOptions(`${n} har ${opp.mr} magic resist fra items`, options((it) => it.tags.includes('MagicPenetration')), 'Magic pen i dit build'));
  const antiheal = opp.itemIds.find((id) => dd.items[id]?.antiheal);
  if (antiheal && (HEALERS.has(me.champ?.id) || me.healing)) lines.push(`${n} har anti-heal (${itemName(antiheal)}) - din healing er reduceret`);
  if (opp.itemGold >= 2500 && opp.dmg.ad >= 0.7) lines.push(withOptions(`${genitive(n)} items er mest AD`, options((it) => it.tags.includes('Armor')), 'Armor i dit build'));
  if (opp.itemGold >= 2500 && opp.dmg.ap >= 0.7) lines.push(withOptions(`${genitive(n)} items er mest AP`, options((it) => it.tags.includes('SpellBlock')), 'Magic resist i dit build'));
  return lines;
}

// Din win rate mod en bestemt champion (OP.GG's counters-liste for din champion og rolle).
function matchupStats(build, opponentId) {
  const c = build?.counters?.find((x) => x.champion_id === Number(opponentId));
  return c && c.play ? { games: c.play, winRate: c.win / c.play } : null;
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

// Matchup-data bruges kun når der er nok kampe bag (ellers er tallene støj).
const MATCHUP_MIN_GAMES = 150;

function recommend(build, cfg, enemyIds, matchup) {
  const enemy = cfg.adaptToEnemies && enemyIds.length ? analyzeEnemies(enemyIds) : null;
  const blocks = [];
  const notes = [];
  const used = new Set();
  const addUsed = (ids) => ids.forEach((id) => used.add(id));

  const skillOrder = build.skills?.[0]?.order || [];
  const skills = { start: skillOrder.slice(0, 3), max: build.skill_masteries?.[0]?.ids || [] };

  const vsName = matchup && (dd.champions[matchup.id]?.name || 'modstanderen');
  if (matchup?.stats) notes.push(`Mod ${vsName}: ${pct(matchup.stats.winRate)} WR i ${matchup.stats.games.toLocaleString('da-DK')} kampe`);
  const mStart = matchup?.build?.starter_items?.[0];
  const useMStart = mStart && mStart.play >= MATCHUP_MIN_GAMES;
  const start = useMStart ? mStart : rankOptions(build.starter_items, { buildChoice: 'popular' })[0];
  if (useMStart) notes.push(`Start-items valgt til matchuppet mod ${vsName}`);
  if (start) blocks.push(itemBlock(`Start${useMStart ? ` mod ${vsName}` : ''}${skills.max.length ? ` - max ${skills.max.join(' > ')}` : ''}`, start.ids));

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

  const pagesOf = (b) => {
    const pages = (b?.rune_pages || []).flatMap((p) => p.builds || []);
    return pages.length ? pages : b?.runes || [];
  };
  let runeOptions = rankOptions(pagesOf(build), cfg).slice(0, 3);
  // Bedste rune-side i matchuppet først (fx "Mod Zed"), hvis der er nok kampe.
  const mRune = rankOptions(pagesOf(matchup?.build), cfg).find((r) => r.play >= MATCHUP_MIN_GAMES);
  if (mRune) {
    runeOptions = [{ ...mRune, matchup: vsName }, ...runeOptions.filter((r) => perkKey(r) !== perkKey(mRune))].slice(0, 3);
  }
  const spells = rankOptions(build.summoner_spells, { buildChoice: 'popular' })[0]?.ids || null;

  return { blocks, notes, skills, runeOptions, spells, enemy, matchup: matchup && { id: matchup.id, name: vsName, stats: matchup.stats, manual: matchup.manual } };
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
    // Har vi lige slettet vores egen side, er der en ledig plads - så skyldes fejlen noget andet
    // (fx runer der ikke passer til en ny patch). Rør aldrig dine egne sider i det tilfælde.
    if (ours) throw e;
    // Er siderne faktisk fulde? (Kan klienten ikke svare, antager vi det, som før.)
    const inventory = await lcu(client, 'GET', '/lol-perks/v1/inventory').catch(() => null);
    if (typeof inventory?.ownedPageCount === 'number' && editable.length < inventory.ownedPageCount) throw e;
    // Erstat helst en side du ikke bruger lige nu.
    const victim = editable.filter((p) => !p.current).pop() || editable.find((p) => p.current);
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

// ---------- Draft: bans og counterpicks (før du låser) ----------
// Kun aggregerede OP.GG-tal + din egen champion-pulje - data fra før kampen, som Riot tillader.

const DRAFT_MIN_GAMES = 200;

// Dine champions til rollen: højeste mastery + champions fra din historik, filtreret på rollen.
async function myChampionPool(cfg, position) {
  const ids = [];
  try {
    const mastery = await lcu(app.client, 'GET', '/lol-champion-mastery/v1/local-player/champion-mastery');
    for (const m of (Array.isArray(mastery) ? mastery : []).sort((a, b) => b.championPoints - a.championPoints).slice(0, 15)) ids.push(m.championId);
  } catch {}
  // + dine 8 mest spillede fra historikken (ikke alle - det ville give et udbrud af OP.GG-kald).
  const played = new Map();
  for (const g of history.games) if (g.championId) played.set(g.championId, (played.get(g.championId) || 0) + 1);
  for (const [id] of [...played].sort((a, b) => b[1] - a[1]).slice(0, 8)) if (!ids.includes(id)) ids.push(id);
  const withRole = await Promise.all(ids.map(async (id) => {
    try {
      const probe = await fetchBuild(cfg.region, 'ranked', id, 'MID');
      return { id, rate: probe.summary?.positions?.find((p) => p.name === position)?.stats?.role_rate || 0 };
    } catch {
      return { id, rate: 0 };
    }
  }));
  return withRole.filter((x) => x.rate >= 0.2).map((x) => x.id).slice(0, 6);
}

async function analyzeDraft(cfg, position, enemyIds, unavailable) {
  const pool = await myChampionPool(cfg, position);
  const builds = (await Promise.all(pool.map((id) => fetchBuild(cfg.region, 'ranked', id, position).then((b) => ({ id, b }), () => null)))).filter(Boolean);
  const name = (id) => dd.champions[id]?.name || String(id);

  // Bans: de champions dine champions klarer sig dårligst imod (vægtet efter hvor mange af dem de rammer).
  const threat = new Map();
  for (const { id, b } of builds) {
    for (const c of b.counters || []) {
      if (c.play < DRAFT_MIN_GAMES || unavailable.includes(c.champion_id)) continue;
      const t = threat.get(c.champion_id) || { loss: 0, hits: [] };
      t.loss += 0.5 - c.win / c.play;
      t.hits.push({ id, wr: c.win / c.play });
      threat.set(c.champion_id, t);
    }
  }
  const bans = [...threat]
    .map(([id, t]) => ({ id, score: t.loss / Math.max(builds.length, 1), wr: t.hits.reduce((s, h) => s + h.wr, 0) / t.hits.length, hits: t.hits }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => ({ id: x.id, reason: `Dine ${x.hits.length > 1 ? `${x.hits.length} champions` : name(x.hits[0].id)} vinder ${pct(x.wr)} mod ${name(x.id)}` }));

  // Counterpicks når lane-modstanderen er kendt: din pulje sorteret efter win rate mod den + generelle counters.
  const opponent = await laneOpponent(cfg, position, enemyIds);
  let poolVs = [];
  let counters = [];
  if (opponent) {
    poolVs = builds.map(({ id, b }) => ({ id, stats: matchupStats(b, opponent) }))
      .filter((x) => x.stats && x.stats.games >= 100)
      .sort((a, b) => b.stats.winRate - a.stats.winRate)
      .map((x) => ({ id: x.id, winRate: x.stats.winRate, games: x.stats.games }));
    try {
      const opp = await fetchBuild(cfg.region, 'ranked', opponent, position);
      counters = (opp.counters || [])
        // Højere krav end for din pulje: ellers dukker sjældne off-role picks op på få kampe.
        .filter((c) => c.play >= 500 && !unavailable.includes(c.champion_id))
        .map((c) => ({ id: c.champion_id, winRate: 1 - c.win / c.play, games: c.play }))
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 3);
    } catch {}
  }
  return { position, pool, bans, opponent, poolVs, counters };
}

// Kører i baggrunden, så champion select-løkken ikke venter på OP.GG.
function updateDraft(session, me) {
  const position = app.roleOverride || POSITION_MAP[me.assignedPosition];
  if (!POSITIONS.includes(position)) { app.draft = null; return; }
  const actions = (session.actions || []).flat();
  const unavailable = [
    ...actions.filter((a) => a.type === 'ban' && a.completed && a.championId).map((a) => a.championId),
    ...[...(session.myTeam || []), ...(session.theirTeam || [])].map((m) => m.championId).filter((id) => id > 0),
  ];
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0);
  const myBanTurn = actions.some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'ban' && a.isInProgress);
  const key = `${position}|${enemyIds.sort().join(',')}|${unavailable.sort().join(',')}`;
  if (app.draft) app.draft.myBanTurn = myBanTurn;
  if (key === app.draftKey) return;
  app.draftKey = key;
  analyzeDraft(app.cfg, position, enemyIds, unavailable)
    .then((d) => {
      if (app.draftKey !== key) return;
      app.draft = { ...d, myBanTurn };
      broadcast();
    })
    .catch((e) => log(`Draft-hjælp fejlede: ${e.message}`));
}

// ---------- Kampoversigt og historik ----------

const HISTORY_FILE = process.env.LOL_HELPER_HISTORY || path.join(APP_DIR, 'history.json');
const history = (() => {
  try {
    const games = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).games;
    // Spring ødelagte/håndredigerede poster over i stedet for at fejle senere.
    return { games: Array.isArray(games) ? games.filter((g) => g && typeof g === 'object' && g.champion) : [] };
  } catch {
    return { games: [] };
  }
})();

// Følger dine køb under kampen: hvilke færdige items, hvornår, og om de var blandt forslagene.
function trackGame(data, L) {
  const t = L.gameTime;
  if (!app.game || app.game.championKey !== L.me.champ?.key) {
    app.game = { championKey: L.me.champ?.key, seen: new Map(), adapted: new Set(), buys: [], lastItems: [...L.me.itemIds], result: null };
  }
  const g = app.game;
  for (const a of L.advice) {
    if (!g.seen.has(a.id)) g.seen.set(a.id, t);
    if (a.adapted) g.adapted.add(a.id);
  }
  const before = [...g.lastItems];
  for (const id of L.me.itemIds) {
    const i = before.indexOf(id);
    if (i !== -1) { before.splice(i, 1); continue; }
    if (isCompleted(dd.items[id])) g.buys.push({ id, t, suggested: g.seen.has(id), adapted: g.adapted.has(id) });
  }
  g.lastItems = [...L.me.itemIds];
  // GameEnd-eventet har (efter Riots eksempler) et Result-felt; findes det ikke, er resultatet ukendt.
  const end = (data.events?.Events || []).find((e) => e.EventName === 'GameEnd');
  if (end?.Result) g.result = /win/i.test(end.Result) ? 'Sejr' : 'Nederlag';
  g.last = L;
}

// Glem sidste champion select, så vinduet viser oversigten/historikken.
function clearPick() {
  app.pick = null;
  app.build = null;
  app.rec = null;
  app.plan = null;
  app.planKey = null;
}

function finishGame() {
  const g = app.game;
  app.game = null;
  clearPick();
  if (!g?.last || g.last.gameTime < 300) return; // remakes og afbrudte kampe tæller ikke
  const L = g.last;
  const minutes = L.gameTime / 60;
  const summary = {
    date: new Date().toISOString(),
    championId: Number(L.me.champ?.key) || null,
    champion: L.me.champ?.name || '?',
    position: LIVE_POSITION[L.me.position] || L.me.position || '',
    result: g.result,
    duration: Math.round(L.gameTime),
    kills: L.me.kills, deaths: L.me.deaths, assists: L.me.assists,
    cs: L.me.cs,
    csPerMin: Math.round((L.me.cs / minutes) * 10) / 10,
    items: L.me.itemIds.filter((id) => isCompleted(dd.items[id])),
    buys: g.buys,
    followed: g.buys.length ? g.buys.filter((b) => b.suggested).length / g.buys.length : null,
    adaptedBought: g.buys.filter((b) => b.adapted).map((b) => itemName(b.id)),
    goldDiff: L.allies.reduce((s, p) => s + p.itemGold, 0) - L.enemies.reduce((s, p) => s + p.itemGold, 0),
    matchup: L.matchup ? { champion: L.matchup.player.champ?.name, winRate: L.matchup.stats?.winRate ?? null } : null,
  };
  history.games.unshift(summary);
  history.games.length = Math.min(history.games.length, 100);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1)); } catch (e) { log(`Kunne ikke gemme historik: ${e.message}`); }
  log(`Kampoversigt: ${summary.champion} ${summary.kills}/${summary.deaths}/${summary.assists}, ${String(summary.csPerMin).replace('.', ',')} CS/min` +
    (summary.followed != null ? `, ${pct(summary.followed)} af dine køb var blandt forslagene` : ''));
}

// ---------- Opdateringer ----------

const VERSION = '1.9.0';
const UPDATE_URL = process.env.LOL_HELPER_UPDATE_URL || 'https://api.github.com/repos/tvg-invest/lol-rune-helper/releases/latest';
const UPDATE_ASSET = { win32: 'LoL-Rune-Helper.exe', darwin: 'LoL-Rune-Helper-mac' }[process.platform];

const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkUpdate() {
  try {
    const rel = await getJson(UPDATE_URL);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => a.name === UPDATE_ASSET);
    if (latest && newer(latest, VERSION) && asset) {
      if (app.update?.version !== latest) log(`Ny version ${latest} er klar - klik "Opdater" i vinduet.`);
      app.update = { version: latest, url: asset.browser_download_url, notes: String(rel.body || '').slice(0, 600) };
      broadcast();
    }
  } catch {} // ingen udgivelse eller intet net: prøv igen senere
}

async function applyUpdate() {
  if (!IS_SEA) throw new Error('Kører fra kildekode - hent ny kode i stedet');
  if (!app.update?.url) throw new Error('Ingen opdatering');
  log(`Henter version ${app.update.version}...`);
  const res = await fetch(app.update.url, { headers: { 'User-Agent': 'lol-rune-helper' }, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Download fejlede: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10 * 1024 * 1024) throw new Error('Filen er for lille - afbryder');
  const exe = process.execPath;
  fs.writeFileSync(`${exe}.new`, buf, { mode: 0o755 });
  // En kørende fil kan omdøbes (også på Windows) men ikke overskrives: gem den gamle som .old.
  const rollback = () => {
    try { fs.rmSync(exe, { force: true }); fs.renameSync(`${exe}.old`, exe); } catch {}
  };
  fs.rmSync(`${exe}.old`, { force: true });
  fs.renameSync(exe, `${exe}.old`);
  try {
    fs.renameSync(`${exe}.new`, exe);
  } catch (e) {
    fs.renameSync(`${exe}.old`, exe); // fx antivirus der holder den nye fil - behold den gamle
    throw e;
  }
  // Start den nye version mens den gamle stadig kører; den venter selv på at porten bliver ledig.
  const child = spawn(exe, ['--updated'], { cwd: APP_DIR, detached: true, stdio: 'ignore', env: process.env });
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!started) {
    rollback();
    throw new Error('Den nye version kunne ikke starte - beholder den gamle');
  }
  child.unref();
  log('Opdateret - genstarter...');
  for (const client of sseClients) client.end();
  app.server.close();
  app.server.closeAllConnections();
  setTimeout(() => process.exit(0), 300);
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
    position: p.position || '',
    level: p.level || 1,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
    assists: s.assists || 0,
    cs: s.creepScore || 0,
    isDead: Boolean(p.isDead),
    itemIds,
    itemGold,
    // Optagede inventory-pladser (0-5; plads 6 er trinket). En stak potions fylder én plads.
    slotsUsed: (p.items || []).filter((i) => (typeof i.slot === 'number' ? i.slot < 6 : !dd.items[String(i.itemID)]?.tags.includes('Trinket'))).length,
    dmg: damageProfile(champ, itemIds),
    armor: itemIds.reduce((sum, id) => sum + (dd.items[id]?.stats.FlatArmorMod || 0), 0),
    mr: itemIds.reduce((sum, id) => sum + (dd.items[id]?.stats.FlatSpellBlockMod || 0), 0),
    healing: HEALERS.has(champ?.id) || itemIds.some((id) => dd.items[id]?.tags.some((t) => t === 'LifeSteal' || t === 'SpellVamp')),
  };
}

// Pris tilbage når de dele du allerede ejer trækkes fra (hver ejet del tælles én gang).
// Returnerer også hvilke ejede dele der indgår, så vi ved om du er i gang med itemet.
function remainingCost(id, ownedIds) {
  const owned = [...ownedIds];
  const used = [];
  let cost = dd.items[id]?.gold || 0;
  // Ejer du en del, trækkes hele dens pris fra; ellers kigges på dens egne dele.
  const take = (x) => {
    for (const c of dd.items[x]?.from || []) {
      const i = owned.indexOf(c);
      if (i !== -1) { owned.splice(i, 1); used.push(c); cost -= dd.items[c].gold; } else take(c);
    }
  };
  take(id);
  return { cost: Math.max(0, cost), used };
}

// Dele for mindst så meget guld betyder at du er i gang med itemet (en enkelt Amplifying Tome gør ikke).
const IN_PROGRESS_GOLD = 700;

// Starter-items man sælger for at få plads: Doran's Shield/Blade/Ring, Dark Seal, Cull.
const SELLABLE_STARTERS = new Set(['1054', '1055', '1056', '1082', '1083']);
const ELIXIR = { ad: '2140', ap: '2139', tank: '2138' }; // Wrath, Sorcery, Iron (500 g, fylder ingen plads)

// Inventory-overblik: pladser, fuldt build og elixir der passer til dig (ved fuldt build).
function inventoryInfo(me, gold, mapNumber) {
  const completed = me.itemIds.filter((id) => isCompleted(dd.items[id]));
  const full = completed.length >= 6;
  const kind = me.champ?.tags?.[0] === 'Tank' ? 'tank' : me.dmg.ad >= 0.5 ? 'ad' : 'ap';
  const elixirId = ELIXIR[kind];
  const elixirOk = full && dd.items[elixirId] && dd.items[elixirId].maps[mapNumber] !== false;
  return {
    slotsUsed: Math.min(6, me.slotsUsed ?? me.itemIds.length),
    completed: completed.length,
    full,
    elixir: elixirOk ? { id: elixirId, cost: dd.items[elixirId].gold, canAfford: dd.items[elixirId].gold <= gold } : null,
  };
}

function affordablePart(id, ownedIds, gold) {
  const owned = [...ownedIds];
  const parts = [];
  // Som remainingCost: en del du ejer (inkl. dens under-dele) er allerede betalt og foreslås ikke.
  const walk = (x) => {
    for (const c of dd.items[x]?.from || []) {
      const i = owned.indexOf(c);
      if (i !== -1) { owned.splice(i, 1); continue; }
      parts.push(c);
      walk(c);
    }
  };
  walk(id);
  return parts
    .filter((p) => dd.items[p]?.gold <= gold)
    .sort((a, b) => dd.items[b].gold - dd.items[a].gold)[0] || null;
}

function threatOf(p) {
  return p.itemGold + p.kills * 300 + p.assists * 100 + p.level * 150 - p.deaths * 100;
}

// Næste evne efter buildets skill-rækkefølge: den første i rækkefølgen du ligger bagud på
// (så den også giver mening, hvis du har afveget fra rækkefølgen tidligere).
function nextSkill(order, levels) {
  const target = { Q: 0, W: 0, E: 0, R: 0 };
  for (const s of order) {
    if (!(s in target)) continue;
    target[s]++;
    if (target[s] > levels[s]) return s;
  }
  return null;
}

function skillHint(activePlayer, build) {
  const abilities = activePlayer?.abilities || {};
  const levels = { Q: 0, W: 0, E: 0, R: 0 };
  for (const k of Object.keys(levels)) levels[k] = abilities[k]?.abilityLevel || 0;
  const spent = levels.Q + levels.W + levels.E + levels.R;
  const unspent = Math.max(0, (activePlayer?.level || 0) - spent);
  const order = build?.skills?.[0]?.order || [];
  return {
    levels,
    unspent,
    next: unspent > 0 ? nextSkill(order, levels) : null,
    names: Object.fromEntries(Object.keys(levels).map((k) => [k, abilities[k]?.displayName || k])),
    max: build?.skill_masteries?.[0]?.ids || [],
  };
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
  const opponent = me.position ? enemies.find((p) => p.position === me.position) : null;
  const matchup = opponent && { player: opponent, stats: matchupStats(build, opponent.champ?.key) };
  const skill = skillHint(data.activePlayer, build);
  const inventory = inventoryInfo(me, gold, data.gameData?.mapNumber || 11);
  return { me, allies, enemies, gold, gameTime: data.gameData?.gameTime || 0, gameMode: data.gameData?.gameMode, score, enemy, advice, matchup, skill, inventory };
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

  // Inventory: 6 pladser. Fuldt build = 6 færdige items -> kun "byt ud"-forslag.
  const completedOwned = owned.filter((id) => isCompleted(dd.items[id]));
  const full = completedOwned.length >= 6;
  const freeSlots = Math.max(0, 6 - (me.slotsUsed ?? owned.length));
  // Unikke passiver du allerede har (to Spellblade-/Lifeline-/Hydra-items virker ikke sammen).
  const ownedPassives = new Set(completedOwned.flatMap((id) => dd.items[id].passives));
  // Starter-items der kan sælges for at få plads (billigste/mindst værdifulde først).
  const buildingMejais = (pop.get('3041') || 0) >= 0.05;
  const sellable = [...new Set(owned)]
    .filter((id) => SELLABLE_STARTERS.has(id) && !(id === '1082' && buildingMejais))
    .sort((a, b) => dd.items[a].sell - dd.items[b].sell);
  // Ved fuldt build: det af dine items der er mindst brugt i buildet (støvler beholdes).
  const swapOut = full
    ? completedOwned.filter((id) => !dd.items[id].tags.includes('Boots')).sort((a, b) => (pop.get(a) || 0) - (pop.get(b) || 0))[0]
    : null;
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
    if (it.passives.some((p) => ownedPassives.has(p))) continue; // samme unikke passiv som noget du har
    const { cost, used } = remainingCost(id, owned);
    const paid = it.gold - cost;
    const inProgress = paid >= IN_PROGRESS_GOLD;
    // Sjældne køb i puljen (fx Randuin's på en mage) passer sjældent til championen - medmindre du er i gang med det.
    if (popularity >= 0 && popularity < 0.02 && !inProgress) continue;
    let score = Math.max(popularity, 0) * 100;
    const reasons = [];
    if (inProgress) {
      score += 40 + 60 * (paid / it.gold);
      reasons.push(`Du er i gang: har ${used.map(itemName).join(', ')} (${pct(paid / it.gold)} af prisen)`);
    }
    if (it.antiheal && enemy.healers.length) { score += 30 + 15 * enemy.healers.length; reasons.push(`Anti-heal mod ${names(enemy.healers)}`); }
    if (it.tags.includes('ArmorPenetration') && iAmAD && enemy.armorHeavy) { score += 35; reasons.push(`${names(enemy.armorStackers)} bygger armor`); }
    if (it.tags.includes('MagicPenetration') && !iAmAD && enemy.mrHeavy) { score += 35; reasons.push(`${names(enemy.mrStackers)} bygger magic resist`); }
    const fedAD = enemy.fed.find((p) => p.dmg.ad >= 0.6);
    const fedAP = enemy.fed.find((p) => p.dmg.ap >= 0.6);
    if (it.tags.includes('Armor') && fedAD) { score += 30; reasons.push(`${fedAD.champ?.name || fedAD.name} er fed (${kda(fedAD)}) og laver AD-skade`); }
    if (it.tags.includes('SpellBlock') && fedAP) { score += 30; reasons.push(`${fedAP.champ?.name || fedAP.name} er fed (${kda(fedAP)}) og laver AP-skade`); }
    if (it.tags.includes('Armor') && enemy.adShare >= 0.65) { score += 15; reasons.push(`${pct(enemy.adShare)} af deres trussel er AD`); }
    if (it.tags.includes('SpellBlock') && enemy.apShare >= 0.55) { score += 15; reasons.push(`${pct(enemy.apShare)} af deres trussel er AP`); }
    const adapted = reasons.length > (inProgress ? 1 : 0);
    if (!reasons.length) reasons.push(`Fast del af buildet (${pct(Math.min(Math.max(popularity, 0), 1))} køber det)`);
    let budget = gold;
    let sell = null;
    let swap = null;
    if (full) {
      // Fuldt build: kun bytte når der er en konkret grund (anti-heal, armor, MR ...).
      if (!adapted || !swapOut) continue;
      swap = swapOut;
      budget += dd.items[swapOut].sell;
      reasons.unshift(`Fuldt build: byt ${itemName(swapOut)} ud (sælges for ${dd.items[swapOut].sell} g)`);
    } else if (!used.length && freeSlots === 0) {
      // Nyt item uden ejede dele kræver en ledig plads.
      if (!sellable.length) continue;
      sell = sellable[0];
      budget += dd.items[sell].sell;
      reasons.push(`Kræver en ledig plads: sælg ${itemName(sell)} (+${dd.items[sell].sell} g)`);
    }
    // En del fylder en plads: kun forslag om del hvis der er plads.
    const part = cost > budget && freeSlots > 0 && !full ? affordablePart(id, owned, gold) : null;
    scored.push({ id, score, reasons, cost, canAfford: cost <= budget, part, adapted, inProgress, used, sell, swap });
  }
  scored.sort((a, b) => b.score - a.score);
  // Rækkefølge: det item du er i gang med (dine dele er ikke spildt), så op til 2 tilpassede forslag,
  // resten fyldes med det bedste fra buildet. Hver ejet del bruges kun til ét "i gang"-item.
  // Max ét anti-heal-item.
  const out = [];
  const maxOut = full ? 2 : 3;
  const add = (s) => {
    if (out.includes(s) || out.length === maxOut) return false;
    if (dd.items[s.id].antiheal && out.some((o) => dd.items[o.id].antiheal)) return false;
    out.push(s);
    return true;
  };
  const claimed = [];
  const rejected = new Set(); // andre items der ville bruge de samme dele
  for (const s of scored.filter((x) => x.inProgress)) {
    const left = [...claimed];
    const overlaps = s.used.some((u) => { const i = left.indexOf(u); if (i === -1) return false; left.splice(i, 1); return true; });
    if (!overlaps && add(s)) claimed.push(...s.used);
    else rejected.add(s);
  }
  const rest = scored.filter((s) => !rejected.has(s));
  rest.filter((s) => s.adapted && !s.inProgress).slice(0, 2).forEach(add);
  rest.forEach(add);
  // "I gang" først, ellers efter score.
  return out.sort((a, b) => (b.inProgress - a.inProgress) || (b.score - a.score));
}

// ---------- Stemme (virker også i ægte fuldskærm, hvor intet vindue kan ses) ----------

const lastSpoken = new Map();
function speak(kind, text) {
  if (!app.cfg.voice) return;
  // Højst én besked af hver slags hvert 8. sekund, så den ikke snakker i munden på sig selv.
  if (Date.now() - (lastSpoken.get(kind) || 0) < 8000) return;
  lastSpoken.set(kind, Date.now());
  log(`Stemme: ${text}`);
  const done = () => {};
  if (process.env.LOL_HELPER_SAY_CMD) return execFile(process.env.LOL_HELPER_SAY_CMD, [text], done); // test-hook
  if (process.platform === 'win32') {
    // Windows' indbyggede talesyntese; teksten via miljøvariabel, så anførselstegn i navne er sikre.
    execFile('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak($env:LRH_SAY)'],
    { windowsHide: true, env: { ...process.env, LRH_SAY: text } }, done);
  } else if (process.platform === 'darwin') {
    execFile('say', [text], done);
  }
}

// Sig kun det der er NYT siden sidste tjek (ikke alt sammen når kampen starter).
function announce(L) {
  const v = app.voice;
  const afford = new Set(L.advice.filter((a) => a.canAfford).map((a) => a.id));
  const fed = new Set(L.enemy.fed.map((p) => p.champ?.name || p.name));
  if (v) {
    const newAfford = [...afford].filter((id) => !v.afford.has(id));
    // Kun det vigtigste forslag (de står i prioriteret rækkefølge) - kort besked midt i en kamp.
    if (newAfford.length) speak('afford', `Råd til ${itemName(newAfford[0])}`);
    if (L.skill.next && !v.skillNext) speak('skill', `Level op: ${L.skill.next}`);
    const newFed = [...fed].filter((n) => !v.fed.has(n));
    if (newFed.length) speak('fed', `${newFed.join(' og ')} er fed`);
  }
  app.voice = { afford, fed, skillNext: L.skill.next };
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
  if (app.live) {
    trackGame(data, app.live);
    const opp = app.live.matchup?.player;
    if (opp?.champ) ensurePlan(champ.key, opp.champ.key, LIVE_POSITION[meRaw.position] || app.build?.position, app.liveBuild.build);
    trackOpponent(app.live);
    announce(app.live);
  }
  if (first && app.live) log(`Live: ${champ.name} - forslag og scoreboard vises i vinduet.`);
  broadcast();
}

async function liveLoop() {
  let gone = 0; // antal tjek i træk hvor spillet ikke findes
  for (;;) {
    let wait = 2000;
    let data = null;
    try {
      data = await liveGet('/liveclientdata/allgamedata');
      gone = 0;
    } catch (e) {
      // Kun "porten er lukket" eller 404 betyder at spillet er væk; en timeout er bare et hak.
      if (e.code === 'ECONNREFUSED' || e.status === 404) gone++;
      // Ingen kamp: tjek sjældnere, og endnu sjældnere når klienten slet ikke kører.
      wait = app.client || process.env.LOL_HELPER_LIVE ? 3000 : 6000;
    }
    if (data?.allPlayers?.length && data.activePlayer) {
      try {
        await updateLive(data);
      } catch (e) {
        log(`Fejl i live-data: ${e.message}`); // fejl i vores egen behandling afslutter ikke kampen
      }
    }
    if (app.live && gone >= 2) {
      app.live = null;
      app.liveBuild = null;
      app.voice = null;
      log('Kampen er slut.');
      finishGame();
      broadcast();
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
  opponentOverride: null, // lane-modstander valgt i vinduet
  prefetched: null,       // champion hvis build allerede hentes (hover)
  runeIndex: 0,
  appliedPerks: null,     // rune-siden vi selv har sat (så vi kan se om du har ændret den)
  build: null,         // { build, position }
  rec: null,
  applied: { pickKey: null, itemKey: null },
  voice: null,         // hvad stemmen allerede har sagt i denne kamp
  plan: null,          // gameplan mod lane-modstanderen
  planKey: null,
  draft: null,         // ban/counterpick-forslag før du låser
  draftKey: null,
  game: null,          // køb og forslag i den igangværende kamp (til kampoversigten)
  update: null,        // { version, url, notes } hvis en nyere version findes
  server: null,
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
    skill: L.skill,
    inventory: L.inventory && {
      ...L.inventory,
      elixir: L.inventory.elixir && { ...L.inventory.elixir, name: itemName(L.inventory.elixir.id), icon: dd.items[L.inventory.elixir.id]?.icon },
    },
    matchup: L.matchup && {
      name: L.matchup.player.champ?.name || L.matchup.player.name,
      icon: L.matchup.player.champ?.icon,
      winRate: L.matchup.stats?.winRate ?? null,
      games: L.matchup.stats?.games ?? null,
    },
    me: player(L.me),
    allies: team(L.allies, L.me.team),
    enemies: team(L.enemies, enemySide),
    advice: L.advice.map((a) => ({
      ...item(a.id),
      cost: a.cost,
      canAfford: a.canAfford,
      reasons: a.reasons,
      adapted: a.adapted,
      inProgress: a.inProgress,
      part: a.part && { ...item(a.part), cost: dd.items[a.part].gold },
      sell: a.sell && { ...item(a.sell), value: dd.items[a.sell].sell },
      swap: a.swap && { ...item(a.swap), value: dd.items[a.swap].sell },
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

const champView = (id) => ({ id, name: dd.champions[id]?.name || String(id), icon: dd.champions[id]?.icon });

function planView() {
  const p = app.plan;
  if (!p) return null;
  const item = (id) => ({ id, name: itemName(id), icon: dd.items[id]?.icon });
  return {
    opponent: champView(p.oppKey),
    me: champView(p.myKey),
    position: p.position,
    winRate: p.stats?.winRate ?? null,
    games: p.stats?.games ?? null,
    laneAdvantage: p.laneAdvantage,
    soloKill: p.soloKill,
    playStyle: p.playStyle,
    tip: p.tip,
    scaling: p.scaling,
    myCore: p.myCore.map(item),
    oppCore: p.oppCore.map(item),
    now: app.live ? planNow(p, app.live) : null,
    log: p.log.map((l) => ({ t: l.t, text: l.text })),
  };
}

function draftView() {
  const d = app.draft;
  if (!d) return null;
  return {
    position: d.position,
    myBanTurn: Boolean(d.myBanTurn),
    pool: d.pool.map(champView),
    bans: d.bans.map((b) => ({ ...champView(b.id), reason: b.reason })),
    opponent: d.opponent ? champView(d.opponent) : null,
    poolVs: d.poolVs.map((x) => ({ ...champView(x.id), winRate: x.winRate, games: x.games })),
    counters: d.counters.map((x) => ({ ...champView(x.id), winRate: x.winRate, games: x.games })),
  };
}

function historyView() {
  const games = history.games;
  if (!games.length) return null;
  const item = (id) => ({ id, name: itemName(id), icon: dd.items[id]?.icon });
  // Pr. champion: kampe, sejre (hvor kendt), gennemsnitlig KDA og hvor ofte du fulgte forslagene.
  const per = new Map();
  for (const g of games) {
    const p = per.get(g.champion) || { champion: g.champion, icon: dd.champions[g.championId]?.icon, games: 0, wins: 0, known: 0, k: 0, d: 0, a: 0, followed: [] };
    p.games++;
    if (g.result) { p.known++; if (g.result === 'Sejr') p.wins++; }
    p.k += g.kills || 0; p.d += g.deaths || 0; p.a += g.assists || 0;
    if (g.followed != null) p.followed.push(g.followed);
    per.set(g.champion, p);
  }
  return {
    last: { ...games[0], icon: dd.champions[games[0].championId]?.icon, items: (games[0].items || []).map(item), buys: (games[0].buys || []).map((b) => ({ ...b, ...item(b.id) })) },
    recent: games.slice(0, 10).map((g) => ({
      date: g.date, champion: g.champion, icon: dd.champions[g.championId]?.icon, result: g.result,
      kda: `${g.kills}/${g.deaths}/${g.assists}`, csPerMin: g.csPerMin, followed: g.followed,
    })),
    champions: [...per.values()].sort((a, b) => b.games - a.games).slice(0, 8).map((p) => ({
      champion: p.champion, icon: p.icon, games: p.games,
      winRate: p.known ? p.wins / p.known : null,
      kda: p.d ? (p.k + p.a) / p.d : p.k + p.a,
      followed: p.followed.length ? p.followed.reduce((s, x) => s + x, 0) / p.followed.length : null,
    })),
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
    autostart: autostartSupported() ? autostartEnabled() : null,
    version: VERSION,
    pid: process.pid,
    voice: Boolean(app.cfg.voice),
    update: app.update && { version: app.update.version, notes: app.update.notes, canApply: IS_SEA },
    draft: draftView(),
    plan: planView(),
    history: historyView(),
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
    patchNote: b.build.thinPatch ? `Patch ${b.build.newestVersion} er ny og har for få kampe endnu - bruger ${b.build.version}` : null,
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
      matchup: r.matchup || null,
    })),
    matchup: rec.matchup && {
      id: rec.matchup.id,
      name: rec.matchup.name,
      icon: dd.champions[rec.matchup.id]?.icon,
      winRate: rec.matchup.stats?.winRate ?? null,
      games: rec.matchup.stats?.games ?? null,
      manual: rec.matchup.manual,
    },
    spells: (app.appliedSpells || rec.spells || []).map((id) => ({ name: spellName(id), icon: dd.spells[id]?.icon })),
    skills: rec.skills,
    blocks: rec.blocks.map((bl) => ({
      title: bl.type,
      items: bl.items.map((i) => ({ id: i.id, count: i.count, name: itemName(i.id), icon: dd.items[i.id]?.icon })),
    })),
    notes: rec.notes,
    enemy: pick.enemyIds.length ? {
      champions: pick.enemyIds.map((id) => ({ id, name: dd.champions[id]?.name || '?', icon: dd.champions[id]?.icon })),
      adShare: rec.enemy?.adShare ?? null,
      apShare: rec.enemy?.apShare ?? null,
    } : null,
  };
}

// ---------- Start med computeren ----------

const AUTOSTART_FILE = {
  win32: path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'LoL Rune Helper.lnk'),
  darwin: path.join(os.homedir(), 'Library', 'LaunchAgents', 'dk.tvginvest.lolrunehelper.plist'),
}[process.platform];

const autostartSupported = () => Boolean(AUTOSTART_FILE);
const autostartEnabled = () => Boolean(AUTOSTART_FILE) && fs.existsSync(AUTOSTART_FILE);
// Som færdig programfil: start programmet selv. Fra kilde: node + scriptet.
const launchCommand = () => (IS_SEA ? [process.execPath] : [process.execPath, path.join(__dirname, 'lol-helper.js')]);
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function setAutostart(on) {
  if (!on) {
    fs.rmSync(AUTOSTART_FILE, { force: true });
    return;
  }
  const [cmd, ...args] = launchCommand();
  args.push('--autostart'); // starter uden at åbne browseren
  if (process.platform === 'win32') {
    // Genvej i Start-mappen (minimeret vindue). Værdier via miljøvariabler, så stier med mellemrum er sikre.
    const ps = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LRH_LNK);' +
      '$s.TargetPath=$env:LRH_TARGET;$s.Arguments=$env:LRH_ARGS;$s.WorkingDirectory=$env:LRH_DIR;$s.WindowStyle=7;$s.Save()';
    await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      env: { ...process.env, LRH_LNK: AUTOSTART_FILE, LRH_TARGET: cmd, LRH_ARGS: args.map((a) => `"${a}"`).join(' '), LRH_DIR: APP_DIR },
    }, (err) => (err ? reject(err) : resolve())));
  } else {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dk.tvginvest.lolrunehelper</string>
  <key>ProgramArguments</key>
  <array>${[cmd, ...args].map((a) => `<string>${xmlEscape(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xmlEscape(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(APP_DIR, 'lol-helper.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(APP_DIR, 'lol-helper.log'))}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    fs.writeFileSync(AUTOSTART_FILE, plist);
  }
}

const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  let data;
  try {
    data = `data: ${JSON.stringify(viewModel())}\n\n`;
  } catch (e) {
    // Ikke log() her - den kalder broadcast() igen.
    console.error(`Fejl i vinduets data: ${e.message}`);
    return;
  }
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

// Tilladte Host-headers: beskytter mod DNS-rebinding (en fremmed side der "bliver" 127.0.0.1).
const allowedHosts = new Set();
function setAllowedHosts(port) {
  allowedHosts.clear();
  for (const h of ['127.0.0.1', 'localhost']) allowedHosts.add(`${h}:${port}`);
  for (const u of app.remote.urls) allowedHosts.add(new URL(u.url).host);
}

function startWindowServer(port) {
  const html = readAsset('gui.html');
  // En fejl i en forespørgsel må aldrig vælte programmet - svar 500 og log den.
  const server = http.createServer((req, res) => handleRequest(req, res, html).catch((e) => {
    log(`Fejl i vinduet: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end();
  }));
  return listenWithFallback(server, port);
}

async function handleRequest(req, res, html) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (allowedHosts.size && !allowedHosts.has(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Ukendt adresse');
  }
  if (!LOOPBACK.has(req.socket.remoteAddress)) {
    const { token } = app.remote;
    let query = null;
    try { query = new URL(req.url, 'http://x').searchParams.get('token'); } catch {}
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
    try {
      // Tjek inde i køen: en ny champion kan være låst, mens klikket ventede.
      await serial(() => {
        if (!app.rec?.runeOptions[index] || !app.client) throw Object.assign(new Error('Ingen rune-side at vælge'), { badRequest: true });
        return applyRuneChoice(index);
      });
      return json(200, { ok: true });
    } catch (e) {
      if (e.badRequest) return json(400, { error: e.message });
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
  if (req.method === 'POST' && req.url === '/api/opponent') {
    const { championId } = await readBody(req);
    if (championId !== null && !app.pick?.enemyIds.includes(Number(championId))) return json(400, { error: 'Ikke på modstanderholdet' });
    app.opponentOverride = championId === null ? null : Number(championId);
    app.applied.itemKey = null; // løkken opdaterer med den nye modstander
    return json(200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/update') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    try {
      json(200, { ok: true });
      await applyUpdate();
    } catch (e) {
      log(`Fejl: opdatering mislykkedes: ${e.message}`);
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/voice') {
    const { enabled } = await readBody(req);
    app.cfg.voice = Boolean(enabled);
    saveConfigValue('voice', app.cfg.voice);
    log(app.cfg.voice ? 'Stemme slået til.' : 'Stemme slået fra.');
    if (app.cfg.voice) { lastSpoken.clear(); speak('test', 'Stemmen er slået til'); }
    return json(200, { ok: true, enabled: app.cfg.voice });
  }
  if (req.method === 'POST' && req.url === '/api/autostart') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    if (!autostartSupported()) return json(400, { error: 'Ikke understøttet her' });
    const { enabled } = await readBody(req);
    try {
      await setAutostart(Boolean(enabled));
      log(enabled ? 'Starter nu automatisk med computeren.' : 'Starter ikke længere automatisk.');
      broadcast();
      return json(200, { ok: true, enabled: autostartEnabled() });
    } catch (e) {
      log(`Fejl: kunne ikke ændre autostart: ${e.message}`);
      return json(500, { error: e.message });
    }
  }
  json(404, { error: 'Ikke fundet' });
}

function listenWithFallback(server, port) {
  // Efter en opdatering lukker den gamle version om lidt: vent på samme port i stedet for at tage en ny.
  let waitForOld = process.argv.includes('--updated') ? 40 : 0;
  return new Promise((resolve, reject) => {
    const tryListen = (p, attempts) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && waitForOld-- > 0) return setTimeout(() => tryListen(p, attempts), 250);
        if (e.code === 'EADDRINUSE' && attempts > 0) return tryListen(p + 1, attempts - 1);
        reject(e);
      });
      // Uden telefon-adgang kun 127.0.0.1: vinduet kan ikke nås fra andre maskiner.
      server.listen(p, app.remote.enabled ? '0.0.0.0' : '127.0.0.1', () => {
        app.server = server;
        resolve(server.address().port);
      });
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

const perkKey = (r) => [...r.primary_rune_ids, ...r.secondary_rune_ids, ...r.stat_mod_ids].join(',');

async function applyRuneChoice(index) {
  const rune = app.rec.runeOptions[index];
  await applyRunes(app.client, rune, titleFor());
  app.runeIndex = index;
  app.appliedPerks = perkKey(rune);
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
    app.appliedPerks = null;
    const position = app.roleOverride || POSITION_MAP[pick.assignedPosition];
    app.build = await getBuild(cfg, pick.championId, position, pick.gameMode);
  }
  if (!app.build) return;
  const prevMatchup = app.rec?.matchup?.id ?? null;
  app.rec = recommend(app.build.build, cfg, pick.enemyIds, await findMatchup(pick));
  const matchupChanged = (app.rec.matchup?.id ?? null) !== prevMatchup;
  // Rune-valgene kan være omrokeret (matchup-side først) - peg på den side der faktisk er sat.
  if (app.appliedPerks) app.runeIndex = app.rec.runeOptions.findIndex((r) => perkKey(r) === app.appliedPerks);
  // Gameplan mod lane-modstanderen (i baggrunden - runer/items venter ikke på den).
  if (app.rec.matchup) ensurePlan(pick.championId, app.rec.matchup.id, app.build.position, app.build.build);

  if (fullApply) {
    const stats = roleStats(app.build);
    log(`${champName} (${app.build.position}) - patch ${app.build.build.version || '?'}` +
      (app.build.build.thinPatch ? ` (${app.build.build.newestVersion} har for få kampe endnu)` : '') +
      (stats ? `, ${stats.play.toLocaleString('da-DK')} kampe, ${pct(stats.winRate)} WR (${stats.scope})` : ''));
    if (cfg.setRunes && app.rec.runeOptions.length) await applyRuneChoice(0);
    if (cfg.setSpells && app.rec.spells) {
      app.appliedSpells = await applySpells(app.client, cfg, pick.me, app.rec.spells);
      log(`  Summoners: ${spellName(app.appliedSpells[0])} (D) + ${spellName(app.appliedSpells[1])} (F)`);
    }
    if (app.rec.skills.start.length) log(`  Skills: start ${app.rec.skills.start.join(' > ')}, max ${app.rec.skills.max.join(' > ')}`);
  } else {
    log(matchupChanged && app.rec.matchup
      ? `Lane-modstander: ${app.rec.matchup.name}${app.rec.matchup.manual ? ' (valgt manuelt)' : ''} - opdaterer for ${champName}.`
      : `Modstanderholdet ændrede sig - opdaterer items for ${champName}.`);
    const top = app.rec.runeOptions[0];
    if (cfg.setRunes && top?.matchup && app.appliedPerks && perkKey(top) !== app.appliedPerks) {
      // Matchup-runer kun hvis du ikke selv har ændret auto-siden.
      if (await autoPageUntouched()) {
        await applyRuneChoice(0);
        log(`  Runer skiftet til matchuppet mod ${top.matchup}.`);
      } else {
        log(`  Du har selv ændret rune-siden - matchup-runerne mod ${top.matchup} ligger som fane i vinduet.`);
      }
    }
  }
  await applyItems();
}

async function autoPageUntouched() {
  try {
    const page = await lcu(app.client, 'GET', '/lol-perks/v1/currentpage');
    return Boolean(page?.name?.startsWith(PREFIX)) && (page.selectedPerkIds || []).join(',') === app.appliedPerks;
  } catch {
    return false;
  }
}

async function findMatchup(pick) {
  if (pick.gameMode === 'ARAM' || !POSITIONS.includes(app.build.position)) return null;
  const id = app.opponentOverride ?? await laneOpponent(app.cfg, app.build.position, pick.enemyIds);
  if (!id) return null;
  let build = null;
  try {
    build = await fetchBuild(app.cfg.region, 'ranked', pick.championId, app.build.position, id);
  } catch (e) {
    log(`  Kunne ikke hente matchup-data: ${e.message}`);
  }
  return { id, build, stats: matchupStats(app.build.build, id), manual: app.opponentOverride != null };
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
      app.opponentOverride = null;
    }
    app.prefetched = null;
    if (app.draft || app.draftKey) { app.draft = null; app.draftKey = null; }
    // Tilbage i lobbyen uden kamp (fx dodge): vis ikke den gamle champion select.
    if (app.pick && ['None', 'Lobby', 'Matchmaking', 'ReadyCheck'].includes(phase)) { clearPick(); broadcast(); }
    return cfg.pollMs;
  }
  const session = await lcu(app.client, 'GET', '/lol-champ-select/v1/session');
  const me = session.myTeam?.find((m) => m.cellId === session.localPlayerCellId);
  const pickPending = (session.actions || []).flat()
    .some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && !a.completed);
  if (!(me?.championId > 0) || pickPending) {
    setStatus('Champion select - venter på at du låser en champion.');
    if (me) updateDraft(session, me);
    // Hent buildet allerede mens du hover, så runerne sættes i samme sekund du låser.
    const hover = me?.championId || me?.championPickIntent;
    if (hover > 0 && hover !== app.prefetched) {
      app.prefetched = hover;
      getBuild(cfg, hover, app.roleOverride || POSITION_MAP[me.assignedPosition], 'CLASSIC').catch(() => {});
    }
    return cfg.pollMs;
  }
  setStatus('Champion select - build sat.');
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0).sort((a, b) => a - b);
  const pickKey = `${me.championId}:${me.assignedPosition}:${app.roleOverride || ''}`;
  const itemKey = `${pickKey}|${enemyIds.join(',')}|${app.opponentOverride ?? ''}`;
  if (pickKey !== app.applied.pickKey || itemKey !== app.applied.itemKey) {
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
  const updated = process.argv.includes('--updated');
  if (process.argv.includes('--autostart') || updated) app.cfg.openWindow = false; // efter opdatering genforbinder vinduet selv
  if (IS_SEA) fs.rm(`${process.execPath}.old`, { force: true }, () => {}); // rester fra en opdatering på Windows

  // Kører programmet allerede? Så åbn bare dets vindue i stedet for at starte en kopi.
  if (app.cfg.port && !updated) {
    try {
      const running = await fetch(`http://127.0.0.1:${app.cfg.port}/state`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      if (running && 'ddVersion' in running) {
        console.log('LoL Rune Helper kører allerede - åbner vinduet.');
        if (!process.argv.includes('--autostart')) openBrowser(`http://127.0.0.1:${app.cfg.port}`);
        setTimeout(() => process.exit(0), 1500);
        return;
      }
    } catch {}
  }

  log(`LoL Rune Helper ${VERSION} starter...`);
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
  setAllowedHosts(port);
  if (app.cfg.openWindow) openBrowser(url);
  if (app.cfg.liveAdvice) liveLoop();
  pruneCache();
  setInterval(pruneCache, 3600 * 1000);
  if (app.cfg.autoUpdate) {
    checkUpdate();
    setInterval(checkUpdate, 6 * 3600 * 1000);
  }

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

// Sikkerhedsnet: en overset fejl i en baggrundsopgave skal logges, ikke lukke programmet.
process.on('unhandledRejection', (e) => {
  try { log(`Fejl (uventet): ${e?.message || e}`); } catch {}
});

main().catch((e) => {
  console.error(e);
  if (IS_SEA) setTimeout(() => process.exit(1), 30000); // hold vinduet åbent så fejlen kan læses
  else process.exit(1);
});
