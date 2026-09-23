/* Drives the Lead Desk through its real clicks with Airtable and Claude
   stubbed: add a source, paste a table, catch a duplicate, approve, send to
   Airtable, read outreach back, and make sure an opt-out suppresses the
   company on the next import. Reports any page error.
   Run: node test/flow.js   (needs global playwright) */
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/index.html') body = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[hidden]{display:none!important}body{margin:0}</style></head><body>' + body + '</body></html>');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' });
  res.end(body);
});

(async () => {
  await new Promise(r => server.listen(8098, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e));
  page.on('console', m => { if (m.type() === 'error' && !/net::|404|favicon|fonts/.test(m.text())) errors.push('console ' + m.text()); });

  await page.addInitScript(() => {
    /* Airtable, with the shapes list_tables_for_base returned for the real base */
    const F = (names) => names.map((n, i) => ({ id: 'fld' + (n.replace(/\W/g, '') + 'xxxxxxxxxxxxxx').slice(0, 14), name: n }));
    const CO = F(['External ID', 'Company', 'Domain', 'Website', 'City', 'Region', 'Industry', 'Description', 'Customer mix', 'Bootcamp priority', 'Priority confidence', 'Priority reasons', 'Grant pre-screen', 'Grant checklist', 'Source links', 'Discovered', 'Verified', 'Approved by', 'Outreach status', 'Outreach owner', 'First contact date', 'Channel', 'Next follow-up', 'Replied', 'Applied', 'Attended', 'Do not contact', 'Grant referral', 'Last synced']);
    const CT = F(['External ID', 'Name', 'Company External ID', 'Company', 'Role', 'Decision maker', 'Email', 'Email verified', 'Phone', 'Phone verified', 'LinkedIn', 'Sources', 'Do not contact']);
    const tables = { tables: [{ id: 'tbloCsATWhWShKQqP', name: 'Companies', fields: CO }, { id: 'tblybeD6fmRaHMpzK', name: 'Contacts', fields: CT }] };
    const rows = { tbloCsATWhWShKQqP: {}, tblybeD6fmRaHMpzK: {} };
    let n = 0;
    window.__at = { rows, calls: [] };
    const mcp = {
      callTool: (server, tool, input) => {
        window.__at.calls.push(tool);
        if (tool === 'list_tables_for_base') return Promise.resolve({ payload: tables });
        if (tool === 'update_records_for_table') {
          const ext = input.performUpsert.fieldIdsToMergeOn[0];
          const recs = input.records.map(r => {
            const key = r.fields[ext];
            const t = rows[input.tableId];
            if (!t[key]) t[key] = { id: 'rec' + String(++n).padStart(14, '0'), fields: {} };
            Object.assign(t[key].fields, r.fields);
            return { id: t[key].id, fields: { [ext]: key } };
          });
          return Promise.resolve({ payload: { records: recs } });
        }
        if (tool === 'list_records_for_table') {
          const t = rows[input.tableId];
          return Promise.resolve({ payload: { records: Object.values(t).map(r => ({ id: r.id, fields: r.fields })) } });
        }
        return Promise.reject({ code: 'tool_error', message: 'unexpected ' + tool });
      }
    };
    window.claude = { use: (name) => Promise.resolve(name === 'mcp' ? mcp : null) };
  });

  await page.goto('http://127.0.0.1:8098/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.pulse');

  /* a source */
  await page.click('[data-act="nav"][data-view="sources"]');
  await page.click('.view-head [data-act="open-source"]');
  await page.fill('#src-name', 'Greater Cleveland member directory');
  await page.fill('#src-url', 'https://example.org/members');
  await page.selectOption('#src-type', 'Chamber of commerce');
  await page.selectOption('#src-city', 'Cleveland');
  await page.selectOption('#src-status', 'Approved');
  await page.click('[data-act="save-source"]');
  await page.waitForSelector('table.data');

  /* a paste with a duplicate inside it */
  await page.click('.top-actions [data-act="open-import"]');
  await page.selectOption('#imp-src', { label: 'Greater Cleveland member directory · Cleveland' });
  await page.fill('#imp-text', [
    'Company,Website,City,Owner,Title,Email,Founded,Employees',
    'Acme Fabrication LLC,acme-fab.example,Cleveland,Dana Reed,Owner,dana@acme-fab.example,2019,12',
    'Acme Fab,https://www.acme-fab.example,Lakewood,,,,,',
    'Quiet Bakery,quiet.example,Akron,Sam Lee,Founder,sam@quiet.example,2021,4'
  ].join('\n'));
  await page.click('[data-act="imp-preview"]');
  await page.waitForSelector('[data-act="imp-commit"]');
  const preview = await page.textContent('.sheet-body');
  assert.ok(/2 new · 1 already known/.test(preview), 'preview counts: ' + preview.slice(0, 400));
  await page.click('[data-act="imp-commit"]');
  await page.waitForSelector('.leads .lead');
  assert.strictEqual(await page.locator('.leads .lead').count(), 2);

  /* approve the top lead and send it */
  await page.click('.leads .lead >> nth=0');
  await page.waitForSelector('[data-act="approve"]');
  const title = await page.textContent('#sheet-title');
  await page.click('[data-act="approve"]');
  await page.waitForSelector('[data-act="sync-one"]');
  await page.click('[data-act="sync-one"]');
  await page.waitForFunction(() => /In Airtable since/.test(document.querySelector('.sheet-body').textContent));
  let at = await page.evaluate(() => window.__at.rows);
  const coRows = Object.values(at.tbloCsATWhWShKQqP);
  assert.strictEqual(coRows.length, 1, 'one company row');
  assert.strictEqual(Object.values(at.tblybeD6fmRaHMpzK).length, 1, 'one contact row');

  /* sending again updates the same row */
  await page.click('[data-act="sync-one"]');
  await page.waitForTimeout(300);
  at = await page.evaluate(() => window.__at.rows);
  assert.strictEqual(Object.values(at.tbloCsATWhWShKQqP).length, 1, 'no duplicate on resend');

  /* the team contacts them, then they opt out, in Airtable */
  /* field ids in the stub are derived from names; set them by name via the same rule */
  await page.evaluate(() => {
    const r = Object.values(window.__at.rows.tbloCsATWhWShKQqP)[0];
    const fid = n => 'fld' + (n.replace(/\W/g, '') + 'xxxxxxxxxxxxxx').slice(0, 14);
    r.fields[fid('Outreach status')] = { name: 'Opted out' };
    r.fields[fid('First contact date')] = new Date().toISOString().slice(0, 10);
  });
  await page.click('[data-act="close"]');
  await page.click('[data-act="readback"]');
  await page.waitForFunction(() => /Outreach read/.test(document.getElementById('toast').textContent));
  await page.click('[data-act="nav"][data-view="settings"]');
  const sup = await page.textContent('main');
  assert.ok(/Opted out in Airtable/.test(sup), 'opt-out joined the suppression list');

  /* the same company listed again is never re-queued */
  await page.click('.top-actions [data-act="open-import"]');
  await page.click('[data-act="imp-method"][data-m="one"]');
  await page.fill('#one-name', title.trim());
  await page.fill('#one-web', 'acme-fab.example');
  await page.click('[data-act="imp-one"]');
  await page.waitForSelector('[data-act="imp-commit"]');
  const p2 = await page.textContent('.sheet-body');
  assert.ok(/0 new/.test(p2), 'rediscovered company is not new: ' + p2.slice(0, 300));
  await page.click('[data-act="close"]');

  /* every view renders */
  for (const v of ['today', 'companies', 'performance', 'sources', 'settings']) {
    await page.click('[data-act="nav"][data-view="' + v + '"]');
    await page.waitForTimeout(80);
  }
  await page.click('[data-act="nav"][data-view="companies"]');
  await page.click('table.data tr.click >> nth=0');
  await page.click('[data-act="edit"][data-field="industry"]');
  await page.fill('#ed-v', 'Precision machining');
  await page.click('[data-act="save-fact"]');
  await page.waitForFunction(() => /Precision machining/.test(document.querySelector('.sheet-body').textContent));
  await page.screenshot({ path: process.env.SHOT || '/tmp/leaddesk.png', fullPage: false });

  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('[data-act="close"]');
  await page.click('[data-act="nav"][data-view="today"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.ok(!overflow, 'no sideways scroll at phone width');

  await browser.close(); server.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('sourcing flow ok');
})().catch(e => { console.error(e); server.close(); process.exit(1); });
