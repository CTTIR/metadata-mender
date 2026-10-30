# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-10-30

### Fixed

- Preserve saved update settings; new installations fill empty fields, retain full
  names, and disable title-based DOI adoption by default.
- Require returned identifier identity and reject conflicting bibliographic evidence.
  Optional title search now requires author, year, publication and type agreement.
- Refuse conflicting local identifiers and CRAN-like substrings in unrelated URLs;
  retain compound PubMed surnames.
- Refuse read-only, trashed, pending-edit, and changed-during-lookup items. Cancel
  before writes, prevent overlapping batches, and reload failed staged changes.
- Check item-type field support before setting identifiers; retain conflicting
  Extra identifiers in fill mode and preserve manual tags.
- Sanitize network errors, refuse redirects, bound retries, and correctly pace CORE.
- Name the OpenAlex metric as 2-year mean citedness; preserve existing Impact Factor lines.
- Build reproducible packages without removing older artifacts; verify archive
  contents and release tag/version agreement. Add reconciliation and package tests.

### Compatibility

- Declare Zotero 9.0–10.0.x. See `docs/AUDIT-2026-10-30.md` for actual qualification
  evidence and remaining desktop verification. This local candidate is not published.

## [0.6.0] - 2026-05-28

### Added

- Overwrite mode default, with a *Fill empty fields only* alternative in
  preferences.
- `journalAbbr` and `language` fields populated where sources expose
  them.
- Configurable mended-tag policy: *latest run*, *full history*, or
  *stable*.
- Crossref title-fallback lookup for items lacking a DOI/PMID
  (Jaccard ≥ 0.7), toggleable in preferences.

### Changed

- Improved DOI/PMID detection from `Extra` lines.
- Creator names are now stored with initials by default; toggleable.
- Legacy provenance/citation lines are migrated to the current format
  on first run.

[Unreleased]: https://github.com/CTTIR/metadata-mender/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/CTTIR/metadata-mender/releases/tag/v0.6.1
[0.6.0]: https://github.com/CTTIR/metadata-mender/releases/tag/v0.6.0
