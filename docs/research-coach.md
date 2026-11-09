# Coach: hvad en coach ville sige - og hvordan det måles i dine kampe (nov. 2026)

Grundlaget for kortet "Din coach" i LoL Rune Helper (v1.21.0). Hvert råd har en kilde til selve rådet og et tal fra
dine egne kampe. Alle tal er **sammenhænge** (kampe man vinder har fx flere drager med dig ved pitten) - ikke bevis for årsag.
Rådene vises kun **før og efter** kampen; under kampen viser programmet stadig kun fakta og valg.

Kilderne er hentet og læst 9/11-2026 (dodge.gg-mid-guiden og League Wikis Baron-side dobbelttjekket).
dodge.gg, metabot.gg og loltheory er coaching-blogs fra 2026, ikke pro-holds sider. Dignitas-artiklerne er fra 2016-2021
(pro-holdets blog): rådene står ved magt, men deres spiltal (timere, guld) er forældede - programmet bruger kun spiltal
fra League Wiki og Riots patch notes.
Kunne ikke hentes: nerfplz.com (403), boostroom.com (403), wombocombo.gg (videresender til en anden side),
docs.bayesesports.com (DNS-fejl), dodge.gg top-guide (404). Mobalytics, Blitz, League of Graphs og Reddit blokerer (se research-low-elo.md).

## Spillets regler (2026)

| Fakta | Kilde |
|---|---|
| Drage: første gang 5:00, ny drage 5 min efter den forrige er dræbt | https://wiki.leagueoflegends.com/en-us/Dragon |
| Voidgrubs: 8:00, kun én gang, forsvinder 14:45 | https://wiki.leagueoflegends.com/en-us/Void_Grub |
| Rift Herald: 15:00, forsvinder 19:45 | https://wiki.leagueoflegends.com/en-us/Rift_Herald |
| Baron Nashor: 20:00 (fra 25:00 i patch 26.1), 6 min mellem | https://wiki.leagueoflegends.com/en-us/Baron_Nashor |
| Atakhan fjernet i patch 26.1 | https://wiki.leagueoflegends.com/en-us/Atakhan |
| Tårnplader: 5 plader, 120 g, **permanente** siden 26.1 (falder ikke af ved 14:00 længere) | https://www.leagueoflegends.com/en-us/news/game-updates/patch-26-1-notes/ |
| Kortets koordinater: Summoner's Rift ca. -120 til 14.870 (x) / 14.980 (y) | https://hextechdocs.dev/map-data/ |

## Rådene - hvad coaches siger

### Mid
- **Skub før du går:** "Always push the wave before leaving lane." / "The cannon wave is your best roam timer." -
  https://www.dodge.gg/en-US/lol/news/mid-lane-guide-2026 (24/3-2026)
- **Mid-prio før objectives:** "Before Dragon, Baron, or Grubs, shove the mid wave. This forces the enemy to either lose CS mid or
  send someone to catch it, creating a numbers advantage at the objective." - samme kilde.
- **Roam med prio:** "It is best to roam when you have lane priority over your opponent" -
  https://dignitas.gg/articles/leave-lane-win-game-a-mid-laners-guide-to-roaming-league-of-legends (25/5-2019)
- Ingen kilde fundet for "roam når fjendens mid recaller" - derfor står det ikke i rådene.

### Jungle
- **Gank lanes der kan følge op:** "Your laner has CC to chain with yours - a gank without follow-up CC usually fails"; gank når bølgen
  skubber mod jeres tårn, ikke når din laner har lavt liv eller fjenden har en stor bølge - https://www.dodge.gg/en-US/lol/news/jungle-guide-2026 (24/3-2026)
- **Path mod siden med prio:** vertikal jungling "requires lane priority on the side you are invading" - samme kilde.
- **Track fjendens jungler:** "you always want to be tracking what path the enemy Jungler is taking" -
  https://dignitas.gg/articles/dardochs-jungle-guide-for-season-11-prepare-for-2021 (9/1-2021)

### Top
- **Teleport:** Teleport bot til ganks og ind i drage- eller Herald-kampe; afbryd hvis kampen vender -
  https://dignitas.gg/articles/blogs/League-of-Legends/9558/the-uses-of-top-lane-teleport (16/6-2016, gamle TP-regler;
  nuværende: https://wiki.leagueoflegends.com/en-us/Teleport)
