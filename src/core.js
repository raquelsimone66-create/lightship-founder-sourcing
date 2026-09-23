/* core.js — the rules of the Lead Desk, with no page and no storage.
   Normalising, matching, merging, scoring and the Airtable mapping all live
   here so they can be tested in node and trusted in the browser alike.

   Every consequential fact is held as { v, src, at, by }:
     v   the value
     src the URL (or named source) it came from
     at  the date it was last verified, YYYY-MM-DD
     by  "auto" for anything imported or extracted, "human" once a researcher
         has entered or confirmed it — human facts are never overwritten by a
         refresh, only flagged when new evidence disagrees. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LD = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- reference data ---------- */

  var PRIORITY_CITIES = ["Cleveland", "Akron"];
  var EXPANSION_CITIES = ["Dayton", "Columbus", "Cincinnati", "Toledo", "Youngstown", "Athens/Marietta"];

  /* A lead in Lakewood is a Cleveland lead for cohort purposes. Kept short
     and obvious; anything not listed keeps its own name and scores as Ohio. */
  var METRO = {
    cleveland: "Cleveland", lakewood: "Cleveland", "cleveland heights": "Cleveland",
    "shaker heights": "Cleveland", euclid: "Cleveland", parma: "Cleveland",
    "east cleveland": "Cleveland", "university heights": "Cleveland", beachwood: "Cleveland",
    solon: "Cleveland", westlake: "Cleveland", strongsville: "Cleveland", mentor: "Cleveland",
    "maple heights": "Cleveland", "garfield heights": "Cleveland", "warrensville heights": "Cleveland",
    independence: "Cleveland", "north olmsted": "Cleveland", elyria: "Cleveland", lorain: "Cleveland",
    willoughby: "Cleveland", "willoughby hills": "Cleveland", bedford: "Cleveland", "bedford heights": "Cleveland",
    "brook park": "Cleveland", "middleburg heights": "Cleveland", "cuyahoga heights": "Cleveland", "valley view": "Cleveland",
    "brooklyn": "Cleveland", "brooklyn heights": "Cleveland", "north royalton": "Cleveland",
    "berea": "Cleveland", "wickliffe": "Cleveland", "eastlake": "Cleveland", "highland heights": "Cleveland",
    "mayfield heights": "Cleveland", "oakwood village": "Cleveland", "twinsburg": "Cleveland", "macedonia": "Cleveland",
    "walton hills": "Cleveland", "seven hills": "Cleveland", "garfield hts": "Cleveland",
    akron: "Akron", "cuyahoga falls": "Akron", barberton: "Akron", stow: "Akron", kent: "Akron",
    hudson: "Akron", fairlawn: "Akron", "green": "Akron", tallmadge: "Akron", canton: "Akron",
    streetsboro: "Akron", ravenna: "Akron", "north canton": "Akron", massillon: "Akron", norton: "Akron",
    "copley": "Akron", "munroe falls": "Akron", "mogadore": "Akron", "wadsworth": "Akron", medina: "Akron",
    dayton: "Dayton", kettering: "Dayton", beavercreek: "Dayton", huber: "Dayton", "huber heights": "Dayton",
    columbus: "Columbus", dublin: "Columbus", westerville: "Columbus", worthington: "Columbus",
    "grove city": "Columbus", hilliard: "Columbus", gahanna: "Columbus", reynoldsburg: "Columbus",
    cincinnati: "Cincinnati", norwood: "Cincinnati", "blue ash": "Cincinnati", mason: "Cincinnati",
    "west chester": "Cincinnati", covington: "Cincinnati", fairfield: "Cincinnati",
    toledo: "Toledo", "bowling green": "Toledo", perrysburg: "Toledo", maumee: "Toledo", sylvania: "Toledo",
    youngstown: "Youngstown", warren: "Youngstown", boardman: "Youngstown", austintown: "Youngstown",
    athens: "Athens/Marietta", marietta: "Athens/Marietta", nelsonville: "Athens/Marietta"
  };

  /* JobsOhio's published target industries. The desk only pre-screens:
     JobsOhio decides eligibility. Keywords map a free-text industry onto one. */
  var JOBSOHIO_INDUSTRIES = [
    { name: "Advanced Manufacturing", kw: ["manufactur", "machining", "fabricat", "metal", "plastics", "industrial", "polymer", "robotics"] },
    { name: "Aerospace & Aviation", kw: ["aerospace", "aviation", "aircraft", "drone", "uav"] },
    { name: "Automotive", kw: ["automotive", "vehicle", "ev ", "electric vehicle", "auto parts"] },
    { name: "Energy & Chemicals", kw: ["energy", "chemical", "solar", "battery", "oil", "gas", "utility"] },
    { name: "Financial Services", kw: ["fintech", "financial", "insurance", "banking", "payments", "accounting"] },
    { name: "Food & Agribusiness", kw: ["food", "beverage", "agri", "farm", "bakery", "brewing", "brewery"] },
    { name: "Healthcare & Life Sciences", kw: ["health", "medical", "biotech", "pharma", "life science", "clinic", "diagnostic"] },
    { name: "Logistics & Distribution", kw: ["logistics", "distribution", "freight", "trucking", "warehous", "supply chain", "moving"] },
    { name: "Technology", kw: ["software", "saas", "technology", "it services", "cyber", "data", "ai ", "artificial intelligence", "semiconductor", "cloud", "tech"] },
    { name: "Military & Federal", kw: ["defense", "military", "federal contract", "government contract"] }
  ];

  var REVENUE_BANDS = [
    { id: "lt100k", label: "Under $100K" },
    { id: "100k-500k", label: "$100K–$500K" },
    { id: "500k-1m", label: "$500K–$1M" },
    { id: "100k-1m", label: "$100K–$1M" },
    { id: "1m-5m", label: "$1M–$5M" },
    { id: "5m-25m", label: "$5M–$25M" },
    { id: "gte25m", label: "$25M or more" }
  ];

  var SOURCE_TYPES = [
    "Business directory", "Chamber of commerce", "Supplier network", "Startup ecosystem",
    "Accelerator list", "Event roster", "Partner referral", "Company website", "Founder network", "Web research", "Other"
  ];

  var TRI = ["yes", "no", "unknown"];

  var CONTACT_STALE_DAYS = 180;
  var PROFILE_STALE_DAYS = 90;

  /* ---------- small helpers ---------- */

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function today(now) { return iso(now || new Date()); }
  function daysBetween(a, b) {
    if (!a || !b) return null;
    var da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    var db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((db - da) / 86400000);
  }
  function uid(prefix) {
    var s = "";
    var chars = "abcdefghijkmnpqrstuvwxyz23456789";
    for (var i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return prefix + "_" + s;
  }
  /* The same company must get the same id no matter which view or run
     creates it, so two people opening the desk at once, or a batch added
     twice, write one record rather than two. FNV-1a, twice, in base 36. */
  function stableId(prefix, key) {
    function fnv(str, seed) {
      var h = seed >>> 0;
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return h;
    }
    var k = String(key || "");
    return prefix + "_" + fnv(k, 2166136261).toString(36) + fnv(k, 3339675911).toString(36);
  }
  function companyKey(c) {
    var d = val(c, "domain");
    if (d) return "d:" + d;
    var city = val(c, "city");
    return "n:" + normName(val(c, "name")) + "|" + (regionOf(city) || String(city || "").toLowerCase());
  }
  function contactKey(companyId, ct) {
    var e = val(ct, "email"), l = val(ct, "linkedin");
    return companyId + "|" + (e ? "e:" + e : l ? "l:" + l.toLowerCase() : "n:" + normName(val(ct, "name")) + "|" + (val(ct, "phone") || ""));
  }

  function blank(v) { return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length); }

  /* A fact's value, or undefined when the fact is missing or marked unknown. */
  function val(rec, field) {
    var f = rec && rec.f && rec.f[field];
    if (!f || blank(f.v) || f.v === "unknown") return undefined;
    return f.v;
  }
  function fact(v, src, at, by) { return { v: v, src: src || "", at: at || "", by: by || "auto" }; }

  /* ---------- normalising ---------- */

  function normDomain(raw) {
    if (!raw) return "";
    var s = String(raw).trim().toLowerCase();
    if (s.indexOf("@") > 0 && s.indexOf("/") < 0) s = s.split("@").pop();
    s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\d?\./, "");
    s = s.split(/[\/?#:]/)[0];
    return /\.[a-z]{2,}$/.test(s) ? s : "";
  }

  /* Webmail and social hosts say nothing about which company it is. */
  var SHARED_HOSTS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com",
    "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "linktr.ee",
    "google.com", "sites.google.com", "wixsite.com", "squarespace.com", "godaddysites.com", "yelp.com"];
  function companyDomain(raw) {
    var d = normDomain(raw);
    if (!d) return "";
    for (var i = 0; i < SHARED_HOSTS.length; i++) {
      var h = SHARED_HOSTS[i];
      if (d === h || d.slice(-(h.length + 1)) === "." + h) return "";
    }
    return d;
  }

  var SUFFIXES = /\b(llc|l\.l\.c|inc|incorporated|co|company|corp|corporation|ltd|limited|pllc|plc|lp|llp|group|holdings|enterprises)\b\.?/g;
  function normName(raw) {
    return String(raw || "").toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(SUFFIXES, " ")
      .replace(/^the\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normCity(raw) {
    var s = String(raw || "").split(",")[0].trim();
    if (!s) return "";
    return s.replace(/\s+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function regionOf(city) {
    var c = String(city || "").toLowerCase().split(",")[0].trim();
    return METRO[c] || "";
  }

  function normEmail(raw) {
    var s = String(raw || "").trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s) ? s : "";
  }
  function normPhone(raw) {
    var d = String(raw || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : "";
  }
  function normLinkedIn(raw) {
    var s = String(raw || "").trim();
    if (!/linkedin\.com\//i.test(s)) return "";
    return "https://www." + s.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  }

  /* Public social profiles. A handle or a URL goes in; a clean URL comes out,
     and only for the platform it claims to be. */
  var SOCIALS = [
    { key: "instagram", label: "Instagram", host: "instagram.com" },
    { key: "facebook", label: "Facebook", host: "facebook.com" },
    { key: "x", label: "X", host: "x.com", alt: "twitter.com" },
    { key: "youtube", label: "YouTube", host: "youtube.com" },
    { key: "tiktok", label: "TikTok", host: "tiktok.com" }
  ];
  function normSocial(raw, key) {
    var s = String(raw || "").trim();
    if (!s) return "";
    var net = SOCIALS.filter(function (x) { return x.key === key; })[0];
    if (!net) return "";
    if (/^@?[A-Za-z0-9._-]{2,40}$/.test(s)) {
      var h = s.replace(/^@/, "");
      return "https://www." + net.host + "/" + (key === "tiktok" ? "@" : "") + h;
    }
    var d = normDomain(s);
    if (d !== net.host && d !== net.alt && d.slice(-(net.host.length + 1)) !== "." + net.host) return "";
    return "https://" + s.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  }

  /* ---------- matching ---------- */

  function namesOf(c) {
    var out = [];
    var n = normName(val(c, "name"));
    if (n) out.push(n);
    (c.aliases || []).forEach(function (a) { var x = normName(a); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  /* Why two records are the same company, or null. Domain wins outright;
     a shared name counts only when the cities agree or one is unknown, so
     "Main Street Bakery" in Akron and in Toledo stay two companies. */
  function matchReason(a, b) {
    var da = val(a, "domain"), dbb = val(b, "domain");
    if (da && dbb) return da === dbb ? "domain" : null;
    var na = namesOf(a), nb = namesOf(b);
    var shared = na.some(function (n) { return nb.indexOf(n) >= 0; });
    if (!shared) return null;
    var ra = regionOf(val(a, "city")) || val(a, "city");
    var rb = regionOf(val(b, "city")) || val(b, "city");
    if (!ra || !rb || ra === rb) return "name";
    return null;
  }

  function findMatch(candidate, companies) {
    for (var i = 0; i < companies.length; i++) {
      var why = matchReason(candidate, companies[i]);
      if (why) return { company: companies[i], why: why };
    }
    return null;
  }

  /* ---------- building records from raw input ---------- */

  var COMPANY_FIELDS = ["name", "domain", "website", "city", "description", "industry", "customerMix",
    "foundedYear", "employees", "revenueBand", "revenueEstimate", "companyLinkedin", "instagram", "facebook", "x", "youtube", "tiktok", "parentOver25M", "hiring", "expansion", "investment",
    "growth", "financing", "targetIndustry", "engagement", "ownerIdentity"];

  /* A raw row from CSV, paste, an extraction or a discovery run → a company
     and its contacts. Source provenance travels onto every fact it supplies. */
  function fromRaw(raw, source, now) {
    var at = raw.verifiedAt || today(now);
    var src = raw.sourceUrl || (source && source.url) || "";
    var by = raw.by || "auto";
    var c = { f: {}, aliases: [], sources: [], conflicts: [] };
    /* a researched profile cites a different page for each fact */
    var ev = raw.evidence || {};
    function put(field, v) { if (!blank(v)) c.f[field] = fact(v, ev[field] || src, at, by); }

    put("name", String(raw.name || "").trim());
    var website = raw.website ? String(raw.website).trim() : "";
    if (website && !/^[a-z]+:\/\//i.test(website)) website = "https://" + website;
    var domain = companyDomain(raw.domain || website || raw.email);
    put("domain", domain);
    put("website", website || (domain ? "https://" + domain : ""));
    put("city", normCity(raw.city || (source && source.city)));
    put("description", raw.description ? String(raw.description).trim().slice(0, 400) : "");
    put("industry", raw.industry);
    put("customerMix", normMix(raw.customerMix));
    put("foundedYear", toYear(raw.foundedYear));
    put("employees", toInt(raw.employees));
    put("revenueBand", normRevenue(raw.revenueBand || raw.revenue));
    ["hiring", "expansion", "investment", "engagement"].forEach(function (k) { put(k, raw[k] ? String(raw[k]).trim() : ""); });
    ["growth", "financing", "targetIndustry", "parentOver25M"].forEach(function (k) {
      var t = normTri(raw[k]); if (t && t !== "unknown") put(k, t);
    });
    /* Identity is recorded only when the source itself states it —
       a founder network roster, a certification list, the owner's own words. */
    if (raw.ownerIdentity && raw.identitySource) {
      c.f.ownerIdentity = fact(String(raw.ownerIdentity).trim(), raw.identitySource, at, by);
    }

    if (source || src) {
      c.sources.push({
        url: src, label: (source && source.label) || raw.sourceLabel || "",
        type: (source && source.type) || raw.sourceType || "Other",
        sourceId: (source && source.id) || "", network: !!(source && source.network),
        at: at
      });
    }

    var contacts = [];
    var people = raw.contacts || (raw.contactName || raw.email || raw.phone ? [{
      name: raw.contactName, role: raw.contactRole, email: raw.email, phone: raw.phone, linkedin: raw.linkedin
    }] : []);
    people.forEach(function (p) {
      var ct = contactFromRaw(p, src, at, by);
      if (ct) contacts.push(ct);
    });
    if (!domain) {
      /* the owner's business email often names the site the directory left out */
      contacts.some(function (ct) {
        var d = companyDomain(val(ct, "email"));
        if (d) { c.f.domain = fact(d, ct.f.email.src, at, by); return true; }
        return false;
      });
    }
    if (raw.companyLinkedin) put("companyLinkedin", normLinkedIn(raw.companyLinkedin));
    /* a general inbox or main line belongs to the company, not a person */
    put("email", normEmail(raw.companyEmail));
    put("phone", normPhone(raw.companyPhone));
    SOCIALS.forEach(function (n) { put(n.key, normSocial(raw[n.key], n.key)); });
    /* Most small businesses publish no revenue. An estimate is kept apart
       from a stated figure, always with the reasoning behind it. */
    var estBand = normRevenue(raw.revenueEstimate);
    if (estBand) {
      c.f.revenueEstimate = fact(estBand, ev.revenueEstimate || src, at, by);
      c.f.revenueEstimate.basis = String(raw.revenueBasis || "").trim().slice(0, 300);
    }
    return { company: c, contacts: contacts };
  }

  function contactFromRaw(p, src, at, by) {
    if (!p) return null;
    var ct = { f: {}, doNotContact: !!p.doNotContact };
    var s = p.sourceUrl || src;
    function put(field, v) { if (!blank(v)) ct.f[field] = fact(v, s, p.verifiedAt || at, p.by || by); }
    put("name", p.name ? String(p.name).trim() : "");
    put("role", p.role ? String(p.role).trim() : "");
    put("email", normEmail(p.email));
    put("phone", normPhone(p.phone));
    put("linkedin", normLinkedIn(p.linkedin));
    if (!ct.f.name && !ct.f.email && !ct.f.phone && !ct.f.linkedin) return null;
    ct.decisionMaker = p.decisionMaker !== undefined ? !!p.decisionMaker : isDecisionRole(p.role);
    return ct;
  }

  var DM = /\b(owner|co-?owner|founder|co-?founder|ceo|chief|president|principal|managing (partner|director|member)|partner|proprietor|general manager|executive director)\b/i;
  function isDecisionRole(role) { return DM.test(String(role || "")); }

  function normMix(v) {
    var s = String(v || "").toLowerCase();
    if (!s) return "";
    if (/mix|both|b2b\s*\/\s*b2c|b2b and b2c/.test(s)) return "Mixed";
    if (/b2b|business/.test(s)) return "B2B";
    if (/b2c|consumer|retail/.test(s)) return "B2C";
    return "";
  }
  function normTri(v) {
    if (v === true) return "yes";
    if (v === false) return "no";
    var s = String(v || "").toLowerCase().trim();
    if (/^(y|yes|true|confirmed)$/.test(s)) return "yes";
    if (/^(n|no|false)$/.test(s)) return "no";
    return s ? "unknown" : "";
  }
  function toYear(v) {
    var m = String(v || "").match(/\b(18|19|20)\d{2}\b/);
    return m ? Number(m[0]) : "";
  }
  function toInt(v) {
    if (v === "" || v === null || v === undefined) return "";
    var m = String(v).replace(/,/g, "").match(/\d+/);
    return m ? Number(m[0]) : "";
  }
  function normRevenue(v) {
    if (!v) return "";
    var s = String(v).toLowerCase().trim();
    for (var i = 0; i < REVENUE_BANDS.length; i++) if (REVENUE_BANDS[i].id === s) return s;
    var n = parseMoney(s);
    if (n === null) return "";
    if (n < 100000) return "lt100k";
    if (n < 500000) return "100k-500k";
    if (n < 1000000) return "500k-1m";
    if (n < 5000000) return "1m-5m";
    if (n < 25000000) return "5m-25m";
    return "gte25m";
  }
  function parseMoney(s) {
    var m = String(s).replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m|mm|million|thousand|b)?/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    var u = (m[2] || "").toLowerCase();
    if (u === "k" || u === "thousand") n *= 1e3;
    else if (u === "m" || u === "mm" || u === "million") n *= 1e6;
    else if (u === "b") n *= 1e9;
    return n;
  }

  /* ---------- merging ---------- */

  function sameValue(a, b, field) {
    if (field === "name") return normName(a) === normName(b);
    if (field === "website") return normDomain(a) === normDomain(b);
    if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
    return a === b;
  }

  /* Folds incoming facts into an existing record.
     - an empty field is filled
     - an identical value refreshes the verified date
     - a different value over an automatic fact replaces it, and the change
       is kept as an open conflict for a researcher to confirm
     - a different value over a human fact never replaces it; it is only
       flagged, because a researcher's word outranks a refresh
     Returns the list of fields that changed or conflicted. */
  function mergeFacts(target, incoming, now) {
    target.f = target.f || {};
    target.conflicts = target.conflicts || [];
    var changed = [];
    Object.keys(incoming.f || {}).forEach(function (k) {
      var inc = incoming.f[k];
      var cur = target.f[k];
      if (!cur || blank(cur.v) || cur.v === "unknown") {
        target.f[k] = inc; changed.push({ field: k, kind: "filled" });
        return;
      }
      if (sameValue(cur.v, inc.v, k)) {
        if (inc.at && (!cur.at || inc.at > cur.at) && cur.by !== "human") { cur.at = inc.at; cur.src = inc.src || cur.src; }
        return;
      }
      var open = target.conflicts.filter(function (x) { return x.field === k && !x.resolved && sameValue(x.incoming.v, inc.v, k); });
      if (open.length) return;
      target.conflicts.push({ field: k, current: cur, incoming: inc, at: today(now), resolved: false });
      if (cur.by !== "human" && inc.by !== "human") {
        target.f[k] = inc;
        changed.push({ field: k, kind: "replaced" });
      } else if (inc.by === "human") {
        target.f[k] = inc;
        changed.push({ field: k, kind: "replaced" });
      } else {
        changed.push({ field: k, kind: "protected" });
      }
    });
    return changed;
  }

  function mergeCompany(target, incoming, now) {
    /* A second name for the same company ("Acme" vs "Acme Fabrication LLC")
       is kept as an alias rather than fought over as a conflict. */
    var inName = val(incoming, "name");
    var facts = Object.assign({}, incoming.f);
    if (inName && val(target, "name") && normName(inName) !== normName(val(target, "name"))) {
      delete facts.name;
      target.aliases = target.aliases || [];
      if (target.aliases.map(normName).indexOf(normName(inName)) < 0) target.aliases.push(inName);
    }
    var changed = mergeFacts(target, { f: facts }, now);
    target.sources = target.sources || [];
    (incoming.sources || []).forEach(function (s) {
      var dup = target.sources.some(function (t) { return t.url && t.url === s.url; });
      if (!dup) target.sources.push(s);
    });
    return changed;
  }

  /* Same person at the same company: a shared email, a shared LinkedIn, or
     the same name. Each contact method keeps its own source and date. */
  function contactMatch(a, b) {
    var ea = val(a, "email"), eb = val(b, "email");
    if (ea && eb && ea === eb) return true;
    var la = val(a, "linkedin"), lb = val(b, "linkedin");
    if (la && lb && la.toLowerCase() === lb.toLowerCase()) return true;
    var na = normName(val(a, "name")), nb = normName(val(b, "name"));
    return !!(na && nb && na === nb);
  }

  /* Ingest one raw record against the current state.
     Returns what happened so the caller can write it and log it. */
  function ingest(raw, source, state, now) {
    var built = fromRaw(raw, source, now);
    var incoming = built.company;
    if (!val(incoming, "name") && !val(incoming, "domain")) return { action: "skipped", reason: "no name or domain" };

    var sup = suppressed(incoming, state.suppression || []);
    var match = findMatch(incoming, state.companies || []);
    var company, action, changed = [];
    if (match) {
      company = clone(match.company);
      changed = mergeCompany(company, incoming, now);
      action = "merged";
      /* a company already in outreach is never re-queued as new: that is how
         rediscovery turns into repeat contact */
      if (changed.length && company.review && company.review.state === "approved" && !inOutreach(company)) {
        company.review.refreshed = today(now);
      }
    } else {
      company = incoming;
      company.id = stableId("co", companyKey(incoming));
      company.createdAt = today(now);
      /* the researcher's own note on the company website decides whether
         this starts in the queue or under Investigate */
      var vnote = raw.verifyNote ? String(raw.verifyNote).slice(0, 300) : "";
      var doubt = vnote && NEEDS_LOOK.test(vnote);
      company.review = sup ? { state: "rejected", note: "Suppressed: " + sup }
        : doubt ? { state: "investigate", note: "Research note: " + vnote }
        : { state: "new", note: vnote ? "Research note: " + vnote : "" };
      action = sup ? "suppressed" : "created";
    }
    company.updatedAt = today(now);
    if (!company.review) company.review = { state: "new" };
    if (sup) company.doNotContact = true;

    var existingContacts = (state.contacts || []).filter(function (x) { return x.companyId === company.id; });
    var contacts = built.contacts.map(function (ct) {
      var hit = null;
      for (var i = 0; i < existingContacts.length; i++) if (contactMatch(existingContacts[i], ct)) { hit = existingContacts[i]; break; }
      if (hit) {
        var merged = clone(hit);
        var cc = mergeFacts(merged, ct, now);
        if (ct.decisionMaker) merged.decisionMaker = true;
        merged.updatedAt = today(now);
        if (cc.some(function (x) { return x.kind !== "filled"; })) merged.changed = today(now);
        return { contact: merged, action: "merged" };
      }
      ct.id = stableId("ct", contactKey(company.id, ct));
      ct.companyId = company.id;
      ct.createdAt = today(now);
      ct.updatedAt = today(now);
      if (company.doNotContact) ct.doNotContact = true;
      return { contact: ct, action: "created" };
    });

    return { action: action, company: company, match: match ? match.why : null, changed: changed, contacts: contacts };
  }

  var NEEDS_LOOK = /(for sale|parked|closed|out of business|acquired|bought by|subsidiary|outside ohio|out of state|michigan|pennsylvania|indiana|kentucky|out of range|too large|well over 100|venture|isn.t named|not named|mailbox)/i;

  function suppressed(c, list) {
    var d = val(c, "domain"), n = normName(val(c, "name"));
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.domain && d && s.domain === d) return s.reason || "opted out";
      if (s.name && n && normName(s.name) === n) return s.reason || "opted out";
    }
    return "";
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- outreach state (read back from Airtable) ---------- */

  function inOutreach(c) {
    var o = c.outreach || {};
    return !!(o.firstContactAt || (o.status && o.status !== "Not started"));
  }

  /* ---------- scoring ---------- */

  function cohortFor(region, cohorts, now) {
    var t = today(now);
    var list = (cohorts || []).filter(function (x) { return x.city === region && x.date && x.date >= t; });
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return list[0] || null;
  }

  function bestContact(contacts, now) {
    var best = null, bestRank = -1;
    (contacts || []).forEach(function (ct) {
      if (ct.doNotContact) return;
      var r = 0;
      if (ct.decisionMaker) r += 10;
      var email = ct.f && ct.f.email, phone = ct.f && ct.f.phone, li = ct.f && ct.f.linkedin;
      if (email && email.v) r += fresh(email.at, now) ? 5 : 2;
      if (phone && phone.v) r += fresh(phone.at, now) ? 3 : 1;
      if (li && li.v) r += 2;
      if (r > bestRank) { bestRank = r; best = ct; }
    });
    return best;
  }
  function fresh(at, now) {
    var d = daysBetween(at, today(now));
    return d !== null && d <= CONTACT_STALE_DAYS;
  }

  /* Bootcamp outreach priority, 0–100. Ranks attention, not admission.
     An unknown fact earns no points and is listed as missing, which lowers
     confidence and sends the profile back to research — it is not evidence
     against the company. */
  function scoreBootcamp(c, contacts, settings, now) {
    settings = settings || {};
    var priority = settings.priorityCities || PRIORITY_CITIES;
    var reasons = [], missing = [];
    var parts = { place: 0, fit: 0, traction: 0, reach: 0, timing: 0 };
    var known = 0, asked = 0;
    function ask(present) { asked++; if (present) known++; return present; }

    /* 1. priority city or upcoming cohort — 25 */
    var city = val(c, "city");
    var region = regionOf(city) || city;
    if (ask(!!city)) {
      var cohort = cohortFor(region, settings.cohorts, now);
      if (priority.indexOf(region) >= 0) { parts.place = 25; reasons.push("Priority city: " + region); }
      else if (cohort && daysBetween(today(now), cohort.date) <= 90) { parts.place = 25; reasons.push(region + " cohort on " + cohort.date); }
      else if (cohort) { parts.place = 18; reasons.push(region + " cohort on " + cohort.date); }
      else if (EXPANSION_CITIES.indexOf(region) >= 0) { parts.place = 10; reasons.push(region + " is a planned expansion city"); }
      else { parts.place = 5; reasons.push("Ohio, outside the cohort cities"); }
    } else missing.push("City");

    /* 2. Bootcamp relevance and growth need — 25 */
    if (ask(!!val(c, "description"))) parts.fit += 5; else missing.push("Description");
    var mix = val(c, "customerMix");
    if (ask(!!mix && mix !== "Unknown")) {
      parts.fit += mix === "B2B" ? 7 : mix === "Mixed" ? 6 : 4;
      reasons.push(mix + " customers");
    } else missing.push("Customer mix");
    var yr = val(c, "foundedYear");
    var age = yr ? new Date((now || new Date()).getTime()).getFullYear() - yr : null;
    if (ask(age !== null)) {
      if (age >= 1 && age <= 10) { parts.fit += 7; reasons.push("Operating " + age + " yr" + (age === 1 ? "" : "s") + " — growth stage"); }
      else if (age > 10) { parts.fit += 4; reasons.push("Established " + age + " yrs"); }
      else { parts.fit += 2; reasons.push("Under a year old"); }
    } else missing.push("Year founded");
    var emp = val(c, "employees");
    if (ask(emp !== undefined)) {
      if (emp >= 2 && emp <= 100) { parts.fit += 6; reasons.push(emp + " employees"); }
      else if (emp > 100) parts.fit += 2;
      else parts.fit += 3;
    } else missing.push("Employees");

    /* 3. traction, hiring or expansion — 20 */
    var hiring = val(c, "hiring"), expansion = val(c, "expansion"), rev = val(c, "revenueBand") || val(c, "revenueEstimate");
    if (hiring) { parts.traction += 8; reasons.push("Hiring: " + clip(hiring)); }
    if (expansion) { parts.traction += 6; reasons.push("Expansion: " + clip(expansion)); }
    if (ask(!!rev)) {
      if (rev === "lt100k") parts.traction += 2;
      else { parts.traction += 6; reasons.push("Revenue " + bandLabel(rev)); }
    } else missing.push("Revenue");
    if (!hiring && !expansion) { asked++; missing.push("Hiring or expansion signal"); } else { asked++; known++; }
    parts.traction = Math.min(20, parts.traction);

    /* 4. verified reachable decision maker — 15 */
    var ct = bestContact(contacts, now);
    if (ask(!!ct)) {
      var email = ct.f.email, phone = ct.f.phone, li = ct.f.linkedin;
      var direct = (email && email.v) || (phone && phone.v);
      var freshDirect = (email && email.v && fresh(email.at, now)) || (phone && phone.v && fresh(phone.at, now));
      if (ct.decisionMaker && freshDirect) { parts.reach = 15; reasons.push("Decision maker reachable: " + (val(ct, "name") || "contact")); }
      else if (ct.decisionMaker && direct) { parts.reach = 9; reasons.push("Decision maker contact needs re-verifying"); missing.push("Fresh contact verification"); }
      else if (ct.decisionMaker && li && li.v) { parts.reach = 7; missing.push("Decision maker email or phone"); }
      else if (direct) { parts.reach = 6; missing.push("Decision maker"); }
      else { parts.reach = 3; missing.push("Contact method"); }
    } else missing.push("Decision maker contact");

    /* 5. timeliness and engagement — 15 */
    var types = (c.sources || []).map(function (s) { return s.type; });
    var last = lastTouched(c);
    if (last && daysBetween(last, today(now)) <= 30) { parts.timing += 5; }
    if (types.indexOf("Partner referral") >= 0) { parts.timing += 6; reasons.push("Partner referral"); }
    else if (types.indexOf("Event roster") >= 0 || types.indexOf("Accelerator list") >= 0) { parts.timing += 4; reasons.push("From an event or accelerator list"); }
    if (val(c, "engagement")) { parts.timing += 5; reasons.push("Engagement: " + clip(val(c, "engagement"))); }
    parts.timing = Math.min(15, parts.timing);

    var score = parts.place + parts.fit + parts.traction + parts.reach + parts.timing;
    var ratio = asked ? known / asked : 0;
    var confidence = ratio >= 0.75 ? "High" : ratio >= 0.45 ? "Medium" : "Low";

    var override = c.override && typeof c.override.score === "number" ? c.override : null;
    return {
      score: override ? override.score : score,
      computed: score,
      override: override,
      parts: parts,
      reasons: reasons,
      missing: missing,
      confidence: confidence
    };
  }

  function clip(s) { s = String(s); return s.length > 60 ? s.slice(0, 57) + "…" : s; }
  function bandLabel(id) {
    for (var i = 0; i < REVENUE_BANDS.length; i++) if (REVENUE_BANDS[i].id === id) return REVENUE_BANDS[i].label;
    return id;
  }
  function lastTouched(c) {
    var best = c.createdAt || "";
    Object.keys(c.f || {}).forEach(function (k) { var a = c.f[k].at; if (a && a > best) best = a; });
    return best;
  }

  function industryMatch(industry, description) {
    var hay = " " + String(industry || "").toLowerCase() + " " + String(description || "").toLowerCase() + " ";
    for (var i = 0; i < JOBSOHIO_INDUSTRIES.length; i++) {
      var ind = JOBSOHIO_INDUSTRIES[i];
      for (var j = 0; j < ind.kw.length; j++) if (hay.indexOf(ind.kw[j]) >= 0) return ind.name;
    }
    return "";
  }

  /* JobsOhio Small Business Grant pre-screen. A research aid only:
     JobsOhio makes eligibility and award decisions, and a company that
     misses here remains a Bootcamp prospect. */
  function grantPrescreen(c, now) {
    var year = (now || new Date()).getFullYear();
    var items = [];
    function item(key, label, answer, why) { items.push({ key: key, label: label, answer: answer, why: why || "" }); }

    var fy = val(c, "foundedYear");
    item("age", "Operating at least one year",
      fy ? (year - fy >= 1 ? "yes" : "no") : "unknown", fy ? "Founded " + fy : "Year founded unknown");

    var rev = val(c, "revenueBand"), parent = val(c, "parentOver25M");
    var est = val(c, "revenueEstimate");
    var revAns = "unknown", revWhy = est ? "Estimated " + bandLabel(est) + " — not confirmed" : "Revenue unknown";
    if (rev === "lt100k") { revAns = "no"; revWhy = "Under $100K"; }
    else if (rev === "gte25m" || parent === "yes") { revAns = "no"; revWhy = parent === "yes" ? "Parent company at or above $25M" : "$25M or more"; }
    else if (rev) { revAns = parent === "no" ? "yes" : "unknown"; revWhy = bandLabel(rev) + (parent === "no" ? ", no large parent" : "; parent-company revenue not confirmed"); }
    item("revenue", "Revenue $100K to under $25M, parent included", revAns, revWhy);

    var ti = val(c, "targetIndustry");
    var guess = industryMatch(val(c, "industry"), val(c, "description"));
    item("industry", "JobsOhio target industry",
      ti || (guess ? "yes" : (val(c, "industry") ? "unknown" : "unknown")),
      ti ? "Set by researcher" : guess ? "Looks like " + guess + " — confirm" : "Industry not matched");

    var mix = val(c, "customerMix");
    item("b2b", "Primarily B2B revenue", mix === "B2B" ? "yes" : mix === "B2C" ? "no" : "unknown",
      mix ? mix + " customers" : "Customer mix unknown");

    var inv = val(c, "investment");
    item("investment", "A concrete eligible investment", inv ? "yes" : "unknown", inv ? clip(inv) : "No planned investment found");

    var growth = val(c, "growth");
    item("growth", "Credible 10% job/payroll growth or at-risk retention", growth || "unknown",
      growth ? "Set by researcher" : (val(c, "hiring") ? "Hiring signal — confirm the 10%" : "No growth evidence"));

    var fin = val(c, "financing");
    item("financing", "Can finance spending before reimbursement", fin || "unknown",
      fin ? "Set by researcher" : "Not yet asked");

    var no = items.filter(function (x) { return x.answer === "no"; }).length;
    var yes = items.filter(function (x) { return x.answer === "yes"; }).length;
    var outcome = no ? "Unlikely fit" : yes === items.length ? "Potential referral" : "Needs review";
    return { outcome: outcome, items: items, yes: yes, no: no, unknown: items.length - yes - no };
  }

  /* How likely we could get this company the grant, 0–100. The same seven
     criteria as the checklist, weighted, with partial credit for evidence
     that points the right way but isn't confirmed (an estimated revenue, a
     hiring post standing in for 10% growth). Any clear No caps the score:
     a company that fails a hard requirement shouldn't rank on the rest. */
  var GRANT_WEIGHTS = { age: 10, revenue: 20, industry: 20, b2b: 15, investment: 15, growth: 10, financing: 10 };

  function grantLikelihood(c, now) {
    var pre = grantPrescreen(c, now);
    var byKey = {};
    pre.items.forEach(function (i) { byKey[i.key] = i; });
    var parts = [], missing = [], evidenced = 0, hardNo = false;
    function part(key, points, why, known) {
      var max = GRANT_WEIGHTS[key];
      var it = byKey[key];
      if (it.answer === "no") { hardNo = true; points = 0; }
      if (known || it.answer !== "unknown") evidenced++;
      else missing.push(it.label);
      parts.push({ key: key, label: it.label, points: Math.min(max, points), max: max, answer: it.answer, why: why || it.why });
    }

    part("age", byKey.age.answer === "yes" ? 10 : 0);

    var rev = val(c, "revenueBand"), est = val(c, "revenueEstimate"), parent = val(c, "parentOver25M");
    var inRange = function (b) { return b && b !== "lt100k" && b !== "gte25m"; };
    if (byKey.revenue.answer === "yes") part("revenue", 20);
    else if (inRange(rev)) part("revenue", 16, bandLabel(rev) + " stated; parent company not confirmed", true);
    else if (inRange(est)) {
      var basis = c.f.revenueEstimate.basis;
      part("revenue", 12, "Estimated " + bandLabel(est) + (basis ? " — " + basis : ""), true);
    } else if (est) part("revenue", 2, "Estimated " + bandLabel(est) + " — likely outside the range", true);
    else part("revenue", 0);

    var ti = val(c, "targetIndustry");
    var guess = industryMatch(val(c, "industry"), val(c, "description"));
    if (ti === "yes") part("industry", 20);
    else if (!ti && guess) part("industry", 14, "Looks like " + guess + " — confirm", true);
    else part("industry", 0);

    var mix = val(c, "customerMix");
    part("b2b", mix === "B2B" ? 15 : mix === "Mixed" ? 7 : 0, null, mix === "Mixed");

    if (val(c, "investment")) part("investment", 15);
    else if (val(c, "expansion")) part("investment", 7, "Expansion signal: " + clip(val(c, "expansion")) + " — find the specific investment", true);
    else part("investment", 0);

    var growth = val(c, "growth");
    if (growth === "yes") part("growth", 10);
    else if (!growth && val(c, "hiring")) part("growth", 6, "Hiring: " + clip(val(c, "hiring")) + " — confirm it reaches 10%", true);
    else if (!growth && val(c, "expansion")) part("growth", 4, "Expanding — confirm jobs or payroll grow 10%", true);
    else part("growth", 0);

    var fin = val(c, "financing");
    var bigEnough = ["1m-5m", "5m-25m"].indexOf(rev || est) >= 0;
    if (fin === "yes") part("financing", 10);
    else if (!fin && bigEnough) part("financing", 3, "Revenue suggests some cash flow — ask", false);
    else part("financing", 0, "Ask on the first call");

    var score = parts.reduce(function (a, p) { return a + p.points; }, 0);
    if (hardNo) score = Math.min(score, 15);
    var ratio = evidenced / parts.length;
    return {
      score: score,
      parts: parts,
      missing: missing,
      hardNo: hardNo,
      outcome: pre.outcome,
      confidence: ratio >= 0.7 ? "High" : ratio >= 0.4 ? "Medium" : "Low",
      checklist: pre
    };
  }

  /* The best way to reach a company: the decision maker's own business
     email and phone first, then anyone else's, then a general company inbox
     or main line. Do-not-contact people are never offered. */
  function reachOf(c, contacts) {
    var live = (contacts || []).filter(function (x) { return !x.doNotContact; });
    live.sort(function (a, b) { return (b.decisionMaker ? 1 : 0) - (a.decisionMaker ? 1 : 0); });
    function pick(field) {
      for (var i = 0; i < live.length; i++) {
        var f = live[i].f && live[i].f[field];
        if (f && f.v) return { v: f.v, who: val(live[i], "name") || "", role: val(live[i], "role") || "", src: f.src, at: f.at };
      }
      var cf = c.f && c.f[field];
      if (cf && cf.v) return { v: cf.v, who: "Main office", role: "", src: cf.src, at: cf.at };
      return null;
    }
    if (c.doNotContact) return { email: null, phone: null };
    return { email: pick("email"), phone: pick("phone") };
  }

  function revenueText(c) {
    var r = val(c, "revenueBand");
    if (r) return bandLabel(r);
    var e = val(c, "revenueEstimate");
    return e ? "Est. " + bandLabel(e) : "";
  }

  function socialsOf(c) {
    var out = [];
    var li = val(c, "companyLinkedin");
    if (li) out.push({ key: "linkedin", label: "LinkedIn", url: li });
    SOCIALS.forEach(function (n) { var u = val(c, n.key); if (u) out.push({ key: n.key, label: n.label, url: u }); });
    return out;
  }

  /* ---------- flags the Today view surfaces ---------- */

  function flags(c, contacts, now) {
    var out = [];
    var t = today(now);
    if ((c.conflicts || []).some(function (x) { return !x.resolved; })) out.push("conflict");
    /* only an approved profile can go stale; a new one is simply unreviewed */
    var approved = c.review && c.review.state === "approved";
    if (approved && (!c.verifiedAt || daysBetween(c.verifiedAt, t) > PROFILE_STALE_DAYS)) out.push("stale-profile");
    var live = (contacts || []).filter(function (x) { return !x.doNotContact; });
    if (!live.length) out.push("no-contact");
    live.forEach(function (ct) {
      ["email", "phone"].forEach(function (m) {
        var f = ct.f && ct.f[m];
        if (f && f.v && !fresh(f.at, now) && out.indexOf("stale-contact") < 0) out.push("stale-contact");
      });
      if (ct.changed && daysBetween(ct.changed, t) <= 14 && out.indexOf("contact-changed") < 0) out.push("contact-changed");
    });
    if (c.airtable && c.airtable.status === "error") out.push("sync-error");
    if (c.doNotContact || (c.outreach && c.outreach.optedOut)) out.push("do-not-contact");
    return out;
  }

  /* ---------- Airtable mapping ---------- */

  var AT_COMPANY = {
    externalId: "External ID", name: "Company", domain: "Domain", website: "Website", city: "City",
    region: "Region", industry: "Industry", description: "Description", customerMix: "Customer mix",
    priority: "Bootcamp priority", confidence: "Priority confidence", reasons: "Priority reasons",
    grant: "Grant pre-screen", checklist: "Grant checklist", sources: "Source links",
    discovered: "Discovered", verified: "Verified", approvedBy: "Approved by",
    status: "Outreach status", owner: "Outreach owner", firstContact: "First contact date",
    channel: "Channel", followUp: "Next follow-up", replied: "Replied", applied: "Applied",
    attended: "Attended", doNotContact: "Do not contact", grantReferral: "Grant referral",
    lastSynced: "Last synced", likelihood: "Grant likelihood", likelihoodConfidence: "Grant confidence",
    revenue: "Revenue (est.)", revenueBasis: "Revenue basis", companyLinkedin: "Company LinkedIn",
    socials: "Social profiles", email: "Email", phone: "Phone"
  };
  var AT_CONTACT = {
    externalId: "External ID", name: "Name", companyExternalId: "Company External ID", company: "Company",
    role: "Role", decisionMaker: "Decision maker", email: "Email", emailVerified: "Email verified",
    phone: "Phone", phoneVerified: "Phone verified", linkedin: "LinkedIn", sources: "Sources",
    doNotContact: "Do not contact"
  };

  /* The desk writes research; Airtable owns outreach. So an export carries
     only the research fields, and never touches status, owner, dates or
     replies — the team's record of what happened stays theirs. */
  function companyToAirtable(c, contacts, settings, now) {
    var s = scoreBootcamp(c, contacts, settings, now);
    var g = grantPrescreen(c, now);
    var region = regionOf(val(c, "city"));
    var reasons = s.reasons.slice();
    if (s.override) reasons.unshift("Manual override " + s.override.score + " (computed " + s.computed + "): " + s.override.reason);
    if (s.missing.length) reasons.push("Missing: " + s.missing.join(", "));
    var out = {};
    out[AT_COMPANY.externalId] = c.id;
    out[AT_COMPANY.name] = val(c, "name") || "";
    out[AT_COMPANY.domain] = val(c, "domain") || "";
    out[AT_COMPANY.website] = val(c, "website") || null;
    out[AT_COMPANY.city] = val(c, "city") || "";
    out[AT_COMPANY.region] = region || "";
    out[AT_COMPANY.industry] = val(c, "industry") || "";
    out[AT_COMPANY.description] = val(c, "description") || "";
    out[AT_COMPANY.customerMix] = val(c, "customerMix") || "Unknown";
    out[AT_COMPANY.priority] = s.score;
    out[AT_COMPANY.confidence] = s.confidence;
    out[AT_COMPANY.reasons] = reasons.join("\n");
    out[AT_COMPANY.grant] = g.outcome;
    out[AT_COMPANY.checklist] = g.items.map(function (i) { return (i.answer === "yes" ? "✔ " : i.answer === "no" ? "✘ " : "? ") + i.label + " — " + i.why; }).join("\n");
    out[AT_COMPANY.sources] = (c.sources || []).map(function (x) { return (x.label ? x.label + ": " : "") + x.url + (x.at ? " (" + x.at + ")" : ""); }).join("\n");
    out[AT_COMPANY.discovered] = c.createdAt || null;
    out[AT_COMPANY.verified] = c.verifiedAt || null;
    out[AT_COMPANY.approvedBy] = (c.review && c.review.byName) || "";
    out[AT_COMPANY.doNotContact] = !!c.doNotContact;
    out[AT_COMPANY.lastSynced] = new Date((now || new Date()).getTime()).toISOString();
    var gl = grantLikelihood(c, now);
    out[AT_COMPANY.likelihood] = gl.score;
    out[AT_COMPANY.likelihoodConfidence] = gl.confidence;
    out[AT_COMPANY.revenue] = revenueText(c) || "Unknown";
    out[AT_COMPANY.revenueBasis] = (c.f.revenueEstimate && !val(c, "revenueBand") && c.f.revenueEstimate.basis) || (val(c, "revenueBand") ? "Stated: " + ((c.f.revenueBand && c.f.revenueBand.src) || "") : "");
    out[AT_COMPANY.companyLinkedin] = val(c, "companyLinkedin") || null;
    var reach = reachOf(c, contacts);
    out[AT_COMPANY.email] = reach.email ? reach.email.v : null;
    out[AT_COMPANY.phone] = reach.phone ? reach.phone.v : null;
    out[AT_COMPANY.socials] = socialsOf(c).filter(function (x) { return x.key !== "linkedin"; }).map(function (x) { return x.label + ": " + x.url; }).join("\n");
    return out;
  }

  function contactToAirtable(ct, company) {
    var out = {};
    out[AT_CONTACT.externalId] = ct.id;
    out[AT_CONTACT.name] = val(ct, "name") || "";
    out[AT_CONTACT.companyExternalId] = company.id;
    if (company.airtable && company.airtable.recordId) out[AT_CONTACT.company] = [company.airtable.recordId];
    out[AT_CONTACT.role] = val(ct, "role") || "";
    out[AT_CONTACT.decisionMaker] = !!ct.decisionMaker;
    /* a do-not-contact person keeps a row, so they are never rediscovered,
       but carries no way to reach them */
    var dnc = !!(ct.doNotContact || company.doNotContact);
    out[AT_CONTACT.email] = dnc ? null : (val(ct, "email") || null);
    out[AT_CONTACT.emailVerified] = dnc ? null : ((ct.f.email && ct.f.email.at) || null);
    out[AT_CONTACT.phone] = dnc ? null : (val(ct, "phone") || null);
    out[AT_CONTACT.phoneVerified] = dnc ? null : ((ct.f.phone && ct.f.phone.at) || null);
    out[AT_CONTACT.linkedin] = dnc ? null : (val(ct, "linkedin") || null);
    out[AT_CONTACT.sources] = ["name", "role", "email", "phone", "linkedin"].filter(function (k) { return ct.f[k] && ct.f[k].src; })
      .map(function (k) { return k + ": " + ct.f[k].src + (ct.f[k].at ? " (" + ct.f[k].at + ")" : ""); }).join("\n");
    out[AT_CONTACT.doNotContact] = dnc;
    return out;
  }

  /* Airtable's outreach fields → the desk's read-only outreach block. */
  function outreachFromAirtable(fields) {
    fields = fields || {};
    function sel(v) { return v && typeof v === "object" ? v.name : v || ""; }
    var status = sel(fields[AT_COMPANY.status]);
    return {
      status: status || "Not started",
      owner: fields[AT_COMPANY.owner] || "",
      firstContactAt: fields[AT_COMPANY.firstContact] || "",
      channel: sel(fields[AT_COMPANY.channel]),
      followUp: fields[AT_COMPANY.followUp] || "",
      replied: !!fields[AT_COMPANY.replied] || status === "Replied" || status === "Applied" || status === "Attended",
      applied: !!fields[AT_COMPANY.applied] || status === "Applied" || status === "Attended",
      attended: !!fields[AT_COMPANY.attended] || status === "Attended",
      optedOut: !!fields[AT_COMPANY.doNotContact] || status === "Opted out",
      grantReferral: sel(fields[AT_COMPANY.grantReferral]) || "None"
    };
  }

  /* ---------- performance ---------- */

  function weekStart(dateStr) {
    var d = new Date(dateStr + "T12:00:00");
    var day = (d.getDay() + 6) % 7;       /* Monday-based weeks */
    d.setDate(d.getDate() - day);
    return iso(d);
  }

  /* Each count is its own set of distinct companies, so discovery volume
     can never stand in for outreach or enrolment. */
  function metrics(companies, now, fromDate, toDate) {
    function inRange(d) { return d && d >= fromDate && d <= toDate; }
    var m = { discovered: 0, approved: 0, synced: 0, firstContacted: 0, replies: 0, applications: 0,
      attendance: 0, grantReferrals: 0, founderNetwork: 0, verifiedContact: 0, byCity: {}, bySource: {} };
    companies.forEach(function (c) {
      var o = c.outreach || {};
      if (inRange(c.createdAt)) {
        m.discovered++;
        (c.sources || []).some(function (s) { return s.network; }) && m.founderNetwork++;
        var src = (c.sources && c.sources[0] && (c.sources[0].label || c.sources[0].type)) || "Unknown";
        m.bySource[src] = (m.bySource[src] || 0) + 1;
      }
      if (c.review && c.review.state === "approved" && inRange(c.review.at)) m.approved++;
      if (c.airtable && inRange(c.airtable.firstSyncedAt)) m.synced++;
      if (inRange(o.firstContactAt)) {
        m.firstContacted++;
        var region = regionOf(val(c, "city")) || val(c, "city") || "Unknown";
        m.byCity[region] = (m.byCity[region] || 0) + 1;
      }
      if (o.replied && inRange(o.firstContactAt || c.updatedAt)) m.replies++;
      if (o.applied && inRange(o.firstContactAt || c.updatedAt)) m.applications++;
      if (o.attended && inRange(o.firstContactAt || c.updatedAt)) m.attendance++;
      if (o.grantReferral && o.grantReferral !== "None" && inRange(o.firstContactAt || c.updatedAt)) m.grantReferrals++;
    });
    return m;
  }

  /* ---------- CSV ---------- */

  function parseCSV(text) {
    var rows = [], row = [], cell = "", q = false;
    text = String(text || "").replace(/\r\n?/g, "\n");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === "," || ch === "\t") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ""; }); });
    if (!rows.length) return [];
    var head = rows[0].map(headerKey);
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, j) { if (h && !blank(r[j])) o[h] = String(r[j]).trim(); });
      return o;
    });
  }

  var HEADERS = {
    name: /^(company|company name|business|business name|name|organization|organisation)$/,
    website: /^(website|url|site|web|homepage)$/,
    domain: /^domain$/,
    city: /^(city|town|location)$/,
    description: /^(description|about|summary)$/,
    industry: /^(industry|sector|category)$/,
    customerMix: /^(customer mix|b2b\/b2c|b2b|market)$/,
    foundedYear: /^(founded|year founded|established|founded year)$/,
    employees: /^(employees|employee count|headcount|size)$/,
    revenue: /^(revenue|annual revenue|sales)$/,
    contactName: /^(contact|contact name|owner|owner name|founder|decision maker)$/,
    contactRole: /^(title|role|contact title|position)$/,
    email: /^(email|e-mail|contact email|business email)$/,
    phone: /^(phone|telephone|phone number)$/,
    linkedin: /^(linkedin|contact linkedin|personal linkedin)$/,
    companyLinkedin: /^(company linkedin|linkedin company)$/,
    hiring: /^(hiring|hiring signal)$/,
    expansion: /^(expansion|expansion signal)$/,
    sourceUrl: /^(source|source url|source link)$/
  };
  function headerKey(h) {
    var s = String(h || "").trim().toLowerCase();
    for (var k in HEADERS) if (HEADERS[k].test(s)) return k;
    return "";
  }

  return {
    PRIORITY_CITIES: PRIORITY_CITIES, EXPANSION_CITIES: EXPANSION_CITIES,
    JOBSOHIO_INDUSTRIES: JOBSOHIO_INDUSTRIES, REVENUE_BANDS: REVENUE_BANDS,
    SOURCE_TYPES: SOURCE_TYPES, TRI: TRI, COMPANY_FIELDS: COMPANY_FIELDS,
    CONTACT_STALE_DAYS: CONTACT_STALE_DAYS, PROFILE_STALE_DAYS: PROFILE_STALE_DAYS,
    AT_COMPANY: AT_COMPANY, AT_CONTACT: AT_CONTACT,
    today: today, iso: iso, daysBetween: daysBetween, uid: uid, stableId: stableId, companyKey: companyKey, contactKey: contactKey, val: val, fact: fact, blank: blank,
    normDomain: normDomain, companyDomain: companyDomain, normName: normName, normCity: normCity,
    regionOf: regionOf, normEmail: normEmail, normPhone: normPhone, normLinkedIn: normLinkedIn,
    normRevenue: normRevenue, normMix: normMix, normTri: normTri, bandLabel: bandLabel,
    matchReason: matchReason, findMatch: findMatch, fromRaw: fromRaw, contactFromRaw: contactFromRaw,
    isDecisionRole: isDecisionRole, mergeFacts: mergeFacts, mergeCompany: mergeCompany,
    contactMatch: contactMatch, ingest: ingest, suppressed: suppressed, inOutreach: inOutreach,
    scoreBootcamp: scoreBootcamp, grantPrescreen: grantPrescreen, grantLikelihood: grantLikelihood,
    GRANT_WEIGHTS: GRANT_WEIGHTS, SOCIALS: SOCIALS, normSocial: normSocial, revenueText: revenueText, socialsOf: socialsOf, reachOf: reachOf, industryMatch: industryMatch,
    bestContact: bestContact, flags: flags, companyToAirtable: companyToAirtable,
    contactToAirtable: contactToAirtable, outreachFromAirtable: outreachFromAirtable,
    metrics: metrics, weekStart: weekStart, parseCSV: parseCSV, clone: clone
  };
});
