# Hvorfor klatrer man ikke i low elo? (research til Klatre-tjek, nov. 2026)

Grundlaget for "Klatre-tjek" i LoL Rune Helper (v1.20.0). Hvert punkt har kilder med tal, hvor det fandtes.
Alle tal er **sammenhænge** (kampe man vinder har færre dødsfald osv.) - ikke bevis for årsag.

Kilder der ikke kunne hentes (HTTP 403 eller blokeret): Mobalytics, Blitz, League of Graphs, Reddit.
Tal fra dem er derfor ikke brugt.

Dobbelttjekket direkte på siden (9/11-2026): amitilted deaths/cs-per-minute/control-wards/vision-score, begge iTero-artikler,
UCLA-rapporten, Dignitas-citatet og League Wikis dødstid. Senseos, Do et al., Deng et al., Dupourque, Probuilds og
amitilted kill-participation er hentet én gang under researchen, men ikke dobbelttjekket - programmet viser ingen tal fra dem.

## Hoveddatasæt

**amitilted.com** - 65.569 spiller-kampe i 6.557 ranked solo-kampe, Nordamerika (na1), patch 25.24-26.20,
"Updated October 2026". Det eneste fundne datasæt der deler tallene op pr. rank, rolle og sejr/nederlag.
Kun én region, og Iron-Gold har kun 376-484 kampe pr. rolle. https://amitilted.com/stats

## De 8 største fejl (sorteret efter hvor stærk evidensen er)

### 1. For mange dødsfald (overextend, facecheck, dårlige dives)
- Hvorfor: hvert dødsfald giver fjenden guld og koster dig tid på kortet (minions, objectives).
- Tal: "Of every stat on these pages, deaths and gold per minute separate wins from losses the most."
  Tabte kampe har 2-3 flere dødsfald end vundne i alle ranks og roller. Gold MID: 5,0 i sejre mod 7,8 i nederlag;
  Gold jungle 4,7 mod 7,8; Iron MID 5,2 mod 7,4. https://amitilted.com/stats/deaths
- 9.879 Diamond-kampe ved 10 min: dødsfald korrelerer -0,339 med sejr. https://astro-wen.github.io/UCLA_C111_LoL/report.html
- Evidens: stærk (konsistent på tværs af kilder).

### 2. Føring der ikke bliver omsat (lane-føring -> intet tårn/objective)
- Hvorfor: guld bliver først til sejre, når det bliver til items, tårne og objectives.
- Tal: guldforskel ved 10 min er den stærkeste enkeltfaktor (r = 0,511) i 9.879 Diamond-kampe; hold i den laveste
  femtedel vandt 13,6 %, den højeste 87,0 %. https://astro-wen.github.io/UCLA_C111_LoL/report.html
- Dignitas "Sins of Silver" (Lynari): "Kills alone don't close games; you haven't begun to put the game away until at least
  an inhibitor is down." https://dignitas.gg/articles/sins-of-silver-mistakes-low-elo-players-insist-on-making
- Ikke fundet: hvor ofte low elo-spillere omsætter en føring (ingen kilde pr. rank).
- Evidens: stærk for at guld forudsiger sejr; "omsætning" i low elo er ikke målt af nogen kilde.

### 3. Dårlig farm, især efter lanen
- Hvorfor: minions er den stabile guldkilde.
- Tal (amitilted, typisk CS/min): MID Iron 5,4 - Bronze 5,7 - Silver 6,2 - Gold 6,6 - Plat 7,0.
  Højere i vundne end tabte kampe i alle roller undtagen support (Gold MID 6,8 mod 6,4; Gold jungle 7,0 mod 6,0).
  https://amitilted.com/stats/cs-per-minute
- Krydstjek (senseos, 20.793 kampe, 15 regioner, alle roller): Iron 4,91 - Bronze 5,11 - Silver 5,38 - Gold 5,57.
  https://senseos.gg/guides/league-of-legends/cs-kda-and-game-length-by-rank/
- Evidens: stærk for at CS stiger med rank. "9-10 CS/min" er et coach-mål, ikke et målt snit.

### 4. Champions du ikke kender (for stor pulje, første kampe i ranked)
- Tal: iTero, lidt over 1.000.000 solo queue-kampe omkring Gold (patch 13.7, 24/4-2023): win rate krydser 50 % ved ca.
  12.000 mastery = ca. 20 kampe; under 10.000 mastery ca. 44 %. https://itero.gg/articles/mastery-a-statistical-summary
- Do et al. (FDG 2021): champion-erfaring alene forudsiger udfaldet med 75,1 % træfsikkerhed. https://arxiv.org/abs/2108.02799
- Evidens: stærk for de første ca. 20 kampe; derefter lille gevinst.

### 5. Tilt: at køe igen lige efter tab
- Tal: iTero (100.000+ kampe via Riot API, 28/5-2020): 48,8 % win rate efter 2 tab i træk; Gold-spillere der køer igen med
  det samme har "by far the lowest win rate"; en kort pause gav mere end 3 % over snittet. https://www.itero.gg/articles/lol-tilt
- Deng et al. (CHI PLAY 2024, 597.680 kampe fra topspillere): tabsstimer hænger sammen med lavere præstation (lille effekt);
  længere pauser efter tab forbedrede præstationen lidt.
  https://scholars.hkbu.edu.hk/en/publications/streaks-and-coping-decoding-player-performance-in-league-of-legen/
