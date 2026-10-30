const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../content/metadata-mender.js"), "utf8");
const prefix = "extensions.metadata-mender.";
const title = "A detailed synthetic study of library metadata preservation";
const clone = value => JSON.parse(JSON.stringify(value));

function setup(overrides = {}) {
  const preferences = { [prefix + "sourcePriority"]: "crossref", ...overrides };
  const logs = [], delays = [], requests = [];
  const valid = new Set(["title", "DOI", "date", "publicationTitle", "extra", "volume", "issue", "pages",
    "ISSN", "abstractNote", "url", "publisher", "journalAbbreviation", "language"]);
  const Zotero = {
    Prefs: { get: key => preferences[key], set: (key, value) => { preferences[key] = value; } },
    Promise: { delay: async ms => { delays.push(ms); } },
    debug: message => logs.push(message),
    Libraries: { get: () => ({ editable: true }) },
    CreatorTypes: { getID: () => 1 },
    ItemTypes: { getName: () => "journalArticle" },
    ItemFields: { getID: field => valid.has(field) ? field : false,
      getFieldIDFromTypeAndBase: (_, field) => field, isValidForType: field => valid.has(field) },
    HTTP: { request: async (...args) => { requests.push(args); return { status: 200, response: {} }; } },
  };
  const context = { Zotero };
  vm.createContext(context);
  vm.runInContext(source, context);
  const M = Zotero.MetadataMender;
  M._setDefaultPrefs();
  M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, journal: "Synthetic Journal",
    creators: [{ firstName: "Example", lastName: "Researcher", creatorType: "author" }] });
  return { M, Zotero, preferences, logs, delays, requests };
}

function item(options = {}) {
  let fields = { DOI: "10.1234/synthetic", title, date: "2020", extra: "Private review note", ...options.fields };
  let creators = options.creators || [{ firstName: "Example", lastName: "Researcher", creatorTypeID: 1 }];
  let tags = options.tags || [{ tag: "mended:manual-review", type: 0 }];
  let stored = clone({ fields, creators, tags });
  let changed = !!options.pending;
  return {
    id: 1, key: "SYNTH001", libraryID: 1, itemTypeID: 2, deleted: !!options.deleted,
    saves: 0, reloads: 0, writes: [],
    isRegularItem: () => true, hasChanged: () => changed,
    getField: field => fields[field] || "", getCreators: () => clone(creators), getTags: () => clone(tags),
    setField(field, value) {
      this.writes.push(field);
      if (["PMID", "PMCID", "arXiv"].includes(field)) throw new Error("Unsupported native identifier field");
      fields[field] = value; changed = true;
    },
    setCreators: value => { creators = clone(value); changed = true; },
    addTag: (tag, type) => { if (!tags.some(t => t.tag === tag)) tags.push({ tag, type }); changed = true; },
    removeTag: tag => { tags = tags.filter(t => t.tag !== tag); changed = true; },
    async saveTx() { this.saves++; if (options.failSave) throw new Error("Synthetic disk error");
      stored = clone({ fields, creators, tags }); changed = false; },
    async reload() { this.reloads++; ({ fields, creators, tags } = clone(stored)); changed = false; },
    externalEdit(field, value) { fields[field] = value; stored = clone({ fields, creators, tags }); },
  };
}

test("new defaults are conservative and existing fill/overwrite choices survive initialization", () => {
  const fresh = setup();
  assert.equal(fresh.preferences[prefix + "overwriteMode"], "fill");
  assert.equal(fresh.preferences[prefix + "initialsGivenNames"], false);
  assert.equal(fresh.preferences[prefix + "titleFallback"], false);
  for (const mode of ["fill", "overwrite"]) {
    const existing = setup({ [prefix + "overwriteMode"]: mode });
    assert.equal(existing.preferences[prefix + "overwriteMode"], mode);
  }
});

test("fill preserves reviewed fields, complete names, manual tags, and conflicting Extra identifiers", async () => {
  const { M } = setup({ [prefix + "initialsGivenNames"]: true });
  const reference = item({ fields: { extra: "Private note\nPMCID: PMC111" } });
  M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, PMCID: "PMC999", volume: "4",
    creators: [{ firstName: "E", lastName: "Researcher", creatorType: "author" }] });
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.equal(reference.getField("volume"), "4");
  assert.equal(reference.getCreators()[0].firstName, "Example");
  assert.match(reference.getField("extra"), /PMCID: PMC111/);
  assert.ok(reference.getTags().some(tag => tag.tag === "mended:manual-review"));
  assert.ok(!reference.writes.includes("PMCID"));
});

test("unsupported native identifiers are safely added to Extra", async () => {
  const { M } = setup();
  const reference = item();
  M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, PMID: "12345" });
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.match(reference.getField("extra"), /PMID: 12345/);
  assert.ok(!reference.writes.includes("PMID"));
});

