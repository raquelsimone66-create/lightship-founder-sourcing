/* The Lead Desk's rules, without a page: matching, merging, protection of
   human edits, suppression, both scores and the Airtable mapping.
   Run: node test/core.js */
const assert = require('assert');
const LD = require('../src/core.js');

const NOW = new Date('2026-09-23T12:00:00');
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

t('domains normalise and shared hosts say nothing', () => {
  assert.strictEqual(LD.normDomain('https://www.Acme-Fab.com/about?x=1'), 'acme-fab.com');
  assert.strictEqual(LD.companyDomain('owner@acme-fab.com'), 'acme-fab.com');
  assert.strictEqual(LD.companyDomain('jane@gmail.com'), '');
  assert.strictEqual(LD.companyDomain('https://facebook.com/acmefab'), '');
});

t('names normalise across suffixes, punctuation and "the"', () => {
  assert.strictEqual(LD.normName('The Acme Fabrication, LLC'), 'acme fabrication');
  assert.strictEqual(LD.normName('Acme Fabrication Inc.'), 'acme fabrication');
  assert.strictEqual(LD.normName('Smith & Sons Co'), 'smith and sons');
});

t('suburbs roll up to their cohort city', () => {
  assert.strictEqual(LD.regionOf('Lakewood'), 'Cleveland');
  assert.strictEqual(LD.regionOf('Cuyahoga Falls, OH'), 'Akron');
  assert.strictEqual(LD.regionOf('Marietta'), 'Athens/Marietta');
});

const src = { id: 's1', url: 'https://clevelandchamber.example/members', label: 'Cleveland chamber', type: 'Chamber of commerce', city: 'Cleveland' };

t('a new company is created, queued for review, with provenance on every fact', () => {
  const r = LD.ingest({ name: 'Acme Fabrication LLC', website: 'acme-fab.com', contactName: 'Dana Reed',
    contactRole: 'Owner', email: 'dana@acme-fab.com' }, src, { companies: [], contacts: [] }, NOW);
  assert.strictEqual(r.action, 'created');
  assert.strictEqual(r.company.review.state, 'new');
  assert.strictEqual(r.company.f.domain.v, 'acme-fab.com');
  assert.strictEqual(r.company.f.city.v, 'Cleveland');
  assert.strictEqual(r.company.f.city.src, src.url);
  assert.strictEqual(r.company.f.city.at, '2026-09-23');
  assert.strictEqual(r.contacts[0].contact.decisionMaker, true);
  assert.ok(/^co_/.test(r.company.id) && /^ct_/.test(r.contacts[0].contact.id));
});

function seed() {
  const r = LD.ingest({ name: 'Acme Fabrication LLC', website: 'acme-fab.com', city: 'Cleveland',
    industry: 'Metal fabrication', contactName: 'Dana Reed', contactRole: 'Owner', email: 'dana@acme-fab.com' },
    src, { companies: [], contacts: [] }, NOW);
  return { companies: [r.company], contacts: r.contacts.map(x => x.contact) };
}

t('same domain under another name merges, keeps the alias and both sources', () => {
  const s = seed();
  const r = LD.ingest({ name: 'Acme Fab', website: 'https://www.acme-fab.com', city: 'Lakewood' },
    { id: 's2', url: 'https://sba.example/list', label: 'SBA list', type: 'Business directory' }, s, NOW);
  assert.strictEqual(r.action, 'merged');
  assert.strictEqual(r.match, 'domain');
  assert.strictEqual(r.company.id, s.companies[0].id);
  assert.deepStrictEqual(r.company.aliases, ['Acme Fab']);
  assert.strictEqual(r.company.f.name.v, 'Acme Fabrication LLC');
  assert.strictEqual(r.company.sources.length, 2);
});

t('same name without domains matches only in the same metro', () => {
  const a = LD.fromRaw({ name: 'Main Street Bakery', city: 'Akron' }, null, NOW).company;
  const b = LD.fromRaw({ name: 'Main Street Bakery Inc', city: 'Cuyahoga Falls' }, null, NOW).company;
  const c = LD.fromRaw({ name: 'Main Street Bakery', city: 'Toledo' }, null, NOW).company;
  assert.strictEqual(LD.matchReason(a, b), 'name');
  assert.strictEqual(LD.matchReason(a, c), null);
});

t('a refresh never overwrites a human-verified fact; it flags the conflict', () => {
  const s = seed();
  s.companies[0].f.industry = LD.fact('Advanced manufacturing', 'call with owner', '2026-09-01', 'human');
  const r = LD.ingest({ name: 'Acme Fabrication', website: 'acme-fab.com', industry: 'Retail' }, src, s, NOW);
  assert.strictEqual(r.company.f.industry.v, 'Advanced manufacturing');
  const open = r.company.conflicts.filter(x => !x.resolved);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].incoming.v, 'Retail');
  assert.ok(r.changed.some(x => x.field === 'industry' && x.kind === 'protected'));
});

