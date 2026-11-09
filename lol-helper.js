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
  scouting: true,         // lane-modstanderen (og fjendens jungler) på OP.GG: kampe og win rate på championen denne sæson + rank
  enemyJungle: true,      // fjendens junglers mest spillede første clear (OP.GG) i champion select og de første 4 min
  matchReview: true,      // kampgennemgang efter kampen fra klientens timeline (kort, guldkurve, rute, items)
  patterns: true,         // dine mønstre på tværs af kampe (kun med mindst 10 kampe på champion + rolle)
  climbCheck: true,       // klatre-tjek: de kendte low elo-huller (dødsfald, vision, CS, objectives, tilt) målt i dine egne kampe
  coach: true,            // coach: 3-5 konkrete ændringer i din spillestil (drage, roams, ganks, sidelanes) målt i dine kampe - kun før/efter kampen
  obsClips: false,        // video af dine dødsfald via OBS' replay buffer (OBS 28+ med WebSocket slået til)
  obsPassword: '',        // OBS WebSocket-adgangskode (logges aldrig)
  obsPort: 4455,
  // "Se det i replayet": hop til øjeblikket i League's eget replay. Kræver EnableReplayApi=1 i League's game.cfg,
  // som programmet KUN sætter når du slår "Replay-spring" til i vinduet (med backup - samme knap slår det fra igen).
  replayJump: false,
  championPool: true,     // "Din champion-pulje": win rate, form og mastery pr. champion i hver rolle + én linje i champion select
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
  const installDir = /--install-directory=(.+?)(?="|\s+"?--|$)/m.exec(cmdline);
  if (port && token) return { protocol: 'https', port: Number(port[1]), password: token[1], dir: installDir ? installDir[1].trim() : null };

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
      if (Number(p) > 0 && password && (!(Number(pid) > 0) || pidAlive(pid))) return { protocol, port: Number(p), password, dir: path.dirname(file) };
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
const ALL_CAMPS = Object.keys(CAMP_NAMES);
// Summoner's Rift: blå side (base nederst til venstre) har Blue/Gromp/Wolves på top-siden og Red/Raptors/Krugs på bot-siden.
// Rød side (base øverst til højre) er spejlet: Red/Raptors/Krugs på top-siden, Blue/Gromp/Wolves på bot-siden.
const TOP_SIDE_CAMPS = { BLUE: new Set(['BLUE', 'GROMP', 'WOLVES']), RED: new Set(['RED', 'RAPTORS', 'KRUG']) };

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
    // Hvilken side af kortet første clear starter og slutter på - over ALLE ruter der er en fuld clear af egen jungle
    // (alle 6 camps én gang). Ren kort-geometri, se TOP_SIDE_CAMPS.
    const full = routes.filter((r) => r.route.length === 6 && ALL_CAMPS.every((c) => r.route.includes(c)));
    const fullGames = full.reduce((s, r) => s + r.play, 0);
    if (fullGames > 0) {
      const top = TOP_SIDE_CAMPS[side];
      out.sides = out.sides || {};
      out.sides[side] = {
        games: fullGames,
        startTop: full.filter((r) => top.has(r.route[0])).reduce((s, r) => s + r.play, 0) / fullGames,
        endTop: full.filter((r) => top.has(r.route[5])).reduce((s, r) => s + r.play, 0) / fullGames,
      };
    }
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
  return cachedJson(`jungle2_${championKey}`, async () => { // 2: med start/slut-side (v1.18)
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

// ---------- Fjendens jungler: første clear (OP.GG jungle-paths) ----------
// Kun det OP.GG's ruter siger (start- og slutside, top 3 ruter med andel) - ingen gættede tidspunkter.
// Champion select: jungleren gættes ud fra rollefordelingen (som lane-modstanderen), siden fra myTeam[].team
// (1 = blå, 2 = rød; fjenden er den anden). I kampen: position JUNGLE eller den eneste med Smite.

// Samme opslag laves ikke igen; fejlede det, prøves igen efter 1 min (stille - ingen fejltekst).
const ejDone = (key) => app.ejKey === key && !(app.ejFailAt && Date.now() - app.ejFailAt > 60000);

function setEnemyJungle(champKey, side, guessed, key) {
  app.ejKey = key;
  app.ejFailAt = 0;
  fetchJungleRoutes(champKey)
    .then((routes) => {
      if (app.ejKey !== key) return;
      app.enemyJungle = { key: String(champKey), side, guessed, routes };
      broadcast();
    })
    .catch(() => { if (app.ejKey === key) app.ejFailAt = Date.now(); });
}

function updateEnemyJungleSelect(session, me) {
  if (!app.cfg.enemyJungle) return;
  const enemyIds = (session.theirTeam || []).map((m) => m.championId).filter((id) => id > 0).sort((a, b) => a - b);
  const enemySide = me?.team === 1 ? 'RED' : me?.team === 2 ? 'BLUE' : null;
  const key = `select|${enemyIds.join(',')}|${enemySide}`;
  if (ejDone(key)) return;
  app.ejKey = key;
  app.ejFailAt = 0;
  if (!enemyIds.length) { if (app.enemyJungle) { app.enemyJungle = null; broadcast(); } return; }
  laneOpponent(app.cfg, 'JUNGLE', enemyIds)
    .then((jg) => {
      if (app.ejKey !== key) return;
      if (!jg) { if (app.enemyJungle) { app.enemyJungle = null; broadcast(); } return; }
      setEnemyJungle(String(jg), enemySide, true, key);
    })
    .catch(() => { if (app.ejKey === key) app.ejFailAt = Date.now(); });
}

function updateEnemyJungleLive(L) {
  if (!app.cfg.enemyJungle || L.gameTime >= 240) return;
  const smiters = L.enemies.filter((p) => p.hasSmite);
  const jg = L.enemies.find((p) => p.position === 'JUNGLE') || (smiters.length === 1 ? smiters[0] : null);
  const side = L.me.team === 'ORDER' ? 'RED' : 'BLUE';
  if (!jg?.champ) return;
  const key = `live|${jg.champ.key}|${side}`;
  if (ejDone(key)) return;
  // Samme champion som i champion select: behold kortet, men nu med sikker side og jungler.
  if (app.enemyJungle?.key === String(jg.champ.key)) {
    app.ejKey = key;
    app.enemyJungle = { ...app.enemyJungle, side, guessed: false };
    return;
  }
  setEnemyJungle(String(jg.champ.key), side, false, key);
}

const pct0 = (x) => `${Math.round(x * 100)}%`;
function enemyJungleView() {
  const ej = app.enemyJungle;
  if (!ej?.routes) return null;
  const champ = champView(ej.key);
  const sideName = { BLUE: 'blå side', RED: 'rød side' };
  const sides = ej.side ? [ej.side] : ['BLUE', 'RED'].filter((s) => ej.routes[s]);
  const perSide = sides.map((side) => {
    const st = ej.routes.sides?.[side];
    let text = null;
    if (st) {
      const start = st.startTop >= 0.5 ? `starter på top-siden i ${pct0(st.startTop)}` : `starter på bot-siden i ${pct0(1 - st.startTop)}`;
      const end = st.endTop >= 0.5 ? `første clear ender på top-siden i ${pct0(st.endTop)}` : `første clear ender på bot-siden i ${pct0(1 - st.endTop)}`;
      text = `${champ.name} (${sideName[side]}): ${start} af kampene, ${end}`;
    }
    return {
      side,
      text,
      games: st?.games ?? null,
      routes: (ej.routes[side] || []).map((r) => ({ camps: r.route.map((c) => CAMP_NAMES[c] || c), share: r.share, games: r.play })),
    };
  }).filter((x) => x.text || x.routes.length);
  return perSide.length ? { champion: champ, guessed: ej.guessed, sides: perSide } : null;
}

// ---------- Spejder: lane-modstanderen og fjendens jungler på OP.GG ----------
// OP.GG's offentlige MCP-tjeneste (lol_get_summoner_profile): ranked-kampe pr. champion denne sæson + rank.
// Svaret er OP.GG's kompakte "class"-format (ikke JSON) - parseOpggText læser det. Fejler noget, vises intet.

// "class Summoner: game_name,tagline\n\nLolGetSummonerProfile(Data(Summoner(\"x\",\"y\")))" -> { data: { summoner: { game_name, tagline } } }
function parseOpggText(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const classes = {};
  const lines = t.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^class (\w+):\s*(.*)$/.exec(lines[i]);
    if (!m) { if (lines[i].trim()) break; continue; }
    classes[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  const src = lines.slice(i).join('\n');
  let p = 0;
  const fail = () => { throw new Error('OP.GG: uventet svarformat'); };
  const ws = () => { while (p < src.length && /\s/.test(src[p])) p++; };
  const list = (end) => {
    const out = [];
    ws();
    if (src[p] === end) { p++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (src[p] === ',') { p++; continue; }
      if (src[p] === end) { p++; return out; }
      fail();
    }
  };
  const value = () => {
    ws();
    const c = src[p];
    if (c === '"') {
      const s = p;
      for (p++; p < src.length && src[p] !== '"'; p++) if (src[p] === '\\') p++;
      p++;
      try { return JSON.parse(src.slice(s, p)); } catch { return src.slice(s + 1, p - 1); }
    }
    if (c === '[') { p++; return list(']'); }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_]\w*)/.exec(src.slice(p, p + 80));
    if (!m) fail();
    p += m[1].length;
    if (/^-?\d/.test(m[1])) return Number(m[1]);
    if (m[1] === 'null') return null;
    if (m[1] === 'true') return true;
    if (m[1] === 'false') return false;
    ws();
    if (src[p] !== '(') fail();
    p++;
    const args = list(')');
    const fields = classes[m[1]] || [];
    return Object.fromEntries(args.map((a, k) => [fields[k] || String(k), a]));
  };
  const root = value();
  // Yderste klasse (fx LolGetSummonerProfile) har ét felt: data.
  return root;
}

// Klientens region -> OP.GG-region. Kun regioner OP.GG har; GLOBAL kan ikke slå spillere op.
const OPGG_REGIONS = new Set(['NA', 'EUW', 'EUNE', 'KR', 'JP', 'BR', 'LAN', 'LAS', 'OCE', 'TR', 'RU', 'ME', 'SG', 'TW', 'VN', 'PH', 'TH']);
const PLATFORM_REGION = { NA1: 'NA', EUW1: 'EUW', EUN1: 'EUNE', JP1: 'JP', BR1: 'BR', LA1: 'LAN', LA2: 'LAS', OC1: 'OCE', TR1: 'TR', ME1: 'ME', SG2: 'SG', TW2: 'TW', VN2: 'VN', PH2: 'PH', TH2: 'TH' };
const toOpggRegion = (r) => {
  const v = String(r || '').toUpperCase();
  return OPGG_REGIONS.has(v) ? v : PLATFORM_REGION[v] || null;
};

// Region til opslag af spillere: klientens region (/riotclient/region-locale), ellers config.region hvis det er en rigtig region.
async function summonerRegion() {
  if (app.summonerRegion) return app.summonerRegion;
  if (app.client) {
    try {
      const r = await lcu(app.client, 'GET', '/riotclient/region-locale');
      const reg = toOpggRegion(r?.region) || toOpggRegion(r?.webRegion);
      if (reg) { app.summonerRegion = reg; return reg; }
    } catch {}
  }
  return toOpggRegion(app.cfg.region);
}

const SCOUT_FIELDS = [
  'data.summoner.ranked_most_champions.my_champion_stats[].{id,play,win}',
  'data.summoner.ranked_most_champions.{game_type,play,season_id,win}',
  'data.summoner.league_stats[].tier_info.{division,lp,tier}',
  'data.summoner.league_stats[].{game_type,lose,win}',
  'data.summoner.{updated_at}',
];

async function mcpCall(name, args, timeout = 20000) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'lol-rune-helper' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeout),
  });
  const j = await res.json();
  if (j.error || j.result?.isError) throw new Error(`OP.GG (${name}): ${String(j.error?.message || j.result?.content?.[0]?.text || 'fejl').slice(0, 120)}`);
  return parseOpggText(j.result?.content?.[0]?.text);
}

function fetchSummonerScout(region, gameName, tagLine) {
  // Spillernavne ikke i filnavnet: kort hash.
  const id = createHash('sha1').update(`${region}|${gameName}#${tagLine}`.toLowerCase()).digest('hex').slice(0, 16);
  return cachedJson(`scout_${id}`, async () => {
    const d = await mcpCall('lol_get_summoner_profile', { game_name: gameName, tag_line: tagLine, region, desired_output_fields: SCOUT_FIELDS });
    const s = d?.data?.summoner;
    if (!s || typeof s !== 'object') throw new Error('OP.GG: ingen spiller i svaret');
    const r = s.ranked_most_champions;
    return {
      updatedAt: s.updated_at || null,
      tiers: (Array.isArray(s.league_stats) ? s.league_stats : []).map((x) => ({
        type: x.game_type, tier: x.tier_info?.tier || null, division: x.tier_info?.division ?? null, lp: x.tier_info?.lp ?? null, win: x.win ?? null, lose: x.lose ?? null,
      })),
      ranked: r && typeof r === 'object' ? {
        play: Number(r.play) || 0,
        win: Number(r.win) || 0,
        champs: (Array.isArray(r.my_champion_stats) ? r.my_champion_stats : []).map((c) => ({ id: String(c.id), play: Number(c.play) || 0, win: Number(c.win) || 0 })),
      } : null,
    };
  });
}

const TIER_NAME = (t) => String(t).charAt(0) + String(t).slice(1).toLowerCase();
function rankText(tiers) {
  const solo = (tiers || []).find((t) => t.type === 'SOLORANKED' && t.tier);
  if (!solo) return null;
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(solo.tier);
  return apex ? `${TIER_NAME(solo.tier)} ${solo.lp ?? '?'} LP` : `${TIER_NAME(solo.tier)} ${solo.division ?? ''}`.trim();
}

// Tekst kun ud fra OP.GG's tal. Listen over mest spillede er afkortet (fx 10), så "ingen kampe på X" siges kun,
// når listens kampe tilsammen er alle spillerens ranked-kampe.
function scoutLines(s, champKey) {
  const name = dd.champions[champKey]?.name || '?';
  const r = s.ranked;
  const c = r?.champs.find((x) => x.id === String(champKey));
  let text;
  let voice = null;
  if (c && c.play > 0) {
    text = `${name}: ${c.play.toLocaleString('da-DK')} ranked-kampe, ${pct0(c.win / c.play)} WR denne sæson` + (r.play ? ` (${pct0(c.play / r.play)} af spillerens ranked-kampe)` : '');
    voice = `${name}: ${c.play} kampe, ${Math.round((c.win / c.play) * 100)} procent win rate`;
  } else if (r && r.play > 0) {
    const listed = r.champs.reduce((sum, x) => sum + x.play, 0);
    if (listed === r.play) {
      text = `Ingen ranked-kampe på ${name} denne sæson (${r.play.toLocaleString('da-DK')} ranked-kampe på andre champions)`;
      voice = `Ingen ranked-kampe på ${name} denne sæson`;
    } else {
      text = `${name} er ikke blandt spillerens ${r.champs.length} mest spillede i ranked denne sæson (${r.play.toLocaleString('da-DK')} ranked-kampe i alt)`;
    }
  } else {
    text = `Ingen ranked-kampe denne sæson ifølge OP.GG`;
  }
  const rank = rankText(s.tiers);
  let age = null;
  const at = Date.parse(s.updatedAt || '');
  if (at && Date.now() - at > 48 * 3600 * 1000) age = `OP.GG opdateret ${new Date(at).toLocaleDateString('da-DK')}`;
  return { text, voice, rank, age };
}

// Én gang pr. spiller pr. kamp: lane-modstanderen og (hvis det er en anden) fjendens jungler.
function ensureScout(L) {
  const g = app.game;
  if (!app.cfg.scouting || !g || !L) return;
  if (!g.scout) g.scout = new Map();
  const smiters = L.enemies.filter((p) => p.hasSmite);
  const jg = L.enemies.find((p) => p.position === 'JUNGLE') || (smiters.length === 1 ? smiters[0] : null);
  const targets = [];
  if (L.matchup?.player) targets.push({ p: L.matchup.player, role: 'lane' });
  if (jg && jg !== L.matchup?.player) targets.push({ p: jg, role: 'jungle' });
  for (const { p, role } of targets) {
    if (!p.champ || !p.riot?.gameName || !p.riot?.tagLine || p.isBot || g.scout.has(p.key)) continue;
    const entry = { role, champKey: String(p.champ.key), status: 'loading', result: null };
    g.scout.set(p.key, entry);
    (async () => {
      const region = await summonerRegion();
      if (!region) { entry.status = 'none'; return; }
      const s = await fetchSummonerScout(region, p.riot.gameName, p.riot.tagLine);
      entry.result = scoutLines(s, entry.champKey);
      entry.status = 'ok';
      if (app.game === g) {
        log(`Spejder: ${entry.result.text}${entry.result.rank ? ` · ${entry.result.rank}` : ''}`);
        if (entry.result.voice && L.gameTime < 300 && role === 'lane') speak('scout', entry.result.voice);
        broadcast();
      }
    })().catch(() => { entry.status = 'none'; }); // stille: intet vises
  }
}

function scoutView() {
  const g = app.game;
  if (!app.cfg.scouting || !g?.scout) return [];
  return [...g.scout.values()].filter((e) => e.status === 'ok' && e.result).map((e) => ({
    role: e.role,
    champion: champView(e.champKey),
    text: e.result.text,
    rank: e.result.rank,
    age: e.result.age,
  }));
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

// Bans mod én bestemt champion (den du hover/har valgt): dem den har lavest win rate imod.
function bansAgainst(champId, build, unavailable, name) {
  return (build?.counters || [])
    .filter((c) => c.play >= DRAFT_MIN_GAMES && c.champion_id !== champId && !unavailable.includes(c.champion_id))
    .map((c) => ({ id: c.champion_id, wr: c.win / c.play, games: c.play }))
    .filter((x) => x.wr < 0.5)
    .sort((a, b) => a.wr - b.wr)
    .slice(0, 3)
    .map((x) => ({ id: x.id, reason: `${name(champId)} vinder kun ${pct(x.wr)} mod ${name(x.id)} (${x.games.toLocaleString('da-DK')} kampe)` }));
}

async function analyzeDraft(cfg, position, enemyIds, unavailable, myChamp) {
  const pool = await myChampionPool(cfg, position);
  const builds = (await Promise.all(pool.map((id) => fetchBuild(cfg.region, 'ranked', id, position).then((b) => ({ id, b }), () => null)))).filter(Boolean);
  const name = (id) => dd.champions[id]?.name || String(id);

  // Har du valgt (hover/lås) en champion, bannes der mod den. Ellers mod hele din pulje.
  let bansFor = null;
  let champBans = [];
  if (myChamp > 0) {
    const own = builds.find((x) => x.id === myChamp)?.b
      || await fetchBuild(cfg.region, 'ranked', myChamp, position).catch((e) => { log(`  Ban-forslag til ${name(myChamp)}: ${e.message}`); return null; });
    champBans = bansAgainst(myChamp, own, unavailable, name);
    if (champBans.length) bansFor = myChamp;
  }

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
  const bans = bansFor ? champBans : [...threat]
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
  return { position, pool, bans, bansFor, opponent, poolVs, counters };
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
  // Din valgte champion: erklæret pick (hover før bans) eller den du hover/har låst.
  const myChamp = me.championPickIntent > 0 ? me.championPickIntent : me.championId > 0 ? me.championId : 0;
  const key = `${position}|${myChamp}|${enemyIds.sort().join(',')}|${[...new Set(unavailable)].sort().join(',')}`;
  const banChanged = app.draftBanTurn !== myBanTurn;
  app.draftBanTurn = myBanTurn;
  if (app.draft) app.draft.myBanTurn = myBanTurn;
  if (key === app.draftKey) {
    if (banChanged && app.draft) broadcast(); // din tur til at banne: vis det med det samme
    return;
  }
  app.draftKey = key;
  app.draftStatus = 'loading';
  analyzeDraft(app.cfg, position, enemyIds, unavailable, myChamp)
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
    const { games, recent, pendingClips, clipDir } = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^﻿/, ''));
    // Spring ødelagte/håndredigerede poster over i stedet for at fejle senere.
    return {
      games: Array.isArray(games) ? games.filter((g) => g && typeof g === 'object' && g.champion) : [],
      // Klientens kamphistorik (alle dine Summoner's Rift-kampe, også uden programmet): id, start, længde, sejr.
      recent: Array.isArray(recent) ? recent.filter((x) => x && typeof x.start === 'number' && typeof x.win === 'boolean') : [],
      // OBS-klip fra en kamp der kører (gemt med det samme, så en genstart midt i kampen ikke mister dem).
      pendingClips: Array.isArray(pendingClips) ? pendingClips.filter((p) => p && typeof p.file === 'string' && typeof p.t === 'number' && typeof p.at === 'number') : [],
      // OBS' optagemappe (GetRecordDirectory), husket til at finde klip efter en genstart.
      clipDir: typeof clipDir === 'string' && clipDir ? clipDir : null,
    };
  } catch {
    return { games: [], recent: [], pendingClips: [], clipDir: null };
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
    const death = { t: e.EventTime, at: Date.now(), killer: what, helpers: (e.Assisters || []).length, context: killer ? duelContext(L.me, killer) : null };
    g.deaths.push(death);
    obsClipDeath(g, death); // gør intet med obsClips slået fra
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
  // Til kampgennemgangen: kampens id (fra klienten) og hvem der var lane-modstander/fjendens jungler.
  if (g.gameId === undefined && app.client && app.cfg.matchReview) {
    g.gameId = null;
    lcu(app.client, 'GET', '/lol-gameflow/v1/session')
      .then((flow) => { const id = Number(flow?.gameData?.gameId); if (id > 0) g.gameId = id; })
      .catch(() => {});
  }
  if (L.matchup?.player?.champ) g.oppKey = String(L.matchup.player.champ.key);
  const smiters = L.enemies.filter((p) => p.hasSmite);
  const ejg = L.enemies.find((p) => p.position === 'JUNGLE') || (smiters.length === 1 ? smiters[0] : null);
  if (ejg?.champ) g.jgKey = String(ejg.champ.key);
  g.team = L.me.team === 'CHAOS' ? 'RED' : 'BLUE';
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
  app.enemyJungle = null;
  app.ejKey = null;
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

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1)); } catch (e) { log(`Kunne ikke gemme historik: ${e.message}`); }
}

