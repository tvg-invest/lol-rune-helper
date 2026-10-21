# LoL Rune Helper

Sætter automatisk **runer**, **summoner spells** og et **item set** (anbefalede items i butikken), når du låser en champion i champion select. Items og støvler **tilpasses modstanderholdet**. **Under kampen** viser vinduet 2-3 begrundede købsforslag ud fra hvad modstanderne faktisk bygger + et live scoreboard - også på telefonen. Virker på Windows og Mac.

Builds kommer fra OP.GG (nuværende patch, din rolle). Navne og ikoner kommer fra Riots Data Dragon.

## Til spilleren

Hent den færdige zip (ingen installation nødvendig), pak ud, og start programmet. Se `LAES-MIG.txt` (kommer med i zip'en som `LÆS MIG.txt`).

## Hvad sker der

Når du har **låst** en champion:

- **Runer:** laver en rune-side `Auto: <Champion> <ROLLE>` og gør den aktiv. Samme side genbruges hver gang. Har du ingen ledige sider (klienten melder fulde sider), erstattes én af dine egne sider én gang - helst en du ikke har aktiv. Afviser klienten alligevel auto-siden, lægges din side tilbage.
- **Valg af build (`buildChoice: smart`):** højeste win rate blandt muligheder med mindst 25% af den mest spilledes kampe (og mindst 100 kampe). `popular` = mest spillede.
- **Summoners:** de mest spillede. Flash bliver på den tast, du havde den på.
- **Item set:** start-items + skill-rækkefølge, core build, "Mod deres hold", støvler, alternativer, situationelle items. Dine egne item sets røres ikke.
- **Mod deres hold:** når modstanderne har valgt, analyseres holdet (AD/AP-fordeling fra Data Dragon, kendte healere, tanks/supports som CC). Der foreslås anti-heal, armor eller magic resist - men **kun items som din champion faktisk bygger** ifølge OP.GG - og Plated Steelcaps / Mercury's Treads hvis championen bruger dem. Kun item set'et opdateres; runerne røres ikke igen.
- **Vindue** (`http://127.0.0.1:3399`, kun lokalt): vælg mellem 3 rune-sider, tving en rolle, se analysen af modstanderholdet og en log.

Rolle: tildelt rolle i draft/ranked, ellers championens hovedrolle. ARAM og URF har egne data. Arena og ukendte spiltyper uden for Summoner's Rift springes over.

## Draft, kampoversigt og opdateringer

- **Draft (før du låser):** din pulje = top-15 mastery (`/lol-champion-mastery/v1/local-player/champion-mastery`) + champions fra `history.json`, filtreret på rollen (OP.GG role_rate >= 20%). Ban-forslag = champions som puljen i snit taber til (OP.GG `counters`, min. 200 kampe). Når lane-modstanderen er valgt: puljen sorteret efter win rate mod den + de 3 stærkeste counters (min. 500 kampe). Valgte/bannede champions foreslås ikke.
- **Kampoversigt:** færdige items du køber registreres med tid og om de var blandt forslagene (og tilpassede). Resultat fra live-API'ens `GameEnd`-event (`Result`), ellers ukendt. Gemmes i `history.json` (max 100) med spiltype, map og konto; kampe under 5 min og Practice Tool tæller ikke. Statistikken og draft-puljen bruger kun Summoner's Rift-kampe.
- **Kampen er slut** når spillets port lukker og klienten ikke længere er "i kamp" (eller `GameEnd` er set). Crasher spillet og du genforbinder, fortsætter samme kamp (køb, gameplan og stemme bevares).
- **Opdateringer:** tjekker `https://api.github.com/repos/tvg-invest/lol-rune-helper/releases/latest` ved start, hver time og når vinduet åbnes. Asset `LoL-Rune-Helper.exe` / `LoL-Rune-Helper-mac`. "Opdater nu" henter filen, tjekker størrelse + sha256 mod GitHubs `digest`, erstatter programmet (den kørende fil omdøbes til .old) og starter den nye med `--updated` (Windows: via `start /min`, så den har sit eget konsolvindue). Den gamle venter op til 90 sek. på at den nye svarer på `/state`; ellers stoppes den nye, .old lægges tilbage, og den gamle kører videre med fejlen i vinduet. Den nye sletter .old først når den lytter. Udgiv med `bash scripts/build.sh && bash scripts/release.sh "noter"` efter at have hævet `VERSION`.
- Tests: `node test/fake-lcu.test.js` (alt), `node test/items.test.js` (item-logik mod den rigtige Data Dragon), `node test/robust.test.js` (uden net: forrige patch, skalering, OP.GG-kø, spiltyper), `node test/sikkerhed.test.js` (ødelagt config.json, telefon kun via Tailscale, kun én kopi) og `HELPER_BIN=... node test/update.test.js` (selv-opdatering mod falsk udgivelse, inkl. 404, forkert sha256, dobbeltklik og tilbagerulning).

## Matchup, hastighed og autostart

- **Lane-modstander:** et gæt ud fra OP.GG's rollefordeling (`/api/<region>/champions/ranked`, ét kald for alle champions): hver modstander får én rolle, så summen af rollernes andel er størst; modstanderen på din rolle bruges med min. 25%. Eller den du klikker på i vinduet. Under kampen: samme `position` i live-API'en; mangler den og spiller du jungle, den eneste modstander med Smite.
- **Matchup-data:** `?target_champion=<id>` på OP.GG giver runer/items kun fra kampe mod den champion. Bruges kun med mindst 150 kampe: "Mod X"-rune-side først og start-items. Win rate mod modstanderen fra `counters`.
- **Din side er din:** når modstanderen kendes efter du har låst, skiftes runerne kun hvis den aktive side stadig er programmets urørte auto-side (`/lol-perks/v1/currentpage`).
- **Hurtigt:** buildet (og matchup-buildet, når draften kender modstanderen) hentes mens du hover. Runer og summoners venter højst 1,5 sek. på matchup-opslaget; kommer det senere, skiftes til matchup-runerne hvis auto-siden er urørt. OP.GG-svar caches i hukommelsen og i `cache/` i 6 timer (regnet fra filens alder); en fejl huskes i 15 sek., og uden net bruges en ældre fil (op til 24 t).
- **Fejl og offline:** kan buildet ikke hentes, prøves igen efter 15, 30, 45 og derefter hvert 60. sek. Runer, summoners og item set sættes hver for sig, så én fejl ikke stopper resten. Data Dragon gemmes i `cache/ddragon.json`: uden internet ved start bruges den gemte kopi, ellers venter programmet (vinduet viser status). Ny patch i Data Dragon hentes automatisk (tjek hvert 15. min).
- **Klientens dataformat:** første rigtige champion select gemmer formen af klientens svar (felter og typer, ingen navne) i `lcu-shapes.json` ved siden af programmet, så antagelserne om LCU-felterne kan tjekkes. Slet filen for at få en ny.
- **Én kopi:** startes programmet igen, åbner det bare det kørende vindue.
- **Autostart:** knap i vinduet. Windows: genvej i Start-mappen (minimeret). macOS: LaunchAgent `~/Library/LaunchAgents/dk.tvginvest.lolrunehelper.plist`. Starter med `--autostart` (åbner ikke browseren).

## Under kampen (live)

Læser spillets [Live Client Data API](https://developer.riotgames.com/docs/lol) (`https://127.0.0.1:2999/liveclientdata/allgamedata`) hvert 2. sekund og viser i vinduet:

- **Overvej at købe:** 2-3 forslag fra championens egen item-pulje (min. 2% køber det), scoret efter popularitet + modstandernes **faktiske** builds:
  - anti-heal mod healere (champions med meget healing eller lifesteal/omnivamp-items); findes intet anti-heal i puljen, bruges det der matcher din skadetype
  - armor/MR mod en **fed** modstander (kills, items, level) af den skadetype, og når holdets trussel er AD- eller AP-tung
  - armor/magic pen når mindst 2 stacker forsvar (eller én stacker meget)
  - op til 2 tilpassede forslag, resten fra buildet; restpris med ejede dele trukket fra + hvilken del du har råd til nu
- **Scoreboard:** items, KDA, CS, level, item-guld pr. hold og drager/baron/herald/tårne fra kill-feedet.
- **Modstanderne:** AD/AP-trussel vægtet efter items og kills, hvem der stacker forsvar eller healer. Spiller du en champion med camouflage/usynlighed (fx Evelynn), står der også hvem der bærer Oracle Lens eller Control Ward (passiv TAB-info, ingen stemme).

Riots regler ([Game Policy](https://developer.riotgames.com/docs/lol), [General Policies](https://developer.riotgames.com/policies/general)) forbyder information spilleren ikke allerede kender og apps der bestemmer spillerens beslutninger, men tillader at fremhæve vigtige beslutninger og give flere valg. Derfor: kun TAB-information, 2-3 begrundede forslag, ingen timere. Bemærk at Riot kræver at produkter registreres i Developer Portal.

## Købsforslag: byggerækkefølge, matchup, påmindelser

- **Næste item:** OP.GG's `core_items` er 3-item-kombinationer (antaget i byggerækkefølge - passer med data). Blandt kombinationer hvis første k items er dine færdige (ikke støvler), andelen der bygger item k+1 -> bonus + begrundelse. Det mest typiske næste item har altid en plads (efter et item du er i gang med).
- **Matchup:** `last_items` mod lane-modstanderen (`?target_champion=`, min. 100 kampe) vs. generelt; ratio >= 1,3 -> bonus "Bygges oftere mod X".
- **Startitems:** de første 3 min og før første køb (trinket tæller ikke): matchup-startitems (min. 150 kampe) ellers de mest købte; vises i vindue og overlay, siges én gang.
- **Påmindelser** (linjer over forslagene): ingen færdige støvler efter 10 min (mest spillede fra buildet, restpris), ingen Control Ward efter 5 min når der er plads og 75 g.
- Item-win rates bruges ikke som bonus (overlevelses-bias: dyre items færdiggøres mest i vundne kampe).

## Jungle-ruter og core-stemme

- **Jungle-ruter:** `op.gg/lol/champions/<ddragon-id i små bogstaver>/jungle-paths/jungle` har ruterne som indlejret (escaped) data: `{"team_key":"BLUE|RED","routes":[{"route":[6 camps],"play":N,"rank":N}, ...]}`. Ruterne læses ét objekt ad gangen fra listens start. Top 3 pr. side med andel, plus hvor de starter (`"rate":{"team_key":..,"blue":..,"red":..,"raptors":..}`, procent); caches 6 timer; fejl = intet kort. Vises for JUNGLE i champion select (begge sider) og de første 5 min (kun din side, fra live-API'ets `team`).
- **Core-stemme:** når et item fra dit core build (gameplanens eller buildets) bliver færdigt: "<item> færdig - N af M i dit core build". Egen tilstand.
- **Lane-modstander under kampen:** samme rolle i live-API'et; mangler rollerne, bruges modstanderen fra champion select.

## Inventory, fuldt build og ny patch

- **Pladser:** live-API'ens `slot` (0-5 = inventory). Nyt item uden ejede dele og ingen ledig plads -> "fx ved salg af" Doran's/Dark Seal/Cull, potion eller Control Ward (Dark Seal beholdes hvis Mejai's er i buildet); 5 færdige items + noget der ikke kan sælges (jungle-pet) = fuldt build; ingen "råd nu til delen" uden plads.
- **Fuldt build** (6 færdige items): ingen almindelige køb; højst 2 begrundede bytninger (det mindst brugte af dine items, støvler beholdes) + elixir efter skadetype (Wrath/Sorcery/Iron).
- **Unikke passiver:** items der deler et `<passive>`-navn i Data Dragon (Spellblade, Lifeline, Cleave, Manaflow, Annul ...) foreslås ikke oven i hinanden.
- **Ny patch:** er OP.GG's patch den nyeste i Data Dragon og har under 20.000 kampe -> OP.GG `?version=<forrige>` bruges hvis den har mindst 3x så mange kampe (også for matchup-data), vises i vinduet. Halter OP.GG efter Data Dragon, bruges OP.GG's patch som den er.
- **Modstander-notifikationer (`enemyAlerts`, standard til):** stemme og overlay når lane-modstanderen køber et item eller når level 6, "X er fed" (stemme, overlay, FED-mærke), "har ult" i "Lige nu" og modstander-begrundelser i overlay/stemme/bip. OBS: Overwolfs regler for Riot-spil forbyder notifikationer om modstanderes power spikes - sæt `"enemyAlerts": false` for at slå det hele fra (så står det kun passivt i hovedvinduet).

## Gameplan mod lane-modstanderen

- **Fast del** (champion select og kamp): win rate i matchuppet (OP.GG `counters`; under 150 kampe vises den grå med "få kampe"), lane-fordel ("Tidligt i kampen" for junglere) / flest solo kills / spillestil + tip-tekst fra OP.GG's offentlige MCP-tjeneste (`https://mcp-api.op.gg/mcp`, værktøj `lol_get_lane_matchup_guide`; navne i UPPER_SNAKE_CASE, kun engelsk; udokumenteret - fejler den, laves planen uden; sender den antal kampe (`summoner_spells[].play`) under 150, vises kun tippet), skalering ud fra begge champions' `game_lengths`, og begges typiske core build. Spillestil, tip og skalering vises kun i champion select - ikke under kampen.
- **Live** ("Lige nu", står øverst i kortet under kampen): begges level, item-guld, KDA, core-fremskridt for begge, hans armor/MR/anti-heal/skadetype med items fra DIT build (min. 2% pick rate) der svarer på det.
- **Ændringer**: hans nye færdige items (og level 6) logges med tid; med `enemyAlerts` siges de også og står i overlayet.
- Kun fakta + valg, ingen "engage nu" (Riot: "Apps that dictate player decisions"). Research: `docs/research-tryndamere-evelynn.md`.

## Stemme og fuldskærm

Ægte fuldskærm (exclusive fullscreen) kan ikke overlejres af andre vinduer; det kræver injektion i spilprocessen, som programmet bevidst ikke gør (Vanguard). Derfor en stemme, der virker uanset vindue: startitems, "Råd til <item>" (vigtigste nye forslag du kan købe uden at sælge/bytte), "Level op: Q", "Level 6 - R" (Evelynn: "Level 6 - camouflage og R") og færdige core-items - og med `enemyAlerts` også "X er fed" og lane-modstanderens køb/level 6. Kun nye hændelser, max én pr. slags hvert 8. sek.; en besked der blev afvist af 8-sek.-grænsen, prøves igen ved næste tjek. Beskederne siges én ad gangen (kø), og en besked der har ventet over 6 sek. i køen, droppes og gentages ikke. Med `"enemyAlerts": false` siges "Råd til" ikke for forslag, der kun skyldes modstandernes tilstand (fx en modstander med høj KDA). Windows: `System.Speech` via PowerShell med en dansk stemme (da-DK) hvis der er en; macOS: `say` med en dansk stemme hvis der er en. Den valgte stemme og evt. fejl står i loggen. Til/fra i vinduet (gemmes i `config.json` som `voice`).

## Overlay

Knappen "Overlay" åbner et [Document Picture-in-Picture](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)-vindue (Chrome/Edge 116+), som altid ligger øverst: guld, startitems, de 3 forslag (RÅD NU / mangler X, hvor salgs-/bytteværdien er trukket fra) og din matchup-win rate. Med `enemyAlerts` (standard) også "Fed: ...", lane-modstanderens seneste køb og begrundelser om modstanderne; med `"enemyAlerts": false` kun begrundelser om dit eget build. Bip + blink når et forslag skifter til "råd nu". Mistes forbindelsen til programmet, viser overlayet "Forbindelse tabt" i stedet for gamle tal. Intet injiceres i spillet - det er et almindeligt browservindue, så League skal køre i Borderless.

## Telefon

`"remoteAccess": true` åbner vinduet for andre enheder (ellers kun 127.0.0.1). Som standard kun via Tailscale (100.64.0.0/10, krypteret af Tailscale). `"remoteLan": true` tillader også wifi/LAN - det er almindelig HTTP, så nøglen kan aflyttes på delte netværk. `"remoteHosts": ["min-pc"]` tillader ekstra navne, fx et Tailscale MagicDNS-navn. Tilladte adresser (Host-tjek mod DNS-rebinding) opdateres hvert minut, så Tailscale der starter efter programmet også virker. Andre enheder skal have en hemmelig nøgle (QR-kode i vinduet, gemt i `remote-token.txt` - slet filen for en ny nøgle), som bliver til en cookie. POST kræver JSON, så fremmede hjemmesider ikke kan ændre noget.

## Indstillinger (`config.json` ved siden af programmet)

| Felt | Betydning |
|---|---|
| `region` | OP.GG-region: `GLOBAL` (flest kampe), `EUW`, `EUNE`, `NA`, `KR` ... |
| `buildChoice` | `smart` eller `popular` |
| `setRunes` / `setSpells` / `setItemSet` / `adaptToEnemies` | `true`/`false` |
| `flashKey` | `keep`, `D` eller `F` |
| `liveAdvice` | Købsforslag, scoreboard og gameplan under kampen |
| `voice` | Stemme til/fra |
| `enemyAlerts` | Notifikationer om modstanderne (stemme/overlay om lane-modstanderens køb og level 6, "X er fed", FED-mærke, "har ult"). Forbudt efter Overwolfs Riot-regler - `false` slår dem fra |
| `openWindow` | Åbn vinduet i browseren ved start |
| `autoUpdate` | Tjek for nye versioner (opdatering sker først når du klikker) |
| `remoteAccess` | Vinduet kan åbnes fra telefonen (kun via Tailscale, medmindre `remoteLan`) |
| `remoteLan` | Tillad også telefon-adgang via wifi/LAN (ukrypteret HTTP) |
| `remoteHosts` | Ekstra navne vinduet må åbnes på, fx `["min-pc"]` (Tailscale MagicDNS) |
| `port` | Port til vinduet (næste ledige bruges hvis optaget) |
| `pollMs` | Hvor ofte klienten tjekkes |

## Udvikling

- Kør fra kilde: `node lol-helper.js` (Node 18+), eller `start-windows.bat` / `start-mac.command`.
- Test mod falsk League-klient: `node test/fake-lcu.test.js`
  - `HELPER_BIN="dist/LoL-Rune-Helper-Mac/LoL Rune Helper"` tester den færdige programfil.
  - Dækker champion select, modstandere, vindue-API, rolleskift, live-kamp (forslag, restpris, scoreboard, objectives) og telefon-nøglen.
  - Screenshot: `HOLD_LIVE=25000 node test/fake-lcu.test.js` (eller `HOLD_SELECT`), og `node test/screenshot.js <url fra HOLD-linjen> fil.png [bredde] [højde]`. Bruger en ren Chrome-profil og melder billeder der ikke er indlæst.
- Byg programfiler (på macOS): `bash scripts/build.sh` -> `dist/LoL-Rune-Helper-Windows.zip` og `dist/LoL-Rune-Helper-Mac.zip` (universal). Bruger Node "single executable applications"; henter Node-binærer fra nodejs.org og `postject` via npx.

## Er det tilladt?

Programmet bruger kun Riots officielle, lokale API'er: League-klientens API i champion select (runer, summoners, item sets - det samme som U.GG, Blitz og Porofessor) og under kampen spillets Live Client Data API, som kun giver det du også kan se på TAB (items, levels, KDA, eget guld). Ingen injektion i spillet, ingen hukommelses- eller skærmlæsning. Forslag er fakta og valg. OBS: med `enemyAlerts` (standard) giver programmet notifikationer om modstanderes power spikes, som Overwolfs regler for Riot-spil forbyder - det er din risiko; `"enemyAlerts": false` slår dem fra. Riot kræver at produkter registreres i Developer Portal.
