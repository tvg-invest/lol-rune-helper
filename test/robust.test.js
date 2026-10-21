'use strict';
// Robusthed: tester små rene funktioner fra lol-helper.js uden netværk (forrige patch, skalering,
// OP.GG-køen, spiltyper). Funktionerne klippes ud af kildeteksten og køres i en sandkasse.
// Kør: node test/robust.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'lol-helper.js'), 'utf8');
// Klip en funktion/konstant ud: fra "start" til den matchende afsluttende krølleparentes.
function extract(start) {
  const i = src.indexOf(start);
  assert(i !== -1, `findes ikke: ${start}`);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`ingen slutning: ${start}`);
}

const ctx = vm.createContext({ dd: { versions: [] } });
vm.runInContext([
  "const genitive = (name) => (/[sxz]$/i.test(name) ? `${name}'` : `${name}s`);",
  extract('function previousPatch('),
  extract('function scalingNote('),
  "const SR_MODES = ['CLASSIC', 'SWIFTPLAY', 'PRACTICETOOL', 'TUTORIAL'];",
  extract('function buildMode('),
  'let activeRequests = 0;',
  'const requestQueue = [];',
  extract('async function limited('),
  'this.api = { previousPatch, scalingNote, buildMode, limited, active: () => activeRequests };',
].join('\n'), ctx);
const { previousPatch, scalingNote, buildMode, limited } = ctx.api;

(async () => {
  // Forrige patch: kun når OP.GG's patch er den nyeste i Data Dragon, og så den ÆLDRE patch
  ctx.dd.versions = ['16.21.1', '16.20.1', '16.19.1', 'lolpatch_7.20'];
  assert.strictEqual(previousPatch('16.21'), '16.20', 'nyeste -> forrige');
  assert.strictEqual(previousPatch('16.20'), null, 'OP.GG halter efter Data Dragon -> ingen fallback (aldrig en nyere patch)');
  assert.strictEqual(previousPatch(''), null);
  ctx.dd.versions = ['16.21.1'];
  assert.strictEqual(previousPatch('16.21'), null, 'ingen forrige kendt');

  // Skalering: rate: null fra OP.GG giver ingen påstand
  const gl = (a, b) => ({ game_lengths: [{ rate: a }, { rate: 0.5 }, { rate: b }] });
  assert.strictEqual(scalingNote(gl(null, null), gl(0.45, 0.55), 'Zed'), null, 'null-rater -> ingen note');
  assert.strictEqual(scalingNote(gl(0.5, 0.5), { game_lengths: [] }, 'Zed'), null);
  assert(/^Du skalerer bedre end Zed/.test(scalingNote(gl(0.45, 0.6), gl(0.5, 0.5), 'Zed')));
  const his = scalingNote(gl(0.5, 0.5), gl(0.45, 0.6), 'Zed');
  assert(/^Zed skalerer bedre end dig \(Zeds win rate/.test(his), his);
  assert(!/bedste chance/.test(his), 'fakta, ikke en anbefaling');
  assert(/^I skalerer nogenlunde ens/.test(scalingNote(gl(0.5, 0.5), gl(0.5, 0.51), 'Zed')));

  // Spiltyper
  assert.strictEqual(buildMode('CLASSIC'), 'ranked');
  assert.strictEqual(buildMode('SWIFTPLAY', 11), 'ranked');
  assert.strictEqual(buildMode('ARAM', 12), 'aram');
  assert.strictEqual(buildMode('KIWI', 12), 'aram', 'ARAM-variant genkendes på map 12');
  assert.strictEqual(buildMode('URF', 11), 'urf');
  assert.strictEqual(buildMode('ONEFORALL', 11), 'ranked', "ukendt spiltype på Summoner's Rift");
  assert.strictEqual(buildMode('CHERRY', 30), null, 'Arena springes over');
  assert.strictEqual(buildMode('NEXUSBLITZ', 21), null);

  // OP.GG-køen: aldrig mere end 4 samtidige kald, heller ikke når nye kald kommer i samme øjeblik som en plads frigives
  let now = 0;
  let max = 0;
  const job = (ms) => limited(async () => {
    now++;
    max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, ms));
    now--;
  });
  const jobs = [];
  for (let i = 0; i < 12; i++) jobs.push(job(5 + (i % 3)));
  // Nye kald i samme mikro-opgave som de første afsluttes
  jobs.push(new Promise((r) => setTimeout(r, 6)).then(() => Promise.all([job(1), job(1), job(1)])));
  await Promise.all(jobs);
  assert(max <= 4, `højst 4 samtidige: ${max}`);
  assert.strictEqual(ctx.api.active(), 0, 'alle pladser frigivet');
  // En fejl frigiver også pladsen
  await limited(async () => { throw new Error('x'); }).catch(() => {});
  assert.strictEqual(ctx.api.active(), 0, 'plads frigivet efter fejl');

  console.log('ROBUSTHED: ALLE TESTS BESTÅET');
})().catch((e) => {
  console.error('FEJL:', e.message);
  process.exitCode = 1;
});