function finishGame() {
  const g = app.game;
  const plan = app.plan;
  app.game = null;
  clearPick();
  obsCloseSoon();
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
  summary.deathLog = g.deaths; // samme objekter: et OBS-klip der bliver færdigt efter kampen, havner også her
  // Klippene står nu i kampen selv - de midlertidige poster (gemt under kampen) er ikke længere nødvendige.
  history.pendingClips = history.pendingClips.filter((p) => !g.deaths.some((d) => d.clip === p.file));
  summary.lessons = lessonsFor(summary, srGames().filter((x) => x.championId === summary.championId).slice(0, 10));
  // Til kampgennemgangen (kun id'er - selve timelinen gemmes ikke).
  if (g.gameId) summary.gameId = g.gameId;
  summary.team = g.team || null;
  if (g.oppKey) summary.oppChampionId = Number(g.oppKey);
  if (g.jgKey) summary.enemyJunglerId = Number(g.jgKey);
  g.summary = summary;
  history.games.unshift(summary);
  history.games.length = Math.min(history.games.length, 100);
  saveHistory();
  if (app.cfg.matchReview) fetchReview(summary, REVIEW_ATTEMPTS).catch(() => {});
  app.recentAt = Date.now() - RECENT_REFRESH_MS + 60000; // klientens kamphistorik igen om 1 min (kampen skal nå at komme med)
  log(`Kampoversigt: ${summary.champion} ${summary.kills}/${summary.deaths}/${summary.assists}, ${String(summary.csPerMin).replace('.', ',')} CS/min` +
    (summary.followed != null ? `, ${pct(summary.followed)} af dine køb var blandt forslagene` : '') +
    (summary.duels?.length ? `, dueller mod ${summary.matchup.champion}: ${summary.duels.filter((d) => d.won).length}-${summary.duels.filter((d) => !d.won).length}` : ''));
}

// ---------- Kampgennemgang (timeline fra League-klienten) ----------
// /lol-match-history/v1/games/{id} (deltagere: participantId, teamId, championId, spells) og
// /lol-match-history/v1/game-timelines/{id} (frames pr. minut med participantFrames + events).
// Der gemmes kun et kort uddrag i history.json - aldrig selve timelinen.

const REVIEW_ATTEMPTS = 10;
const REVIEW_RETRY_MS = Number(process.env.LOL_HELPER_REVIEW_RETRY_MS) || 30000; // kampen dukker op i historikken lidt efter slut
const MAP_SIZE = 14870; // Summoner's Rift-koordinater 0-14870 på begge akser (0,0 = blå base nederst til venstre)
// Lanes (omtrentlig) ud fra tårnenes placering: top langs venstre og øverste kant, bot langs nederste og højre kant,
// mid på diagonalen. Inden for 1.300 enheder af linjen = i lanen.
const LANE_LINES = {
  Top: [[1300, 3000], [1300, 13600], [12000, 13600]],
  Mid: [[3200, 3200], [11700, 11700]],
  Bot: [[3000, 1300], [13600, 1300], [13600, 12000]],
};
function laneAt(x, y) {
  const segDist = ([ax, ay], [bx, by]) => {
    const dx = bx - ax; const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  let best = null;
  for (const [lane, pts] of Object.entries(LANE_LINES)) {
    for (let i = 1; i < pts.length; i++) {
      const d = segDist(pts[i - 1], pts[i]);
      if (d <= 1300 && (!best || d < best.d)) best = { lane, d };
    }
  }
  return best?.lane || null;
}
// Top-siden = over mid-diagonalen (y > x), bot-siden = under.
const mapSide = (x, y) => (y > x ? 'top' : 'bot');

function participantFrame(frame, id) {
  const pf = frame?.participantFrames;
  if (!pf) return null;
  if (Array.isArray(pf)) return pf.find((x) => x?.participantId === id) || null;
  return pf[id] || pf[String(id)] || null;
}

// Kampgennemgangens format. v1 (v1.18.0) fandt ingen lane-modstander i kampe uden live-data og
// forventede ITEM_PURCHASED-events, som klientens timeline ikke har - de hentes igen (se reviewOlderGames).
// v3 (v1.20.0) har også vision, Control Wards, CS pr. minut, objectives og dødstid (klatre-tjekket).
// v2-gennemgange vises stadig (REVIEW_MIN) og opgraderes af sig selv, hvis klienten stadig har kampen.
// v4 (v1.21.0) har også coachens tal: hvem der stod ved de store monstre, roams, ganks med dødsfald bagefter
// og dødsfald alene i en sidelane efter 20 min.
// v5 (v1.22.0) har også kampens patch (gameVersion) og platform (til "Se det i replayet": replays kan kun ses
// på samme patch, og filen hedder <platform>-<gameId>.rofl).
const REVIEW_VERSION = 5;
const REVIEW_MIN = 2;
// "Tæt på" et sted (coachen): 3.000 enheder. Valgt ud fra kortet, ikke ud fra præstation: i Tobias' 51 kampe
// døde dragen i median ved (9.837, 4.397) og Baron ved (5.007, 10.471); fra dragen er der ca. 3.100 enheder til
// bot-lanens midterlinje og ca. 3.850 til mid, fra Baron ca. 3.700 til top og 3.850 til mid (LANE_LINES).
// Inden for 3.000 = tættere på pitten end på nogen lane - dvs. i floden/junglen ved pitten, ikke i en lane.
const COACH_NEAR = 3000;
// Efter 20 min (Baron Nashor spawner ved 20:00 - League Wiki) tæller dødsfald alene i en sidelane.
const COACH_LATE_SEC = 20 * 60;
// Et gank "lykkes", når du får kill/assist og ikke selv dør inden for 30 sek. (en definition af "samme kamp").
const GANK_FIGHT_SEC = 30;
const EPIC_MONSTERS = ['DRAGON', 'HORDE', 'RIFTHERALD', 'BARON_NASHOR', 'ATAKHAN'];
// Dødstid (sek.) efter League Wikis formel (wiki.leagueoflegends.com/en-us/Death): BRW pr. level
// + BRW x TIF, hvor TIF vokser efter 15 min og har loft på 50 %.
const BRW = [10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
function respawnSeconds(level, tSec) {
  const brw = BRW[Math.max(1, Math.min(18, level || 1)) - 1];
  const m = tSec / 60;
  let tif = 0;
  if (m >= 45) tif = 21.75 + Math.ceil(2 * (m - 45)) * 1.45;
  else if (m >= 30) tif = 12.75 + Math.ceil(2 * (m - 30)) * 0.30;
  else if (m > 15) tif = Math.ceil(2 * (m - 15)) * 0.425;
  return brw * (1 + Math.min(50, tif) / 100);
}
// Objectives i klientens timeline: ELITE_MONSTER_KILL (monsterType) og BUILDING_KILL (teamId = bygningens ejer).
const OBJECTIVE_NAMES = { DRAGON: 'drage', HORDE: 'voidgrubs', RIFTHERALD: 'Rift Herald', BARON_NASHOR: 'Baron', ATAKHAN: 'Atakhan', TOWER: 'tårn', INHIBITOR: 'inhibitor' };
const LANE_POSITION = { TOP: 'Top', MID: 'Mid', ADC: 'Bot', SUPPORT: 'Bot', JUNGLE: 'Jungle' };
// Guld med tusindtalspunktum (1.250), uden at afhænge af Node's sprogdata.
const gnum = (x) => { const r = Math.round(x); return (r < 0 ? '-' : '') + String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };

// Hvem spillede hvor. Klientens egen timeline.lane/role er upålidelig (i Tobias' 51 kampe stod mid-spillere
// som NONE/SUPPORT, TOP/SOLO og BOTTOM/DUO, og en top-Darius som JUNGLE), så rollen findes ud fra
// positionerne: den lane man oftest står i minut 2-10 (laneAt). Smite = jungle.
// Det ramte den lane-modstander som live-API'et selv fandt i 19 af 19 kampe.
function assignLanes(parts, frames) {
  const minuteOf = (f, i) => (typeof f.timestamp === 'number' ? Math.round(f.timestamp / 60000) : i);
  const early = frames.filter((f, i) => minuteOf(f, i) >= 2 && minuteOf(f, i) <= 10);
  for (const p of parts) {
    if (p.spells.includes(11)) { p.lane = 'Jungle'; continue; }
    const n = { Top: 0, Mid: 0, Bot: 0 };
    for (const f of early) {
      const pos = participantFrame(f, p.id)?.position;
      const l = pos && typeof pos.x === 'number' ? laneAt(pos.x, pos.y) : null;
      if (l) n[l]++;
    }
    const [best, cnt] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    p.lane = cnt > 0 ? best : null;
  }
  // Bot-lanen: carry/support efter CS ved 10 min (flest minions = carry) - kun til at vælge den rigtige modstander.
  const f10 = early[early.length - 1];
  for (const team of new Set(parts.map((p) => p.team))) {
    const bot = parts.filter((p) => p.team === team && p.lane === 'Bot');
    if (bot.length !== 2) continue;
    const cs = (p) => participantFrame(f10, p.id)?.minionsKilled || 0;
    const [a, b] = bot;
    if (cs(a) === cs(b)) continue;
    (cs(a) > cs(b) ? a : b).botRole = 'carry';
    (cs(a) > cs(b) ? b : a).botRole = 'support';
  }
}

// Lane-modstanderen: 1) den live-API'et fandt under kampen, 2) samme lane ud fra positionerne,
// 3) klientens timeline.lane/role. Metoden gemmes (oppBy), så gennemgangen kan vise hvor sikker den er.
function findOpponent(me, enemies, s) {
  const live = s.oppChampionId ? enemies.find((p) => p.champ === String(s.oppChampionId)) : null;
  if (live) return { opp: live, by: 'live' };
  const lane = me.lane || LANE_POSITION[s.position];
  if (lane) {
    let same = enemies.filter((p) => p.lane === lane);
    if (same.length > 1 && me.botRole) same = same.filter((p) => p.botRole === me.botRole);
    if (same.length === 1) return { opp: same[0], by: 'position' };
  }
  // Klientens lane bruges kun når den passer med den rolle du selv spillede (den tager ofte fejl).
  const LCU_LANE = { TOP: 'Top', MIDDLE: 'Mid', BOTTOM: 'Bot', JUNGLE: 'Jungle' };
  const lcuSame = LCU_LANE[me.lcuLane] && LCU_LANE[me.lcuLane] === LANE_POSITION[s.position]
    ? enemies.filter((p) => p.lcuLane === me.lcuLane && (me.lcuLane !== 'BOTTOM' || p.lcuRole === me.lcuRole)) : [];
  if (lcuSame.length === 1) return { opp: lcuSame[0], by: 'client' };
  return { opp: null, by: null };
}

function buildReview(game, timeline, s) {
  const ids = new Map((game?.participantIdentities || []).map((pi) => [pi.participantId, pi.player || {}]));
  const parts = (game?.participants || []).map((p) => ({
    id: p.participantId, team: p.teamId, champ: String(p.championId), spells: [p.spell1Id, p.spell2Id], puuid: ids.get(p.participantId)?.puuid,
    lcuLane: p.timeline?.lane || null, lcuRole: p.timeline?.role || null, win: p.stats?.win,
  }));
  const me = (s.puuid && parts.find((p) => p.puuid && p.puuid === s.puuid)) || parts.find((p) => p.champ === String(s.championId));
  if (!me) return null;
  const frames = Array.isArray(timeline?.frames) ? timeline.frames : [];
  if (!frames.length) return null;
  assignLanes(parts, frames);
  const enemies = parts.filter((p) => p.team !== me.team);
  const { opp, by: oppBy } = findOpponent(me, enemies, s);
  const smiters = enemies.filter((p) => p.spells.includes(11));
  const jg = (s.enemyJunglerId && enemies.find((p) => p.champ === String(s.enemyJunglerId))) || (smiters.length === 1 ? smiters[0] : null);
  const champOf = (id) => parts.find((p) => p.id === id)?.champ || null;
  const minute = (f, i) => (typeof f.timestamp === 'number' ? Math.round(f.timestamp / 60000) : i);
  const pf = (f, id) => participantFrame(f, id);
  const pos = (f, id) => { const p = pf(f, id)?.position; return p && typeof p.x === 'number' ? [Math.round(p.x), Math.round(p.y)] : null; };
  const cs = (f, id) => { const p = pf(f, id); return p ? (p.minionsKilled || 0) + (p.jungleMinionsKilled || 0) : null; };
  // Guldforskel mod lane-modstanderen og mellem holdene pr. minut (totalGold i timelinen).
  const gold = opp ? frames.map((f, i) => {
    const a = pf(f, me.id)?.totalGold; const b = pf(f, opp.id)?.totalGold;
    return typeof a === 'number' && typeof b === 'number' ? [minute(f, i), a - b] : null;
  }).filter(Boolean) : [];
  const team = frames.map((f, i) => {
    let d = 0;
    for (const p of parts) { const g = pf(f, p.id)?.totalGold; if (typeof g !== 'number') return null; d += p.team === me.team ? g : -g; }
    return [minute(f, i), d];
  }).filter(Boolean);
  // Øjebliksbilleder ved 10 og 15 min: guld, CS og XP mod lane-modstanderen.
  const at = {};
  for (const m of [10, 15]) {
    const f = frames.find((x, i) => minute(x, i) === m);
    if (!f || !pf(f, me.id)) continue;
    const mine = pf(f, me.id); const theirs = opp ? pf(f, opp.id) : null;
    at[m] = {
      cs: cs(f, me.id),
      oppCs: theirs ? cs(f, opp.id) : null,
      gold: theirs && typeof mine.totalGold === 'number' ? mine.totalGold - theirs.totalGold : null,
      xp: theirs && typeof mine.xp === 'number' ? mine.xp - theirs.xp : null,
    };
  }
  const jungle = s.position === 'JUNGLE' || me.lane === 'Jungle';
  const events = frames.flatMap((f) => (Array.isArray(f.events) ? f.events : []));
  const sec = (e) => Math.round((e.timestamp || 0) / 1000);
  const kills = events.filter((e) => e.type === 'CHAMPION_KILL');
  // Din halvdel af kortet: blå = nederst til venstre (x + y < kortets størrelse).
  const ownHalf = (x, y) => (me.team === 200 ? x + y > MAP_SIZE : x + y < MAP_SIZE);
  const deaths = kills.filter((e) => e.victimId === me.id).map((e) => {
    const x = e.position?.x ?? null; const y = e.position?.y ?? null;
    return {
      t: sec(e), x, y, killer: champOf(e.killerId),
      // Fjendens jungler først: for en jungler er lane-modstanderen den samme.
      by: jg && e.killerId === jg.id ? 'jungle' : opp && e.killerId === opp.id ? 'lane' : 'other',
      // Antal fjender om drabet: drabsmanden + dem med assist (0 = tårn/minions).
      n: (e.killerId > 0 ? 1 : 0) + (Array.isArray(e.assistingParticipantIds) ? e.assistingParticipantIds.length : 0),
      zone: x == null ? null : laneAt(x, y) || 'Jungle',
      own: x == null ? null : ownHalf(x, y),
    };
  });
  const ganks = jungle ? kills.filter((e) => sec(e) < 600 && e.position && (e.killerId === me.id || (e.assistingParticipantIds || []).includes(me.id)))
    .map((e) => ({ t: sec(e), x: e.position.x, y: e.position.y, lane: laneAt(e.position.x, e.position.y), kill: e.killerId === me.id, victim: champOf(e.victimId) }))
    .filter((x) => x.lane) : [];
  // Din position minut for minut: junglere 1-8 (første clear), lanere 1-14 (laning-fasen i programmets faser, PHASES).
  const pathTo = jungle ? 8 : 14;
  const span = frames.filter((f, i) => minute(f, i) >= 1 && minute(f, i) <= pathTo);
  // Dødstid: level fra minuttet før dødsfaldet (participantFrames.level) + wikiens formel.
  const levelAt = (t) => { const f = [...frames].reverse().find((x, i) => minute(x, frames.length - 1 - i) * 60 <= t); return pf(f, me.id)?.level || 1; };
  for (const d of deaths) { d.lvl = levelAt(d.t); d.dead = Math.round(respawnSeconds(d.lvl, d.t)); }
  const deadAt = (t) => deaths.some((d) => t >= d.t && t <= d.t + d.dead);
  const teamOf = (id) => parts.find((p) => p.id === id)?.team;
  // Coach (v4): hvem der stod tæt på et sted omkring et tidspunkt. Timelinen har kun én position pr. minut, så
  // "tæt på" = inden for COACH_NEAR enheder i minut-billedet lige før ELLER lige efter tidspunktet (højst ca.
  // 30 sek. fra det ene af dem). Omtrentligt - derfor kun brugt til tællinger over mange kampe.
  const ms = (f, i) => (typeof f.timestamp === 'number' ? f.timestamp : i * 60000);
  const around = (t) => {
    const k = frames.findIndex((f, i) => ms(f, i) > t * 1000);
    return k === -1 ? [frames[frames.length - 1]] : k === 0 ? [frames[0]] : [frames[k - 1], frames[k]];
  };
  const nearAt = (id, x, y, t) => around(t).some((f) => { const p = pos(f, id); return p && Math.hypot(p[0] - x, p[1] - y) <= COACH_NEAR; });
  const objectives = events.filter((e) => e.type === 'ELITE_MONSTER_KILL' || e.type === 'BUILDING_KILL').map((e) => {
    const t = sec(e);
    const k = e.type === 'ELITE_MONSTER_KILL' ? e.monsterType : e.buildingType === 'INHIBITOR_BUILDING' ? 'INHIBITOR' : 'TOWER';
    // Monstre: holdet til den der fik det sidste slag. Bygninger: teamId er ejeren, så det andet hold tog den.
    const takenBy = e.type === 'ELITE_MONSTER_KILL' ? teamOf(e.killerId) : (e.teamId === 100 ? 200 : e.teamId === 200 ? 100 : null);
    if (!k || !takenBy) return null;
    const o = { t, k, mine: takenBy === me.team, dead: deadAt(t) };
    // Store monstre: var du (i live) tæt på, og hvor mange fra hvert hold stod tæt på (dig medregnet).
    if (EPIC_MONSTERS.includes(k) && e.position && typeof e.position.x === 'number') {
      const { x, y } = e.position;
      o.near = !o.dead && nearAt(me.id, x, y, t);
      o.al = parts.filter((p) => p.team === me.team && nearAt(p.id, x, y, t)).length;
      o.en = parts.filter((p) => p.team !== me.team && nearAt(p.id, x, y, t)).length;
    }
    return o;
  }).filter(Boolean);
  // Dødsfald i en sidelane (top/bot) efter Baron er kommet (20 min) uden en holdkammerat tæt på.
  for (const d of deaths) {
    if (d.t >= COACH_LATE_SEC && (d.zone === 'Top' || d.zone === 'Bot') && d.x != null) {
      d.alone = !parts.some((p) => p.team === me.team && p.id !== me.id && nearAt(p.id, d.x, d.y, d.t));
    }
  }
  // Roams (ikke-junglere): kills/assists før 14 min i en anden lane end din egen (positionen på drabet).
  const roams = !jungle && me.lane ? kills.filter((e) => sec(e) < 840 && e.position && (e.killerId === me.id || (e.assistingParticipantIds || []).includes(me.id)))
    .map((e) => ({ t: sec(e), lane: laneAt(e.position.x, e.position.y), kill: e.killerId === me.id }))
    .filter((x) => x.lane && x.lane !== me.lane) : [];
  // Ganks: døde du selv inden for 30 sek. efter?
  for (const gk of ganks) gk.died = deaths.some((d) => d.t >= gk.t && d.t <= gk.t + GANK_FIGHT_SEC);
  const st = game.participants.find((p) => p.participantId === me.id)?.stats || {};
  const num = (x) => (typeof x === 'number' ? x : null);
  const teamKills = (game.participants || []).filter((p) => p.teamId === me.team).reduce((a, p) => a + (p.stats?.kills || 0), 0);
  // CS (minions + jungle) ved hvert minut - index = minut.
  const csm = [];
  frames.forEach((f, i) => { const c = cs(f, me.id); if (c != null) csm[minute(f, i)] = c; });
  return {
    v: REVIEW_VERSION,
    dur: num(game.gameDuration),
    start: num(game.gameCreation),
    queue: num(game.queueId),
    gv: typeof game.gameVersion === 'string' && game.gameVersion ? game.gameVersion : null,
    pf: typeof game.platformId === 'string' && game.platformId ? game.platformId : null,
    stats: {
      vision: num(st.visionScore), wardsPlaced: num(st.wardsPlaced), wardsKilled: num(st.wardsKilled), controlWards: num(st.visionWardsBoughtInGame),
      kills: num(st.kills), deaths: num(st.deaths), assists: num(st.assists), teamKills,
      damage: num(st.totalDamageDealtToChampions), turretDamage: num(st.damageDealtToTurrets), objectiveDamage: num(st.damageDealtToObjectives),
      cs: typeof st.totalMinionsKilled === 'number' ? st.totalMinionsKilled + (st.neutralMinionsKilled || 0) : null,
    },
    csm: Array.from(csm, (x) => (x == null ? null : x)),
    objectives,
    side: me.team === 200 ? 'RED' : 'BLUE',
    win: typeof me.win === 'boolean' ? me.win : null,
    lane: me.lane,
    opp: opp?.champ || null,
    oppBy,
    jg: jg?.champ || null,
    deaths,
    gold,
    team,
    at,
    path: span.map((f) => pos(f, me.id)).filter(Boolean),
    pathTo,
    jgPath: jungle && jg ? frames.filter((f, i) => minute(f, i) >= 1 && minute(f, i) <= 8).map((f) => pos(f, jg.id)).filter(Boolean) : [],
    ganks,
    roams,
  };
}

// Gem formen (felter og typer, ingen navne) af klientens kamp + timeline én gang, så antagelserne kan tjekkes.
function logMatchShapes(game, timeline) {
  const file = path.join(path.dirname(SHAPES_FILE), 'match-shapes.json');
  if (app.matchShapesLogged || (process.env.LOL_HELPER_LCU && !process.env.LOL_HELPER_SHAPES) || fs.existsSync(file)) return;
  app.matchShapesLogged = true;
  const frames = timeline?.frames || [];
  const sample = { game, timeline: { ...timeline, frames: frames.slice(0, 3) } };
  try { fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), version: VERSION, ...shapeOf(sample) }, null, 1)); } catch {}
}