- **Split vs. gruppe:** "If you aren't warding or watching your minimap and are just mindlessly pushing, you're literally asking to lose
  the game." / "If your team is behind... you cannot split." -
  https://dignitas.gg/articles/blogs/League-of-Legends/14349/split-pushing-101-an-in-depth-league-of-legends-guide (30/4-2020);
  "The threat must be live before the objective contests" - https://blog.loltheory.gg/split-push-lol/ (7/11-2026)

### Alle roller
- **Gruppér i midgame, ingen facecheck:** "prioritize being with your team"; "You do not wanna be 'that' person that is face checking brushes";
  "Taking the risk of overstaying is how most people give up their leads" -
  https://dignitas.gg/articles/macro-game-level-up-a-mid-to-late-game-league-of-legends-guide (26/3-2020)
- **Klar et minut før:** "All these details should be accounted for within about a minute before the objective spawns." -
  https://dignitas.gg/articles/blogs/League-of-Legends/14839/a-guide-on-timing-and-tracking-objectives-in-league-of-legends (27/10-2020);
  "Set up 60-90 seconds early" og vær "shoved in before Rift Herald or a Dragon spawns" -
  https://metabot.gg/en/league/guides/objectives-dragon-baron-herald-grubs (15/10-2026)
- **Recall i god tid:** at recalle 30 sek. før dragen spawner efterlader holdet med en for lidt -
  https://dignitas.gg/articles/summoner-phone-home-a-guide-to-recalls (27/6-2021)
- **Omsæt føringen:** "Kills alone don't close games" -
  https://dignitas.gg/articles/sins-of-silver-mistakes-low-elo-players-insist-on-making; plader er permanente og giver 120 g (patch 26.1).
- **Dø ikke mod flere:** tabte kampe har 2-3 flere dødsfald end vundne i alle ranks og roller - https://amitilted.com/stats/deaths;
  vision forhindrer at "potentially 4 people coming to collapse on you" (Dignitas macro-guiden ovenfor).
  Ingen kilde fundet med en fast "1v2"-regel.

## Hvad programmet måler (og hvordan)

Data: klientens kamp + timeline efter kampen (`/lol-match-history/v1/games|game-timelines/{id}`, kun GET). Timelinen har **én position
pr. minut** for hver spiller plus CHAMPION_KILL (position, drabsmand, assists), ELITE_MONSTER_KILL (monster, drabsmand, position) og
BUILDING_KILL. Gemmes kort i `review` (v4) i history.json.

**"Tæt på" = 3.000 enheder** fra stedet, i minut-billedet lige før **eller** lige efter tidspunktet (det ene ligger højst ca. 30 sek. fra).
Hvorfor 3.000: i Tobias' 51 kampe døde dragen i median ved (9.837, 4.397) og Baron ved (5.007, 10.471). Fra dragen er der ca. 3.100 enheder
til bot-lanens midterlinje og 3.850 til mid; fra Baron 3.700 til top og 3.850 til mid (programmets `LANE_LINES`). Inden for 3.000 = tættere
på pitten end på nogen lane, dvs. i floden/junglen ved pitten. Det er et kortmål, ikke en præstationsgrænse - og omtrentligt (minut-billeder).

| Råd | Målt sådan | Roller |
|---|---|---|
| Vær ved dragen | for hver drage (begge holds): i live og tæt på drabsstedet. Plus: tog holdet den med/uden dig, og var I færre end fjenden ved pitten | alle |
| Vær ved voidgrubs, Herald og Baron | samme, for voidgrubs/Herald/Baron. Voidgrubs der dør inden for 60 sek. af hinanden = ét objective | alle |
| Dø ikke lige før et objective | dine dødsfald hvor fjenden tog et stort monster, mens du stadig var død (dødstid efter League Wikis formel, se research-low-elo.md) | alle |
| Bliv ikke alene i en sidelane sent | dødsfald efter 20:00 (Baron spawner) i top- eller bot-lanen (inden for 1.300 enheder af lanens linje) uden en holdkammerat inden for 3.000 enheder i minut-billedet før eller efter | alle |
| Undgå at blive fanget 1 mod 2 | dødsfald hvor drabsmand + assists er 2 eller flere | alle |
| Roam mere | dine kills/assists før 14:00 i en anden lane end din egen (drabets position). 14 min = programmets laning-fase | mid, top, support |
| Gank lanes der kan følge op | kills/assists i en lane før 10:00, hvor du ikke selv døde inden for 30 sek. (en definition af "samme kamp"). Plus fordeling top/mid/bot | jungle |
| Omsæt din føring | i kampe hvor du var foran din lane-modstander ved 10 min (guld): tårne + store monstre dit hold tog 10:00-20:00 | alle |