- Dupourque: 49,40 % efter et tab mod 50,12 % efter en sejr. https://sdupourque.me/leagueProject/loserQ/true_data
- Evidens: moderat - effekten er reel men lille (ca. 0,6-3 procentpoint).

### 6. Svag vision og for få Control Wards
- Tal (amitilted, Control Wards pr. kamp): jungle Iron 0,5 - Gold 1,1; support Iron 1,3 - Gold 3,1; top/mid/ADC 0,2-0,6 i alle ranks.
  https://amitilted.com/stats/control-wards
- Vision score/min (typisk): MID Iron 0,53 - Gold 0,68; jungle 0,70 - 0,85; support 1,55 - 2,23. Forskellen mellem sejre og
  nederlag er lille (Gold MID 0,74 mod 0,65). https://amitilted.com/stats/vision-score
- Evidens: moderat som rank-markør, svag som direkte årsag til sejr i den enkelte kamp.

### 7. Objectives (drage, Herald, Baron, tårne) - og at være død når de bliver taget
- Tal: 9.879 Diamond-kampe ved 10 min: en drage 64,1 % sejre mod 41,9 % uden; Herald 59,5 % mod 47,7 %.
  https://astro-wen.github.io/UCLA_C111_LoL/report.html
- Probuilds (uden datasæt/rank/dato): First Baron 82,8 %, First Tower 70,4 %, First Dragon 61,8 %. https://probuilds.net/news/objective-win-rates
- Evidens: moderat på retningen; ingen verificerbar low elo-tabel.

### 8. At jagte kills i stedet for objectives
- Tal: kill participation er næsten ens i sejre og nederlag (Gold MID 43 % mod 40 %). https://amitilted.com/stats/kill-participation
- Evidens: moderat.

### Ikke målbare / ingen tal fundet
Minimap- og jungle-tracking, recall-timing, positionering i teamfights og "ARAM mid": kun coach-meninger, ingen tal.

## Hvad programmet måler (og hvordan)

Data: klientens kamp + timeline efter kampen (`/lol-match-history/v1/games|game-timelines/{id}`), klientens kamphistorik
(`/lol-match-history/v1/products/lol/current-summoner/matches`), mastery og (ikke verificeret form) ranked-stats.
Alt er kun GET. Skillelinjen er altid din egen median - ingen faste tærskler.

| Fejl | Målt sådan | Hvor |
|---|---|---|
| 1 Dødsfald | dødsfald før 14 min; dødsfald mod 2+ fjender (killer + assists i CHAMPION_KILL); dødsfald pr. 10 min i hver fase | kampgennemgang, Klatre-tjek |
| 2 Føring ikke omsat | foran mod lane-modstanderen ved 10 min (totalGold) men holdet bagud ved 20 min | kampgennemgang, Klatre-tjek, champion select |
| 3 Farm | CS/min fra 14 til 25 min (participantFrames minions + jungle) + CS/min mod kildens tal pr. rank | kampgennemgang, Klatre-tjek |
| 4 Champion-erfaring | mastery-point på den låste champion (under 12.000 = iTeros grænse); pulje og sejre i de sidste 20 kampe | champion select, Klatre-tjek |
| 5 Tilt | sejre efter 0/1/2/3+ tab i træk, kamp nr. i sessionen, tidspunkt; tilt-vagt efter 2 tab i træk (kilden) eller dit eget tal | lobby, champion select |
| 6 Vision | visionScore pr. min og visionWardsBoughtInGame (kampens stats) mod din median og kilden | kampgennemgang, Klatre-tjek |
| 7 Objectives | fjendens drager/voidgrubs/Herald/Baron/tårne/inhibitorer taget mens du var død (dødstid efter League Wikis formel) | kampgennemgang, Klatre-tjek |
| 8 Kill-jagt | ikke målt som eget punkt (ingen tydelig forskel i kilden) | - |

Dødstid: BRW pr. level (10, 10, 12, 12, 14, 16, 20, 25, 28, 32,5, 35, 37,5, 40, 42,5, 45, 47,5, 50, 52,5 sek.) + BRW x TIF
efter 15 min, loft 50 %. https://wiki.leagueoflegends.com/en-us/Death

"I træk" = næste kamp startede senest 45 min efter den forrige sluttede (en definition, ikke en præstationsgrænse).

## Tobias' egne data (35 kampe i history.json + 51 kampe i klientens liste, 9/11-2026)

- LeBlanc/MID (15 kampe med gennemgang): foran i lanen ved 10 min i 13 af 15 - vandt 5 af de 13. I 6 af dem var holdet
  bagud ved 20 min (0 sejre). Holdet bagud ved 20 min i alt: 0 af 8 sejre.
- Dødsfald pr. 10 min (MID): 1,6 tidligt - 2,6 midt - 3,3 sent. 66 af 102 dødsfald var mod 2 eller flere fjender.
- Mest "dyre" i MID: dødsfald mod 2+ over medianen (4): 0 af 7 sejre mod 5 af 8; fjendens objectives mens død over
  medianen (5): 0 af 6 mod 5 af 9.
- Tilt: efter 2 tab i træk 4 af 7 sejre (efter 0 tab: 7 af 28) - hans egne kampe viser ikke et fald, så vagten bruger kildens tal.
