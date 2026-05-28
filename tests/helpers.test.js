// Unit tests for the pure helpers in content/metadata-mender.js.
// We evaluate the source file in a fresh VM context with a minimal `Zotero`
// stub so the module-level assignment to `Zotero.MetadataMender` succeeds.
//
// Run with:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "content", "metadata-mender.js");
const code = fs.readFileSync(SRC, "utf8");

function loadModule() {
  const ctx = {
    Zotero: {
      Prefs: { get: () => undefined, set: () => {} },
      Promise: { delay: (ms) => new Promise((r) => setTimeout(r, ms)) },
      debug: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.Zotero.MetadataMender;
}

const M = loadModule();

// VM-context objects have a different `Object.prototype` than this realm's,
// which breaks `deepStrictEqual`. Marshal them to plain local objects.
const plain = (o) => JSON.parse(JSON.stringify(o));

test("_normalizeDOI strips common prefixes and whitespace", () => {
  assert.strictEqual(M._normalizeDOI("https://doi.org/10.1/abc"), "10.1/abc");
  assert.strictEqual(M._normalizeDOI("https://dx.doi.org/10.1/abc"), "10.1/abc");
  assert.strictEqual(M._normalizeDOI("doi: 10.1/abc"), "10.1/abc");
  assert.strictEqual(M._normalizeDOI("  10.1/abc  "), "10.1/abc");
  assert.strictEqual(M._normalizeDOI("10.1/abc"), "10.1/abc");
});

test("_splitName parses normal 'First Last' form", () => {
  assert.deepStrictEqual(
    plain(M._splitName("John Smith")),
    { firstName: "John", lastName: "Smith", creatorType: "author" }
  );
  assert.deepStrictEqual(
    plain(M._splitName("Mary Jane Watson")),
    { firstName: "Mary Jane", lastName: "Watson", creatorType: "author" }
  );
  assert.deepStrictEqual(
    plain(M._splitName("")),
    { firstName: "", lastName: "", creatorType: "author" }
  );
});

test("_splitName parses PubMed 'Last IN' form when lastFirst=true", () => {
  assert.deepStrictEqual(
    plain(M._splitName("Smith JA", true)),
    { firstName: "JA", lastName: "Smith", creatorType: "author" }
  );
  assert.deepStrictEqual(
    plain(M._splitName("Müller H", true)),
    { firstName: "H", lastName: "Müller", creatorType: "author" }
  );
});

test("_reconstructAbstract reorders words by their indices", () => {
  const idx = { hello: [0], world: [1] };
  assert.strictEqual(M._reconstructAbstract(idx), "hello world");

  const repeated = { the: [0, 4], "quick": [1], "brown": [2], "fox": [3], "lazy": [5] };
  assert.strictEqual(M._reconstructAbstract(repeated), "the quick brown fox the lazy");
});

test("_upsertExtraLine appends when the key is absent", () => {
  assert.strictEqual(
    M._upsertExtraLine("PMID: 123", "Citations", "5"),
    "PMID: 123\nCitations: 5"
  );
  assert.strictEqual(M._upsertExtraLine("", "PMID", "9"), "PMID: 9");
});

test("_upsertExtraLine replaces an existing key in place (case-insensitive)", () => {
  assert.strictEqual(M._upsertExtraLine("Citations: 1", "Citations", "5"), "Citations: 5");
  assert.strictEqual(M._upsertExtraLine("citations: 1", "Citations", "5"), "Citations: 5");
});

test("_upsertExtraLine deduplicates multiple lines with the same key", () => {
  const result = M._upsertExtraLine(
    "Citations: 1\nfoo: bar\nCitations: 2",
    "Citations",
    "9"
  );
  assert.strictEqual(result, "Citations: 9\nfoo: bar");
});

test("_toInitials abbreviates given names PubMed-style and is idempotent", () => {
  assert.strictEqual(M._toInitials("Raban Arved"), "RA");
  assert.strictEqual(M._toInitials("Helena Lucia"), "HL");
  assert.strictEqual(M._toInitials("Maximilian"), "M");
  assert.strictEqual(M._toInitials("Jean-Pierre"), "JP");
  assert.strictEqual(M._toInitials("J."), "J");
  // Already-abbreviated input passes through unchanged (idempotent).
  assert.strictEqual(M._toInitials("RA"), "RA");
  assert.strictEqual(M._toInitials("HL"), "HL");
  assert.strictEqual(M._toInitials(""), "");
});

test("_removeExtraLine drops the matching key (case-insensitive) and trims blanks", () => {
  assert.strictEqual(M._removeExtraLine("PMID: 1\nDOI: 10.1/x", "PMID"), "DOI: 10.1/x");
  assert.strictEqual(M._removeExtraLine("pmid: 1\nDOI: 10.1/x", "PMID"), "DOI: 10.1/x");
  assert.strictEqual(M._removeExtraLine("PMID: 1", "PMID"), "");
  // Absent key — unchanged.
  assert.strictEqual(M._removeExtraLine("DOI: 10.1/x", "PMID"), "DOI: 10.1/x");
});

test("_normalizeLang maps ISO 639-2 to 639-1 and passes through the rest", () => {
  assert.strictEqual(M._normalizeLang("eng"), "en");
  assert.strictEqual(M._normalizeLang("ENG"), "en");
  assert.strictEqual(M._normalizeLang("ger"), "de");
  assert.strictEqual(M._normalizeLang("en"), "en");
  assert.strictEqual(M._normalizeLang("xyz"), "xyz");
  assert.strictEqual(M._normalizeLang(""), "");
});

test("_appendExtraLineIfMissing is a no-op when the key already exists", () => {
  assert.strictEqual(
    M._appendExtraLineIfMissing("PMID: 1", "PMID", "999"),
    "PMID: 1"
  );
  assert.strictEqual(M._appendExtraLineIfMissing("", "PMID", "1"), "PMID: 1");
  assert.strictEqual(
    M._appendExtraLineIfMissing("DOI: 10.1/x", "PMID", "1"),
    "DOI: 10.1/x\nPMID: 1"
  );
});

test("_parseRetryAfter handles seconds and HTTP-date forms", () => {
  assert.strictEqual(M._parseRetryAfter("30"), 30000);
  assert.strictEqual(M._parseRetryAfter("0"), 0);
  assert.strictEqual(M._parseRetryAfter(""), null);
  assert.strictEqual(M._parseRetryAfter(null), null);
  // HTTP-date in the past should clamp to 0.
  assert.strictEqual(M._parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0);
});

test("_today returns ISO YYYY-MM-DD", () => {
  assert.match(M._today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("_titleSimilar gives 1 for identical titles", () => {
  assert.strictEqual(
    M._titleSimilar("Effects of caffeine on sleep", "Effects of caffeine on sleep"),
    1
  );
});

test("_titleSimilar is case- and punctuation-insensitive", () => {
  assert.strictEqual(
    M._titleSimilar(
      "Effects of caffeine on sleep.",
      "EFFECTS OF caffeine, ON sleep"
    ),
    1
  );
});

test("_titleSimilar scores partial overlap between 0 and 1", () => {
  const score = M._titleSimilar(
    "Effects of caffeine on sleep in adults",
    "Effects of caffeine on sleep latency"
  );
  assert.ok(score > 0.3 && score < 1, `expected 0.3<score<1, got ${score}`);
});

test("_titleSimilar gives 0 for disjoint titles", () => {
  assert.strictEqual(
    M._titleSimilar(
      "Effects of caffeine on sleep",
      "Quantum entanglement experiments"
    ),
    0
  );
});

test("_titleSimilar ignores short tokens (≤2 chars)", () => {
  // "of" / "on" / "in" should be dropped; only meaningful words count.
  const score = M._titleSimilar("a of in on it", "x of in on it");
  assert.strictEqual(score, 0);
});

test("_parseRDescriptionAuthors handles a single author with role tag", () => {
  assert.deepStrictEqual(
    plain(M._parseRDescriptionAuthors("Hadley Wickham [aut, cre]")),
    [{ firstName: "Hadley", lastName: "Wickham", creatorType: "author" }]
  );
});

test("_parseRDescriptionAuthors splits on top-level commas only", () => {
  // Commas inside [...] or (...) must not split the entry.
  const result = M._parseRDescriptionAuthors(
    "Hadley Wickham [aut, cre], Winston Chang [aut]"
  );
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(plain(result[0]), {
    firstName: "Hadley", lastName: "Wickham", creatorType: "author",
  });
  assert.deepStrictEqual(plain(result[1]), {
    firstName: "Winston", lastName: "Chang", creatorType: "author",
  });
});

test("_parseRDescriptionAuthors strips ORCID parentheticals", () => {
  const result = M._parseRDescriptionAuthors(
    "Hadley Wickham [aut, cre] (<https://orcid.org/0000-0003-4757-117X>)"
  );
  assert.deepStrictEqual(plain(result[0]), {
    firstName: "Hadley", lastName: "Wickham", creatorType: "author",
  });
});

test("_parseRDescriptionAuthors returns empty for empty/null input", () => {
  assert.deepStrictEqual(plain(M._parseRDescriptionAuthors("")), []);
  assert.deepStrictEqual(plain(M._parseRDescriptionAuthors(null)), []);
});
