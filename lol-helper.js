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
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('crypto');

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
  voice: true,            // sig "Råd til ...", "Level op: Q", "Level 6" og færdige core-items højt (virker også i ægte fuldskærm)
  // Notifikationer om modstanderne: stemme/overlay når lane-modstanderen køber et item eller når level 6, "X er fed",
  // "har ult" og FED-mærket. OBS: Overwolfs regler for Riot-spil forbyder notifikationer om modstanderes power spikes.
  enemyAlerts: true,
  openWindow: true,       // åbn vinduet i browseren ved start
  remoteAccess: false,    // true = vinduet kan åbnes fra telefonen via Tailscale med en hemmelig nøgle
  remoteLan: false,       // true = også via wifi/LAN (ukrypteret HTTP - nøglen kan aflyttes på delte netværk)
  remoteHosts: [],        // ekstra navne vinduet må åbnes på, fx et Tailscale MagicDNS-navn ("min-pc")
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

// Læs config.json som objekt. Notesblok/PowerShell kan gemme med BOM (U+FEFF), som JSON.parse ikke tåler.
// Kaster ved ugyldig JSON; ENOENT kastes videre, så kalderen kan skelne "ingen fil" fra "ødelagt fil".
function readConfigFile() {
  const obj = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('config.json skal være et JSON-objekt { ... }');
  return obj;
}

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...readConfigFile() };
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Kunne ikke læse config.json (${e.message}) - bruger standardindstillinger.`);
    return { ...DEFAULT_CONFIG };
  }
}

// Gem én indstilling i config.json (resten af filen bevares).
// Kan filen ikke læses (fx en tastefejl), skrives intet - ellers ville resten af indstillingerne forsvinde.
function saveConfigValue(key, value) {
  let current = {};
  try {
    current = readConfigFile();
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`Indstillingen blev ikke gemt: config.json kunne ikke læses (${e.message}). Ret filen, så gemmes den næste gang.`);
      return false;
    }
  }
  current[key] = value;
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(current, null, 2)}\n`);
    return true;
  } catch (e) {
    log(`Kunne ikke gemme indstillingen: ${e.message}`);
    return false;
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
    // Lockfilen findes kun mens klienten kører og er gratis at læse - prøv den før PowerShell.
    // Den sidst fundne installationsmappe (fra PowerShell) prøves først, så en installation uden for C/D/E:\Riot Games også er gratis.
    const fromLockfile = readLockfile(lockfileCandidates(findClient.lastCmdline || ''));
    if (fromLockfile) { findClient.psWait = 0; return fromLockfile; }
    // PowerShell tager ~0,5 sek. CPU at starte. Kører League ikke, venter vi længere og længere
    // mellem forsøgene (15 -> 30 -> 60 -> 120 sek.), så programmet ikke bruger CPU hele dagen.
    const psWait = findClient.psWait || 15000;
    if (Date.now() - (findClient.lastPs || 0) < psWait) return null;
    findClient.lastPs = Date.now();
    cmdline = await run('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]);
    if (cmdline.trim()) {
      findClient.psWait = 0;
      findClient.lastCmdline = cmdline;
    } else {
      findClient.psWait = Math.min(psWait * 2, 120000);
    }
  } else {
    cmdline = (await run('ps', ['-A', '-ww', '-o', 'args'])).split('\n').filter((l) => l.includes('LeagueClientUx')).join('\n');
  }
  if (!cmdline.trim()) return null;

  const port = /--app-port=(\d+)/.exec(cmdline);
  const token = /--remoting-auth-token=([\w-]+)/.exec(cmdline);
  if (port && token) return { protocol: 'https', port: Number(port[1]), password: token[1] };

  return readLockfile(lockfileCandidates(cmdline));
}

// Kører processen med dette pid? (EPERM = den findes, men tilhører en anden bruger.)
function pidAlive(pid) {
  if (!(Number(pid) > 0)) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Lockfile-format: LeagueClient:<pid>:<port>:<password>:<protocol>
// En lockfil efter et nedbrud kan blive liggende: spring den over, hvis klientens pid ikke kører.
function readLockfile(files) {
  for (const file of files) {
    try {
      const [, pid, p, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
      if (Number(p) > 0 && password && (!(Number(pid) > 0) || pidAlive(pid))) return { protocol, port: Number(p), password };
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

// Sidste hentede Data Dragon-data gemmes på disken, så programmet kan starte uden internet
// (fx autostart ved Windows-login før netværket er klar).
const DD_CACHE_FILE = () => path.join(CACHE_DIR, 'ddragon.json');

async function fetchStaticData() {
  try {
    const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
    const base = `https://ddragon.leagueoflegends.com/cdn/${versions[0]}`;
    const [champs, items, styles, spells] = await Promise.all(
      ['champion', 'item', 'runesReforged', 'summoner'].map((f) => getJson(`${base}/data/en_US/${f}.json`)),
    );
    const raw = { versions, champs, items, styles, spells };
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(DD_CACHE_FILE(), JSON.stringify(raw));
    } catch {}
    return raw;
  } catch (e) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(DD_CACHE_FILE(), 'utf8')); } catch {}
    if (!raw?.versions?.length || !raw.champs || !raw.items || !raw.styles || !raw.spells) throw e;
    if (!dd.version) log(`Data Dragon svarer ikke (${e.message}) - bruger gemte data fra patch ${raw.versions[0]}.`);
    return { ...raw, offline: true };
  }
}

async function loadStaticData() {
  const { versions, champs, items, styles, spells, offline } = await fetchStaticData();
  const [version] = versions;
  // Alt herunder er synkront: de gamle data skiftes ud på én gang (fjernede items/champions forsvinder også).
  dd.champions = {};
  dd.championKeyById = {};
  dd.items = {};
  dd.runes = {};
  dd.spells = {};
  dd.offline = Boolean(offline);
  dd.versions = versions.slice(0, 10);
  const base = `https://ddragon.leagueoflegends.com/cdn/${version}`;
  dd.version = version;
  for (const c of Object.values(champs.data)) {
    dd.champions[c.key] = { key: c.key, id: c.id, name: c.name, tags: c.tags, info: c.info, icon: `${base}/img/champion/${c.image.full}` };
    dd.championKeyById[c.id.toLowerCase()] = c.key;
  }
  for (const [id, it] of Object.entries(items.data)) {
    dd.items[id] = {
      name: it.name,
      tags: it.tags || [],
      // Riot kalder nu effekten "Wounds" (Thornmail, Chempunk, Bramble Vest siger ikke "Grievous Wounds").
      antiheal: /\bWounds\b/.test(it.description || ''),
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
  // Støvler = Boots-tag eller bygget af støvler (Gunmetal Greaves har ikke Boots-tagget).
  const bootsOf = (id, seen = new Set()) => {
    const it = dd.items[id];
    if (!it || seen.has(id)) return false;
    seen.add(id);
    return it.tags.includes('Boots') || it.from.some((c) => bootsOf(c, seen));
  };
  for (const id of Object.keys(dd.items)) dd.items[id].boots = bootsOf(id);
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

// Start: prøv igen med stigende pause, indtil Data Dragon (eller den gemte kopi) kan læses.
async function loadStaticDataWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadStaticData();
    } catch (e) {
      // Kun netværksfejl prøves igen. En fejl i selve dataene/koden lukker programmet, så en ny version der
      // ikke virker bliver rullet tilbage af den gamle (og ikke hænger i "Venter på internet").
      const network = ['AbortError', 'TimeoutError'].includes(e.name) || Boolean(e.cause?.code)
        || /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket|-> \d{3}/i.test(e.message);
      if (!network) throw e;
      const waitS = Math.min(5 * attempt, 60);
      if (attempt === 1) log(`  ${e.message}`);
      setStatus(`Venter på internet (Data Dragon svarer ikke) - prøver igen om ${waitS} sek.`);
      await sleep(waitS * 1000);
    }
  }
}

// Programmet kan køre i dagevis: tjek jævnligt om Data Dragon har en ny patch (og kom online efter en offline-start).
async function refreshStaticData() {
  try {
    const [latest] = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
    if (latest === dd.version && !dd.offline) return;
    const before = dd.version;
    await loadStaticData();
    if (dd.version !== before) log(`Data Dragon opdateret: ${before} -> ${dd.version}.`);
    broadcast();
  } catch {}
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
  // Pladsen overdrages direkte til den næste i køen, så et nyt kald ikke kan snige sig forbi (max 4).
  if (activeRequests >= 4) await new Promise((resolve) => requestQueue.push(resolve));
  else activeRequests++;
  try {
    return await fn();
  } finally {
    const next = requestQueue.shift();
    if (next) next();
    else activeRequests--;
  }
}

// Ryd udløbne builds i hukommelsen og gamle filer i cache-mappen (kører hver time).
function pruneCache() {
  for (const [key, hit] of buildCache) if (Date.now() - hit.at > CACHE_TTL) buildCache.delete(key);
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f === 'ddragon.json') continue; // offline-kopien af Data Dragon skal overleve
      const file = path.join(CACHE_DIR, f);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.rmSync(file, { force: true });
    }
  } catch {}
}

// Fælles cache for OP.GG-data: hukommelse + fil i cache-mappen, 6 timer.
// En fejl huskes i 15 sek. (så draften ikke hamrer løs på en OP.GG der fejler), og findes en ældre fil
// (op til 24 t, se pruneCache), bruges den hellere end ingenting.
const FAIL_TTL = 15 * 1000;
function cachedJson(key, loader) {
  const hit = buildCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
  const file = path.join(CACHE_DIR, `${key}.json`);
  let fileAt = 0;
  try { fileAt = fs.statSync(file).mtimeMs; } catch {}
  const fresh = fileAt > 0 && Date.now() - fileAt < CACHE_TTL;
  // Data fra disken er så gamle som filen - ellers kunne de leve 6 t mere i hukommelsen.
  const entry = { promise: null, at: fresh ? fileAt : Date.now() };
  const expireSoon = () => { entry.at = Date.now() - CACHE_TTL + FAIL_TTL; };
  entry.promise = (async () => {
    if (fresh) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { entry.at = Date.now(); }
    }
    let data;
    try {
      data = await limited(loader);
    } catch (e) {
      if (fileAt) {
        try {
          const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
          expireSoon(); // prøv nettet igen om lidt
          return stale;
        } catch {}
      }
      throw e;
    }
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {}
    return data;
  })().catch((err) => {
    expireSoon();
    throw err;
  });
  buildCache.set(key, entry);
  return entry.promise;
}

// I starten af en ny patch har OP.GG næsten ingen kampe (fx 280 i stedet for 80.000).
// Så bruges den forrige patch, indtil den nye har nok data.
const THIN_PATCH_GAMES = 20000;

// Forrige patch ud fra Data Dragons versionsliste: "16.21" -> "16.20".
// Kun når OP.GG's version er den nyeste i Data Dragon - halter OP.GG bagefter, er dens patch ikke ny.
function previousPatch(version) {
  const majorMinor = (v) => String(v || '').split('.').slice(0, 2).join('.');
  const current = majorMinor(version);
  const list = [...new Set((dd.versions || []).map(majorMinor).filter((v) => /^\d+\.\d+$/.test(v)))];
  return current && list[0] === current && list[1] ? list[1] : null;
}