**Rangering:** for hvert råd deles dine kampe (samme champion + rolle med mindst 10 kampe, ellers hele rollen) ved din egen median.
"Hænger sammen med nederlag" = sejrsandel i kampene på den gode side minus på den dårlige side (kræver 3 kampe på hver side). Et råd vises
kun, hvis dine nederlag også samlet ligger på den dårlige side (fx færre drager med dig i nederlagene), og der er mindst 3 sejre og 3 nederlag.
Op til 5 råd på kortet, 3 efter hver kamp (kun råd hvor netop den kamp lå på den dårlige side), 1 linje i champion select.
Under 10 kampe med kampgennemgang (v4) i rollen: "Spil N kampe mere med rollen".

**Kan ikke måles fra timelinen:** Teleport-brug (ingen summoner spell-events), facecheck/vision før man går ind (ingen ward-events),
tracking af fjendens jungler og lane-prio (kun én position pr. minut), recall-timing (kun omtrent).

## Tobias' egne tal (51 kampe fra klienten, 9/11-2026)

Kørt på de 51 timelines fra klienten (23 LeBlanc MID, 15 JUNGLE: Lee Sin 7, Evelynn 5, LeBlanc 3):

1. **Omsæt din føring** - foran ved 10 min: holdet tog 23 tårne/store monstre 10-20 min i 10 nederlag (2,3 pr. kamp) mod 24 i 4 sejre (6 pr. kamp).
   Under medianen (3): 0 af 6 sejre - ellers 4 af 8.
2. **Dø ikke lige før et objective** - 20 dødsfald der gav fjenden et stort monster i 16 nederlag mod 0 i 7 sejre. Over medianen: 0 af 5 sejre - ellers 7 af 18.
3. **Vær ved dragen** - ved 26 af 75 drager i nederlagene mod 13 af 25 i sejrene. Med ham ved dragen tog holdet den i 23 af 39, uden ham i 27 af 61.
4. **Undgå at blive fanget 1 mod 2** - 83 dødsfald mod 2+ i 16 nederlag (5,2 pr. kamp) mod 16 i 7 sejre (2,3 pr. kamp).
5. **Roam mere** - kills/assists i andre lanes før 14 min: 1,4 pr. kamp i nederlag mod 1,7 i sejre (svagest af de fem).

JUNGLE: **Gank lanes der kan følge op** - lykkede ganks før 10 min 1,1 pr. kamp i nederlag mod 1,6 i sejre; 10 top, 3 mid, 15 bot,
og i 8 af 28 døde han selv inden for 30 sek.

## "Se det i replayet" (v1.22.0) - kilder til endpoints (tjekket 9/11-2026)

| Hvad | Kilde |
|---|---|
| Klientens replay-endpoints og typer (configuration, rofls/path, metadata/{gameId}, rofls/{gameId}/download og /watch med `LolReplaysReplayContextData {componentType}`, metadata-states) | LCU `/help?format=Full` fra Tobias' klient (patch 16.22.834.8910), kun GET |
| `componentType: "replay-button_match-history"` | LeagueAkari (`src/shared/http-api-axios-helper/league-client/replays.ts`), dysolix/hasagi-core (`docs/Common-Endpoints.md`), wooto/lol-replay-recorder |
| Metadata giver 404 før download; `downloadProgress` er ikke altid en procent; `watch` starter spillet og `isPlayingReplay` bliver `true` | github.com/wnzzer/rank-analysis, `docs/superpowers/specs/2026-07-27-match-replay-design.md` (målt på en rigtig klient 16.14) |
| Replay API: slået fra som standard, `[General] EnableReplayApi=1` i game.cfg, `GET /replay/game`, `GET/POST /replay/playback` | https://developer.riotgames.com/docs/lol#game-client-api_replay-api |
| Felterne `time`, `paused`, `speed`, `length`, `seeking` i `/replay/playback` | Riots League Director: https://github.com/RiotGames/leaguedirector (`leaguedirector/api.py`) |

Tobias' game.cfg (9/11-2026) har allerede linjen `EnableReplayApi=0` under `[General]`. Ikke verificeret mod en rigtig klient:
POST download/watch (ikke kørt på hans pc), at `/replay/playback` `time` er kamptid i sekunder som timelinens, og at spillet
beholder `EnableReplayApi=1` når det selv skriver game.cfg.