// Henter kampen fra klienten (prøver igen et stykke tid - kampen kommer først i historikken lidt efter slut).
async function fetchReview(summary, attempts) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(REVIEW_RETRY_MS);
    if (!app.client) continue;
    try {
      if (!summary.gameId) {
        const eog = await lcu(app.client, 'GET', '/lol-end-of-game/v1/eog-stats-block').catch(() => null);
        if (Number(eog?.gameId) > 0 && (!eog.gameLength || Math.abs(eog.gameLength - summary.duration) < 120)) summary.gameId = Number(eog.gameId);
        if (!summary.gameId) continue;
      }
      if (!summary.puuid && !app.puuid) {
        const me = await lcu(app.client, 'GET', '/lol-summoner/v1/current-summoner').catch(() => null);
        if (me?.puuid) app.puuid = me.puuid;
      }
      const [game, timeline] = await Promise.all([
        lcu(app.client, 'GET', `/lol-match-history/v1/games/${summary.gameId}`),
        lcu(app.client, 'GET', `/lol-match-history/v1/game-timelines/${summary.gameId}`),
      ]);
      logMatchShapes(game, timeline);
      const review = buildReview(game, timeline, { ...summary, puuid: app.puuid });
      if (!review) { lastErr = new Error('kampen kunne ikke læses'); continue; }
      summary.review = review;
      // Resultatet mangler, når kampen sluttede uden GameEnd-event i live-API'et: klienten ved det.
      if (!summary.result && review.win != null) summary.result = review.win ? 'Sejr' : 'Nederlag';
      saveHistory();
      // Nu kendes alle kampens dødsfald (og kampens starttid): OBS-klip der ikke nåede at blive koblet, kobles her.
      try { recoverClips(); } catch (e) { log(`Klip: kunne ikke gennemgå optagemappen (${e.message}).`); }
      log(`Kampgennemgang klar: ${summary.champion} (${review.deaths.length} dødsfald, ` +
        `${review.opp ? `mod ${dd.champions[review.opp]?.name || review.opp}` : 'ingen lane-modstander fundet'}, ${review.team.length} minutter guld).`);
      broadcast();
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  log(`Kampgennemgang: kampen kunne ikke hentes fra klienten${lastErr ? ` (${String(lastErr.message).slice(0, 120)})` : ''}.`);
  return false;
}

