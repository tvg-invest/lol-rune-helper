# Research: funktioner til Tryndamere (top) og Evelynn (jungle)

Researchet 2026-10-20, patch 26.20 (OP.GG kalder den "16.20"). Tre spor: datakilder, spillestil, Riots regler.
Markeret **(verificeret)** = hentet/læst direkte i dag. **(antaget)** = ikke bekræftet.

## 1. Datakilder

| Kilde | Hvad den giver | Status |
|---|---|---|
| OP.GG champion-endpoint (bruges allerede) | Builds, runer, skills, `game_lengths` (WR ved 0/25/30/35/40 min), `counters` (58 matchups for Trynd) | **(verificeret)** Trynd top 17.606 kampe, Eve jungle 14.976 (Emerald+). Intet jungle-specifikt. |
| OP.GG `?target_champion=` | Runer/items/skills kun fra kampe mod den champion | **(verificeret)** men tyndt: Trynd vs Darius 425 kampe, top-core kun 33. `summary`/`game_lengths`/`counters` er IKKE matchup-specifikke. |
| OP.GG MCP `https://mcp-api.op.gg/mcp`, værktøj `lol_get_lane_matchup_guide` | Tip-tekst mod modstanderen, `lane_advantage_champion`, `lane_solo_kill_advantage_champion`, `recommended_play_style`, matchup-builds | **(verificeret)** gratis, ingen nøgle, 200. Udokumenteret/uofficiel brug - kan ændre sig. Engelsk tekst. Alle tiers. |
| OP.GG jungle-paths-side `op.gg/lol/champions/evelynn/jungle-paths/jungle` | Camp-rækkefølge pr. side: `{team_key, routes:[{route:[6 camps], play}]}` | **(verificeret)** indlejret i HTML (Next.js), ingen JSON-API fundet. Blå side top: Gromp-Wolves-Raptors-Red-Krug (16.493 kampe). Kun full clear, ingen WR/tider. Region/tier uklar. |
| Riot match-v5 timeline | Position pr. frame + jungle-CS → kan rekonstruere ruter og gank-tider fra master+ Evelynn-kampe | Kun docs **(verificeret)**; kræver Riot API-nøgle (personlig: 100 kald / 2 min). Frame-interval 60 s **(antaget)**. Grovkornet. |
| Live Client Data API (port 2999) | Eget: level, guld, evne-levels, `championStats` (AD, crit, Fury via `resourceValue`). Alle: items inkl. trinket, level, KDA, CS, død/respawn | **(verificeret)** fra Riots eksempel. Ingen positioner, ingen fjendtlige cooldowns/guld. |
| u.gg, mobalytics, leagueofgraphs | - | 403 (Cloudflare). Ikke brugbare. |

## 2. Spillestil (kort)

**Tryndamere top**
- Build (OP.GG): Ravenous Hydra → Phantom Dancer → Infinity Edge, Berserker's, Doran's Bow. Runer: Lethal Tempo og Hail of Blades skiftes om førstepladsen afhængigt af kilde/tier.
- Power spikes: lvl 2-3 (E+Q all-in), lvl 6 (R → dives), Hydra (waveclear/split), IE (crit).
- Sværeste matchups (Trynd WR): Teemo 42,6 %, Malphite 43,4 %, Kennen ~44 %, Nasus ~45 %, Quinn ~45 %, Jax 45,8 %. Nemme: Malzahar, Illaoi, Irelia, Gangplank, Gwen.
- Patch: buffs 26.1/26.3/26.6. En nævnt 26.17-nerf kunne ikke bekræftes **(antaget)**.

**Evelynn jungle**
- Build: Dark Seal → Lich Bane/Rocketbelt → Rabadon's/Mejai's, Sorcerer's, Electrocute.
- Camps spawner 0:55 siden 26.1 (Gromp/Krugs 1:07, scuttle 2:55). Full clear ca. 3:07 (Skill-Capped), recall for Dark Seal, mod level 6.
- Svag før 6; level 6 = camouflage + R → gank isolerede mål. Hårde: Skarner (42 %), Rek'Sai, Pantheon, Gragas, Trundle; Lee/Elise/Rengar invaderer. Control wards/Oracle/Scryer's Bloom afslører hende.

## 3. Riots regler pr. idé

