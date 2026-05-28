# Metadata Mender

A Zotero 7 plugin that reconciles and completes item metadata by looking up the
item's **DOI**, **PMID**, or **CRAN package id** against eight free databases —
**PubMed (NCBI E-utilities)**, **OpenAlex**, **Crossref**, **Semantic Scholar**,
**OpenAIRE** (grey literature), **Unpaywall**, **CORE**, and **CRAN** (R
packages, via METACRAN) — and merges the results back onto the item. It also
records the current **citation count** and a **journal impact-factor
surrogate** with a date stamp, and surfaces the **Open Access PDF link** when
available.

## What it does

- Right-click one or more items → **Mend metadata (DOI/PMID lookup)**.
  The menu item is hidden automatically when no regular item is selected.
- For each item it reads the DOI (from the DOI field or `Extra`) and PMID
  (from `Extra`), queries the configured sources, and fills in or corrects:
  title, date, journal/publication title, volume, issue, pages, ISSN,
  abstract, URL, publisher, and authors.
- If the item has neither a DOI nor a PMID, the plugin can optionally fall
  back to a Crossref bibliographic search by title (+ first author) and adopt
  the top match when its title is similar enough (Jaccard ≥ 0.7 on tokenised
  words). Controlled by a setting; default on.
- Items are processed in parallel (configurable, default 4 workers). Per-source
  rate limits are still respected, so a batch only goes faster where one source
  is idle while another is waiting.
- A progress popup ticks per item and can be cancelled with **Esc**.
- Items that get changes are tagged according to the configured tag policy:
  - *Latest run* (default) — single `mended:YYYY-MM-DD` tag, replacing any
    previous date tag on that item.
  - *Full history* — accumulates one `mended:YYYY-MM-DD` tag per run date.
  - *Stable* — a single `mended` tag without a date.
- Per-item errors (after retries) are shown inline in the progress popup —
  up to five with their failure reasons, plus a "…and N more" line when
  truncated. Full details always go to **Help → Debug Output**.

### Extra-field lines written

The plugin writes these structured lines to `Extra`. Stable identifiers are
appended once; temporal data is rewritten on every run with today's date.

| Line               | Behaviour | Source |
|--------------------|-----------|--------|
| `PMID: <id>`       | Append once | discovered from PubMed or Semantic Scholar |
| `PMCID: PMC<id>`   | Append once | OpenAlex, PubMed, or Semantic Scholar |
| `arXiv: <id>`      | Append once | Semantic Scholar |
| `OpenAlex: W<id>`  | Append once | OpenAlex |
| `Citations: <n> [<source>, YYYY-MM-DD]` | Rewritten every run | OpenAlex preferred; falls back to Crossref or Semantic Scholar |
| `Impact Factor: <x.xx> [OpenAlex 2yr mean citedness, YYYY-MM-DD]` | Rewritten every run | OpenAlex venue lookup |
| `OA-URL: <url>`    | Rewritten every run | Cascade — OpenAlex → Unpaywall → OpenAIRE → CORE |
| `Provenance: YYYY-MM-DD — field:source, …` | Rewritten on any change | derived from the actual merges performed |

Citation count is pinned to OpenAlex (with a fallback) so the time series
stays comparable across runs.

## Sources, keys, and rate limits

All keys are **optional**. Configure them in
**Zotero → Settings → Metadata Mender**.

| Source           | Works without a key?              | What a key/email buys you |
|------------------|-----------------------------------|---------------------------|
| PubMed           | Yes (3 requests/sec)              | An NCBI API key raises the limit to 10 requests/sec. |
| OpenAlex         | Single DOI/PMID lookups are free  | An API key is required beyond the free daily allowance and raises throughput. |
| Crossref         | Yes                               | A contact email (`mailto`) joins the faster *polite pool*. A *Crossref Plus* token unlocks the premium pool. |
| Semantic Scholar | Yes (~1 req/sec, shared)          | An API key reserves headroom and raises the throttle. |
| OpenAIRE         | Yes                               | Broad coverage of grey literature (theses, reports, working papers, repository deposits) — especially European/funded research. |
| Unpaywall        | Requires the contact email only   | Best-in-class discovery of open-access PDFs (especially repository copies). No API key. |
| CORE             | **No** (anonymous budget is too small to be useful) | A free API key unlocks the 10 tokens/minute tier and gives access to direct full-text PDF URLs. |
| CRAN (METACRAN)  | Yes                               | Resolves R-package metadata (Title, Description, Version, Authors, Date, License, URL). |