const BUSY_PHASES = ['ChampSelect', 'InProgress', 'GameStart', 'Reconnect'];
const reviewOutdated = (g) => g.review && !(g.review.v >= REVIEW_VERSION);
// Ældre kampe (uden gennemgang, eller med en gennemgang i et ældre format): find kampens id i klientens
// kamphistorik (samme champion, sluttede inden for 10 min af det gemte tidspunkt) og hent gennemgangen,
// hvis klienten stadig har den. Stopper hvis champion select eller en kamp går i gang undervejs.
async function reviewOlderGames(opts = {}) {
  if (!app.client) return { ok: false, error: 'League-klienten kører ikke' };
  const busy = async () => BUSY_PHASES.includes(await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase').catch(() => null));
  if (await busy()) return { ok: false, error: 'Ikke under champion select eller kamp' };
  const missing = srGames().slice(0, 50).filter((g) => (opts.outdatedOnly ? reviewOutdated(g) : !g.review || reviewOutdated(g)));
  if (!missing.length) return { ok: true, found: 0, tried: 0 };
  let list = [];
  if (missing.some((g) => !g.gameId)) {
    try {
      const j = await lcu(app.client, 'GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=50');
      list = j?.games?.games || [];
    } catch {}
  }
  let found = 0;
  for (const g of missing) {
    if (!g.gameId) {
      const end = Date.parse(g.date);
      const m = list.find((x) => x.participants?.[0]?.championId === g.championId && typeof x.gameCreation === 'number'
        && Math.abs(x.gameCreation + (x.gameDuration || 0) * 1000 - end) < 10 * 60 * 1000);
      if (!m) continue;
      g.gameId = m.gameId;
    }
    if (await busy()) break;
    if (await fetchReview(g, 1)) found++;
  }
  saveHistory();
  return { ok: true, found, tried: missing.length };
}

// Gennemgange fra v1.18.0 (uden lane-modstander/guld) hentes igen af sig selv én gang, når klienten er ledig.
function upgradeOldReviews(phase) {
  if (app.reviewUpgrade || !app.cfg.matchReview || BUSY_PHASES.includes(phase) || !srGames().some(reviewOutdated)) return;
  app.reviewUpgrade = 'running';
  reviewOlderGames({ outdatedOnly: true })
    .then((r) => { if (r.ok && r.tried) log(`Kampgennemgang: ${r.found} af ${r.tried} ældre gennemgange opdateret til det nye format.`); broadcast(); })
    .catch(() => {})
    .finally(() => { app.reviewUpgrade = 'done'; });
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// Gennemgange i det nuværende format (v1 mangler modstander og guld).
const reviewed = (gs) => gs.filter((g) => g.review?.v >= REVIEW_MIN);
const firstBuys = (g) => (g.buys || []).slice(0, 4).map((b) => ({ id: b.id, t: Math.round(b.t) }));

function reviewView() {
  if (!app.cfg.matchReview) return null;
  const all = srGames();
  const games = all.slice(0, 15).filter((g) => g.review || gameClips(g).length);
  return games.slice(0, 10).map((g) => {
    const r = g.review?.v >= REVIEW_MIN ? g.review : null;
    const item = (id) => ({ id, name: itemName(id), icon: dd.items[id]?.icon });
    // Din median for CS ved 10 min med samme champion og rolle (andre kampe med gennemgang).
    const same = reviewed(all).filter((x) => x !== g && x.championId === g.championId && x.position === g.position && typeof x.review.at?.[10]?.cs === 'number');
    const firstItem = firstItemTime(g);
    return {
      date: g.date,
      champion: g.champion,
      icon: dd.champions[g.championId]?.icon,
      result: g.result,
      position: g.position,
      jungle: g.position === 'JUNGLE',
      outdated: Boolean(g.review && !r),
      review: r ? {
        side: r.side,
        opp: r.opp ? champView(r.opp) : null,
        oppBy: r.oppBy,
        jg: r.jg ? champView(r.jg) : null,
        deaths: r.deaths.map((d) => ({ ...d, killer: d.killer ? dd.champions[d.killer]?.name || d.killer : null,
          beforeItem: firstItem != null ? d.t < firstItem : null, clip: clipAt(g, d.t) })),
        gold: r.gold,
        team: r.team,
        at: r.at,
        cs10Median: same.length >= 3 ? median(same.map((x) => x.review.at[10].cs)) : null,
        cs10Games: same.length,
        path: r.path,
        pathTo: r.pathTo,
        jgPath: r.jgPath,
        ganks: r.ganks.map((x) => ({ ...x, victim: x.victim ? dd.champions[x.victim]?.name || x.victim : null })),
        // Klientens timeline har ingen køb - de første færdige items kommer fra live-API'et under kampen.
        items: firstBuys(g).map((x) => ({ ...item(x.id), t: x.t })),
        climb: app.cfg.climbCheck ? safeView(() => gameLeaks(g)) : null,
        coach: app.cfg.coach ? safeView(() => coachGame(g)) : null,
      } : null,
      // Klip der ikke hører til et dødsfald i gennemgangen (eller kampe uden gennemgang) - de andre står ved dødsfaldet.
      // Klip uden kendt dødsfald (t = null, est = anslået kamptid) står her som "Andre klip fra kampen".
      clips: gameClips(g).filter((c) => !(r && c.t != null && r.deaths.some((x) => Math.abs(x.t - c.t) <= CLIP_MATCH_SEC)))
        .map((c) => ({ t: c.t, est: c.est ?? null, killer: c.killer, file: c.file, name: path.basename(c.file) })),
      gameId: g.gameId || null,
      replay: replayFor(g),
    };
  });
}

// ---------- Dine mønstre (på tværs af kampe) ----------
// Kun sammenhænge med tal ("7 af 9"), aldrig årsager. Kræver mindst 10 kampe i gruppen (champion + rolle,
// eller alle dine kampe i en rolle), og hver linje kræver selv mindst 10 kampe med de data den bygger på.
// Skillelinjer kommer fra dine egne data (median) - ingen faste tærskler.

const PATTERN_MIN_GAMES = 10;
const PHASES = [[0, 14, 'tidligt (0-14 min)'], [14, 25, 'midt (14-25 min)'], [25, Infinity, 'sent (25+ min)']];
function patternLines(games, oppLabel = 'lane-modstanderen') {
  const known = games.filter((g) => g.result === 'Sejr' || g.result === 'Nederlag');
  const wins = (gs) => gs.filter((g) => g.result === 'Sejr').length;
  const split = (label, a, b, la, lb) => (a.length && b.length
    ? `${label}: ${la} ${wins(a)} af ${a.length} sejre - ${lb} ${wins(b)} af ${b.length}` : null);
  const enough = (xs) => xs.length >= PATTERN_MIN_GAMES;
  const lines = [];
  // 1) Første færdige item før/efter din median.
  const withItem = known.map((g) => ({ g, t: firstItemTime(g) })).filter((x) => x.t != null);
  if (enough(withItem)) {
    const med = median(withItem.map((x) => x.t));
    const counts = new Map();
    for (const { g } of withItem) { const id = (g.buys || []).find((b) => !isBoots(dd.items[b.id]))?.id; if (id) counts.set(id, (counts.get(id) || 0) + 1); }
    const [topId, topN] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
    const line = split(`Første færdige item (din median ${mmss(med)})`, withItem.filter((x) => x.t < med).map((x) => x.g), withItem.filter((x) => x.t >= med).map((x) => x.g), 'før:', 'senere:');
    if (line) lines.push({ key: 'item', text: line + (topId ? ` (oftest ${itemName(topId)}, ${topN} af ${withItem.length} kampe)` : '') });
  }
  // 2) Dødsfald før 14 min (kill-feedet).
  const withDeaths = known.filter((g) => Array.isArray(g.deathLog));
  if (enough(withDeaths)) {
    const early = (g) => g.deathLog.some((d) => d.t < 840);
    const line = split('Dødsfald før 14 min', withDeaths.filter((g) => !early(g)), withDeaths.filter(early), 'ingen:', 'mindst ét:');
    if (line) lines.push({ key: 'deaths', text: line });
  }
  const rv = reviewed(games);
  const rvKnown = rv.filter((g) => known.includes(g));
  if (enough(rv)) {
    // 3) Hvor, til hvem og mod hvor mange (kampgennemgangen).
    const all = rv.flatMap((g) => g.review.deaths.map((d) => ({ ...d, g })));
    const early = all.filter((d) => d.t < 840);
    const n = rv.length;
    if (early.length) {
      const by = (k) => early.filter((d) => d.by === k).length;
      lines.push({ key: 'killer', text: `Dødsfald før 14 min (${early.length} i ${n} kampe): ` +
        (oppLabel === 'lane-modstanderen' ? `${by('lane')} til lane-modstanderen, ` : '') + `${by('jungle')} til fjendens jungler, ${by('other')} til andre` });
      const placed = early.filter((d) => d.zone);
      if (placed.length) {
        const own = placed.filter((d) => d.own).length;
        const inJungle = placed.filter((d) => d.zone === 'Jungle').length;
        lines.push({ key: 'where', text: `Hvor: ${placed.length - inJungle} af ${placed.length} i en lane, ${inJungle} i jungle/flod - ${placed.length - own} på fjendens halvdel af kortet` });
      }
    }
    if (all.length) {
      const c = (f) => all.filter(f).length;
      const towers = c((d) => d.n === 0);
      lines.push({ key: 'collapse', text: `Alle ${all.length} dødsfald (${n} kampe): ${c((d) => d.n === 1)} mod én, ${c((d) => d.n === 2)} mod to, ${c((d) => d.n >= 3)} mod tre eller flere` +
        (towers ? `, ${towers} til tårn/minions` : '') });
      // Før/efter første færdige item - som dødsfald pr. 10 min, da tiden før første item er kortere.
      const timed = rv.filter((g) => firstItemTime(g) != null);
      if (enough(timed)) {
        let a = 0; let b = 0; let ta = 0; let tb = 0;
        for (const g of timed) {
          const fi = firstItemTime(g);
          for (const d of g.review.deaths) (d.t < fi ? a++ : b++);
          ta += Math.min(fi, g.duration); tb += Math.max(0, g.duration - fi);
        }
        const rate = (k, t) => String(Math.round((k / (t / 600)) * 10) / 10).replace('.', ',');
        if (ta && tb) lines.push({ key: 'firstitem', text: `Før dit første færdige item: ${a} dødsfald (${rate(a, ta)} pr. 10 min) - efter: ${b} (${rate(b, tb)} pr. 10 min), ${timed.length} kampe` });
      }
    }
  }
  // 4) Guld og CS mod lane-modstanderen ved 10 og 15 min.
  for (const m of [10, 15]) {
    const at = rvKnown.map((g) => ({ g, d: g.review.at?.[m]?.gold })).filter((x) => typeof x.d === 'number' && x.d !== 0);
    if (!enough(at)) continue;
    const line = split(`Guld mod ${oppLabel} ved ${m} min`, at.filter((x) => x.d > 0).map((x) => x.g), at.filter((x) => x.d < 0).map((x) => x.g), 'foran:', 'bagud:');
    if (line) lines.push({ key: `gold${m}`, text: `${line} (median ${median(at.map((x) => x.d)) >= 0 ? '+' : ''}${gnum(median(at.map((x) => x.d)))} g)` });
  }
  const cs10 = rvKnown.map((g) => ({ g, cs: g.review.at?.[10]?.cs })).filter((x) => typeof x.cs === 'number');
  if (enough(cs10)) {
    const med = median(cs10.map((x) => x.cs));
    const line = split(`CS ved 10 min (din median ${Math.round(med)})`, cs10.filter((x) => x.cs > med).map((x) => x.g), cs10.filter((x) => x.cs <= med).map((x) => x.g), 'over:', 'median eller under:');
    if (line) lines.push({ key: 'cs10', text: line });
  }
  // 5) Faser: holdets guldforskel ved 10/20 min og hvor nederlagene tabte mest guld.
  const teamAt = (g, m) => g.review.team?.find((x) => x[0] === m)?.[1];
  for (const m of [10, 20]) {
    const at = rvKnown.map((g) => ({ g, d: teamAt(g, m) })).filter((x) => typeof x.d === 'number' && x.d !== 0);
    if (!enough(at)) continue;
    const line = split(`Holdets guld ved ${m} min`, at.filter((x) => x.d > 0).map((x) => x.g), at.filter((x) => x.d < 0).map((x) => x.g), 'foran:', 'bagud:');
    if (line) lines.push({ key: `team${m}`, text: line });
  }
  const losses = rvKnown.filter((g) => g.result === 'Nederlag' && (g.review.team || []).length >= 5);
  if (losses.length && enough(rvKnown)) {
    // Fasen hvor holdets guldforskel faldt mest pr. minut.
    const worst = new Map();
    for (const g of losses) {
      const t = g.review.team;
      let best = null;
      for (const [from, to, label] of PHASES) {
        const a = [...t].reverse().find((x) => x[0] <= from) || t[0];
        const b = [...t].reverse().find((x) => x[0] <= to) || t[t.length - 1];
        if (b[0] - a[0] < 3) continue;
        const rate = (b[1] - a[1]) / (b[0] - a[0]);
        if (!best || rate < best.rate) best = { rate, label };
      }
      if (best && best.rate < 0) worst.set(best.label, (worst.get(best.label) || 0) + 1);
    }
    if (worst.size) lines.push({ key: 'phase', text: `I ${losses.length} nederlag faldt holdets guld mest (pr. minut): ${PHASES.map(([, , l]) => `${l} ${worst.get(l) || 0}`).join(', ')}` });
    // Tabte føringer: nederlag hvor holdet var mere foran end din median for største føring (alle kampe i gruppen).
    const peak = (g) => Math.max(0, ...g.review.team.map((x) => x[1]));
    const medPeak = median(rvKnown.map(peak));
    const thrown = losses.filter((g) => peak(g) > medPeak && medPeak > 0);
    if (medPeak > 0) lines.push({ key: 'throw', text: `Tabte føringer: ${thrown.length} af ${losses.length} nederlag hvor holdet var mere end ${gnum(medPeak)} g foran (din median for største føring)` });
  }
  // 6) Jungle: første gank = første kill/assist i en lane før 10 min (mislykkede ganks kan ikke ses i timelinen).
  const jg = rvKnown.filter((g) => g.position === 'JUNGLE');
  if (enough(jg)) {
    const withGank = jg.map((g) => ({ g, t: g.review.ganks?.[0]?.t })).filter((x) => typeof x.t === 'number');
    const none = jg.length - withGank.length;
    const med = median(withGank.map((x) => x.t));
    const line = withGank.length ? split(`Første kill/assist i en lane (din median ${mmss(med)})`, withGank.filter((x) => x.t < med).map((x) => x.g), withGank.filter((x) => x.t >= med).map((x) => x.g), 'før:', 'senere:') : null;
    if (line || none) lines.push({ key: 'gank', text: (line || 'Første kill/assist i en lane') + (none ? ` - ingen før 10 min: ${wins(jg.filter((g) => !g.review.ganks?.length))} af ${none} sejre` : '') });
  }
  // 7) Dueller mod lane-modstanderen.
  const withDuels = known.filter((g) => (g.duels || []).length);
  if (enough(withDuels)) {
    const net = (g) => g.duels.filter((d) => d.won).length - g.duels.filter((d) => !d.won).length;
    const line = split(`Dueller mod ${oppLabel}`, withDuels.filter((g) => net(g) > 0), withDuels.filter((g) => net(g) < 0), 'vandt flest:', 'tabte flest:');
    if (line) lines.push({ key: 'duels', text: line });
  }
  return lines;
}

function patternsFor(championId, position) {
  const games = srGames().filter((g) => (championId == null || g.championId === Number(championId)) && (!position || g.position === position));
  if (games.length < PATTERN_MIN_GAMES) return { games: games.length, lines: [] };
  return { games: games.length, reviewed: reviewed(games).length, lines: patternLines(games, position === 'JUNGLE' ? 'fjendens jungler' : 'lane-modstanderen') };
}

// Kortet "Dine mønstre": dine mest spillede champion + rolle-kombinationer, og dine roller samlet
// (når rollen har flere champions, fx jungle med Lee Sin og Evelynn). Grupper under 10 kampe vises med antal.
function patternsView() {
  if (!app.cfg.patterns) return null;
  const combos = new Map();
  const roles = new Map();
  for (const g of srGames()) {
    if (!g.championId || !g.position) continue;
    const k = `${g.championId}|${g.position}`;
    combos.set(k, (combos.get(k) || 0) + 1);
    if (!roles.has(g.position)) roles.set(g.position, new Set());
    roles.get(g.position).add(g.championId);
  }
  const sorted = [...combos].sort((a, b) => b[1] - a[1]);
  const out = [];
  const pending = [];
  for (const [k, n] of sorted) {
    const [id, pos] = k.split('|');
    if (n < PATTERN_MIN_GAMES) { pending.push({ champion: champView(id), position: pos, games: n }); continue; }
    const p = patternsFor(id, pos);
    if (p.lines.length && out.length < 3) out.push({ champion: champView(id), position: pos, games: p.games, reviewed: p.reviewed, lines: p.lines.map((l) => l.text) });
  }
  // Rollen samlet kun når ingen champion i rollen selv har nok kampe (ellers gentager den champion-gruppen).
  for (const [pos, champs] of roles) {
    if (champs.size < 2 || [...champs].some((id) => (combos.get(`${id}|${pos}`) || 0) >= PATTERN_MIN_GAMES)) continue;
    const p = patternsFor(null, pos);
    if (p.lines.length) out.push({ champion: null, position: pos, games: p.games, reviewed: p.reviewed, lines: p.lines.map((l) => l.text) });
  }
  const best = sorted[0];
  return {
    groups: out,
    pending: pending.slice(0, 6),
    minGames: PATTERN_MIN_GAMES,
    waiting: !out.length && best ? { champion: champView(best[0].split('|')[0]), position: best[0].split('|')[1], games: best[1] } : null,
  };
}

// ---------- Klatre-tjek: de kendte low elo-huller, målt i dine egne kampe ----------
// Hvert punkt bygger på docs/research-low-elo.md (kilder pr. punkt). Skillelinjen er altid din egen median -
// ingen faste tærskler. "Koster" = forskellen i dine sejre mellem kampe på den gode og den dårlige side af
// medianen: en sammenhæng i dine kampe med antal, ikke en årsag. Kun Summoner's Rift-kampe med kendt resultat.

const RESEARCH_URL = 'https://github.com/tvg-invest/lol-rune-helper/blob/worktree-build-helper/docs/research-low-elo.md';
const decs = (x, n = 1) => String(Math.round(x * 10 ** n) / 10 ** n).replace('.', ',');
const fix = (x, n = 1) => x.toFixed(n).replace('.', ','); // altid n decimaler (kildens tal: 5,0)
const knownResult = (g) => g.result === 'Sejr' || g.result === 'Nederlag';
const winsOf = (gs) => gs.filter((g) => g.result === 'Sejr').length;
const reviewDeaths = (g) => (g.review?.v >= REVIEW_MIN && Array.isArray(g.review.deaths) ? g.review.deaths : null);
const durOf = (g) => g.review?.dur || g.duration || null;
const teamGoldAt = (g, m) => g.review?.team?.find((x) => x[0] === m)?.[1];
// CS/min fra 14 min til 25 min (eller kampens sidste hele minut) - kræver mindst 5 minutter efter 14.
function csMidOf(g) {
  const c = g.review?.csm;
  if (!Array.isArray(c) || typeof c[14] !== 'number') return null;
  let end = Math.min(25, c.length - 1);
  while (end > 14 && typeof c[end] !== 'number') end--;
  return end - 14 >= 5 ? (c[end] - c[14]) / (end - 14) : null;
}
const OBJ_PLURAL = { DRAGON: 'drager', HORDE: 'voidgrubs', RIFTHERALD: 'Rift Herald', BARON_NASHOR: 'Baron', ATAKHAN: 'Atakhan', TOWER: 'tårne', INHIBITOR: 'inhibitorer' };
const objList = (objs) => {
  const by = new Map();
  for (const o of objs) by.set(o.k, (by.get(o.k) || 0) + 1);
  return [...by].map(([k, n]) => `${n} ${n > 1 ? OBJ_PLURAL[k] || k : OBJECTIVE_NAMES[k] || k}`).join(', ');
};

// De målbare huller. low: true = lavere er bedre. tip = hvad du kan prøve næste kamp (fra kilderne).
const CLIMB_METRICS = [
  { key: 'early', label: 'Dødsfald før 14 min', low: true, fmt: (v) => decs(v),
    get: (g) => { const d = reviewDeaths(g) || g.deathLog; return Array.isArray(d) ? d.filter((x) => x.t < 840).length : null; } },
  { key: 'multi', label: 'Dødsfald mod 2+ fjender', low: true, fmt: (v) => decs(v),
    get: (g) => reviewDeaths(g)?.filter((d) => d.n >= 2).length ?? null },
  { key: 'objDead', label: 'Fjendens objectives mens du var død', low: true, fmt: (v) => decs(v),
    get: (g) => (Array.isArray(g.review?.objectives) ? g.review.objectives.filter((o) => !o.mine && o.dead).length : null) },
  { key: 'csMid', label: 'CS/min midt i kampen (14-25 min)', low: false, fmt: (v) => decs(v), get: csMidOf },
  { key: 'vision', label: 'Vision score pr. min', low: false, fmt: (v) => fix(v, 2),
    get: (g) => { const v = g.review?.stats?.vision; const d = durOf(g); return typeof v === 'number' && d ? v / (d / 60) : null; } },
  { key: 'controlWards', label: 'Control Wards købt', low: false, fmt: (v) => decs(v), get: (g) => g.review?.stats?.controlWards ?? null },
  { key: 'thrown', label: 'Foran i lanen ved 10 min, men holdet bagud ved 20 min', low: true, bool: true,
    get: (g) => { const a = g.review?.at?.[10]?.gold; const t = teamGoldAt(g, 20); return typeof a === 'number' && a > 0 && typeof t === 'number' ? (t < 0 ? 1 : 0) : null; } },
];
// Ét konkret forsøg til næste kamp pr. hul + kilden (docs/research-low-elo.md). Kun efter kampen / før kampen.
const CLIMB_TIPS = {
  early: { text: 'Næste kamp: gå efter 0-1 dødsfald før 14 min. Tag kun trades, når du ved hvor fjendens jungler er (set på kortet eller ward i floden).',
    source: 'amitilted.com (65.569 spiller-kampe, NA, okt. 2026): tabte kampe har 2-3 flere dødsfald end vundne i alle ranks og roller', url: 'https://amitilted.com/stats/deaths' },
  multi: { text: 'Næste kamp: når 2 eller flere fjender ikke kan ses på kortet, så træk dig mod dit tårn, før du farmer videre eller går ind.',
    source: 'amitilted.com: dødsfald og guld pr. minut er det der skiller sejre fra nederlag mest (fx Gold MID 5,0 dødsfald i sejre mod 7,8 i nederlag)', url: 'https://amitilted.com/stats/deaths' },
  objDead: { text: 'Næste kamp: vær i live og tæt på i minuttet før en drage, voidgrubs eller Baron - pres ikke en bølge dybt på fjendens halvdel lige før.',
    source: 'UCLA-analyse af 9.879 Diamond-kampe: hold med en drage ved 10 min vandt 64,1 % mod 41,9 % uden', url: 'https://astro-wen.github.io/UCLA_C111_LoL/report.html' },
  csMid: { text: 'Næste kamp: efter lanen, tag den sidebølge der er nærmest dig mellem objectives i stedet for at gå rundt med holdet uden mål.',
    source: 'amitilted.com: CS/min er højere i vundne end i tabte kampe i alle roller undtagen support (fx Gold MID 6,8 mod 6,4)', url: 'https://amitilted.com/stats/cs-per-minute' },
  vision: { text: 'Næste kamp: brug dit trinket hver gang det er klar, og placér det på den vej fjendens jungler kommer fra.',
    source: 'amitilted.com: vision score er højere i vundne kampe i alle roller, men forskellen er lille (fx Gold MID 0,74 mod 0,65 pr. min)', url: 'https://amitilted.com/stats/vision-score' },
  controlWards: { text: 'Næste kamp: køb en Control Ward ved hvert besøg i base, når du har en ledig plads.',
    source: 'amitilted.com: Gold jungle køber 1,1 og Gold support 3,1 pr. kamp; top/mid/ADC kun 0,2-0,6 i alle ranks', url: 'https://amitilted.com/stats/control-wards' },
  thrown: { text: 'Næste kamp: når du er foran efter lanen, så brug føringen med holdet på et tårn eller en drage i stedet for at jagte kills alene.',
    source: 'Dignitas "Sins of Silver": "Kills alone don\'t close games"; UCLA (9.879 kampe): guldforskel ved 10 min hænger stærkest sammen med sejr (r = 0,51)', url: 'https://dignitas.gg/articles/sins-of-silver-mistakes-low-elo-players-insist-on-making' },
};

// Referencetal pr. rank og rolle fra amitilted.com (NA ranked solo, patch 25.24-26.20, opdateret okt. 2026;
// 376-484 kampe pr. rolle i Iron-Gold). Typisk spiller (deaths: snit i sejre / nederlag).
const REF_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
const REF = {
  cs: { TOP: [5.7, 5.8, 6.4, 6.7, 6.9], JUNGLE: [5.7, 5.9, 6.3, 6.5, 6.7], MID: [5.4, 5.7, 6.2, 6.6, 7.0], ADC: [5.5, 5.8, 6.3, 7.0, 7.3] },
  vision: { TOP: [0.64, 0.69, 0.71, 0.75, 0.76], JUNGLE: [0.70, 0.78, 0.80, 0.85, 0.82], MID: [0.53, 0.63, 0.64, 0.68, 0.68], ADC: [0.61, 0.64, 0.64, 0.59, 0.61], SUPPORT: [1.55, 1.79, 1.95, 2.23, 2.40] },
  controlWards: { TOP: [0.2, 0.3, 0.3, 0.4, 0.4], JUNGLE: [0.5, 0.7, 0.8, 1.1, 1.1], MID: [0.2, 0.6, 0.6, 0.6, 0.6], ADC: [0.3, 0.3, 0.4, 0.5, 0.5], SUPPORT: [1.3, 1.8, 2.1, 3.1, 3.6] },
  deaths: {
    TOP: [[5.1, 7.5], [5.3, 7.8], [5.6, 7.4], [5.3, 7.6], [5.1, 7.4]], JUNGLE: [[5.1, 8.1], [5.3, 8.1], [4.9, 7.5], [4.7, 7.8], [4.4, 7.4]],
    MID: [[5.2, 7.4], [5.3, 8.0], [5.2, 7.8], [5.0, 7.8], [5.0, 7.3]], ADC: [[6.0, 8.4], [5.9, 8.7], [5.4, 7.7], [5.5, 8.0], [5.4, 7.8]],
    SUPPORT: [[5.4, 7.3], [5.6, 7.9], [5.2, 8.3], [5.2, 8.2], [5.2, 7.6]],
  },
};
const REF_URL = 'https://amitilted.com/stats';
// Hvilke ranks der sammenlignes med: din egen (fra klienten) og Gold - eller rangen over, hvis du er Gold/Platinum.
function refTiers() {
  const i = REF_TIERS.indexOf(app.rank?.tier);
  if (i === -1) return [3];
  return i < 3 ? [i, 3] : i < 4 ? [i, i + 1] : [i];
}
const tierName = (i) => TIER_NAME(REF_TIERS[i]);
// Kampens tal mod kilden (kun roller/tal kilden har).
function gameRefs(g) {
  const pos = g.position; const dur = durOf(g); const st = g.review?.stats || {};
  const tiers = refTiers(); const out = [];
  const list = (tab, f) => tiers.map((i) => `${tierName(i)} ${f(tab[i])}`).join(', ');
  if (REF.deaths[pos] && typeof g.deaths === 'number') out.push(`${g.deaths} dødsfald - ${pos} i snit i sejre / nederlag: ${list(REF.deaths[pos], ([w, l]) => `${fix(w)} / ${fix(l)}`)}`);
  if (REF.cs[pos] && typeof g.csPerMin === 'number') out.push(`${fix(g.csPerMin)} CS/min - typisk ${pos}: ${list(REF.cs[pos], (x) => fix(x))}`);
  if (REF.vision[pos] && typeof st.vision === 'number' && dur) out.push(`${fix(st.vision / (dur / 60), 2)} vision score/min - typisk ${pos}: ${list(REF.vision[pos], (x) => fix(x, 2))}`);
  if (REF.controlWards[pos] && typeof st.controlWards === 'number') out.push(`${st.controlWards} Control Wards - typisk ${pos}: ${list(REF.controlWards[pos], (x) => fix(x))}`);
  return out;
}

// Champion-erfaring (iTero, 1M+ solo queue-kampe omkring Gold, patch 13.7): win rate krydser 50 % ved ca.
// 12.000 mastery-point = ca. 20 kampe på championen.
const MASTERY_CROSS = 12000;
const MASTERY_URL = 'https://itero.gg/articles/mastery-a-statistical-summary';
async function fetchPickMastery(championId) {
  if (!app.cfg.climbCheck || !app.client) return;
  app.pickMastery = { championId, points: null };
  try {
    const list = await lcu(app.client, 'GET', '/lol-champion-mastery/v1/local-player/champion-mastery');
    const m = (Array.isArray(list) ? list : []).find((x) => x.championId === championId);
    if (app.pickMastery?.championId === championId) app.pickMastery.points = typeof m?.championPoints === 'number' ? m.championPoints : 0;
    broadcast();
  } catch {}
}

// Din median for et hul og dine sejre på hver side af den. Kræver 10 kampe med tallet og 3 på hver side
// for at sige noget om sejre.
function metricSplit(m, games, exclude = null) {
  const xs = games.filter((g) => g !== exclude && knownResult(g)).map((g) => ({ g, v: m.get(g) })).filter((x) => typeof x.v === 'number' && Number.isFinite(x.v));
  if (xs.length < PATTERN_MIN_GAMES) return null;
  const med = m.bool ? 0 : median(xs.map((x) => x.v));
  const worse = (v) => (m.bool ? v === 1 : m.low ? v > med : v < med);
  const bad = xs.filter((x) => worse(x.v)).map((x) => x.g);
  const good = xs.filter((x) => !worse(x.v)).map((x) => x.g);
  const out = { m, med, n: xs.length, worse, bad: bad.length, badWins: winsOf(bad), good: good.length, goodWins: winsOf(good), cost: null, values: xs };
  if (bad.length >= 3 && good.length >= 3) out.cost = out.goodWins / out.good - out.badWins / out.bad;
  return out;
}
const splitText = (s) => (s.m.bool
  ? `${s.m.label}: ${s.badWins} af ${s.bad} sejre - foran ved 10 min uden det: ${s.goodWins} af ${s.good}`
  : `${s.m.label} (din median ${s.m.fmt(s.med)}): ${s.m.low ? 'flere' : 'færre'} end medianen ${s.badWins} af ${s.bad} sejre - ellers ${s.goodWins} af ${s.good}`);

// Gruppen tallene sammenlignes med: dine kampe i samme rolle (vision og CS afhænger af rollen), eller alle
// dine kampe, hvis rollen har under 10.
function climbGroup(position) {
  const all = srGames().filter(knownResult);
  const same = position ? all.filter((g) => g.position === position) : [];
  return same.length >= PATTERN_MIN_GAMES ? { games: same, scope: `dine ${position}-kampe` } : { games: all, scope: 'alle dine kampe' };
}

// Op til 3 huller i én kamp: tal hvor kampen var værre end din median, sorteret efter hvad de koster dig.
function gameLeaks(g) {
  if (!g || !(g.review?.v >= REVIEW_MIN)) return null;
  const { games, scope } = climbGroup(g.position);
  const leaks = [];
  for (const m of CLIMB_METRICS) {
    const v = m.get(g);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const s = metricSplit(m, games, g);
    if (!s || !s.worse(v)) continue;
    let text;
    if (m.key === 'thrown') {
      text = `Foran i lanen ved 10 min (+${gnum(g.review.at[10].gold)} g), men holdet var ${gnum(-teamGoldAt(g, 20))} g bagud ved 20 min.`;
    } else {
      const extra = m.key === 'objDead' ? ` (${objList(g.review.objectives.filter((o) => !o.mine && o.dead))})` : '';
      text = `${m.label}: ${m.fmt(v)}${extra} - din median er ${m.fmt(s.med)}.`;
    }
    const wins = m.bool ? `Samme forløb i ${scope}: ${s.badWins} af ${s.bad} sejre - foran ved 10 min uden det: ${s.goodWins} af ${s.good}.`
      : `I ${scope}: ${s.m.low ? 'flere' : 'færre'} end medianen ${s.badWins} af ${s.bad} sejre - ellers ${s.goodWins} af ${s.good}.`;
    leaks.push({ key: m.key, text, wins, cost: s.cost, tip: CLIMB_TIPS[m.key] || null });
  }
  leaks.sort((a, b) => (b.cost ?? -2) - (a.cost ?? -2));
  return { scope, leaks: leaks.slice(0, 3).map(({ cost, ...x }) => x), refs: gameRefs(g), refUrl: REF_URL };
}

// Kampe "i træk": næste kamp startede senest 45 min efter at den forrige sluttede (kø + champion select).
const SESSION_GAP_MS = 45 * 60 * 1000;
const recentSorted = () => [...history.recent].sort((a, b) => a.start - b.start);
const endOf = (x) => x.start + (x.dur || 0) * 1000;
// Sejre efter 0, 1, 2 og 3+ tab i træk, kamp nr. i sessionen og tidspunkt på dagen (klientens kamphistorik).
function streakStats(list = recentSorted()) {
  if (list.length < PATTERN_MIN_GAMES) return null;
  const after = [0, 1, 2, 3].map((k) => ({ k, games: 0, wins: 0 }));
  const nth = { early: { games: 0, wins: 0 }, late: { games: 0, wins: 0 } };
  let streak = 0; let inSession = 0;
  list.forEach((x, i) => {
    const prev = list[i - 1];
    const chained = prev && x.start - endOf(prev) <= SESSION_GAP_MS;
    if (!chained) { streak = 0; inSession = 0; }
    inSession++;
    const row = after[Math.min(3, streak)];
    row.games++; if (x.win) row.wins++;
    const n = inSession <= 2 ? nth.early : nth.late;
    n.games++; if (x.win) n.wins++;
    streak = x.win ? 0 : streak + 1;
  });
  const hours = list.map((x) => new Date(x.start).getHours());
  const medHour = Math.round(median(hours));
  const before = list.filter((x, i) => hours[i] < medHour);
  const from = list.filter((x, i) => hours[i] >= medHour);
  const last = list[list.length - 1];
  // Tab i træk lige nu (kun hvis du stadig er i samme session).
  let current = 0;
  if (Date.now() - endOf(last) <= SESSION_GAP_MS) {
    for (let i = list.length - 1; i >= 0 && !list[i].win; i--) {
      current++;
      if (i > 0 && list[i].start - endOf(list[i - 1]) > SESSION_GAP_MS) break;
    }
  }
  return {
    games: list.length, wins: list.filter((x) => x.win).length, after, nth, current,
    hour: before.length && from.length ? { medHour, before: { games: before.length, wins: before.filter((x) => x.win).length }, from: { games: from.length, wins: from.filter((x) => x.win).length } } : null,
  };
}
// Tilt-vagten: hvor mange tab i træk før din egen win rate falder (din data: mindst 5 kampe efter k tab i træk
// og lavere win rate end ellers). Har du for få kampe, bruges kildens tal (TILT_FALLBACK).
const TILT_FALLBACK = 2;
const TILT_SOURCE = 'I iTeros analyse af 100.000 kampe var win rate 48,8 % efter 2 tab i træk, og Gold-spillere der køede igen med det samme havde den laveste win rate.';
const TILT_URL = 'https://www.itero.gg/articles/lol-tilt';
function tiltThreshold(s) {
  if (!s) return { k: TILT_FALLBACK, own: false };
  const base = s.wins / s.games;
  for (const k of [2, 3]) {
    const row = s.after[k];
    if (row.games >= 5 && row.wins / row.games < base) return { k, own: true, row };
  }
  return { k: TILT_FALLBACK, own: false };
}
function tiltGuard(s = streakStats()) {
  if (!s || !s.current) return null;
  const t = tiltThreshold(s);
  if (s.current < t.k) return null;
  const row = s.after[Math.min(3, s.current)];
  const own = row.games >= 5 ? ` I dine egne kampe vandt du ${row.wins} af ${row.games} lige efter ${Math.min(3, s.current)}${s.current >= 3 ? '+' : ''} tab i træk (alle dine kampe: ${s.wins} af ${s.games}).` : '';
  const src = t.own ? '' : ` ${TILT_SOURCE}`;
  return { text: `${s.current} tab i træk.${own}${src} En kort pause før næste kø er et godt valg - det er helt dit valg.`, url: t.own ? null : TILT_URL };
}

// Henter klientens kamphistorik (kun GET, kun når klienten er ledig) til tilt- og tidspunkt-tallene.
const RECENT_REFRESH_MS = 10 * 60 * 1000;
async function refreshRecentGames(force = false) {
  if (!app.client || !(app.cfg.climbCheck || app.cfg.championPool) || app.recentBusy || (!force && Date.now() - (app.recentAt || 0) < RECENT_REFRESH_MS)) return;
  app.recentBusy = true;
  app.recentAt = Date.now();
  try {
    const j = await lcu(app.client, 'GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=50');
    const byId = new Map(history.recent.map((x) => [x.id, x]));
    let added = 0;
    for (const x of j?.games?.games || []) {
      const win = x.participants?.[0]?.stats?.win;
      if (typeof win !== 'boolean' || typeof x.gameCreation !== 'number' || x.mapId !== 11 || !['CLASSIC', 'SWIFTPLAY'].includes(x.gameMode)) continue;
      if (x.endOfGameResult && x.endOfGameResult !== 'GameComplete') continue;
      if (!byId.has(x.gameId)) added++;
      byId.set(x.gameId, { id: x.gameId, start: x.gameCreation, dur: x.gameDuration || 0, win, queue: x.queueId ?? null, champ: x.participants[0].championId ?? null,
        gv: typeof x.gameVersion === 'string' ? x.gameVersion : null });
    }
    // Mastery pr. champion (champion-puljen) - samme GET som champion select bruger.
    if (app.cfg.championPool) {
      const list = await lcu(app.client, 'GET', '/lol-champion-mastery/v1/local-player/champion-mastery').catch(() => null);
      if (Array.isArray(list)) {
        app.mastery = new Map(list.filter((m) => m && typeof m.championId === 'number').map((m) => [m.championId,
          { points: typeof m.championPoints === 'number' ? m.championPoints : null, level: typeof m.championLevel === 'number' ? m.championLevel : null }]));
      }
    }
    if (added || history.recent.some((x) => x.gv === undefined)) {
      history.recent = [...byId.values()].sort((a, b) => b.start - a.start).slice(0, 200);
      saveHistory();
    }
    // Din rank i solo/duo (til referencetallene). Formen er ikke set i en rigtig klient endnu - læses forsigtigt.
    const ranked = await lcu(app.client, 'GET', '/lol-ranked/v1/current-ranked-stats').catch(() => null);
    const solo = ranked?.queueMap?.RANKED_SOLO_5x5 || (Array.isArray(ranked?.queues) ? ranked.queues.find((q) => q?.queueType === 'RANKED_SOLO_5x5') : null);
    const tier = typeof solo?.tier === 'string' ? solo.tier.toUpperCase() : '';
    app.rank = tier && tier !== 'NONE' ? { tier, division: solo.division || null } : null;
    broadcast();
  } catch {} finally { app.recentBusy = false; }
}

// Dødsfald pr. 10 min i hver fase (tid i fasen tæller med, så korte kampe ikke trækker ned).
function deathPhases(games) {
  const rv = games.filter((g) => reviewDeaths(g) && durOf(g));
  if (rv.length < PATTERN_MIN_GAMES) return null;
  const rows = PHASES.map(([from, to, label]) => ({ label, deaths: 0, time: 0, from, to }));
  for (const g of rv) {
    const dur = durOf(g);
    for (const r of rows) r.time += Math.max(0, Math.min(dur, r.to * 60) - r.from * 60);
    for (const d of reviewDeaths(g)) rows.find((r) => d.t >= r.from * 60 && d.t < r.to * 60).deaths++;
  }
  return { games: rv.length, rows: rows.filter((r) => r.time > 0).map((r) => ({ label: r.label, deaths: r.deaths, per10: r.deaths / (r.time / 600) })) };
}

// Føringen i lanen omsat (eller ej): foran ved 10 min -> sejre, og hvor ofte holdet alligevel var bagud ved 20.
function leadLine(games) {
  const at = games.filter((g) => g.review?.v >= REVIEW_MIN && typeof g.review.at?.[10]?.gold === 'number' && g.review.at[10].gold !== 0);
  if (at.length < PATTERN_MIN_GAMES) return null;
  const ahead = at.filter((g) => g.review.at[10].gold > 0);
  const lost = ahead.filter((g) => typeof teamGoldAt(g, 20) === 'number' && teamGoldAt(g, 20) < 0);
  const behind20 = games.filter((g) => typeof teamGoldAt(g, 20) === 'number' && teamGoldAt(g, 20) < 0);
  return `Foran i lanen ved 10 min i ${ahead.length} af ${at.length} kampe - vandt ${winsOf(ahead)} af de ${ahead.length}.` +
    (lost.length ? ` I ${lost.length} af dem var holdet bagud ved 20 min (${winsOf(lost)} sejre).` : '') +
    (behind20.length ? ` Holdet bagud ved 20 min i alt: ${winsOf(behind20)} af ${behind20.length} sejre.` : '');
}

// Champion-pulje i dine seneste 20 kampe.
function poolView(games) {
  const last = games.slice(0, 20);
  if (last.length < PATTERN_MIN_GAMES) return null;
  const by = new Map();
  for (const g of last) {
    const k = `${g.championId}|${g.position}`;
    const x = by.get(k) || { key: k, champion: champView(g.championId), position: g.position, games: 0, wins: 0 };
    x.games++; if (g.result === 'Sejr') x.wins++;
    by.set(k, x);
  }
  const list = [...by.values()].sort((a, b) => b.games - a.games);
  const top2 = new Set(list.slice(0, 2).map((x) => x.key));
  const inTop = last.filter((g) => top2.has(`${g.championId}|${g.position}`));
  const rest = last.filter((g) => !inTop.includes(g));
  return {
    games: last.length,
    champions: new Set(last.map((g) => g.championId)).size,
    roles: new Set(last.map((g) => g.position)).size,
    list: list.slice(0, 6).map(({ key, ...x }) => x),
    topVsRest: rest.length >= 3 ? `Dine 2 mest spillede: ${winsOf(inTop)} af ${inTop.length} sejre - alle andre: ${winsOf(rest)} af ${rest.length}` : null,
  };
}

// Udvikling: din median i de sidste 10 kampe mod de 10 før (kræver 15 kampe med tallet).
function trendRows(games) {
  const rows = [];
  for (const m of CLIMB_METRICS) {
    if (m.bool) continue;
    const vs = games.map((g) => m.get(g)).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (vs.length < 15) continue;
    const last = median(vs.slice(0, 10)); const before = median(vs.slice(10, 20));
    rows.push({ label: m.label, last: m.fmt(last), before: m.fmt(before), better: last === before ? null : m.low ? last < before : last > before, n: Math.min(20, vs.length) });
  }
  return rows;
}

// Hovedrollen: den rolle du har spillet mest i dine seneste 20 kampe.
function mainRole() {
  const n = new Map();
  for (const g of srGames().slice(0, 20)) if (g.position) n.set(g.position, (n.get(g.position) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function climbView() {
  if (!app.cfg.climbCheck) return null;
  const role = mainRole();
  const { games, scope } = climbGroup(role);
  const splits = CLIMB_METRICS.map((m) => metricSplit(m, games)).filter((s) => s && s.cost != null && s.cost > 0).sort((a, b) => b.cost - a.cost);
  const allDeaths = games.flatMap((g) => reviewDeaths(g) || []);
  const st = streakStats();
  const latest = srGames().find((g) => g.review?.v >= REVIEW_MIN);
  const last = latest ? gameLeaks(latest) : null;
  const tilt = tiltThreshold(st);
  return {
    scope,
    games: games.length,
    minGames: PATTERN_MIN_GAMES,
    last: last && latest ? { date: latest.date, champion: latest.champion, result: latest.result, ...last } : null,
    reviewShown: Boolean(app.cfg.matchReview),
    costs: splits.slice(0, 3).map((s) => ({ text: splitText(s), tip: CLIMB_TIPS[s.m.key] || null })),
    lead: leadLine(games),
    phases: deathPhases(games),
    multi: allDeaths.length >= 20 ? `${allDeaths.filter((d) => d.n >= 2).length} af ${allDeaths.length} dødsfald var mod 2 eller flere fjender` : null,
    trends: trendRows(games),
    pool: poolView(srGames()),
    tilt: st ? { games: st.games, wins: st.wins, after: st.after, nth: st.nth, hour: st.hour, k: tilt.k, own: tilt.own, gapMin: SESSION_GAP_MS / 60000 } : null,
    guard: tiltGuard(st),
    sources: RESEARCH_URL,
  };
}

// Én linje i champion select: dit største hul i den rolle du skal spille (det der koster flest sejre, helst et
// du stadig har i dine sidste 5 kampe) + tilt-vagten.
function climbFocus(position) {
  if (!app.cfg.climbCheck) return null;
  const { games, scope } = climbGroup(position);
  const splits = CLIMB_METRICS.map((m) => metricSplit(m, games)).filter((s) => s && s.cost != null && s.cost > 0).sort((a, b) => b.cost - a.cost);
  const recentWorse = (s) => {
    const vs = s.values.slice(0, 5).map((x) => x.v);
    return vs.length >= 3 && s.worse(s.m.bool ? (vs.filter((v) => v === 1).length > vs.length / 2 ? 1 : 0) : median(vs));
  };
  const s = splits.find(recentWorse) || splits[0];
  const focus = s ? { text: `${splitText(s)} (${scope})`, label: s.m.label, tip: CLIMB_TIPS[s.m.key] || null, recent: recentWorse(s) } : null;
  const guard = tiltGuard();
  return focus || guard ? { focus, guard } : null;
}

// ---------- Coach: de 3-5 vigtigste ændringer i din spillestil ----------
// Konkrete råd som en coach ville sige dem ("Vær ved dragen"), hvert med: et tal fra dine egne kampe (med antal),
// en kilde til selve rådet (docs/research-coach.md) og én ting du kan gøre i næste kamp. Rådene sorteres efter
// hvor meget de hænger sammen med dine nederlag: forskellen i sejre mellem kampe på hver side af din egen median
// (som klatre-tjekket). Sammenhænge, ikke bevis for årsag. Ingen faste tærskler; "tæt på" er en kortafstand
// (COACH_NEAR). Kun før og efter kampen - under kampen viser programmet stadig kun fakta og valg.

const COACH_URL = 'https://github.com/tvg-invest/lol-rune-helper/blob/worktree-build-helper/docs/research-coach.md';
const COACH_MIN_GAMES = PATTERN_MIN_GAMES;
// Voidgrubs dør som flere events lige efter hinanden: samme slags monster inden for 60 sek. = ét objective.
const COACH_MERGE_SEC = 60;
const coachReady = (g) => g.review?.v >= 4 && knownResult(g);
function epicTakes(r, kinds) {
  const out = [];
  const list = (r?.objectives || []).filter((o) => kinds.includes(o.k) && typeof o.near === 'boolean').sort((a, b) => a.t - b.t);
  for (const o of list) {
    const last = out[out.length - 1];
    if (last && last.k === o.k && o.t - last.t <= COACH_MERGE_SEC) { last.near = last.near || o.near; last.dead = last.dead && o.dead; continue; }
    out.push({ ...o });
  }
  return out;
}
const TOPSIDE = ['HORDE', 'RIFTHERALD', 'BARON_NASHOR'];
// Dødsfald hvor fjenden tog et stort monster, mens du stadig var død (dødstid efter League Wikis formel).
const objDeaths = (r) => (r.deaths || []).filter((d) => typeof d.dead === 'number'
  && epicTakes(r, EPIC_MONSTERS).some((o) => !o.mine && o.t >= d.t && o.t <= d.t + d.dead));
const ALL_ROLES = POSITIONS;

// Kilder til rådene (hentet og læst 9/11-2026 - se docs/research-coach.md).
const SRC = {
  midGuide: { name: 'dodge.gg mid lane guide 2026: "Before Dragon, Baron, or Grubs, shove the mid wave" og "Always push the wave before leaving lane"', url: 'https://www.dodge.gg/en-US/lol/news/mid-lane-guide-2026' },
  midRoam: { name: 'Dignitas, mid-roaming-guide: "It is best to roam when you have lane priority over your opponent"', url: 'https://dignitas.gg/articles/leave-lane-win-game-a-mid-laners-guide-to-roaming-league-of-legends' },
  jgGuide: { name: 'dodge.gg jungle guide 2026: "Your laner has CC to chain with yours - a gank without follow-up CC usually fails"', url: 'https://www.dodge.gg/en-US/lol/news/jungle-guide-2026' },
  timing: { name: 'Dignitas, timing af objectives: "All these details should be accounted for within about a minute before the objective spawns"', url: 'https://dignitas.gg/articles/blogs/League-of-Legends/14839/a-guide-on-timing-and-tracking-objectives-in-league-of-legends' },
  setup: { name: 'metabot.gg objective-guide: "Set up 60-90 seconds early" og vær "shoved in before Rift Herald or a Dragon spawns"', url: 'https://metabot.gg/en/league/guides/objectives-dragon-baron-herald-grubs' },
  recall: { name: 'Dignitas, recall-guide: at recalle 30 sek. før dragen spawner efterlader holdet med en mand for lidt', url: 'https://dignitas.gg/articles/summoner-phone-home-a-guide-to-recalls' },
  macro: { name: 'Dignitas, mid/late game-guide: "prioritize being with your team" og "Taking the risk of overstaying is how most people give up their leads"', url: 'https://dignitas.gg/articles/macro-game-level-up-a-mid-to-late-game-league-of-legends-guide' },
  split: { name: 'Dignitas, split pushing 101: "If you aren\'t warding or watching your minimap and are just mindlessly pushing, you\'re literally asking to lose the game"', url: 'https://dignitas.gg/articles/blogs/League-of-Legends/14349/split-pushing-101-an-in-depth-league-of-legends-guide' },
  topTp: { name: 'Dignitas, Teleport i top: Teleport til bot-ganks og til drage- eller Herald-kampe', url: 'https://dignitas.gg/articles/blogs/League-of-Legends/9558/the-uses-of-top-lane-teleport' },
  sins: { name: 'Dignitas "Sins of Silver": "Kills alone don\'t close games"; tårnplader er permanente og giver 120 g (patch 26.1)', url: 'https://dignitas.gg/articles/sins-of-silver-mistakes-low-elo-players-insist-on-making' },
  deaths: { name: 'amitilted.com (65.569 spiller-kampe, NA, okt. 2026): tabte kampe har 2-3 flere dødsfald end vundne i alle ranks og roller', url: 'https://amitilted.com/stats/deaths' },
};

// Holdets side af sagen: tog dit hold monsteret med og uden dig, og var I flere/færre end fjenden ved pitten.
function pitTeam(games, kinds, where) {
  const takes = games.flatMap((g) => epicTakes(g.review, kinds));
  const w = takes.filter((o) => o.near); const wo = takes.filter((o) => !o.near);
  if (w.length < 3 || wo.length < 3) return null;
  const fewer = wo.filter((o) => typeof o.al === 'number' && typeof o.en === 'number' && o.al < o.en).length;
  return `Med dig ved ${where} tog dit hold den i ${w.filter((o) => o.mine).length} af ${w.length} - uden dig i ${wo.filter((o) => o.mine).length} af ${wo.length}` +
    ` (og uden dig var I færre end fjenden ved ${where} i ${fewer} af de ${wo.length}).`;
}
// Hvor dine ganks gik hen, og hvor ofte du selv døde lige efter.
function gankLanes(games) {
  const gs = games.flatMap((g) => g.review.ganks || []);
  if (!gs.length) return null;
  const n = (l) => gs.filter((x) => x.lane === l).length;
  return `Dine kills/assists i lanes før 10 min: ${n('Top')} top, ${n('Mid')} mid, ${n('Bot')} bot - i ${gs.filter((x) => x.died).length} af de ${gs.length} døde du selv inden for ${GANK_FIGHT_SEC} sek.`;
}

// De målbare råd. kind 'share' = "X af Y" (højere er bedre), 'count' = antal pr. kamp (low: true = færre er bedre).
// do[rolle] = én konkret ting til næste kamp (fra kilden). roles = hvilke roller rådet gælder for.
const COACH_ADVICE = [
  { key: 'dragon', kind: 'share', title: 'Vær ved dragen', unit: 'drager', roles: ALL_ROLES,
    get: (g) => { const xs = epicTakes(g.review, ['DRAGON']); return xs.length ? { hit: xs.filter((o) => o.near).length, of: xs.length } : null; },
    extra: (games) => pitTeam(games, ['DRAGON'], 'dragen'),
    do: {
      MID: 'Skub mid-bølgen ind under deres tårn ca. et minut før dragen spawner, og gå så mod floden ved dragen - før deres mid gør det.',
      JUNGLE: 'Læg din clear, så du står ved dragen når den spawner (første gang 5:00, så hvert 5. min), og start den først når bot eller mid har skubbet.',
      TOP: 'Hav Teleport klar når dragen spawner, og brug den til drage-kampen frem for at skubbe videre i top.',
      ADC: 'Skub bot-bølgen ind ca. et minut før dragen, recall i god tid, og gå til pitten sammen med din support.',
      SUPPORT: 'Ward floden ved dragen ca. et minut før den spawner, og få din ADC med derhen efter et skub.',
    },
    src: { MID: 'midGuide', JUNGLE: 'timing', TOP: 'topTp', ADC: 'recall', SUPPORT: 'setup' } },
  { key: 'topside', kind: 'share', title: 'Vær ved voidgrubs, Herald og Baron', unit: 'voidgrubs/Herald/Baron', roles: ALL_ROLES,
    get: (g) => { const xs = epicTakes(g.review, TOPSIDE); return xs.length ? { hit: xs.filter((o) => o.near).length, of: xs.length } : null; },
    extra: (games) => pitTeam(games, TOPSIDE, 'pitten'),
    do: {
      MID: 'Skub mid før voidgrubs (8:00), Herald (15:00) og Baron (20:00), og gå mod top-siden af floden, så holdet er flere end dem.',
      JUNGLE: 'Planlæg ruten mod top-siden til voidgrubs ved 8:00 og Herald ved 15:00, når top eller mid har skubbet.',
      TOP: 'Skub top-bølgen før voidgrubs og Herald, så du kan gå direkte til pitten (den ligger på din side af kortet).',
      ADC: 'Efter 20 min: følg holdet til Baron - skub bot-bølgen først, gå så med midt gennem junglen.',
      SUPPORT: 'Ward top-siden af floden ca. et minut før voidgrubs, Herald og Baron, og gå med holdet derhen.',
    },
    src: { MID: 'midGuide', JUNGLE: 'jgGuide', TOP: 'setup', ADC: 'macro', SUPPORT: 'setup' } },
  { key: 'objDeath', kind: 'count', low: true, title: 'Dø ikke lige før et objective', unit: 'dødsfald der gav fjenden et stort monster', roles: ALL_ROLES,
    get: (g) => (Array.isArray(g.review?.objectives) ? objDeaths(g.review).length : null),
    do: { ALL: 'Når dragen eller Baron spawner inden for et minut: tag ingen risiko alene - recall i god tid og kom tilbage med fuldt liv, i stedet for at farme dybt på deres halvdel.' },
    src: { ALL: 'timing' } },
  { key: 'sideAlone', kind: 'count', low: true, title: 'Bliv ikke alene i en sidelane sent', unit: 'dødsfald alene i en sidelane efter 20 min', roles: ALL_ROLES,
    get: (g) => ((g.review?.dur || 0) >= COACH_LATE_SEC && (g.review.deaths || []).every((d) => d.t < COACH_LATE_SEC || !(d.zone === 'Top' || d.zone === 'Bot') || typeof d.alone === 'boolean')
      ? g.review.deaths.filter((d) => d.alone).length : null),
    do: { ALL: 'Efter 20 min: når Baron eller dragen er oppe, eller du ikke kan se mindst 3 fjender på kortet, så gå til holdet i midten i stedet for at skubbe en sidelane alene.',
      TOP: 'Efter 20 min: split kun når du kan se fjenderne på kortet og har ward foran dig - ellers gå til holdet, før Baron eller dragen spawner.' },
    src: { ALL: 'macro', TOP: 'split' } },
  { key: 'outnumbered', kind: 'count', low: true, title: 'Undgå at blive fanget 1 mod 2', unit: 'dødsfald mod 2+ fjender', roles: ALL_ROLES,
    get: (g) => (Array.isArray(g.review?.deaths) ? g.review.deaths.filter((d) => d.n >= 2).length : null),
    do: { ALL: 'Når 2 eller flere fjender ikke kan ses på kortet, så træk dig mod dit tårn eller holdet, før du farmer videre eller går ind i en busk.' },
    src: { ALL: 'deaths' } },
  { key: 'roam', kind: 'count', low: false, title: 'Roam mere', unit: 'kills/assists i andre lanes før 14 min', roles: ['MID', 'TOP', 'SUPPORT'],
    get: (g) => (Array.isArray(g.review?.roams) ? g.review.roams.length : null),
    do: {
      MID: 'Skub bølgen ind under deres tårn (kanon-bølgen er et godt tidspunkt), og gå så bot eller top - bot hvis dragen snart spawner.',
      TOP: 'Brug Teleport til en bot-gank eller drage-kamp, når den er klar og din bølge er skubbet.',
      SUPPORT: 'Efter et skub i bot: gå med din jungler eller til mid, når din ADC er sikker eller recaller.',
    },
    src: { MID: 'midGuide', TOP: 'topTp', SUPPORT: 'midRoam' } },
  { key: 'gank', kind: 'count', low: false, title: 'Gank lanes der kan følge op', unit: 'lykkede ganks før 10 min', roles: ['JUNGLE'],
    extra: gankLanes,
    get: (g) => (Array.isArray(g.review?.ganks) && g.review.ganks.every((x) => typeof x.died === 'boolean') ? g.review.ganks.filter((x) => !x.died).length : null),
    do: { JUNGLE: 'Gank den lane hvor din laner har CC og bølgen skubber mod jeres tårn - og gå videre til en anden lane, hvis din laner har lavt liv eller fjenden har en stor bølge.' },
    src: { JUNGLE: 'jgGuide' } },
  { key: 'convert', kind: 'count', low: false, title: 'Omsæt din føring', unit: 'tårne og store monstre til dit hold 10-20 min (når du var foran ved 10)', roles: ALL_ROLES,
    get: (g) => {
      const r = g.review; const a = r?.at?.[10]?.gold;
      if (typeof a !== 'number' || a <= 0 || (r.dur || 0) < COACH_LATE_SEC || !Array.isArray(r.objectives)) return null;
      const towers = r.objectives.filter((o) => o.k === 'TOWER' && o.mine && o.t >= 600 && o.t < COACH_LATE_SEC).length;
      return towers + epicTakes(r, EPIC_MONSTERS).filter((o) => o.mine && o.t >= 600 && o.t < COACH_LATE_SEC).length;
    },
    do: { ALL: 'Når du er foran efter lanen, så slå tårnet i din lane (pladerne er permanente og giver 120 g) og gå med holdet til næste drage i stedet for at jagte kills alene.' },
    src: { ALL: 'sins' } },
];
const adviceDo = (a, role) => a.do[role] || a.do.ALL || Object.values(a.do)[0];
const adviceSrc = (a, role) => SRC[a.src[role] || a.src.ALL || Object.values(a.src)[0]];
// Tal pr. kamp til median-splittet: andel for "X af Y", ellers antal.
const coachValue = (a, g) => { const v = a.get(g); return v == null ? null : a.kind === 'share' ? v.hit / v.of : v; };

// Gruppen et råd måles i: champion + rolle med mindst 10 færdige kampe, ellers hele rollen.
function coachGroup(position, championId) {
  const role = srGames().filter((g) => g.position === position && coachReady(g));
  const champ = championId ? role.filter((g) => g.championId === Number(championId)) : [];
  if (champ.length >= COACH_MIN_GAMES) return { games: champ, scope: `dine ${champ[0].champion} ${position}-kampe` };
  return { games: role, scope: `dine ${position}-kampe` };
}

// Ét råd målt i gruppen: median-split (sejre på hver side) + samlede tal i sejre og nederlag.
function coachSplit(a, games, exclude = null) {
  const xs = games.filter((g) => g !== exclude).map((g) => ({ g, raw: a.get(g), v: coachValue(a, g) })).filter((x) => typeof x.v === 'number' && Number.isFinite(x.v));
  if (xs.length < COACH_MIN_GAMES) return null;
  const med = median(xs.map((x) => x.v));
  const worse = (v) => (a.kind === 'share' || !a.low ? v < med : v > med);
  const bad = xs.filter((x) => worse(x.v)).map((x) => x.g);
  const good = xs.filter((x) => !worse(x.v)).map((x) => x.g);
  const won = xs.filter((x) => x.g.result === 'Sejr'); const lost = xs.filter((x) => x.g.result === 'Nederlag');
  const sum = (ys, f) => ys.reduce((s, x) => s + f(x), 0);
  const agg = a.kind === 'share'
    ? { lossHit: sum(lost, (x) => x.raw.hit), lossOf: sum(lost, (x) => x.raw.of), winHit: sum(won, (x) => x.raw.hit), winOf: sum(won, (x) => x.raw.of) }
    : { lossSum: sum(lost, (x) => x.raw), winSum: sum(won, (x) => x.raw) };
  // Peger dine sejre og nederlag samme vej som rådet? (andel/antal pr. kamp i nederlag er værst)
  const lossRate = a.kind === 'share' ? agg.lossHit / (agg.lossOf || 1) : agg.lossSum / (lost.length || 1);
  const winRate = a.kind === 'share' ? agg.winHit / (agg.winOf || 1) : agg.winSum / (won.length || 1);
  const agrees = lost.length >= 3 && won.length >= 3 && (a.kind === 'share' || !a.low ? lossRate < winRate : lossRate > winRate);
  const cost = bad.length >= 3 && good.length >= 3 ? winsOf(good) / good.length - winsOf(bad) / bad.length : null;
  return { a, med, n: xs.length, worse, bad: bad.length, badWins: winsOf(bad), good: good.length, goodWins: winsOf(good), wins: won.length, losses: lost.length, agg, agrees, cost, values: xs };
}
const cpct = (x) => `${Math.round(x * 100)} %`;
// "Du var ved 4 af 17 drager i dine nederlag mod 11 af 15 i sejrene" / "6 i 9 nederlag mod 1 i 8 sejre".
function coachEvidence(s) {
  const { a, agg } = s;
  if (a.kind === 'share') return `Du var ved ${agg.lossHit} af ${agg.lossOf} ${a.unit} i dine nederlag mod ${agg.winHit} af ${agg.winOf} i dine sejre.`;
  const per = (n, k) => decs(n / k);
  return `${a.unit[0].toUpperCase()}${a.unit.slice(1)}: ${agg.lossSum} i ${s.losses} nederlag (${per(agg.lossSum, s.losses)} pr. kamp) mod ${agg.winSum} i ${s.wins} sejre (${per(agg.winSum, s.wins)} pr. kamp).`;
}
function coachSplitText(s) {
  const { a } = s;
  const med = a.kind === 'share' ? cpct(s.med) : decs(s.med);
  const side = a.kind === 'share' || !a.low ? 'under' : 'over';
  return `Kampe ${side} din median (${med}): ${s.badWins} af ${s.bad} sejre - ellers ${s.goodWins} af ${s.good}.`;
}
function adviceItem(s, role, scope) {
  const src = adviceSrc(s.a, role);
  return { key: s.a.key, title: s.a.title, evidence: coachEvidence(s), extra: s.a.extra ? s.a.extra(s.values.map((x) => x.g)) : null, split: coachSplitText(s), scope, games: s.n,
    next: adviceDo(s.a, role), source: src?.name || null, url: src?.url || null };
}

// Rådene for en rolle (og champion), sorteret efter hvor meget de hænger sammen med dine nederlag.
function coachFor(position, championId = null) {
  const { games, scope } = coachGroup(position, championId);
  if (games.length < COACH_MIN_GAMES) return { role: position, scope, games: games.length, need: COACH_MIN_GAMES - games.length, advice: [] };
  const advice = COACH_ADVICE.filter((a) => a.roles.includes(position)).map((a) => coachSplit(a, games))
    .filter((s) => s && s.agrees && s.cost != null && s.cost > 0).sort((x, y) => y.cost - x.cost);
  return { role: position, scope, games: games.length, need: 0,
    advice: advice.slice(0, 5).map((s) => ({ ...adviceItem(s, position, scope), media: adviceMedia(s.a, s.values.map((x) => x.g)) })) };
}

// Kampens tal for ét råd ("I denne kamp: 0 af 3 drager").
function coachGameText(a, g) {
  const v = a.get(g);
  if (a.kind === 'share') return `I denne kamp var du ved ${v.hit} af ${v.of} ${a.unit}.`;
  if (a.key === 'convert') return `I denne kamp var du foran ved 10 min (+${gnum(g.review.at[10].gold)} g), og dit hold tog ${v} tårne/store monstre mellem 10 og 20 min.`;
  return `I denne kamp: ${v} ${a.unit}.`;
}
// Efter kampen: op til 3 råd hvor kampen lå på den dårlige side af din median.
function coachGame(g) {
  if (!coachReady(g)) return null;
  const { games, scope } = coachGroup(g.position, g.championId);
  const others = games.filter((x) => x !== g);
  if (others.length < COACH_MIN_GAMES) return { need: COACH_MIN_GAMES - others.length, role: g.position, advice: [] };
  const out = [];
  for (const a of COACH_ADVICE.filter((x) => x.roles.includes(g.position))) {
    const v = coachValue(a, g);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const s = coachSplit(a, others);
    if (!s || !s.agrees || !(s.cost > 0) || !s.worse(v)) continue;
    out.push({ ...adviceItem(s, g.position, scope), game: coachGameText(a, g), cost: s.cost, moments: adviceMoments(a, g).map((m) => momentView(m, g)) });
  }
  out.sort((x, y) => y.cost - x.cost);
  return { role: g.position, need: 0, advice: out.slice(0, 3).map(({ cost, ...x }) => x) };
}

// Det der ikke kan måles fra klientens timeline (én position pr. minut, kun kills/bygninger/monstre).
const COACH_UNMEASURED = [
  'Teleport-brug (timelinen viser ikke summoner spells)',
  'facecheck af buske og vision før du går ind (ingen ward-events i timelinen)',
  'tracking af fjendens jungler og lane-prio (kun én position pr. minut)',
  'recall-timing (kun omtrent: du kan stå i base på et minut-billede)',
];

// Kortet "Din coach": din mest spillede rolle (seneste 20 kampe) og de andre roller med antal.
function topChampion(position) {
  const n = new Map();
  for (const g of srGames().filter((x) => x.position === position && coachReady(x))) n.set(g.championId, (n.get(g.championId) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
function coachView() {
  if (!app.cfg.coach) return null;
  const main = mainRole();
  if (!main) return null;
  const roles = [...new Set(srGames().slice(0, 20).map((g) => g.position).filter(Boolean))];
  return {
    main: coachFor(main, topChampion(main)),
    others: roles.filter((r) => r !== main).map((r) => { const c = coachFor(r); return { role: r, games: c.games, need: c.need, top: c.advice[0] || null }; }),
    minGames: COACH_MIN_GAMES,
    near: COACH_NEAR,
    unmeasured: COACH_UNMEASURED,
    sources: COACH_URL,
  };
}
// Champion select: én linje for rollen/championen du har låst.
function coachPick(position, championId) {
  if (!app.cfg.coach || !position) return null;
  const c = coachFor(position, championId);
  if (!c.advice.length) return c.need ? { need: c.need, role: position } : null;
  const a = c.advice[0];
  return { title: a.title, evidence: a.evidence, next: a.next, url: a.url, scope: c.scope };
}

// ---------- OBS: video af dine dødsfald (kun med obsClips: true) ----------
// OBS WebSocket v5 (indbygget i OBS 28+). Node's indbyggede WebSocket-klient (Node 22) - ingen ekstra pakker.
// Med obsClips slået fra kaldes intet her: ingen forbindelse, ingen beskeder.

const OBS_CLIP_DELAY = 3000; // vent 3 sek. efter dødsfaldet, så selve dødsfaldet er med i klippet
const obs = { ws: null, ready: false, prepared: false, status: null, nextTry: 0, pending: new Map(), seq: 0, lastPath: null, closeTimer: null };
const obsUrl = () => process.env.LOL_HELPER_OBS || `ws://127.0.0.1:${Number(app.cfg.obsPort) || 4455}`;

function setObsStatus(text) {
  if (obs.status === text) return;
  obs.status = text;
  log(text);
}

function obsConnect() {
  if (!app.cfg.obsClips || obs.ws || Date.now() < obs.nextTry) return;
  clearTimeout(obs.closeTimer);
  obs.nextTry = Date.now() + 60000; // højst ét forsøg i minuttet, og kun én statuslinje
  if (typeof WebSocket !== 'function') { setObsStatus('OBS-klip: denne version af programmet mangler WebSocket.'); return; }
  let ws;
  try { ws = new WebSocket(obsUrl()); } catch { setObsStatus(`OBS svarer ikke (${obsUrl()}).`); return; }
  obs.ws = ws;
  obs.ready = false;
  ws.onerror = () => {};
  ws.onclose = (e) => {
    const was = obs.ready;
    obs.ws = null;
    obs.ready = false;
    obs.prepared = false;
    for (const p of obs.pending.values()) p.reject(new Error('OBS-forbindelsen lukkede'));
    obs.pending.clear();
    if (!app.cfg.obsClips) return;
    if (e?.code === 4009) setObsStatus('OBS afviste adgangskoden - tjek "obsPassword" i config.json.');
    else if (!was) setObsStatus(`OBS svarer ikke (${obsUrl()}) - start OBS og slå WebSocket-serveren til. Prøver igen om lidt.`);
    else setObsStatus('Forbindelsen til OBS blev afbrudt - prøver igen om lidt.');
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.op === 0) { // Hello
      const auth = m.d?.authentication;
      const identify = { rpcVersion: 1, eventSubscriptions: 0 };
      if (auth) {
        const pw = String(app.cfg.obsPassword || '');
        if (!pw) { setObsStatus('OBS kræver en adgangskode - skriv den i config.json som "obsPassword".'); ws.close(); return; }
        const b64 = (s) => createHash('sha256').update(s).digest('base64');
        identify.authentication = b64(b64(pw + auth.salt) + auth.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (m.op === 2) { // Identified
      obs.ready = true;
      // Replay bufferen startes kun til en kamp - ikke når forbindelsen kun skal bruges til at finde optagemappen.
      if (app.live) obsPrepare().catch(() => {});
    } else if (m.op === 7) { // RequestResponse
      const p = obs.pending.get(m.d?.requestId);
      if (!p) return;
      obs.pending.delete(m.d.requestId);
      clearTimeout(p.timer);
      if (m.d.requestStatus?.result) p.resolve(m.d.responseData || {});
      else p.reject(Object.assign(new Error(m.d.requestStatus?.comment || `kode ${m.d.requestStatus?.code}`), { code: m.d.requestStatus?.code }));
    }
  };
}

function obsRequest(requestType, requestData) {
  return new Promise((resolve, reject) => {
    if (!obs.ws || !obs.ready) return reject(new Error('OBS er ikke forbundet'));
    const requestId = `lrh-${++obs.seq}`;
    const timer = setTimeout(() => { obs.pending.delete(requestId); reject(new Error('OBS svarede ikke')); }, 10000);
    obs.pending.set(requestId, { resolve, reject, timer });
    obs.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
  });
}

// Start replay bufferen hvis den ikke kører, og husk det sidst gemte klip (så et nyt kan kendes).
async function obsPrepare() {
  obs.prepared = true;
  try {
    const st = await obsRequest('GetReplayBufferStatus');
    if (!st.outputActive) {
      await obsRequest('StartReplayBuffer');
      log('OBS: replay buffer startet.');
    }
  } catch (e) {
    setObsStatus(`OBS: replay bufferen kunne ikke startes (${e.message}) - slå den til i OBS: Indstillinger -> Output -> Replay Buffer.`);
    return;
  }
  try { obs.lastPath = (await obsRequest('GetLastReplayBufferReplay')).savedReplayPath || null; } catch {}
  await obsRememberDir().catch(() => {});
  setObsStatus('OBS forbundet - dine dødsfald gemmes som klip.');
}

function obsClipDeath(g, death) {
  if (!app.cfg.obsClips) return;
  setTimeout(async () => {
    if (!obs.ready) {
      log(`OBS: dødsfaldet ${mmss(death.t)} kunne ikke klippes - OBS er ikke forbundet.`);
      return;
    }
    try {
      await obsRequest('SaveReplayBuffer');
      // Filen skrives lidt efter: vent på at "sidste klip" skifter (op til 20 sek. - også efter kampen er gemt).
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const r = await obsRequest('GetLastReplayBufferReplay').catch(() => null);
        const p = r?.savedReplayPath;
        if (p && p !== obs.lastPath) {
          obs.lastPath = p;
          death.clip = p;
          // Nåede "Find klip" at finde filen først, står den nu kun ved dødsfaldet (programmets egen tid er mest præcis).
          for (const x of history.games) if (Array.isArray(x.clipLog)) x.clipLog = x.clipLog.filter((c) => c.file !== p);
          log(`OBS: klip af dødsfaldet ${mmss(death.t)} gemt (${path.basename(p)}).`);
          // Gem med det samme: er kampen allerede gemt, står klippet i den (samme objekt). Ellers i pendingClips,
          // så en genstart midt i kampen ikke mister det (kobles til kampen, når den er gemt - se recoverClips).
          if (app.game === g) history.pendingClips.push({ file: p, t: death.t, at: death.at || Date.now(), gameId: g.gameId || null, killer: death.killer || null });
          saveHistory();
          broadcast();
          return;
        }
      }
      log(`OBS: klippet af dødsfaldet ${mmss(death.t)} blev ikke færdigt i tide - "Find klip til mine kampe" kobler det bagefter.`);
    } catch (e) {
      log(`OBS: klippet kunne ikke gemmes (${e.message}).`);
    }
  }, OBS_CLIP_DELAY);
}

function obsClose() {
  clearTimeout(obs.closeTimer);
  obs.nextTry = 0;
  if (obs.ws) { try { obs.ws.close(); } catch {} }
  obs.ws = null;
  obs.ready = false;
  obs.prepared = false;
}
// Efter kampen: luk forbindelsen, når de sidste klip er gemt.
function obsCloseSoon() {
  if (!obs.ws) return;
  clearTimeout(obs.closeTimer);
  obs.closeTimer = setTimeout(() => { if (!app.live) { obsClose(); obs.status = null; } }, 20000);
  obs.closeTimer.unref?.();
}

// Kun klip der hører til en af dine kampe i history.json (gemt af programmet eller fundet i OBS' optagemappe og koblet
// til kampen) og kun fra deres egen mappe.
function allowedClip(p) {
  if (typeof p !== 'string' || !p) return null;
  const clips = history.games.flatMap((g) => gameClips(g).map((c) => c.file));
  const dirs = new Set(clips.map((c) => path.resolve(path.dirname(c))));
  const want = path.resolve(p);
  if (!clips.some((c) => path.resolve(c) === want) || !dirs.has(path.dirname(want))) return null;
  if (!/\.(mp4|mkv|mov|flv|webm|ts|m3u8)$/i.test(want)) return null;
  return want;
}

// ---------- Klip der ikke blev koblet til en kamp ----------
// OBS' replay buffer gemmer fx "Replay 2026-11-09 14-28-57.mp4" (standardnavnet, lokal tid) i optagemappen. Klip der
// ikke står ved en kamp (fx efter en genstart midt i kampen) findes ud fra filens ændringstid (mtime): den skal ligge
// mellem kampens start (klientens gameCreation) og slut. Parring med dødsfaldene:
// - samme antal klip og dødsfald uden klip: 1:1 i tidsorden.
// - ellers med forskydningen mellem kamptid og væg-tid (indlæsning + OBS' gemme-forsinkelse), målt på programmets egne
//   klip i kampen eller fundet i data (mindst 2 klip skal pege på samme forskydning) - og kun inden for 4 sek.
// - kan forskydningen ikke afgøres, gættes der ikke: klippene vises som "Andre klip fra kampen".
// I Tobias' rigtige kampe (9/11-2026) var forskydningen 37 og 104 sek. fra gameCreation, med højst 1,5 sek. spredning
// inden for samme kamp.
const CLIP_FILE_RE = /^Replay[ _-].*\.(mp4|mkv|mov|flv|webm|ts)$/i;
const CLIP_PAIR_TOL_SEC = 4;
const CLIP_LOAD_MAX_SEC = 400; // gameCreation -> kamptid 0:00 (indlæsning) + gemme-forsinkelse
const CLIP_END_MARGIN_MS = 90 * 1000;
const PENDING_CLIP_MAX_MS = 3 * 24 * 3600 * 1000;
const normPath = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const defaultClipDir = () => process.env.LOL_HELPER_CLIP_DIR || path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos');

// Alle klip i en kamp: gemt under kampen (deathLog[].clip) og fundet bagefter (clipLog). t = kamptid, null = intet dødsfald.
function gameClips(g) {
  const out = [];
  for (const d of Array.isArray(g.deathLog) ? g.deathLog : []) {
    if (d && typeof d.clip === 'string' && d.clip) out.push({ t: typeof d.t === 'number' ? d.t : null, file: d.clip, killer: d.killer || null });
  }
  for (const c of Array.isArray(g.clipLog) ? g.clipLog : []) {
    // Samme fil to steder (fundet i mappen, lige før programmets eget klip blev færdigt): programmets eget vinder.
    if (c && typeof c.file === 'string' && c.file && !out.some((x) => x.file === c.file)) out.push({ t: typeof c.t === 'number' ? c.t : null, est: typeof c.est === 'number' ? c.est : null, file: c.file, killer: c.killer || null, how: c.how || null });
  }
  return out;
}

// Kampens tidsrum i væg-tid (ms). start = klientens gameCreation (fra gennemgangen), ellers slut minus længde minus 5 min.
function gameWindow(g) {
  const end = Date.parse(g.date);
  if (!Number.isFinite(end)) return null;
  const dur = (Number(g.review?.dur) || Number(g.duration) || 0) * 1000;
  const exact = Number(g.review?.start) > 0;
  const start = exact ? Number(g.review.start) : end - dur - 5 * 60000;
  return { start, end: Math.max(end, start + dur) + CLIP_END_MARGIN_MS, exact };
}

// Par klip (filer med væg-tid i ms) med dødsfald (kamptid i sek.). Ren funktion - se reglerne ovenfor.
// anchors: kendte klip i kampen ({ t, at }). start: gameCreation (ms) hvis kendt, til at afvise umulige forskydninger.
function pairClips(deaths, files, { anchors = [], start = null } = {}) {
  const ds = deaths.filter((t) => typeof t === 'number').sort((a, b) => a - b);
  const fsorted = files.filter((f) => f && Number.isFinite(f.at)).sort((a, b) => a.at - b.at);
  const out = { how: 'none', offset: null, pairs: [], other: [] };
  if (!fsorted.length) return out;
  if (ds.length && fsorted.length === ds.length) {
    out.how = 'order';
    out.pairs = fsorted.map((f, i) => ({ file: f.file, at: f.at, t: ds[i] }));
    return out;
  }
  const match = (o) => {
    const used = new Set();
    const pairs = [];
    for (const f of fsorted) {
      let best = -1;
      for (let j = 0; j < ds.length; j++) {
        if (used.has(j)) continue;
        const r = Math.abs(f.at / 1000 - o - ds[j]);
        if (r <= CLIP_PAIR_TOL_SEC && (best < 0 || r < Math.abs(f.at / 1000 - o - ds[best]))) best = j;
      }
      if (best >= 0) { used.add(best); pairs.push({ file: f.file, at: f.at, t: ds[best] }); }
    }
    return pairs;
  };
  const plausible = (o) => start == null || (o - start / 1000 >= 0 && o - start / 1000 <= CLIP_LOAD_MAX_SEC);
  let off = null;
  const anc = anchors.map((a) => a.at / 1000 - a.t).filter(Number.isFinite);
  if (anc.length) {
    off = median(anc);
    out.how = 'anchor';
  } else if (ds.length) {
    let best = null;
    let tie = false;
    for (const f of fsorted) {
      for (const d of ds) {
        const o = f.at / 1000 - d;
        if (!plausible(o)) continue;
        const n = match(o).length;
        if (!best || n > best.n) { best = { o, n }; tie = false; } else if (n === best.n && Math.abs(o - best.o) > 2 * CLIP_PAIR_TOL_SEC) tie = true;
      }
    }
    if (best && best.n >= 2 && !tie) {
      // Midt i de parrede klips forskydning (ikke kun det ene par, kandidaten kom fra).
      off = median(match(best.o).map((p) => p.at / 1000 - p.t));
      out.how = 'offset';
    }
  }
  if (off != null) {
    out.offset = off;
    out.pairs = match(off);
  }
  const paired = new Set(out.pairs.map((p) => p.file));
  out.other = fsorted.filter((f) => !paired.has(f.file)).map((f) => ({ file: f.file, at: f.at, est: off != null ? Math.max(0, Math.round(f.at / 1000 - off)) : null }));
  return out;
}

function clipDirs(extra = []) {
  const dirs = new Map();
  const add = (d) => { if (typeof d === 'string' && d) dirs.set(normPath(d), path.resolve(d)); };
  for (const d of extra) add(d);
  add(history.clipDir);
  for (const g of history.games) for (const c of gameClips(g)) add(path.dirname(c.file));
  for (const p of history.pendingClips) add(path.dirname(p.file));
  add(defaultClipDir());
  return [...dirs.values()];
}

function listClipFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!CLIP_FILE_RE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) out.push({ file, at: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

const CLIP_HOW = {
  live: 'gemt under kampen',
  order: 'samme antal klip og dødsfald - parret i tidsorden',
  anchor: 'ud fra programmets egne klip i samme kamp',
  offset: 'ud fra tidsforskellen mellem klippene og dødsfaldene',
  none: 'kunne ikke afgøre hvilke dødsfald - vist som andre klip',
};

// Kobl klip uden kamp til dine kampe og gem det i history.json med det samme. Synkron (ingen netværk).
function recoverClips(extraDirs = []) {
  const res = { found: 0, pending: 0, games: [], dirs: [] };
  const known = new Set(history.games.flatMap((g) => gameClips(g).map((c) => normPath(c.file))));
  // Også filnavnet alene: samme klip kan stå med en anden sti (fx OBS' "C:/..." mod en omdirigeret Videoer-mappe).
  // OBS' navne har tidspunktet til sekundet, så to forskellige klip har ikke samme navn.
  const knownNames = new Set(history.games.flatMap((g) => gameClips(g).map((c) => path.basename(c.file.replace(/\\/g, '/')).toLowerCase())));
  let changed = false;
  const windows = history.games.map((g) => ({ g, w: gameWindow(g) })).filter((x) => x.w);
  // Den seneste kamp, der var startet, da filen blev skrevet (kampe overlapper ikke).
  const gameAt = (at) => windows.filter((x) => at >= x.w.start && at <= x.w.end).sort((a, b) => b.w.start - a.w.start)[0]?.g || null;
  const killerName = (k) => (k == null ? null : dd.champions?.[k]?.name || String(k));
  const add = (g, entry) => {
    if (!Array.isArray(g.clipLog)) g.clipLog = [];
    g.clipLog.push(entry);
    known.add(normPath(entry.file));
    knownNames.add(path.basename(entry.file.replace(/\\/g, '/')).toLowerCase());
    changed = true;
  };

  // 1) Klip gemt under en kamp, der ikke nåede at blive gemt med kampen (genstart midt i kampen): kamptiden er kendt.
  const keep = [];
  for (const p of history.pendingClips) {
    if (known.has(normPath(p.file))) { changed = true; continue; }
    const g = (p.gameId && history.games.find((x) => x.gameId === p.gameId)) || gameAt(p.at);
    if (g) {
      add(g, { t: p.t, file: p.file, how: 'live', killer: p.killer || null });
      res.pending++;
      res.found++;
      res.games.push({ date: g.date, champion: g.champion, gameId: g.gameId || null, files: 1, paired: 1, other: 0, how: 'live' });
    } else if (Date.now() - p.at < PENDING_CLIP_MAX_MS) keep.push(p);
    else changed = true;
  }
  history.pendingClips = keep;

  // 2) Replay-filer i optagemappen, som ingen kamp har endnu.
  res.dirs = clipDirs(extraDirs);
  const byGame = new Map();
  for (const f of listClipFiles(res.dirs)) {
    if (known.has(normPath(f.file)) || knownNames.has(path.basename(f.file).toLowerCase())) continue;
    const g = gameAt(f.at);
    if (!g) continue;
    if (!byGame.has(g)) byGame.set(g, []);
    byGame.get(g).push(f);
  }
  for (const [g, files] of byGame) {
    const w = gameWindow(g);
    const all = (Array.isArray(g.review?.deaths) ? g.review.deaths : Array.isArray(g.deathLog) ? g.deathLog : []).filter((d) => d && typeof d.t === 'number');
    const open = all.filter((d) => !clipAt(g, d.t));
    const anchors = gameClips(g).filter((c) => c.t != null).map((c) => {
      try { return { t: c.t, at: fs.statSync(c.file).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
    const r = pairClips(open.map((d) => d.t), files, { anchors, start: w.exact ? w.start : null });
    for (const p of r.pairs) add(g, { t: p.t, file: p.file, how: r.how, killer: killerName(open.find((d) => d.t === p.t)?.killer) });
    for (const o of r.other) add(g, { t: null, est: o.est, file: o.file, how: 'other' });
    res.found += files.length;
    res.games.push({ date: g.date, champion: g.champion, gameId: g.gameId || null, deaths: all.length, files: files.length, paired: r.pairs.length, other: r.other.length, how: r.how });
  }
  if (changed) saveHistory();
  for (const x of res.games) {
    log(`Klip fundet til ${x.champion} (${new Date(x.date).toLocaleString('da-DK')}): ${x.paired} af ${x.files} koblet til et dødsfald` +
      ` (${CLIP_HOW[x.how] || x.how})${x.other ? `, ${x.other} vist som andre klip fra kampen` : ''}.`);
  }
  return res;
}

// OBS' optagemappe (hvor replay bufferen gemmer), husket i history.json.
async function obsRememberDir() {
  if (!obs.ready) return null;
  const d = (await obsRequest('GetRecordDirectory')).recordDirectory;
  if (typeof d !== 'string' || !d) return null;
  if (history.clipDir !== d) { history.clipDir = d; saveHistory(); }
  return d;
}

// "Find klip til mine kampe": spørg OBS om optagemappen (forbinder kort, hvis OBS-klip er slået til), og kobl klippene.
async function findClipsForGames() {
  let dir = null;
  if (app.cfg.obsClips && typeof WebSocket === 'function') {
    const opened = !obs.ws;
    if (opened) { obs.nextTry = 0; obsConnect(); }
    for (let i = 0; i < 30 && obs.ws && !obs.ready; i++) await sleep(200);
    try { dir = await obsRememberDir(); } catch {} finally { if (opened && !app.live) obsCloseSoon(); }
  }
  const r = recoverClips(dir ? [dir] : []);
  return { ok: true, obsDir: dir, ...r };
}

const CLIP_TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.flv': 'video/x-flv', '.ts': 'video/mp2t' };
function serveClip(req, res, file) {
  let size;
  try { size = fs.statSync(file).size; } catch { res.writeHead(404); return res.end(); }
  const type = CLIP_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && size) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

function openFile(file) {
  if (process.platform === 'win32') execFile('explorer.exe', [file], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('open', [file], () => {});
  else execFile('xdg-open', [file], () => {});
}

// ---------- "Se det i replayet": start kampens replay i League-klienten og hop til øjeblikket ----------
// Kun efter kampen og kun med Riots egen replay-funktion. Kilder (tjekket 9/11-2026):
// - Klientens egne endpoints (LCU /help?format=Full fra en rigtig klient, patch 16.22): GET /lol-replays/v1/configuration
//   (isReplaysEnabled, isPlayingGame, isPlayingReplay, isPatching, gameVersion), GET /lol-replays/v1/rofls/path,
//   GET /lol-replays/v1/metadata/{gameId} -> {state, gameId, downloadProgress} (state: checking, found, watch, download,
//   downloading, retryDownload, incompatible, missingOrExpired, lost, error, maxLimitReached, unsupported),
//   POST /lol-replays/v1/rofls/{gameId}/download og .../watch med body LolReplaysReplayContextData {componentType}.
// - componentType "replay-button_match-history" (klientens egen kamphistorik-knap; brugt af LeagueAkari, hasagi-core m.fl.).
// - Målt på en rigtig klient (github.com/wnzzer/rank-analysis, 27/7-2026): metadata giver 404 før der er bedt om
//   download, og downloadProgress er ikke altid en procent - derfor vises den kun når den ligger i 0-100.
// - Riots Replay API (https://developer.riotgames.com/docs/lol#game-client-api_replay-api): slået fra som standard,
//   kræver "[General] EnableReplayApi=1" i game.cfg. GET /replay/game, GET/POST /replay/playback - felterne
//   time/paused/speed/length/seeking er dem Riots League Director bruger (github.com/RiotGames/leaguedirector, api.py).
// game.cfg ændres KUN når du selv slår "Replay-spring" til i vinduet (backup + den gamle værdi lægges tilbage, når
// du slår det fra). Uden det starter knappen bare replayet, og du spoler selv.

const REPLAY_COMPONENT = 'replay-button_match-history';
const REPLAY_LEAD_SEC = 10;            // hop til 10 sek. før øjeblikket
const REPLAY_POLL_MS = Number(process.env.LOL_HELPER_REPLAY_POLL_MS) || 1000;
const REPLAY_DOWNLOAD_TRIES = 120;     // ca. 2 min på at hente replayet
const REPLAY_LOAD_TRIES = 180;         // ca. 3 min på at replayet indlæses i spillet
const REPLAY_API = (() => {
  const [protocol, port] = (process.env.LOL_HELPER_REPLAY || process.env.LOL_HELPER_LIVE || 'https:2999').split(':');
  return { protocol, port: Number(port) };
})();
const replayApi = (method, p, body) => localJson(REPLAY_API.protocol, REPLAY_API.port, method, p, {}, body, 3000);
const REPLAY_BUSY = {
  ChampSelect: 'Ikke under champion select.', InProgress: 'Ikke mens du er i kamp.', GameStart: 'Ikke mens en kamp starter.',
  Reconnect: 'Ikke mens du er i kamp.', Matchmaking: 'Ikke mens du står i kø.', ReadyCheck: 'Ikke mens du står i kø.',
};
const REPLAY_FAIL = {
  incompatible: 'Replayet er fra en anden patch og kan ikke afspilles i denne klient.',
  missingOrExpired: 'Riot har ikke replayet længere (udløbet).',
  lost: 'Replayet er gået tabt hos Riot.',
  unsupported: 'Replays understøttes ikke for denne kamp.',
  maxLimitReached: 'Klienten har for mange replays - slet nogle i replay-mappen.',
  error: 'Klienten kunne ikke hente replayet.',
};
const majorMinor = (v) => { const m = /^(\d+)\.(\d+)/.exec(String(v || '')); return m ? `${m[1]}.${m[2]}` : null; };

// League's game.cfg ligger i Config-mappen ved siden af klientens lockfile (Windows: C:\Riot Games\League of Legends\Config).
function gameCfgPath() {
  if (process.env.LOL_HELPER_GAME_CFG) return process.env.LOL_HELPER_GAME_CFG;
  const dirs = [app.client?.dir, ...lockfileCandidates(findClient.lastCmdline || '').map((f) => path.dirname(f))].filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, 'Config', 'game.cfg');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const CFG_SECTION = /^\s*\[([^\]]*)\]\s*$/;
const CFG_KEY = /^\s*EnableReplayApi\s*=\s*(.*?)\s*$/i;
// Værdien af EnableReplayApi under [General] (found: false hvis linjen ikke findes).
function cfgReplayValue(text) {
  let section = null;
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = CFG_SECTION.exec(line);
    if (s) { section = s[1].trim().toLowerCase(); continue; }
    const k = section === 'general' ? CFG_KEY.exec(line) : null;
    if (k) return { found: true, value: k[1] };
  }
  return { found: false, value: null };
}
// Sæt (eller fjern, value = null) EnableReplayApi under [General]. Resten af filen røres ikke (linjeskift og BOM bevares).
function cfgSetReplay(text, value) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  let section = null; let header = -1; let at = -1;
  lines.forEach((line, i) => {
    const s = CFG_SECTION.exec(line);
    if (s) { section = s[1].trim().toLowerCase(); if (section === 'general' && header === -1) header = i; return; }
    if (section === 'general' && at === -1 && CFG_KEY.test(line)) at = i;
  });
  if (value == null) {
    if (at !== -1) lines.splice(at, 1);
    return bom + lines.join(eol);
  }
  const line = `EnableReplayApi=${value}`;
  if (at !== -1) lines[at] = line;
  else if (header !== -1) lines.splice(header + 1, 0, line);
  else return `${bom}[General]${eol}${line}${eol}${body}`;
  return bom + lines.join(eol);
}
// Læser (aldrig skriver) game.cfg: er Replay API'et slået til? Gemmes i 5 sek.
function replayCfgState(force = false) {
  if (!force && app.replayCfg && Date.now() - app.replayCfg.at < 5000) return app.replayCfg;
  const file = gameCfgPath();
  let st = { at: Date.now(), file, on: false, value: null, error: null };
  if (file) {
    try { const v = cfgReplayValue(fs.readFileSync(file, 'utf8')); st = { ...st, on: v.value === '1', value: v.found ? v.value : null }; } catch (e) { st.error = e.message; }
  }
  app.replayCfg = st;
  return st;
}

// Kører spillet (eller et replay)? Port 2999 hører til spilprocessen - ethvert HTTP-svar betyder at den kører.
async function gameProcessRunning() {
  for (const get of [() => liveGet('/liveclientdata/gamestats'), () => replayApi('GET', '/replay/game')]) {
    try { await get(); return true; } catch (e) { if (e.status) return true; }
  }
  return false;
}

// Slå replay-spring til/fra (kun på din opfordring fra vinduet). Til: backup af game.cfg + EnableReplayApi=1.
// Fra: den værdi der stod før (eller linjen fjernes, hvis den ikke fandtes).
async function setReplayJump(on) {
  const phase = app.client ? await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase').catch(() => null) : null;
  if (['ChampSelect', 'InProgress', 'GameStart', 'Reconnect'].includes(phase)) return { ok: false, error: 'Ikke under champion select eller kamp - prøv igen bagefter.' };
  if (await gameProcessRunning()) return { ok: false, error: 'Luk spillet eller replayet først (spillet skriver selv game.cfg, når det lukker).' };
  const file = gameCfgPath();
  if (!file) return { ok: false, error: "League's game.cfg blev ikke fundet. Start League-klienten, så finder programmet installationsmappen." };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `game.cfg kunne ikke læses (${e.message}).` }; }
  const cur = cfgReplayValue(text);
  try {
    if (on) {
      const backup = `${file}.lrh-backup`;
      fs.copyFileSync(file, backup);
      // Den oprindelige værdi huskes kun første gang (ikke når du allerede har slået det til).
      const before = app.cfg.replayJump && app.cfg.replayApiBefore !== undefined ? app.cfg.replayApiBefore : (cur.found ? cur.value : null);
      if (cur.value !== '1') fs.writeFileSync(file, cfgSetReplay(text, '1'));
      app.cfg.replayJump = true;
      app.cfg.replayApiBefore = before;
      saveConfigValue('replayApiBefore', before);
      saveConfigValue('replayJump', true);
      log(`Replay-spring slået til: EnableReplayApi=1 under [General] i ${file} (backup: ${path.basename(backup)}).`);
      replayCfgState(true);
      return { ok: true, file, backup };
    }
    const before = app.cfg.replayApiBefore === undefined ? '0' : app.cfg.replayApiBefore;
    const next = cfgSetReplay(text, before);
    if (app.cfg.replayJump && next !== text) fs.writeFileSync(file, next);
    app.cfg.replayJump = false;
    delete app.cfg.replayApiBefore;
    saveConfigValue('replayJump', false);
    saveConfigValue('replayApiBefore', undefined);
    log(`Replay-spring slået fra: EnableReplayApi sat tilbage til ${before == null ? '(ingen linje)' : before} i ${file}.`);
    replayCfgState(true);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: `game.cfg kunne ikke ændres (${e.message}).` };
  }
}

// Klientens replay-indstillinger (kun GET, når klienten er ledig). Gemmes i 15 sek.
async function refreshReplayEnv(force = false) {
  if (!app.client) { app.replayEnv = null; return null; }
  if (!force && app.replayEnv && Date.now() - app.replayEnv.at < 15000) return app.replayEnv;
  const conf = await lcu(app.client, 'GET', '/lol-replays/v1/configuration').catch(() => null);
  const dir = conf ? await lcu(app.client, 'GET', '/lol-replays/v1/rofls/path').catch(() => null) : null;
  app.replayEnv = { at: Date.now(), conf: conf && typeof conf === 'object' ? conf : null, dir: typeof dir === 'string' ? dir : null };
  if (app.replayEnv.conf) app.replayWatching = Boolean(conf.isPlayingReplay);
  return app.replayEnv;
}

// Hvorfor knappen er slået fra lige nu (null = den virker).
function replayBlock() {
  if (!app.client) return 'League-klienten kører ikke.';
  if (REPLAY_BUSY[app.phase]) return REPLAY_BUSY[app.phase];
  const c = app.replayEnv?.conf;
  if (c?.isPatching) return 'Klienten er ved at opdatere.';
  if (c && c.isReplaysEnabled === false) return 'Replays er slået fra i League-klienten.';
  if (c?.isPlayingGame) return 'Spillet kører allerede.';
  if (app.replayJob && !app.replayJob.done && !app.replayJob.error) return 'Et replay er ved at starte.';
  return null;
}

// Kampens patch: fra gennemgangen (v5) eller klientens kamphistorik.
const gameVersionOf = (g) => g.review?.gv || history.recent.find((x) => x.id === g.gameId)?.gv || null;
// Kan netop denne kamp ses som replay? (Replays kan kun afspilles på samme patch som kampen.)
function replayFor(g) {
  if (!g?.gameId) return { ok: false, reason: 'Kampens id kendes ikke, så replayet kan ikke findes.' };
  const gv = majorMinor(gameVersionOf(g));
  const cv = majorMinor(app.replayEnv?.conf?.gameVersion);
  if (gv && cv && gv !== cv) return { ok: false, gameId: g.gameId, reason: `Kampen er fra patch ${gv} - klienten er på ${cv}. Replays kan kun ses på samme patch.` };
  const pf = g.review?.pf; const dir = app.replayEnv?.dir;
  let local = false;
  try { local = Boolean(pf && dir && fs.existsSync(path.join(dir, `${pf}-${g.gameId}.rofl`))); } catch {}
  return { ok: true, gameId: g.gameId, patch: gv, local };
}

function replayView() {
  const st = replayCfgState();
  const job = app.replayJob;
  return {
    block: replayBlock(),
    jump: st.on,
    optIn: Boolean(app.cfg.replayJump),
    cfgFound: Boolean(st.file),
    cfgError: st.error,
    clientPatch: majorMinor(app.replayEnv?.conf?.gameVersion),
    lead: REPLAY_LEAD_SEC,
    job: job ? { gameId: job.gameId, t: job.t, target: job.target, step: job.step, error: job.error, done: job.done } : null,
  };
}

// Start replayet af en af dine egne kampe og hop til t - REPLAY_LEAD_SEC (kun med replay-spring slået til).
async function startReplay(gameId, t) {
  const g = srGames().find((x) => x.gameId === gameId);
  if (!g) return { ok: false, error: 'Kampen findes ikke i din historik.' };
  if (!app.client) return { ok: false, error: 'League-klienten kører ikke.' };
  app.phase = await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase').catch(() => app.phase);
  await refreshReplayEnv(true);
  const block = replayBlock();
  if (block) return { ok: false, error: block };
  const conf = app.replayEnv?.conf;
  if (!conf) return { ok: false, error: 'Klienten svarer ikke på replay-forespørgsler.' };
  const r = replayFor(g);
  if (!r.ok) return { ok: false, error: r.reason };
  const jump = replayCfgState(true).on;
  const sameReplay = conf.isPlayingReplay && app.replayCurrent === gameId;
  if (conf.isPlayingReplay && !(jump && sameReplay)) return { ok: false, error: 'Et replay kører allerede - luk det først.' };
  const job = { gameId, t, target: Math.max(0, Math.round(t) - REPLAY_LEAD_SEC), step: 'Forbereder replayet...', error: null, done: false };
  app.replayJob = job;
  runReplayJob(job, sameReplay, jump).catch((e) => { job.error = `Replayet kunne ikke startes (${String(e.message).slice(0, 160)}).`; log(`Replay: ${job.error}`); broadcast(); });
  broadcast();
  return { ok: true };
}

async function runReplayJob(job, alreadyPlaying, jump) {
  const set = (step) => { job.step = step; broadcast(); };
  const fail = (msg) => { job.error = msg; log(`Replay: ${msg}`); broadcast(); };
  const busyNow = async () => REPLAY_BUSY[await lcu(app.client, 'GET', '/lol-gameflow/v1/gameflow-phase').catch(() => null)] || null;
  if (!alreadyPlaying) {
    // 1) Hent replayet (download), til klienten melder "watch".
    let posts = 0; let ready = false;
    for (let i = 0; i < REPLAY_DOWNLOAD_TRIES && !ready; i++) {
      if (i) await sleep(REPLAY_POLL_MS);
      if (!app.client) return fail('League-klienten lukkede.');
      if (i % 5 === 0) { const b = await busyNow(); if (b) return fail(`Stoppet: ${b}`); }
      let meta;
      try { meta = await lcu(app.client, 'GET', `/lol-replays/v1/metadata/${job.gameId}`); } catch (e) { meta = e.status === 404 ? null : undefined; }
      const state = meta?.state;
      if (state === 'watch') { ready = true; break; }
      if (REPLAY_FAIL[state]) return fail(REPLAY_FAIL[state]);
      if (meta === null || state === 'download' || state === 'retryDownload') {
        if (posts < 3) {
          posts++;
          set('Henter replayet fra Riot...');
          await lcu(app.client, 'POST', `/lol-replays/v1/rofls/${job.gameId}/download`, { componentType: REPLAY_COMPONENT });
        }
        continue;
      }
      if (state === 'downloading') {
        const p = meta.downloadProgress;
        set(`Henter replayet...${typeof p === 'number' && p >= 0 && p <= 100 ? ` ${p} %` : ''}`);
      } else if (meta) set('Klienten tjekker replayet...');
    }
    if (!ready) return fail('Klienten blev ikke klar med replayet inden for 2 minutter. Kampen er måske for gammel, eller Riot har ikke replayet.');
    const b = await busyNow();
    if (b) return fail(`Stoppet: ${b}`);
    // 2) Start replayet i spillet.
    set('Starter replayet i League...');
    await lcu(app.client, 'POST', `/lol-replays/v1/rofls/${job.gameId}/watch`, { componentType: REPLAY_COMPONENT });
    app.replayWatching = true;
    app.replayCurrent = job.gameId;
    log(`Replay: kamp ${job.gameId} startet${jump ? ` - hopper til ${mmss(job.target)}` : ''}.`);
  }
  if (!jump) {
    job.done = true;
    return set(`Replayet starter. Spol selv til ${mmss(job.target)} (${REPLAY_LEAD_SEC} sek. før ${mmss(job.t)}) - eller slå "Replay-spring" til, så hopper programmet selv.`);
  }
  // 3) Vent på Replay API'et (spillet indlæser replayet), og sæt tiden.
  set('Venter på at replayet er indlæst...');
  let pb = null;
  for (let i = 0; i < REPLAY_LOAD_TRIES && !pb; i++) {
    if (i) await sleep(REPLAY_POLL_MS);
    if (!(await replayApi('GET', '/replay/game').catch(() => null))) continue;
    const x = await replayApi('GET', '/replay/playback').catch(() => null);
    if (x && typeof x.length === 'number' && x.length > 0) pb = x;
  }
  if (!pb) return fail(`Replayet startede, men Replay API'et svarede ikke inden for 3 minutter. Står "EnableReplayApi=1" stadig i game.cfg? Spol selv til ${mmss(job.target)}.`);
  const target = Math.min(job.target, Math.floor(pb.length));
  for (let k = 0; k < 3; k++) {
    await replayApi('POST', '/replay/playback', { time: target, paused: false }).catch(() => null);
    for (let i = 0; i < 5; i++) {
      await sleep(REPLAY_POLL_MS);
      const now = await replayApi('GET', '/replay/playback').catch(() => null);
      if (now && !now.seeking && typeof now.time === 'number' && now.time >= target - 5 && now.time <= target + 30) {
        job.done = true;
        log(`Replay: står på ${mmss(target)}.`);
        return set(`Replayet står på ${mmss(target)} - ${REPLAY_LEAD_SEC} sek. før ${mmss(job.t)}.`);
      }
    }
  }
  return fail(`Replayet kører, men springet til ${mmss(target)} blev ikke bekræftet af spillet. Spol selv til ${mmss(target)}.`);
}

// Kører et replay lige nu? (Så live-løkken ikke tager replayet for en kamp.) Kun når der ikke allerede er en kamp.
async function replayRunning() {
  if (app.live) return false;
  if (app.replayWatching) return true;
  if (!app.client) return false;
  if (Date.now() - (app.replayCheckAt || 0) < 10000) return Boolean(app.replayCheckHit);
  app.replayCheckAt = Date.now();
  const c = await lcu(app.client, 'GET', '/lol-replays/v1/configuration').catch(() => null);
  app.replayCheckHit = Boolean(c?.isPlayingReplay);
  return app.replayCheckHit;
}

// ---------- Klip og replay ved coachens råd ----------
// OBS-klip gemmes med kamptiden fra live-API'et (deathLog), dødsfald i gennemgangen med timelinens tid. I Tobias'
// rigtige kampe lå de to højst 1 sek. fra hinanden. To af dine dødsfald ligger altid mindst 10 sek. fra hinanden
// (laveste dødstid, League Wiki: https://wiki.leagueoflegends.com/en-us/Death), så 5 sek. kan ikke ramme et andet dødsfald.
const CLIP_MATCH_SEC = 5;
function clipAt(g, t) {
  const d = gameClips(g).filter((x) => x.t != null && Math.abs(x.t - t) <= CLIP_MATCH_SEC)
    .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return d ? { file: d.file, name: path.basename(d.file) } : null;
}
const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Øjeblikkene i en kamp, som et råd handler om (med tid): dødsfaldene for dødsråd, de store monstre du ikke var ved osv.
function adviceMoments(a, g) {
  const r = g.review;
  if (!r || !(r.v >= 4)) return [];
  const killer = (d) => (d.killer ? dd.champions[d.killer]?.name || d.killer : null);
  const death = (d, what) => ({ t: d.t, what, killer: killer(d), clip: clipAt(g, d.t) });
  const deaths = Array.isArray(r.deaths) ? r.deaths : [];
  switch (a.key) {
    case 'objDeath': {
      const takes = epicTakes(r, EPIC_MONSTERS);
      return objDeaths(r).map((d) => {
        const o = takes.find((x) => !x.mine && x.t >= d.t && x.t <= d.t + d.dead);
        return death(d, `Død ${mmss(d.t)}${o ? ` - fjenden tog ${OBJECTIVE_NAMES[o.k] || o.k} ${mmss(o.t)}, mens du var død` : ''}`);
      });
    }
    case 'outnumbered': return deaths.filter((d) => d.n >= 2).map((d) => death(d, `Død ${mmss(d.t)} mod ${d.n}`));
    case 'sideAlone': return deaths.filter((d) => d.alone).map((d) => death(d, `Død ${mmss(d.t)} alene i ${d.zone === 'Top' ? 'top' : 'bot'}-lanen`));
    case 'dragon':
    case 'topside':
      return epicTakes(r, a.key === 'dragon' ? ['DRAGON'] : TOPSIDE).filter((o) => !o.near)
        .map((o) => ({ t: o.t, what: `${capFirst(OBJECTIVE_NAMES[o.k] || o.k)} ${mmss(o.t)} uden dig - ${o.mine ? 'dit hold' : 'fjenden'} tog den`, killer: null, clip: null }));
    case 'gank':
      return (r.ganks || []).filter((x) => x.died).map((x) => {
        const d = deaths.find((y) => y.t >= x.t && y.t <= x.t + GANK_FIGHT_SEC);
        return { t: x.t, what: `Gank i ${x.lane} ${mmss(x.t)} - du døde ${d ? mmss(d.t) : 'lige efter'}`, killer: d ? killer(d) : null, clip: d ? clipAt(g, d.t) : null };
      });
    default: return [];
  }
}
const momentView = (m, g) => ({ ...m, gameId: g.gameId || null, date: g.date, champion: g.champion });
// Kortet: klip af rådets øjeblikke på tværs af kampene (nyeste først), og ellers replay-knapper fra den nyeste kamp der kan ses.
function adviceMedia(a, games) {
  const clips = []; let replay = null;
  for (const g of games) {
    const ms = adviceMoments(a, g);
    for (const m of ms) if (m.clip && clips.length < 10) clips.push(momentView(m, g));
    const open = ms.filter((m) => !m.clip);
    if (!replay && open.length && g.gameId) {
      const rp = replayFor(g);
      if (rp.ok) replay = { ...rp, date: g.date, champion: g.champion, result: g.result || null, moments: open.slice(0, 3).map((m) => momentView(m, g)) };
    }
  }
  return { clips, replay };
}

// ---------- Din champion-pulje ----------
// Pr. rolle: win rate, kampe og form pr. champion (history.json - rollen kommer fra live-API'et), de champions du
// vinder mest med, hvor mange forskellige champions du har spillet i rollen, og mastery fra klienten. Klientens
// kamphistorik (history.recent) har ingen pålidelig rolle (se README), så den vises samlet for alle roller.
// Kilde (docs/research-low-elo.md, punkt 4, dobbelttjekket): iTero - win rate krydser 50 % ved ca. 12.000 mastery
// = ca. 20 kampe på en champion, og ligger omkring 44 % under 10.000. (Do et al. står også i researchen, men er ikke
// dobbelttjekket - derfor vises ingen tal derfra.)
const POOL_FEW = 20;     // under iTeros ca. 20 kampe står "få kampe"
const POOL_SPREAD = 20;  // spredning: forskellige champions i dine sidste 20 kampe i rollen
const POOL_FORM = 5;     // form: dine sidste 5 kampe på championen
const POOL_SOURCES = [
  { name: 'iTero (1M+ solo queue-kampe omkring Gold, patch 13.7): win rate krydser 50 % ved ca. 12.000 mastery-point = ca. 20 kampe på en champion; under 10.000 ligger den omkring 44 %', url: MASTERY_URL },
];
// Rangering: nederste grænse af et 95 %-interval for din win rate (Wilson) - så 1 af 1 ikke slår 9 af 15.
function wilsonLow(w, n, z = 1.96) {
  if (!n) return 0;
  const p = w / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}
function poolRoles() {
  const roles = new Map();
  for (const g of srGames()) {
    if (!knownResult(g) || !POSITIONS.includes(g.position) || !g.championId) continue;
    if (!roles.has(g.position)) roles.set(g.position, []);
    roles.get(g.position).push(g);
  }
  return [...roles].map(([role, gs]) => {
    const by = new Map();
    for (const g of gs) {
      const x = by.get(g.championId) || { id: g.championId, games: 0, wins: 0, form: [] };
      x.games++;
      if (g.result === 'Sejr') x.wins++;
      if (x.form.length < POOL_FORM) x.form.push(g.result === 'Sejr');
      by.set(g.championId, x);
    }
    const list = [...by.values()].map((x) => ({ ...x, low: wilsonLow(x.wins, x.games) })).sort((a, b) => b.low - a.low || b.games - a.games);
    const last = gs.slice(0, POOL_SPREAD);
    const n = new Map();
    for (const g of last) n.set(g.championId, (n.get(g.championId) || 0) + 1);
    const top2 = new Set([...n].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id));
    const inTop = last.filter((g) => top2.has(g.championId)); const rest = last.filter((g) => !top2.has(g.championId));
    return { role, games: gs.length, list, last: last.length, distinct: n.size, inTop: { games: inTop.length, wins: winsOf(inTop) }, rest: { games: rest.length, wins: winsOf(rest) } };
  }).sort((a, b) => b.games - a.games);
}
const masteryOf = (id) => app.mastery?.get(Number(id)) || null;
function championPoolView() {
  if (!app.cfg.championPool) return null;
  const roles = poolRoles();
  const recent = history.recent.filter((x) => x.champ);
  const byChamp = new Map();
  for (const x of recent) { const c = byChamp.get(x.champ) || { id: x.champ, games: 0, wins: 0 }; c.games++; if (x.win) c.wins++; byChamp.set(x.champ, c); }
  if (!roles.length && !recent.length) return null;
  return {
    few: POOL_FEW,
    roles: roles.map((r) => ({
      role: r.role, games: r.games, last: r.last, distinct: r.distinct,
      topVsRest: r.rest.games >= 3 && r.inTop.games >= 3
        ? `Dine 2 mest spillede ${r.role}-champions: ${r.inTop.wins} af ${r.inTop.games} sejre - alle andre: ${r.rest.wins} af ${r.rest.games}` : null,
      best: r.list.filter((x) => x.wins > 0).slice(0, 3).map((x) => x.id),
      champions: r.list.map((x) => ({ ...champView(x.id), games: x.games, wins: x.wins, form: x.form, few: x.games < POOL_FEW, mastery: masteryOf(x.id) })),
    })),
    client: recent.length ? { games: recent.length, distinct: byChamp.size,
      champions: [...byChamp.values()].sort((a, b) => b.games - a.games).slice(0, 8).map((c) => ({ ...champView(c.id), games: c.games, wins: c.wins })) } : null,
    masteryKnown: Boolean(app.mastery),
    sources: POOL_SOURCES,
    research: RESEARCH_URL,
  };
}
// Champion select: én linje for den champion du hover/har låst i din rolle.
function poolPick(championId, position) {
  if (!app.cfg.championPool || !(championId > 0)) return null;
  const name = dd.champions[championId]?.name || `Champion ${championId}`;
  const m = masteryOf(championId);
  const mastery = m?.points != null ? `${gnum(m.points)} mastery-point` : null;
  const roles = poolRoles();
  const elsewhere = srGames().filter((g) => g.championId === championId && knownResult(g) && g.position !== position).length;
  const clientGames = history.recent.filter((x) => x.champ === championId).length;
  const r = position ? roles.find((x) => x.role === position) : null;
  const me = r?.list.find((x) => x.id === championId);
  if (!position) return null;
  if (!me) {
    return { championId, isNew: true, text: `Ny champion for dig: 0 kampe i rollen ${position}`,
      extra: [mastery, elsewhere ? `${elsewhere} kampe i andre roller` : null, clientGames ? `${clientGames} i klientens kamphistorik (alle roller)` : null].filter(Boolean).join(' · ') || null };
  }
  const best = r.list.filter((x) => x.wins > 0)[0];
  const isBest = best && best.id === championId;
  const text = isBest ? `${name}: din bedste ${position}-champion (${me.wins} af ${me.games})`
    : `${name}: ${me.wins} af ${me.games} i ${position} - nr. ${r.list.indexOf(me) + 1} af dine ${r.list.length} ${position}-champions` +
      (best ? ` (bedste: ${dd.champions[best.id]?.name || best.id} ${best.wins} af ${best.games})` : '');
  return { championId, isBest: Boolean(isBest), few: me.games < POOL_FEW, text,
    extra: [me.games < POOL_FEW ? `få kampe (under ${POOL_FEW})` : null, mastery].filter(Boolean).join(' · ') || null };
}

// ---------- Opdateringer ----------

const VERSION = '1.22.1';
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
    // Riot ID til spejder-opslaget (gameName#tagLine).
    riot: { gameName: p.riotIdGameName || playerName(p).split('#')[0] || null, tagLine: p.riotIdTagLine || playerName(p).split('#')[1] || null },
    isBot: Boolean(p.isBot),
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
    // Nye funktioner fejler stille - de må aldrig stoppe live-løkken.
    for (const fn of [ensureScout, updateEnemyJungleLive]) {
      try { fn(app.live); } catch {}
    }
    if (app.cfg.obsClips) {
      obsConnect();
      if (obs.ready && !obs.prepared) obsPrepare().catch(() => {}); // forbindelsen fandtes allerede (fx fra "Find klip")
    }
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
    if (data?.allPlayers?.length && data.activePlayer && !(await replayRunning())) {
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
  enemyJungle: null,   // { key, side, guessed, routes } - fjendens junglers første clear
  ejKey: null,
  ejFailAt: 0,
  summonerRegion: null, // OP.GG-region fra klienten (til spejder-opslag)
  puuid: null,         // din puuid (til kampgennemgangen)
  rank: null,          // { tier, division } i solo/duo fra klienten (klatre-tjekkets referencetal)
  pickMastery: null,   // { championId, points } for den champion du har låst
  recentAt: 0,         // sidst klientens kamphistorik blev hentet (tilt-tallene)
  recentBusy: false,
  phase: null,         // klientens gameflow-fase (sidst set)
  hover: null,         // { championId, position } - champion du hover/har låst i champion select
  mastery: null,       // Map championId -> { points, level } fra klienten (champion-puljen)
  replayEnv: null,     // { at, conf, dir } - klientens replay-indstillinger
  replayCfg: null,     // læst fra game.cfg: er Replay API'et slået til
  replayJob: null,     // igangværende/seneste "Se det i replayet"
  replayWatching: false, // et replay kører (så live-løkken ikke tager det for en kamp)
  replayCurrent: null, // gameId på replayet programmet startede
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
    scout: safeView(scoutView) || [],
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
    bansFor: d.bansFor ? champView(d.bansFor) : null,
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

// En fejl i en af de nye visninger må ikke tage resten af vinduet med sig.
function safeView(fn) {
  try { return fn(); } catch (e) { console.error(`Visning fejlede: ${e.message}`); return null; }
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
    enemyJungle: safeView(enemyJungleView),
    reviews: app.live ? null : safeView(reviewView),
    patterns: app.live ? null : safeView(patternsView),
    climb: app.live ? null : safeView(climbView),
    // Coachen: kun før og efter kampen (under kampen kun fakta og valg).
    coach: app.live ? null : safeView(coachView),
    // Tilt-vagten også i champion select før du låser (draften).
    climbGuard: app.live || !app.cfg.climbCheck ? null : safeView(() => tiltGuard()),
    obsClips: Boolean(app.cfg.obsClips),
    obs: app.cfg.obsClips ? { status: obs.status, ready: obs.ready } : null,
    // "Se det i replayet": kun før/efter kampen.
    replay: app.live ? null : safeView(replayView),
    pool: app.live ? null : safeView(championPoolView),
    // Champion select: én linje om den champion du hover/har låst (din egen pulje i rollen).
    poolPick: app.live || !app.hover ? null : safeView(() => poolPick(app.hover.championId, app.hover.position)),
  };
  if (!pick || !b || !rec) return base;
  if (app.cfg.patterns) {
    const p = safeView(() => patternsFor(pick.championId, b.position));
    if (p) base.patternsPick = { games: p.games, minGames: PATTERN_MIN_GAMES, lines: p.lines.slice(0, 2).map((l) => l.text) };
  }
  if (app.cfg.coach && !app.live) {
    const c = safeView(() => coachPick(b.position, pick.championId));
    if (c) base.coachPick = c;
  }
  if (app.cfg.climbCheck) {
    const f = safeView(() => climbFocus(b.position));
    const pm = app.pickMastery?.championId === pick.championId ? app.pickMastery.points : null;
    const champName = dd.champions[pick.championId]?.name || '';
    const mastery = typeof pm === 'number' && pm < MASTERY_CROSS
      ? { text: `${gnum(pm)} mastery-point på ${champName}. I iTeros data (1M+ solo queue-kampe omkring Gold) krydser win rate 50 % ved ca. ${gnum(MASTERY_CROSS)} point (ca. 20 kampe); under 10.000 ligger den omkring 44 %.`, url: MASTERY_URL } : null;
    if (f || mastery) base.climbPick = { focus: f?.focus || null, guard: f?.guard || null, mastery };
  }
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
    // no-store: efter en opdatering skal vinduet altid hente den nye side (se pageVersion i gui.html).
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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
  if (req.method === 'POST' && req.url === '/api/obs') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    const { enabled } = await readBody(req);
    app.cfg.obsClips = Boolean(enabled);
    saveConfigValue('obsClips', app.cfg.obsClips);
    if (app.cfg.obsClips) {
      log('OBS-klip slået til - forbinder til OBS når en kamp kører.');
      obs.nextTry = 0;
      if (app.live) obsConnect();
    } else {
      obsClose();
      obs.status = null;
      log('OBS-klip slået fra.');
    }
    broadcast();
    return json(200, { ok: true, enabled: app.cfg.obsClips });
  }
  // "Se det i replayet": kun fra computeren selv, kun dine egne kampe (fra history.json).
  if (req.method === 'POST' && req.url === '/api/replay') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    const { gameId, t } = await readBody(req);
    if (!(Number(gameId) > 0) || !(Number(t) >= 0)) return json(400, { error: 'Mangler kamp og tid' });
    const r = await startReplay(Number(gameId), Number(t));
    return json(r.ok ? 200 : 409, r);
  }
  // Slå replay-spring til/fra: ændrer KUN EnableReplayApi i League's game.cfg (med backup) - på dit klik.
  if (req.method === 'POST' && req.url === '/api/replay-jump') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    const { enabled } = await readBody(req);
    const r = await setReplayJump(Boolean(enabled));
    broadcast();
    return json(r.ok ? 200 : 409, r);
  }
  if (req.method === 'POST' && req.url === '/api/review-old') {
    if (!app.cfg.matchReview) return json(400, { error: 'Kampgennemgang er slået fra (matchReview)' });
    const r = await reviewOlderGames();
    broadcast();
    return json(r.ok ? 200 : 409, r);
  }
  // "Find klip til mine kampe": kobl OBS-klip i optagemappen til kampene (kun fra computeren selv).
  if (req.method === 'POST' && req.url === '/api/find-clips') {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    const r = await findClipsForGames();
    broadcast();
    return json(200, r);
  }
  // Video af dine dødsfald: kun fra computeren selv og kun filer programmet selv har gemt (se allowedClip).
  if ((req.method === 'GET' && req.url.startsWith('/clip?')) || (req.method === 'POST' && req.url === '/api/open-clip')) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return json(403, { error: 'Kun fra computeren selv' });
    const wanted = req.method === 'GET' ? new URL(req.url, 'http://x').searchParams.get('f') : (await readBody(req)).file;
    const file = allowedClip(wanted);
    if (!file) return json(403, { error: 'Ikke et klip fra programmet' });
    if (req.method === 'GET') return serveClip(req, res, file);
    if (!fs.existsSync(file)) return json(404, { error: 'Filen findes ikke længere' });
    openFile(file);
    return json(200, { ok: true });
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
    if (app.pickMastery?.championId !== pick.championId) fetchPickMastery(pick.championId).catch(() => {});
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
  'completed', 'isInProgress', 'isEditable', 'isActive', 'isValid', 'team', 'teamId', 'participantId', 'type', 'frameInterval']);
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
  if (app.phase !== phase) { app.phase = phase; broadcast(); }
  if (phase !== 'ChampSelect') {
    if (app.hover) { app.hover = null; broadcast(); }
    // Replay-knappen: klientens replay-indstillinger (kun GET, kun når klienten er ledig).
    if (!REPLAY_BUSY[phase] && !app.live) refreshReplayEnv().catch(() => {});
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
    if ((app.pick || app.enemyJungle) && ['None', 'Lobby', 'Matchmaking', 'ReadyCheck'].includes(phase)) { clearPick(); broadcast(); }
    if (['None', 'Lobby', 'EndOfGame'].includes(phase)) { upgradeOldReviews(phase); refreshRecentGames().catch(() => {}); }
    return cfg.pollMs;
  }
  const session = await lcu(app.client, 'GET', '/lol-champ-select/v1/session');
  const me = session.myTeam?.find((m) => m.cellId === session.localPlayerCellId);
  app.replayWatching = false; // i champion select kører der ikke et replay
  // Champion-puljen: den champion du hover (eller har låst) i din rolle.
  const hv = me?.championId > 0 ? me.championId : me?.championPickIntent;
  const hvPos = app.roleOverride || POSITION_MAP[me?.assignedPosition] || null;
  if ((app.hover?.championId || 0) !== (hv > 0 ? hv : 0) || (hv > 0 && app.hover?.position !== hvPos)) {
    app.hover = hv > 0 ? { championId: hv, position: hvPos } : null;
    broadcast();
  }
  const pickPending = (session.actions || []).flat()
    .some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && !a.completed);
  try { updateEnemyJungleSelect(session, me); } catch {}
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
  // OBS-klip der ikke står ved en kamp (fx efter en genstart midt i kampen) kobles til kampene - kun filer, intet netværk.
  try { recoverClips(); broadcast(); } catch (e) { log(`Klip: kunne ikke gennemgå optagemappen (${e.message}).`); }
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
        app.summonerRegion = null;
        app.puuid = null;
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