function fetchBuild(region, mode, championId, position, target) {
  const key = `${region}_${mode}_${championId}_${position}${target ? `_vs${target}` : ''}`;
  return cachedJson(key, async () => {
    const url = `https://lol-api-champion.op.gg/api/${region}/champions/${mode}/${championId}/${position}` +
      (target ? `?target_champion=${target}` : '');
    const j = await getJson(url);
    // Ukendt format (OP.GG har ændret sig): fejl i stedet for at cache et tomt build i 6 timer.
    if (!j?.data?.summary || !Array.isArray(j.data.rune_pages || j.data.runes)) throw new Error(`OP.GG: uventet svar fra ${url}`);
    const data = { ...j.data, version: j.meta?.version };
    const games = data.summary.average_stats?.play;
    const prev = typeof games === 'number' && games < THIN_PATCH_GAMES ? previousPatch(j.meta?.version) : null;
    if (prev) {
      try {
        const p = await getJson(`${url}${url.includes('?') ? '&' : '?'}version=${prev}`);
        const prevGames = p.data?.summary?.average_stats?.play;
        if (p.data?.summary && typeof prevGames === 'number' && prevGames > 0 && prevGames >= games * 3) {
          return { ...p.data, version: p.meta?.version || prev, newestVersion: j.meta?.version, thinPatch: true };
        }
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
    // Antal kampe bag guiden (kun hvis OP.GG sender det) - så få kampe ikke vises som en dom.
    const spells = Array.isArray(d.summoner_spells) ? d.summoner_spells : null;
    return {
      games: spells ? spells.reduce((s, x) => s + (Number(x?.play) || 0), 0) : null,
      tip: d.opponent_champion_tip || '',
      laneAdvantage: d.lane_advantage_champion || null,
      soloKill: d.lane_solo_kill_advantage_champion || null,
      playStyle: d.recommended_play_style || null,
    };
  });
}

// Rollefordeling for alle champions i ét kald (OP.GG's champion-liste): id -> { TOP: 0.86, ... }.
// Mangler en champion i listen (eller fejler den), hentes championens eget build og rollerne læses derfra.
async function roleRates(cfg, ids) {
  let all = null;
  try {
    all = await cachedJson(`${cfg.region}_roles`, async () => {
      const j = await getJson(`https://lol-api-champion.op.gg/api/${cfg.region}/champions/ranked`);
      if (!Array.isArray(j?.data)) throw new Error('OP.GG: uventet champion-liste');
      return Object.fromEntries(j.data.map((c) => [c.id, Object.fromEntries((c.positions || []).map((p) => [p.name, p.stats?.role_rate || 0]))]));
    });
  } catch {}
  return Object.fromEntries(await Promise.all(ids.map(async (id) => {
    if (all?.[id]) return [id, all[id]];
    try {
      const probe = await fetchBuild(cfg.region, 'ranked', id, 'MID');
      return [id, Object.fromEntries((probe.summary?.positions || []).map((p) => [p.name, p.stats?.role_rate || 0]))];
    } catch {
      return [id, {}];
    }
  })));
}

// Lane-modstanderen (et gæt): OP.GG's rollefordeling for hele modstanderholdet - hver modstander får
// én rolle, så summen af rollernes andel er størst (en flex-pick tager ikke to roller). Kræver mindst 25%.
async function laneOpponent(cfg, position, enemyIds) {
  if (!POSITIONS.includes(position) || !enemyIds.length) return null;
  const ids = enemyIds.slice(0, 5);
  const rates = await roleRates(cfg, ids);
  let best = { score: -1, roles: [] };
  const assign = (i, roles, score) => {
    if (i === ids.length) {
      if (score > best.score) best = { score, roles: [...roles] };
      return;
    }
    for (const pos of POSITIONS) {
      if (roles.includes(pos)) continue;
      roles.push(pos);
      assign(i + 1, roles, score + (rates[ids[i]]?.[pos] || 0));
      roles.pop();
    }
  };
  assign(0, [], 0);
  const i = best.roles.indexOf(position);
  return i !== -1 && (rates[ids[i]]?.[position] || 0) >= 0.25 ? ids[i] : null;
}

// ---------- Jungle-ruter (OP.GG jungle-paths) ----------
// Mest brugte første clear pr. side. Ligger som indlejret data i OP.GG's side (ingen JSON-API) -
// kan ændre sig uden varsel, så en fejl giver bare intet rutekort.
const OPGG_WEB = process.env.LOL_HELPER_OPGG_WEB || 'https://op.gg';
const CAMP_NAMES = { BLUE: 'Blue', RED: 'Red', GROMP: 'Gromp', WOLVES: 'Wolves', RAPTORS: 'Raptors', KRUG: 'Krugs' };

function parseJungleRoutes(html) {
  const text = html.replace(/\\"/g, '"');
  const out = {};
  for (const side of ['BLUE', 'RED']) {
    const prefix = `{"team_key":"${side}","routes":[`;
    const start = text.indexOf(prefix);
    if (start === -1) continue;
    // Læs rute-objekterne ét ad gangen fra listens start, og stop når listen slutter.
    const re = /\{"route":\[([^\]]*)\],"play":(\d+),"rank":(\d+)\},?/y;
    re.lastIndex = start + prefix.length;
    const routes = [];
    let m;
    while ((m = re.exec(text))) routes.push({ route: JSON.parse(`[${m[1]}]`), play: Number(m[2]) });
    const total = routes.reduce((s, r) => s + r.play, 0) || 1;
    if (routes.length) out[side] = routes.slice(0, 3).map((r) => ({ ...r, share: r.play / total }));
  }
  // Hvor de starter (procent pr. side): "rate":{"team_key":"BLUE","blue":52,"red":17,"raptors":29}
  const rate = {};
  for (const m of text.matchAll(/"rate":\{"team_key":"(BLUE|RED)","blue":(\d+),"red":(\d+),"raptors":(\d+)\}/g)) {
    rate[m[1]] = { blue: Number(m[2]), red: Number(m[3]), raptors: Number(m[4]) };
  }
  if (Object.keys(rate).length) out.rate = rate;
  return out.BLUE || out.RED ? out : null;
}

function fetchJungleRoutes(championKey) {
  const champ = dd.champions[championKey];
  if (!champ) return Promise.resolve(null);
  return cachedJson(`jungle_${championKey}`, async () => {
    const res = await fetch(`${OPGG_WEB}/lol/champions/${champ.id.toLowerCase()}/jungle-paths/jungle`, {
      headers: { 'User-Agent': 'Mozilla/5.0 lol-rune-helper' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Jungle-ruter: ${res.status}`);
    // Ingen ruter på siden: fejl (caches ikke), så der prøves igen senere.
    const routes = parseJungleRoutes(await res.text());
    if (!routes) throw Object.assign(new Error(`Jungle-ruter: ingen ruter fundet for ${champ.name}`), { empty: true });
    return routes;
  });
}

function ensureJungleRoutes(championKey, position) {
  // Ikke jungle (fx rolle skiftet i vinduet): fjern et gammelt rutekort.
  if (position !== 'JUNGLE') {
    if (app.jungleKey || app.jungle) { app.jungle = null; app.jungleKey = null; broadcast(); }
    return;
  }
  if (app.jungleKey === championKey) return;
  if (app.jungleRetry?.key === championKey && Date.now() < app.jungleRetry.at) return;
  app.jungleKey = championKey;
  app.jungle = null;
  fetchJungleRoutes(championKey)
    .then((routes) => {
      if (app.jungleKey !== championKey) return;
      app.jungle = routes;
      app.jungleRetry = null;
      broadcast();
    })
    .catch((err) => {
      log(`  ${err.message}`);
      // Prøv igen senere i samme kamp: om 1 min ved netværksfejl, 10 min hvis siden ingen ruter havde.
      if (app.jungleKey === championKey) app.jungleKey = null;
      app.jungleRetry = { key: championKey, at: Date.now() + (err.empty ? 600000 : 60000) };
    });
}

// ---------- Gameplan mod din lane-modstander ----------
// Fast del: OP.GG's matchup-guide + tal. Live del: fakta om jer to (level, items, core) + valg fra dit build.
// Bevidst ingen "engage nu"-råd: Riot tillader ikke apps der træffer beslutninger for spilleren.

const PLAY_STYLE = { defensive: 'Defensiv', aggressive: 'Aggressiv', even: 'Jævn' };
const genitive = (name) => (/[sxz]$/i.test(name) ? `${name}'` : `${name}s`);
// Kun færdige items (ikke støvler) tæller som core-pladser: Dark Seal (1082) bliver til Mejai's og er ikke en plads.
const coreIdsOf = (ids) => [...new Set((ids || []).map(String).filter((id) => isCompleted(dd.items[id]) && !isBoots(dd.items[id])))];
// Samme core-valg som item settet (recommend bruger rankOptions med din buildChoice).
const coreOf = (build, cfg = app.cfg) => coreIdsOf(rankOptions(build?.core_items, cfg)[0]?.ids);

// Hvem skalerer bedst: hvor meget win rate ændrer sig fra korte (<25 min) til lange (40+ min) kampe.
// OP.GG sender rate: null uden data (fx off-role) - så siges intet.
function scalingNote(myBuild, oppBuild, oppName) {
  const curve = (b) => {
    const g = b?.game_lengths || [];
    if (g.length < 2) return null;
    const first = g[0].rate;
    const last = g[g.length - 1].rate;
    return typeof first === 'number' && typeof last === 'number' ? last - first : null;
  };
  const mine = curve(myBuild);
  const his = curve(oppBuild);
  if (mine == null || his == null) return null;
  if (mine - his > 0.02) return `Du skalerer bedre end ${oppName} (din win rate stiger mere fra kampe under 25 min til kampe over 40 min).`;
  if (his - mine > 0.02) return `${oppName} skalerer bedre end dig (${genitive(oppName)} win rate stiger mere fra kampe under 25 min til kampe over 40 min).`;
  return 'I skalerer nogenlunde ens (win rate i kampe under 25 min mod over 40 min).';
}

// Win rate pr. kamplængde ("59% under 25 min, 48% 25-30 min, ...") fra OP.GG's game_lengths.
function lengthCurve(build) {
  const g = (build?.game_lengths || []).filter((x) => typeof x.rate === 'number');
  if (g.length < 2) return null;
  const label = (x, i) => (i === 0 ? `under ${g[1].game_length} min`
    : i === g.length - 1 ? `${x.game_length}+ min` : `${x.game_length}-${g[i + 1].game_length} min`);
  return { text: g.map((x, i) => `${pct(x.rate)} ${label(x, i)}`).join(', '), drop: g[g.length - 1].rate - g[0].rate };
}

// Matchup-valg (spells, skill-max, start) der afviger fra det generelle - kun med nok kampe bag.
function matchupChoices(myBuild, matchupBuild, oppName) {
  const out = [];
  const top = (list) => [...(list || [])].sort((a, b) => b.play - a.play)[0];
  const same = (a, b) => a && b && [...a].map(String).sort().join() === [...b].map(String).sort().join();
  const gSpells = top(myBuild?.summoner_spells);
  const mSpells = top(matchupBuild?.summoner_spells);
  if (mSpells?.play >= MATCHUP_MIN_GAMES && gSpells && !same(mSpells.ids, gSpells.ids)) {
    out.push(`Mod ${oppName} tager flest ${mSpells.ids.map(spellName).join(' + ')} (generelt ${gSpells.ids.map(spellName).join(' + ')})`);
  }
  const gMax = top(myBuild?.skill_masteries);
  const mMax = top(matchupBuild?.skill_masteries);
  if (mMax?.play >= MATCHUP_MIN_GAMES && gMax && mMax.ids.join() !== gMax.ids.join()) {
    out.push(`Mod ${oppName} maxer flest ${mMax.ids.join(' > ')} (generelt ${gMax.ids.join(' > ')})`);
  } else if (gMax) out.push(`Max ${gMax.ids.join(' > ')}`);
  return out;
}

// Champion-specifikke noter pr. fase (fra docs/research-tryndamere-evelynn.md, patch 26.20).
const CHAMPION_COACH = {
  Tryndamere: {
    lane: ['Level 2-3 er dit første spike: E + Q giver et stærkt all-in.'],
    spike: ['Level 6: R (Undying Rage) gør dig udødelig i 5 sekunder - det er dit dive-vindue.', 'Ravenous Hydra giver waveclear og gør dig stærk til split-push.'],
    mid: ['Med Hydra kan du presse en sidelane og trække modstandere væk fra objectives.'],
    late: ['Infinity Edge er dit crit-spike.', 'Mod armor-stackere: se armor pen-forslagene (fx Lord Dominik\'s Regards / Mortal Reminder).'],
  },
  Evelynn: {
    lane: ['Du er svag før level 6: farm og undgå kampe.', 'Camps spawner 0:55 (Gromp/Krugs 1:07, scuttle 2:55). Full clear ca. 3:07, og recall til Dark Seal er standard.'],
    spike: ['Level 6: camouflage + R - gank isolerede mål.', 'Control Wards, Oracle Lens og Scryer\'s Bloom afslører dig (under kampen står det under "Modstanderne").'],
    mid: ['Lanes hvor din holdkammerat er foran (se "Gank-overblik"), er de nemmeste ganks.'],
    late: [],
  },
};

// Matchup-plan i faser ud fra OP.GG-data: laning, første power spikes, midgame og lategame.
function planPhases({ myBuild, oppBuild, matchupBuild, oppName, laneAdvantage, soloKill, playStyle, scaling, myCore, oppCore, position, myId }) {
  const gold = (id) => dd.items[id]?.gold || 0;
  const g = (x) => x.toLocaleString('da-DK');
  const jungle = position === 'JUNGLE';
  const lane = [];
  if (laneAdvantage === 'dig') lane.push(jungle ? `Du er stærkest tidligt (OP.GG) - du kan presse ${oppName} i starten.` : `Du har lane-fordel (OP.GG): du kan presse ${oppName} og tage trades i lanen.`);
  else if (laneAdvantage === 'jævn') lane.push(jungle ? 'Starten er jævn (OP.GG) - første items og level 6 afgør meget.' : 'Lanen er jævn (OP.GG) - første items og level 6 afgør meget.');
  else if (laneAdvantage) lane.push(jungle ? `${oppName} er stærkest tidligt (OP.GG) - undgå ham i starten, og spil efter dine spikes.` : `${oppName} har lane-fordel (OP.GG): spil sikkert, farm og vent på dine power spikes.`);
  if (soloKill === 'dig') lane.push(`Du får flest solo kills i matchuppet.`);
  else if (soloKill && soloKill !== 'jævn') lane.push(`${oppName} får flest solo kills - pas på 1 mod 1, når han er foran.`);
  if (playStyle) lane.push(`Anbefalet spillestil: ${playStyle.toLowerCase()}.`);
  const mStart = matchupBuild?.starter_items?.[0];
  const start = mStart?.play >= MATCHUP_MIN_GAMES ? mStart : rankOptions(myBuild?.starter_items, { buildChoice: 'popular' })[0];
  if (start) {
    const counts = new Map();
    for (const id of start.ids.map(String)) counts.set(id, (counts.get(id) || 0) + 1);
    lane.push(`Start${start === mStart ? ` mod ${oppName}` : ''}: ${[...counts].map(([id, n]) => (n > 1 ? `${n}x ` : '') + itemName(id)).join(' + ')}`);
  }
  lane.push(...matchupChoices(myBuild, matchupBuild, oppName));

  const spike = [];
  if (myCore[0]) spike.push(`Dit første power spike: ${itemName(myCore[0])} (${g(gold(myCore[0]))} g)`);
  if (oppCore[0]) spike.push(`${genitive(oppName)} første item er typisk ${itemName(oppCore[0])} (${g(gold(oppCore[0]))} g)`);
  if (myCore[0] && oppCore[0]) {
    const d = gold(myCore[0]) - gold(oppCore[0]);
    if (d >= 300) spike.push(`Hans første item er ${g(d)} g billigere - han når ofte først til sit spike.`);
    else if (d <= -300) spike.push(`Dit første item er ${g(-d)} g billigere - du når ofte først til dit spike.`);
  }
  spike.push(`Level 6 ændrer trades: se under "Lige nu", hvem der har ult først.`);

  const mid = [];
  const boost = [...matchupItemBoost(myBuild, matchupBuild)].sort((a, b) => b[1].ratio - a[1].ratio).slice(0, 2);
  for (const [id, b] of boost) mid.push(`Mod ${oppName} bygges ${itemName(id)} oftere (${pct(b.vs)} mod ${pct(b.general)} generelt)`);
  if (oppCore.length > 1) mid.push(`${genitive(oppName)} typiske build: ${oppCore.map(itemName).join(' > ')}`);
  if (myCore.length > 1) mid.push(`Dit core build: ${myCore.map(itemName).join(' > ')}`);

  const late = [];
  if (scaling) late.push(scaling);
  const curve = lengthCurve(myBuild);
  if (curve) {
    late.push(`Din win rate efter kamplængde: ${curve.text}`);
    if (curve.drop <= -0.03) late.push('Din win rate falder i lange kampe - brug dine fordele til objectives og tårne tidligt.');
    else if (curve.drop >= 0.03) late.push('Din win rate stiger i lange kampe - kommer du bagud, så farm og spil efter lategame.');
  }
  const own = CHAMPION_COACH[myId];
  if (own) for (const [k, list] of [['lane', lane], ['spike', spike], ['mid', mid], ['late', late]]) list.unshift(...own[k]);
  return [
    { key: 'lane', title: jungle ? 'Start (level 1-5)' : 'Laning (level 1-5)', lines: lane },
    { key: 'spike', title: 'Level 6 og første item', lines: spike },
    { key: 'mid', title: 'Midgame (ca. 14-25 min)', lines: mid },
    { key: 'late', title: 'Lategame (25+ min)', lines: late },
  ].filter((p) => p.lines.length);
}

// Hvilken fase kampen er i: laning til første færdige item/level 6, midgame til 25 min, så lategame.
function phaseNow(L, plan) {
  if (L.gameTime >= 25 * 60) return 'late';
  if (L.gameTime >= 14 * 60) return 'mid';
  const items = L.me.itemIds.filter((id) => isCompleted(dd.items[id]) && !isBoots(dd.items[id])).length;
  return L.me.level >= 6 || items || plan?.duels?.length ? 'spike' : 'lane';
}

// Styrkeforhold mellem dig og din lane-modstander: level, ult, færdige items og item-guld (står alt på TAB).
const completedCount = (p) => p.itemIds.filter((id) => isCompleted(dd.items[id]) && !isBoots(dd.items[id])).length;
// aName: navn på den første spiller (standard "dig").
function balanceOf(me, opp, name, aName = null) {
  const g = (x) => Math.round(x).toLocaleString('da-DK');
  let score = 0;
  const why = [];
  const lv = me.level - opp.level;
  if (lv) { score += lv; why.push(`${Math.abs(lv)} level ${lv > 0 ? 'foran' : 'bagud'}`); }
  const ultMe = me.level >= 6;
  const ultHim = opp.level >= 6;
  if (ultMe !== ultHim) { score += ultMe ? 1.5 : -1.5; why.push(ultMe ? (aName ? `${aName} har ult` : 'du har ult') : `${name} har ult`); }
  const items = completedCount(me) - completedCount(opp);
  if (items) { score += items * 1.5; why.push(`${Math.abs(items)} ${Math.abs(items) > 1 ? 'færdige items' : 'færdigt item'} ${items > 0 ? 'foran' : 'bagud'}`); }
  const gold = me.itemGold - opp.itemGold;
  if (Math.abs(gold) >= 500) { score += gold / 1000; why.push(`${g(Math.abs(gold))} g item-guld ${gold > 0 ? 'foran' : 'bagud'}`); }
  const side = score >= 1.5 ? 'me' : score <= -1.5 ? 'opp' : 'even';
  return { side, label: side === 'me' ? `Fordel ${aName || 'dig'}` : side === 'opp' ? `Fordel ${name}` : 'Jævnt', why, score: Math.round(score * 10) / 10 };
}

// Kort styrke-kontekst til en duel: "level 6 mod 7, 800 g bagud i items".
function duelContext(me, opp) {
  const d = me.itemGold - opp.itemGold;
  const items = Math.abs(d) < 300 ? 'lige i items' : `${Math.round(Math.abs(d)).toLocaleString('da-DK')} g ${d > 0 ? 'foran' : 'bagud'} i items`;
  return `level ${me.level} mod ${opp.level}, ${items}`;
}

async function buildPlan(myKey, oppKey, position, myBuild) {
  const oppName = dd.champions[oppKey]?.name || '?';
  const myName = dd.champions[myKey]?.name || '';
  const validPos = POSITIONS.includes(position);
  const [guide, oppBuild, matchupBuild] = await Promise.all([
    fetchMatchupGuide(myKey, oppKey, position).catch((e) => { log(`  ${e.message}`); return null; }),
    validPos ? fetchBuild(app.cfg.region, 'ranked', oppKey, position).catch(() => null) : null,
    // Dit build i kampe mod netop denne champion (bruges til item-forslag under kampen).
    validPos ? fetchBuild(app.cfg.region, 'ranked', myKey, position, oppKey).catch(() => null) : null,
  ]);
  const who = (x) => {
    if (!x) return null;
    if (x === 'EVEN') return 'jævn';
    if (x.toLowerCase() === oppName.toLowerCase()) return oppName;
    if (x.toLowerCase() === myName.toLowerCase()) return 'dig';
    return x;
  };
  // Guidens domme (lane-fordel, solo kills, spillestil) kun med nok kampe bag - tippet vises altid.
  const fewGames = typeof guide?.games === 'number' && guide.games < MATCHUP_MIN_GAMES;
  if (fewGames) log(`  Matchup-guide mod ${oppName}: kun ${guide.games} kampe - lane-fordel og spillestil vises ikke.`);
  const laneAdvantage = fewGames ? null : who(guide?.laneAdvantage);
  const soloKill = fewGames ? null : who(guide?.soloKill);
  const playStyle = !fewGames && guide?.playStyle ? PLAY_STYLE[guide.playStyle] || guide.playStyle : null;
  const scaling = scalingNote(myBuild, oppBuild, oppName);
  const myCore = coreOf(myBuild);
  const oppCore = coreOf(oppBuild, { buildChoice: 'popular' }); // hans mest spillede core
  return {
    key: `${myKey}_${oppKey}_${position}`,
    guideGames: guide?.games ?? null,
    myKey: String(myKey),
    oppKey: String(oppKey),
    opponent: oppName,
    position,
    stats: matchupStats(myBuild, oppKey),
    laneAdvantage,
    soloKill,
    playStyle,
    tip: guide?.tip || null,
    scaling,
    myCore,
    oppCore,
    phases: planPhases({ myBuild, oppBuild, matchupBuild, oppName, laneAdvantage, soloKill, playStyle, scaling, myCore, oppCore, position, myId: dd.champions[myKey]?.id }),
    // Items du faktisk bygger: core + sene items som mindst 2% køber (ikke fx Randuin's på en mage).
    matchupBuild,
    myPool: [
      ...(myBuild?.core_items || []).flatMap((x) => x.ids.map(String)),
      ...(myBuild?.last_items || []).filter((x) => (x.pick_rate || 0) >= 0.02).map((x) => String(x.ids[0])),
    ],
    seen: null, // modstanderens items/level ved sidste tjek
    log: [],    // ændringer under kampen
    duels: [],  // kills mellem dig og lane-modstanderen: { t, won, solo, context }
    events: new Set(), // behandlede kill-feed EventID'er
    balance: null, // { side, pending, spokenAt } - til stemmen når styrkeforholdet skifter
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

// Modstanderens nye færdige items -> ændringslog i hovedvinduet (passiv TAB-info).
// Bevidst ingen stemme/overlay-besked: Riot/Overwolf forbyder notifikationer om modstanderens power spikes.
function trackOpponent(L, events = []) {
  const plan = app.plan;
  const opp = L.matchup?.player;
  if (!plan || !opp || String(opp.champ?.key) !== plan.oppKey) return;
  const completed = opp.itemIds.filter((id) => isCompleted(dd.items[id]));
  const add = (kind, text, voice = true) => {
    plan.log.unshift({ t: L.gameTime, text });
    plan.log.length = Math.min(plan.log.length, 12);
    if (voice && app.cfg.enemyAlerts && app.cfg.voice) speak(kind, text);
  };
  // Dueller: kills mellem dig og lane-modstanderen i kill-feedet. Kun nye kills (startes programmet
  // midt i kampen, kendes styrkeforholdet ikke for de gamle).
  const isMe = (n) => n && (n === L.me.key || n === L.me.name);
  const isOpp = (n) => n && (n === opp.key || n === opp.name);
  for (const e of events) {
    if (e.EventName !== 'ChampionKill' || plan.events.has(e.EventID)) continue;
    plan.events.add(e.EventID);
    if (L.gameTime - (e.EventTime || 0) > 15) continue;
    const won = isMe(e.KillerName) && isOpp(e.VictimName);
    if (!won && !(isOpp(e.KillerName) && isMe(e.VictimName))) continue;
    const solo = !(e.Assisters || []).length;
    const context = duelContext(L.me, opp);
    plan.duels.push({ t: e.EventTime, won, solo, context });
    add('duel', `${won ? `Du dræbte ${plan.opponent}` : `Du døde til ${plan.opponent}`}${solo ? '' : ' (med hjælp)'} - ${context}`, false);
  }
  // Styrkeforhold: stemmen siger det, når det har skiftet i 2 tjek i træk (ikke ved små udsving),
  // højst hvert 45. sekund og aldrig om "jævnt".
  const bal = balanceOf(L.me, opp, plan.opponent);
  if (!plan.balance) plan.balance = { side: bal.side, pending: null, spokenAt: -Infinity };
  else if (bal.side === plan.balance.side) plan.balance.pending = null;
  else if (plan.balance.pending !== bal.side) plan.balance.pending = bal.side;
  else {
    plan.balance.side = bal.side;
    plan.balance.pending = null;
    if (bal.side !== 'even' && L.gameTime - plan.balance.spokenAt >= 45) {
      plan.balance.spokenAt = L.gameTime;
      add('balance', `${bal.side === 'me' ? `Fordel dig mod ${plan.opponent}` : bal.label}: ${bal.why.slice(0, 2).join(', ')}`);
    }
  }
  if (plan.seen) {
    const before = [...plan.seen.items];
    for (const id of completed) {
      const i = before.indexOf(id);
      if (i !== -1) before.splice(i, 1);
      else add('opp-item', `${plan.opponent} har købt ${itemName(id)}`);
    }
    if (app.cfg.enemyAlerts && plan.seen.level < 6 && opp.level >= 6) add('opp-level', `${plan.opponent} er level 6`);
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
  // Levels (står på TAB); med enemyAlerts også hvem der har ult.
  let lvl = `Level: dig ${me.level}, ${n} ${opp.level}`;
  if (app.cfg.enemyAlerts) {
    if (me.level >= 6 && opp.level < 6) lvl += ` - du har ult, ${n} har ikke endnu`;
    else if (opp.level >= 6 && me.level < 6) lvl += ` - ${n} har ult, du har ikke endnu`;
  }
  lines.push(lvl);
  const diff = me.itemGold - opp.itemGold;
  lines.push(`Items: dig ${num(me.itemGold)} g, ${n} ${num(opp.itemGold)} g (${diff >= 0 ? '+' : ''}${num(diff)} til dig)`);
  lines.push(`KDA: dig ${me.kills}/${me.deaths}/${me.assists}, ${n} ${opp.kills}/${opp.deaths}/${opp.assists}`);
  const progress = (core, items) => core.filter((id) => items.includes(id));
  const mine = progress(plan.myCore, me.itemIds);
  const his = progress(plan.oppCore, opp.itemIds);
  if (plan.myCore.length) lines.push(`Dit core build: ${mine.length}/${plan.myCore.length}${mine.length ? ` (${mine.map(itemName).join(', ')})` : ''}`);
  if (plan.oppCore.length) lines.push(`${genitive(n)} typiske core: ${his.length}/${plan.oppCore.length}${his.length ? ` (${his.map(itemName).join(', ')})` : ''}`);
  // Items i dit eget build (ikke ejet) med et bestemt tag - som valg, ikke ordre.
  const passives = ownedPassivesOf(me.itemIds); // fx ingen Profane Hydra når du har Ravenous Hydra (begge "Cleave")
  const options = (pred) => [...new Set(plan.myPool)]
    .filter((id) => !me.itemIds.includes(id) && isCompleted(dd.items[id]) && !dd.items[id].passives.some((p) => passives.has(p)) && pred(dd.items[id]))
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

// Spiltype -> OP.GG-data. Summoner's Rift-typer bruger ranked; ARAM og URF har egne data.
// Ukendte typer: ranked på Summoner's Rift (map 11), ellers springes de over (null).
const SR_MODES = ['CLASSIC', 'SWIFTPLAY', 'PRACTICETOOL', 'TUTORIAL'];
function buildMode(gameMode, mapId) {
  if (!gameMode || SR_MODES.includes(gameMode)) return 'ranked';
  if (gameMode === 'ARAM' || mapId === 12) return 'aram';
  if (gameMode === 'URF' || gameMode === 'ARURF') return 'urf';
  return mapId === 11 ? 'ranked' : null;
}

// Finder build for championen. Uden rolle (blind pick) bruges championens hovedrolle.
async function getBuild(cfg, championId, position, gameMode, mapId) {
  const mode = buildMode(gameMode, mapId);
  if (mode === 'aram') return { build: await fetchBuild(cfg.region, 'aram', championId, 'none'), position: 'ARAM' };
  if (mode === 'urf') return { build: await fetchBuild(cfg.region, 'urf', championId, 'none'), position: 'URF' };
  if (!mode) throw new Error(`Spiltypen ${gameMode} har ingen builds hos OP.GG`);
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
    // Kun færdige items (OP.GG's lister har også komponenter som B. F. Sword og Executioner's Calling).
    for (const id of x.ids) if (!pool.includes(id) && !used.has(id) && isCompleted(dd.items[id]) && !isBoots(dd.items[id])) pool.push(id);
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

function recommend(build, cfg, enemyIds, matchup, mapNumber = 11) {
  const enemy = cfg.adaptToEnemies && enemyIds.length ? analyzeEnemies(enemyIds) : null;
  const blocks = [];
  const notes = [];
  const used = new Set();
  const addUsed = (ids) => ids.forEach((id) => used.add(id));

  const skillOrder = build.skills?.[0]?.order || [];
  const skills = { start: skillOrder.slice(0, 3), max: build.skill_masteries?.[0]?.ids || [] };

  const vsName = matchup && (dd.champions[matchup.id]?.name || 'modstanderen');
  if (matchup?.stats) notes.push(`Mod ${vsName}: ${pct(matchup.stats.winRate)} WR i ${matchup.stats.games.toLocaleString('da-DK')} kampe${matchup.stats.games < MATCHUP_MIN_GAMES ? ' (få kampe - usikkert tal)' : ''}`);
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
  // Core i kampe mod din lane-modstander (samme valg-regel), når der er nok kampe og den er en anden.
  const mCore = rankOptions(matchup?.build?.core_items, cfg).find((c) => c.play >= MATCHUP_MIN_GAMES);
  if (mCore && (!core || mCore.ids.join() !== core.ids.join())) {
    blocks.push(itemBlock(`Core mod ${vsName} (${pct(mCore.win / mCore.play)} WR i ${mCore.play.toLocaleString('da-DK')} kampe)`, mCore.ids));
    addUsed(mCore.ids);
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
  const late = (build.last_items || []).map((x) => x.ids[0]).filter((id) => !used.has(id) && isCompleted(dd.items[id])).slice(0, 8);
  if (late.length) blocks.push(itemBlock('Situationelle items', late));
  // Control Ward kan ikke købes i ARAM (map 12).
  blocks.push(itemBlock('Forbrug', [2003, 2055].filter((id) => dd.items[id]?.maps[mapNumber] !== false)));

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
    // Slet kun en af dine sider, når der er bevis for at siderne er fulde: klientens optælling
    // eller en fejltekst om max antal sider. Ellers skyldes fejlen noget andet.
    const inventory = await lcu(client, 'GET', '/lol-perks/v1/inventory').catch(() => null);
    const full = typeof inventory?.ownedPageCount === 'number'
      ? editable.length >= inventory.ownedPageCount
      : /max|maximum|limit|full|too many/i.test(e.message);
    if (!full) throw e;
    // Erstat helst en side du ikke bruger lige nu.
    const victim = editable.filter((p) => !p.current).pop() || editable.find((p) => p.current);
    if (!victim) throw e;
    log(`  Alle rune-sider er fulde - erstatter siden "${victim.name}" (sker kun første gang).`);
    await lcu(client, 'DELETE', `/lol-perks/v1/pages/${victim.id}`);
    try {
      await lcu(client, 'POST', '/lol-perks/v1/pages', page);
    } catch (e2) {
      // Auto-siden blev afvist alligevel: læg din side tilbage, så intet går tabt.
      const { name, primaryStyleId, subStyleId, selectedPerkIds } = victim;
      const restored = await lcu(client, 'POST', '/lol-perks/v1/pages', { name, primaryStyleId, subStyleId, selectedPerkIds, current: Boolean(victim.current) })
        .then(() => true, () => false);
      throw new Error(`Auto-siden kunne ikke oprettes (${e2.message}). Din side "${victim.name}" ${restored ? 'er lagt tilbage' : 'kunne ikke lægges tilbage'}.`);
    }
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
  for (const g of srGames()) if (g.championId) played.set(g.championId, (played.get(g.championId) || 0) + 1);
  for (const [id] of [...played].sort((a, b) => b[1] - a[1]).slice(0, 8)) if (!ids.includes(id)) ids.push(id);
  const rates = await roleRates(cfg, ids);
  return ids.filter((id) => (rates[id]?.[position] || 0) >= 0.2).slice(0, 6);
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
  if (!POSITIONS.includes(position)) { app.draft = null; app.draftStatus = 'unsupported'; return; }
  const actions = (session.actions || []).flat();
  const unavailable = [
    ...actions.filter((a) => a.type === 'ban' && a.completed && a.championId).map((a) => a.championId),
    ...[...(session.myTeam || []), ...(session.theirTeam || [])].map((m) => m.championId).filter((id) => id > 0),
    // Holdkammeraters erklærede picks (ikke din egen hover) skal heller ikke foreslås som ban.
    ...(session.myTeam || []).filter((m) => m.cellId !== session.localPlayerCellId).map((m) => m.championPickIntent).filter((id) => id > 0),
  ];
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0);
  const myBanTurn = actions.some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'ban' && a.isInProgress);
  const key = `${position}|${enemyIds.sort().join(',')}|${[...new Set(unavailable)].sort().join(',')}`;
  const banChanged = app.draftBanTurn !== myBanTurn;
  app.draftBanTurn = myBanTurn;
  if (app.draft) app.draft.myBanTurn = myBanTurn;
  if (key === app.draftKey) {
    if (banChanged && app.draft) broadcast(); // din tur til at banne: vis det med det samme
    return;
  }
  app.draftKey = key;
  app.draftStatus = 'loading';
  analyzeDraft(app.cfg, position, enemyIds, unavailable)
    .then((d) => {
      if (app.draftKey !== key) return;
      app.draft = { ...d, myBanTurn: app.draftBanTurn };
      app.draftStatus = null;
      broadcast();
    })
    .catch((e) => {
      log(`Draft-hjælp fejlede: ${e.message}`);
      if (app.draftKey === key) { app.draftStatus = 'error'; broadcast(); }
    });
}

// ---------- Kampoversigt og historik ----------

const HISTORY_FILE = process.env.LOL_HELPER_HISTORY || path.join(APP_DIR, 'history.json');
// Statistik og champion-pulje bygger kun på Summoner's Rift-kampe (ældre poster uden spiltype tæller med).
const srGames = () => history.games.filter((g) => !g.gameMode || ['CLASSIC', 'SWIFTPLAY'].includes(g.gameMode));
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
    app.game = { championKey: L.me.champ?.key, seen: new Map(), adapted: new Set(), buys: [], lastItems: [...L.me.itemIds], result: null, deaths: [], events: new Set() };
  }
  const g = app.game;
  // Dine dødsfald fra kill-feedet: hvem, med hvor mange hjælpere, og styrkeforholdet mod drabsmanden.
  for (const e of data.events?.Events || []) {
    if (e.EventName !== 'ChampionKill' || g.events.has(e.EventID)) continue;
    g.events.add(e.EventID);
    if (L.gameTime - (e.EventTime || 0) > 15) continue; // gamle kills (programmet startet midt i kampen)
    if (e.VictimName !== L.me.key && e.VictimName !== L.me.name) continue;
    const killer = L.enemies.find((p) => e.KillerName && (p.key === e.KillerName || p.name === e.KillerName));
    const what = killer ? killer.champ?.name || killer.name : /turret/i.test(e.KillerName || '') ? 'tårn' : /minion/i.test(e.KillerName || '') ? 'minions' : 'andet';
    g.deaths.push({ t: e.EventTime, killer: what, helpers: (e.Assisters || []).length, context: killer ? duelContext(L.me, killer) : null });
  }
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
  g.gameMode = data.gameData?.gameMode || g.gameMode || null;
  g.mapNumber = data.gameData?.mapNumber || g.mapNumber || null;
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
  app.jungle = null;
  app.jungleKey = null;
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
// Første færdige item der ikke er støvler (tid i sek.), fra en kamps køb.
const firstItemTime = (game) => (game.buys || []).find((b) => !isBoots(dd.items[b.id]))?.t ?? null;

// "Læring" efter kampen: sammenligning med dine egne seneste kampe på samme champion + mønstre i dødsfald/dueller.
function lessonsFor(s, prev) {
  const out = [];
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const dec = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  if (prev.length >= 3) {
    const cs = avg(prev.map((x) => x.csPerMin || 0));
    out.push(`CS/min ${dec(s.csPerMin)} - dit snit med ${s.champion} er ${dec(cs)} (${prev.length} kampe)${s.csPerMin >= cs + 0.5 ? ', bedre end normalt' : s.csPerMin <= cs - 0.5 ? ', under normalt' : ''}`);
    const d = avg(prev.map((x) => x.deaths || 0));
    out.push(`${s.deaths} dødsfald - dit snit er ${dec(d)}${s.deaths >= d + 2 ? ', flere end normalt' : s.deaths <= d - 2 ? ', færre end normalt' : ''}`);
    const times = prev.map(firstItemTime).filter((t) => t != null);
    const mine = firstItemTime(s);
    if (mine != null && times.length >= 3) {
      const a = avg(times);
      out.push(`Første færdige item ${mmss(mine)} - dit snit er ${mmss(a)}${mine <= a - 60 ? ', hurtigere end normalt' : mine >= a + 60 ? ', langsommere end normalt' : ''}`);
    }
  } else out.push(`Sammenligning med dine egne kampe kommer efter 3 kampe med ${s.champion} (${prev.length} indtil nu).`);
  const early = (s.deathLog || []).filter((d) => d.t < 14 * 60);
  if (early.length >= 2) {
    const by = new Map();
    for (const d of early) by.set(d.killer, (by.get(d.killer) || 0) + 1);
    out.push(`${early.length} dødsfald før 14 min (${[...by].map(([k, n]) => (n > 1 ? `${n}x ` : '') + k).join(', ')})`);
  }
  const ganged = (s.deathLog || []).filter((d) => d.helpers >= 2).length;
  if (ganged >= 2) out.push(`${ganged} af dine dødsfald var mod 3 eller flere`);
  const lost = (s.duels || []).filter((d) => !d.won);
  if (lost.length && lost.length > (s.duels || []).length - lost.length) {
    const behind = lost.filter((d) => /bagud/.test(d.context)).length;
    out.push(`Du tabte ${lost.length} af ${s.duels.length} dueller mod ${s.matchup?.champion}` +
      (behind ? ` - ${behind} af dem mens du var bagud i items` : ''));
  }
  return out;
}

function finishGame() {
  const g = app.game;
  const plan = app.plan;
  app.game = null;
  clearPick();
  if (!g?.last || g.last.gameTime < 300) return; // remakes og afbrudte kampe tæller ikke
  if (['PRACTICETOOL', 'TUTORIAL'].includes(g.gameMode)) return log('Træningskamp - gemmes ikke i historikken.');
  const L = g.last;
  const minutes = L.gameTime / 60;
  const summary = {
    date: new Date().toISOString(),
    championId: Number(L.me.champ?.key) || null,
    champion: L.me.champ?.name || '?',
    gameMode: g.gameMode || null,
    mapNumber: g.mapNumber || null,
    account: L.me.key || null,
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
  // Dueller mod lane-modstanderen (kun hvis gameplanen var mod ham) + styrkeforholdet ved slut.
  const opp = L.matchup?.player;
  if (plan && opp && String(opp.champ?.key) === plan.oppKey) {
    summary.duels = plan.duels.map((d) => ({ t: d.t, won: d.won, solo: d.solo, context: d.context }));
    summary.balanceEnd = balanceOf(L.me, opp, plan.opponent).label;
  }
  summary.deathLog = g.deaths;
  summary.lessons = lessonsFor(summary, srGames().filter((x) => x.championId === summary.championId).slice(0, 10));
  history.games.unshift(summary);
  history.games.length = Math.min(history.games.length, 100);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1)); } catch (e) { log(`Kunne ikke gemme historik: ${e.message}`); }
  log(`Kampoversigt: ${summary.champion} ${summary.kills}/${summary.deaths}/${summary.assists}, ${String(summary.csPerMin).replace('.', ',')} CS/min` +
    (summary.followed != null ? `, ${pct(summary.followed)} af dine køb var blandt forslagene` : '') +
    (summary.duels?.length ? `, dueller mod ${summary.matchup.champion}: ${summary.duels.filter((d) => d.won).length}-${summary.duels.filter((d) => !d.won).length}` : ''));
}

// ---------- Opdateringer ----------

const VERSION = '1.16.0';
const UPDATE_URL = process.env.LOL_HELPER_UPDATE_URL || 'https://api.github.com/repos/tvg-invest/lol-rune-helper/releases/latest';
const UPDATE_ASSET = { win32: 'LoL-Rune-Helper.exe', darwin: 'LoL-Rune-Helper-mac' }[process.platform];

const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Status for opdateringstjek (vises i vinduet): hvornår og om det lykkedes.
const updateCheck = { at: 0, ok: null, error: null };

// Tjek igen hvis sidste tjek er mere end `maxAgeMs` gammelt (fx når vinduet åbnes).
function checkUpdateIfStale(maxAgeMs) {
  if (app.cfg.autoUpdate && Date.now() - updateCheck.at > maxAgeMs) checkUpdate();
}

async function checkUpdate() {
  updateCheck.at = Date.now();
  try {
    const rel = await getJson(UPDATE_URL);
    updateCheck.ok = true;
    updateCheck.error = null;
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => a.name === UPDATE_ASSET);
    if (latest && newer(latest, VERSION) && asset) {
      if (app.update?.version !== latest) log(`Ny version ${latest} er klar - klik "Opdater" i vinduet.`);
      // GitHub giver størrelse og sha256 ("digest": "sha256:...") for hvert asset - tjekkes før filen startes.
      app.update = {
        version: latest,
        url: asset.browser_download_url,
        size: Number(asset.size) || null,
        sha256: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase() || null,
        notes: String(rel.body || '').slice(0, 600),
      };
    }
  } catch (e) {
    // Ingen udgivelse eller intet net: prøv igen senere (vises i vinduet, så det ikke fejler i stilhed).
    updateCheck.ok = false;
    updateCheck.error = e.message;
  }
  broadcast();
}

// Kører programmet fra en zip-fil (Stifinder/7-Zip/WinRAR pakker det ud i en midlertidig mappe)?
// Så forsvinder config, opdatering og autostart, når den midlertidige mappe ryddes.
const RUNS_FROM_ZIP = /[\\/](Temp\d+_[^\\/]+\.zip|7zO[0-9a-f]+|Rar\$[^\\/]*)([\\/]|$)/i.test(APP_DIR);
const ZIP_HINT = 'Programmet kører inde fra zip-filen. Pak zip-filen ud først (højreklik -> Udpak alle) og start det derfra.';

let updateRunning = false;
const UPDATE_PIDFILE = path.join(APP_DIR, 'update.pid'); // den nye version skriver sit pid her (Windows: startes via cmd)

// Gem fejlen, så den kan ses i vinduet (opdateringslinjen), ikke kun i loggen.
function updateFailed(e) {
  if (app.update) app.update.error = e.message;
  updateCheck.ok = false;
  updateCheck.error = `Opdatering mislykkedes: ${e.message}`;
  log(`Fejl: opdatering mislykkedes: ${e.message}`);
}

async function applyUpdate() {
  if (!IS_SEA) throw new Error('Kører fra kildekode - hent ny kode i stedet');
  if (RUNS_FROM_ZIP) throw new Error(ZIP_HINT);
  if (!app.update?.url) throw new Error('Ingen opdatering');
  if (updateRunning) throw Object.assign(new Error('Opdateringen er allerede i gang'), { busy: true });
  updateRunning = true;
  if (app.update) app.update.error = null;
  try {
    await installUpdate();
  } finally {
    updateRunning = false;
  }
}

async function installUpdate() {
  const { version, url, size, sha256 } = app.update;
  log(`Henter version ${version}...`);
  const res = await fetch(url, { headers: { 'User-Agent': 'lol-rune-helper' }, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Download fejlede: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10 * 1024 * 1024) throw new Error('Filen er for lille - afbryder');
  if (size && buf.length !== size) throw new Error(`Filen har forkert størrelse (${buf.length} i stedet for ${size} bytes) - afbryder`);
  if (sha256) {
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error('Filens kontrolsum (sha256) passer ikke med udgivelsen - afbryder');
  }
  if (process.platform === 'win32' && buf.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error('Filen er ikke et Windows-program - afbryder');
  const exe = process.execPath;
  const exeNew = `${exe}.new`;
  const exeOld = `${exe}.old`;
  // En kørende fil kan omdøbes (også på Windows) men ikke overskrives: gem den gamle som .old.
  try {
    fs.writeFileSync(exeNew, buf, { mode: 0o755 });
    fs.rmSync(exeOld, { force: true });
    fs.renameSync(exe, exeOld);
    try {
      fs.renameSync(exeNew, exe);
    } catch (e) {
      fs.renameSync(exeOld, exe); // fx antivirus der holder den nye fil - behold den gamle
      throw e;
    }
  } finally {
    fs.rmSync(exeNew, { force: true }); // ingen 87 MB-rest, hvis et trin fejlede
  }
  const rollback = () => {
    // Slet aldrig programfilen, hvis der ikke er en backup at lægge tilbage.
    if (!fs.existsSync(exeOld)) {
      log(`Kunne ikke lægge den gamle version tilbage: ${path.basename(exeOld)} findes ikke - beholder den nuværende fil`);
      return;
    }
    try { fs.rmSync(exe, { force: true }); fs.renameSync(exeOld, exe); } catch (e) { log(`Kunne ikke lægge den gamle version tilbage: ${e.message}`); }
  };

  // Start den nye version. Den venter selv på, at porten bliver ledig.
  fs.rmSync(UPDATE_PIDFILE, { force: true });
  let child;
  if (process.platform === 'win32') {
    // Via "start", så den nye version får sit eget (minimerede) konsolvindue med loggen.
    // Et detached barn startet direkte har ingen konsol, og man kan hverken se eller lukke det.
    child = spawn('cmd.exe', ['/c', 'start', '', '/min', exe, '--updated'], { cwd: APP_DIR, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  } else {
    let logFd = 'ignore';
    try { logFd = fs.openSync(path.join(APP_DIR, 'lol-helper.log'), 'a'); } catch {}
    child = spawn(exe, ['--updated'], { cwd: APP_DIR, detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    if (typeof logFd === 'number') fs.closeSync(logFd);
  }
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!started) {
    rollback();
    throw new Error('Den nye version kunne ikke starte - beholder den gamle');
  }
  child.unref();
  let childExited = false;
  if (process.platform !== 'win32') child.once('exit', () => { childExited = true; });

  // Frigør porten og vent på, at den nye version svarer. Kommer den ikke op, rulles tilbage.
  log(`Starter version ${version}...`);
  const port = app.server.address().port;
  for (const client of sseClients) client.end();
  await new Promise((resolve) => { app.server.close(() => resolve()); app.server.closeAllConnections(); });
  const deadline = Date.now() + (Number(process.env.LOL_HELPER_UPDATE_WAIT_MS) || 90000);
  let healthy = false;
  while (!healthy && !childExited && Date.now() < deadline) {
    await sleep(500);
    try {
      const s = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
      // Sund = den nye version svarer OG har hentet Data Dragon (vinduet starter før data er hentet).
      healthy = Boolean(s && s.ddVersion && s.pid !== process.pid);
    } catch {}
  }
  if (healthy) {
    console.log(`[${time()}] Version ${version} kører - lukker den gamle.`);
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Den nye version kom ikke op: stop den, læg den gamle fil tilbage og fortsæt med den gamle.
  let newPid = process.platform === 'win32' ? null : child.pid;
  try { newPid = Number(fs.readFileSync(UPDATE_PIDFILE, 'utf8')) || newPid; } catch {}
  if (newPid && pidAlive(newPid)) {
    try { process.kill(newPid); } catch {}
    for (let i = 0; i < 20 && pidAlive(newPid); i++) await sleep(250); // Windows: filen er låst, til processen er væk
  }
  fs.rmSync(UPDATE_PIDFILE, { force: true });
  rollback();
  await new Promise((resolve) => {
    app.server.once('error', (e) => { log(`Kunne ikke åbne vinduet igen: ${e.message}`); resolve(); });
    app.server.listen(port, app.remote.enabled ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  claimInstanceLock(app.cfg.port, port);
  throw new Error(`version ${version} startede ikke korrekt${childExited ? ' (lukkede med det samme)' : ''} - beholder ${VERSION}`);
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

// Støvler: Boots-tag eller bygget af støvler (fx Gunmetal Greaves uden Boots-tag) - se loadStaticData.
const isBoots = (it) => Boolean(it && (it.boots || it.tags.includes('Boots')));
const isCompleted = (it) => it && !it.tags.includes('Consumable') && !it.tags.includes('Trinket') &&
  (isBoots(it) ? it.depth >= 2 : it.into.length === 0 && it.gold >= 1500);
// Navngivne passiver på dine færdige items: et item med samme passiv (fx to Hydra-items med "Cleave") virker ikke sammen.
const ownedPassivesOf = (ownedIds) => new Set(ownedIds.filter((id) => isCompleted(dd.items[id])).flatMap((id) => dd.items[id].passives));

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
    hasSmite: Object.values(p.summonerSpells || {}).some((s) => /smite/i.test(`${s?.rawDisplayName || ''} ${s?.displayName || ''}`)),
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
    // Kun færdige items: Doran's Blade/Bow, Vampiric Scepter og elixirer gør ikke en champion til healer.
    healing: HEALERS.has(champ?.id) || itemIds.some((id) => isCompleted(dd.items[id]) && dd.items[id].tags.some((t) => t === 'LifeSteal' || t === 'SpellVamp')),
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

// Starter-items man sælger for at få plads: Doran's Shield/Blade/Ring/Bow/Helm, Dark Seal, Cull.
const SELLABLE_STARTERS = new Set(['1054', '1055', '1056', '1082', '1083', '1086', '1120']);
const ELIXIR = { ad: '2140', ap: '2139', tank: '2138' }; // Wrath, Sorcery, Iron (500 g, fylder ingen plads)

// Hvor mange i buildet der køber hvert item (core-kombinationer lægges sammen, ellers højeste andel).
function buildPopularity(build) {
  const pop = new Map();
  for (const c of build?.core_items || []) for (const id of c.ids) pop.set(String(id), (pop.get(String(id)) || 0) + (c.pick_rate || 0));
  for (const x of build?.last_items || []) { const id = String(x.ids[0]); pop.set(id, Math.max(pop.get(id) || 0, x.pick_rate || 0)); }
  for (const x of build?.boots || []) { const id = String(x.ids[0]); pop.set(id, Math.max(pop.get(id) || 0, x.pick_rate || 0)); }
  return pop;
}

// Det der kan sælges for at få en ledig plads (billigste først): starter-items og forbrug i tasken
// (potions, Control Ward). Dark Seal tæller ikke med, når dit build går videre til Mejai's.
function sellableIds(ownedIds, pop) {
  const buildingMejais = (pop.get('3041') || 0) >= 0.05;
  return [...new Set(ownedIds)]
    .filter((id) => {
      const it = dd.items[id];
      if (!it || (id === '1082' && buildingMejais)) return false;
      return SELLABLE_STARTERS.has(id) || (it.tags.includes('Consumable') && !it.tags.includes('Trinket'));
    })
    .sort((a, b) => dd.items[a].sell - dd.items[b].sell);
}

// Fuldt build: 6 færdige items, eller 5 + en plads du ikke kan sælge dig ud af (fx jungle-pet).
const isFullBuild = (completed, slotsUsed, sellable) => completed >= 6 || (completed >= 5 && slotsUsed >= 6 && !sellable.length);

// Inventory-overblik: pladser, fuldt build og elixir der passer til dig (ved fuldt build).
function inventoryInfo(me, gold, mapNumber, gameTime = 0, build = null, enemyIds = []) {
  const completed = me.itemIds.filter((id) => isCompleted(dd.items[id]));
  const slotsUsed = me.slotsUsed ?? me.itemIds.length;
  const full = isFullBuild(completed.length, slotsUsed, sellableIds(me.itemIds, buildPopularity(build)));
  const onMap = (id) => dd.items[id] && dd.items[id].maps[mapNumber] !== false;
  // Påmindelse om støvler: ingen færdige støvler efter 10 min -> de støvler item settet valgte (samme valg som i champion select).
  const hasBoots = completed.some((id) => isBoots(dd.items[id]));
  const enemy = app.cfg.adaptToEnemies && enemyIds.length ? analyzeEnemies(enemyIds) : null;
  const chosen = build ? chooseBoots(build, enemy, app.cfg).boots[0] : null;
  const bootsId = chosen != null ? String(chosen) : null;
  const bootsTip = !full && !hasBoots && gameTime >= 600 && bootsId && onMap(bootsId)
    ? { id: bootsId, cost: remainingCost(bootsId, me.itemIds).cost, minutes: Math.floor(gameTime / 60) }
    : null;
  // Påmindelse om Control Ward (75 g): efter 5 min, når du har plads og ingen har (findes ikke i ARAM/Arena).
  const ward = dd.items['2055'];
  const wardTip = onMap('2055') && !full && gameTime >= 300 && slotsUsed < 6
    && !me.itemIds.includes('2055') && gold >= ward.gold;
  const kind = me.champ?.tags?.[0] === 'Tank' ? 'tank' : me.dmg.ad >= 0.5 ? 'ad' : 'ap';
  const elixirId = ELIXIR[kind];
  const elixirOk = full && onMap(elixirId);
  return {
    slotsUsed: Math.min(6, slotsUsed),
    completed: completed.length,
    full,
    elixir: elixirOk ? { id: elixirId, cost: dd.items[elixirId].gold, canAfford: dd.items[elixirId].gold <= gold } : null,
    wardTip: wardTip ? { id: '2055', cost: ward.gold } : null,
    bootsTip: bootsTip && { ...bootsTip, canAfford: bootsTip.cost <= gold },
  };
}

// Den mest værdifulde del du har råd til nu - prisen er hvad delen koster dig (ejede under-dele trukket fra).
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
    .filter((p) => dd.items[p])
    .map((p) => ({ id: p, cost: remainingCost(p, ownedIds).cost }))
    .filter((p) => p.cost <= gold)
    // Størst værdi først; ved samme værdi den du allerede har en under-del til (fx Aether Wisp med en Tome).
    .sort((a, b) => (dd.items[b.id].gold - dd.items[a.id].gold) || (a.cost - b.cost))[0] || null;
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

  // Lane-modstander: samme rolle i live-API'et; mangler rollerne, så den der blev fundet i champion select.
  const knownOpp = app.plan?.oppKey || (app.rec?.matchup?.id != null ? String(app.rec.matchup.id) : null);
  // Jungle uden roller i live-API'et: den eneste modstander med Smite.
  const smiters = enemies.filter((p) => p.hasSmite);
  const iJungle = me.position === 'JUNGLE' || (!me.position && me.hasSmite);
  const opponent = (me.position && enemies.find((p) => p.position === me.position))
    || (iJungle && smiters.length === 1 ? smiters[0] : null)
    || (knownOpp && enemies.find((p) => String(p.champ?.key) === knownOpp))
    || null;
  // Gameplanen (og dens matchup-build) gælder kun hvis den er mod den samme modstander.
  const plan = app.plan && opponent && String(opponent.champ?.key) === app.plan.oppKey ? app.plan : null;
  // Arena (map 30) har sin egen butik: ingen item-råd ud fra et Summoner's Rift-build.
  const mapNumber = data.gameData?.mapNumber || 11;
  const itemBuild = mapNumber === 30 || data.gameData?.gameMode === 'CHERRY' ? null : build;
  const advice = liveAdvice(itemBuild, me, enemy, gold, mapNumber, {
    gameTime: data.gameData?.gameTime || 0,
    matchupBuild: plan?.matchupBuild || null,
    oppName: plan?.opponent || null,
  });
  const matchup = opponent && { player: opponent, stats: matchupStats(build, opponent.champ?.key) };
  const skill = skillHint(data.activePlayer, build);
  const enemyIds = enemies.map((p) => p.champ?.key).filter(Boolean);
  const inventory = inventoryInfo(me, gold, mapNumber, data.gameData?.gameTime || 0, itemBuild, enemyIds);
  inventory.starter = starterAdvice(itemBuild, plan, me, gold, data.gameData?.gameTime || 0, mapNumber);
  return { me, allies, enemies, gold, gameTime: data.gameData?.gameTime || 0, gameMode: data.gameData?.gameMode, score, enemy, advice, matchup, skill, inventory };
}

// 2-3 forslag fra championens egen item-pulje, scoret efter popularitet + modstandernes faktiske builds.
// Startitems ved kampstart (før dit første køb, de første 3 min): fra matchuppet hvis der er nok kampe,
// ellers de mest købte for din champion.
function starterAdvice(build, plan, me, gold, gameTime, mapNumber = 11) {
  const bought = me.itemIds.filter((id) => !dd.items[id]?.tags.includes('Trinket'));
  if (bought.length || gameTime > 180 || !build) return null;
  const mStart = plan?.matchupBuild?.starter_items?.[0];
  const useMatchup = mStart && mStart.play >= MATCHUP_MIN_GAMES;
  const start = useMatchup ? mStart : rankOptions(build.starter_items, { buildChoice: 'popular' })[0];
  if (!start) return null;
  const counts = new Map();
  for (const id of start.ids.map(String)) counts.set(id, (counts.get(id) || 0) + 1);
  const items = [...counts].map(([id, count]) => ({ id, count }));
  // Kan et af items ikke købes på dette map, er startbuildet ikke til denne tilstand.
  if (items.some((i) => !dd.items[i.id] || dd.items[i.id].maps[mapNumber] === false)) return null;
  const cost = items.reduce((s, i) => s + (dd.items[i.id]?.gold || 0) * i.count, 0);
  return { items, cost, canAfford: cost <= gold, vs: useMatchup ? plan.opponent : null, share: start.pick_rate || null };
}

// Næste item efter OP.GG's core-kombinationer (3-4 items): blandt kombinationer hvis første k færdige items
// er dem du har, hvad er item nr. k+1? (Antager at kombinationerne står i byggerækkefølge - det passer
// med dataene, fx starter alle Tryndamere-kombinationer med Ravenous Hydra.) Komponenter som Dark Seal
// fjernes først, så [Dark Seal, Lich Bane, Mejai's, ...] tæller som [Lich Bane, Mejai's, ...].
function nextInBuild(build, ownedNonBoots) {
  const k = ownedNonBoots.length;
  const owned = new Set(ownedNonBoots);
  const counts = new Map();
  let total = 0;
  for (const c of build.core_items || []) {
    const ids = coreIdsOf(c.ids);
    if (ids.length <= k || !ids.slice(0, k).every((id) => owned.has(id)) || owned.has(ids[k])) continue;
    counts.set(ids[k], (counts.get(ids[k]) || 0) + c.play);
    total += c.play;
  }
  return total ? { slot: k + 1, total, share: (id) => (counts.get(id) || 0) / total } : null;
}

// Items der bygges markant oftere mod din lane-modstander end generelt (fx Mortal Reminder mod Darius).
function matchupItemBoost(build, matchupBuild) {
  const rate = (b) => new Map((b?.last_items || []).map((x) => [String(x.ids[0]), x]));
  const general = rate(build);
  const vs = rate(matchupBuild);
  const boost = new Map();
  for (const [id, x] of vs) {
    const g = general.get(id);
    if (x.play < 100 || !g || !g.pick_rate) continue;
    const ratio = x.pick_rate / g.pick_rate;
    if (ratio >= 1.3) boost.set(id, { ratio, vs: x.pick_rate, general: g.pick_rate });
  }
  return boost;
}

function liveAdvice(build, me, enemy, gold, mapNumber, ctx = {}) {
  if (!build) return [];
  const pop = buildPopularity(build);

  const owned = me.itemIds;
  // Inventory: 6 pladser. Fuldt build = 6 færdige items (eller 5 + en plads der ikke kan sælges) -> kun "byt ud"-forslag.
  const completedOwned = owned.filter((id) => isCompleted(dd.items[id]));
  const hasBoots = completedOwned.some((id) => isBoots(dd.items[id]));
  // Kun færdige items: en Executioner's Calling/Oblivion Orb skal ikke skjule Mortal Reminder/Morellonomicon.
  const hasAntiheal = completedOwned.some((id) => dd.items[id].antiheal);
  const iAmAD = me.dmg.ad >= 0.5;
  const slotsUsed = me.slotsUsed ?? owned.length;
  const freeSlots = Math.max(0, 6 - slotsUsed);
  // Unikke passiver du allerede har (to Spellblade-/Lifeline-/Hydra-items virker ikke sammen).
  const ownedPassives = ownedPassivesOf(owned);
  // Det der kan sælges for at få plads (billigste/mindst værdifulde først).
  const sellable = sellableIds(owned, pop);
  const full = isFullBuild(completedOwned.length, slotsUsed, sellable);
  // Ved fuldt build: det af dine items der er mindst brugt i buildet (støvler beholdes).
  const swapOut = full
    ? completedOwned.filter((id) => !isBoots(dd.items[id])).sort((a, b) => (pop.get(a) || 0) - (pop.get(b) || 0))[0]
    : null;
  const ordinal = (n) => `${n}.`;
  const nonBootsDone = completedOwned.filter((id) => !isBoots(dd.items[id]));
  const next = nextInBuild(build, nonBootsDone);
  // Tidlig komponent som mange core-kombinationer starter med (fx Dark Seal på Evelynn): et valg før første færdige item.
  const early = new Map();
  if (!nonBootsDone.length) {
    const plays = new Map();
    let all = 0;
    for (const c of build.core_items || []) {
      all += c.play || 0;
      const first = String(c.ids[0]);
      const it = dd.items[first];
      if (it && !isCompleted(it) && !isBoots(it) && it.into.length) plays.set(first, (plays.get(first) || 0) + (c.play || 0));
    }
    for (const [id, n] of plays) {
      if (n / all >= 0.2 && !dd.items[id].into.some((x) => owned.includes(x))) early.set(id, { share: n / all, total: all });
    }
  }
  const vsBoost = ctx.matchupBuild ? matchupItemBoost(build, ctx.matchupBuild) : new Map();
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
    const first = early.get(id);
    if (!(isCompleted(it) || first) || !it.purchasable || it.maps[mapNumber] === false || owned.includes(id)) continue;
    if (hasBoots && isBoots(it)) continue;
    if (hasAntiheal && it.antiheal) continue;
    if (it.passives.some((p) => ownedPassives.has(p))) continue; // samme unikke passiv som noget du har
    const { cost, used } = remainingCost(id, owned);
    const paid = it.gold - cost;
    const inProgress = paid >= IN_PROGRESS_GOLD;
    // Matchup: bygges markant oftere mod din lane-modstander.
    const vs = vsBoost.get(id);
    // Sjældne køb i puljen (fx Randuin's på en mage) passer sjældent til championen
    // - medmindre du er i gang med det, eller det bygges markant oftere mod din lane-modstander.
    if (popularity >= 0 && popularity < 0.02 && !inProgress && !vs) continue;
    let score = Math.max(popularity, 0) * 100;
    const reasons = [];
    // Begrundelser der bygger på modstandernes tilstand (items, KDA, healere): vises kun passivt i hovedvinduet,
    // aldrig i overlayet og udløser ingen stemme/bip (Riot: ingen notifikationer om modstanderes power spikes).
    const enemyTexts = new Set();
    const enemyReason = (text) => { enemyTexts.add(text); reasons.push(text); };
    // Stærke grunde (rigtige healere, forsvar, en modstander med høj KDA, matchup) giver en af de tilpassede pladser.
    // Andelen af AD/AP i deres trussel giver kun point.
    let strong = false;
    if (inProgress) {
      score += 40 + 60 * (paid / it.gold);
      reasons.push(`Du er i gang: har ${used.map(itemName).join(', ')} (${pct(paid / it.gold)} af prisen)`);
    }
    if (it.antiheal && enemy.healers.length) { score += 30 + 15 * enemy.healers.length; strong = true; enemyReason(`Anti-heal mod ${names(enemy.healers)}`); }
    if (it.tags.includes('ArmorPenetration') && iAmAD && enemy.armorHeavy) { score += 35; strong = true; enemyReason(`${names(enemy.armorStackers)} bygger armor`); }
    if (it.tags.includes('MagicPenetration') && !iAmAD && enemy.mrHeavy) { score += 35; strong = true; enemyReason(`${names(enemy.mrStackers)} bygger magic resist`); }
    const fedAD = enemy.fed.find((p) => p.dmg.ad >= 0.6);
    const fedAP = enemy.fed.find((p) => p.dmg.ap >= 0.6);
    // Med enemyAlerts: "X er fed (KDA) og laver AD-skade"; ellers kun fakta fra TAB (KDA + skadetype ud fra items).
    const fedText = (p, kind) => (app.cfg.enemyAlerts
      ? `${p.champ?.name || p.name} er fed (${kda(p)}) og laver ${kind}-skade`
      : `${p.champ?.name || p.name}: ${kda(p)}, ${pct(kind === 'AD' ? p.dmg.ad : p.dmg.ap)} ${kind}-skade`);
    if (it.tags.includes('Armor') && fedAD) { score += 30; strong = true; enemyReason(fedText(fedAD, 'AD')); }
    if (it.tags.includes('SpellBlock') && fedAP) { score += 30; strong = true; enemyReason(fedText(fedAP, 'AP')); }
    if (it.tags.includes('Armor') && enemy.adShare >= 0.65) { score += 15; enemyReason(`${pct(enemy.adShare)} af deres trussel er AD`); }
    if (it.tags.includes('SpellBlock') && enemy.apShare >= 0.55) { score += 15; enemyReason(`${pct(enemy.apShare)} af deres trussel er AP`); }
    if (vs) { score += Math.min(30, 15 * vs.ratio); strong = true; reasons.push(`Bygges oftere mod ${ctx.oppName} (${pct(vs.vs)} mod ${pct(vs.general)} generelt)`); }
    const adapted = strong;
    if (first) {
      score += 45 * first.share;
      reasons.push(`${pct(first.share)} af core-kombinationerne (${first.total.toLocaleString('da-DK')} kampe) starter med ${it.name}`);
    }
    // Byggerækkefølge: typisk næste item efter dem du har.
    const share = next ? next.share(id) : 0;
    if (share > 0) {
      score += 45 * share;
      const after = nonBootsDone.length ? ` efter ${nonBootsDone.map(itemName).join(' + ')}` : '';
      // Efter "Du er i gang", hvis det står der - ellers først.
      reasons.splice(inProgress ? 1 : 0, 0, `Typisk ${ordinal(next.slot)} item${after} (${pct(share)} af ${next.total.toLocaleString('da-DK')} kampe)`);
    }
    if (!reasons.length) reasons.push(`Fast del af buildet (${pct(Math.min(Math.max(popularity, 0), 1))} køber det)`);
    let budget = gold;
    let sell = null;
    let swap = null;
    if (full) {
      // Fuldt build: kun bytte når der er en konkret grund (anti-heal, armor, MR ...).
      if (!adapted || !swapOut) continue;
      swap = swapOut;
      budget += dd.items[swapOut].sell;
      reasons.unshift(`Fuldt build: mulighed for at bytte ${itemName(swapOut)} ud (sælges for ${dd.items[swapOut].sell} g)`);
    } else if (!used.length && freeSlots === 0) {
      // Nyt item uden ejede dele kræver en ledig plads.
      if (!sellable.length) continue;
      sell = sellable[0];
      budget += dd.items[sell].sell;
      reasons.push(`Kræver en ledig plads, fx ved salg af ${itemName(sell)} (+${dd.items[sell].sell} g)`);
    }
    // En del fylder en plads: kun forslag om del hvis der er plads.
    const part = cost > budget && freeSlots > 0 && !full ? affordablePart(id, owned, gold) : null;
    // Til overlay/stemme: første begrundelse om dit eget build (ikke om modstanderne). Findes ingen, er forslaget
    // der kun pga. modstandernes tilstand -> "quiet": ingen stemme, bip, blink eller overlay-begrundelse.
    // Med enemyAlerts tæller modstander-begrundelserne med (overlay, stemme, bip) som før.
    const ownReasons = reasons.filter((r) => (app.cfg.enemyAlerts || !enemyTexts.has(r)) && !r.startsWith('Fuldt build') && !r.startsWith('Kræver en ledig plads'));
    const overlayReason = ownReasons.find((r) => !r.startsWith('Du er i gang')) || null;
    const quiet = ownReasons.length === 0;
    scored.push({ id, score, reasons, cost, canAfford: cost <= budget, part, adapted, inProgress, used, sell, swap, nextShare: share, overlayReason, quiet });
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
  // Grundplanen: det mest typiske næste item i dit build har altid en plads (medmindre du er i gang med et andet).
  const nextUp = [...rest].filter((s) => s.nextShare > 0).sort((a, b) => b.nextShare - a.nextShare)[0];
  if (nextUp && !out.some((o) => o.inProgress && o.nextShare > 0)) add(nextUp);
  rest.filter((s) => s.adapted && !s.inProgress).slice(0, 2).forEach(add);
  rest.forEach(add);
  // "I gang" først, ellers efter score.
  return out.sort((a, b) => (b.inProgress - a.inProgress) || (b.score - a.score));
}

// ---------- Stemme (virker også i ægte fuldskærm, hvor intet vindue kan ses) ----------

// Én besked ad gangen (kø), så beskederne ikke taler oven i hinanden. Pr. slags højst én hvert 8. sekund,
// og en besked der har ventet for længe i køen droppes (gammelt nyt midt i en kamp er bare støj).
const lastSpoken = new Map();
const speech = { queue: [], busy: false, voiceLogged: false, macVoice: undefined, errors: new Set() };
const SPEECH_MAX_WAIT = 6000;

// Returnerer true hvis beskeden kommer i køen (false = stemmen er slået fra eller samme slags for nylig).
function speak(kind, text) {
  if (!app.cfg.voice) return false;
  if (Date.now() - (lastSpoken.get(kind) || 0) < 8000) return false;
  lastSpoken.set(kind, Date.now());
  speech.queue.push({ text, at: Date.now() });
  speakNext();
  return true;
}

function speakNext() {
  if (speech.busy) return;
  speech.queue = speech.queue.filter((q) => Date.now() - q.at < SPEECH_MAX_WAIT);
  const next = speech.queue.shift();
  if (!next) return;
  speech.busy = true;
  log(`Stemme: ${next.text}`);
  sayNow(next.text, (err, stdout) => {
    speech.busy = false;
    if (err) {
      const msg = err.killed ? 'tog for lang tid' : String(err.message).split('\n')[0];
      if (!speech.errors.has(msg)) { speech.errors.add(msg); log(`Stemmen fejlede: ${msg}`); }
    }
    const m = /VOICE=(.*)\|(.*)/.exec(stdout || '');
    if (m) logVoice(m[1].trim(), m[2].trim());
    speakNext();
  });
}

// Hvilken stemme der læser op - logges én gang, så man kan se hvis der ikke er en dansk.
function logVoice(name, culture) {
  if (speech.voiceLogged) return;
  speech.voiceLogged = true;
  if (/^da/i.test(culture)) log(`Talesyntese: bruger ${name} (${culture}).`);
  else log(`Talesyntese: ingen dansk stemme fundet - bruger ${name || 'standardstemmen'}${culture ? ` (${culture})` : ''}. Beskederne er på dansk.`);
}

// Windows' indbyggede talesyntese; teksten via miljøvariabel, så anførselstegn i navne er sikre.
// Vælger en dansk stemme (da-DK) hvis der er en, ellers standardstemmen.
const WIN_SAY = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'da-DK' } | Select-Object -First 1",
  'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
  "Write-Output ('VOICE=' + $s.Voice.Name + '|' + $s.Voice.Culture.Name)",
  '$s.Rate = 1',
  '$s.Speak($env:LRH_SAY)',
].join('; ');

function sayNow(text, done) {
  const opts = { timeout: 20000, windowsHide: true };
  if (process.env.LOL_HELPER_SAY_CMD) return execFile(process.env.LOL_HELPER_SAY_CMD, [text], opts, done); // test-hook
  if (process.platform === 'win32') {
    return execFile('powershell.exe', ['-NoProfile', '-Command', WIN_SAY], { ...opts, env: { ...process.env, LRH_SAY: text } }, done);
  }
  if (process.platform === 'darwin') {
    // macOS: find en dansk stemme (fx Sara) første gang.
    if (speech.macVoice === undefined) {
      return execFile('say', ['-v', '?'], opts, (err, out) => {
        const m = /^(.+?)\s+da_DK\b/m.exec(err ? '' : out || '');
        speech.macVoice = m ? m[1].trim() : null;
        logVoice(speech.macVoice || '', m ? 'da_DK' : '');
        sayNow(text, done);
      });
    }
    return execFile('say', [...(speech.macVoice ? ['-v', speech.macVoice] : []), text], opts, done);
  }
  done(null, '');
}

// Sig kun det der er NYT. Kun din egen tilstand: dit guld, dine skill-points, dine items og dit level.
// Bevidst intet om modstandernes items, levels eller "fed" (Riot/Overwolf: ingen power spike-notifikationer).
function announce(L) {
  const v = app.voice;
  // Når stemmen er slået fra, tæller alt som sagt (så den ikke siger gamle nyheder når den slås til).
  const say = (kind, text) => !app.cfg.voice || speak(kind, text);
  // Kun forslag du kan købe uden først at sælge eller bytte noget - og ikke forslag der kun skyldes modstandernes
  // tilstand (quiet), så stemmen aldrig indirekte melder at en modstander er blevet stærkere.
  const afford = L.advice.filter((a) => a.canAfford && !a.sell && !a.swap && !a.quiet).map((a) => a.id);
  // Dine færdige core-items (core fra gameplanen, ellers fra buildet).
  const coreList = app.plan?.myCore?.length ? app.plan.myCore : coreOf(app.liveBuild?.build);
  const core = coreList.filter((id) => L.me.itemIds.includes(id) && isCompleted(dd.items[id]));
  // Startitems: siges én gang ved kampstart - men først når gameplanen mod lane-modstanderen er klar,
  // så den nævner matchuppets startitems og ikke de generelle (højst 5 sek. ventetid).
  const st = L.inventory?.starter;
  if (st && app.starterAnnounced !== true) {
    if (!app.starterAnnounced) app.starterAnnounced = Date.now();
    const oppKey = L.matchup?.player?.champ?.key;
    const planReady = !oppKey || app.plan?.oppKey === String(oppKey);
    if (planReady || Date.now() - app.starterAnnounced > 5000) {
      app.starterAnnounced = true;
      speak('start', `Start: ${st.items.map((i) => `${i.count > 1 ? `${i.count} ` : ''}${itemName(i.id)}`).join(' og ')}`);
    }
  }
  const fed = new Set(L.enemy.fed.map((p) => p.champ?.name || p.name));
  if (!v || !v.core) {
    // Første gang i kampen (eller efter opdatering): intet at annoncere, bare husk tilstanden.
    app.voice = { afford: new Set(afford), skillNext: L.skill.next, core, level: L.me.level, fed };
    return;
  }
  // "X er fed" (kun med enemyAlerts): nye modstandere med høj KDA siden sidst.
  if (app.cfg.enemyAlerts) {
    const newFed = [...fed].filter((n) => !v.fed?.has(n));
    if (newFed.length) say('fed', `${newFed.join(' og ')} er fed`);
  }
  // "Råd til": et forslag du ikke længere har råd til, må siges igen senere. Et der bare falder ud af listen, glemmes ikke.
  for (const a of L.advice) if (!a.canAfford) v.afford.delete(a.id);
  const newAfford = afford.filter((id) => !v.afford.has(id));
  // Kun det vigtigste forslag (de står i prioriteret rækkefølge) - kort besked midt i en kamp.
  // Blev beskeden ikke sagt (samme slags for nylig), prøves den igen næste gang.
  if (newAfford.length && say('afford', `Råd til ${itemName(newAfford[0])}`)) newAfford.forEach((id) => v.afford.add(id));
  // Dit eget level 6 (egen tilstand - tilladt). Evelynn får også camouflage.
  let level6 = false;
  if (v.level < 6 && L.me.level >= 6) {
    level6 = true;
    say('level6', L.me.champ?.id === 'Evelynn' ? 'Level 6 - camouflage og R' : 'Level 6 - R');
  }
  let skillNext = L.skill.next ? v.skillNext : null;
  if (L.skill.next && !v.skillNext) {
    // "Level 6 - R" dækker allerede R-pointet.
    if ((level6 && L.skill.next === 'R') || say('skill', `Level op: ${L.skill.next}`)) skillNext = L.skill.next;
  }
  // Dit eget power spike: et item fra dit core build er færdigt (egen tilstand - tilladt). Ét ad gangen.
  const newCore = core.filter((c) => !v.core.includes(c));
  const done = core.filter((c) => v.core.includes(c));
  if (newCore.length && say('core', `${itemName(newCore[0])} færdig - ${done.length + 1} af ${coreList.length} i dit core build`)) done.push(newCore[0]);
  app.voice = { afford: v.afford, skillNext, core: done, level: L.me.level, fed };
}

async function updateLive(data) {
  const activeName = data.activePlayer?.riotId || data.activePlayer?.summonerName || '';
  const meRaw = (data.allPlayers || []).find((p) => playerName(p) === activeName)
    || (data.allPlayers || []).find((p) => activeName && activeName.split('#')[0] === shortName(p));
  const champ = meRaw && championOf(meRaw);
  if (!champ) { app.live = null; return; }

  // Genbrug buildet fra champion select; ellers hent det (fx hvis programmet startes midt i kampen).
  // Fejlede hentningen, prøves der igen hvert halve minut.
  if (app.liveBuild?.championKey !== champ.key || (!app.liveBuild.build && Date.now() >= app.liveBuild.retryAt)) {
    let build = null;
    if (app.build && app.pick?.championId === Number(champ.key)) build = app.build.build;
    else {
      try {
        build = (await getBuild(app.cfg, Number(champ.key), LIVE_POSITION[meRaw.position] || null, data.gameData?.gameMode, data.gameData?.mapNumber)).build;
      } catch (e) {
        if (app.liveBuild?.championKey !== champ.key) log(`Kunne ikke hente build til live-forslag (prøver igen): ${e.message}`);
      }
    }
    app.liveBuild = { championKey: champ.key, build, retryAt: Date.now() + 30000 };
  }
  const first = !app.live;
  app.live = analyzeLive(data, app.liveBuild.build);
  if (app.live) {
    trackGame(data, app.live);
    const opp = app.live.matchup?.player;
    if (opp?.champ) ensurePlan(champ.key, opp.champ.key, LIVE_POSITION[meRaw.position] || app.build?.position, app.liveBuild.build);
    ensureJungleRoutes(champ.key, LIVE_POSITION[meRaw.position] || app.build?.position);
    trackOpponent(app.live, data.events?.Events);
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
      if (app.reconnecting) { app.reconnecting = false; log('Spillet er tilbage - fortsætter samme kamp.'); }
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
    // Spillet er væk. Men står klienten stadig "i kamp" (crash/genforbindelse) og er GameEnd ikke set,
    // er kampen ikke slut: behold køb, gameplan og stemme til spillet er tilbage.
    const phase = app.live && gone >= 2 && app.client && !app.game?.result
      ? await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase').catch(() => null) : null;
    if (app.live && gone >= 2 && ['InProgress', 'Reconnect', 'GameStart'].includes(phase)) {
      if (!app.reconnecting) { app.reconnecting = true; log('Spillet svarer ikke - venter på at du genforbinder.'); }
    } else if (app.live && gone >= 2) {
      app.reconnecting = false;
      app.live = null;
      app.liveBuild = null;
      app.voice = null;
      app.starterAnnounced = false;
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
  jungle: null,        // mest brugte jungle-ruter for din champion (kun jungle)
  jungleKey: null,
  draft: null,         // ban/counterpick-forslag før du låser
  draftKey: null,
  draftBanTurn: false, // din tur til at banne lige nu
  pickRetry: null,     // { pickKey, n, at } når buildet ikke kunne hentes - næste forsøg
  pickStatus: null,    // status efter sidste champion select-anvendelse
  jungleRetry: null,   // { key, at } når jungle-ruterne fejlede
  reconnecting: false, // spillet er væk, men klienten er stadig i kamp (crash/genforbindelse)
  shapesLogged: false, // klientens dataformat er gemt (lcu-shapes.json)
  draftStatus: null,   // 'loading' | 'error' | 'unsupported' mens der ingen draft-data er
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
      wardTip: L.inventory.wardTip && { ...L.inventory.wardTip, name: itemName('2055'), icon: dd.items['2055']?.icon },
      bootsTip: L.inventory.bootsTip && { ...L.inventory.bootsTip, name: itemName(L.inventory.bootsTip.id), icon: dd.items[L.inventory.bootsTip.id]?.icon },
      starter: L.inventory.starter && {
        ...L.inventory.starter,
        items: L.inventory.starter.items.map((i) => ({ ...i, name: itemName(i.id), icon: dd.items[i.id]?.icon })),
      },
    },
    matchup: L.matchup && {
      name: L.matchup.player.champ?.name || L.matchup.player.name,
      icon: L.matchup.player.champ?.icon,
      winRate: L.matchup.stats?.winRate ?? null,
      games: L.matchup.stats?.games ?? null,
    },
    me: player(L.me),
    side: L.me.team === 'CHAOS' ? 'RED' : 'BLUE', // ORDER = blå side
    vision: visionView(L),
    lanes: laneView(L),
    allies: team(L.allies, L.me.team),
    enemies: team(L.enemies, enemySide),
    advice: L.advice.map((a) => ({
      ...item(a.id),
      cost: a.cost,
      canAfford: a.canAfford,
      reasons: a.reasons,
      adapted: a.adapted,
      inProgress: a.inProgress,
      overlayReason: a.overlayReason,
      quiet: a.quiet,
      part: a.part && { ...item(a.part.id), cost: a.part.cost },
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

// Champions med camouflage/usynlighed. For dem vises (passivt, fra TAB) hvem der bærer Oracle Lens eller Control Ward.
const STEALTH_CHAMPS = new Set(['Evelynn', 'Twitch', 'Shaco', 'Rengar', 'Khazix', 'Talon', 'Akali', 'Pyke', 'Vayne', 'MonkeyKing', 'Senna', 'Qiyana']);
function visionView(L) {
  if (!STEALTH_CHAMPS.has(L.me.champ?.id)) return null;
  const who = (id) => L.enemies.filter((p) => p.itemIds.includes(id)).map((p) => p.champ?.name || p.name);
  return { lens: who('3364'), ward: who('2055') };
}

// Styrkeforhold i hver lane (level, ult, items - som på TAB). For junglere: gank-overblik.
const LANES = [['TOP', 'Top'], ['JUNGLE', 'Jungle'], ['MIDDLE', 'Mid'], ['BOTTOM', 'Bot'], ['UTILITY', 'Support']];
function laneView(L) {
  if (!L.me.position) return null;
  const rows = [];
  for (const [pos, lane] of LANES) {
    const a = L.allies.find((p) => p.position === pos);
    const b = L.enemies.find((p) => p.position === pos);
    if (!a || !b) continue;
    const name = (p) => p.champ?.name || p.name;
    const bal = balanceOf(a, b, name(b), a === L.me ? null : name(a));
    const side = (p) => ({ name: name(p), icon: p.champ?.icon, level: p.level, dead: p.isDead, kda: `${p.kills}/${p.deaths}/${p.assists}` });
    rows.push({ lane, me: a === L.me, ally: side(a), enemy: side(b), side: bal.side, label: bal.label, why: bal.why.slice(0, 2) });
  }
  return rows.length ? { jungle: L.me.position === 'JUNGLE', rows } : null;
}

const champView = (id) => ({ id, name: dd.champions[id]?.name || String(id), icon: dd.champions[id]?.icon });

function planView() {
  const p = app.plan;
  if (!p) return null;
  const item = (id) => ({ id, name: itemName(id), icon: dd.items[id]?.icon });
  const opp = app.live?.matchup?.player;
  const live = opp && String(opp.champ?.key) === p.oppKey ? opp : null; // lane-modstanderen i kampen
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
    phases: p.phases || [],
    phaseNow: live ? phaseNow(app.live, p) : null,
    balance: live ? balanceOf(app.live.me, live, p.opponent) : null,
    duels: p.duels.map((d) => ({ t: d.t, won: d.won, solo: d.solo, context: d.context })),
    record: matchupRecord(p),
    now: live ? planNow(p, app.live) : null,
    log: p.log.map((l) => ({ t: l.t, text: l.text })),
  };
}

// Dine egne kampe (gemt af programmet) med samme champion mod samme modstander.
function matchupRecord(p) {
  const oppName = dd.champions[p.oppKey]?.name;
  const games = srGames().filter((g) => String(g.championId) === p.myKey && g.matchup?.champion === oppName);
  if (!games.length) return null;
  const wins = games.filter((g) => g.result === 'Sejr').length;
  const losses = games.filter((g) => g.result === 'Nederlag').length;
  const duels = games.flatMap((g) => g.duels || []);
  return { games: games.length, wins, losses, duelsWon: duels.filter((d) => d.won).length, duelsLost: duels.filter((d) => !d.won).length };
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
  const games = srGames();
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
    enemyAlerts: Boolean(app.cfg.enemyAlerts),
    update: app.update && { version: app.update.version, notes: app.update.notes, canApply: IS_SEA && !RUNS_FROM_ZIP, inProgress: updateRunning, error: app.update.error || null },
    draftStatus: app.draftStatus,
    minGames: MATCHUP_MIN_GAMES, // matchup-tal med færre kampe vises som usikre
    updateCheck: { at: updateCheck.at || null, ok: updateCheck.ok, error: updateCheck.error },
    draft: draftView(),
    plan: planView(),
    jungle: app.jungle && {
      ...Object.fromEntries(['BLUE', 'RED'].filter((side) => app.jungle[side]).map((side) => [side, app.jungle[side].map((r) => ({
        camps: r.route.map((c) => CAMP_NAMES[c] || c),
        games: r.play,
        share: r.share,
      }))])),
      rate: app.jungle.rate || null, // hvor de starter (procent) pr. side
    },
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

// Tailscale-adresser ligger i 100.64.0.0/10. Trafikken dér er krypteret af Tailscale;
// wifi/LAN er almindelig HTTP, hvor nøglen kan aflyttes - derfor kun med "remoteLan": true.
const isTailscale = (ip) => {
  const [x, y] = String(ip || '').replace(/^::ffff:/, '').split('.').map(Number);
  return x === 100 && y >= 64 && y <= 127;
};

function remoteUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const tailscale = isTailscale(a.address);
      if (!tailscale && !app.cfg.remoteLan) continue;
      urls.push({ label: tailscale ? 'Tailscale' : 'Wifi/netværk', url: `http://${a.address}:${port}/?token=${app.remote.token}` });
    }
  }
  return urls.sort((a, b) => (a.label === 'Tailscale' ? -1 : 1) - (b.label === 'Tailscale' ? -1 : 1));
}

// Tilladte Host-headers: beskytter mod DNS-rebinding (en fremmed side der "bliver" 127.0.0.1).
// Med telefon-adgang genberegnes listen løbende: ny IP fra routeren eller Tailscale startet efter programmet.
const allowedHosts = new Set();
const remoteRefresh = { port: 0, timer: null, at: 0 };
function setAllowedHosts(port) {
  remoteRefresh.port = port;
  remoteRefresh.at = Date.now();
  allowedHosts.clear();
  for (const h of ['127.0.0.1', 'localhost']) allowedHosts.add(`${h}:${port}`);
  if (!app.remote.enabled) return;
  const before = app.remote.urls.map((u) => u.url).join(' ');
  app.remote.urls = remoteUrls(port);
  const changed = app.remote.urls.map((u) => u.url).join(' ') !== before;
  if (changed) for (const u of app.remote.urls) log(`Telefon (${u.label}): ${u.url}`);
  if ((changed || !remoteRefresh.timer) && !app.remote.urls.length) {
    log(app.cfg.remoteLan ? 'Telefon: intet netværk fundet endnu.' : 'Telefon: Tailscale er ikke fundet (endnu). Brug Tailscale, eller sæt "remoteLan": true i config.json for wifi.');
  }
  if (changed) broadcast();
  for (const u of app.remote.urls) allowedHosts.add(new URL(u.url).host);
  // Egne navne: computerens navn og fx et Tailscale MagicDNS-navn fra "remoteHosts" i config.json.
  const names = [os.hostname(), ...(Array.isArray(app.cfg.remoteHosts) ? app.cfg.remoteHosts : [])];
  for (const n of names) if (n) allowedHosts.add(`${String(n).toLowerCase()}:${port}`);
  if (!remoteRefresh.timer) {
    remoteRefresh.timer = setInterval(() => setAllowedHosts(remoteRefresh.port), 60 * 1000);
    remoteRefresh.timer.unref();
  }
}

// Sammenlign nøgler i konstant tid (ingen tids-lækage af hvor mange tegn der passer).
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

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
  const host = String(req.headers.host || '').toLowerCase();
  // Ukendt Host med telefon-adgang: måske ny IP/Tailscale siden sidst - genberegn (højst hvert 5. sek.).
  if (allowedHosts.size && !allowedHosts.has(host) && app.remote.enabled && Date.now() - remoteRefresh.at > 5000) setAllowedHosts(remoteRefresh.port);
  if (allowedHosts.size && !allowedHosts.has(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Ukendt adresse');
  }
  if (!LOOPBACK.has(req.socket.remoteAddress)) {
    if (!app.cfg.remoteLan && !isTailscale(req.socket.localAddress)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Telefon-adgang virker kun via Tailscale. Sæt "remoteLan": true i config.json for at tillade wifi.');
    }
    const { token } = app.remote;
    let query = null;
    try { query = new URL(req.url, 'http://x').searchParams.get('token'); } catch {}
    if (token && safeEqual(query, token)) {
      res.writeHead(302, { 'Set-Cookie': `lrh=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`, Location: '/' });
      return res.end();
    }
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('lrh='))?.slice(4);
    if (!token || !safeEqual(cookie, token)) {
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
    // Vinduet åbnes: tjek for ny version, hvis det er mere end 10 min siden sidst.
    checkUpdateIfStale(10 * 60 * 1000);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/check-update') {
    await checkUpdate();
    return json(200, { ok: updateCheck.ok, update: app.update?.version || null });
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
    app.pickRetry = null;
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
    // Dobbeltklik (vinduet tegner knappen igen under download): kun én opdatering ad gangen.
    if (updateRunning) return json(409, { error: 'Opdateringen er allerede i gang' });
    const running = applyUpdate();
    json(200, { ok: true });
    broadcast(); // vinduet viser "Opdaterer..." og deaktiverer knappen
    try {
      await running;
    } catch (e) {
      updateFailed(e);
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
    if (RUNS_FROM_ZIP) return json(400, { error: ZIP_HINT });
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

// Runer/summoners venter højst så længe på lane-modstanderen; kommer den senere, opdateres bagefter.
const MATCHUP_WAIT_MS = 1500;
const PENDING = Symbol('pending');

async function handlePick(pick, pickKey, itemKey) {
  const { cfg } = app;
  const fullApply = pickKey !== app.applied.pickKey;
  app.pick = pick;
  const champName = dd.champions[pick.championId]?.name || `Champion ${pick.championId}`;
  if (pick.gameMode === 'CHERRY' || !buildMode(pick.gameMode, pick.mapId)) {
    app.applied = { pickKey, itemKey };
    app.pickStatus = 'Champion select - ingen builds til denne spiltype.';
    return log(pick.gameMode === 'CHERRY'
      ? `${champName}: Arena har ingen runer - springer over.`
      : `${champName}: spiltypen ${pick.gameMode} har ingen builds hos OP.GG - springer over.`);
  }

  if (fullApply) {
    app.build = null;
    app.rec = null;
    app.runeIndex = 0;
    app.appliedSpells = null;
    app.appliedPerks = null;
    app.plan = null; // gameplanen fra en anden champion/rolle må ikke blive stående
    app.planKey = null;
    const position = app.roleOverride || POSITION_MAP[pick.assignedPosition];
    try {
      app.build = await getBuild(cfg, pick.championId, position, pick.gameMode, pick.mapId);
    } catch (e) {
      // Nøglerne sættes først når buildet er hentet: løkken prøver igen med stigende pause (15 sek. -> 1 min).
      const n = app.pickRetry?.pickKey === pickKey ? app.pickRetry.n + 1 : 1;
      const waitS = Math.min(15 * n, 60);
      app.pickRetry = { pickKey, n, at: Date.now() + waitS * 1000 };
      app.applied = { pickKey: null, itemKey: null };
      app.pickStatus = `Champion select - kunne ikke hente build fra OP.GG, prøver igen om ${waitS} sek.`;
      log(`Kunne ikke hente build til ${champName}: ${e.message}`);
      return;
    }
  }
  if (!app.build) return;
  app.applied = { pickKey, itemKey };
  app.pickRetry = null;
  const build = app.build;
  const matchupP = findMatchup(pick, build);
  const matchup = fullApply ? await Promise.race([matchupP, sleep(MATCHUP_WAIT_MS).then(() => PENDING)]) : await matchupP;
  if (matchup === PENDING) {
    // OP.GG er langsom: sæt runer/summoners/item set nu, og skift til matchup-data når de kommer
    // (runerne kun hvis auto-siden er urørt - samme vej som når modstanderholdet ændrer sig).
    await applyRec(pick, null, true);
    matchupP
      .then((m) => m && serial(() => {
        if (app.build !== build || app.applied.itemKey !== itemKey) return;
        return applyRec(pick, m, false);
      }))
      .then(() => broadcast(), (e) => log(`Fejl: ${e.message}`));
  } else {
    await applyRec(pick, matchup, fullApply);
  }
  app.pickStatus = 'Champion select - build sat.';
}

// Anbefaling ud fra buildet + (evt.) lane-modstanderen, og sæt runer, summoners og item set.
// Hvert trin har sin egen fejlhåndtering, så en afvist rune-side ikke også koster spells og item set.
async function applyRec(pick, matchup, fullApply) {
  const { cfg } = app;
  const champName = dd.champions[pick.championId]?.name || `Champion ${pick.championId}`;
  const step = async (what, fn) => {
    try { await fn(); } catch (e) { log(`Fejl (${what}): ${e.message}`); }
  };
  const prevMatchup = app.rec?.matchup?.id ?? null;
  app.rec = recommend(app.build.build, cfg, pick.enemyIds, matchup, pick.gameMode === 'ARAM' ? 12 : 11);
  const matchupChanged = (app.rec.matchup?.id ?? null) !== prevMatchup;
  // Rune-valgene kan være omrokeret (matchup-side først) - peg på den side der faktisk er sat.
  if (app.appliedPerks) app.runeIndex = app.rec.runeOptions.findIndex((r) => perkKey(r) === app.appliedPerks);
  // Gameplan mod lane-modstanderen og jungle-ruter (i baggrunden - runer/items venter ikke på dem).
  if (app.rec.matchup) ensurePlan(pick.championId, app.rec.matchup.id, app.build.position, app.build.build);
  else { app.plan = null; app.planKey = null; }
  ensureJungleRoutes(String(pick.championId), app.build.position);

  if (fullApply) {
    const stats = roleStats(app.build);
    log(`${champName} (${app.build.position}) - patch ${app.build.build.version || '?'}` +
      (app.build.build.thinPatch ? ` (${app.build.build.newestVersion} har for få kampe endnu)` : '') +
      (stats ? `, ${stats.play.toLocaleString('da-DK')} kampe, ${pct(stats.winRate)} WR (${stats.scope})` : ''));
    if (cfg.setRunes && app.rec.runeOptions.length) await step('runer', () => applyRuneChoice(0));
    if (cfg.setSpells && app.rec.spells) {
      await step('summoners', async () => {
        app.appliedSpells = await applySpells(app.client, cfg, pick.me, app.rec.spells);
        log(`  Summoners: ${spellName(app.appliedSpells[0])} (D) + ${spellName(app.appliedSpells[1])} (F)`);
      });
    }
    if (app.rec.skills.start.length) log(`  Skills: start ${app.rec.skills.start.join(' > ')}, max ${app.rec.skills.max.join(' > ')}`);
  } else {
    log(matchupChanged && app.rec.matchup
      ? `Lane-modstander: ${app.rec.matchup.name}${app.rec.matchup.manual ? ' (valgt manuelt)' : ''} - opdaterer for ${champName}.`
      : `Modstanderholdet ændrede sig - opdaterer items for ${champName}.`);
    const top = app.rec.runeOptions[0];
    if (cfg.setRunes && top?.matchup && app.appliedPerks && perkKey(top) !== app.appliedPerks) {
      // Matchup-runer kun hvis du ikke selv har ændret auto-siden.
      await step('runer', async () => {
        if (await autoPageUntouched()) {
          await applyRuneChoice(0);
          log(`  Runer skiftet til matchuppet mod ${top.matchup}.`);
        } else {
          log(`  Du har selv ændret rune-siden - matchup-runerne mod ${top.matchup} ligger som fane i vinduet.`);
        }
      });
    }
  }
  await step('item set', applyItems);
}

async function autoPageUntouched() {
  try {
    const page = await lcu(app.client, 'GET', '/lol-perks/v1/currentpage');
    return Boolean(page?.name?.startsWith(PREFIX)) && (page.selectedPerkIds || []).join(',') === app.appliedPerks;
  } catch {
    return false;
  }
}

// b = buildet da opslaget startede (app.build kan skifte undervejs, fx ved rolleskift).
async function findMatchup(pick, b = app.build) {
  if (!b || !POSITIONS.includes(b.position)) return null; // ARAM/URF har ingen lane-modstander
  const id = app.opponentOverride ?? await laneOpponent(app.cfg, b.position, pick.enemyIds);
  if (!id) return null;
  let build = null;
  try {
    build = await fetchBuild(app.cfg.region, 'ranked', pick.championId, b.position, id);
  } catch (e) {
    log(`  Kunne ikke hente matchup-data: ${e.message}`);
  }
  return { id, build, stats: matchupStats(b.build, id), manual: app.opponentOverride != null };
}

// Første rigtige champion select: gem formen af klientens svar (felter og typer - ingen navne eller id'er
// på spillere) i lcu-shapes.json, så programmets antagelser om LCU-felterne kan tjekkes bagefter.
// Kun én gang: slet filen for at få en ny.
const SHAPES_FILE = process.env.LOL_HELPER_SHAPES || path.join(APP_DIR, 'lcu-shapes.json');
const SHAPE_VALUES = new Set(['type', 'assignedPosition', 'gameMode', 'phase', 'position', 'cellId', 'actorCellId', 'localPlayerCellId',
  'championId', 'championPickIntent', 'spell1Id', 'spell2Id', 'ownedPageCount', 'mapId', 'id', 'isDeletable', 'current',
  'completed', 'isInProgress', 'isEditable', 'isActive', 'isValid']);
function shapeOf(v, key, depth = 0) {
  if (Array.isArray(v)) {
    const seen = new Map();
    for (const x of v.slice(0, 5)) { const s = shapeOf(x, key, depth + 1); seen.set(JSON.stringify(s), s); }
    return [...seen.values(), `(${v.length} stk.)`];
  }
  if (v && typeof v === 'object') {
    return depth > 6 ? 'object' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, k, depth + 1)]));
  }
  if (v === null || v === undefined) return null;
  return SHAPE_VALUES.has(key) && typeof v !== 'string' ? v : SHAPE_VALUES.has(key) && String(v).length <= 20 ? v : typeof v;
}

async function logLcuShapes(session) {
  if (app.shapesLogged || (process.env.LOL_HELPER_LCU && !process.env.LOL_HELPER_SHAPES)) return; // ikke mod testklienten
  app.shapesLogged = true;
  if (fs.existsSync(SHAPES_FILE)) return;
  const get = (p) => lcu(app.client, 'GET', p).catch((err) => ({ fejl: err.status || err.message }));
  const summoner = await get('/lol-summoner/v1/current-summoner');
  const out = {
    version: VERSION,
    champSelect: session,
    gameflow: await get('/lol-gameflow/v1/session'),
    pages: await get('/lol-perks/v1/pages'),
    inventory: await get('/lol-perks/v1/inventory'),
    currentpage: await get('/lol-perks/v1/currentpage'),
    summoner,
    itemSets: summoner?.summonerId ? await get(`/lol-item-sets/v1/item-sets/${summoner.summonerId}/sets`) : null,
  };
  try {
    fs.writeFileSync(SHAPES_FILE, JSON.stringify({ date: new Date().toISOString(), ...shapeOf(out) }, null, 1));
    log(`Klientens dataformat gemt i ${path.basename(SHAPES_FILE)} (kun felter og typer).`);
  } catch {}
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
    app.pickRetry = null;
    app.pickStatus = null;
    app.prefetched = null;
    if (app.draft || app.draftKey || app.draftStatus) { app.draft = null; app.draftKey = null; app.draftStatus = null; }
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
    // Hent buildet allerede mens du hover, så runerne sættes i samme sekund du låser
    // (og matchup-buildet, når lane-modstanderen er kendt fra draften).
    const hover = me?.championId || me?.championPickIntent;
    const hoverPos = app.roleOverride || POSITION_MAP[me?.assignedPosition];
    const hoverOpp = app.draft?.opponent;
    const prefetch = `${hover}|${hoverOpp || ''}`;
    if (hover > 0 && prefetch !== app.prefetched) {
      app.prefetched = prefetch;
      getBuild(cfg, hover, hoverPos, 'CLASSIC').catch(() => {});
      if (hoverOpp && POSITIONS.includes(hoverPos)) fetchBuild(cfg.region, 'ranked', hover, hoverPos, hoverOpp).catch(() => {});
    }
    return cfg.pollMs;
  }
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0).sort((a, b) => a - b);
  const pickKey = `${me.championId}:${me.assignedPosition}:${app.roleOverride || ''}`;
  const itemKey = `${pickKey}|${enemyIds.join(',')}|${app.opponentOverride ?? ''}`;
  // Fejlede buildet sidst, ventes der lidt før næste forsøg (handlePick sætter pausen).
  const retryWait = app.pickRetry?.pickKey === pickKey && Date.now() < app.pickRetry.at;
  if ((pickKey !== app.applied.pickKey || itemKey !== app.applied.itemKey) && !retryWait) {
    let gameMode = app.pick?.gameMode;
    let mapId = app.pick?.mapId;
    if (pickKey !== app.applied.pickKey || !app.pick) {
      setStatus('Champion select - henter build...');
      // Svarer klienten ikke, prøves igen næste gang i stedet for at gætte på Summoner's Rift.
      const flow = await lcu(app.client, 'GET', '/lol-gameflow/v1/session').catch(() => null);
      if (!flow) return cfg.pollMs;
      gameMode = flow.gameData?.queue?.gameMode || flow.map?.gameMode || 'CLASSIC';
      mapId = flow.map?.id ?? flow.gameData?.queue?.mapId;
    }
    await serial(() => handlePick({ championId: me.championId, assignedPosition: me.assignedPosition, gameMode, mapId, me, enemyIds }, pickKey, itemKey));
    broadcast();
    logLcuShapes(session).catch(() => {});
  }
  setStatus(app.pickStatus || 'Champion select - build sat.');
  return cfg.pollMs;
}

// ---------- Kun én kopi ----------
// Låsefil pr. port med pid + den port der faktisk lyttes på. Lægges FØR Data Dragon hentes, så to hurtige
// starter (dobbeltklik, autostart + klik) ikke begge starter, og en kopi der lytter på port+1 også findes.
const instanceLockFile = (port) => path.join(os.tmpdir(), `lol-rune-helper-${port}.lock`);
const instanceLock = { file: null };

function claimInstanceLock(port, actualPort = null) {
  if (!port) return;
  instanceLock.file = instanceLockFile(port);
  try { fs.writeFileSync(instanceLock.file, JSON.stringify({ pid: process.pid, port: actualPort })); } catch {}
}

// Returnerer { pid, port } for en anden kørende kopi, eller null (så ejer vi låsen).
async function otherInstance(port) {
  const file = instanceLockFile(port);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: null }), { flag: 'wx' });
      instanceLock.file = file;
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') return null; // kan ikke låse (fx skrivebeskyttet temp) - fortsæt som før
    }
    let other = null;
    try { other = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (other?.pid && other.pid !== process.pid && pidAlive(other.pid)) {
      // Den anden kopi starter stadig (henter data): vent op til 30 sek. på at den lytter.
      for (let i = 0; i < 60 && !other.port && pidAlive(other.pid); i++) {
        await sleep(500);
        try { other = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      }
      if (pidAlive(other.pid)) return other;
    }
    fs.rmSync(file, { force: true }); // efterladt af en kopi der ikke kører mere
  }
  return null;
}

process.on('exit', () => {
  if (!instanceLock.file) return;
  try {
    if (JSON.parse(fs.readFileSync(instanceLock.file, 'utf8')).pid === process.pid) fs.rmSync(instanceLock.file, { force: true });
  } catch {}
});

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
  if (updated) {
    claimInstanceLock(app.cfg.port); // den gamle version lukker om lidt - overtag låsen
    try { fs.writeFileSync(UPDATE_PIDFILE, String(process.pid)); } catch {} // så den gamle kan stoppe os, hvis vi ikke kommer op
  }
  if (RUNS_FROM_ZIP) log(`OBS: ${ZIP_HINT}`);

  // Kører programmet allerede? Så åbn bare dets vindue i stedet for at starte en kopi.
  const other = app.cfg.port && !updated ? await otherInstance(app.cfg.port) : null;
  const runningPort = other?.port || app.cfg.port;
  if (app.cfg.port && !updated) {
    try {
      const running = await fetch(`http://127.0.0.1:${runningPort}/state`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      if (running && 'ddVersion' in running) {
        console.log('LoL Rune Helper kører allerede - åbner vinduet.');
        // Bed den kørende kopi om at tjekke for opdatering (ældre versioner svarer 404 - det er ok).
        fetch(`http://127.0.0.1:${runningPort}/api/check-update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }).catch(() => {});
        if (!process.argv.includes('--autostart')) openBrowser(`http://127.0.0.1:${runningPort}`);
        setTimeout(() => process.exit(0), 1500);
        return;
      }
    } catch {}
  }

  log(`LoL Rune Helper ${VERSION} starter...`);
  // Vinduet startes før Data Dragon, så det kan vise "Venter på internet" i stedet for at programmet lukker.
  setupRemote(app.cfg);
  const port = await startWindowServer(app.cfg.port);
  claimInstanceLock(app.cfg.port, port);
  const url = `http://127.0.0.1:${port}`;
  log(`Vindue: ${url}`);
  if (app.remote.enabled) {
    app.remote.urls = remoteUrls(port);
    for (const u of app.remote.urls) log(`Telefon (${u.label}): ${u.url}`);
  }
  setAllowedHosts(port);
  if (app.cfg.openWindow) openBrowser(url);
  const ddVersion = await loadStaticDataWithRetry();
  if (IS_SEA) {
    // Ryd op efter en opdatering først nu, hvor vi lytter OG har data (= den gamle version har set os som sunde):
    // indtil da kan den gamle version rulle tilbage til .old.
    // På Windows er .old låst, til den gamle proces er lukket - prøv derfor igen lidt senere.
    fs.rm(UPDATE_PIDFILE, { force: true }, () => {});
    // Aldrig mens en opdatering kører: så er .old den backup, der skal rulles tilbage til.
    const rmOld = () => { if (!updateRunning) fs.rm(`${process.execPath}.old`, { force: true }, () => {}); };
    rmOld();
    setTimeout(rmOld, 5000).unref();
    setTimeout(rmOld, 60000).unref();
  }
  log(`Data Dragon ${ddVersion} hentet. Builds fra OP.GG (${app.cfg.region}, ${app.cfg.buildChoice}).`);
  setInterval(refreshStaticData, 15 * 60 * 1000); // ny patch / tilbage fra offline
  if (app.cfg.liveAdvice) liveLoop();
  pruneCache();
  setInterval(pruneCache, 3600 * 1000);
  if (app.cfg.autoUpdate) {
    checkUpdate();
    setInterval(checkUpdate, 3600 * 1000); // hver time
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
