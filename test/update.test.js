'use strict';
// Tester selv-opdatering af den færdige programfil mod en falsk udgivelse (GitHub releases-format).
// Kør: HELPER_BIN="dist/LoL-Rune-Helper-Mac/LoL Rune Helper" node test/update.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

if (!process.env.HELPER_BIN) {
  console.log('Springer over: kræver HELPER_BIN (opdatering virker kun i den færdige programfil).');
  process.exit(0);
}
const ASSET = { win32: 'LoL-Rune-Helper.exe', darwin: 'LoL-Rune-Helper-mac' }[process.platform];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-helper-update-'));
  const exe = path.join(tmp, 'app', path.basename(process.env.HELPER_BIN));
  fs.mkdirSync(path.dirname(exe));
  fs.copyFileSync(process.env.HELPER_BIN, exe);
  fs.chmodSync(exe, 0o755);
  const binary = fs.readFileSync(process.env.HELPER_BIN);

  let downloads = 0;
  let tag = 'v0.0.1'; // ingen ny version når programmet starter
  const rel = http.createServer((req, res) => {
    if (req.url === '/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: tag, body: 'Testudgivelse', assets: [{ name: ASSET, browser_download_url: `http://127.0.0.1:${rel.address().port}/asset` }] }));
    }
    if (req.url === '/asset') { downloads++; res.writeHead(200); return res.end(binary); }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => rel.on('listening', r));

  const port = await freePort();
  const env = {
    ...process.env, HOME: tmp, LOL_HELPER_PORT: String(port), LOL_HELPER_NO_WINDOW: '1',
    LOL_HELPER_CACHE: path.join(tmp, 'cache'), LOL_HELPER_HISTORY: path.join(tmp, 'h.json'),
    LOL_HELPER_LIVE: 'http:9', LOL_HELPER_UPDATE_URL: `http://127.0.0.1:${rel.address().port}/latest`,
  };
  const child = spawn(exe, [], { env, cwd: path.dirname(exe) });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const state = () => fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json()).catch(() => null);
  let newPid = null;
  try {
    let s;
    for (let i = 0; i < 60 && !(s = await state())?.updateCheck?.at; i++) await wait(500);
    assert(s?.updateCheck?.at && !s.update, 'første tjek: ingen ny version');
    assert.strictEqual(s.updateCheck.ok, true);
    // Ny version udgives mens programmet kører; du starter programmet igen (anden kopi) ->
    // den kørende kopi skal selv tjekke og finde den
    tag = 'v9.9.9';
    const second = spawn(exe, ['--autostart'], { env, cwd: path.dirname(exe) });
    await new Promise((r) => second.on('exit', r));
    for (let i = 0; i < 30 && !(s = await state())?.update; i++) await wait(500);
    assert.strictEqual(s?.update?.version, '9.9.9', 'ny start får den kørende kopi til at finde den nye version');
    // Knappen "Tjek for opdatering" virker også
    const manual = await fetch(`http://127.0.0.1:${port}/api/check-update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
    assert.deepStrictEqual(manual, { ok: true, update: '9.9.9' });
    assert.strictEqual(s.update.canApply, true);
    assert(out.includes('Ny version 9.9.9'), out);
    const oldPid = s.pid;
    const mtime = fs.statSync(exe).mtimeMs;
    await wait(50);
    await fetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const exited = await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 20000); child.on('exit', () => { clearTimeout(t); resolve(true); }); });
    assert(exited, 'gammel version lukker');
    for (let i = 0; i < 60; i++) { s = await state(); if (s && s.pid !== oldPid) break; await wait(500); }
    assert(s && s.pid !== oldPid, 'ny proces svarer på samme port');
    newPid = s.pid;
    assert.strictEqual(downloads, 1, 'filen blev hentet');
    assert(fs.statSync(exe).mtimeMs > mtime, 'programfilen er udskiftet');
    assert(!fs.existsSync(`${exe}.new`), 'ingen .new-rest');
    console.log('OPDATERINGSTEST BESTÅET');
  } catch (e) {
    console.log(out);
    console.error('FEJL:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    if (newPid) try { process.kill(newPid); } catch {}
    rel.close();
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