## Source priority

Default order: `pubmed,openalex,crossref,semanticscholar,openaire,unpaywall,core,cran`.

The first source with a non-empty value for a given field wins. PubMed and
OpenAlex are queried first because they have the highest signal for the
biomedical items most users curate; the others fill gaps. Citation count is
pinned to OpenAlex regardless of priority (with a fallback). Impact factor
always comes from OpenAlex (only it exposes per-venue `2yr_mean_citedness`).

The plugin adapts its request pacing automatically based on which keys are
present. On HTTP **429** or **5xx** it retries up to twice, honouring
`Retry-After`. **404** is treated as "no record" rather than an error.

Where to get keys:

- **OpenAlex** — free account at <https://openalex.org/settings/api>
- **NCBI** — free, under your account at <https://www.ncbi.nlm.nih.gov/account/>
- **Semantic Scholar** — request at <https://www.semanticscholar.org/product/api>
- **CORE** — free, register at <https://core.ac.uk/services/api>
- **Crossref Plus** — paid; only if you have a subscription
- **Unpaywall** — no key; uses the contact email you already set for Crossref
- **OpenAIRE** — no key required
- **CRAN (METACRAN)** — no key required

## R packages (CRAN)

To mend a software item that represents an R package, give it one of:

- A URL like `https://cran.r-project.org/package=ggplot2` in the Zotero **URL**
  field; the package name is parsed automatically.
- A line `CRAN: ggplot2` in **Extra**.

The plugin then queries METACRAN (`crandb.r-pkg.org`) for the package's
DESCRIPTION and fills in title (package name), abstract (Description), date
(Date/Publication), authors (parsed from the DESCRIPTION Author field, with
`[role]` tags and ORCID parentheticals stripped), version, programming
language ("R"), publisher (CRAN), and URL (the CRAN package page). It also
writes `License:`, `Upstream-URL:`, and `CRAN:` lines to Extra.

If your item type isn't `computerProgram`, the version is stashed as a
`Version:` line in Extra rather than dropped.

## Settings

- **Contact email (mailto)** — used in the User-Agent, Crossref's polite-pool
  query, and as the required identifier for Unpaywall. Setting it also enables
  the Unpaywall source.
- **Source priority** — comma-separated, highest first. Default
  `crossref,pubmed,semanticscholar,openalex`. The first source that supplies a
  given field wins. Citation count and impact factor are special: see above.
- **Update mode**
  - *Fill empty fields only* (default) — never touches standard fields you
    already have.
  - *Overwrite existing fields* — replaces existing values with the
    highest-priority source's value.
- **Look up DOI by title when item has no DOI/PMID** — default on. Disable if
  you'd rather skip such items than risk an incorrect match.
- **Mended-tag policy** — *latest* / *history* / *stable* (see above).
- **Parallel items per batch** — 1 to 12, default 4. Higher is only helpful
  when you have keys that raise the per-source RPS budgets.
- Citation count, impact factor, OA URL, and provenance are written on every
  run regardless of update mode (they are time-stamped readings, not stable
  bibliographic metadata).
- For item types that don't expose a Zotero `DOI` field (books, theses, …) a
  discovered DOI is written as `DOI:` in `Extra` instead of being silently
  dropped.

## Run summary

After each batch the progress popup reports:

`Done. N updated, N unchanged, N skipped, N not found, N errored.`

- **updated** — at least one field or Extra line changed (and a
  `mended:YYYY-MM-DD` tag was added).