t('an automatic fact is replaced by newer evidence but the change is kept for review', () => {
  const s = seed();
  const r = LD.ingest({ name: 'Acme Fabrication', website: 'acme-fab.com', industry: 'Precision machining' }, src, s, NOW);
  assert.strictEqual(r.company.f.industry.v, 'Precision machining');
  assert.strictEqual(r.company.conflicts[0].current.v, 'Metal fabrication');
});

t('the same contact merges; a new email is flagged as a changed contact', () => {
  const s = seed();
  const r = LD.ingest({ name: 'Acme Fabrication', website: 'acme-fab.com', contactName: 'Dana Reed',
    contactRole: 'Owner', email: 'dana.reed@acme-fab.com' }, src, s, NOW);
  assert.strictEqual(r.contacts.length, 1);
  assert.strictEqual(r.contacts[0].action, 'merged');
  assert.strictEqual(r.contacts[0].contact.id, s.contacts[0].id);
  assert.strictEqual(r.contacts[0].contact.changed, '2026-09-23');
});

t('a suppressed company is kept but never queued, and its contacts are do-not-contact', () => {
  const r = LD.ingest({ name: 'Quiet Co', website: 'quiet.example', email: 'x@quiet.example' }, src,
    { companies: [], contacts: [], suppression: [{ domain: 'quiet.example', reason: 'Opted out 2026-08' }] }, NOW);
  assert.strictEqual(r.action, 'suppressed');
  assert.strictEqual(r.company.review.state, 'rejected');
  assert.strictEqual(r.contacts[0].contact.doNotContact, true);
});

t('a company already in outreach is not re-queued when rediscovered', () => {
  const s = seed();
  s.companies[0].review = { state: 'approved', at: '2026-09-10' };
  s.companies[0].outreach = { status: 'Contacted', firstContactAt: '2026-09-12' };
  const r = LD.ingest({ name: 'Acme Fabrication', website: 'acme-fab.com', hiring: 'Two welders' }, src, s, NOW);
  assert.strictEqual(r.company.review.state, 'approved');
  assert.strictEqual(r.company.review.refreshed, undefined);
});

t('Bootcamp score: a well-evidenced Cleveland lead ranks high with high confidence', () => {
  const r = LD.ingest({ name: 'Acme', website: 'acme-fab.com', city: 'Cleveland', description: 'Custom metal parts',
    customerMix: 'B2B', foundedYear: 2019, employees: 12, revenue: '$1.2M', hiring: 'Hiring two welders',
    contactName: 'Dana Reed', contactRole: 'Owner', email: 'dana@acme-fab.com' }, src, { companies: [], contacts: [] }, NOW);
  const s = LD.scoreBootcamp(r.company, r.contacts.map(x => x.contact), {}, NOW);
  assert.strictEqual(s.parts.place, 25);
  assert.strictEqual(s.parts.reach, 15);
  assert.ok(s.score >= 75, 'score ' + s.score);
  assert.strictEqual(s.confidence, 'High');
});

t('Bootcamp score: unknowns lower confidence and list what to research, not a penalty', () => {
  const r = LD.ingest({ name: 'Mystery LLC', city: 'Akron' }, src, { companies: [], contacts: [] }, NOW);
  const s = LD.scoreBootcamp(r.company, [], {}, NOW);
  assert.strictEqual(s.confidence, 'Low');
  ['Customer mix', 'Year founded', 'Revenue', 'Decision maker contact'].forEach(m => assert.ok(s.missing.includes(m), m));
  assert.strictEqual(s.parts.place, 25);
});

t('Bootcamp score: an upcoming cohort lifts a non-priority city', () => {
  const r = LD.ingest({ name: 'Gem City Tools', city: 'Dayton' }, null, { companies: [], contacts: [] }, NOW);
  assert.strictEqual(LD.scoreBootcamp(r.company, [], {}, NOW).parts.place, 10);
  const soon = { cohorts: [{ city: 'Dayton', date: '2026-11-01' }] };
  assert.strictEqual(LD.scoreBootcamp(r.company, [], soon, NOW).parts.place, 25);
  const past = { cohorts: [{ city: 'Dayton', date: '2026-01-01' }] };
  assert.strictEqual(LD.scoreBootcamp(r.company, [], past, NOW).parts.place, 10);
});

t('a manual override wins, and keeps the computed score beside it', () => {
  const r = LD.ingest({ name: 'Mystery LLC', city: 'Akron' }, src, { companies: [], contacts: [] }, NOW);
  r.company.override = { score: 90, reason: 'Warm intro from partner', by: 'u1', at: '2026-09-23' };
  const s = LD.scoreBootcamp(r.company, [], {}, NOW);
  assert.strictEqual(s.score, 90);
  assert.ok(s.computed < 90);
});

t('stale contact verification drops reach points and flags the profile', () => {
  const r = LD.ingest({ name: 'Acme', website: 'acme-fab.com', city: 'Akron', contactName: 'Dana', contactRole: 'Founder',
    email: 'dana@acme-fab.com', verifiedAt: '2025-12-01' }, src, { companies: [], contacts: [] }, NOW);
  const cts = r.contacts.map(x => x.contact);
  assert.strictEqual(LD.scoreBootcamp(r.company, cts, {}, NOW).parts.reach, 9);
  assert.ok(LD.flags(r.company, cts, NOW).includes('stale-contact'));
});

