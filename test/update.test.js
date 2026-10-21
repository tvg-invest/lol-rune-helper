'use strict';
// Tester selv-opdatering af den færdige programfil mod en falsk udgivelse (GitHub releases-format).
// Kør: HELPER_BIN="dist/LoL-Rune-Helper-Mac/LoL Rune Helper" node test/update.test.js
// Dækker: fejl ved download (404), forkert sha256, dobbeltklik, en ny version der crasher eller
// aldrig svarer (tilbagerulning) og til sidst den vellykkede opdatering.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

if (!process.env.HELPER_BIN) {
  console.log('Springer over: kræver HELPER_BIN (opdatering virker kun i den færdige programfil).');
  process.exit(0);
}
const ASSET = { win32: 'LoL-Rune-Helper.exe', darwin: 'LoL-Rune-Helper-mac' }[process.platform];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// Et "program" over 10 MB, der er et shell-script (kun macOS/Linux): crasher eller hænger ved start.
const fakeExe = (script) => Buffer.concat([Buffer.from(`#!/bin/sh\n${script}\n`), Buffer.alloc(11 * 1024 * 1024, '#')]);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-helper-update-'));
  const exe = path.join(tmp, 'app', path.basename(process.env.HELPER_BIN));
  fs.mkdirSync(path.dirname(exe));
  fs.copyFileSync(process.env.HELPER_BIN, exe);
  fs.chmodSync(exe, 0o755);
  const binary = fs.readFileSync(process.env.HELPER_BIN);
  const originalHash = sha(binary);

  let downloads = 0;
  let tag = 'v0.0.1'; // ingen ny version når programmet starter
  // Hvad udgivelsen serverer lige nu: filen, den digest GitHub oplyser, HTTP-status og forsinkelse.
  let asset = { buf: binary, digest: `sha256:${originalHash}`, status: 200, delay: 0 };
  const rel = http.createServer(async (req, res) => {
    if (req.url === '/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: tag, body: 'Testudgivelse', assets: [{
        name: ASSET, size: asset.buf.length, digest: asset.digest, browser_download_url: `http://127.0.0.1:${rel.address().port}/asset`,
      }] }));
    }
    if (req.url === '/asset') {
      downloads++;
      if (asset.delay) await wait(asset.delay);
      res.writeHead(asset.status);
      return res.end(asset.status === 200 ? asset.buf : 'Not Found');
    }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => rel.on('listening', r));

  const port = await freePort();
  const env = {
    ...process.env, HOME: tmp, LOL_HELPER_PORT: String(port), LOL_HELPER_NO_WINDOW: '1',
    LOL_HELPER_CACHE: path.join(tmp, 'cache'), LOL_HELPER_HISTORY: path.join(tmp, 'h.json'),
    LOL_HELPER_LIVE: 'http:9', LOL_HELPER_UPDATE_URL: `http://127.0.0.1:${rel.address().port}/latest`,
    LOL_HELPER_UPDATE_WAIT_MS: '25000', // hvor længe den gamle venter på den nye (normalt 90 sek.)
  };
  const child = spawn(exe, [], { env, cwd: path.dirname(exe) });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const state = () => fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json()).catch(() => null);
  const post = (p) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const refresh = async () => { await post('/api/check-update'); return state(); };
  // Vent til opdateringen er afsluttet (fejl gemt) og den gamle version svarer igen.
  const failed = async (maxMs) => {
    let s;
    for (let t = 0; t < maxMs; t += 500) {
      s = await state();
      if (s && s.update?.error && !s.update.inProgress) return s;
      await wait(500);
    }
    return s;
  };
  const unchanged = (msg) => {
    assert.strictEqual(sha(fs.readFileSync(exe)), originalHash, `${msg}: programfilen er den gamle`);
    assert(!fs.existsSync(`${exe}.new`), `${msg}: ingen .new-rest`);
    assert(!fs.existsSync(`${exe}.old`), `${msg}: ingen .old-rest`);
  };
  let newPid = null;
  try {
    let s;
    for (let i = 0; i < 60 && !(s = await state())?.updateCheck?.at; i++) await wait(500);
    assert(s?.updateCheck?.at && !s.update, 'første tjek: ingen ny version');
    assert.strictEqual(s.updateCheck.ok, true);
    const oldPid = s.pid;
    // Ny version udgives mens programmet kører; du starter programmet igen (anden kopi) ->
    // den kørende kopi skal selv tjekke og finde den
    tag = 'v9.9.9';
    const second = spawn(exe, ['--autostart'], { env, cwd: path.dirname(exe) });
    await new Promise((r) => second.on('exit', r));
    for (let i = 0; i < 30 && !(s = await state())?.update; i++) await wait(500);
    assert.strictEqual(s?.update?.version, '9.9.9', 'ny start får den kørende kopi til at finde den nye version');
    // Knappen "Tjek for opdatering" virker også
    const manual = await post('/api/check-update').then((r) => r.json());
    assert.deepStrictEqual(manual, { ok: true, update: '9.9.9' });
    assert.strictEqual(s.update.canApply, true);
    assert(out.includes('Ny version 9.9.9'), out);

    // A) Download fejler (404): fejlen kan ses i vinduet, intet er ændret
    asset = { ...asset, status: 404 };
    await post('/api/update');
    s = await failed(10000);
    assert(/404/.test(s?.update?.error), `404 vises: ${s?.update?.error}`);
    assert(/Opdatering mislykkedes/.test(s.updateCheck.error) && s.updateCheck.ok === false, 'fejl i opdateringslinjen');
    assert.strictEqual(s.pid, oldPid, 'samme proces kører videre');
    unchanged('404');

    // B) Filen passer ikke med GitHubs sha256-digest: afbryd før noget skrives
    asset = { buf: binary, digest: `sha256:${'0'.repeat(64)}`, status: 200, delay: 0 };
    s = await refresh();
    await post('/api/update');
    s = await failed(20000);
    assert(/kontrolsum/.test(s?.update?.error), `forkert digest afvises: ${s?.update?.error}`);
    assert.strictEqual(s.pid, oldPid);
    unchanged('digest');

    if (process.platform !== 'win32') {
      // C) Ny version crasher ved start + dobbeltklik under download -> kun én opdatering, rul tilbage
      const crash = fakeExe('exit 3');
      asset = { buf: crash, digest: `sha256:${sha(crash)}`, status: 200, delay: 1500 };
      s = await refresh();
      const before = downloads;
      const first = await post('/api/update');
      assert.strictEqual(first.status, 200);
      await wait(300);
      assert.strictEqual((await state()).update.inProgress, true, 'vinduet ved at opdateringen kører');
      const dbl = await post('/api/update');
      assert.strictEqual(dbl.status, 409, 'dobbeltklik afvises');
      s = await failed(30000);
      assert(/startede ikke korrekt/.test(s?.update?.error), `tilbagerulning: ${s?.update?.error}\n${out}`);
      assert.strictEqual(s.pid, oldPid, 'den gamle version kører videre og svarer igen');
      assert.strictEqual(downloads - before, 1, 'kun hentet én gang trods dobbeltklik');
      unchanged('crash');

      // D) Ny version starter men svarer aldrig -> stoppes efter ventetiden, rul tilbage
      const hang = fakeExe('exec sleep 300');
      asset = { buf: hang, digest: `sha256:${sha(hang)}`, status: 200, delay: 0 };
      s = await refresh();
      await post('/api/update');
      s = await failed(60000);
      assert(/startede ikke korrekt/.test(s?.update?.error), `hænger: ${s?.update?.error}`);
      assert.strictEqual(s.pid, oldPid);
      unchanged('hang');
    }

    // E) Vellykket opdatering
    asset = { buf: binary, digest: `sha256:${originalHash}`, status: 200, delay: 0 };
    s = await refresh();
    assert.strictEqual(s.update.error, null, 'nyt tjek rydder den gamle fejl');
    const mtime = fs.statSync(exe).mtimeMs;
    const before = downloads;
    await wait(50);
    await post('/api/update');
    const exited = await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 40000); child.on('exit', () => { clearTimeout(t); resolve(true); }); });
    assert(exited, `gammel version lukker\n${out}`);
    for (let i = 0; i < 60; i++) { s = await state(); if (s && s.pid !== oldPid) break; await wait(500); }
    assert(s && s.pid !== oldPid, 'ny proces svarer på samme port');
    newPid = s.pid;
    assert.strictEqual(downloads - before, 1, 'filen blev hentet');
    assert(fs.statSync(exe).mtimeMs > mtime, 'programfilen er udskiftet');
    assert(!fs.existsSync(`${exe}.new`), 'ingen .new-rest');
    for (let i = 0; i < 20 && fs.existsSync(`${exe}.old`); i++) await wait(500);
    assert(!fs.existsSync(`${exe}.old`), 'den nye version rydder .old op');
    assert(fs.readFileSync(path.join(path.dirname(exe), 'lol-helper.log'), 'utf8').includes('LoL Rune Helper'), 'den nye versions log gemmes i lol-helper.log');
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