| Idé | Vurdering | Grundlag |
|---|---|---|
| Matchup-tips i champion select | Tilladt | "Game overlays that provide static data that is available prior to the game." |
| Evelynn-rute i champion select (2-3 valg) | Tilladt | Statisk, før kampen; flere valg = "increase diversity of game decisions" |
| Stemme om egen tilstand ("Level 6", "Hydra færdig") | Tilladt (lille gråzone) | Egen data spillet allerede viser; formuler som fakta |
| Stemme/alarm om fjendens synlige items ("Oracle Lens") | Gråzone, hælder til tilladt | Synligt på TAB, men tæt på "Drawing conclusions for you during gameplay" - kun ren fakta, slå til selv |
| Drage/baron-timere | Gråzone | Globalt annonceret; ikke forbudt |
| Jungle camp-timere (fjendens) | Risikabelt | "previously unknown" info |
| Fjendens ultimate-cooldowns | **Forbudt** siden 13. marts 2025 | "automatically or manually allowing tracking enemy ultimate cooldowns" |
| Gank-forslag ud fra fjendens liv/position | Ikke muligt/ikke tilladt | Data findes ikke i API'et |
| AI-tips under kampen | Gråzone→ikke tilladt | "Apps that dictate player decisions"; brug AI før/efter kampen |
| Registrering | Påkrævet | "All products must be registered in, and audited by Riot Games through the Developer Portal" |

**Konsekvens for det eksisterende program:** live-købsforslagene bygger på fjendens items/kills ("Zed er fed ... laver AD-skade"). Det er tæt på "Drawing conclusions for you during gameplay". Anbefaling: formuler som fakta + valg (det gør vi delvist), og overvej at gøre live-forslag og stemme om fjender til noget man selv slår til.

## 4. Anbefalede funktioner (prioriteret)

1. **Matchup-kort i champion select** (Trynd: lane-modstander; Eve: fjendens jungler). WR, lane-fordel og solo-kill-fordel, OP.GG's tip-tekst (MCP), matchup-runer/start-items med antal kampe, og hvem der er stærkest tidligt/sent (`game_lengths` for begge champions). Gratis.
2. **Evelynn rute-kort** (champion select): top 2-3 ruter pr. side fra OP.GG jungle-paths, mål for clear-tid ~3:07, scuttle 2:55, recall til Dark Seal. Efter kampen: din jungle-CS ved 3:30 vs mål.
3. **Evelynn "Level 6 - camouflage klar"** (stemme, egen tilstand).
4. **Tryndamere power spikes** (stemme): "Hydra færdig - split-push", "Infinity Edge færdig". Egen tilstand.
5. **"Fjenden har Oracle Lens / control wards"** for Evelynn - kun ren fakta, slås til af brugeren.
6. **Tryndamere mod armor-stackere**: findes allerede (armor pen-forslag); finjuster til Lord Dominik's/Mortal Reminder.
7. **AI-tips (valgfri, koster penge)**: kun før/efter kampen, bygget på OP.GG-tekst + tal. Claude Haiku 5.5 ($0,10/$0,50 pr. mio. tokens): ca. $0,10 for ~100 matchups; Opus 5.5 ($4/$20): ca. $3. Caches pr. patch. Sandsynligvis unødvendig, da OP.GG's MCP allerede giver tip-tekst gratis.

**Fravalgt:** camp-timere, fjendens cooldowns, gank-forslag ud fra position, AI-tips under kampen.

**Risici:** OP.GG's MCP og jungle-paths-side er uofficielle og kan ændre sig uden varsel (byg med tavs fallback). OP.GG's vilkår for brug af MCP/side er ikke undersøgt.

## Kilder
- Riot: developer.riotgames.com/policies/general, developer.riotgames.com/docs/lol, support.riotgames.com (Third-party applications; Game Memory Access Removed 2026-09-29), x.com/RiotGamesDevRel (ult-timer-forbud 2025-03-13)
- OP.GG: champion-endpoint, mcp-api.op.gg/mcp, op.gg/lol/champions/evelynn/jungle-paths/jungle, op.gg build-sider
- riftpatchnotes.com (Tryndamere, Evelynn, jungle), metabot.gg, skill-capped.com, dodge.gg, mobalytics.gg
