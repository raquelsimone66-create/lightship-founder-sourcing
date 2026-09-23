/* Loads a snapshot of real desk data (pass its folder as DATA=...) into the
   page in local mode, visits every view, opens every company, cycles the
   theme and checks phone width, and reports any page error, any "undefined"
   or "NaN" that reaches the screen, and any sideways scroll.
   Run: DATA=path/to/snapshot NODE_PATH=/opt/node22/lib/node_modules node test/sweep.js */
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', 'src');
const DATA = process.env.DATA;
const load = c => { const d = path.join(DATA, c); return fs.existsSync(d) ? fs.readdirSync(d).map(f => Object.assign({ id: f.replace(/\.json$/, '') }, JSON.parse(fs.readFileSync(path.join(d, f))))) : []; };
const snap = {}; ['companies', 'contacts', 'sources', 'runs', 'intake', 'settings'].forEach(c => snap[c] = load(c));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/index.html') body = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[hidden]{display:none!important}body{margin:0}</style></head><body>' + body + '</body></html>');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); res.end(body);
});
(async () => {
  await new Promise(r => server.listen(8097, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const problems = [];
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: scheme });
    page.on('pageerror', e => problems.push(scheme + ' PAGEERROR ' + e));
    page.on('console', m => { if (m.type() === 'error' && !/net::|404|fonts/.test(m.text())) problems.push(scheme + ' console ' + m.text()); });
    await page.addInitScript(s => { for (const k in s) localStorage.setItem('leaddesk.v1.' + k, JSON.stringify(s[k])); window.claude = { use: () => Promise.resolve(null) }; }, snap);
    await page.goto('http://127.0.0.1:8097/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.pulse');
    const bad = async where => {
      const t = await page.evaluate(() => document.body.innerText);
      const m = t.match(/.{0,40}\b(undefined|NaN|\[object Object\]|null)\b.{0,40}/);
      if (m) problems.push(scheme + ' ' + where + ' shows: ' + m[0].replace(/\s+/g, ' '));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (wide) problems.push(scheme + ' ' + where + ' scrolls sideways');
    };
    for (const v of ['today', 'companies', 'performance', 'sources', 'settings']) {
      await page.click('[data-act="nav"][data-view="' + v + '"]'); await page.waitForTimeout(60); await bad(v);
    }
    /* every company sheet */
    await page.click('[data-act="nav"][data-view="companies"]');
    const ids = await page.$$eval('tr.click[data-id]', els => els.map(e => e.getAttribute('data-id')));
    for (const id of ids) {
      await page.click('tr.click[data-id="' + id + '"]');
      await page.waitForSelector('#sheet:not([hidden]) .sheet-body');
      await bad('sheet ' + id);
      await page.click('#sheet [data-act="close"]');
    }
    /* each filter option, to make sure none throws */
    for (const sel of ['#f-region', '#f-owner', '#f-rev', '#f-grant', '#f-contact', '#f-review', '#f-mix', '#f-age', '#f-src', '#f-fresh', '#f-out']) {
      const vals = await page.$$eval(sel + ' option', os => os.map(o => o.value));
      for (const v of vals) { await page.selectOption(sel, v); await page.waitForTimeout(20); }
      await page.selectOption(sel, '');
    }
    /* theme cycles and sticks */
    await page.click('#btn-theme'); const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#btn-theme'); const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (t1 !== 'light' || t2 !== 'dark') problems.push(scheme + ' theme cycle gave ' + t1 + ',' + t2);
    await page.click('#btn-theme');
    /* phone width */
    await page.setViewportSize({ width: 390, height: 844 });
    for (const v of ['today', 'companies', 'performance', 'sources', 'settings']) {
      await page.click('[data-act="nav"][data-view="' + v + '"]'); await page.waitForTimeout(60); await bad('phone ' + v);
    }
    await page.click('[data-act="nav"][data-view="today"]');
    if (scheme === 'light') await page.screenshot({ path: process.env.SHOT_PHONE || '/tmp/sweep-phone.png' });
    await page.setViewportSize({ width: 1360, height: 900 });
    if (scheme === 'dark') { await page.click('[data-act="nav"][data-view="companies"]'); await page.screenshot({ path: process.env.SHOT_DESK || '/tmp/sweep-desk.png' }); }
    console.log(scheme + ': ' + ids.length + ' company sheets opened');
    await page.close();
  }
  await browser.close(); server.close();
  if (problems.length) { console.log('PROBLEMS\n' + Array.from(new Set(problems)).join('\n')); process.exit(1); }
  console.log('sweep clean');
})().catch(e => { console.error(e); server.close(); process.exit(1); });
