# Bootcamp Lead Desk

Lightship's research dashboard for Bootcamp outreach. Every week Claude
researches Ohio companies on the public web. For each one it records industry,
revenue (stated, or an estimate with its reasoning), LinkedIn and social
profiles, the owner, and evidence for each JobsOhio Small Business Grant
criterion. The dashboard ranks them by **how likely we could get them the grant**.
The program manager reviews the list, approves the companies worth inviting to
Lightship Bootcamp, and sends them to Airtable, where the team runs outreach.

**Live page:** https://claude.ai/artifact/85tSue8PchZ7vjzPuTzYqg (private until shared)
**Airtable:** base *Lightship Bootcamp Outreach* (`appn70ywOXUf5kjTv`), tables
*Companies* and *Contacts*.
**Weekly research:** Claude routine *Lightship weekly lead research*, Mondays
6am Eastern. It researches 60–75 companies a run, about 250–300 a month. Its
instructions are in [`research/weekly-research.md`](research/weekly-research.md).

Cleveland and Akron come first. Dayton, Columbus, Cincinnati, Toledo,
Youngstown and Athens/Marietta follow as cohort dates are confirmed.

---

## How a company reaches the program manager

```
Monday: Claude researches 60–75 companies ─► intake ─► dashboard adds them (dedupe + do-not-contact check)
                                                                   │
                                  ranked by grant likelihood on Today, Cleveland/Akron first
                                                                   │
                     program manager approves, edits, rejects or marks investigate
                                                                   │
                                       Send to Airtable (upsert on External ID)
                                                                   │
                team does outreach in Airtable ◄─ dashboard reads status, replies and opt-outs back
```

1. **Research.** The weekly routine searches public sources: chamber
   directories, certified MBE/FBE/SBE vendor lists, business news, accelerator
   portfolios, job boards, procurement awards and company websites. For every
   company it records the page each fact came from. Anything it can't find is
   left out rather than guessed. When revenue isn't published, it gives an
   estimated range with its basis, such as employee count × typical revenue per
   employee, clearly labeled *Est.* It never infers anyone's identity.
2. **Arrive.** When someone with edit access opens the page, waiting research
   is added automatically, through the same duplicate and do-not-contact checks
   as a manual import. A company the desk already has is merged, not added
   twice.
3. **Review.** **Today** lists new companies by grant likelihood. Each row
   shows industry, revenue, city, owner and links to the website, LinkedIn and
   social profiles. Opening a company shows the score for each grant criterion
   and what still needs confirming on a call. The program manager can approve,
   reject (a reason is required), investigate, edit facts, or override the
   Bootcamp fit score.
4. **Manual additions.** You can still add companies yourself with
   **Add leads**: paste a table, paste a page for Claude to extract, or enter one
   company. **Research with Claude** on any company fills in more facts from a
   page you paste.
5. **Sync.** Only approved companies can be sent. The desk upserts on
   `External ID`, so a retry never creates a duplicate row.
6. **Read back.** Outreach status, owner, first contact, replies,
   applications, attendance, grant referral and opt-outs come back from
   Airtable. Opted-out companies, and companies the team added straight into
   Airtable, go on the do-not-contact list, and research skips them.

### What the desk writes to Airtable, and what it never writes

It writes research fields:

- company, domain, website, company LinkedIn, social profiles, city, region, industry, description, customer mix
- grant likelihood and confidence, the grant checklist, estimated revenue and its basis
- Bootcamp fit and its reasons
- source links, discovered and verified dates, approver, and the do-not-contact flag

It never writes outreach status, owner, first-contact date, channel, follow-up,
replied, applied, attended or grant referral. Those belong to the team.

---

## Scoring

### Grant likelihood, 0–100: the main ranking

This is how likely we could get the company a JobsOhio Small Business Grant,
based on what we found online. It uses the same seven criteria as the checklist
below, weighted:

