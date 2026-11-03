const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, item, title, prefix } = require("./harness.cjs");
const turn = () => new Promise(resolve => setImmediate(resolve));

test("fill mode preserves every conflicting stable Extra identifier, including native duplicates", async () => {
  for (const [key, recordKey, value, conflict] of [
    ["PMCID", "PMCID", "PMC111", "PMC999"],
    ["arXiv", "arXivID", "2401.00001", "2401.00002"],
    ["OpenAlex", "openalexID", "W111", "W999"],
  ]) {
    for (const native of [false, true]) {
      const { M, Zotero } = setup();
      if (native && key !== "OpenAlex") {
        const getID = Zotero.ItemFields.getID;
        const valid = Zotero.ItemFields.isValidForType;
        Zotero.ItemFields.getID = field => field === key ? key : getID(field);
        Zotero.ItemFields.isValidForType = field => field === key || valid(field);
      }
      const extra = `Review note\n${key}: ${value}\n${key}: ${conflict}`;
      const reference = item({ fields: { extra, ...(native ? { [key]: value } : {}) } });
      M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, [recordKey]: value });
      assert.equal((await M.reconcileItem(reference)).status, "unchanged");
      assert.equal(reference.getField("extra"), extra);
      assert.equal(reference.saves, 0);
    }
  }
});

test("equal duplicate stable identifiers can still be consolidated in fill mode", async () => {
  const { M } = setup();
  const reference = item({ fields: { extra: "Review note\nPMCID: PMC111\nPMCID: PMC111" } });
  M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, PMCID: "PMC111" });
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.equal(reference.getField("extra").match(/PMCID: PMC111/g).length, 1);
  assert.ok(reference.getField("extra").includes("Review note"));
});

test("venue enrichment requires the returned source identity and refreshes on a new UTC day", async () => {
  const { M } = setup();
  M.RateLimiter.schedule = async (_, fn) => fn();
  let day = "2026-11-02", calls = 0, source = "S999";
  M._today = () => day;
  M._get = async () => {
    calls++;
    return { id: `https://openalex.org/${source}`, summary_stats: { "2yr_mean_citedness": calls } };
  };
  const wrong = { openalex: { _sourceId: "S123" } };
  await M._enrichWithVenue(wrong);
  assert.equal(wrong.openalex.impactFactor2yr, undefined);
  source = "S123";
  const first = { openalex: { _sourceId: "S123" } };
  await M._enrichWithVenue(first);
  assert.equal(first.openalex.impactFactor2yr, 2);
  const repeated = { openalex: { _sourceId: "S123" } };
  await M._enrichWithVenue(repeated);
  assert.equal(repeated.openalex.impactFactor2yr, 2);
  assert.equal(calls, 2);
  day = "2026-11-03";
  const next = { openalex: { _sourceId: "S123" } };
  await M._enrichWithVenue(next);
  assert.equal(next.openalex.impactFactor2yr, 3);
  assert.equal(calls, 3);
});

test("unusable metrics do not overwrite evidence and a genuine zero is retained", async () => {
  for (const invalid of [-1, NaN, Infinity, "3"]) {
    const { M } = setup({ [prefix + "sourcePriority"]: "openalex,crossref" });
    M.fetchOpenAlex = async () => ({ DOI: "10.1234/synthetic", title,
      citedByCount: invalid, impactFactor2yr: invalid });
    M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, citedByCount: 0 });
    const reference = item({ fields: { extra: "OpenAlex 2yr mean citedness: 2.00 [OpenAlex, 2020-01-01]" } });
    assert.equal((await M.reconcileItem(reference)).status, "updated");
    assert.match(reference.getField("extra"), /Citations: 0 \[Crossref, /);
    assert.match(reference.getField("extra"), /citedness: 2\.00 \[OpenAlex, 2020-01-01\]/);
  }
  const { M } = setup({ [prefix + "sourcePriority"]: "openalex" });
  M.fetchOpenAlex = async () => ({ DOI: "10.1234/synthetic", title, citedByCount: 1.5, impactFactor2yr: 0 });
  const reference = item();
  await M.reconcileItem(reference);
  assert.doesNotMatch(reference.getField("extra"), /Citations:/);
  assert.match(reference.getField("extra"), /citedness: 0\.00/);
});

function batchWindow(items) {
  const handlers = new Set();
  return { handlers, ZoteroPane: { getSelectedItems: () => items },
    addEventListener: (_, handler) => handlers.add(handler),
    removeEventListener: (_, handler) => handlers.delete(handler) };
}

