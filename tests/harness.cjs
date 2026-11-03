const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.env.METADATA_MENDER_SOURCE || path.join(__dirname, "../content/metadata-mender.js");
const source = fs.readFileSync(sourcePath, "utf8");
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
  let pendingTags = null;
  return {
    id: 1, key: "SYNTH001", libraryID: 1, itemTypeID: 2, deleted: !!options.deleted,
    saves: 0, reloads: 0, writes: [],
    isRegularItem: () => true, hasChanged: () => changed || pendingTags !== null,
    getField: field => fields[field] || "", getCreators: () => clone(creators), getTags: () => clone(pendingTags || tags),
    setField(field, value) {
      this.writes.push(field);
      if (["PMID", "PMCID", "arXiv"].includes(field)) throw new Error("Unsupported native identifier field");
      fields[field] = value; changed = true;
    },
    setCreators: value => { creators = clone(value); changed = true; },
    addTag(tag, type) {
      const target = options.nativeTagTracking ? (pendingTags ||= clone(tags)) : tags;
      if (!target.some(t => t.tag === tag)) target.push({ tag, type });
      changed = true;
    },
    removeTag(tag) {
      if (options.nativeTagTracking) pendingTags = (pendingTags || tags).filter(t => t.tag !== tag);
      else tags = tags.filter(t => t.tag !== tag);
      changed = true;
    },
    async saveTx() { this.saves++; if (options.failSave) throw new Error("Synthetic disk error");
      tags = pendingTags || tags; pendingTags = null;
      stored = clone({ fields, creators, tags }); changed = false; },
    async reload() { this.reloads++; ({ fields, creators, tags } = clone(stored)); changed = false; },
    _clearChanged(dataType) { if (dataType === "tags") pendingTags = null; },
    externalEdit(field, value) { fields[field] = value; stored = clone({ fields, creators, tags }); },
  };
}

module.exports = { setup, item, title, prefix };
