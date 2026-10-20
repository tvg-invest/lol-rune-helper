'use strict';
// Åbner vinduet i headless Chrome (ren profil), tjekker at alle billeder er indlæst og gemmer et screenshot.
// Brug: node test/screenshot.js <url> [fil.png] [bredde] [højde]
// Sammen med testen: HOLD_LIVE=25000 node test/fake-lcu.test.js  (og brug URL'en fra "HOLD ..." linjen)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [url, file = 'screenshot.png', width = '1100', height = '1150'] = process.argv.slice(2);
const CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-helper-shot-'));
const PORT = 9333;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, url]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await wait(2500);
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const call = (method, params) => new Promise((resolve) => {
      const myId = ++id;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result); }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
    await call('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: Number(width) < 600 });
    await wait(4000);
    const r = await call('Runtime.evaluate', {
      expression: 'JSON.stringify([...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src))',
      returnByValue: true,
    });
    const broken = JSON.parse(r.result.value);
    console.log(broken.length ? `Ikke indlæst: ${broken.join(', ')}` : 'Alle billeder indlæst.');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`Gemt: ${path.resolve(file)}`);
    ws.close();
  } finally {
    chrome.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
  }
})();
