# Bootcamp Lead Desk

Lightship's sourcing tool for Bootcamp outreach. It finds Ohio companies, builds
sourced profiles, scores Bootcamp priority and a separate JobsOhio grant
pre-screen, queues each lead for a researcher, and sends approved leads to
Airtable. Airtable keeps the team's outreach record. The desk handles discovery,
refresh, research and scoring.

**Live page:** https://claude.ai/artifact/85tSue8PchZ7vjzPuTzYqg (private until shared)
**Airtable:** base *Lightship Bootcamp Outreach* (`appn70ywOXUf5kjTv`), tables
*Companies* and *Contacts*.

The goal it serves: 300–500 distinct companies first-contacted each month
(75–125 a week). Cleveland and Akron come first, then Dayton, Columbus,
Cincinnati, Toledo, Youngstown and Athens/Marietta.

---

## How a lead moves

```
approved source ─► Add leads ─► dedupe + suppression check ─► Review queue
                                                              │
                         researcher approves, edits, rejects, or sends to investigate
                                                              │
                                        Send to Airtable (upsert on External ID)
                                                              │
                     team does outreach in Airtable ◄─ desk reads status, replies, opt-outs back
```

1. **Discover.** Leads come only from a source marked **Approved** on the
   Sources page. Each source records its link, city, type and access rules, so
   nobody scrapes a site that asks not to be scraped. You can add leads three ways:
   paste a table (CSV or copied from a spreadsheet), paste page text and have
   Claude list the businesses it names, or enter one company by hand. Every fact
   keeps the source link and the date it was found.
2. **Enrich.** Open a company and use **Research with Claude**. Paste text from a
   page you opened (About page, listing, LinkedIn company page, news story) with
   its link. Claude proposes only what that text says, quoting it. You tick what to
   keep. Anything not found stays **Unknown**.
3. **Deduplicate.** A match on domain always counts. A match on normalized name
   ("The Acme Fabrication, LLC" = "Acme Fabrication") counts only when the cities
   are in the same metro or one is unknown. Duplicates merge into one profile.
   Other names become aliases, every source is kept, and contacts merge on
   email, LinkedIn or name.
4. **Score.** Both scores are recalculated whenever the desk displays them, so
   they change as soon as the evidence or cohort dates do. See *Scoring* below.
5. **Review.** New leads, leads with new evidence, and leads marked investigate
   show up on **Today**. Cleveland and Akron are listed first. A researcher can
   approve, reject (a reason is required), investigate, edit facts, resolve
   conflicts, or override the score (a reason is required and the computed score
   stays visible).
6. **Sync.** Only approved companies can be sent. The desk upserts on
   `External ID`, so sending again or retrying after a failure updates the same
   row and never creates a duplicate. A failed batch marks only its own rows,
   records the error, and shows under **Sync failures**.
7. **Read back.** On each visit, and whenever you click **Read outreach from
   Airtable**, the desk pulls in status, owner, first-contact date, channel,
   follow-up, replies, applications, attendance, grant referral and opt-outs.
   Opted-out companies, and companies the team added to Airtable directly, go on
   the do-not-contact list. A source that lists them again cannot put them back
   in the queue.

### What the desk writes to Airtable, and what it never writes

It writes research fields: company, domain, website, city, region, industry,
description, customer mix, priority, confidence, reasons, grant pre-screen,
checklist, source links, discovered and verified dates, approver, and the
do-not-contact flag.

It never writes outreach status, owner, first-contact date, channel, follow-up,
replied, applied, attended or grant referral. Those fields belong to the team
and are only read.

A do-not-contact person keeps their Airtable row so they are never rediscovered.
Their email, phone and LinkedIn are cleared.

---

## Scoring

### Bootcamp outreach priority, 0–100

This ranks where to spend attention. It does not decide admission.

