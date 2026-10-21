'use strict';
// Enhedstest af item-logikken (review 2026-10-21, pakken "items") mod de rigtige Data Dragon-data.
// Kør: node test/items.test.js  (kræver internet til Data Dragon)
// Indlæser lol-helper.js uden at starte programmet (main() kaldes ikke) og kalder funktionerne direkte.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createRequire } = require('module');

const file = path.join(__dirname, '..', 'lol-helper.js');
const src = fs.readFileSync(file, 'utf8');
const cut = src.lastIndexOf('\nmain().catch(');
assert(cut > 0, 'fandt ikke main()-kaldet');
const ctx = vm.createContext({
  require: createRequire(file), process, console, Buffer, URL, fetch, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file), __filename: file,
});
vm.runInContext(src.slice(0, cut), ctx, { filename: file });
const H = vm.runInContext(`({ dd, app, loadStaticData, isCompleted, isBoots, coreOf, nextInBuild, liveAdvice, inventoryInfo,
  starterAdvice, affordablePart, sellableIds, livePlayer, counterItems, recommend, planNow, remainingCost })`, ctx);

const noEnemy = { healers: [], fed: [], armorStackers: [], mrStackers: [], adShare: 0.5, apShare: 0.5, armorHeavy: false, mrHeavy: false };
const meWith = (ids, dmg = { ad: 0.2, ap: 0.8 }) => ({ itemIds: ids.map(String), slotsUsed: ids.length, dmg, level: 11, itemGold: 0, kills: 0, deaths: 0, assists: 0 });
// Evelynn-agtigt build: de fleste core-kombinationer starter med Dark Seal og har 4 items.
const eve = {
  core_items: [
    { ids: [1082, 3100, 3041, 3089], play: 1527, win: 800, pick_rate: 0.19 },
    { ids: [3100, 3089, 4645], play: 1000, win: 520, pick_rate: 0.12 },
    { ids: [1082, 3100, 3041, 4645], play: 600, win: 300, pick_rate: 0.08 },
    { ids: [3100, 3041, 3089, 3135], play: 300, win: 160, pick_rate: 0.04 },
  ],
  last_items: [],
  boots: [{ ids: [3020], play: 3000, win: 1500, pick_rate: 0.8 }],
};