| Criterion | Points | Full points | Partial credit |
|---|---|---|---|
| Operating at least one year | 10 | Founding year a year or more ago | — |
| Revenue $100K to under $25M, parent included | 20 | Stated and in range, with no large parent | 16 if stated but the parent isn't confirmed; 12 for an estimate in range |
| JobsOhio target industry | 20 | Confirmed | 14 when the industry looks like a target industry |
| Primarily B2B | 15 | B2B | 7 for a mix |
| Concrete eligible investment | 15 | A specific planned investment | 7 for an expansion signal |
| 10% job/payroll growth or at-risk retention | 10 | Confirmed | 6 for a hiring signal, 4 for expansion |
| Can fund spending before reimbursement | 10 | Confirmed | 3 when revenue is $1M+ |

Unknown earns nothing. Each unknown is listed under *To confirm on a call or by
research*, and together they set the confidence. Any clear **No**, such as
mainly consumer sales or revenue over $25M, caps the score at 15, because a
company that fails a hard requirement shouldn't rank on the rest. A company
like that can still be a Bootcamp prospect.

### Bootcamp fit, 0–100: the second score

This ranks where to spend attention. It does not decide admission.

| Part | Max | Earned by |
|---|---|---|
| Priority city or upcoming cohort | 25 | Cleveland/Akron (or any city in Settings → Priority cities), or a confirmed cohort in that city within 90 days. A later cohort earns 18, an expansion city 10, elsewhere in Ohio 5 |
| Relevance and growth need | 25 | A description, customer mix (B2B scores highest), 1–10 years operating, 2–100 employees |
| Traction, hiring or expansion | 20 | A hiring signal, an expansion signal, stated or estimated revenue |
| Verified reachable decision maker | 15 | Owner/founder/CEO with an email or phone verified in the last 180 days. Stale or indirect contact earns less |
| Timeliness and engagement | 15 | Evidence found or refreshed in the last 30 days, a partner referral or event/accelerator source, an engagement signal |

An unknown fact earns no points and is listed under **To research**. It also
lowers confidence (High ≥ 75% of facts known, Medium ≥ 45%, otherwise Low). It is
never treated as evidence against the company. Suburbs count toward their cohort
city, so Lakewood counts as Cleveland and Cuyahoga Falls as Akron.

### Grant checklist (Yes / No / Unknown)

This is a separate Yes / No / Unknown checklist:

- operating at least one year
- revenue of at least $100K and under $25M, parent company included
- a JobsOhio target industry
- primarily B2B revenue
- a concrete eligible investment
- credible 10% growth in jobs or payroll, or at-risk jobs retained
- able to fund spending before reimbursement

Any **No** gives *Unlikely fit*. All **Yes** gives *Potential referral*. Anything
else gives *Needs review*.