t('grant pre-screen: any No is unlikely fit; all Yes is a potential referral; else needs review', () => {
  const base = { name: 'Acme', city: 'Cleveland', foundedYear: 2018, revenue: '2,000,000', parentOver25M: 'no',
    industry: 'Precision machining', customerMix: 'B2B', investment: 'New CNC line, $80K',
    growth: 'yes', financing: 'yes' };
  let c = LD.fromRaw(base, null, NOW).company;
  assert.strictEqual(LD.grantPrescreen(c, NOW).outcome, 'Potential referral');
  c = LD.fromRaw(Object.assign({}, base, { customerMix: 'B2C' }), null, NOW).company;
  assert.strictEqual(LD.grantPrescreen(c, NOW).outcome, 'Unlikely fit');
  c = LD.fromRaw(Object.assign({}, base, { revenue: '$30M' }), null, NOW).company;
  assert.strictEqual(LD.grantPrescreen(c, NOW).outcome, 'Unlikely fit');
  c = LD.fromRaw(Object.assign({}, base, { financing: '' }), null, NOW).company;
  assert.strictEqual(LD.grantPrescreen(c, NOW).outcome, 'Needs review');
  c = LD.fromRaw(Object.assign({}, base, { parentOver25M: '' }), null, NOW).company;
  const g = LD.grantPrescreen(c, NOW);
  assert.strictEqual(g.items.find(i => i.key === 'revenue').answer, 'unknown');
});

t('identity is recorded only with a stated source', () => {
  const a = LD.fromRaw({ name: 'X', ownerIdentity: 'Black-owned' }, null, NOW).company;
  assert.strictEqual(a.f.ownerIdentity, undefined);
  const b = LD.fromRaw({ name: 'X', ownerIdentity: 'Black-owned', identitySource: 'https://network.example/roster' }, null, NOW).company;
  assert.strictEqual(b.f.ownerIdentity.src, 'https://network.example/roster');
});

t('Airtable export carries research only; outreach fields are never written', () => {
  const s = seed();
  const c = s.companies[0];
  const out = LD.companyToAirtable(c, s.contacts, {}, NOW);
  assert.strictEqual(out['External ID'], c.id);
  ['Outreach status', 'Outreach owner', 'First contact date', 'Replied', 'Applied', 'Attended', 'Grant referral']
    .forEach(k => assert.ok(!(k in out), k));
  const dnc = LD.contactToAirtable(Object.assign({}, s.contacts[0], { doNotContact: true }), c);
  assert.strictEqual(dnc['Email'], null);
  assert.strictEqual(dnc['Do not contact'], true);
});

t('outreach reads back from Airtable, including opt-outs', () => {
  const o = LD.outreachFromAirtable({ 'Outreach status': { name: 'Applied' }, 'First contact date': '2026-09-15', 'Do not contact': false });
  assert.strictEqual(o.applied, true);
  assert.strictEqual(o.replied, true);
  assert.strictEqual(o.attended, false);
  assert.strictEqual(LD.outreachFromAirtable({ 'Outreach status': 'Opted out' }).optedOut, true);
});

t('metrics count distinct companies at each stage, separately', () => {
  const cs = [
    { createdAt: '2026-09-21', review: { state: 'approved', at: '2026-09-22' }, airtable: { firstSyncedAt: '2026-09-22' },
      outreach: { firstContactAt: '2026-09-23', replied: true }, f: { city: LD.fact('Akron') }, sources: [{ type: 'Founder network', network: true }] },
    { createdAt: '2026-09-22', review: { state: 'new' }, f: {}, sources: [] },
    { createdAt: '2026-08-01', review: { state: 'approved', at: '2026-08-02' }, outreach: { firstContactAt: '2026-09-22' }, f: { city: LD.fact('Lakewood') }, sources: [] }
  ];
  const m = LD.metrics(cs, NOW, '2026-09-21', '2026-09-27');
  assert.strictEqual(m.discovered, 2);
  assert.strictEqual(m.approved, 1);
  assert.strictEqual(m.synced, 1);
  assert.strictEqual(m.firstContacted, 2);
  assert.strictEqual(m.replies, 1);
  assert.strictEqual(m.founderNetwork, 1);
  assert.deepStrictEqual(m.byCity, { Akron: 1, Cleveland: 1 });
});

t('CSV import maps common directory headers', () => {
  const rows = LD.parseCSV('Business Name,Website,City,Owner,Title,Email\n"Acme, Fab LLC",acme-fab.com,Akron,Dana Reed,Owner,dana@acme-fab.com\n');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Acme, Fab LLC');
  assert.strictEqual(rows[0].contactName, 'Dana Reed');
  assert.strictEqual(rows[0].email, 'dana@acme-fab.com');
});

console.log('\n' + n + ' passed');