test("PubMed responses validate returned UID and retain compound surnames", async () => {
  const { M } = setup({ [prefix + "sourcePriority"]: "pubmed" });
  M.RateLimiter.schedule = async (_, fn) => fn();
  let uid = "12345";
  M._get = async () => ({ result: { "12345": { uid, title,
    authors: [{ authtype: "Author", name: "van der Waals JD" }] } } });
  const reference = item({ fields: { DOI: "", extra: "PMID: 12345" }, creators: [] });
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.equal(reference.getCreators()[0].lastName, "van der Waals");
  assert.equal(reference.getCreators()[0].firstName, "JD");
  uid = "99999";
  const other = item({ fields: { DOI: "", extra: "PMID: 12345" }, creators: [] });
  assert.equal((await M.reconcileItem(other)).status, "error");
  assert.equal(other.saves, 0);
});

test("wrong returned identifiers and conflicting reference titles/authors never reach save", async () => {
  for (const record of [
    { DOI: "10.1234/other", title },
    { title },
    { DOI: "10.1234/synthetic", title: "An unrelated work on a completely different topic" },
    { DOI: "10.1234/synthetic", title, creators: [{ firstName: "Other", lastName: "Person" }] },
  ]) {
    const { M } = setup({ [prefix + "overwriteMode"]: "overwrite" });
    M.fetchCrossref = async () => record;
    const reference = item();
    assert.equal((await M.reconcileItem(reference)).status, "error");
    assert.equal(reference.saves, 0);
    assert.deepEqual(reference.writes, []);
  }
});

test("read-only, trashed and pending-edited items are skipped before network access", async () => {
  for (const scenario of ["read-only", "deleted", "pending"]) {
    const { M, Zotero } = setup();
    let calls = 0;
    M.fetchCrossref = async () => { calls++; return {}; };
    if (scenario === "read-only") Zotero.Libraries.get = () => ({ editable: false });
    const reference = item({ deleted: scenario === "deleted", pending: scenario === "pending" });
    assert.equal((await M.reconcileItem(reference)).status, "skipped");
    assert.equal(calls, 0);
    assert.equal(reference.saves, 0);
  }
});

test("conflicting local identifiers are refused before network access and CRAN requires its real URL", async () => {
  for (const fields of [
    { extra: "DOI: 10.1234/other" },
    { extra: "PMID: 12345\nPMID: 99999" },
    { extra: "PMID: 12345invalid" },
    { url: "https://cran.r-project.org/package=dplyr", extra: "CRAN: ggplot2" },
  ]) {
    const { M } = setup();
    let calls = 0;
    M.fetchCrossref = async () => { calls++; return {}; };
    const reference = item({ fields });
    assert.equal((await M.reconcileItem(reference)).status, "skipped");
    assert.equal(calls, 0);
    assert.equal(reference.saves, 0);
  }
  const { M } = setup();
  assert.equal(M._getCRAN(item({ fields: { url: "https://example.org/cran.r-project.org/package=ggplot2" } })), null);
  assert.equal(M._getCRAN(item({ fields: { url: "https://cran.r-project.org/package=ggplot2" } })), "ggplot2");
  assert.equal(M._getCRAN(item({ fields: { url: "https://cran.r-project.org/web/packages/data.table/index.html" } })), "data.table");
});

test("a saved edit by another tool during lookup invalidates the complete snapshot", async () => {
  const { M } = setup();
  const reference = item();
  M.fetchCrossref = async () => {
    reference.externalEdit("extra", "A newly saved review from another tool");
    return { DOI: "10.1234/synthetic", title, volume: "5" };
  };
  assert.equal((await M.reconcileItem(reference)).status, "skipped");
  assert.equal(reference.getField("extra"), "A newly saved review from another tool");
  assert.equal(reference.saves, 0);
});

test("cancellation during lookups prevents later mutation", async () => {
  const { M } = setup();
  M.fetchCrossref = async () => { M._cancelRequested = true; return { DOI: "10.1234/synthetic", title, volume: "5" }; };
  const reference = item();
  assert.equal((await M.reconcileItem(reference)).status, "skipped");
  assert.equal(reference.saves, 0);
  assert.deepEqual(reference.writes, []);
});

test("failed saves reload the original item rather than leaving staged changes", async () => {
  const { M } = setup();
  const reference = item({ failSave: true });
  const before = M._snapshot(reference);
  await assert.rejects(M.reconcileItem(reference), /original item was reloaded/);
  assert.equal(reference.reloads, 1);
  assert.equal(M._snapshot(reference), before);
  assert.equal(reference.hasChanged(), false);
});

test("unexpected setter failure rolls back earlier mutations without saving a partial record", async () => {
  const { M } = setup();
  M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, journal: "Synthetic Journal", volume: "4" });
  const reference = item();
  const before = M._snapshot(reference);
  const setField = reference.setField;
  reference.setField = function (field, value) {
    if (field === "volume") throw new Error("Unexpected field mutation failure");
    return setField.call(this, field, value);
  };
  await assert.rejects(M.reconcileItem(reference), /original item was reloaded/);
  assert.equal(reference.saves, 0);
  assert.equal(M._snapshot(reference), before);
  assert.equal(reference.hasChanged(), false);
});