| Part | Max | Earned by |
|---|---|---|
| Priority city or upcoming cohort | 25 | Cleveland/Akron (or any city in Settings → Priority cities), or a confirmed cohort in that city within 90 days. A later cohort earns 18, an expansion city 10, elsewhere in Ohio 5 |
| Relevance and growth need | 25 | A description, customer mix (B2B scores highest), 1–10 years operating, 2–100 employees |
| Traction, hiring or expansion | 20 | A hiring signal, an expansion signal, revenue evidence |
| Verified reachable decision maker | 15 | Owner/founder/CEO with an email or phone verified in the last 180 days. Stale or indirect contact earns less |
| Timeliness and engagement | 15 | Evidence found or refreshed in the last 30 days, a partner referral or event/accelerator source, an engagement signal |

An unknown fact earns no points and is listed under **To research**. It also
lowers confidence (High ≥ 75% of facts known, Medium ≥ 45%, otherwise Low). It is
never treated as evidence against the company. Suburbs count toward their cohort
city, so Lakewood counts as Cleveland and Cuyahoga Falls as Akron.

### JobsOhio grant pre-screen

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
| **Company** `companies/{co_…}` | stable ID; `f.name`, `f.domain`, `f.website`, `f.companyLinkedin`, `f.city`, `f.description`, `f.industry`, `f.customerMix`, `f.foundedYear`, `f.employees`, `f.revenueBand`, `f.parentOver25M`, `f.hiring`, `f.expansion`, `f.investment`, `f.growth`, `f.financing`, `f.targetIndustry`, `f.engagement`, `f.ownerIdentity`; `aliases`; `sources[]` (url, label, type, sourceId, network, date); `conflicts[]`; `override`; `createdAt`, `updatedAt`, `verifiedAt`; `doNotContact`; `log[]` |
| **Contact** `contacts/{ct_…}` | stable ID; `companyId`; `f.name`, `f.role`, `f.email`, `f.phone`, `f.linkedin`, each with its own source and verified date; `decisionMaker`; `doNotContact`; `changed` |
| **Workflow** (on the company) | `review` {state, by, at, note, refreshed}; `airtable` {recordId, status, syncedAt, firstSyncedAt, error, attempts}; `snapshot` {score at last sync}; `outreach` {status, owner, firstContactAt, channel, followUp, replied, applied, attended, optedOut, grantReferral}, read from Airtable |
| **Source** `sources/{src_…}` | name, url, type, city, status (Proposed / Approved / Paused), access rules, founder-network flag, lastRunAt |
| **Settings** `settings/desk` | Airtable base/table IDs, priority cities, cohort dates, do-not-contact list |
| **Runs** `runs/{run_…}` | log of imports, syncs and read-backs with counts and errors |
| **Intake** `intake/{…}` | raw candidates from scheduled discovery, waiting to be processed |

The desk stores reviewer IDs, never names. It looks up names only to display
them.

---

## Scheduled discovery and refresh

The page can't browse the web, so recurring discovery runs outside it, as a
scheduled Claude routine. The routine writes raw candidates into the artifact's
`intake` collection. The page then runs each candidate through the same dedupe
and suppression checks as a manual import, and only after that does it reach the
review queue.

The routine should write each candidate like this:

```json
{
  "sourceId": "src_bounce",
  "at": "2026-09-30",
  "raw": {
    "name": "Example Co", "website": "example.com", "city": "Akron",
    "description": "…", "industry": "…",
    "contactName": "…", "contactRole": "Founder", "email": "…",
    "hiring": "Posted two technician roles on 2026-09-28",
    "sourceUrl": "https://the-exact-page-it-came-from"
  }
}
```

Rules for the routine:

- Use only sources whose status is **Approved**, and follow each source's access
  rules.
- Put the exact page in `sourceUrl`.
- Leave out anything you can't source.
- Never infer identity.

The page will not process a candidate whose source isn't approved.

---

## Rollout

- **Phase 1: Cleveland/Akron pilot.** This build. Approve sources, import,
  review, and sync. Check the first 50–100 profiles by hand for location, contact
  accuracy, source quality and duplicates before scaling up. The Performance page
  shows the duplicate and manual-correction rates for that check.
- **Phase 2: operating loop.** Schedule the discovery/refresh routine above.
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
