'use strict';
// Tobias' to rigtige kampe 9/11-2026 (LeBlanc) med OBS-klip, og filerne i C:\Users\tobia\Videos (navn + mtime i UTC).
// Filnavnet er OBS' standard "Replay %CCYY-%MM-%DD %hh-%mm-%ss" i lokal tid (CET), mtime ca. 0-1 sek. senere.
// start = klientens gameCreation, dur = gameDuration (sek.), deaths = dødsfald i klientens timeline (sek.),
// live = dødsfald fra live-API'et + det klip programmet selv koblede under kampen (facit).
module.exports = {
  games: [
  {
    "date": "2026-11-09T13:53:47.454Z",
    "champion": "LeBlanc",
    "result": "Sejr",
    "duration": 2018,
    "start": 1794230368044,
    "dur": 2017,
    "deaths": [ 532, 646, 843, 1043, 1159, 1344, 1503, 1658, 1733, 1854 ],
    "live": [ [ 532.3, "Replay 2026-11-09 14-28-57.mp4" ], [ 646.5, "Replay 2026-11-09 14-30-52.mp4" ], [ 842.7, "Replay 2026-11-09 14-34-08.mp4" ], [ 1043.1, "Replay 2026-11-09 14-37-28.mp4" ], [ 1159.2, "Replay 2026-11-09 14-39-23.mp4" ], [ 1343.6, "Replay 2026-11-09 14-42-29.mp4" ], [ 1502.7, "Replay 2026-11-09 14-45-07.mp4" ], [ 1658.1, "Replay 2026-11-09 14-47-42.mp4" ], [ 1733.4, "Replay 2026-11-09 14-48-59.mp4" ], [ 1853.6, "Replay 2026-11-09 14-50-58.mp4" ] ]
  },
  {
    "date": "2026-11-09T15:10:38.288Z",
    "champion": "LeBlanc",
    "result": "Nederlag",
    "duration": 1917,
    "start": 1794235012052,
    "dur": 1916,
    "deaths": [ 866, 936, 1062, 1231, 1332, 1818, 1901 ],
    "live": [ [ 866, "Replay 2026-11-09 15-53-02.mp4" ], [ 936.1, "Replay 2026-11-09 15-54-13.mp4" ], [ 1062.4, "Replay 2026-11-09 15-56-18.mp4" ], [ 1231.3, "Replay 2026-11-09 15-59-07.mp4" ], [ 1332, "Replay 2026-11-09 16-00-48.mp4" ], [ 1817.9, "Replay 2026-11-09 16-08-53.mp4" ], [ 1900.6, "Replay 2026-11-09 16-10-16.mp4" ] ]
  }
],
  files: [
    { name: "Replay 2026-11-09 14-28-57.mp4", mtime: "2026-11-09T13:28:58.0855991Z" },
    { name: "Replay 2026-11-09 14-30-52.mp4", mtime: "2026-11-09T13:30:52.9442727Z" },
    { name: "Replay 2026-11-09 14-34-08.mp4", mtime: "2026-11-09T13:34:08.5864625Z" },
    { name: "Replay 2026-11-09 14-37-28.mp4", mtime: "2026-11-09T13:37:28.9406017Z" },
    { name: "Replay 2026-11-09 14-39-23.mp4", mtime: "2026-11-09T13:39:24.0153231Z" },
    { name: "Replay 2026-11-09 14-42-29.mp4", mtime: "2026-11-09T13:42:29.8587813Z" },
    { name: "Replay 2026-11-09 14-45-07.mp4", mtime: "2026-11-09T13:45:07.3385998Z" },
    { name: "Replay 2026-11-09 14-47-42.mp4", mtime: "2026-11-09T13:47:42.8684036Z" },
    { name: "Replay 2026-11-09 14-48-59.mp4", mtime: "2026-11-09T13:48:59.6359418Z" },
    { name: "Replay 2026-11-09 14-50-58.mp4", mtime: "2026-11-09T13:50:58.8709139Z" },
    { name: "Replay 2026-11-09 15-53-02.mp4", mtime: "2026-11-09T14:53:02.7568594Z" },
    { name: "Replay 2026-11-09 15-54-13.mp4", mtime: "2026-11-09T14:54:13.3134324Z" },
    { name: "Replay 2026-11-09 15-56-18.mp4", mtime: "2026-11-09T14:56:18.4939440Z" },
    { name: "Replay 2026-11-09 15-59-07.mp4", mtime: "2026-11-09T14:59:08.1432498Z" },
    { name: "Replay 2026-11-09 16-00-48.mp4", mtime: "2026-11-09T15:00:49.1834368Z" },
    { name: "Replay 2026-11-09 16-08-53.mp4", mtime: "2026-11-09T15:08:54.1137471Z" },
    { name: "Replay 2026-11-09 16-10-16.mp4", mtime: "2026-11-09T15:10:17.0531568Z" },
  ],
};