This is a research aid only. JobsOhio decides eligibility and awards. A company
that misses the grant is still a Bootcamp prospect. A referral needs the company's
confirmed interest and its permission to share its information.
Sources: [program overview](https://www.jobsohio.com/incentives-programs/support-for-small-businesses/jobsohio-small-business-grant),
[guidelines (PDF)](https://www.jobsohio.com/images/josb_guidelines_may_2025-(1).pdf),
reviewed September 23, 2026.

---

## Founder representation

The desk reaches Black, Brown and women owners on purpose, by **sourcing**
through their networks. A source can be flagged as a founder network, and
Performance reports what share of discovered companies came through those
networks. Identity is recorded on a company only when an owner provided it or a
reliable public source states it, such as a city MBE/FBE certification. It always
carries that source. It is never inferred from names or photos, never scored, and
never used to exclude anyone.

---

## Data contract

Every consequential fact is stored as `{ v, src, at, by }`: the value, where it
came from, the date it was verified, and whether it came from an import/extraction
(`auto`) or a researcher (`human`). A refresh never overwrites a `human` fact. It
records a conflict instead. An `auto` fact can be replaced by newer evidence, and
the replaced value is kept as a conflict until a researcher confirms one.

| Entity | Held as |
|---|---|
| **Company** `companies/{co_…}` | stable ID; `f.name`, `f.domain`, `f.website`, `f.companyLinkedin`, `f.instagram`, `f.facebook`, `f.x`, `f.youtube`, `f.tiktok`, `f.revenueEstimate` (with `basis`), `f.city`, `f.description`, `f.industry`, `f.customerMix`, `f.foundedYear`, `f.employees`, `f.revenueBand`, `f.parentOver25M`, `f.hiring`, `f.expansion`, `f.investment`, `f.growth`, `f.financing`, `f.targetIndustry`, `f.engagement`, `f.ownerIdentity`; `aliases`; `sources[]` (url, label, type, sourceId, network, date); `conflicts[]`; `override`; `createdAt`, `updatedAt`, `verifiedAt`; `doNotContact`; `log[]` |
| **Contact** `contacts/{ct_…}` | stable ID; `companyId`; `f.name`, `f.role`, `f.email`, `f.phone`, `f.linkedin`, each with its own source and verified date; `decisionMaker`; `doNotContact`; `changed` |
| **Workflow** (on the company) | `review` {state, by, at, note, refreshed}; `airtable` {recordId, status, syncedAt, firstSyncedAt, error, attempts}; `snapshot` {score at last sync}; `outreach` {status, owner, firstContactAt, channel, followUp, replied, applied, attended, optedOut, grantReferral}, read from Airtable |
| **Source** `sources/{src_…}` | name, url, type, city, status (Proposed / Approved / Paused), access rules, founder-network flag, lastRunAt |
| **Settings** `settings/desk` | Airtable base/table IDs, priority cities, cohort dates, do-not-contact list |
| **Runs** `runs/{run_…}` | log of imports, syncs and read-backs with counts and errors |
| **Intake** `intake/{…}` | raw candidates from scheduled discovery, waiting to be processed |

The desk stores reviewer IDs, never names. It looks up names only to display
them.

---

## The weekly research routine

The page can't browse the web itself, so research runs as a scheduled Claude
routine: *Lightship weekly lead research*, which starts a fresh session every
Monday at 10:00 UTC. It:

- reads the desk's settings and existing companies, so it skips anything known or suppressed
- researches 60–75 new companies
- writes each one as a document in the artifact's `intake` collection

The full instructions, including the exact document shape, are in
[`research/weekly-research.md`](research/weekly-research.md). To change them,
edit that file and update the routine's prompt to match. You can see and run
the routine from claude.ai's routines list.

The page adds waiting research automatically the next time someone who can edit
opens it. It never processes candidates tagged with a paused source.

---

## Rollout

- **Phase 1: Cleveland/Akron pilot.** This build. Approve sources, import,
  review, and sync. Check the first 50–100 profiles by hand for location, contact
  accuracy, source quality and duplicates before scaling up. The Performance page
  shows the duplicate and manual-correction rates for that check.
- **Phase 2: operating loop.** The weekly research routine is running.
  Two-way status sync, stale-data flags and source performance are already built.
  Target 75–125 unique first contacts a week.
- **Phase 3: expand.** Add source packs for the other cities as Bootcamp dates
  are confirmed (Settings → Cohort dates). Tune sources and thresholds on reply
  and application rates (Sources page), not on lead volume.

---

## Files

```
src/
  index.html   page shell
  styles.css   tokens, light + dark, phone width
  core.js      the rules: normalising, matching, merging, both scores, Airtable mapping, metrics
  app.js       storage, Airtable, Claude, and every view
test/
  core.js      node test/core.js   — the rules, no browser
  flow.js      node test/flow.js   — real clicks with Airtable stubbed
```

`test/flow.js` serves `src/` on :8098 and needs Playwright. In a Claude Code
cloud session, run it with `NODE_PATH=/opt/node22/lib/node_modules node test/flow.js`.

To change the page, edit the files in `src/`, then republish them to the same
URL. The data in the artifact's database stays put.