test("progress creation failure removes cancellation listeners and releases the batch", async () => {
  const { M, Zotero } = setup();
  Zotero.ProgressWindow = function () {
    this.changeHeadline = () => { throw new Error("Synthetic progress creation failure"); };
  };
  const window = batchWindow([item()]);
  await assert.rejects(M.reconcileSelected(window), /progress creation failure/);
  assert.equal(window.handlers.size, 0);
  assert.equal(M._running, false);
});

test("progress failure cancels pending writes and holds the lock until workers settle", async () => {
  const { M, Zotero } = setup();
  const first = item(), second = item({ fields: { DOI: "10.1234/second" } });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  M.fetchCrossref = async ({ doi }) => {
    if (doi.endsWith("second")) await pending;
    return { DOI: doi, title, volume: "4" };
  };
  let ticks = 0;
  const line = { setText() { if (++ticks === 2) throw new Error("Synthetic closed progress window"); }, setProgress() {} };
  Zotero.ProgressWindow = function () {
    this.changeHeadline = () => {};
    this.show = () => {};
    this.startCloseTimer = () => {};
    this.ItemProgress = function () { return line; };
  };
  const window = batchWindow([first, second]);
  let settled = false;
  const completed = M.reconcileSelected(window).then(
    () => { settled = true; return null; }, error => { settled = true; return error; });
  await turn();
  // Release even if an assertion fails, so the test cannot strand a worker.
  const beforeRelease = { running: M._running, settled, secondSaves: second.saves };
  release();
  const error = await completed;
  assert.equal(beforeRelease.running, true);
  assert.equal(beforeRelease.settled, false);
  assert.equal(beforeRelease.secondSaves, 0);
  assert.match(error.message, /closed progress window/);
  assert.equal(first.saves, 1);
  assert.equal(second.saves, 0);
  assert.equal(M._running, false);
  assert.equal(window.handlers.size, 0);
});

test("Extra identifier replacement and native promotion retain review text across line endings", async () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    for (const native of [false, true]) {
      const { M, Zotero } = setup();
      if (native) {
        const getID = Zotero.ItemFields.getID;
        const valid = Zotero.ItemFields.isValidForType;
        Zotero.ItemFields.getID = field => field === "PMCID" ? field : getID(field);
        Zotero.ItemFields.isValidForType = field => field === "PMCID" || valid(field);
      }
      const extra = `PMCID: PMC111${separator}Manual synthetic review note`;
      const reference = item({ fields: { extra, ...(native ? { PMCID: "PMC111" } : {}) } });
      M.fetchCrossref = async () => ({ DOI: "10.1234/synthetic", title, PMCID: "PMC111" });
      await M.reconcileItem(reference);
      if (native) {
        assert.match(reference.getField("extra"), /^Manual synthetic review note\nProvenance:/);
        assert.match(reference.getField("extra"), /PMCID:crossref$/);
      } else assert.equal(reference.getField("extra"), extra);
    }
  }
});

test("Extra-only identifier and CRAN changes record their actual sources without repeat saves", async () => {
  const { M } = setup({ [prefix + "sourcePriority"]: "pubmed" });
  M.fetchPubMed = async () => ({ DOI: "10.1234/synthetic", title, PMID: "12345" });
  const reference = item();
  const first = await M.reconcileItem(reference);
  assert.equal(first.status, "updated");
  assert.match(reference.getField("extra"), /PMID: 12345\nProvenance: \d{4}-\d{2}-\d{2} — PMID:pubmed$/);
  assert.equal((await M.reconcileItem(reference)).status, "unchanged");
  assert.equal(reference.saves, 1);
  const cran = setup({ [prefix + "sourcePriority"]: "cran" });
  cran.M.fetchCRAN = async () => ({ CRAN: "ggplot2", cranUpstreamUrl: "https://ggplot2.tidyverse.org" });
  const software = item({ fields: { DOI: "", extra: "CRAN: ggplot2" } });
  assert.equal((await cran.M.reconcileItem(software)).status, "updated");
  assert.match(software.getField("extra"), /Upstream-URL:cran$/);
  assert.equal((await cran.M.reconcileItem(software)).status, "unchanged");
  assert.equal(software.saves, 1);
});