test("simultaneous requests cannot reconcile the same item twice", async () => {
  const { M } = setup();
  let complete;
  M.fetchCrossref = () => new Promise(resolve => { complete = resolve; });
  const reference = item();
  const first = M.reconcileItem(reference);
  const second = await M.reconcileItem(reference);
  assert.equal(second.status, "skipped");
  complete({ DOI: "10.1234/synthetic", title, volume: "4" });
  await first;
  assert.equal(reference.saves, 1);
});

test("title discovery requires concordant identity and refuses ambiguous DOI candidates", async () => {
  const { M } = setup({ [prefix + "titleFallback"]: true });
  M.RateLimiter.schedule = async (_, fn) => fn();
  const reference = item({ fields: { DOI: "", publicationTitle: "Synthetic Journal" } });
  const candidate = { DOI: "10.1234/candidate", title: [title], type: "journal-article",
    author: [{ family: "Researcher" }], published: { "date-parts": [[2020]] }, "container-title": ["Synthetic Journal"] };
  M._get = async () => ({ message: { items: [candidate] } });
  assert.equal(await M._tryTitleFallback(reference), candidate.DOI);
  for (const changed of [{ type: "book-chapter" }, { author: [{ family: "Other" }] },
    { published: { "date-parts": [[2001]] } }, { "container-title": ["Different Journal"] }]) {
    M._get = async () => ({ message: { items: [{ ...candidate, ...changed }] } });
    assert.equal(await M._tryTitleFallback(reference), null);
  }
  M._get = async () => ({ message: { items: [candidate, { ...candidate, DOI: "10.1234/ambiguous" }] } });
  assert.equal(await M._tryTitleFallback(reference), null);
});

test("HTTP failures never expose keys or query text and long retry waits stop", async () => {
  const { M, Zotero, delays, requests } = setup();
  Zotero.HTTP.request = async (...args) => { requests.push(args); return { status: 429, getResponseHeader: () => "86400" }; };
  await assert.rejects(M._get("https://api.openalex.org/works/x?api_key=SECRET&query=PRIVATE"), error => {
    assert.equal(error.message, "HTTP 429 (api.openalex.org)"); return true;
  });
  assert.deepEqual(delays, []);
  assert.equal(requests.length, 1);
  Zotero.HTTP.request = async () => { throw new Error("API key SECRET in transport error"); };
  await assert.rejects(M._get("https://api.crossref.org/works/x"), /Metadata request failed \(api.crossref.org\)/);
});

test("OpenAlex credentials use headers and provider redirects are not followed", async () => {
  const { M, Zotero, preferences } = setup({ [prefix + "openalexKey"]: "SECRET" });
  M.RateLimiter.schedule = async (_, fn) => fn();
  let request;
  Zotero.HTTP.request = async (...args) => { request = args; return { status: 200, response: { doi: "https://doi.org/10.1234/synthetic" } }; };
  await M.fetchOpenAlex({ doi: "10.1234/synthetic" });
  assert.ok(!request[1].includes(preferences[prefix + "openalexKey"]));
  assert.equal(request[2].headers.Authorization, "Bearer SECRET");
  assert.equal(request[2].followRedirects, false);
});

test("HTTP status handling uses Zotero's actual option contract and retries at most twice", async () => {
  const { M, Zotero, delays } = setup();
  let attempts = 0;
  Zotero.HTTP.request = async (_, __, options) => {
    // Zotero rejects non-2xx unless successCodes is false. Its native retry
    // layer otherwise has an independent one-hour budget.
    if (options.successCodes !== false) throw new Error("UnexpectedStatusException");
    assert.equal(options.errorDelayMax, 0);
    assert.equal(options.noRetryOnThrottle, true);
    attempts++;
    return { status: 503, getResponseHeader: () => "2" };
  };
  await assert.rejects(M._get("https://api.crossref.org/works/x"), /HTTP 503/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2000, 2000]);
  Zotero.HTTP.request = async (_, __, options) => {
    if (options.successCodes !== false) throw new Error("UnexpectedStatusException");
    return { status: 404 };
  };
  assert.equal(await M._get("https://api.crossref.org/works/x"), null);
});

test("mean citedness is labelled accurately without removing independently supplied metrics", async () => {
  const { M } = setup({ [prefix + "sourcePriority"]: "openalex" });
  M.fetchOpenAlex = async () => ({ DOI: "10.1234/synthetic", title, impactFactor2yr: 2.5 });
  const reference = item({ fields: { extra: "Impact Factor: 4.1 [manually verified]" } });
  await M.reconcileItem(reference);
  assert.match(reference.getField("extra"), /OpenAlex 2yr mean citedness: 2.50/);
  assert.match(reference.getField("extra"), /Impact Factor: 4.1 \[manually verified\]/);
});
