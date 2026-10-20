# LoL Rune Helper

Sætter automatisk **runer**, **summoner spells** og et **item set** (anbefalede items i butikken), når du låser en champion i champion select. Items og støvler **tilpasses modstanderholdet**. **Under kampen** viser vinduet 2-3 begrundede købsforslag ud fra hvad modstanderne faktisk bygger + et live scoreboard - også på telefonen. Virker på Windows og Mac.

Builds kommer fra OP.GG (nuværende patch, din rolle). Navne og ikoner kommer fra Riots Data Dragon.

## Til spilleren

Hent den færdige zip (ingen installation nødvendig), pak ud, og start programmet. Se `LAES-MIG.txt` (kommer med i zip'en som `LÆS MIG.txt`).

## Hvad sker der

Når du har **låst** en champion:

- **Runer:** laver en rune-side `Auto: <Champion> <ROLLE>` og gør den aktiv. Samme side genbruges hver gang. Har du ingen ledige sider, erstattes din aktive side én gang.
- **Valg af build (`buildChoice: smart`):** højeste win rate blandt muligheder med mindst 25% af den mest spilledes kampe (og mindst 100 kampe). `popular` = mest spillede.
- **Summoners:** de mest spillede. Flash bliver på den tast, du havde den på.
- **Item set:** start-items + skill-rækkefølge, core build, "Mod deres hold", støvler, alternativer, situationelle items. Dine egne item sets røres ikke.
- **Mod deres hold:** når modstanderne har valgt, analyseres holdet (AD/AP-fordeling fra Data Dragon, kendte healere, tanks/supports som CC). Der foreslås anti-heal, armor eller magic resist - men **kun items som din champion faktisk bygger** ifølge OP.GG - og Plated Steelcaps / Mercury's Treads hvis championen bruger dem. Kun item set'et opdateres; runerne røres ikke igen.
- **Vindue** (`http://127.0.0.1:3399`, kun lokalt): vælg mellem 3 rune-sider, tving en rolle, se analysen af modstanderholdet og en log.

Rolle: tildelt rolle i draft/ranked, ellers championens hovedrolle. ARAM har egne data. Arena springes over.

## Under kampen (live)

Læser spillets [Live Client Data API](https://developer.riotgames.com/docs/lol) (`https://127.0.0.1:2999/liveclientdata/allgamedata`) hvert 2. sekund og viser i vinduet:

- **Overvej at købe:** 2-3 forslag fra championens egen item-pulje (min. 2% køber det), scoret efter popularitet + modstandernes **faktiske** builds:
  - anti-heal mod healere (champions med meget healing eller lifesteal/omnivamp-items); findes intet anti-heal i puljen, bruges det der matcher din skadetype
  - armor/MR mod en **fed** modstander (kills, items, level) af den skadetype, og når holdets trussel er AD- eller AP-tung
  - armor/magic pen når mindst 2 stacker forsvar (eller én stacker meget)
  - op til 2 tilpassede forslag, resten fra buildet; restpris med ejede dele trukket fra + hvilken del du har råd til nu
- **Scoreboard:** items, KDA, CS, level, item-guld pr. hold og drager/baron/herald/tårne fra kill-feedet.
- **Modstanderne:** AD/AP-trussel vægtet efter items og kills, hvem der er fed, stacker forsvar eller healer.

Riots regler ([Game Policy](https://developer.riotgames.com/docs/lol), [General Policies](https://developer.riotgames.com/policies/general)) forbyder information spilleren ikke allerede kender og apps der bestemmer spillerens beslutninger, men tillader at fremhæve vigtige beslutninger og give flere valg. Derfor: kun TAB-information, 2-3 begrundede forslag, ingen timere. Bemærk at Riot kræver at produkter registreres i Developer Portal.

## Overlay

Knappen "Overlay" åbner et [Document Picture-in-Picture](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)-vindue (Chrome/Edge 116+), som altid ligger øverst: guld, de 3 forslag (RÅD NU / mangler X) og hvem der er fed. Bip + blink når et forslag skifter til "råd nu" (kun dit eget guld). Intet injiceres i spillet - det er et almindeligt browservindue, så League skal køre i Borderless.

## Telefon

`"remoteAccess": true` lytter på alle netværk (ellers kun 127.0.0.1). Andre enheder skal have en hemmelig nøgle (QR-kode i vinduet, gemt i `remote-token.txt`), som bliver til en cookie. POST kræver JSON, så fremmede hjemmesider ikke kan ændre noget.

## Indstillinger (`config.json` ved siden af programmet)

| Felt | Betydning |
|---|---|
| `region` | OP.GG-region: `GLOBAL` (flest kampe), `EUW`, `EUNE`, `NA`, `KR` ... |
| `buildChoice` | `smart` eller `popular` |
| `setRunes` / `setSpells` / `setItemSet` / `adaptToEnemies` | `true`/`false` |
| `flashKey` | `keep`, `D` eller `F` |
| `openWindow` | Åbn vinduet i browseren ved start |
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

Programmet bruger kun klientens lokale API i champion select - det samme som U.GG, Blitz og Porofessor. Det læser intet fra selve kampen.