test("OpenAlex PMCID URLs retain explicit NCBI article identities without trusting lookalike hosts", async () => {
  const { M } = setup();
  M.RateLimiter.schedule = async (_, fn) => fn();
  for (const value of ["PMC123", "https://www.ncbi.nlm.nih.gov/pmc/articles/123",
    "https://ncbi.nlm.nih.gov/pmc/articles/PMC123/", "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/"]) {
    M._get = async () => ({ doi: "https://doi.org/10.1234/synthetic", ids: { pmcid: value } });
    assert.equal((await M.fetchOpenAlex({ doi: "10.1234/synthetic" })).PMCID, "PMC123");
  }
  for (const value of ["https://example.org/PMC123", "https://ncbi.nlm.nih.gov.example.org/pmc/articles/123",
    "https://ncbi.nlm.nih.gov@evil.example/pmc/articles/123", "https://ncbi.nlm.nih.gov/other/PMC123",
    "https://pmc.ncbi.nlm.nih.gov/articles/123/other", "PMC123 trailing text", "PMC0", 123, {}]) {
    M._get = async () => ({ doi: "https://doi.org/10.1234/synthetic", ids: { pmcid: value } });
    assert.equal((await M.fetchOpenAlex({ doi: "10.1234/synthetic" })).PMCID, undefined);
  }
});

test("PubMed's explicitly collective authors reach Zotero as single-field creators", async () => {
  const { M } = setup({ [prefix + "sourcePriority"]: "pubmed", [prefix + "initialsGivenNames"]: true });
  M.RateLimiter.schedule = async (_, fn) => fn();
  M._get = async () => ({ result: { "12345": { uid: "12345", title,
    authors: [{ authtype: "Author", name: "van der Waals JD" },
      { authtype: "CollectiveName", name: "Synthetic Trial Group" },
      { authtype: "Investigator", name: "Not a listed author" },
      { authtype: "CollectiveName", name: "" }, null] } } });
  const reference = item({ fields: { DOI: "", extra: "PMID: 12345" }, creators: [] });
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.deepEqual(reference.getCreators(), [
    { firstName: "JD", lastName: "van der Waals", fieldMode: 0, creatorTypeID: 1 },
    { firstName: "", lastName: "Synthetic Trial Group", fieldMode: 1, creatorTypeID: 1 },
  ]);
});


test("failed saves discard native pending tags and permit a clean retry", async () => {
  const { M } = setup();
  const options = { failSave: true, nativeTagTracking: true };
  const reference = item(options);
  const before = M._snapshot(reference);
  await assert.rejects(M.reconcileItem(reference), /original item was reloaded/);
  assert.equal(M._snapshot(reference), before);
  assert.equal(reference.hasChanged(), false);
  options.failSave = false;
  assert.equal((await M.reconcileItem(reference)).status, "updated");
  assert.equal(reference.hasChanged(), false);
  assert.equal(reference.getTags().filter(t => /^mended:\d/.test(t.tag)).length, 1);
  assert.ok(reference.getTags().some(t => t.tag === "mended:manual-review"));
});

test("dirty items remain untouched and failed reloads never clear pending changes", async () => {
  for (const duringLookup of [false, true]) {
    const { M } = setup();
    const reference = item({ nativeTagTracking: true });
    const edit = () => reference.addTag("Unsaved manual review", 0);
    let clears = 0;
    reference._clearChanged = () => { clears++; };
    if (duringLookup) M.fetchCrossref = async () => { edit(); return {DOI:"10.1234/synthetic",title,volume:"4"}; };
    else edit();
    assert.equal((await M.reconcileItem(reference)).status, "skipped");
    assert.equal(reference.reloads, 0);
    assert.equal(clears, 0);
    assert.equal(reference.hasChanged(), true);
    assert.ok(reference.getTags().some(t => t.tag === "Unsaved manual review"));
  }
  const { M } = setup();
  const reference = item({ failSave: true, nativeTagTracking: true });
  reference.reload = async () => { throw new Error("Synthetic reload failure"); };
  reference._clearChanged = () => { throw new Error("Must not clear after failed reload"); };
  await assert.rejects(M.reconcileItem(reference), /reload failed; reopen Zotero/);
  assert.equal(reference.hasChanged(), true);
  const unsupported = item({ failSave: true, nativeTagTracking: true });
  delete unsupported._clearChanged;
  await assert.rejects(M.reconcileItem(unsupported), /reload failed; reopen Zotero/);
  assert.equal(unsupported.hasChanged(), true);
});
