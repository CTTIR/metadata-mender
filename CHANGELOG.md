# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/r-heller/metadata-mender/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/r-heller/metadata-mender/releases/tag/v0.6.0
