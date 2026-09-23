/* app.js — the Lead Desk page: storage, Airtable, Claude, and every view.
   The rules themselves live in core.js (window.LD); this file only reads
   and writes state and draws it. */
(function () {
  "use strict";
  var LD = window.LD;

  /* ============================================================
     Storage — the artifact's shared db, with this browser as a fallback
     ============================================================ */

  var COLLS = ["companies", "contacts", "sources", "runs", "intake", "settings"];
  var cache = {};
  COLLS.forEach(function (c) { cache[c] = []; });
  var db = null;
  var mode = "local";
  var LKEY = "leaddesk.v1.";

  function localLoad(c) {
    try { var r = localStorage.getItem(LKEY + c); return r ? JSON.parse(r) : []; } catch (e) { return []; }
  }
  function localSave(c) {
    try { localStorage.setItem(LKEY + c, JSON.stringify(cache[c])); } catch (e) { /* best effort */ }
  }

  function all(c) { return cache[c]; }
  function find(c, id) {
    var rows = cache[c];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  var writeErrors = 0;
  function put(c, row) {
    if (!row.id) throw new Error("row without id");
    var i = cache[c].findIndex(function (r) { return r.id === row.id; });
    if (i >= 0) cache[c][i] = row; else cache[c].push(row);
    if (db) {
      var data = JSON.parse(JSON.stringify(row)); delete data.id;
      db.doc(c + "/" + row.id).set(data).catch(function (e) {
        writeErrors++;
        console.warn("write failed", c, row.id, e && e.code);
        toast(e && (e.code === "permission_denied" || e.code === "not_granted")
          ? "You can view this desk but not change it. Ask the owner for edit access."
          : "A change didn't save. Check your connection and try again.");
      });
    } else localSave(c);
    schedule();
  }
  function del(c, id) {
    cache[c] = cache[c].filter(function (r) { return r.id !== id; });
    if (db) db.doc(c + "/" + id).delete().catch(function (e) { console.warn("delete failed", e && e.code); });
    else localSave(c);
    schedule();
  }

  function settings() {
    var s = find("settings", "desk") || { id: "desk" };
    s.airtable = Object.assign({ baseId: "appn70ywOXUf5kjTv", companiesTable: "tbloCsATWhWShKQqP", contactsTable: "tblybeD6fmRaHMpzK" }, s.airtable || {});
    s.priorityCities = s.priorityCities && s.priorityCities.length ? s.priorityCities : LD.PRIORITY_CITIES.slice();
    s.cohorts = s.cohorts || [];
    s.suppression = s.suppression || [];
    return s;
  }
  function saveSettings(patch) {
    var s = Object.assign(settings(), patch);
    put("settings", s);
  }

  function boot() {
    COLLS.forEach(function (c) { cache[c] = localLoad(c); });
    render();
    if (!window.claude || typeof window.claude.use !== "function") return;

    window.claude.use("db").then(function (h) {
      if (!h) return;
      db = h; mode = "db";
      var pending = COLLS.length;
      COLLS.forEach(function (c) {
        db.collection(c).onSnapshot(function (snap) {
          cache[c] = snap.docs.map(function (d) { return Object.assign({}, d.data() || {}, { id: d.id }); });
          if (pending > 0 && --pending === 0) afterLoad();
          schedule();
        }, function (err) { console.warn("snapshot error", c, err && err.code); });
      });
    }).catch(function () { /* stay local */ });

    window.claude.use("user").then(function (u) {
      if (!u) return;
      user = u;
      u.me().then(function (m) { me = m; schedule(); });
    }).catch(function () {});
  }

  var loadedOnce = false;
  function afterLoad() {
    if (loadedOnce) return;
    loadedOnce = true;
    /* one quiet read of outreach state per visit, so opt-outs and replies
       made in Airtable are here before anyone reviews */
    if (settings().airtable.baseId) readBack(true);
  }

  var user = null;
  var me = { id: null, name: "", canEdit: false };

  /* names for ids, resolved at render time and never stored */
  var names = {};
  function nameOf(id) {
    if (!id) return "";
    if (names[id] !== undefined) return names[id] || "a teammate";
    names[id] = "";
    if (user && user.profiles) {
      user.profiles([id]).then(function (ps) { names[id] = (ps[id] && ps[id].name) || ""; schedule(); }).catch(function () {});
    }
    return "a teammate";
  }

  /* ============================================================
     Derived reads
     ============================================================ */

  var NOW = function () { return new Date(); };
  var memo = { tick: 0, score: {}, grant: {} };
  function contactsOf(id) { return cache.contacts.filter(function (c) { return c.companyId === id; }); }
  function scoreOf(c) {
    var k = c.id;
    if (!memo.score[k]) memo.score[k] = LD.scoreBootcamp(c, contactsOf(c.id), settings(), NOW());
    return memo.score[k];
  }
  function grantOf(c) {
    if (!memo.grant[c.id]) memo.grant[c.id] = LD.grantPrescreen(c, NOW());
    return memo.grant[c.id];
  }
  function flagsOf(c) { return LD.flags(c, contactsOf(c.id), NOW()); }
  function regionOf(c) { return LD.regionOf(LD.val(c, "city")) || LD.val(c, "city") || ""; }
  function isPriority(c) { return settings().priorityCities.indexOf(regionOf(c)) >= 0; }
  function state(c) { return (c.review && c.review.state) || "new"; }
  function inQueue(c) {
    var s = state(c);
    return s === "new" || s === "investigate" || (s === "approved" && c.review.refreshed);
  }
  function needsSync(c) {
    if (state(c) !== "approved") return false;
    var a = c.airtable || {};
    if (a.status === "error") return true;
    if (!a.syncedAt) return true;
    return (c.updatedAt || "") > a.syncedAt.slice(0, 10) || a.status === "pending";
  }
  function highChange(c) {
    if (state(c) !== "approved") return false;
    var snap = c.snapshot && c.snapshot.score;
    var s = scoreOf(c).score;
    return (typeof snap === "number" && Math.abs(s - snap) >= 10) || flagsOf(c).indexOf("contact-changed") >= 0;
  }

  /* ============================================================
     Rendering loop
     ============================================================ */

  var view = "today";
  var filters = { q: "", region: "", mix: "", grant: "", contact: "", review: "", outreach: "", source: "", fresh: "", age: "", revenue: "", minScore: "", flag: "" };
  var sheet = null;          /* { kind: "company", id } | { kind: "import" } | { kind: "source", id } */
  var editing = null;        /* the inline edit currently open in the sheet */
  var perfPeriod = "week";
  var queued = false;

  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; render(); });
  }

  function render() {
    memo = { score: {}, grant: {} };
    renderTabs();
    renderStatus();
    var main = document.getElementById("main");
    var html = "";
    if (view === "today") html = viewToday();
    else if (view === "companies") html = viewCompanies();
    else if (view === "performance") html = viewPerformance();
    else if (view === "sources") html = viewSources();
    else if (view === "settings") html = viewSettings();
    main.innerHTML = html;
    if (sheet && !editing) renderSheet();
  }

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function link(url, label) {
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) return esc(label || url);
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label || shortUrl(url)) + "</a>";
  }
  function shortUrl(u) { return String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 48); }
  function fmtDate(d) {
    if (!d) return "—";
    var x = new Date(String(d).slice(0, 10) + "T12:00:00");
    return isNaN(x) ? esc(d) : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: x.getFullYear() === NOW().getFullYear() ? undefined : "numeric" });
  }
  function ago(d) {
    if (!d) return "never";
    var n = LD.daysBetween(String(d).slice(0, 10), LD.today());
    if (n === 0) return "today";
    if (n === 1) return "yesterday";
    return n + " days ago";
  }

  var TABS = [
    ["today", "Today"], ["companies", "Companies"], ["performance", "Performance"],
    ["sources", "Sources"], ["settings", "Settings"]
  ];
  function renderTabs() {
    var q = cache.companies.filter(inQueue).length;
    document.getElementById("tabs").innerHTML = TABS.map(function (t) {
      var extra = t[0] === "today" && q ? '<span class="count">' + q + "</span>" : "";
      return '<button type="button" class="tab" data-act="nav" data-view="' + t[0] + '"' +
        (view === t[0] ? ' aria-current="page"' : "") + ">" + t[1] + extra + "</button>";
    }).join("");
  }

  var at = { status: "idle", msg: "", lastRead: null };
  function renderStatus() {
    var dbDot = mode === "db" ? "on" : "warn";
    var dbText = mode === "db" ? "Shared desk" : "This browser only";
    var atDot = at.status === "ok" ? "on" : at.status === "error" ? "off" : at.status === "busy" ? "warn" : "";
    var atText = at.status === "busy" ? at.msg || "Talking to Airtable…" :
      at.status === "error" ? "Airtable: " + at.msg :
      at.lastRead ? "Airtable read " + ago(at.lastRead) : "Airtable not read yet";
    var intake = cache.intake.length;
    document.getElementById("status").innerHTML =
      '<span><span class="dot ' + dbDot + '"></span>' + dbText + "</span>" +
      '<span><span class="dot ' + atDot + '"></span>' + esc(atText) + "</span>" +
      (intake ? '<span><span class="dot warn"></span>' + intake + " discovered candidates waiting</span>" : "") +
      (me && me.name ? '<span class="spacer"></span><span>Signed in as ' + esc(me.name) + "</span>" : "");
  }

  /* ---------- fragments ---------- */

  function scoreCell(c) {
    var s = scoreOf(c);
    return '<div class="score" title="Bootcamp priority ' + s.score + " of 100 · " + s.confidence + ' confidence">' +
      '<span class="score-n">' + s.score + "</span>" +
      '<span class="score-bar"><i style="width:' + s.score + '%"></i></span>' +
      '<span class="score-c">' + s.confidence + "</span></div>";
  }
  function grantChip(c) {
    var g = grantOf(c).outcome;
    var cls = g === "Potential referral" ? "good" : g === "Unlikely fit" ? "" : "warn";
    return '<span class="chip ' + cls + '" title="JobsOhio grant pre-screen — a research aid, not an eligibility decision">Grant: ' + esc(g) + "</span>";
  }
  function reviewChip(c) {
    var s = state(c);
    if (s === "approved" && c.review.refreshed) return '<span class="chip warn">Refreshed</span>';
    var map = { "new": ["accent", "New"], investigate: ["warn", "Investigate"], approved: ["good", "Approved"], rejected: ["", "Rejected"] };
    var m = map[s] || ["", s];
    return '<span class="chip ' + m[0] + '">' + m[1] + "</span>";
  }
  var FLAG_TEXT = {
    "conflict": ["warn", "Source conflict"], "stale-profile": ["", "Profile stale"], "no-contact": ["alert", "No contact"],
    "stale-contact": ["warn", "Contact stale"], "contact-changed": ["warn", "Contact changed"],
    "sync-error": ["alert", "Sync failed"], "do-not-contact": ["alert", "Do not contact"]
  };
  function flagChips(c, only) {
    return flagsOf(c).filter(function (f) { return !only || only.indexOf(f) >= 0; }).map(function (f) {
      var t = FLAG_TEXT[f] || ["", f];
      return '<span class="chip ' + t[0] + '">' + t[1] + "</span>";
    }).join("");
  }
  function outreachChip(c) {
    var o = c.outreach;
    if (!o || !o.status || o.status === "Not started") return "";
    var cls = o.optedOut ? "alert" : o.applied || o.replied ? "good" : "accent";
    return '<span class="chip ' + cls + '">' + esc(o.status) + "</span>";
  }

  function leadRow(c) {
    var ct = LD.bestContact(contactsOf(c.id), NOW());
    var who = ct ? (LD.val(ct, "name") || "Contact") + (LD.val(ct, "role") ? ", " + LD.val(ct, "role") : "") : "No contact yet";
    return '<li class="lead" data-act="open-company" data-id="' + esc(c.id) + '" tabindex="0">' +
      scoreCell(c) +
      '<div><div class="lead-name">' + esc(LD.val(c, "name") || "Unnamed") + "</div>" +
      '<div class="lead-meta"><span>' + esc(LD.val(c, "city") || "City unknown") + "</span>" +
      "<span>" + esc(LD.val(c, "industry") || "Industry unknown") + "</span>" +
      "<span>" + esc(who) + "</span></div></div>" +
      '<div class="lead-tags">' + reviewChip(c) + grantChip(c) + flagChips(c, ["conflict", "no-contact", "stale-contact", "sync-error", "do-not-contact"]) + outreachChip(c) + "</div></li>";
  }

  /* ============================================================
     Today
     ============================================================ */

  function weekRange(d) {
    var start = LD.weekStart(LD.today(d));
    var e = new Date(start + "T12:00:00"); e.setDate(e.getDate() + 6);
    return [start, LD.iso(e)];
  }
  function monthRange(d) {
    var s = new Date(d.getFullYear(), d.getMonth(), 1), e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return [LD.iso(s), LD.iso(e)];
  }

  function viewToday() {
    var cs = cache.companies;
    var queue = cs.filter(inQueue);
    var queuePriority = queue.filter(isPriority).length;
    var missing = cs.filter(function (c) { return state(c) !== "rejected" && flagsOf(c).indexOf("no-contact") >= 0; }).length;
    var conflicts = cs.filter(function (c) { return state(c) !== "rejected" && flagsOf(c).indexOf("conflict") >= 0; }).length;
    var syncFail = cs.filter(function (c) { return c.airtable && c.airtable.status === "error"; }).length;
    var changes = cs.filter(highChange).length;
    var stale = cs.filter(function (c) { return state(c) === "approved" && flagsOf(c).indexOf("stale-contact") >= 0; }).length;
    var toSync = cs.filter(needsSync).length;

    function cell(n, label, flag, tone) {
      return '<button type="button" class="pulse-cell ' + (n ? tone || "" : "zero") + '" data-act="filter-flag" data-flag="' + flag + '">' +
        '<span class="n">' + n + '</span><span class="l">' + label + "</span></button>";
    }

    var wk = weekRange(NOW());
    var m = LD.metrics(cs, NOW(), wk[0], wk[1]);
    var pct = Math.min(100, m.firstContacted / 150 * 100);

    queue.sort(function (a, b) {
      var pa = isPriority(a) ? 1 : 0, pb = isPriority(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return scoreOf(b).score - scoreOf(a).score;
    });

    var html = '<div class="view-head"><div><h2>Today</h2><p>New and refreshed leads to review, what is missing, and anything that failed. Cleveland and Akron come first.</p></div>' +
      '<div class="row">' + (toSync ? '<button type="button" class="btn" data-act="sync">Send ' + toSync + " to Airtable</button>" : "") +
      '<button type="button" class="btn ghost" data-act="readback">Read outreach from Airtable</button></div></div>';

    html += '<div class="pulse">' +
      cell(queue.length, "To review" + (queuePriority ? " · " + queuePriority + " Cle/Akron" : ""), "queue", "") +
      cell(missing, "Missing contacts", "no-contact", "warn") +
      cell(conflicts, "Source conflicts", "conflict", "warn") +
      cell(syncFail, "Sync failures", "sync-error", "alert") +
      cell(changes, "High-priority changes", "changes", "warn") +
      cell(stale, "Stale contacts", "stale-contact", "warn") +
      "</div>";

    html += '<div class="pace"><div class="pace-head"><strong class="num">' + m.firstContacted + '</strong><span>companies first-contacted this week</span>' +
      '<span class="muted small">Target 75–125 · week of ' + fmtDate(wk[0]) + " · " + m.discovered + " discovered · " + m.approved + " approved · " + m.synced + " synced</span></div>" +
      '<div class="pace-track" aria-hidden="true"><span class="pace-band" style="left:50%;width:33.3%"></span><span class="pace-fill" style="width:' + pct + '%"></span></div>' +
      '<span class="muted small">First contacts are read back from Airtable, one per company. Discovery volume is counted separately and never stands in for outreach.</span></div>';

    html += '<div class="split"><section><div class="section-title"><h3>Review queue</h3><span class="muted small">' + queue.length + " waiting</span></div>";
    if (!queue.length) {
      html += '<div class="panel empty">' + (cs.length ? "Nothing waiting. New leads land here as they're added or refreshed." :
        'No leads yet. Start with <button type="button" class="btn sm" data-act="open-import">Add leads</button> from an approved Cleveland or Akron source.') + "</div>";
    } else {
      html += '<ul class="leads panel">' + queue.slice(0, 15).map(leadRow).join("") + "</ul>";
      if (queue.length > 15) html += '<p class="muted small"><button type="button" class="btn ghost sm" data-act="filter-flag" data-flag="queue">See all ' + queue.length + "</button></p>";
    }
    html += "</section><aside>";

    if (cache.intake.length) {
      html += '<div class="section-title"><h3>Discovered</h3></div><div class="panel panel-pad" style="margin-bottom:18px"><p style="margin:0 0 8px">' +
        cache.intake.length + " candidates arrived from scheduled discovery. Processing checks each against the desk for duplicates and suppressions before it reaches the queue.</p>" +
        '<button type="button" class="btn primary sm" data-act="process-intake">Process candidates</button></div>';
    }

    var changed = cs.filter(highChange).slice(0, 6);
    if (changed.length) {
      html += '<div class="section-title"><h3>High-priority changes</h3></div><ul class="leads panel" style="margin-bottom:18px">' + changed.map(leadRow).join("") + "</ul>";
    }

    var runs = cache.runs.slice().sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); }).slice(0, 8);
    html += '<div class="section-title"><h3>Recent activity</h3></div><div class="panel">';
    html += runs.length ? runs.map(function (r) {
      return '<div class="contact"><div class="method"><strong>' + esc(r.title) + '</strong><span class="prov">' + fmtDate(r.at) + (r.by ? " · " + esc(nameOf(r.by)) : "") + "</span></div>" +
        '<div class="small muted">' + esc(r.summary || "") + "</div>" +
        (r.errors && r.errors.length ? '<div class="small" style="color:var(--attention)">' + esc(r.errors.slice(0, 3).join(" · ")) + "</div>" : "") + "</div>";
    }).join("") : '<div class="empty">Imports, syncs and read-backs will be logged here.</div>';
    html += "</div></aside></div>";
    return html;
  }

  /* ============================================================
     Companies — search and filter
     ============================================================ */

  function matchesFilters(c) {
    var f = filters;
    if (f.q) {
      var q = f.q.toLowerCase();
      var hay = [LD.val(c, "name"), LD.val(c, "domain"), LD.val(c, "description"), LD.val(c, "industry"), (c.aliases || []).join(" ")]
        .concat(contactsOf(c.id).map(function (ct) { return LD.val(ct, "name"); })).join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (f.region && regionOf(c) !== f.region) return false;
    if (f.mix && (LD.val(c, "customerMix") || "Unknown") !== f.mix) return false;
    if (f.grant && grantOf(c).outcome !== f.grant) return false;
    if (f.review) {
      if (f.review === "refreshed") { if (!(state(c) === "approved" && c.review.refreshed)) return false; }
      else if (state(c) !== f.review) return false;
    }
    if (f.minScore && scoreOf(c).score < Number(f.minScore)) return false;
    if (f.age === "known" && !LD.val(c, "foundedYear")) return false;
    if (f.age === "unknown" && LD.val(c, "foundedYear")) return false;
    if (f.revenue === "unknown" && LD.val(c, "revenueBand")) return false;
    if (f.revenue && f.revenue !== "unknown" && LD.val(c, "revenueBand") !== f.revenue) return false;
    if (f.contact) {
      var ct = LD.bestContact(contactsOf(c.id), NOW());
      var reach = scoreOf(c).parts.reach;
      if (f.contact === "verified" && reach < 15) return false;
      if (f.contact === "any" && !ct) return false;
      if (f.contact === "none" && ct) return false;
    }
    if (f.source && !(c.sources || []).some(function (s) { return s.sourceId === f.source || s.type === f.source; })) return false;
    if (f.fresh) {
      var fl = flagsOf(c);
      var stale = fl.indexOf("stale-profile") >= 0 || fl.indexOf("stale-contact") >= 0;
      if (f.fresh === "fresh" && stale) return false;
      if (f.fresh === "stale" && !stale) return false;
    }
    if (f.outreach) {
      var st = (c.outreach && c.outreach.status) || (c.airtable && c.airtable.recordId ? "Not started" : "Not in Airtable");
      if (st !== f.outreach) return false;
    }
    if (f.flag) {
      if (f.flag === "queue") { if (!inQueue(c)) return false; }
      else if (f.flag === "changes") { if (!highChange(c)) return false; }
      else if (flagsOf(c).indexOf(f.flag) < 0) return false;
      if (f.flag !== "queue" && f.flag !== "sync-error" && state(c) === "rejected") return false;
    }
    return true;
  }

  function opt(value, label, current) {
    return '<option value="' + esc(value) + '"' + (String(current) === String(value) ? " selected" : "") + ">" + esc(label) + "</option>";
  }
  function sel(id, key, options) {
    return '<select id="' + id + '" data-filter="' + key + '">' + options.map(function (o) { return opt(o[0], o[1], filters[key]); }).join("") + "</select>";
  }

  function viewCompanies() {
    var regions = {};
    cache.companies.forEach(function (c) { var r = regionOf(c); if (r) regions[r] = 1; });
    var rows = cache.companies.filter(matchesFilters).sort(function (a, b) { return scoreOf(b).score - scoreOf(a).score; });
    var flagLabel = { queue: "In the review queue", changes: "High-priority changes" };
    Object.keys(FLAG_TEXT).forEach(function (k) { flagLabel[k] = FLAG_TEXT[k][1]; });

    var html = '<div class="view-head"><div><h2>Companies</h2><p>Every company the desk knows, with its evidence. Scores recalculate as facts or cohort dates change.</p></div></div>';
    html += '<div class="filters">' +
      '<label class="field">Search<input type="search" id="f-q" data-filter="q" value="' + esc(filters.q) + '" placeholder="Name, domain, person, industry"></label>' +
      '<label class="field">City' + sel("f-region", "region", [["", "All cities"]].concat(Object.keys(regions).sort().map(function (r) { return [r, r]; }))) + "</label>" +
      '<label class="field">Review' + sel("f-review", "review", [["", "Any"], ["new", "New"], ["refreshed", "Refreshed"], ["investigate", "Investigate"], ["approved", "Approved"], ["rejected", "Rejected"]]) + "</label>" +
      '<label class="field">Minimum score<input type="number" id="f-min" data-filter="minScore" min="0" max="100" step="5" value="' + esc(filters.minScore) + '"></label>' +
      '<label class="field">Customers' + sel("f-mix", "mix", [["", "Any"], ["B2B", "B2B"], ["Mixed", "Mixed"], ["B2C", "B2C"], ["Unknown", "Unknown"]]) + "</label>" +
      '<label class="field">Grant pre-screen' + sel("f-grant", "grant", [["", "Any"], ["Potential referral", "Potential referral"], ["Needs review", "Needs review"], ["Unlikely fit", "Unlikely fit"]]) + "</label>" +
      '<label class="field">Contact' + sel("f-contact", "contact", [["", "Any"], ["verified", "Verified decision maker"], ["any", "Has a contact"], ["none", "No contact"]]) + "</label>" +
      '<label class="field">Company age' + sel("f-age", "age", [["", "Any"], ["known", "Evidence found"], ["unknown", "Unknown"]]) + "</label>" +
      '<label class="field">Revenue' + sel("f-rev", "revenue", [["", "Any"], ["unknown", "Unknown"]].concat(LD.REVENUE_BANDS.map(function (b) { return [b.id, b.label]; }))) + "</label>" +
      '<label class="field">Source' + sel("f-src", "source", [["", "Any"]].concat(cache.sources.map(function (s) { return [s.id, s.name]; })).concat(LD.SOURCE_TYPES.map(function (t) { return [t, "Type: " + t]; }))) + "</label>" +
      '<label class="field">Freshness' + sel("f-fresh", "fresh", [["", "Any"], ["fresh", "Fresh"], ["stale", "Stale"]]) + "</label>" +
      '<label class="field">Outreach' + sel("f-out", "outreach", [["", "Any"], ["Not in Airtable", "Not in Airtable"], ["Not started", "Not started"], ["Contacted", "Contacted"], ["Replied", "Replied"], ["Applied", "Applied"], ["Attended", "Attended"], ["Not interested", "Not interested"], ["Opted out", "Opted out"]]) + "</label>" +
      "</div>";
    if (filters.flag) {
      html += '<p class="row"><span class="chip accent">' + esc(flagLabel[filters.flag] || filters.flag) + '</span><button type="button" class="btn ghost sm" data-act="clear-flag">Clear</button></p>';
    }
    html += '<p class="muted small">' + rows.length + " of " + cache.companies.length + " companies" + (rows.length > 300 ? " · showing the top 300 by score" : "") + "</p>";
    if (!rows.length) return html + '<div class="panel empty">No companies match these filters.</div>';

    html += '<div class="table-wrap"><table class="data"><thead><tr><th>Score</th><th>Company</th><th>City</th><th>Customers</th><th>Grant</th><th>Decision maker</th><th>Review</th><th>Outreach</th><th>Verified</th></tr></thead><tbody>';
    rows.slice(0, 300).forEach(function (c) {
      var s = scoreOf(c);
      var ct = LD.bestContact(contactsOf(c.id), NOW());
      html += '<tr class="click" data-act="open-company" data-id="' + esc(c.id) + '">' +
        '<td class="num"><span class="score-n" style="font-size:15px">' + s.score + '</span> <span class="muted small">' + s.confidence[0] + "</span></td>" +
        "<td><strong>" + esc(LD.val(c, "name")) + '</strong><div class="muted small">' + esc(LD.val(c, "domain") || "no domain") + "</div></td>" +
        "<td>" + esc(LD.val(c, "city") || "—") + "</td>" +
        "<td>" + esc(LD.val(c, "customerMix") || "Unknown") + "</td>" +
        "<td>" + grantChip(c) + "</td>" +
        "<td>" + (ct ? esc(LD.val(ct, "name") || "—") + (s.parts.reach >= 15 ? ' <span class="chip good">Verified</span>' : "") : '<span class="muted">None</span>') + "</td>" +
        "<td>" + reviewChip(c) + "</td>" +
        "<td>" + (outreachChip(c) || '<span class="muted small">' + (c.airtable && c.airtable.recordId ? "Not started" : "—") + "</span>") + "</td>" +
        '<td class="small">' + fmtDate(c.verifiedAt) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  /* ============================================================
     Performance
     ============================================================ */

  function viewPerformance() {
    var cs = cache.companies;
    var range = perfPeriod === "week" ? weekRange(NOW()) : monthRange(NOW());
    var m = LD.metrics(cs, NOW(), range[0], range[1]);
    var target = perfPeriod === "week" ? "75–125" : "300–500";

    var approved = cs.filter(function (c) { return state(c) === "approved"; });
    var verified = approved.filter(function (c) { return scoreOf(c).parts.reach >= 15; }).length;
    var fresh = approved.filter(function (c) { return c.verifiedAt && LD.daysBetween(c.verifiedAt, LD.today()) <= LD.PROFILE_STALE_DAYS; }).length;
    var corrected = approved.filter(function (c) {
      return Object.keys(c.f || {}).some(function (k) { return c.f[k].by === "human" && c.f[k].src !== "Import"; }) ||
        (c.conflicts || []).some(function (x) { return x.resolved; }) || c.override;
    }).length;
    var ingested = 0, merged = 0;
    cache.runs.forEach(function (r) { if (r.counts) { ingested += (r.counts.created || 0) + (r.counts.merged || 0); merged += r.counts.merged || 0; } });
    function pct(a, b) { return b ? Math.round(a / b * 100) + "%" : "—"; }

    var html = '<div class="view-head"><div><h2>Performance</h2><p>Each number is a distinct count of companies at that stage, so discovery never masquerades as outreach or enrolment.</p></div>' +
      '<div class="seg" role="group" aria-label="Period"><button type="button" data-act="perf" data-p="week" aria-pressed="' + (perfPeriod === "week") + '">This week</button>' +
      '<button type="button" data-act="perf" data-p="month" aria-pressed="' + (perfPeriod === "month") + '">This month</button></div></div>';

    function stat(n, l, s) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + "</div>" + (s ? '<div class="s">' + s + "</div>" : "") + "</div>"; }
    html += '<div class="section-title"><h3>Funnel · ' + fmtDate(range[0]) + " – " + fmtDate(range[1]) + "</h3></div>";
    html += '<div class="stat-grid" style="margin-bottom:22px">' +
      stat(m.discovered, "Discovered") + stat(m.approved, "Approved") + stat(m.synced, "Synced to Airtable") +
      stat(m.firstContacted, "First-contacted", "Target " + target) + stat(m.replies, "Replied") +
      stat(m.applications, "Applied") + stat(m.attendance, "Attended") + stat(m.grantReferrals, "Grant referrals", "Interest confirmed or beyond") + "</div>";

    html += '<div class="split"><section>';
    html += '<div class="section-title"><h3>Weekly first contacts</h3><span class="muted small">Band = 75–125 target</span></div>';
    html += '<div class="panel panel-pad chart">' + paceChart(cs) + "</div>";

    html += '<div class="section-title" style="margin-top:22px"><h3>Quality</h3></div><div class="stat-grid">' +
      stat(pct(verified, approved.length), "Verified-contact rate", verified + " of " + approved.length + " approved") +
      stat(pct(merged, ingested), "Duplicate rate", merged + " of " + ingested + " imported rows matched an existing company") +
      stat(pct(corrected, approved.length), "Manual-correction rate", corrected + " approved profiles edited by a researcher") +
      stat(pct(fresh, approved.length), "Fresh profiles", "Verified in the last " + LD.PROFILE_STALE_DAYS + " days") +
      "</div></section><aside>";

    html += '<div class="section-title"><h3>First contacts by city</h3></div><div class="panel panel-pad">' + mix(m.byCity) + "</div>";
    html += '<div class="section-title" style="margin-top:18px"><h3>Discovered by source</h3></div><div class="panel panel-pad">' + mix(m.bySource) + "</div>";
    html += '<div class="section-title" style="margin-top:18px"><h3>Founder-network coverage</h3></div><div class="panel panel-pad"><p style="margin:0">' +
      "<strong>" + pct(m.founderNetwork, m.discovered) + "</strong> of companies discovered this " + perfPeriod + " came through Black, Brown or women founder networks (" + m.founderNetwork + " of " + m.discovered + ").</p>" +
      '<p class="muted small" style="margin:6px 0 0">Measured by where we sourced, never by guessing anyone\'s identity. Identity is recorded only when an owner provides it or it is reliably public, and it never affects a score.</p></div>';
    html += "</aside></div>";
    return html;
  }

  function mix(obj) {
    var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
    if (!keys.length) return '<p class="muted small" style="margin:0">Nothing in this period yet.</p>';
    var max = obj[keys[0]];
    return '<div class="mix">' + keys.slice(0, 10).map(function (k) {
      return '<div class="mix-row"><span>' + esc(k) + '</span><span class="bar"><i style="width:' + (obj[k] / max * 100) + '%"></i></span><span class="num">' + obj[k] + "</span></div>";
    }).join("") + "</div>";
  }

  function paceChart(cs) {
    var weeks = [];
    var start = new Date(LD.weekStart(LD.today()) + "T12:00:00");
    for (var i = 7; i >= 0; i--) {
      var s = new Date(start); s.setDate(s.getDate() - i * 7);
      var e = new Date(s); e.setDate(e.getDate() + 6);
      var from = LD.iso(s), to = LD.iso(e);
      var n = cs.filter(function (c) { var d = c.outreach && c.outreach.firstContactAt; return d && d >= from && d <= to; }).length;
      weeks.push({ from: from, n: n });
    }
    var W = 560, H = 200, L = 34, R = 8, T = 10, B = 24;
    var max = Math.max(150, Math.max.apply(null, weeks.map(function (w) { return w.n; })));
    max = Math.ceil(max / 50) * 50;
    function y(v) { return T + (H - T - B) * (1 - v / max); }
    var bw = (W - L - R) / weeks.length;
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="First contacts per week for the last eight weeks against the 75 to 125 target">';
    svg += '<rect x="' + L + '" y="' + y(125) + '" width="' + (W - L - R) + '" height="' + (y(75) - y(125)) + '" fill="var(--accent-wash)"/>';
    for (var g = 0; g <= max; g += 50) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--line)" stroke-width="1"/>';
      svg += '<text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g + "</text>";
    }
    weeks.forEach(function (w, i) {
      var x = L + i * bw + bw * 0.2, h = y(0) - y(w.n);
      var last = i === weeks.length - 1;
      svg += '<rect x="' + x + '" y="' + y(w.n) + '" width="' + (bw * 0.6) + '" height="' + Math.max(0, h) + '" rx="2" fill="' + (last ? "var(--accent)" : "var(--accent-line)") + '"/>';
      if (w.n) svg += '<text x="' + (x + bw * 0.3) + '" y="' + (y(w.n) - 4) + '" text-anchor="middle">' + w.n + "</text>";
      var d = new Date(w.from + "T12:00:00");
      svg += '<text x="' + (x + bw * 0.3) + '" y="' + (H - 6) + '" text-anchor="middle">' + (d.getMonth() + 1) + "/" + d.getDate() + "</text>";
    });
    return svg + "</svg>";
  }

  /* ============================================================
     Sources
     ============================================================ */

  function sourceStats(s) {
    var n = { discovered: 0, approved: 0, contacted: 0, replied: 0 };
    cache.companies.forEach(function (c) {
      if (!(c.sources || []).some(function (x) { return x.sourceId === s.id; })) return;
      n.discovered++;
      if (state(c) === "approved") n.approved++;
      if (c.outreach && c.outreach.firstContactAt) n.contacted++;
      if (c.outreach && c.outreach.replied) n.replied++;
    });
    return n;
  }

  function viewSources() {
    var list = cache.sources.slice().sort(function (a, b) {
      var o = { Approved: 0, Proposed: 1, Paused: 2 };
      return (o[a.status] || 0) - (o[b.status] || 0) || String(a.city).localeCompare(String(b.city)) || String(a.name).localeCompare(String(b.name));
    });
    var html = '<div class="view-head"><div><h2>Sources</h2><p>Only approved sources can feed the desk. Each keeps its access rules, so nobody scrapes what a source asks us not to. Tune these by replies and applications, not by volume.</p></div>' +
      '<button type="button" class="btn primary" data-act="open-source">Add a source</button></div>';
    if (!list.length) return html + '<div class="panel empty">No sources yet. Add the Cleveland and Akron directories, chambers and founder networks you plan to use.</div>';
    html += '<div class="table-wrap"><table class="data"><thead><tr><th>Source</th><th>City</th><th>Type</th><th>Status</th><th class="num">Found</th><th class="num">Approved</th><th class="num">Contacted</th><th class="num">Replied</th><th>Last run</th></tr></thead><tbody>';
    list.forEach(function (s) {
      var n = sourceStats(s);
      var st = s.status === "Approved" ? "good" : s.status === "Paused" ? "" : "warn";
      html += '<tr class="click" data-act="open-source" data-id="' + esc(s.id) + '"><td><strong>' + esc(s.name) + "</strong>" +
        (s.network ? ' <span class="chip lamp">Founder network</span>' : "") +
        '<div class="small">' + link(s.url) + "</div>" + (s.access ? '<div class="muted small">' + esc(s.access) + "</div>" : "") + "</td>" +
        "<td>" + esc(s.city || "Ohio") + "</td><td>" + esc(s.type || "") + '</td><td><span class="chip ' + st + '">' + esc(s.status || "Proposed") + "</span></td>" +
        '<td class="num">' + n.discovered + '</td><td class="num">' + n.approved + '</td><td class="num">' + n.contacted + '</td><td class="num">' + n.replied + (n.contacted ? ' <span class="muted small">' + Math.round(n.replied / n.contacted * 100) + "%</span>" : "") + "</td>" +
        '<td class="small">' + fmtDate(s.lastRunAt) + "</td></tr>";
    });
    return html + "</tbody></table></div>";
  }

  /* ============================================================
     Settings
     ============================================================ */

  function viewSettings() {
    var s = settings();
    var html = '<div class="view-head"><div><h2>Settings</h2><p>Where approved leads go, which cities come first, and who must never be contacted again.</p></div></div>';
    html += '<div class="split"><section>';

    html += '<div class="section-title"><h3>Cohort dates</h3></div><div class="panel panel-pad" style="margin-bottom:18px">' +
      '<p class="muted small" style="margin:0 0 10px">A confirmed cohort within 90 days lifts that city to full priority points. Scores recalculate the moment these change.</p>';
    html += s.cohorts.length ? '<ul class="plain" style="margin:0 0 10px">' + s.cohorts.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).map(function (c, i) {
      return "<li>" + esc(c.city) + " · " + fmtDate(c.date) + (c.date < LD.today() ? ' <span class="muted small">past</span>' : "") +
        ' <button type="button" class="btn ghost sm" data-act="rm-cohort" data-city="' + esc(c.city) + '" data-date="' + esc(c.date) + '">Remove</button></li>';
    }).join("") + "</ul>" : '<p class="muted small">No cohort dates yet.</p>';
    html += '<div class="row"><select id="co-city" style="width:auto">' + LD.PRIORITY_CITIES.concat(LD.EXPANSION_CITIES).map(function (c) { return opt(c, c, ""); }).join("") + "</select>" +
      '<input type="date" id="co-date" style="width:auto"><button type="button" class="btn sm" data-act="add-cohort">Add cohort</button></div></div>';

    html += '<div class="section-title"><h3>Priority cities</h3></div><div class="panel panel-pad" style="margin-bottom:18px">' +
      '<label class="field">Cities that always get full city points (comma-separated)<input type="text" id="set-cities" value="' + esc(s.priorityCities.join(", ")) + '"></label>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-act="save-cities">Save</button><span class="muted small">Suburbs roll up automatically — Lakewood counts as Cleveland, Cuyahoga Falls as Akron.</span></div></div>';

    html += '<div class="section-title"><h3>Airtable</h3></div><div class="panel panel-pad" style="margin-bottom:18px"><div class="grid-form">' +
      '<label class="field">Base ID<input type="text" id="at-base" value="' + esc(s.airtable.baseId) + '"></label>' +
      '<label class="field">Companies table ID<input type="text" id="at-co" value="' + esc(s.airtable.companiesTable) + '"></label>' +
      '<label class="field">Contacts table ID<input type="text" id="at-ct" value="' + esc(s.airtable.contactsTable) + '"></label></div>' +
      '<div class="row" style="margin-top:10px"><button type="button" class="btn sm" data-act="save-airtable">Save</button><button type="button" class="btn sm" data-act="test-airtable">Check connection</button></div>' +
      '<p class="muted small" style="margin:8px 0 0">The desk writes research fields and upserts on <span class="mono">External ID</span>, so a retry can never create a duplicate. It never writes outreach status, owner, dates or replies — those belong to the team in Airtable and are only read back.</p></div>';

    html += "</section><aside>";
    html += '<div class="section-title"><h3>Do not contact</h3><span class="muted small">' + s.suppression.length + "</span></div><div class=\"panel panel-pad\">" +
      '<p class="muted small" style="margin:0 0 10px">Opt-outs from Airtable land here automatically. A suppressed company is never queued again, even if a new source lists it.</p>' +
      '<div class="row" style="margin-bottom:10px"><input type="text" id="sup-v" placeholder="domain.com or company name" style="flex:1;min-width:0"><button type="button" class="btn sm" data-act="add-sup">Add</button></div>';
    html += s.suppression.length ? '<ul class="plain" style="margin:0;max-height:320px;overflow:auto">' + s.suppression.map(function (x, i) {
      return "<li>" + esc(x.domain || x.name) + ' <span class="muted small">' + esc(x.reason || "") + (x.at ? " · " + fmtDate(x.at) : "") + '</span> <button type="button" class="btn ghost sm" data-act="rm-sup" data-i="' + i + '">Remove</button></li>';
    }).join("") + "</ul>" : "";
    html += "</div>";

    html += '<div class="section-title" style="margin-top:18px"><h3>Ground rules</h3></div><div class="panel panel-pad small"><ul class="plain" style="margin:0">' +
      "<li>Every consequential fact keeps its source and verification date; anything not found is marked unknown.</li>" +
      "<li>Business contact information only — the owner or decision maker, business email and phone, individual and company LinkedIn.</li>" +
      "<li>A researcher approves every export. A verified human edit is never overwritten by a refresh.</li>" +
      "<li>Founder identity is recorded only when provided or reliably public, with its source. It is never inferred from names or photos and never scored.</li>" +
      "<li>A JobsOhio referral needs confirmed business interest and permission to share. JobsOhio makes eligibility and award decisions; a company that misses the pre-screen stays a Bootcamp prospect.</li>" +
      "</ul></div>";
    html += "</aside></div>";
    return html;
  }

  /* ============================================================
     Sheet — company detail
     ============================================================ */

  var FIELD_LABELS = {
    name: "Company name", domain: "Domain", website: "Website", companyLinkedin: "Company LinkedIn", city: "City",
    description: "Description", industry: "Industry", customerMix: "Customer mix", foundedYear: "Year founded",
    employees: "Employees", revenueBand: "Annual revenue", parentOver25M: "Parent company at or above $25M",
    hiring: "Hiring signal", expansion: "Expansion signal", investment: "Planned investment",
    growth: "10% job/payroll growth or at-risk retention", financing: "Can finance before reimbursement",
    targetIndustry: "JobsOhio target industry", engagement: "Engagement signal",
    ownerIdentity: "Founder identity (self-reported or public)"
  };
  var FACT_ORDER = ["name", "website", "domain", "companyLinkedin", "city", "description", "industry", "customerMix",
    "foundedYear", "employees", "revenueBand", "hiring", "expansion", "engagement", "ownerIdentity"];
  var TRI_FIELDS = ["parentOver25M", "growth", "financing", "targetIndustry"];

  function openSheet(s) { sheet = s; editing = null; renderSheet(); }
  function closeSheet() {
    sheet = null; editing = null;
    document.getElementById("sheet").hidden = true;
    document.getElementById("scrim").hidden = true;
  }

  function renderSheet() {
    var el = document.getElementById("sheet");
    var html = "";
    if (sheet.kind === "company") html = sheetCompany(find("companies", sheet.id));
    else if (sheet.kind === "import") html = sheetImport();
    else if (sheet.kind === "source") html = sheetSource(sheet.id ? find("sources", sheet.id) : null);
    if (html === null) { closeSheet(); return; }
    var scroll = el.querySelector(".sheet-body");
    var top = scroll ? scroll.scrollTop : 0;
    el.innerHTML = html;
    el.hidden = false;
    document.getElementById("scrim").hidden = false;
    var body = el.querySelector(".sheet-body");
    if (body) body.scrollTop = top;
  }

  function factValue(field, f) {
    if (!f || LD.blank(f.v) || f.v === "unknown") return '<span class="unknown">Unknown</span>';
    var v = f.v;
    if (field === "website" || field === "companyLinkedin") return link(v);
    if (field === "revenueBand") return esc(LD.bandLabel(v));
    if (TRI_FIELDS.indexOf(field) >= 0) return esc(v === "yes" ? "Yes" : v === "no" ? "No" : v);
    return esc(v);
  }
  function provenance(f) {
    if (!f || LD.blank(f.v)) return "";
    var who = f.by === "human" ? "Researcher" : "";
    var where = f.src && f.src !== "Researcher" ? link(f.src) : who ? "" : "no source";
    return '<span class="prov">' + [who, where].filter(Boolean).join(" · ") + " · verified " + fmtDate(f.at) + "</span>";
  }

  function editor(field, cur) {
    var v = cur && cur.v !== undefined ? cur.v : "";
    var input;
    if (field === "customerMix") input = '<select id="ed-v">' + ["", "B2B", "Mixed", "B2C", "unknown"].map(function (o) { return opt(o, o || "—", v); }).join("") + "</select>";
    else if (field === "revenueBand") input = '<select id="ed-v">' + [["", "—"], ["unknown", "Unknown"]].concat(LD.REVENUE_BANDS.map(function (b) { return [b.id, b.label]; })).map(function (o) { return opt(o[0], o[1], v); }).join("") + "</select>";
    else if (TRI_FIELDS.indexOf(field) >= 0) input = '<select id="ed-v">' + [["unknown", "Unknown"], ["yes", "Yes"], ["no", "No"]].map(function (o) { return opt(o[0], o[1], v); }).join("") + "</select>";
    else if (field === "description" || field === "hiring" || field === "expansion" || field === "investment" || field === "engagement") input = '<textarea id="ed-v" style="min-height:60px">' + esc(v) + "</textarea>";
    else input = '<input type="' + (field === "foundedYear" || field === "employees" ? "number" : "text") + '" id="ed-v" value="' + esc(v) + '">';
    var needSrc = field === "ownerIdentity";
    return '<div class="inline-edit">' + input +
      '<input type="text" id="ed-src" placeholder="' + (needSrc ? "Where the owner stated this (required)" : "Source URL, or leave blank for your own research") + '" value="' + esc(cur && cur.by === "human" ? cur.src : "") + '">' +
      (needSrc ? '<span class="muted small">Only what the owner provided or a reliable public source states. Never inferred, never scored.</span>' : "") +
      '<div class="row"><button type="button" class="btn primary sm" data-act="save-fact" data-field="' + field + '">Save</button><button type="button" class="btn ghost sm" data-act="cancel-edit">Cancel</button></div></div>';
  }

  function sheetCompany(c) {
    if (!c) return null;
    var s = scoreOf(c), g = grantOf(c);
    var cts = contactsOf(c.id);
    var st = state(c);
    var o = c.outreach || {};

    var h = '<div class="sheet-head"><div style="flex:1;min-width:0"><h2 id="sheet-title">' + esc(LD.val(c, "name") || "Unnamed") + "</h2>" +
      '<div class="lead-meta">' + (LD.val(c, "website") ? link(LD.val(c, "website")) : "<span>No website</span>") +
      "<span>" + esc(LD.val(c, "city") || "City unknown") + (regionOf(c) && regionOf(c) !== LD.val(c, "city") ? " · " + esc(regionOf(c)) + " area" : "") + "</span>" +
      (c.aliases && c.aliases.length ? "<span>Also listed as " + esc(c.aliases.join(", ")) + "</span>" : "") + "</div>" +
      '<div class="lead-tags" style="justify-content:flex-start;margin-top:6px">' + reviewChip(c) + grantChip(c) + flagChips(c) + outreachChip(c) + "</div></div>" +
      '<button type="button" class="btn ghost" data-act="close" aria-label="Close">✕</button></div>';

    h += '<div class="sheet-body">';

    /* review actions */
    h += '<div class="block"><div class="row">';
    if (c.doNotContact) h += '<div class="notice alert" style="flex:1">Do not contact. This company opted out or is suppressed; it stays on file so it is never rediscovered.</div>';
    else if (st !== "approved") h += '<button type="button" class="btn good" data-act="approve">Approve for outreach</button>';
    else if (c.review.refreshed) h += '<button type="button" class="btn good" data-act="ack-refresh">Mark refresh reviewed</button>';
    if (st !== "investigate" && st !== "rejected") h += '<button type="button" class="btn" data-act="investigate">Investigate</button>';
    if (st !== "rejected") h += '<button type="button" class="btn danger" data-act="reject">Reject</button>';
    if (st === "rejected" || st === "investigate") h += '<button type="button" class="btn ghost" data-act="reopen">Back to queue</button>';
    if (st === "approved" && !c.doNotContact) h += '<span class="spacer"></span><button type="button" class="btn primary" data-act="sync-one">' + (c.airtable && c.airtable.recordId ? "Update in Airtable" : "Send to Airtable") + "</button>";
    h += "</div>";
    if (editing === "note") {
      h += '<div class="inline-edit"><textarea id="rv-note" placeholder="' + (sheet.pending === "reject" ? "Why reject? e.g. outside Ohio, closed, not a fit for Bootcamp" : "What needs checking?") + '"></textarea>' +
        '<div class="row"><button type="button" class="btn primary sm" data-act="confirm-review">' + (sheet.pending === "reject" ? "Reject" : "Send to investigate") + '</button><button type="button" class="btn ghost sm" data-act="cancel-edit">Cancel</button></div></div>';
    }
    var rv = c.review || {};
    if (rv.note || rv.by) h += '<p class="muted small" style="margin:8px 0 0">' + esc(rv.state === "approved" ? "Approved" : rv.state === "rejected" ? "Rejected" : rv.state === "investigate" ? "Sent to investigate" : "Added") +
      (rv.by ? " by " + esc(nameOf(rv.by)) : "") + (rv.at ? " · " + fmtDate(rv.at) : "") + (rv.note ? " — " + esc(rv.note) : "") + "</p>";
    if (c.airtable && c.airtable.status === "error") h += '<div class="notice alert" style="margin-top:8px">Last sync failed: ' + esc(c.airtable.error || "unknown error") + ". Sending again is safe — the desk updates the same Airtable row instead of making a new one.</div>";
    else if (c.airtable && c.airtable.syncedAt) h += '<p class="muted small" style="margin:6px 0 0">In Airtable since ' + fmtDate(c.airtable.firstSyncedAt) + " · last sent " + fmtDate(c.airtable.syncedAt) + "</p>";
    h += "</div>";

    /* conflicts */
    var open = (c.conflicts || []).map(function (x, i) { return [x, i]; }).filter(function (p) { return !p[0].resolved; });
    if (open.length) {
      h += '<div class="block"><h3>Conflicting evidence</h3><div class="panel">';
      open.forEach(function (p) {
        var x = p[0];
        h += '<div class="conflict"><strong>' + esc(FIELD_LABELS[x.field] || x.field) + "</strong>" +
          '<div class="method"><span>Kept: ' + factValue(x.field, c.f[x.field]) + "</span>" + provenance(c.f[x.field]) + "</div>" +
          '<div class="method"><span>' + (sameFact(c.f[x.field], x.incoming) ? "Was" : "New") + ": " + factValue(x.field, sameFact(c.f[x.field], x.incoming) ? x.current : x.incoming) + "</span>" + provenance(sameFact(c.f[x.field], x.incoming) ? x.current : x.incoming) + "</div>" +
          '<div class="row"><button type="button" class="btn sm" data-act="resolve" data-i="' + p[1] + '" data-pick="kept">Confirm kept value</button>' +
          '<button type="button" class="btn sm" data-act="resolve" data-i="' + p[1] + '" data-pick="other">Use the other value</button></div></div>';
      });
      h += "</div></div>";
    }

    /* score */
    var P = s.parts;
    function bar(label, v, max) {
      return '<div class="bd-row"><span>' + label + '</span><span class="bd-track"><i style="width:' + (v / max * 100) + '%"></i></span><span class="num">' + v + "/" + max + "</span></div>";
    }
    h += '<div class="block"><h3>Bootcamp priority · <span class="mono" style="color:var(--lamp)">' + s.score + "</span> · " + s.confidence + " confidence</h3>" +
      '<div class="panel panel-pad"><div class="breakdown">' +
      bar("Priority city or cohort", P.place, 25) + bar("Relevance and growth need", P.fit, 25) +
      bar("Traction, hiring, expansion", P.traction, 20) + bar("Reachable decision maker", P.reach, 15) + bar("Timeliness and engagement", P.timing, 15) + "</div>";
    if (s.reasons.length) h += '<ul class="plain small">' + s.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
    if (s.missing.length) h += '<p class="small" style="margin:8px 0 0"><strong>To research:</strong> ' + esc(s.missing.join(" · ")) + '<br><span class="muted">Unknowns lower confidence; they are not evidence against the company.</span></p>';
    if (s.override) h += '<div class="notice" style="margin-top:10px">Manual score ' + s.override.score + " (computed " + s.computed + ") — " + esc(s.override.reason) + '<span class="muted small"> · ' + esc(nameOf(s.override.by)) + " · " + fmtDate(s.override.at) + '</span> <button type="button" class="btn ghost sm" data-act="clear-override">Remove</button></div>';
    if (editing === "override") {
      h += '<div class="inline-edit"><input type="number" id="ov-score" min="0" max="100" placeholder="Score 0–100"><input type="text" id="ov-reason" placeholder="Reason (required) — e.g. warm intro from a partner">' +
        '<div class="row"><button type="button" class="btn primary sm" data-act="save-override">Save override</button><button type="button" class="btn ghost sm" data-act="cancel-edit">Cancel</button></div></div>';
    } else if (!s.override) h += '<p style="margin:10px 0 0"><button type="button" class="edit-btn" data-act="edit" data-field="override">Override this score…</button></p>';
    h += "</div></div>";

    /* contacts */
    h += '<div class="block"><h3>Owner and contacts</h3><div class="panel">';
    if (!cts.length) h += '<div class="empty">No contact yet. Look for the owner or decision maker on the company site, LinkedIn or the source listing.</div>';
    cts.forEach(function (ct) {
      h += '<div class="contact"><div class="method"><strong>' + esc(LD.val(ct, "name") || "Unnamed contact") + "</strong>" +
        (LD.val(ct, "role") ? "<span>" + esc(LD.val(ct, "role")) + "</span>" : "") +
        (ct.decisionMaker ? '<span class="chip accent">Decision maker</span>' : "") +
        (ct.doNotContact ? '<span class="chip alert">Do not contact</span>' : "") +
        (ct.changed ? '<span class="chip warn">Changed ' + fmtDate(ct.changed) + "</span>" : "") + "</div>";
      ["email", "phone", "linkedin"].forEach(function (m) {
        var f = ct.f[m];
        if (!f || !f.v) return;
        var stale = m !== "linkedin" && LD.daysBetween(f.at, LD.today()) > LD.CONTACT_STALE_DAYS;
        h += '<div class="method"><span class="mono small">' + (m === "linkedin" ? link(f.v, "LinkedIn profile") : esc(f.v)) + "</span>" + provenance(f) +
          (stale ? '<span class="chip warn">Stale</span>' : "") +
          '<button type="button" class="edit-btn" data-act="verify-method" data-ct="' + esc(ct.id) + '" data-m="' + m + '">Mark verified today</button></div>';
      });
      h += '<div class="row"><button type="button" class="btn ghost sm" data-act="toggle-dm" data-ct="' + esc(ct.id) + '">' + (ct.decisionMaker ? "Not the decision maker" : "Decision maker") + "</button>" +
        '<button type="button" class="btn ghost sm" data-act="toggle-dnc" data-ct="' + esc(ct.id) + '">' + (ct.doNotContact ? "Allow contact" : "Do not contact") + "</button></div></div>";
    });
    h += "</div>";
    if (editing === "contact") {
      h += '<div class="panel panel-pad" style="margin-top:8px"><div class="grid-form">' +
        '<label class="field">Name<input type="text" id="nc-name"></label><label class="field">Role<input type="text" id="nc-role" placeholder="Owner, Founder, CEO…"></label>' +
        '<label class="field">Business email<input type="email" id="nc-email"></label><label class="field">Business phone<input type="text" id="nc-phone"></label>' +
        '<label class="field">LinkedIn<input type="url" id="nc-li"></label><label class="field">Where you found it<input type="url" id="nc-src" placeholder="https://…"></label></div>' +
        '<div class="row" style="margin-top:10px"><button type="button" class="btn primary sm" data-act="save-contact">Add contact</button><button type="button" class="btn ghost sm" data-act="cancel-edit">Cancel</button></div></div>';
    } else h += '<p style="margin:8px 0 0"><button type="button" class="edit-btn" data-act="edit" data-field="contact">Add a contact…</button></p>';
    h += "</div>";

    /* facts */
    h += '<div class="block"><h3>Profile and evidence</h3><div class="facts">';
    FACT_ORDER.forEach(function (k) {
      var f = c.f[k];
      h += '<div class="k">' + esc(FIELD_LABELS[k]) + '</div><div class="v">';
      if (editing === k) h += editor(k, f);
      else h += "<span>" + factValue(k, f) + "</span>" + provenance(f) + '<button type="button" class="edit-btn" data-act="edit" data-field="' + k + '">' + (f && !LD.blank(f.v) ? "Edit" : "Add") + "</button>";
      h += "</div>";
    });
    h += "</div>";
    h += '<p style="margin:8px 0 0"><button type="button" class="btn sm" data-act="edit" data-field="enrich">Research with Claude…</button></p>';
    if (editing === "enrich") h += enrichPanel();
    h += "</div>";

    /* grant */
    h += '<div class="block"><h3>JobsOhio grant pre-screen · ' + esc(g.outcome) + "</h3>" +
      '<div class="panel">' + g.items.map(function (it) {
        var fld = { industry: "targetIndustry", growth: "growth", financing: "financing" }[it.key];
        var ctl = "";
        if (fld) {
          var cur = LD.val(c, fld) || "unknown";
          ctl = '<span class="tri" role="group" aria-label="' + esc(it.label) + '">' + ["yes", "no", "unknown"].map(function (a) {
            return '<button type="button" class="' + a + '" aria-pressed="' + (cur === a) + '" data-act="tri" data-field="' + fld + '" data-v="' + a + '">' + (a === "unknown" ? "?" : a[0].toUpperCase() + a.slice(1)) + "</button>";
          }).join("") + "</span>";
        } else if (it.key === "revenue") {
          var pc = LD.val(c, "parentOver25M") || "unknown";
          ctl = '<span class="tri" role="group" aria-label="Parent company at or above $25M">' + ["yes", "no", "unknown"].map(function (a) {
            return '<button type="button" class="' + (a === "yes" ? "no" : a === "no" ? "yes" : a) + '" aria-pressed="' + (pc === a) + '" data-act="tri" data-field="parentOver25M" data-v="' + a + '" title="Parent company at or above $25M?">' + (a === "yes" ? "Parent ≥$25M" : a === "no" ? "No big parent" : "?") + "</button>";
          }).join("") + "</span>";
        } else {
          ctl = '<span class="chip ' + (it.answer === "yes" ? "good" : it.answer === "no" ? "alert" : "") + '">' + (it.answer === "yes" ? "Yes" : it.answer === "no" ? "No" : "Unknown") + "</span>";
        }
        return '<div class="check"><div><div>' + esc(it.label) + '</div><div class="muted small">' + esc(it.why) + "</div></div>" + ctl + "</div>";
      }).join("") + "</div>" +
      '<p class="muted small" style="margin:8px 0 0">A research aid, not an eligibility decision — JobsOhio decides. Projects may receive up to $50,000, generally as reimbursement. A referral needs the company\'s confirmed interest and permission to share its information. Missing the grant never removes a Bootcamp prospect. ' +
      link("https://www.jobsohio.com/incentives-programs/support-for-small-businesses/jobsohio-small-business-grant", "Program overview") + " · " + link("https://www.jobsohio.com/images/josb_guidelines_may_2025-(1).pdf", "Guidelines (PDF)") + "</p></div>";

    /* outreach */
    h += '<div class="block"><h3>Outreach · from Airtable</h3><div class="panel panel-pad">';
    if (!c.airtable || !c.airtable.recordId) h += '<p class="muted" style="margin:0">Not in Airtable yet. Approve it, then send it; outreach is tracked there.</p>';
    else h += '<div class="facts" style="border:0">' +
      '<div class="k">Status</div><div class="v">' + esc(o.status || "Not started") + "</div>" +
      '<div class="k">Owner</div><div class="v">' + esc(o.owner || "Unassigned") + "</div>" +
      '<div class="k">First contact</div><div class="v">' + fmtDate(o.firstContactAt) + (o.channel ? " · " + esc(o.channel) : "") + "</div>" +
      '<div class="k">Next follow-up</div><div class="v">' + fmtDate(o.followUp) + "</div>" +
      '<div class="k">Replied · Applied · Attended</div><div class="v">' + (o.replied ? "Yes" : "No") + " · " + (o.applied ? "Yes" : "No") + " · " + (o.attended ? "Yes" : "No") + "</div>" +
      '<div class="k">Grant referral</div><div class="v">' + esc(o.grantReferral || "None") + "</div></div>";
    h += "</div></div>";

    /* sources */
    h += '<div class="block"><h3>Where we found it</h3><div class="panel">' + (c.sources || []).map(function (x) {
      return '<div class="contact"><div class="method"><strong>' + esc(x.label || x.type || "Source") + "</strong>" + (x.network ? '<span class="chip lamp">Founder network</span>' : "") +
        '<span class="prov">' + esc(x.type || "") + " · " + fmtDate(x.at) + "</span></div><div class=\"small\">" + link(x.url) + "</div></div>";
    }).join("") + (c.sources && c.sources.length ? "" : '<div class="empty">No source recorded.</div>') + "</div>" +
      '<p class="muted small" style="margin:6px 0 0">Stable ID <span class="mono">' + esc(c.id) + "</span> · discovered " + fmtDate(c.createdAt) + " · updated " + fmtDate(c.updatedAt) + "</p></div>";

    /* log */
    if (c.log && c.log.length) {
      h += '<div class="block"><h3>History</h3><div class="panel">' + c.log.slice(-12).reverse().map(function (l) {
        return '<div class="contact small"><div class="method"><span>' + esc(l.what) + '</span><span class="prov">' + fmtDate(l.at) + (l.by ? " · " + esc(nameOf(l.by)) : "") + "</span></div></div>";
      }).join("") + "</div></div>";
    }

    return h + "</div>";
  }
  function sameFact(a, b) { return a && b && a.v === b.v && a.src === b.src; }

  /* ---------- Claude research ---------- */

  var enrich = { status: "idle", result: null, error: "" };
  function enrichPanel() {
    var h = '<div class="panel panel-pad" style="margin-top:8px"><p class="small" style="margin:0 0 8px">Paste text from a page you opened — the About page, a chamber listing, a LinkedIn company page, a news story. Claude pulls out only what that text states, and every fact it proposes is tied to the link you give.</p>' +
      '<label class="field">Page link (required)<input type="url" id="en-url" placeholder="https://…"></label>' +
      '<label class="field" style="margin-top:8px">Page text<textarea id="en-text" placeholder="Paste the page text here"></textarea></label>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn primary sm" data-act="run-enrich"' + (enrich.status === "busy" ? " disabled" : "") + ">" + (enrich.status === "busy" ? "Reading…" : "Extract facts") + '</button><button type="button" class="btn ghost sm" data-act="cancel-edit">Close</button></div>';
    if (enrich.error) h += '<div class="notice alert" style="margin-top:8px">' + esc(enrich.error) + "</div>";
    if (enrich.result) {
      var r = enrich.result;
      h += '<div style="margin-top:10px"><strong class="small">Proposed from ' + link(r.url) + "</strong>";
      if (!r.facts.length && !r.contacts.length) h += '<p class="muted small">Nothing usable in that text.</p>';
      r.facts.forEach(function (f, i) {
        h += '<label class="check" style="cursor:pointer"><span><strong>' + esc(FIELD_LABELS[f.field] || f.field) + ":</strong> " + esc(f.field === "revenueBand" ? LD.bandLabel(f.value) : f.value) +
          (f.quote ? '<br><span class="muted small">“' + esc(f.quote) + "”</span>" : "") + '</span><input type="checkbox" id="en-f' + i + '" checked></label>';
      });
      r.contacts.forEach(function (p, i) {
        h += '<label class="check" style="cursor:pointer"><span><strong>Contact:</strong> ' + esc([p.name, p.role, p.email, p.phone, p.linkedin].filter(Boolean).join(" · ")) + '</span><input type="checkbox" id="en-c' + i + '" checked></label>';
      });
      if (r.facts.length || r.contacts.length) h += '<div class="row" style="margin-top:8px"><button type="button" class="btn good sm" data-act="accept-enrich">Add checked facts</button></div>';
      h += "</div>";
    }
    return h + "</div>";
  }

  var EXTRACT_RULES =
    "Rules:\n" +
    "- Use only what the text states. Never guess, never fill from general knowledge. Leave a field out rather than infer it.\n" +
    "- Business contact information only: owner or decision-maker names and roles, business email, business phone, individual LinkedIn URL, company LinkedIn URL. No home addresses, personal social media or family details.\n" +
    "- Never infer race, ethnicity, gender or any identity from names, photos or wording. Include ownerIdentity only if the text itself states it (for example 'certified woman-owned business' or the owner describing themself), and quote it.\n" +
    "- customerMix is one of B2B, B2C, Mixed. revenueBand is one of lt100k, 100k-1m, 1m-5m, 5m-25m, gte25m. foundedYear is a 4-digit year. employees is a whole number.\n" +
    "- hiring, expansion, investment and engagement are one short sentence each describing the stated signal.\n" +
    "- description is one plain sentence of what the company does, in your words, no marketing language.\n";

  function sampleHandle() {
    if (!window.claude || !window.claude.use) return Promise.resolve(null);
    return window.claude.use("sample").catch(function () { return null; });
  }
  function sampleError(e) {
    var code = e && e.code;
    if (code === "not_granted") return "Claude isn't allowed on this page for you. Allow it when asked, or add the facts by hand.";
    if (code === "rate_limited") return "Claude is busy — wait a minute and try again.";
    if (code === "invalid_json") return "Claude's answer couldn't be read. Try a shorter piece of text.";
    if (code === "cancelled") return "Stopped.";
    return "Claude couldn't read that: " + ((e && e.message) || "unknown error") + ".";
  }

  var ENRICH_FIELDS = ["description", "industry", "customerMix", "foundedYear", "employees", "revenueBand", "city",
    "website", "companyLinkedin", "hiring", "expansion", "investment", "engagement", "ownerIdentity"];

  function runEnrich(c, url, text) {
    enrich = { status: "busy", result: null, error: "" };
    renderSheetKeepEdit();
    sampleHandle().then(function (sample) {
      if (!sample) throw { code: "not_granted" };
      var prompt = "You are helping a researcher build a sourced profile of an Ohio small business for Lightship Foundation's Bootcamp outreach.\n" +
        "Company: " + (LD.val(c, "name") || "") + (LD.val(c, "city") ? " (" + LD.val(c, "city") + ")" : "") + "\n" +
        "The text below was copied from: " + url + "\n\n" + EXTRACT_RULES +
        "\nReply with only JSON: {\"facts\":[{\"field\":one of " + JSON.stringify(ENRICH_FIELDS) + ",\"value\":string or number,\"quote\":\"the exact words from the text that support it\"}]," +
        "\"contacts\":[{\"name\":\"\",\"role\":\"\",\"email\":\"\",\"phone\":\"\",\"linkedin\":\"\"}]}\n\nTEXT:\n" + text.slice(0, 24000);
      return sample.json(prompt, { modelTier: "default" });
    }).then(function (out) {
      var facts = (out && Array.isArray(out.facts) ? out.facts : []).filter(function (f) {
        return f && ENRICH_FIELDS.indexOf(f.field) >= 0 && !LD.blank(f.value) && (f.field !== "ownerIdentity" || f.quote);
      }).map(function (f) {
        var v = f.value;
        if (f.field === "customerMix") v = LD.normMix(v);
        if (f.field === "revenueBand") v = LD.normRevenue(v);
        if (f.field === "foundedYear" || f.field === "employees") v = Number(String(v).replace(/\D/g, "")) || "";
        return { field: f.field, value: v, quote: String(f.quote || "").slice(0, 240) };
      }).filter(function (f) { return !LD.blank(f.value); });
      var contacts = (out && Array.isArray(out.contacts) ? out.contacts : []).filter(function (p) { return p && (p.name || p.email || p.phone); });
      enrich = { status: "idle", result: { url: url, facts: facts, contacts: contacts }, error: "" };
      renderSheetKeepEdit();
    }).catch(function (e) {
      enrich = { status: "idle", result: null, error: sampleError(e) };
      renderSheetKeepEdit();
    });
  }
  /* Claude answers arrive while the panel is open: redraw it without
     losing what the researcher pasted. */
  function renderSheetKeepEdit() {
    var u = document.getElementById("en-url"), t = document.getElementById("en-text");
    var uv = u ? u.value : "", tv = t ? t.value : "";
    renderSheet();
    var u2 = document.getElementById("en-url"), t2 = document.getElementById("en-text");
    if (u2) u2.value = uv;
    if (t2) t2.value = tv;
  }

  /* ============================================================
     Sheet — add leads
     ============================================================ */

  var imp = { method: "table", sourceId: "", text: "", rows: null, preview: null, busy: false, error: "" };

  function approvedSources() { return cache.sources.filter(function (s) { return s.status === "Approved"; }); }

  function sheetImport() {
    var srcs = approvedSources();
    var h = '<div class="sheet-head"><div style="flex:1"><h2 id="sheet-title">Add leads</h2><div class="muted small">Every lead comes from an approved source and keeps that source on each fact. Duplicates and do-not-contact companies are caught before anything is saved.</div></div>' +
      '<button type="button" class="btn ghost" data-act="close" aria-label="Close">✕</button></div><div class="sheet-body">';
    if (!srcs.length) {
      return h + '<div class="notice warn">There are no approved sources yet. Add a source and set it to Approved, then come back.</div>' +
        '<div><button type="button" class="btn primary" data-act="open-source">Add a source</button></div></div>';
    }
    h += '<label class="field">Source<select id="imp-src">' + [["", "Choose an approved source"]].concat(srcs.map(function (s) { return [s.id, s.name + (s.city ? " · " + s.city : "")]; }))
      .map(function (o) { return opt(o[0], o[1], imp.sourceId); }).join("") + "</select></label>";
    h += '<div class="seg" role="group" aria-label="How"><button type="button" data-act="imp-method" data-m="table" aria-pressed="' + (imp.method === "table") + '">Paste a table</button>' +
      '<button type="button" data-act="imp-method" data-m="extract" aria-pressed="' + (imp.method === "extract") + '">Extract from page text</button>' +
      '<button type="button" data-act="imp-method" data-m="one" aria-pressed="' + (imp.method === "one") + '">One company</button></div>';

    if (imp.method === "table") {
      h += '<label class="field">Rows copied from a spreadsheet or CSV, header row first<textarea id="imp-text" style="min-height:160px" placeholder="Company, Website, City, Owner, Title, Email, Phone">' + esc(imp.text) + "</textarea></label>" +
        '<p class="muted small" style="margin:0">Recognised headers include Company, Website, City, Description, Industry, Founded, Employees, Revenue, Owner/Contact, Title, Email, Phone, LinkedIn, Source.</p>' +
        '<div><button type="button" class="btn" data-act="imp-preview">Check for duplicates</button></div>';
    } else if (imp.method === "extract") {
      h += '<label class="field">Link to the page you copied from<input type="url" id="imp-url" placeholder="https://…" value="' + esc(imp.url || "") + '"></label>' +
        '<label class="field">Page text — a member directory, event roster, accelerator cohort list<textarea id="imp-text" style="min-height:160px">' + esc(imp.text) + "</textarea></label>" +
        '<p class="muted small" style="margin:0">Claude lists only the businesses the text names, with only the details it states. You check every row before anything is saved.</p>' +
        '<div><button type="button" class="btn" data-act="imp-extract"' + (imp.busy ? " disabled" : "") + ">" + (imp.busy ? "Reading…" : "Extract companies") + "</button></div>";
    } else {
      h += '<div class="grid-form">' +
        '<label class="field">Company<input type="text" id="one-name"></label><label class="field">Website<input type="text" id="one-web"></label>' +
        '<label class="field">City<input type="text" id="one-city"></label><label class="field">Industry<input type="text" id="one-ind"></label>' +
        '<label class="field">Owner or decision maker<input type="text" id="one-cn"></label><label class="field">Role<input type="text" id="one-cr"></label>' +
        '<label class="field">Business email<input type="email" id="one-em"></label><label class="field">Business phone<input type="text" id="one-ph"></label>' +
        '<label class="field">Link where you found it<input type="url" id="one-src" placeholder="https://…"></label></div>' +
        '<label class="field">One-sentence description<input type="text" id="one-desc"></label>' +
        '<div><button type="button" class="btn" data-act="imp-one">Check for duplicates</button></div>';
    }
    if (imp.error) h += '<div class="notice alert">' + esc(imp.error) + "</div>";

    if (imp.preview) {
      var p = imp.preview;
      var counts = { created: 0, merged: 0, suppressed: 0, skipped: 0 };
      p.forEach(function (r) { counts[r.action] = (counts[r.action] || 0) + 1; });
      h += '<div class="block"><h3>Check before saving</h3><p class="small" style="margin:0 0 8px">' + counts.created + " new · " + counts.merged + " already known (will merge) · " + counts.suppressed + " do-not-contact · " + counts.skipped + " skipped</p>" +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Company</th><th>City</th><th>Contact</th><th>Outcome</th></tr></thead><tbody>' +
        p.map(function (r) {
          var out = r.action === "created" ? '<span class="chip accent">New</span>' :
            r.action === "merged" ? '<span class="chip">Matches ' + esc(LD.val(r.company, "name")) + " by " + esc(r.match) + "</span>" :
            r.action === "suppressed" ? '<span class="chip alert">Do not contact</span>' : '<span class="chip warn">Skipped: ' + esc(r.reason) + "</span>";
          var ct = r.contacts && r.contacts[0] && r.contacts[0].contact;
          return "<tr><td>" + esc(r.raw.name || "—") + "</td><td>" + esc(r.raw.city || (r.company && LD.val(r.company, "city")) || "—") + "</td><td class=\"small\">" +
            esc(ct ? [LD.val(ct, "name"), LD.val(ct, "email")].filter(Boolean).join(" · ") : "—") + "</td><td>" + out + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
        '<div class="row" style="margin-top:10px"><button type="button" class="btn primary" data-act="imp-commit">Save ' + (counts.created + counts.merged + counts.suppressed) + " to the desk</button>" +
        '<button type="button" class="btn ghost" data-act="imp-reset">Start over</button></div></div>';
    }
    return h + "</div>";
  }

  /* Runs every raw row through the same rules against a working copy, so
     two rows for one company inside a single paste also collapse. */
  function dryRun(rows, source) {
    var st = { companies: cache.companies.slice(), contacts: cache.contacts.slice(), suppression: settings().suppression };
    return rows.map(function (raw) {
      var r = LD.ingest(raw, source, st, NOW());
      r.raw = raw;
      if (r.company) {
        var i = st.companies.findIndex(function (x) { return x.id === r.company.id; });
        if (i >= 0) st.companies[i] = r.company; else st.companies.push(r.company);
        r.contacts.forEach(function (x) {
          var j = st.contacts.findIndex(function (y) { return y.id === x.contact.id; });
          if (j >= 0) st.contacts[j] = x.contact; else st.contacts.push(x.contact);
        });
      }
      return r;
    });
  }

  function commitResults(results, source, title) {
    var counts = { created: 0, merged: 0, suppressed: 0, skipped: 0 };
    var touched = {}, touchedContacts = {};
    results.forEach(function (r) {
      counts[r.action] = (counts[r.action] || 0) + 1;
      if (!r.company) return;
      touched[r.company.id] = r.company;
      r.contacts.forEach(function (x) { touchedContacts[x.contact.id] = x.contact; });
    });
    Object.keys(touched).forEach(function (id) {
      var c = touched[id];
      logTo(c, (find("companies", id) ? "Merged new evidence from " : "Discovered via ") + (source ? source.name : "import"));
      put("companies", c);
    });
    Object.keys(touchedContacts).forEach(function (id) { put("contacts", touchedContacts[id]); });
    if (source) put("sources", Object.assign({}, source, { lastRunAt: LD.today() }));
    addRun(title, counts.created + " new, " + counts.merged + " merged, " + counts.suppressed + " suppressed, " + counts.skipped + " skipped" + (source ? " · " + source.name : ""), counts, []);
    return counts;
  }

  function logTo(c, what) {
    c.log = (c.log || []).concat([{ at: LD.today(), what: what, by: me.id || null }]).slice(-40);
  }
  function addRun(title, summary, counts, errors) {
    put("runs", { id: LD.uid("run"), at: new Date().toISOString(), title: title, summary: summary, counts: counts || null, errors: errors || [], by: me.id || null });
    /* keep the log from growing without end */
    var runs = cache.runs.slice().sort(function (a, b) { return (a.at || "").localeCompare(b.at || ""); });
    while (runs.length > 200) del("runs", runs.shift().id);
  }

  function runExtract(url, text, source) {
    imp.busy = true; imp.error = ""; renderSheet();
    sampleHandle().then(function (sample) {
      if (!sample) throw { code: "not_granted" };
      var prompt = "You are helping a researcher list Ohio small businesses from a public source for Lightship Foundation's Bootcamp outreach.\n" +
        "The text below was copied from " + url + " (" + (source.type || "source") + (source.city ? ", " + source.city : "") + ").\n\n" + EXTRACT_RULES +
        "- List each distinct business the text names. Skip nonprofits, government offices, and the source organization itself.\n" +
        "\nReply with only a JSON array: [{\"name\":\"\",\"website\":\"\",\"city\":\"\",\"description\":\"\",\"industry\":\"\",\"contactName\":\"\",\"contactRole\":\"\",\"email\":\"\",\"phone\":\"\",\"linkedin\":\"\"}] — omit empty keys.\n\nTEXT:\n" + text.slice(0, 40000);
      return sample.json(prompt, { modelTier: "default" });
    }).then(function (arr) {
      var rows = (Array.isArray(arr) ? arr : []).filter(function (x) { return x && x.name; }).map(function (x) {
        var o = {};
        ["name", "website", "city", "description", "industry", "contactName", "contactRole", "email", "phone", "linkedin"].forEach(function (k) { if (x[k]) o[k] = String(x[k]); });
        o.sourceUrl = url;
        return o;
      });
      imp.busy = false;
      if (!rows.length) { imp.error = "No businesses found in that text."; renderSheet(); return; }
      imp.rows = rows;
      imp.preview = dryRun(rows, source);
      renderSheet();
    }).catch(function (e) { imp.busy = false; imp.error = sampleError(e); renderSheet(); });
  }

  /* ============================================================
     Sheet — source
     ============================================================ */

  function sheetSource(s) {
    s = s || { status: "Proposed", type: "Business directory", city: "Cleveland" };
    var h = '<div class="sheet-head"><div style="flex:1"><h2 id="sheet-title">' + (s.id ? esc(s.name) : "Add a source") + '</h2><div class="muted small">Public directories, chambers, supplier networks, startup ecosystems, accelerator lists, event rosters, partner referrals and company websites.</div></div>' +
      '<button type="button" class="btn ghost" data-act="close" aria-label="Close">✕</button></div><div class="sheet-body"><div class="grid-form">' +
      '<label class="field">Name<input type="text" id="src-name" value="' + esc(s.name || "") + '"></label>' +
      '<label class="field">Link<input type="url" id="src-url" value="' + esc(s.url || "") + '" placeholder="https://…"></label>' +
      '<label class="field">Type<select id="src-type">' + LD.SOURCE_TYPES.map(function (t) { return opt(t, t, s.type); }).join("") + "</select></label>" +
      '<label class="field">City<select id="src-city">' + ["Ohio"].concat(LD.PRIORITY_CITIES, LD.EXPANSION_CITIES).map(function (c) { return opt(c, c, s.city || "Ohio"); }).join("") + "</select></label>" +
      '<label class="field">Status<select id="src-status">' + ["Proposed", "Approved", "Paused"].map(function (t) { return opt(t, t, s.status); }).join("") + "</select></label></div>" +
      '<label class="field">Access rules — how we may use it<input type="text" id="src-access" value="' + esc(s.access || "") + '" placeholder="e.g. Public member list; copy by hand; no automated scraping"></label>' +
      '<label class="row small" style="font-weight:600"><input type="checkbox" id="src-net"' + (s.network ? " checked" : "") + "> Black, Brown or women founder network — counted for sourcing coverage, never attached to a person</label>" +
      '<label class="field">Notes<textarea id="src-notes" style="min-height:60px">' + esc(s.notes || "") + "</textarea></label>" +
      '<div class="row"><button type="button" class="btn primary" data-act="save-source" data-id="' + esc(s.id || "") + '">Save source</button>' +
      (s.id ? '<button type="button" class="btn danger" data-act="del-source" data-id="' + esc(s.id) + '">Delete</button>' : "") + "</div>";
    if (s.id) {
      var n = sourceStats(s);
      h += '<div class="stat-grid"><div class="stat"><div class="n">' + n.discovered + '</div><div class="l">Found</div></div><div class="stat"><div class="n">' + n.approved +
        '</div><div class="l">Approved</div></div><div class="stat"><div class="n">' + n.contacted + '</div><div class="l">Contacted</div></div><div class="stat"><div class="n">' + n.replied + '</div><div class="l">Replied</div></div></div>';
    }
    return h + "</div>";
  }

  /* ============================================================
     Airtable
     ============================================================ */

  function mcpHandle() {
    if (!window.claude || !window.claude.use) return Promise.resolve(null);
    return window.claude.use("mcp").catch(function () { return null; });
  }
  function payloadOf(res) {
    var p = res && res.payload !== undefined ? res.payload : res;
    if (p && Array.isArray(p.content)) p = p.content.map(function (x) { return x.text || ""; }).join("");
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { /* leave as text */ } }
    return p;
  }
  function mcpMessage(e) {
    var code = e && e.code;
    if (code === "server_not_connected") return "Airtable isn't connected. Add it under claude.ai Settings → Connectors.";
    if (code === "needs_reauth") return "Airtable needs reconnecting in claude.ai Settings → Connectors.";
    if (code === "not_granted" || code === "approval_required") return "Allow Airtable for this page when asked.";
    if (code === "blocked_by_policy") return "Your organization's policy blocks Airtable here.";
    if (code === "server_unavailable") return "Airtable didn't answer in time. Some rows may have saved; sending again is safe.";
    if (code === "tool_error") return String((e && e.message) || "Airtable refused the request").slice(0, 200);
    return (e && e.message) || "Airtable request failed.";
  }
  function call(tool, input) {
    return mcpHandle().then(function (mcp) {
      if (!mcp) throw { code: "not_granted", message: "unavailable" };
      return mcp.callTool("Airtable", tool, input);
    }).then(payloadOf);
  }

  var schema = null;
  function loadSchema() {
    var cfg = settings().airtable;
    return call("list_tables_for_base", { baseId: cfg.baseId }).then(function (p) {
      var tables = (p && p.tables) || [];
      function map(tid) {
        var t = tables.filter(function (x) { return x.id === tid || x.name === tid; })[0];
        if (!t) throw { code: "tool_error", message: "Table " + tid + " isn't in base " + cfg.baseId + "." };
        var byName = {}, byId = {};
        t.fields.forEach(function (f) { byName[f.name] = f.id; byId[f.id] = f.name; });
        return { id: t.id, byName: byName, byId: byId };
      }
      schema = { companies: map(cfg.companiesTable), contacts: map(cfg.contactsTable) };
      var missing = [];
      Object.keys(LD.AT_COMPANY).forEach(function (k) { if (!schema.companies.byName[LD.AT_COMPANY[k]]) missing.push("Companies." + LD.AT_COMPANY[k]); });
      Object.keys(LD.AT_CONTACT).forEach(function (k) { if (!schema.contacts.byName[LD.AT_CONTACT[k]]) missing.push("Contacts." + LD.AT_CONTACT[k]); });
      if (missing.length) throw { code: "tool_error", message: "Airtable is missing fields: " + missing.join(", ") };
      return schema;
    });
  }
  function toIds(tbl, fields) {
    var out = {};
    Object.keys(fields).forEach(function (n) { var id = tbl.byName[n]; if (id) out[id] = fields[n]; });
    return out;
  }
  function toNames(tbl, fields) {
    var out = {};
    Object.keys(fields || {}).forEach(function (k) { out[tbl.byId[k] || k] = fields[k]; });
    return out;
  }

  /* Upsert in tens on External ID. A batch that fails marks only its own
     rows, and sending them again updates the same Airtable rows. */
  function upsert(tbl, rows) {
    var ext = tbl.byName["External ID"];
    var done = {}, failed = {};
    var chunks = [];
    for (var i = 0; i < rows.length; i += 10) chunks.push(rows.slice(i, i + 10));
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return call("update_records_for_table", {
          baseId: settings().airtable.baseId, tableId: tbl.id, typecast: true,
          performUpsert: { fieldIdsToMergeOn: [ext] }, fieldIds: [ext],
          records: chunk.map(function (r) { return { fields: toIds(tbl, r.fields) }; })
        }).then(function (p) {
          var recs = (p && p.records) || [];
          chunk.forEach(function (r, j) {
            var hit = recs.filter(function (x) { var f = x.fields || {}; return f[ext] === r.key || f["External ID"] === r.key; })[0] || recs[j];
            if (hit && hit.id) done[r.key] = hit.id; else failed[r.key] = "Airtable didn't return a row for it";
          });
        }).catch(function (e) {
          var msg = mcpMessage(e);
          chunk.forEach(function (r) { failed[r.key] = msg; });
          if (e && (e.code === "server_not_connected" || e.code === "needs_reauth" || e.code === "not_granted" || e.code === "blocked_by_policy")) throw e;
        });
      });
    }, Promise.resolve()).then(function () { return { done: done, failed: failed }; });
  }

  var syncing = false;
  function sync(companies) {
    if (syncing) return;
    companies = companies.filter(function (c) { return state(c) === "approved" && !c.doNotContact; });
    if (!companies.length) { toast("Nothing approved is waiting to go to Airtable."); return; }
    syncing = true;
    at.status = "busy"; at.msg = "Sending " + companies.length + " to Airtable…"; schedule();
    var errors = [];
    var s = settings();
    loadSchema().then(function (sc) {
      var rows = companies.map(function (c) { return { key: c.id, fields: LD.companyToAirtable(c, contactsOf(c.id), s, NOW()) }; });
      return upsert(sc.companies, rows).then(function (res) {
        var nowIso = new Date().toISOString();
        var ok = [];
        companies.forEach(function (c) {
          var copy = LD.clone(c);
          var a = copy.airtable || {};
          if (res.done[c.id]) {
            copy.airtable = { recordId: res.done[c.id], status: "synced", syncedAt: nowIso, firstSyncedAt: a.firstSyncedAt || LD.today(), attempts: 0, error: "" };
            copy.snapshot = { score: scoreOf(c).score, grant: grantOf(c).outcome, at: LD.today() };
            ok.push(copy);
          } else {
            copy.airtable = Object.assign({}, a, { status: "error", error: res.failed[c.id] || "Unknown error", attempts: (a.attempts || 0) + 1, lastAttempt: nowIso });
            errors.push((LD.val(c, "name") || c.id) + ": " + copy.airtable.error);
          }
          put("companies", copy);
        });
        /* contacts ride with their company so the link can be set */
        var ctRows = [];
        ok.forEach(function (c) {
          contactsOf(c.id).forEach(function (ct) { ctRows.push({ key: ct.id, fields: LD.contactToAirtable(ct, c), ct: ct }); });
        });
        if (!ctRows.length) return ok.length;
        return upsert(sc.contacts, ctRows).then(function (r2) {
          ctRows.forEach(function (row) {
            var ct = LD.clone(row.ct);
            if (r2.done[row.key]) ct.airtable = { recordId: r2.done[row.key], status: "synced", syncedAt: nowIso };
            else { ct.airtable = { status: "error", error: r2.failed[row.key] }; errors.push("Contact " + (LD.val(ct, "name") || ct.id) + ": " + r2.failed[row.key]); }
            put("contacts", ct);
          });
          return ok.length;
        });
      });
    }).then(function (n) {
      at.status = errors.length ? "error" : "ok"; at.msg = errors.length ? errors.length + " rows failed" : "";
      addRun("Sent to Airtable", n + " companies synced" + (errors.length ? ", " + errors.length + " failed" : ""), null, errors);
      toast(errors.length ? n + " sent · " + errors.length + " failed — see Today" : n + " sent to Airtable");
    }).catch(function (e) {
      at.status = "error"; at.msg = mcpMessage(e);
      addRun("Sync to Airtable failed", mcpMessage(e), null, [mcpMessage(e)]);
      toast(mcpMessage(e));
    }).then(function () { syncing = false; schedule(); });
  }

  /* Read the team's outreach state back, so replies, owners and opt-outs
     are here and nobody is contacted twice. */
  function readBack(quiet) {
    if (syncing) return;
    at.status = "busy"; at.msg = "Reading outreach from Airtable…"; schedule();
    var fields = Object.keys(LD.AT_COMPANY).map(function (k) { return LD.AT_COMPANY[k]; })
      .filter(function (n) { return ["External ID", "Company", "Domain", "Outreach status", "Outreach owner", "First contact date", "Channel", "Next follow-up", "Replied", "Applied", "Attended", "Do not contact", "Grant referral"].indexOf(n) >= 0; });
    function pageAll(tbl, fieldNames) {
      var out = [];
      function next(cursor) {
        var input = { baseId: settings().airtable.baseId, tableId: tbl.id, fieldIds: fieldNames.map(function (n) { return tbl.byName[n]; }).filter(Boolean), pageSize: 1000 };
        if (cursor) input.cursor = cursor;
        return call("list_records_for_table", input).then(function (p) {
          (p && p.records || []).forEach(function (r) { out.push({ id: r.id, fields: toNames(tbl, r.fields || r.cellValuesByFieldId || {}) }); });
          var nc = p && (p.nextCursor || p.cursor || p.offset);
          return nc && out.length < 20000 ? next(nc) : out;
        });
      }
      return next(null);
    }
    loadSchema().then(function (sc) {
      return pageAll(sc.companies, fields).then(function (recs) {
        var s = settings();
        var sup = s.suppression.slice();
        var supChanged = false;
        var updated = 0, optOuts = 0, outside = 0;
        recs.forEach(function (r) {
          var f = r.fields;
          var ext = f["External ID"];
          var c = ext ? find("companies", ext) : null;
          var o = LD.outreachFromAirtable(f);
          if (c) {
            var next = LD.clone(c);
            next.outreach = o;
            next.airtable = Object.assign({}, next.airtable || {}, { recordId: r.id });
            if (o.optedOut && !c.doNotContact) { next.doNotContact = true; logTo(next, "Opted out (from Airtable)"); optOuts++; }
            if (JSON.stringify(next.outreach) !== JSON.stringify(c.outreach) || next.doNotContact !== c.doNotContact || (c.airtable || {}).recordId !== r.id) {
              put("companies", next); updated++;
            }
          } else outside++;
          /* opt-outs and companies the team entered straight into Airtable
             both join the suppression list, so a source can't resurface them */
          var dom = LD.companyDomain(f["Domain"]), nm = f["Company"];
          var known = sup.some(function (x) { return (dom && x.domain === dom) || (!dom && nm && x.name && LD.normName(x.name) === LD.normName(nm)); });
          if (!known && (o.optedOut || !c) && (dom || nm)) {
            sup.push({ domain: dom || "", name: dom ? "" : nm, reason: o.optedOut ? "Opted out in Airtable" : "Already in Airtable outreach", at: LD.today() });
            supChanged = true;
          }
        });
        if (supChanged) saveSettings({ suppression: sup });
        return pageAll(sc.contacts, ["External ID", "Do not contact"]).then(function (cr) {
          cr.forEach(function (r) {
            var ct = r.fields["External ID"] && find("contacts", r.fields["External ID"]);
            if (ct && r.fields["Do not contact"] && !ct.doNotContact) put("contacts", Object.assign(LD.clone(ct), { doNotContact: true }));
          });
          return { updated: updated, optOuts: optOuts, outside: outside, total: recs.length };
        });
      });
    }).then(function (r) {
      at.status = "ok"; at.lastRead = new Date().toISOString();
      if (!quiet || r.updated) addRun("Read outreach from Airtable", r.total + " rows · " + r.updated + " updated · " + r.optOuts + " new opt-outs" + (r.outside ? " · " + r.outside + " added in Airtable directly" : ""), null, []);
      if (!quiet) toast("Outreach read: " + r.updated + " updated");
    }).catch(function (e) {
      at.status = "error"; at.msg = mcpMessage(e);
      if (!quiet) toast(mcpMessage(e));
    }).then(schedule);
  }

  /* ============================================================
     Intake from scheduled discovery
     ============================================================ */

  function processIntake() {
    var items = cache.intake.slice();
    if (!items.length) return;
    var bySource = {};
    items.forEach(function (it) { (bySource[it.sourceId || ""] = bySource[it.sourceId || ""] || []).push(it); });
    Object.keys(bySource).forEach(function (sid) {
      var src = sid ? find("sources", sid) : null;
      var usable = bySource[sid].filter(function () { return !src || src.status === "Approved"; });
      var rows = usable.map(function (it) { return it.raw || it; });
      if (rows.length) commitResults(dryRun(rows, src ? srcRef(src) : null), src, "Processed discovered candidates");
      bySource[sid].forEach(function (it) { if (usable.indexOf(it) >= 0) del("intake", it.id); });
      if (usable.length < bySource[sid].length) toast("Some candidates came from a source that isn't approved and were left waiting.");
    });
  }
  function srcRef(s) { return { id: s.id, url: s.url, label: s.name, type: s.type, city: s.city === "Ohio" ? "" : s.city, network: !!s.network }; }

  /* ============================================================
     Mutations from the company sheet
     ============================================================ */

  function mutate(id, fn, what) {
    var c = find("companies", id);
    if (!c) return;
    var next = LD.clone(c);
    fn(next);
    next.updatedAt = LD.today();
    if (what) logTo(next, what);
    put("companies", next);
  }

  function saveFact(id, field, value, src) {
    mutate(id, function (c) {
      if (LD.blank(value)) { delete c.f[field]; return; }
      c.f[field] = LD.fact(value, src || "Researcher", LD.today(), "human");
      (c.conflicts || []).forEach(function (x) { if (x.field === field) x.resolved = true; });
      if (field === "website" && !LD.val(c, "domain")) {
        var d = LD.companyDomain(value);
        if (d) c.f.domain = LD.fact(d, src || "Researcher", LD.today(), "human");
      }
    }, "Edited " + (FIELD_LABELS[field] || field));
  }

  /* ============================================================
     Events
     ============================================================ */

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3600);
  }
  function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]");
    if (!t) return;
    var act = t.getAttribute("data-act");
    var d = t.dataset;
    var cid = sheet && sheet.kind === "company" ? sheet.id : null;

    switch (act) {
      case "nav": view = d.view; filters.flag = filters.flag && d.view === "companies" ? filters.flag : ""; render(); window.scrollTo(0, 0); break;
      case "open-company": openSheet({ kind: "company", id: d.id }); break;
      case "close": closeSheet(); break;
      case "filter-flag": Object.keys(filters).forEach(function (k) { filters[k] = ""; }); filters.flag = d.flag; view = "companies"; render(); break;
      case "clear-flag": filters.flag = ""; render(); break;
      case "perf": perfPeriod = d.p; render(); break;

      case "open-import": imp = { method: "table", sourceId: imp.sourceId || "", text: "", rows: null, preview: null, busy: false, error: "" }; openSheet({ kind: "import" }); break;
      case "open-source": openSheet({ kind: "source", id: d.id || null }); break;
      case "process-intake": processIntake(); toast("Candidates processed"); break;
      case "sync": sync(cache.companies.filter(needsSync)); break;
      case "readback": readBack(false); break;

      /* review */
      case "approve":
        mutate(cid, function (c) {
          c.review = { state: "approved", at: LD.today(), by: me.id || null };
          c.verifiedAt = LD.today();
          c.airtable = Object.assign({}, c.airtable || {}, { status: "pending" });
        }, "Approved for outreach");
        toast("Approved. It will go to Airtable with the next send.");
        break;
      case "ack-refresh":
        mutate(cid, function (c) {
          delete c.review.refreshed; c.verifiedAt = LD.today();
          c.snapshot = { score: scoreOf(find("companies", cid)).score, at: LD.today() };
          c.airtable = Object.assign({}, c.airtable || {}, { status: "pending" });
        }, "Reviewed refreshed evidence");
        break;
      case "investigate": case "reject":
        sheet.pending = act; editing = "note"; renderSheet();
        var n = document.getElementById("rv-note"); if (n) n.focus();
        break;
      case "confirm-review":
        var note = v("rv-note");
        if (sheet.pending === "reject" && !note) { toast("Say why it's rejected, so the next researcher knows."); break; }
        var pend = sheet.pending;
        editing = null;
        mutate(cid, function (c) { c.review = { state: pend === "reject" ? "rejected" : "investigate", at: LD.today(), by: me.id || null, note: note }; },
          (pend === "reject" ? "Rejected" : "Sent to investigate") + (note ? ": " + note : ""));
        break;
      case "reopen": mutate(cid, function (c) { c.review = { state: "new", at: LD.today(), by: me.id || null }; }, "Returned to the review queue"); break;
      case "sync-one": sync([find("companies", cid)]); break;

      /* facts */
      case "edit": editing = d.field; if (d.field === "enrich") enrich = { status: "idle", result: null, error: "" }; renderSheetForce(); break;
      case "cancel-edit": editing = null; renderSheet(); break;
      case "save-fact":
        var val = v("ed-v"), src = v("ed-src");
        if (d.field === "ownerIdentity" && val && !src) { toast("Add where the owner stated this. Identity is never recorded without a source."); break; }
        if (d.field === "foundedYear" || d.field === "employees") val = val === "" ? "" : Number(val);
        editing = null; saveFact(cid, d.field, val, src);
        break;
      case "tri": saveFact(cid, d.field, d.v === "unknown" ? "" : d.v, "Researcher"); break;
      case "resolve":
        mutate(cid, function (c) {
          var x = c.conflicts[Number(d.i)];
          if (!x) return;
          var keptIsIncoming = sameFact(c.f[x.field], x.incoming);
          var chosen = d.pick === "kept" ? c.f[x.field] : (keptIsIncoming ? x.current : x.incoming);
          c.f[x.field] = Object.assign({}, chosen, { by: "human", at: LD.today() });
          x.resolved = true;
        }, "Resolved a source conflict");
        break;

      /* score */
      case "save-override":
        var sc = Number(v("ov-score")), why = v("ov-reason");
        if (isNaN(sc) || sc < 0 || sc > 100 || v("ov-score") === "") { toast("Enter a score from 0 to 100."); break; }
        if (!why) { toast("Give a reason for the override."); break; }
        editing = null;
        mutate(cid, function (c) { c.override = { score: Math.round(sc), reason: why, by: me.id || null, at: LD.today() }; }, "Score overridden to " + Math.round(sc) + ": " + why);
        break;
      case "clear-override": mutate(cid, function (c) { delete c.override; }, "Score override removed"); break;

      /* contacts */
      case "save-contact":
        var ct = LD.contactFromRaw({ name: v("nc-name"), role: v("nc-role"), email: v("nc-email"), phone: v("nc-phone"), linkedin: v("nc-li") },
          v("nc-src") || "Researcher", LD.today(), "human");
        if (!ct) { toast("Add at least a name, email, phone or LinkedIn."); break; }
        if (v("nc-email") && !LD.val(ct, "email")) { toast("That email doesn't look right."); break; }
        var co = find("companies", cid);
        var dup = contactsOf(cid).filter(function (x) { return LD.contactMatch(x, ct); })[0];
        if (dup) {
          var merged = LD.clone(dup); LD.mergeFacts(merged, ct); if (ct.decisionMaker) merged.decisionMaker = true;
          merged.updatedAt = LD.today(); put("contacts", merged);
        } else {
          ct.id = LD.uid("ct"); ct.companyId = cid; ct.createdAt = LD.today(); ct.updatedAt = LD.today();
          if (co && co.doNotContact) ct.doNotContact = true;
          put("contacts", ct);
        }
        editing = null;
        mutate(cid, function () {}, "Added contact " + (LD.val(ct, "name") || ""));
        break;
      case "verify-method":
        var c1 = find("contacts", d.ct);
        if (c1) { var cc = LD.clone(c1); cc.f[d.m].at = LD.today(); cc.f[d.m].by = "human"; delete cc.changed; cc.updatedAt = LD.today(); put("contacts", cc); mutate(cid, function () {}, "Verified " + d.m + " for " + (LD.val(cc, "name") || "contact")); }
        break;
      case "toggle-dm":
        var c2 = find("contacts", d.ct); if (c2) { var c2b = LD.clone(c2); c2b.decisionMaker = !c2b.decisionMaker; c2b.updatedAt = LD.today(); put("contacts", c2b); mutate(cid, function () {}); }
        break;
      case "toggle-dnc":
        var c3 = find("contacts", d.ct); if (c3) { var c3b = LD.clone(c3); c3b.doNotContact = !c3b.doNotContact; c3b.updatedAt = LD.today(); put("contacts", c3b); mutate(cid, function () {}, (c3b.doNotContact ? "Marked do not contact: " : "Allowed contact: ") + (LD.val(c3b, "name") || "")); }
        break;

      /* Claude */
      case "run-enrich":
        var eu = v("en-url"), et = v("en-text");
        if (!/^https?:\/\//i.test(eu)) { toast("Add the page link, so every fact keeps its source."); break; }
        if (et.length < 40) { toast("Paste the page text first."); break; }
        runEnrich(find("companies", cid), eu, et);
        break;
      case "accept-enrich":
        var r = enrich.result; if (!r) break;
        var took = 0;
        mutate(cid, function (c) {
          var inc = { f: {} };
          r.facts.forEach(function (f, i) {
            var box = document.getElementById("en-f" + i);
            if (box && box.checked) { inc.f[f.field] = LD.fact(f.value, r.url, LD.today(), "auto"); took++; }
          });
          LD.mergeFacts(c, inc);
        }, "Added facts from " + r.url);
        r.contacts.forEach(function (p, i) {
          var box = document.getElementById("en-c" + i);
          if (!box || !box.checked) return;
          var nct = LD.contactFromRaw(p, r.url, LD.today(), "auto");
          if (!nct) return;
          var hit = contactsOf(cid).filter(function (x) { return LD.contactMatch(x, nct); })[0];
          if (hit) { var m2 = LD.clone(hit); LD.mergeFacts(m2, nct); m2.updatedAt = LD.today(); put("contacts", m2); }
          else { nct.id = LD.uid("ct"); nct.companyId = cid; nct.createdAt = LD.today(); nct.updatedAt = LD.today(); put("contacts", nct); }
          took++;
        });
        editing = null; enrich = { status: "idle", result: null, error: "" };
        toast(took + " facts added with their source");
        break;

      /* import */
      case "imp-method": imp.method = d.m; imp.preview = null; imp.error = ""; imp.sourceId = v("imp-src") || imp.sourceId; renderSheet(); break;
      case "imp-preview": case "imp-extract": case "imp-one":
        imp.sourceId = v("imp-src"); imp.error = "";
        var s0 = find("sources", imp.sourceId);
        if (!s0) { imp.error = "Choose the source these came from."; renderSheet(); break; }
        var sref = srcRef(s0);
        if (act === "imp-preview") {
          imp.text = document.getElementById("imp-text").value;
          var rows = LD.parseCSV(imp.text);
          if (!rows.length) { imp.error = "No rows found. Include a header row, e.g. Company, Website, City."; renderSheet(); break; }
          if (!rows.some(function (x) { return x.name || x.website; })) { imp.error = "Couldn't find a Company or Website column."; renderSheet(); break; }
          imp.rows = rows; imp.preview = dryRun(rows, sref); renderSheet();
        } else if (act === "imp-extract") {
          imp.text = document.getElementById("imp-text").value; imp.url = v("imp-url");
          if (!/^https?:\/\//i.test(imp.url)) { imp.error = "Add the link to the page you copied from."; renderSheet(); break; }
          if (imp.text.length < 40) { imp.error = "Paste the page text first."; renderSheet(); break; }
          runExtract(imp.url, imp.text, sref);
        } else {
          var one = { name: v("one-name"), website: v("one-web"), city: v("one-city"), industry: v("one-ind"), contactName: v("one-cn"),
            contactRole: v("one-cr"), email: v("one-em"), phone: v("one-ph"), description: v("one-desc"), sourceUrl: v("one-src") || s0.url };
          if (!one.name) { imp.error = "Add the company name."; renderSheet(); break; }
          imp.rows = [one]; imp.preview = dryRun([one], sref); renderSheet();
        }
        break;
      case "imp-commit":
        var s1 = find("sources", imp.sourceId);
        /* re-run against the current desk in case a teammate added the same company meanwhile */
        var counts = commitResults(dryRun(imp.rows, s1 ? srcRef(s1) : null), s1, "Added leads");
        toast(counts.created + " new, " + counts.merged + " merged");
        closeSheet(); view = "today"; render();
        break;
      case "imp-reset": imp.preview = null; imp.rows = null; renderSheet(); break;

      /* sources */
      case "save-source":
        var name = v("src-name");
        if (!name) { toast("Give the source a name."); break; }
        var srcRow = Object.assign({}, d.id ? find("sources", d.id) : { id: LD.uid("src"), createdAt: LD.today() }, {
          name: name, url: v("src-url"), type: v("src-type"), city: v("src-city"), status: v("src-status"),
          access: v("src-access"), notes: v("src-notes"), network: document.getElementById("src-net").checked
        });
        put("sources", srcRow);
        toast("Source saved");
        if (imp && sheet && sheet.kind === "source" && srcRow.status === "Approved" && !d.id) { imp.sourceId = srcRow.id; }
        closeSheet();
        break;
      case "del-source": del("sources", d.id); closeSheet(); toast("Source deleted. Companies keep their source history."); break;

      /* settings */
      case "add-cohort":
        var cd = v("co-date"); if (!cd) { toast("Pick a date."); break; }
        saveSettings({ cohorts: settings().cohorts.concat([{ city: v("co-city"), date: cd }]) }); break;
      case "rm-cohort": saveSettings({ cohorts: settings().cohorts.filter(function (x) { return !(x.city === d.city && x.date === d.date); }) }); break;
      case "save-cities":
        var cities = v("set-cities").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        saveSettings({ priorityCities: cities }); toast("Priority cities saved"); break;
      case "save-airtable":
        saveSettings({ airtable: { baseId: v("at-base"), companiesTable: v("at-co"), contactsTable: v("at-ct") } }); schema = null; toast("Airtable settings saved"); break;
      case "test-airtable":
        at.status = "busy"; at.msg = "Checking Airtable…"; schedule();
        loadSchema().then(function () { at.status = "ok"; toast("Airtable is connected and has every field the desk needs."); })
          .catch(function (e) { at.status = "error"; at.msg = mcpMessage(e); toast(mcpMessage(e)); }).then(schedule);
        break;
      case "add-sup":
        var sv = v("sup-v"); if (!sv) break;
        var dom = LD.companyDomain(sv);
        saveSettings({ suppression: settings().suppression.concat([{ domain: dom, name: dom ? "" : sv, reason: "Added by researcher", at: LD.today() }]) });
        break;
      case "rm-sup": saveSettings({ suppression: settings().suppression.filter(function (x, i) { return i !== Number(d.i); }) }); break;
    }
  });

  function renderSheetForce() {
    renderSheet();
    var first = document.querySelector("#sheet .inline-edit input, #sheet .inline-edit textarea, #sheet .inline-edit select, #sheet #en-url, #sheet #ov-score, #sheet #nc-name");
    if (first) first.focus();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && sheet) { if (editing) { editing = null; renderSheet(); } else closeSheet(); }
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("lead")) e.target.click();
  });
  document.getElementById("scrim").addEventListener("click", closeSheet);

  var filterTimer = null;
  document.addEventListener("input", function (e) {
    var k = e.target.getAttribute && e.target.getAttribute("data-filter");
    if (!k) return;
    filters[k] = e.target.value;
    clearTimeout(filterTimer);
    var id = e.target.id, pos = e.target.selectionStart;
    filterTimer = setTimeout(function () {
      render();
      var el = document.getElementById(id);
      if (el) { el.focus(); try { if (pos !== null && el.setSelectionRange) el.setSelectionRange(pos, pos); } catch (x) { /* not a text input */ } }
    }, e.target.tagName === "SELECT" ? 0 : 200);
  });

  boot();
})();