(async () => {
  await H.loadStaticData();
  const it = (id) => H.dd.items[id];
  const ids = (list) => list.map((a) => a.id);

  // 1) Gunmetal Greaves (tier 3 af Berserker's) er støvler og færdige
  if (it('3172')) {
    assert(H.isBoots(it('3172')) && H.isCompleted(it('3172')), 'Gunmetal Greaves = færdige støvler');
    const build = { core_items: [], last_items: [], boots: [{ ids: [3006], play: 1000, win: 500, pick_rate: 0.8 }] };
    const me = meWith(['3172'], { ad: 0.9, ap: 0.1 });
    assert(!ids(H.liveAdvice(build, me, noEnemy, 3000, 11)).includes('3006'), "Berserker's foreslås ikke igen");
    assert.strictEqual(H.inventoryInfo(me, 3000, 11, 1200, build).bootsTip, null, 'ingen støvle-påmindelse med Gunmetal');
  }

  // 2) Anti-heal: Data Dragon skriver nu "Wounds" (Thornmail, Chempunk, Bramble Vest)
  for (const id of ['3075', '6609', '3033', '3165']) if (it(id)) assert(it(id).antiheal, `${it(id).name} er anti-heal`);

  // 3) En anti-heal-komponent (Executioner's Calling) skjuler ikke Mortal Reminder
  {
    const build = { core_items: [], last_items: [{ ids: [3033], play: 500, win: 250, pick_rate: 0.1 }], boots: [] };
    const enemy = { ...noEnemy, healers: [{ champ: { name: 'Soraka' } }] };
    const adv = H.liveAdvice(build, meWith(['3123'], { ad: 0.9, ap: 0.1 }), enemy, 1000, 11);
    assert(ids(adv).includes('3033'), `Mortal Reminder foreslås med Executioner's: ${JSON.stringify(ids(adv))}`);
    assert(adv.find((a) => a.id === '3033').inProgress, "Executioner's tæller som 'i gang'");
  }

  // 4) Healing: kun færdige items (Doran's Blade gør ikke Jhin til healer)
  const jhin = (items) => H.livePlayer({ championName: 'Jhin', rawChampionName: 'game_character_displayname_Jhin', items: items.map((itemID, slot) => ({ itemID, slot })) });
  assert.strictEqual(jhin([1055]).healing, false, "Doran's Blade er ikke healing");
  assert.strictEqual(jhin([3072]).healing, true, 'Bloodthirster er healing');

  // 5) Dark Seal: core uden komponenter, næste item i 4-item-kombinationer, Dark Seal som tidligt valg
  assert.deepStrictEqual([...H.coreOf(eve, { buildChoice: 'popular' })], ['3100', '3041', '3089'], 'core uden Dark Seal');
  assert.strictEqual(H.nextInBuild(eve, []).share('3100'), 1, 'Lich Bane er 1. færdige item i alle kombinationer');
  const n1 = H.nextInBuild(eve, ['3100']);
  assert(n1.share('3041') > 0.6 && n1.slot === 2, `Mejai's er typisk 2. item: ${n1.share('3041')}`);
  const n3 = H.nextInBuild(eve, ['3100', '3041', '3089']);
  assert(n3 && n3.slot === 4 && n3.share('3135') === 1, '4. item i en 4-item-kombination');
  const first = H.liveAdvice(eve, meWith([]), noEnemy, 1000, 11);
  const seal = first.find((a) => a.id === '1082');
  assert(seal && seal.reasons.some((r) => /core-kombinationerne .* starter med Dark Seal/.test(r)), `Dark Seal som valg før første item: ${JSON.stringify(first.map((a) => [a.id, a.reasons]))}`);
  assert(!H.liveAdvice(eve, meWith(['3100']), noEnemy, 1000, 11).some((a) => a.id === '1082'), 'ingen Dark Seal efter første færdige item');

  // 6) Smart core: gameplanen/stemmen bruger samme core som item settet
  const two = { core_items: [{ ids: [3100, 3089, 4645], play: 1000, win: 480 }, { ids: [3100, 3041, 3089], play: 600, win: 360 }] };
  const rec = H.recommend(two, { buildChoice: 'smart', adaptToEnemies: false }, [], null);
  assert(rec.blocks[0].type.startsWith('Core build') && rec.blocks[0].items.map((i) => i.id).join() === H.coreOf(two, { buildChoice: 'smart' }).join(), 'samme smart-core');

  // 7) Pladser: Doran's Bow/Helm og Control Ward kan sælges; jungle-pet + 5 items = fuldt build (elixir)
  const sell = H.sellableIds(['1086', '1120', '2055', '3100'], new Map());
  assert(['1086', '1120', '2055'].every((id) => sell.includes(id)) && !sell.includes('3100'), `kan sælges: ${sell}`);
  const five = ['3100', '3089', '3135', '4645', '3157'];
  const pet = H.inventoryInfo(meWith([...five, '1101']), 600, 11, 1800, eve);
  assert(pet.full && pet.elixir, `pet + 5 items = fuldt build med elixir: ${JSON.stringify(pet)}`);
  const wardFull = H.inventoryInfo(meWith([...five, '2055']), 600, 11, 1800, eve);
  assert.strictEqual(wardFull.full, false, 'Control Ward kan sælges -> ikke fuldt');

  // 8) ARAM/Arena: ingen Control Ward-påmindelse, ingen SR-startitems, Forbrug uden ward i ARAM
  assert(H.inventoryInfo(meWith(['3100']), 500, 11, 600, null).wardTip, 'ward-påmindelse på SR');
  assert.strictEqual(H.inventoryInfo(meWith(['3100']), 500, 12, 600, null).wardTip, null, 'ingen ward i ARAM');
  const st = { starter_items: [{ ids: [1056, 2003, 2003], play: 1000, win: 500, pick_rate: 0.5 }] };
  assert(H.starterAdvice(st, null, meWith([]), 500, 10, 11), 'startitems på SR');
  assert.strictEqual(H.starterAdvice(st, null, meWith([]), 500, 10, 30), null, 'ingen SR-startitems i Arena');
  const aram = H.recommend(two, { buildChoice: 'popular', adaptToEnemies: false }, [], null, 12);
  assert(!aram.blocks.find((b) => b.type === 'Forbrug').items.some((i) => i.id === '2055'), 'ingen Control Ward i ARAM-item settet');

  // 9) Del-forslag: prisen trækker ejede under-dele fra (Aether Wisp med en Amplifying Tome)
  const wisp = it('3100')?.from.find((p) => it(p).from.includes('1052'));
  if (wisp) {
    const part = H.affordablePart('3100', ['1052'], H.remainingCost(wisp, ['1052']).cost);
    assert(part && part.cost === H.remainingCost(part.id, ['1052']).cost, `del med restpris: ${JSON.stringify(part)}`);
    assert.strictEqual(H.affordablePart('3100', ['1052'], it(wisp).gold - 1)?.id, wisp, `${it(wisp).name} kan betales med en Tome`);
  }

  // 10) Item settet: kun færdige items i "Mod deres hold" og "Situationelle items"
  const pool = { core_items: [], last_items: [3123, 1038, 3033, 1031, 3026].map((id) => ({ ids: [id], play: 100, win: 50, pick_rate: 0.05 })) };
  const ci = H.counterItems(pool, { healers: [{ name: 'Soraka' }], adHeavy: true, apHeavy: false, adShare: 0.8 }, new Set());
  assert(ci.picks.length && ci.picks.every((id) => H.isCompleted(it(id))), `kun færdige counter-items: ${ci.picks}`);
  const late = H.recommend(pool, { buildChoice: 'popular', adaptToEnemies: false }, [], null).blocks.find((b) => b.type === 'Situationelle items');
  assert(late.items.every((i) => H.isCompleted(it(i.id))), `kun færdige situationelle items: ${late.items.map((i) => i.id)}`);

  // 11) Matchup-core i item settet
  const vs = { id: 238, build: { core_items: [{ ids: [3100, 3157, 3089], play: 400, win: 220 }] }, stats: null };
  const recVs = H.recommend(two, { buildChoice: 'popular', adaptToEnemies: false }, [], vs);
  assert(recVs.blocks.some((b) => b.type.startsWith('Core mod Zed')), `core mod Zed: ${recVs.blocks.map((b) => b.type)}`);

  // 12) Gameplanens valg: intet item med samme unikke passiv som et du har (Profane ved siden af Ravenous Hydra)
  const rav = it('3074');
  const prof = it('6698');
  if (rav && prof && rav.passives.some((p) => prof.passives.includes(p))) {
    const plan = { oppKey: '238', opponent: 'Zed', myCore: [], oppCore: [], myPool: ['6698', '3033', '3036'] };
    const me = { ...meWith(['3074'], { ad: 1, ap: 0 }), champ: { id: 'Tryndamere' } };
    const opp = { ...meWith([], { ad: 1, ap: 0 }), champ: { key: '238' }, armor: 60, mr: 0 };
    const lines = H.planNow(plan, { me, matchup: { player: opp } });
    const pen = lines.find((l) => l.includes('armor fra items')) || '';
    assert(pen && !pen.includes(prof.name), `ingen Profane Hydra ved Ravenous: ${pen}`);
  }

  // 13) Begrundelser er fakta (ingen "er fed"), og salg/bytte er muligheder
  const fedZed = { champ: { name: 'Zed' }, kills: 9, deaths: 1, assists: 3, dmg: { ad: 0.9, ap: 0.1 } };
  const armorBuild = { core_items: [], last_items: [{ ids: [3157], play: 500, win: 250, pick_rate: 0.3 }], boots: [] };
  const fedAdv = H.liveAdvice(armorBuild, meWith([]), { ...noEnemy, fed: [fedZed] }, 5000, 11);
  const r = fedAdv.find((a) => a.id === '3157')?.reasons || [];
  assert(r.some((x) => x.startsWith('Zed: 9/1/3')) && !r.some((x) => /er fed/.test(x)), `fakta-begrundelse: ${r}`);
  // Svag grund (kun AD-andel) giver ingen tilpasset plads
  const share = H.liveAdvice(armorBuild, meWith([]), { ...noEnemy, adShare: 0.8 }, 5000, 11).find((a) => a.id === '3157');
  assert(share && !share.adapted, 'AD-andel alene er ikke en tilpasset grund');

  console.log('ALLE ITEM-TESTS BESTÅET');
})().catch((e) => { console.error(e); process.exit(1); });
