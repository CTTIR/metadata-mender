/* eslint-disable no-undef */
// Metadata Mender — core module.
// Loaded into the plugin sandbox by bootstrap.js; `Zotero` and `rootURI` are injected.

Zotero.MetadataMender = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  addedElementIDs: [],
  _sourceCache: {},
  _popupHandlers: [],
  _cancelRequested: false,

  PREFS: {
    openalexKey: "extensions.metadata-mender.openalexKey",
    ncbiKey: "extensions.metadata-mender.ncbiKey",
    crossrefMailto: "extensions.metadata-mender.crossrefMailto",
    crossrefPlusToken: "extensions.metadata-mender.crossrefPlusToken",
    semanticScholarKey: "extensions.metadata-mender.semanticScholarKey",
    coreKey: "extensions.metadata-mender.coreKey",
    sourcePriority: "extensions.metadata-mender.sourcePriority",
    overwriteMode: "extensions.metadata-mender.overwriteMode",
    initialsGivenNames: "extensions.metadata-mender.initialsGivenNames",
    titleFallback: "extensions.metadata-mender.titleFallback",
    tagPolicy: "extensions.metadata-mender.tagPolicy",
    concurrency: "extensions.metadata-mender.concurrency",
  },

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._setDefaultPrefs();
    this.RateLimiter.reset();
    this._sourceCache = {};
    this._popupHandlers = [];
    this.initialized = true;
  },

  shutdown() {
    this.initialized = false;
  },

  _setDefaultPrefs() {
    const setIfUnset = (key, val) => {
      if (Zotero.Prefs.get(key, true) === undefined) {
        Zotero.Prefs.set(key, val, true);
      }
    };
    setIfUnset(this.PREFS.openalexKey, "");
    setIfUnset(this.PREFS.ncbiKey, "");
    setIfUnset(this.PREFS.crossrefMailto, "");
    setIfUnset(this.PREFS.crossrefPlusToken, "");
    setIfUnset(this.PREFS.semanticScholarKey, "");
    setIfUnset(this.PREFS.coreKey, "");
    setIfUnset(
      this.PREFS.sourcePriority,
      "pubmed,openalex,crossref,semanticscholar,openaire,unpaywall,core,cran"
    );
    setIfUnset(this.PREFS.overwriteMode, "overwrite");
    setIfUnset(this.PREFS.initialsGivenNames, true);
    setIfUnset(this.PREFS.titleFallback, true);
    setIfUnset(this.PREFS.tagPolicy, "latest");
    setIfUnset(this.PREFS.concurrency, 4);

    // One-time migration: earlier versions defaulted Update mode to "fill",
    // which left pre-existing (sometimes wrong) field values like author names
    // untouched. The intended behaviour is to refresh from the sources, so flip
    // legacy "fill" installs to "overwrite" once. Still user-editable afterward.
    const migratedKey = "extensions.metadata-mender.overwriteDefaultMigrated";
    if (Zotero.Prefs.get(migratedKey, true) === undefined) {
      if (Zotero.Prefs.get(this.PREFS.overwriteMode, true) === "fill") {
        Zotero.Prefs.set(this.PREFS.overwriteMode, "overwrite", true);
      }
      Zotero.Prefs.set(migratedKey, true, true);
    }
  },

  getPref(key) {
    return Zotero.Prefs.get(key, true);
  },

  // =========================================================================
  // Rate limiting — per source. Token-spacing scheduler with adaptive RPS.
  // =========================================================================
  RateLimiter: {
    _queues: {},

    _rps(source) {
      const M = Zotero.MetadataMender;
      switch (source) {
        case "openalex":
          return 10;
        case "pubmed":
          return M.getPref(M.PREFS.ncbiKey) ? 10 : 3;
        case "crossref":
          return M.getPref(M.PREFS.crossrefPlusToken) ? 50 : 20;
        case "semanticscholar":
          return M.getPref(M.PREFS.semanticScholarKey) ? 5 : 1;
        case "openaire":
          // OpenAIRE doesn't publish a public per-second cap; stay courteous.
          return 10;
        case "core":
          // CORE: ~10 tokens/minute unauthenticated (effectively unusable);
          // 10 tokens/minute on the free tier with a key. Stay well under.
          return M.getPref(M.PREFS.coreKey) ? 5 : 1;
        case "unpaywall":
          // Generous limits; stay polite.
          return 10;
        case "cran":
          // METACRAN (crandb.r-pkg.org) is community-hosted; stay conservative.
          return 5;
        default:
          return 2;
      }
    },

    reset() {
      this._queues = {};
    },

    async schedule(source, fn) {
      const minInterval = 1000 / this._rps(source);
      if (!this._queues[source]) {
        this._queues[source] = { last: 0, chain: Promise.resolve() };
      }
      const q = this._queues[source];
      const run = q.chain.then(async () => {
        const now = Date.now();
        const wait = Math.max(0, q.last + minInterval - now);
        if (wait > 0) await Zotero.Promise.delay(wait);
        q.last = Date.now();
        return fn();
      });
      q.chain = run.catch(() => {});
      return run;
    },
  },

  // =========================================================================
  // HTTP helper — 2xx → body, 404 → null, 429/5xx → retry honouring Retry-After.
  // =========================================================================
  async _get(url, headers = {}, attempt = 1) {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: Object.assign({ "User-Agent": this._userAgent() }, headers),
      responseType: "json",
      timeout: 30000,
      errorOnStatus: false,
    });
    const status = xhr.status;
    if (status >= 200 && status < 300) return xhr.response;
    if (status === 404) return null;
    if ((status === 429 || (status >= 500 && status < 600)) && attempt < 3) {
      const ra = xhr.getResponseHeader ? xhr.getResponseHeader("Retry-After") : null;
      const wait = this._parseRetryAfter(ra) ?? Math.pow(2, attempt) * 1000;
      await Zotero.Promise.delay(wait);
      return this._get(url, headers, attempt + 1);
    }
    throw new Error(`HTTP ${status} ${url}`);
  },

  _parseRetryAfter(value) {
    if (!value) return null;
    const n = parseFloat(value);
    if (!isNaN(n)) return Math.max(0, n * 1000);
    const t = Date.parse(value);
    if (!isNaN(t)) return Math.max(0, t - Date.now());
    return null;
  },

  _userAgent() {
    const mailto = this.getPref(this.PREFS.crossrefMailto);
    const tail = mailto ? `; mailto:${mailto})` : ")";
    return `MetadataMender/${this.version || "0.1.0"} (https://github.com/r-heller/metadata-mender${tail}`;
  },

  _today() {
    return new Date().toISOString().slice(0, 10);
  },

  // Replace (or append) a `Key: value` line in an Extra blob. Case-insensitive
  // on the key. Drops duplicate keys.
  _upsertExtraLine(extra, key, value) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^\\s*" + escaped + "\\s*:", "i");
    const lines = (extra || "").split("\n");
    const out = [];
    let replaced = false;
    for (const l of lines) {
      if (re.test(l)) {
        if (!replaced) {
          out.push(`${key}: ${value}`);
          replaced = true;
        }
      } else {
        out.push(l);
      }
    }
    if (!replaced) out.push(`${key}: ${value}`);
    while (out.length && out[0] === "") out.shift();
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  },

  _appendExtraLineIfMissing(extra, key, value) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^\\s*" + escaped + "\\s*:", "im");
    if (re.test(extra || "")) return extra;
    const prefix = (extra && extra.length) ? extra + "\n" : "";
    return prefix + `${key}: ${value}`;
  },

  // Drop a `Key: value` line from an Extra blob (case-insensitive on the key).
  // Used to de-duplicate once a value has been promoted to a native field.
  _removeExtraLine(extra, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^\\s*" + escaped + "\\s*:", "i");
    const lines = (extra || "").split("\n").filter((l) => !re.test(l));
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  },

  // Map common ISO 639-2 codes (as PubMed returns) to the ISO 639-1 codes
  // Zotero/CSL prefer. Anything unrecognised passes through unchanged.
  _normalizeLang(v) {
    if (!v) return v;
    const s = String(v).trim().toLowerCase();
    const map = {
      eng: "en", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es",
      ita: "it", por: "pt", dut: "nl", nld: "nl", rus: "ru", chi: "zh",
      zho: "zh", jpn: "ja", kor: "ko", ara: "ar", pol: "pl", swe: "sv",
    };
    return map[s] || v;
  },

  // Jaccard similarity on lowercased word tokens (≥3 chars). Used by the
  // title-fallback DOI search.
  _titleSimilar(a, b) {
    const tokenize = (s) =>
      new Set(
        String(s || "")
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 2)
      );
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = new Set([...ta, ...tb]).size;
    return union ? inter / union : 0;
  },

  // OpenAlex venue lookup for the 2-year mean citedness. Cached per session.
  async _getOpenAlexSource(sid) {
    if (!sid) return null;
    if (Object.prototype.hasOwnProperty.call(this._sourceCache, sid)) {
      return this._sourceCache[sid];
    }
    const key = this.getPref(this.PREFS.openalexKey);
    let url = `https://api.openalex.org/sources/${encodeURIComponent(sid)}`;
    if (key) url += "?api_key=" + encodeURIComponent(key);
    try {
      const data = await this.RateLimiter.schedule("openalex", () => this._get(url));
      this._sourceCache[sid] = data || null;
    } catch (e) {
      Zotero.debug("Metadata Mender: openalex venue lookup failed: " + e);
      this._sourceCache[sid] = null;
    }
    return this._sourceCache[sid];
  },

  // =========================================================================
  // Identifier extraction
  // =========================================================================
  _getDOI(item) {
    let doi;
    try { doi = item.getField("DOI"); } catch (e) { doi = ""; }
    if (doi) return this._normalizeDOI(doi);
    const extra = item.getField("extra") || "";
    const m = extra.match(/^DOI:\s*(\S+)/im);
    if (m) return this._normalizeDOI(m[1]);
    return null;
  },

  _normalizeDOI(doi) {
    return doi
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "");
  },

  _getPMID(item) {
    try {
      const v = item.getField("PMID");
      if (v) return String(v).trim();
    } catch (e) { /* no native PMID field — read from Extra below */ }
    const extra = item.getField("extra") || "";
    const m = extra.match(/^PMID:\s*(\d+)/im);
    return m ? m[1] : null;
  },

  // R package on CRAN — triggered explicitly via a CRAN URL in the URL field
  // or a `CRAN: <name>` line in Extra.  Names can contain dots (e.g. data.table).
  _getCRAN(item) {
    try {
      const url = item.getField("url") || "";
      const m = url.match(/cran\.r-project\.org\/(?:package=|web\/packages\/)([\w.]+)/i);
      if (m) return m[1];
    } catch (e) { /* item type lacks URL field — fine */ }
    const extra = item.getField("extra") || "";
    const m = extra.match(/^CRAN:\s*([\w.]+)/im);
    return m ? m[1] : null;
  },

  // =========================================================================
  // Source clients
  // =========================================================================

  async fetchOpenAlex({ doi, pmid }) {
    const key = this.getPref(this.PREFS.openalexKey);
    let url;
    if (doi) {
      url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
    } else if (pmid) {
      url = `https://api.openalex.org/works/pmid:${encodeURIComponent(pmid)}`;
    } else {
      return null;
    }
    if (key) url += (url.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(key);

    const data = await this.RateLimiter.schedule("openalex", () => this._get(url));
    if (!data || data.error) return null;

    const rec = {
      title: data.title || data.display_name,
      DOI: data.doi ? this._normalizeDOI(data.doi) : undefined,
      date: data.publication_date,
      url: data.primary_location && data.primary_location.landing_page_url,
    };
    const host = data.primary_location && data.primary_location.source;
    if (host) {
      rec.journal = host.display_name;
      if (host.issn_l) rec.ISSN = host.issn_l;
      if (host.id) rec._sourceId = host.id.split("/").pop();
    }
    if (data.language) rec.language = this._normalizeLang(data.language);
    if (typeof data.cited_by_count === "number") rec.citedByCount = data.cited_by_count;
    if (data.ids) {
      if (data.ids.pmcid) {
        const m = String(data.ids.pmcid).match(/PMC\d+/);
        if (m) rec.PMCID = m[0];
      }
      if (data.ids.openalex) rec.openalexID = String(data.ids.openalex).split("/").pop();
    } else if (data.id) {
      rec.openalexID = String(data.id).split("/").pop();
    }
    const oaLoc = data.best_oa_location;
    if (oaLoc && oaLoc.pdf_url) rec.oaPdfUrl = oaLoc.pdf_url;
    else if (oaLoc && oaLoc.landing_page_url) rec.oaPdfUrl = oaLoc.landing_page_url;
    const bib = data.biblio || {};
    if (bib.volume) rec.volume = bib.volume;
    if (bib.issue) rec.issue = bib.issue;
    if (bib.first_page) {
      rec.pages = bib.last_page ? `${bib.first_page}-${bib.last_page}` : bib.first_page;
    }
    if (Array.isArray(data.authorships) && data.authorships.length) {
      rec.creators = data.authorships.map((a) => {
        const name = (a.author && a.author.display_name) || "";
        return this._splitName(name);
      });
    }
    if (data.abstract_inverted_index) {
      rec.abstractNote = this._reconstructAbstract(data.abstract_inverted_index);
    }
    return rec;
  },

  async fetchCrossref({ doi }) {
    if (!doi) return null;
    let url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const mailto = this.getPref(this.PREFS.crossrefMailto);
    if (mailto) url += "?mailto=" + encodeURIComponent(mailto);

    const headers = {};
    const plus = this.getPref(this.PREFS.crossrefPlusToken);
    if (plus) headers["Crossref-Plus-API-Token"] = "Bearer " + plus;

    const data = await this.RateLimiter.schedule("crossref", () => this._get(url, headers));
    if (!data || data.status !== "ok" || !data.message) return null;
    const m = data.message;

    const rec = {
      DOI: m.DOI ? this._normalizeDOI(m.DOI) : undefined,
      title: Array.isArray(m.title) && m.title.length ? m.title[0] : undefined,
      journal:
        Array.isArray(m["container-title"]) && m["container-title"].length
          ? m["container-title"][0]
          : undefined,
      volume: m.volume,
      issue: m.issue,
      pages: m.page,
      publisher: m.publisher,
      url: m.URL,
    };
    if (Array.isArray(m.ISSN) && m.ISSN.length) rec.ISSN = m.ISSN[0];
    if (Array.isArray(m["short-container-title"]) && m["short-container-title"].length) {
      rec.journalAbbreviation = m["short-container-title"][0];
    }
    if (m.language) rec.language = this._normalizeLang(m.language);
    const dateParts =
      (m.published && m.published["date-parts"]) ||
      (m["published-print"] && m["published-print"]["date-parts"]) ||
      (m["published-online"] && m["published-online"]["date-parts"]);
    if (dateParts && dateParts[0]) {
      rec.date = dateParts[0]
        .map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0")))
        .join("-");
    }
    if (Array.isArray(m.author) && m.author.length) {
      rec.creators = m.author.map((a) => ({
        firstName: a.given || "",
        lastName: a.family || a.name || "",
        creatorType: "author",
      }));
    }
    if (m.abstract) rec.abstractNote = m.abstract.replace(/<[^>]+>/g, "").trim();
    if (typeof m["is-referenced-by-count"] === "number") {
      rec.citedByCount = m["is-referenced-by-count"];
    }
    return rec;
  },

  async fetchPubMed({ pmid, doi }) {
    let id = pmid;
    const key = this.getPref(this.PREFS.ncbiKey);
    const keyParam = key ? "&api_key=" + encodeURIComponent(key) : "";

    if (!id && doi) {
      const searchUrl =
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json" +
        "&term=" + encodeURIComponent(doi) + "[DOI]" + keyParam;
      const s = await this.RateLimiter.schedule("pubmed", () => this._get(searchUrl));
      const list = s && s.esearchresult && s.esearchresult.idlist;
      if (list && list.length) id = list[0];
    }
    if (!id) return null;

    const summaryUrl =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json" +
      "&id=" + encodeURIComponent(id) + keyParam;
    const data = await this.RateLimiter.schedule("pubmed", () => this._get(summaryUrl));
    const doc = data && data.result && data.result[id];
    if (!doc || doc.error) return null;

    const rec = {
      title: doc.title,
      journal: doc.fulljournalname || doc.source,
      volume: doc.volume,
      issue: doc.issue,
      pages: doc.pages,
      date: doc.sortpubdate ? doc.sortpubdate.split(" ")[0].replace(/\//g, "-") : doc.pubdate,
      PMID: id,
    };
    if (Array.isArray(doc.articleids)) {
      const d = doc.articleids.find((x) => x.idtype === "doi");
      if (d) rec.DOI = this._normalizeDOI(d.value);
      const pmc = doc.articleids.find((x) => x.idtype === "pmc" || x.idtype === "pmcid");
      if (pmc) {
        const m = String(pmc.value).match(/PMC\d+/);
        if (m) rec.PMCID = m[0];
      }
    }
    if (doc.issn) rec.ISSN = doc.issn;
    // doc.source is the NLM title abbreviation (e.g. "Cell Transplant").
    if (doc.source) rec.journalAbbreviation = doc.source;
    if (Array.isArray(doc.lang) && doc.lang.length) {
      rec.language = this._normalizeLang(doc.lang[0]);
    }
    if (Array.isArray(doc.authors) && doc.authors.length) {
      rec.creators = doc.authors
        .filter((a) => a.authtype === "Author")
        .map((a) => this._splitName(a.name, true));
    }
    return rec;
  },

  async fetchSemanticScholar({ doi, pmid }) {
    let id;
    if (doi) id = "DOI:" + doi;
    else if (pmid) id = "PMID:" + pmid;
    else return null;

    const fields = [
      "externalIds", "title", "abstract", "year", "publicationDate",
      "journal", "venue", "authors", "citationCount",
    ].join(",");
    const url =
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}` +
      `?fields=${fields}`;

    const headers = {};
    const key = this.getPref(this.PREFS.semanticScholarKey);
    if (key) headers["x-api-key"] = key;

    const data = await this.RateLimiter.schedule("semanticscholar", () =>
      this._get(url, headers)
    );
    if (!data || data.error || !data.paperId) return null;

    const rec = {
      title: data.title,
      date: data.publicationDate || (data.year ? String(data.year) : undefined),
      abstractNote: data.abstract || undefined,
    };
    if (data.externalIds) {
      if (data.externalIds.DOI) rec.DOI = this._normalizeDOI(data.externalIds.DOI);
      if (data.externalIds.PubMed) rec.PMID = String(data.externalIds.PubMed);
      if (data.externalIds.PubMedCentral) {
        const m = String(data.externalIds.PubMedCentral).match(/PMC\d+/);
        if (m) rec.PMCID = m[0];
      }
      if (data.externalIds.ArXiv) rec.arXivID = String(data.externalIds.ArXiv);
    }
    if (data.journal && data.journal.name) {
      rec.journal = data.journal.name;
      if (data.journal.volume) rec.volume = data.journal.volume;
      if (data.journal.pages) rec.pages = data.journal.pages;
    } else if (data.venue) {
      rec.journal = data.venue;
    }
    if (Array.isArray(data.authors) && data.authors.length) {
      rec.creators = data.authors.map((a) => this._splitName(a.name || ""));
    }
    if (typeof data.citationCount === "number") rec.citedByCount = data.citationCount;
    return rec;
  },

  // OpenAIRE Graph API — broad European/funded research coverage including
  // theses, working papers, reports, and other grey literature that Crossref
  // doesn't index.  No key required.  Endpoint and parameter name follow the
  // v1 Graph API (graph.openaire.eu/docs/apis/graph-api/).
  async fetchOpenAIRE({ doi }) {
    if (!doi) return null;
    const url =
      `https://api.openaire.eu/graph/v1/researchProducts` +
      `?pid=${encodeURIComponent(doi)}&pageSize=1`;
    const data = await this.RateLimiter.schedule("openaire", () => this._get(url));
    const results = data && data.results;
    if (!Array.isArray(results) || !results.length) return null;
    const r = results[0];

    const rec = {};
    const pickStr = (v) => (Array.isArray(v) ? v[0] : v);
    if (r.title) rec.title = pickStr(r.title);
    if (r.publicationDate) rec.date = r.publicationDate;
    if (r.publisher) rec.publisher = r.publisher;
    if (r.description) rec.abstractNote = pickStr(r.description);

    const c = r.container;
    if (c) {
      if (c.name) rec.journal = c.name;
      if (c.vol) rec.volume = c.vol;
      if (c.iss) rec.issue = c.iss;
      if (c.sp && c.ep) rec.pages = `${c.sp}-${c.ep}`;
      else if (c.sp) rec.pages = c.sp;
      const issn = c.issnPrinted || c.issnOnline || c.issnLinking;
      if (issn) rec.ISSN = issn;
    }

    if (Array.isArray(r.authors)) {
      rec.creators = r.authors.map((a) => {
        const name = a.fullName || a.name || "";
        // OpenAIRE often gives names in "Last, First" form — handle explicitly.
        if (name.includes(",")) {
          const [last, first] = name.split(",").map((s) => s.trim());
          return { firstName: first || "", lastName: last, creatorType: "author" };
        }
        return this._splitName(name);
      });
    }

    if (Array.isArray(r.pids)) {
      const doiPid = r.pids.find((p) => p.scheme === "doi");
      if (doiPid && doiPid.value) rec.DOI = this._normalizeDOI(doiPid.value);
      const pmidPid = r.pids.find((p) => p.scheme === "pmid");
      if (pmidPid && pmidPid.value) rec.PMID = String(pmidPid.value);
      const pmcPid = r.pids.find((p) => p.scheme === "pmc" || p.scheme === "pmcid");
      if (pmcPid && pmcPid.value) {
        const m = String(pmcPid.value).match(/PMC\d+/);
        if (m) rec.PMCID = m[0];
      }
    }

    // OpenAIRE's "instances" each correspond to a repository copy. Take the
    // first open-access one as our OA PDF candidate.
    if (Array.isArray(r.instances)) {
      const open = r.instances.find(
        (i) => i.accessRight === "OPEN" || i.accessRight === "OPEN ACCESS"
      );
      if (open) {
        const url2 = Array.isArray(open.urls) ? open.urls[0] : open.url;
        if (url2) rec.oaPdfUrl = url2;
      }
    }
    return rec;
  },

  // CORE — large open-access aggregator. Only useful with an API key (free at
  // core.ac.uk/services/api).  Without a key we short-circuit so we don't
  // burn the tiny shared anonymous budget.
  async fetchCORE({ doi }) {
    const key = this.getPref(this.PREFS.coreKey);
    if (!key || !doi) return null;
    const q = encodeURIComponent(`doi:"${doi}"`);
    const url = `https://api.core.ac.uk/v3/search/works?q=${q}&limit=1`;
    const data = await this.RateLimiter.schedule("core", () =>
      this._get(url, { Authorization: "Bearer " + key })
    );
    if (!data || !Array.isArray(data.results) || !data.results.length) return null;
    const r = data.results[0];

    const rec = {};
    if (r.title) rec.title = r.title;
    if (r.abstract) rec.abstractNote = r.abstract;
    if (r.publishedDate || r.datePublished) {
      rec.date = String(r.publishedDate || r.datePublished).split("T")[0];
    } else if (r.yearPublished) {
      rec.date = String(r.yearPublished);
    }
    if (r.publisher) rec.publisher = r.publisher;
    if (r.doi) rec.DOI = this._normalizeDOI(r.doi);
    if (r.downloadUrl) rec.coreFullTextUrl = r.downloadUrl;
    if (Array.isArray(r.authors)) {
      rec.creators = r.authors.map((a) => {
        const name = typeof a === "string" ? a : (a.name || "");
        return this._splitName(name);
      });
    }
    if (Array.isArray(r.journals) && r.journals.length) {
      const j = r.journals[0];
      if (j.title) rec.journal = j.title;
      if (Array.isArray(j.identifiers)) {
        const issn = j.identifiers.find((id) => /^issn:/i.test(id));
        if (issn) rec.ISSN = issn.replace(/^issn:/i, "");
      }
    }
    return rec;
  },

  // Unpaywall — gold standard for OA-PDF discovery. Requires a contact email
  // (we reuse the Crossref mailto pref). Without one, we don't call it.
  async fetchUnpaywall({ doi }) {
    if (!doi) return null;
    const email = this.getPref(this.PREFS.crossrefMailto);
    if (!email) return null;
    const url =
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}` +
      `?email=${encodeURIComponent(email)}`;
    const data = await this.RateLimiter.schedule("unpaywall", () => this._get(url));
    if (!data || data.error) return null;

    const rec = {};
    if (data.title) rec.title = data.title;
    if (data.year) rec.date = String(data.year);
    if (data.journal_name) rec.journal = data.journal_name;
    if (data.journal_issn_l) rec.ISSN = data.journal_issn_l;
    if (data.publisher) rec.publisher = data.publisher;
    if (Array.isArray(data.z_authors)) {
      rec.creators = data.z_authors.map((a) => ({
        firstName: a.given || "",
        lastName: a.family || "",
        creatorType: "author",
      }));
    }
    const oa = data.best_oa_location;
    if (oa && oa.url_for_pdf) rec.oaPdfUrl = oa.url_for_pdf;
    else if (oa && oa.url) rec.oaPdfUrl = oa.url;
    return rec;
  },

  // CRAN via METACRAN (crandb.r-pkg.org) — returns the package's DESCRIPTION
  // as JSON. Only triggered when the item has a CRAN identifier.
  async fetchCRAN({ cran }) {
    if (!cran) return null;
    const url = `https://crandb.r-pkg.org/${encodeURIComponent(cran)}`;
    const data = await this.RateLimiter.schedule("cran", () => this._get(url));
    if (!data || !data.Package) return null;

    const rec = {
      title: data.Package,
      publisher: "Comprehensive R Archive Network (CRAN)",
      url: `https://cran.r-project.org/package=${data.Package}`,
      programmingLanguage: "R",
    };
    // CRAN's DESCRIPTION has a short Title (one-liner) and a longer Description.
    // Prefer the longer one as abstract, fall back to Title.
    if (data.Description) rec.abstractNote = String(data.Description).replace(/\s+/g, " ").trim();
    else if (data.Title) rec.abstractNote = String(data.Title).replace(/\s+/g, " ").trim();

    if (data.Version) rec.versionNumber = String(data.Version);

    const pubDate = data["Date/Publication"] || data.date || data.Date;
    if (pubDate) rec.date = String(pubDate).split(/[\sT]/)[0];

    if (data.Author) rec.creators = this._parseRDescriptionAuthors(data.Author);

    // CRAN-specific augmentations consumed by _augmentExtra.
    if (data.License) rec.cranLicense = String(data.License).trim();
    if (data.URL) {
      // DESCRIPTION's URL field can list multiple URLs separated by comma.
      const upstream = String(data.URL).split(/[,\s]+/).filter(Boolean)[0];
      if (upstream) rec.cranUpstreamUrl = upstream;
    }
    return rec;
  },

  // Parse the freeform Author field of an R DESCRIPTION file. Example:
  //   "Hadley Wickham [aut, cre] (<https://orcid.org/...>), Winston Chang [aut]"
  // Splits on top-level commas (depth-aware so commas inside [...] or (...)
  // don't split), strips role tags and ORCID parentheticals, and runs each
  // residual name through _splitName.
  _parseRDescriptionAuthors(str) {
    if (!str || typeof str !== "string") return [];
    const chunks = [];
    let depth = 0;
    let buf = "";
    for (const ch of str) {
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        if (buf.trim()) chunks.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) chunks.push(buf.trim());

    const creators = [];
    for (const entry of chunks) {
      const name = entry
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\([^)]*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!name) continue;
      creators.push(this._splitName(name));
    }
    return creators;
  },

  // Bibliographic search on Crossref to resolve a DOI from title (+ first
  // author lastname). Conservative: requires Jaccard ≥ 0.7 on tokenised titles.
  async _tryTitleFallback(item) {
    let title;
    try { title = item.getField("title"); } catch (e) { return null; }
    if (!title || title.length < 12) return null;

    let url =
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=3`;
    try {
      const creators = item.getCreators() || [];
      if (creators.length) {
        const first = creators[0];
        const lastName = first.lastName || first.firstName;
        if (lastName) url += `&query.author=${encodeURIComponent(lastName)}`;
      }
    } catch (e) { /* no creators — fine */ }
    const mailto = this.getPref(this.PREFS.crossrefMailto);
    if (mailto) url += `&mailto=${encodeURIComponent(mailto)}`;

    const data = await this.RateLimiter.schedule("crossref", () => this._get(url));
    const items = data && data.message && data.message.items;
    if (!Array.isArray(items)) return null;

    for (const cand of items) {
      const candTitle = Array.isArray(cand.title) && cand.title[0];
      if (!candTitle) continue;
      if (this._titleSimilar(title, candTitle) >= 0.7 && cand.DOI) {
        return this._normalizeDOI(cand.DOI);
      }
    }
    return null;
  },

  // ---- name helpers ----

  // Abbreviate a given/first name to PubMed-style initials.
  //   "Raban Arved" -> "RA",  "Helena Lucia" -> "HL",  "Maximilian" -> "M",
  //   "Jean-Pierre" -> "JP". Already-abbreviated clusters ("RA", "J") pass
  //   through unchanged so the transform is idempotent.
  _toInitials(firstName) {
    if (!firstName) return "";
    const parts = String(firstName).trim().split(/[\s\-]+/).filter(Boolean);
    const out = parts.map((p) => {
      const letters = p.replace(/\./g, "");
      if (!letters) return "";
      // An all-caps run like "RA" is already initials — keep every letter.
      if (letters === letters.toUpperCase() && /^[^\d]{1,4}$/.test(letters)) {
        return letters;
      }
      return Array.from(letters)[0].toUpperCase();
    });
    return out.join("");
  },

  // Reformat the item's author/creator given names to initials (pref-gated).
  // Runs regardless of source or update mode so the result is consistent.
  _normalizeCreatorInitials(ctx) {
    const { item, changes } = ctx;
    if (!this.getPref(this.PREFS.initialsGivenNames)) return;
    const existing = item.getCreators();
    if (!existing.length) return;
    let changed = false;
    const next = existing.map((c) => {
      // Single-field (institutional) names have fieldMode 1 — leave them be.
      if (c.fieldMode === 1 || !c.firstName) return c;
      const ini = this._toInitials(c.firstName);
      if (ini && ini !== c.firstName) changed = true;
      return Object.assign({}, c, { firstName: ini || c.firstName });
    });
    if (changed) {
      item.setCreators(next);
      changes.push({ field: "creators", to: "initials" });
    }
  },

  _splitName(full, lastFirst = false) {
    if (!full) return { firstName: "", lastName: "", creatorType: "author" };
    if (lastFirst) {
      const parts = full.trim().split(/\s+/);
      const last = parts.shift() || "";
      return { firstName: parts.join(" "), lastName: last, creatorType: "author" };
    }
    const parts = full.trim().split(/\s+/);
    const last = parts.pop() || "";
    return { firstName: parts.join(" "), lastName: last, creatorType: "author" };
  },

  _reconstructAbstract(inverted) {
    const positions = [];
    for (const [word, idxs] of Object.entries(inverted)) {
      for (const i of idxs) positions[i] = word;
    }
    return positions.join(" ").replace(/\s+/g, " ").trim();
  },

  // =========================================================================
  // Reconciliation
  // =========================================================================
  _mergeFields: [
    "title", "date", "DOI", "journal", "volume", "issue",
    "pages", "ISSN", "abstractNote", "url", "publisher",
    "journalAbbreviation", "language",
    // Software-relevant fields — silently no-op on item types that lack them
    // (the try/catch around setField handles that).
    "versionNumber", "programmingLanguage",
  ],

  _zoteroFieldName(item, key) {
    if (key === "journal") return "publicationTitle";
    return key;
  },

  _getSourcePriority() {
    return (this.getPref(this.PREFS.sourcePriority) || "crossref,pubmed,semanticscholar,openalex")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },

  async _fetchAllSources(ids, priority) {
    const { doi, pmid, cran } = ids;
    const records = {};
    const errors = {};
    for (const src of priority) {
      try {
        let rec = null;
        if (src === "openalex") rec = await this.fetchOpenAlex({ doi, pmid });
        else if (src === "crossref") rec = await this.fetchCrossref({ doi });
        else if (src === "pubmed") rec = await this.fetchPubMed({ pmid, doi });
        else if (src === "semanticscholar") rec = await this.fetchSemanticScholar({ doi, pmid });
        else if (src === "openaire") rec = await this.fetchOpenAIRE({ doi });
        else if (src === "core") rec = await this.fetchCORE({ doi });
        else if (src === "unpaywall") rec = await this.fetchUnpaywall({ doi });
        else if (src === "cran") rec = await this.fetchCRAN({ cran });
        if (rec) records[src] = rec;
      } catch (e) {
        errors[src] = String((e && e.message) || e);
        Zotero.debug("Metadata Mender: " + src + " error: " + e);
      }
    }
    return { records, errors };
  },

  async _enrichWithVenue(records) {
    const oaRec = records.openalex;
    if (oaRec && oaRec._sourceId) {
      const venue = await this._getOpenAlexSource(oaRec._sourceId);
      const stats = venue && venue.summary_stats;
      const mc = stats && stats["2yr_mean_citedness"];
      if (typeof mc === "number") oaRec.impactFactor2yr = mc;
    }
  },

  _mergeStandardFields(ctx) {
    const { item, records, priority, mode, changes, provenance, extraInjects } = ctx;
    for (const key of this._mergeFields) {
      let chosen, chosenSrc;
      for (const src of priority) {
        const r = records[src];
        if (r && r[key] !== undefined && r[key] !== null && r[key] !== "") {
          chosen = r[key];
          chosenSrc = src;
          break;
        }
      }
      if (chosen === undefined) continue;

      const fieldName = this._zoteroFieldName(item, key);
      let current;
      try {
        current = item.getField(fieldName);
      } catch (e) {
        // Field not applicable to this item type. For a few keys, fall back
        // to writing the value into Extra so it isn't lost.
        if (key === "DOI") {
          extraInjects.push({ key: "DOI", value: chosen, source: chosenSrc });
        } else if (key === "versionNumber") {
          extraInjects.push({ key: "Version", value: chosen, source: chosenSrc });
        }
        continue;
      }
      if (mode === "fill" && current) continue;
      if (current === String(chosen)) continue;

      try {
        item.setField(fieldName, chosen);
        changes.push({ field: fieldName, from: current, to: chosen, source: chosenSrc });
        provenance[fieldName] = chosenSrc;
      } catch (e) {
        if (key === "DOI") {
          extraInjects.push({ key: "DOI", value: chosen, source: chosenSrc });
        } else if (key === "versionNumber") {
          extraInjects.push({ key: "Version", value: chosen, source: chosenSrc });
        }
      }
    }
  },

  _mergeCreators(ctx) {
    const { item, records, priority, mode, changes, provenance } = ctx;
    let creators, creatorSrc;
    for (const src of priority) {
      const r = records[src];
      if (r && Array.isArray(r.creators) && r.creators.length) {
        creators = r.creators;
        creatorSrc = src;
        break;
      }
    }
    if (!creators) return;
    const existing = item.getCreators();
    if (mode !== "overwrite" && existing.length) return;

    item.setCreators(
      creators.map((c) => ({
        firstName: c.firstName,
        lastName: c.lastName,
        creatorTypeID: Zotero.CreatorTypes.getID(c.creatorType || "author"),
      }))
    );
    changes.push({ field: "creators", count: creators.length, source: creatorSrc });
    provenance.creators = creatorSrc;
  },

  _augmentExtra(ctx) {
    const { item, records, priority, today, changes, provenance, extraInjects, pmid, cran } = ctx;
    const oaRec = records.openalex;
    let extra = item.getField("extra") || "";
    const origExtra = extra;

    // Deferred standard-field injects (e.g. DOI for item types lacking that field).
    for (const inj of extraInjects) {
      const next = this._appendExtraLineIfMissing(extra, inj.key, inj.value);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: `${inj.key}: ${inj.value}`, source: inj.source });
        provenance[inj.key] = inj.source;
      }
    }

    // Identifiers (PMID, PMCID, arXiv, OpenAlex). Prefer a native item field
    // where the item type provides one; otherwise keep the value in Extra.
    // When the native field holds the value we drop any duplicate Extra line.
    const pick = (key) => {
      for (const s of priority) {
        const r = records[s];
        if (r && r[key]) return { value: r[key], src: s };
      }
      return { value: undefined, src: undefined };
    };
    const pmidPick = pick("PMID");
    const identifiers = [
      { value: pmidPick.value || pmid, src: pmidPick.src, field: "PMID", extraKey: "PMID" },
      { ...pick("PMCID"), field: "PMCID", extraKey: "PMCID" },
      { ...pick("arXivID"), field: "arXiv", extraKey: "arXiv" },
      { ...pick("openalexID"), field: null, extraKey: "OpenAlex" },
    ];
    for (const id of identifiers) {
      if (!id.value) continue;
      // Probe whether the field exists for this item type. getField throws on an
      // unknown field, so a clean read means a native field is available.
      let isNative = false, current = "";
      if (id.field) {
        try { current = item.getField(id.field); isNative = true; } catch (e) { isNative = false; }
      }
      if (isNative) {
        if (String(current) !== String(id.value)) {
          item.setField(id.field, id.value);
          changes.push({ field: id.field, from: current, to: id.value, source: id.src });
          if (id.src) provenance[id.field] = id.src;
        }
        const deduped = this._removeExtraLine(extra, id.extraKey);
        if (deduped !== extra) {
          extra = deduped;
          changes.push({ field: "extra", to: `moved ${id.extraKey} to native field` });
        }
      } else {
        const next = this._upsertExtraLine(extra, id.extraKey, id.value);
        if (next !== extra) {
          extra = next;
          changes.push({ field: "extra", to: `${id.extraKey}: ${id.value}`, source: id.src });
        }
      }
    }

    // Citation count — prefer OpenAlex for time-series consistency.
    const citationSources = {
      openalex: "OpenAlex",
      crossref: "Crossref",
      semanticscholar: "Semantic Scholar",
    };
    let citationCount, citationSrc;
    if (oaRec && typeof oaRec.citedByCount === "number") {
      citationCount = oaRec.citedByCount;
      citationSrc = "openalex";
    } else {
      for (const src of priority) {
        const r = records[src];
        if (r && typeof r.citedByCount === "number" && citationSources[src]) {
          citationCount = r.citedByCount;
          citationSrc = src;
          break;
        }
      }
    }
    if (typeof citationCount === "number") {
      const line = `${citationCount} [${citationSources[citationSrc]}, ${today}]`;
      const next = this._upsertExtraLine(extra, "Citations", line);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "Citations: " + line, source: citationSrc });
        provenance.citations = citationSrc;
      }
    }

    // Impact-factor surrogate.
    if (oaRec && typeof oaRec.impactFactor2yr === "number") {
      const v = oaRec.impactFactor2yr.toFixed(2);
      const line = `${v} [OpenAlex 2yr mean citedness, ${today}]`;
      const next = this._upsertExtraLine(extra, "Impact Factor", line);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "Impact Factor: " + line, source: "openalex" });
        provenance.impactFactor = "openalex";
      }
    }

    // OA URL — cascade across OA-aware sources. OpenAlex first (broadest),
    // then Unpaywall (best for repository copies), then OpenAIRE, then CORE.
    const oaCandidates = [
      ["openalex", oaRec && oaRec.oaPdfUrl],
      ["unpaywall", records.unpaywall && records.unpaywall.oaPdfUrl],
      ["openaire", records.openaire && records.openaire.oaPdfUrl],
      ["core", records.core && records.core.coreFullTextUrl],
    ];
    let oaUrl, oaSrc;
    for (const [src, url] of oaCandidates) {
      if (url) { oaUrl = url; oaSrc = src; break; }
    }
    if (oaUrl) {
      const next = this._upsertExtraLine(extra, "OA-URL", oaUrl);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "OA-URL: " + oaUrl, source: oaSrc });
        provenance["OA-URL"] = oaSrc;
      }
    }

    // CRAN-specific augmentations — package id, license, upstream URL.
    const cranRec = records.cran;
    if (cran) {
      const next = this._appendExtraLineIfMissing(extra, "CRAN", cran);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "CRAN: " + cran });
      }
    }
    if (cranRec && cranRec.cranLicense) {
      const next = this._appendExtraLineIfMissing(extra, "License", cranRec.cranLicense);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "License: " + cranRec.cranLicense, source: "cran" });
        provenance.license = "cran";
      }
    }
    if (cranRec && cranRec.cranUpstreamUrl) {
      const next = this._appendExtraLineIfMissing(extra, "Upstream-URL", cranRec.cranUpstreamUrl);
      if (next !== extra) {
        extra = next;
        changes.push({ field: "extra", to: "Upstream-URL: " + cranRec.cranUpstreamUrl, source: "cran" });
      }
    }

    // Provenance line — fields actually changed this run, with sources.
    if (Object.keys(provenance).length) {
      const provLine =
        today + " — " +
        Object.entries(provenance).map(([k, v]) => `${k}:${v}`).join(", ");
      const next = this._upsertExtraLine(extra, "Provenance", provLine);
      if (next !== extra) extra = next;
    }

    if (extra !== origExtra) item.setField("extra", extra);
  },

  _applyTag(item, today) {
    const policy = this.getPref(this.PREFS.tagPolicy) || "latest";
    try {
      if (policy === "stable") {
        item.addTag("mended", 1);
        return;
      }
      if (policy === "latest") {
        const existing = item.getTags() || [];
        for (const t of existing) {
          if (t.tag === "mended" || /^mended:/.test(t.tag)) {
            item.removeTag(t.tag);
          }
        }
      }
      item.addTag(`mended:${today}`, 1);
    } catch (e) {
      Zotero.debug("Metadata Mender: tagging failed: " + e);
    }
  },

  async reconcileItem(item) {
    let doi = this._getDOI(item);
    const pmid = this._getPMID(item);
    const cran = this._getCRAN(item);
    let doiViaTitle = false;

    if (!doi && !pmid && !cran && this.getPref(this.PREFS.titleFallback)) {
      try {
        const found = await this._tryTitleFallback(item);
        if (found) {
          doi = found;
          doiViaTitle = true;
        }
      } catch (e) {
        Zotero.debug("Metadata Mender: title fallback failed: " + e);
      }
    }

    if (!doi && !pmid && !cran) {
      return { item, status: "skipped", reason: "no DOI, PMID, or CRAN id" };
    }

    const priority = this._getSourcePriority();
    const { records, errors } = await this._fetchAllSources({ doi, pmid, cran }, priority);

    if (!Object.keys(records).length) {
      if (Object.keys(errors).length) {
        return { item, status: "error", reason: "all sources errored", errors };
      }
      return { item, status: "notfound", reason: "no source had a record" };
    }

    await this._enrichWithVenue(records);

    const ctx = {
      item,
      records,
      priority,
      pmid,
      cran,
      mode: this.getPref(this.PREFS.overwriteMode) || "fill",
      today: this._today(),
      changes: [],
      provenance: {},
      extraInjects: [],
    };

    if (doiViaTitle) {
      ctx.provenance["DOI-via-title"] = "crossref-search";
    }

    this._mergeStandardFields(ctx);
    this._mergeCreators(ctx);
    this._normalizeCreatorInitials(ctx);
    this._augmentExtra(ctx);

    if (ctx.changes.length) {
      this._applyTag(item, ctx.today);
      await item.saveTx();
      return { item, status: "updated", changes: ctx.changes, sources: Object.keys(records) };
    }
    return { item, status: "unchanged", sources: Object.keys(records) };
  },

  async reconcileSelected(window) {
    const ZP = window.ZoteroPane;
    const items = ZP.getSelectedItems().filter((it) => it.isRegularItem());
    if (!items.length) {
      const msg = (await this._t(window, "mm-alert-no-selection")) || "No regular items selected.";
      Zotero.alert(window, "Metadata Mender", msg);
      return;
    }

    this._cancelRequested = false;
    const onKey = (e) => { if (e.key === "Escape") this._cancelRequested = true; };
    window.addEventListener("keydown", onKey, false);

    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Metadata Mender");
    const icon = "chrome://zotero/skin/toolbar-advanced-search.png";
    const line = new progress.ItemProgress(icon, "");
    progress.show();

    let updated = 0, skipped = 0, errored = 0, unchanged = 0, notfound = 0;
    let done = 0;
    const failures = [];

    const concurrency = Math.max(
      1,
      Math.min(12, parseInt(this.getPref(this.PREFS.concurrency), 10) || 4)
    );

    const tick = async () => {
      const total = items.length;
      const tmpl =
        (await this._t(window, "mm-progress-tick", { done, total })) ||
        `Reconciling ${done}/${total}… (Esc to cancel)`;
      line.setText(tmpl);
      line.setProgress(total ? Math.round((100 * done) / total) : 100);
    };
    await tick();

    // Worker pool — N workers race to pull the next item index. Per-source
    // rate limits are still enforced by RateLimiter, so this only speeds up
    // items that are bottlenecked on different sources or on idle scheduler time.
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        if (this._cancelRequested) return;
        const i = nextIdx++;
        if (i >= items.length) return;
        const item = items[i];
        try {
          const res = await this.reconcileItem(item);
          if (res.status === "updated") updated++;
          else if (res.status === "skipped") skipped++;
          else if (res.status === "notfound") notfound++;
          else if (res.status === "error") {
            errored++;
            failures.push({ item, errors: res.errors || {}, reason: res.reason });
          } else unchanged++;
        } catch (e) {
          errored++;
          failures.push({ item, errors: { unexpected: String(e) }, reason: "exception" });
          Zotero.debug("Metadata Mender: reconcile failed: " + e);
        }
        done++;
        await tick();
      }
    };
    const workerCount = Math.min(concurrency, items.length);
    const workers = [];
    for (let w = 0; w < workerCount; w++) workers.push(worker());

    try {
      await Promise.all(workers);
    } finally {
      window.removeEventListener("keydown", onKey, false);
    }

    const cancelled = this._cancelRequested;
    this._cancelRequested = false;

    const summaryId = cancelled ? "mm-progress-cancelled" : "mm-progress-done";
    const args = { updated, unchanged, skipped, notfound, errored };
    const summary =
      (await this._t(window, summaryId, args)) ||
      `${cancelled ? "Cancelled." : "Done."} ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${notfound} not found, ${errored} errored.`;
    line.setText(summary);
    line.setProgress(100);

    // Surface error details inline (up to 5 items); always log full details.
    if (failures.length) {
      const errIcon = "chrome://zotero/skin/cross.png";
      const show = failures.slice(0, 5);
      for (const f of show) {
        let title = "";
        try { title = f.item.getField("title") || ""; } catch (e) { /* ignore */ }
        const shortTitle = title.length > 60 ? title.slice(0, 60) + "…" : title;
        const reasons = Object.entries(f.errors)
          .map(([s, m]) => `${s}: ${m}`)
          .join(" · ");
        const errLine = new progress.ItemProgress(
          errIcon,
          `${shortTitle || "[untitled]"} — ${reasons || f.reason || "unknown"}`
        );
        errLine.setProgress(100);
      }
      if (failures.length > 5) {
        const moreLine = new progress.ItemProgress(
          errIcon,
          `…and ${failures.length - 5} more (see Help → Debug Output for full details)`
        );
        moreLine.setProgress(100);
      }
      for (const f of failures) {
        Zotero.debug(
          `Metadata Mender failure: itemID=${f.item.id} — ${JSON.stringify(f.errors)}`
        );
      }
    }

    progress.startCloseTimer(failures.length ? 15000 : 8000);
  },

  async _t(window, id, args) {
    try {
      const l10n = window && window.document && window.document.l10n;
      if (!l10n) return null;
      return await l10n.formatValue(id, args);
    } catch (e) {
      return null;
    }
  },

  // =========================================================================
  // UI — right-click context menu item in the items list.
  // =========================================================================
  addToWindow(window) {
    const doc = window.document;
    const menu = doc.getElementById("zotero-itemmenu");
    if (!menu) return;

    try {
      if (window.MozXULElement && window.MozXULElement.insertFTLIfNeeded) {
        window.MozXULElement.insertFTLIfNeeded("metadata-mender.ftl");
      }
    } catch (e) {
      Zotero.debug("Metadata Mender: insertFTLIfNeeded failed: " + e);
    }

    const sep = doc.createXULElement("menuseparator");
    sep.id = "mm-separator";
    menu.appendChild(sep);
    this._storeAddedElement(sep);

    const menuitem = doc.createXULElement("menuitem");
    menuitem.id = "mm-reconcile";
    menuitem.setAttribute("label", "Mend metadata (DOI/PMID lookup)");
    menuitem.setAttribute("data-l10n-id", "mm-menu-mend");
    menuitem.addEventListener("command", () => {
      this.reconcileSelected(window).catch((e) =>
        Zotero.debug("Metadata Mender: " + e)
      );
    });
    menu.appendChild(menuitem);
    this._storeAddedElement(menuitem);

    const onShowing = () => {
      try {
        const sel = window.ZoteroPane.getSelectedItems();
        const hasRegular = sel.some((it) => it.isRegularItem());
        menuitem.hidden = !hasRegular;
        sep.hidden = !hasRegular;
      } catch (e) {
        menuitem.hidden = false;
        sep.hidden = false;
      }
    };
    menu.addEventListener("popupshowing", onShowing);
    this._popupHandlers.push({ window, menu, onShowing });
  },

  removeFromWindow(window) {
    const doc = window.document;
    this._popupHandlers = this._popupHandlers.filter((h) => {
      if (h.window === window) {
        h.menu.removeEventListener("popupshowing", h.onShowing);
        return false;
      }
      return true;
    });
    for (const id of this.addedElementIDs) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
  },

  addToAllWindows() {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if (win.ZoteroPane) this.addToWindow(win);
    }
  },

  removeFromAllWindows() {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if (win.ZoteroPane) this.removeFromWindow(win);
    }
  },

  _storeAddedElement(el) {
    if (!el.id) throw new Error("Element must have an id");
    this.addedElementIDs.push(el.id);
  },
};