- **unchanged** — sources answered but had nothing new to add.
- **skipped** — item has no DOI/PMID, so nothing to look up.
- **not found** — every queried source returned 404 (work not indexed).
- **errored** — every queried source threw (network, 5xx after retries, etc.).

Press **Esc** during a batch to stop after the current item; the summary then
reads "Cancelled. …" with whatever was accumulated so far.

## Install

**Compatibility:** Zotero 7 and newer (`strict_min_version 6.999`,
`strict_max_version 9.*`). Not compatible with Zotero 6.

1. Download `metadata-mender-<version>.xpi` from the
   [Releases page](https://github.com/r-heller/metadata-mender/releases).
2. In Zotero: **Tools → Plugins → gear icon → Install Plugin From File…**
3. Select the `.xpi`. Restart Zotero if prompted.

## Documentation

Full walkthrough and screenshots: <https://r-heller.github.io/metadata-mender/>.

## Build from source

```bash
./build.sh
```

Produces `metadata-mender-<version>.xpi`. No build toolchain required — it is
plain bootstrapped JS zipped into an XPI.

## Tests

```bash
node --test tests/
```

The pure helpers (`_normalizeDOI`, `_splitName`, `_reconstructAbstract`,
`_upsertExtraLine`, `_appendExtraLineIfMissing`, `_parseRetryAfter`, `_today`)
are exercised in a VM context with a minimal Zotero stub — no Zotero install
needed. The same suite runs on every push via `.github/workflows/ci.yml`.

## Release

Push a tag `vX.Y.Z` matching `manifest.json`'s version. The `release` job in
the CI workflow builds the XPI and attaches it to a GitHub release. Don't
forget to bump `update.json` to the same version.

## Notes & limitations

- Only regular items (not notes/attachments) are processed.
- Items with neither a DOI nor a PMID are skipped.
- OpenAlex abstracts are reconstructed from its inverted-index format; Crossref
  abstracts are stripped of JATS XML tags.
- Author name parsing is heuristic (especially for PubMed's "Surname IN" form);
  spot-check author fields after a bulk run in *overwrite* mode.
- The "impact factor" is OpenAlex's 2-year mean citedness — a transparent
  surrogate computed by OpenAlex, not the Clarivate JIF. It tracks closely for
  most journals but is not identical. Items not on a recognised venue
  (preprints, books, conference papers without indexed proceedings) will not
  get an impact-factor line.
- The bundled icons in `content/icons/` are **placeholders** (solid colour
  squares). Replace them before publishing.

## How to cite

If Metadata Mender contributes to a publication, please cite it.

**BibTeX**

```bibtex
@software{heller_metadata_mender_2026,
  author  = {Heller, Raban},
  title   = {Metadata Mender: a Zotero plugin for reconciling item
             metadata against PubMed, OpenAlex, Crossref, Semantic
             Scholar, OpenAIRE, Unpaywall, CORE, and CRAN},
  year    = {2026},
  version = {0.6.0},
  url     = {https://github.com/r-heller/metadata-mender},
  license = {MIT}
}
```

**APA**

> Heller, R. (2026). *Metadata Mender: a Zotero plugin for reconciling item
> metadata against PubMed, OpenAlex, Crossref, Semantic Scholar, OpenAIRE,
> Unpaywall, CORE, and CRAN* (Version 0.6.0) [Computer software].
> https://github.com/r-heller/metadata-mender

> **DOI:** none yet. To mint one, archive a tagged release on
> [Zenodo](https://zenodo.org/account/settings/github/) (enable the repo,
> push a `vX.Y.Z` tag, accept the auto-deposit). Then add `doi = {…}` to
> the BibTeX entry above and a `doi:` field to `CITATION.cff`.

## Links

- Documentation: <https://r-heller.github.io/metadata-mender/>
- Issues: <https://github.com/r-heller/metadata-mender/issues>
- Releases: <https://github.com/r-heller/metadata-mender/releases>

## License

[MIT](LICENSE).
