# LoL Rune Helper

Sætter automatisk **runer**, **summoner spells** og et **item set** (anbefalede items i butikken), når du låser en champion i champion select. Items og støvler **tilpasses modstanderholdet**. Et lokalt vindue viser hele anbefalingen med ikoner. Virker på Windows og Mac.

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
  - `SCREENSHOT=gui.png` tager et billede af vinduet (headless Chrome).
- Byg programfiler (på macOS): `bash scripts/build.sh` -> `dist/LoL-Rune-Helper-Windows.zip` og `dist/LoL-Rune-Helper-Mac.zip` (universal). Bruger Node "single executable applications"; henter Node-binærer fra nodejs.org og `postject` via npx.

## Er det tilladt?

Programmet bruger kun klientens lokale API i champion select - det samme som U.GG, Blitz og Porofessor. Det læser intet fra selve kampen.
