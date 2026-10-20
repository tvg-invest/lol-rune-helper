# LoL Rune Helper

Sætter automatisk **runer**, **summoner spells** og et **item set** (anbefalede items i butikken), når du låser en champion i champion select. Virker på Windows og Mac.

Builds kommer fra OP.GG (mest spillede runer/build for championen i din rolle på nuværende patch). Navne kommer fra Riots Data Dragon.

## Installation (én gang)

1. Installer **Node.js LTS** fra https://nodejs.org (version 18 eller nyere).
2. Pak mappen ud et sted, fx på skrivebordet.

## Start

- **Windows:** dobbeltklik `start-windows.bat`.
- **Mac:** første gang: højreklik `start-mac.command` -> Åbn -> Åbn (macOS advarer, fordi filen ikke er signeret). Derefter bare dobbeltklik.

Lad vinduet stå åbent, mens du spiller. Rækkefølgen er ligegyldig - programmet venter selv på League-klienten.

## Hvad sker der

Når du har **låst** en champion:

- **Runer:** laver en rune-side der hedder `Auto: <Champion> <ROLLE>` og gør den aktiv. Den samme side genbruges hver gang. Har du ingen ledige sider, erstattes din aktive side én gang - derefter bruges kun auto-siden.
- **Summoners:** sætter de mest spillede. Flash bliver på den tast, du havde den på (kan ændres).
- **Item set:** ligger øverst i butikken i spillet: start-items + skill-rækkefølge, core build, støvler, alternativer, situationelle items. Dine egne item sets røres ikke.
- Vinduet viser også hele anbefalingen som tekst.

Rolle: i draft/ranked bruges din tildelte rolle. I blind pick bruges championens hovedrolle. ARAM har sine egne data. Arena springes over.

## Indstillinger (`config.json`)

| Felt | Betydning |
|---|---|
| `region` | OP.GG-region: `GLOBAL` (flest kampe), `EUW`, `EUNE`, `NA`, `KR` ... |
| `setRunes` / `setSpells` / `setItemSet` | `true`/`false` for hver del |
| `flashKey` | `keep`, `D` eller `F` |
| `pollMs` | Hvor ofte klienten tjekkes (millisekunder) |

## Er det tilladt?

Programmet bruger kun klientens officielle lokale API i champion select - det samme som U.GG, Blitz og Porofessor gør. Det læser intet fra selve kampen.

## Test (udvikling)

`node test/fake-lcu.test.js` kører programmet mod en falsk League-klient og tjekker hvad det sender.
