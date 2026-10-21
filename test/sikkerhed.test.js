'use strict';
// Tester config.json-robusthed, telefon-adgang kun via Tailscale og "kun én kopi" (også ved samtidig start).
// Kør: node test/sikkerhed.test.js   (kræver internet til Data Dragon)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const [cmd, baseArgs] = process.env.HELPER_BIN
  ? [path.resolve(process.env.HELPER_BIN), []]
  : [process.execPath, [path.join(__dirname, '..', 'lol-helper.js')]];
const isTailscale = (ip) => { const [x, y] = ip.split('.').map(Number); return x === 100 && y >= 64 && y <= 127; };
const rawGet = (host, port, p, headers = {}) => new Promise((resolve) => {
  const r = http.request({ host, port, path: p, headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', (e) => resolve({ status: e.code, body: '' }));
  r.end();
});
const getState = (port) => fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json()).catch(() => null);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-helper-sikkerhed-'));
  const configFile = path.join(tmp, 'config.json');
  const port = await freePort();
  const lockFile = path.join(os.tmpdir(), `lol-rune-helper-${port}.lock`);
  const env = {
    ...process.env, HOME: tmp, LOL_HELPER_PORT: String(port), LOL_HELPER_NO_WINDOW: '1', LOL_HELPER_REMOTE: '1',
    LOL_HELPER_CONFIG: configFile, LOL_HELPER_CACHE: path.join(tmp, 'cache'), LOL_HELPER_HISTORY: path.join(tmp, 'h.json'),
    LOL_HELPER_LIVE: 'http:9', LOL_HELPER_UPDATE_URL: 'http://127.0.0.1:9/ingen', LOL_HELPER_LCU: 'http:9:x',
  };
  // Ødelagt config.json (afsluttende komma - en typisk tastefejl).
  const broken = '{\n  "region": "EUW",\n  "voice": true,\n}\n';
  fs.writeFileSync(configFile, broken);
  const procs = [];
  const start = (extra = []) => {
    const p = spawn(cmd, [...baseArgs, ...extra], { env });
    p.out = '';
    p.stdout.on('data', (d) => (p.out += d));
    p.stderr.on('data', (d) => (p.out += d));
    p.exited = new Promise((r) => p.on('exit', (c) => { p.code = c; r(c); }));
    procs.push(p);
    return p;
  };
  try {
    // 1) To kopier startet samtidig (dobbeltklik): kun én må blive kørende
    const a = start();
    await wait(150);
    const b = start(['--autostart']);
    const first = await Promise.race([a.exited.then(() => a), b.exited.then(() => b), wait(60000).then(() => null)]);
    assert(first, `en af de to kopier skal lukke af sig selv:\n${a.out}\n---\n${b.out}`);
    assert.strictEqual(first.code, 0, first.out);
    assert(first.out.includes('kører allerede'), first.out);
    const main = first === a ? b : a;
    let s = null;
    for (let i = 0; i < 60 && !(s = await getState(port)); i++) await wait(500);
    assert(s && s.pid === main.pid, 'den anden kopi kører og svarer');
    assert.strictEqual(main.code, undefined, 'hovedkopien kører stadig');

    // 2) Ødelagt config.json: stemme-knappen må ikke overskrive filen
    assert(main.out.includes('Kunne ikke læse config.json'), main.out);
    const r = await fetch(`http://127.0.0.1:${port}/api/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' }).then((x) => x.json());
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(fs.readFileSync(configFile, 'utf8'), broken, 'config.json er urørt');
    await wait(300);
    assert(main.out.includes('Indstillingen blev ikke gemt'), main.out);

    // 3) Telefon-adgang uden remoteLan: kun Tailscale. Wifi-adressen afvises, selv med rigtig Host.
    const lan = Object.values(os.networkInterfaces()).flat().find((x) => x.family === 'IPv4' && !x.internal && !isTailscale(x.address));
    if (lan) {
      assert(!main.out.includes(`http://${lan.address}:${port}/?token=`), 'intet wifi-link i loggen');
      const res = await rawGet(lan.address, port, '/state', { Host: `127.0.0.1:${port}` });
      assert.strictEqual(res.status, 403, `wifi afvises: ${res.status}`);
      assert(res.body.includes('Tailscale'), res.body);
    } else {
      console.log('(Ingen wifi-adresse - springer wifi-afvisning over)');
    }
    // Computerens navn er en tilladt Host (fx http://min-pc:3399), en fremmed er det ikke.
    assert.strictEqual((await rawGet('127.0.0.1', port, '/state', { Host: `${os.hostname().toUpperCase()}:${port}` })).status, 200, 'eget maskinnavn tilladt');
    assert.strictEqual((await rawGet('127.0.0.1', port, '/state', { Host: `ondsindet.example:${port}` })).status, 403, 'fremmed navn afvises');

    // 4) Opdatering fra kildekode afvises, og fejlen kan ses i vinduet (ikke kun i loggen)
    if (!process.env.HELPER_BIN) {
      const up = await fetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.strictEqual(up.status, 200);
      await wait(300);
      s = await getState(port);
      assert.strictEqual(s.updateCheck.ok, false);
      assert(/Opdatering mislykkedes: Kører fra kildekode/.test(s.updateCheck.error), s.updateCheck.error);
    }

    // 5) Låsefil med pid + port; en efterladt lås fra et dødt pid blokerer ikke næste start
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.deepStrictEqual(lock, { pid: main.pid, port }, 'låsefil med pid og port');
    main.kill('SIGKILL');
    await main.exited;
    await wait(300);
    assert(fs.existsSync(lockFile), 'låsen blev efterladt (hårdt dræbt)');
    const c = start();
    for (let i = 0; i < 60 && !(s = await getState(port)); i++) await wait(500);
    assert(s && s.pid === c.pid, `ny kopi starter trods efterladt låsefil:\n${c.out}`);
    console.log('SIKKERHEDSTEST BESTÅET');
  } catch (e) {
    for (const p of procs) console.log(p.out);
    console.error('FEJL:', e.message);
    process.exitCode = 1;
  } finally {
    for (const p of procs) try { p.kill(); } catch {}
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(lockFile, { force: true });
  }
})();
