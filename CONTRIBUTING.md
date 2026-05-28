# Contributing

Thanks for your interest in improving Metadata Mender.

## Reporting bugs and requesting features

Open an issue at
<https://github.com/r-heller/metadata-mender/issues>. The issue templates
will prompt you for the relevant details (Zotero version, OS, a sample
item or DOI that reproduces the problem). Output from **Help → Debug
Output** is almost always useful for bug reports.

## Development

The plugin is plain bootstrapped JavaScript — no build toolchain.

```bash
./build.sh           # produce metadata-mender-<version>.xpi
node --test tests/   # run unit tests for the pure helpers
```

To try a local change, install the freshly built `.xpi` into Zotero via
**Tools → Plugins → gear icon → Install Plugin From File…**, or point
Zotero at the unpacked source folder using a proxy file (see Zotero's
plugin development docs).

## Pull requests

- Keep changes focused; one logical change per PR.
- Update `manifest.json` and `update.json` together when bumping the
  version.
- Add or update an entry in `CHANGELOG.md` under `## [Unreleased]`.
- Tests live in `tests/`. New pure helpers should ship with tests.
- CI runs `node --test`, JSON validation, and a syntax check on every
  push.

## Release

1. Bump the version in `manifest.json` and `update.json`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under a new version
   heading.
3. Commit, tag `vX.Y.Z`, push the tag. The release workflow builds the
   `.xpi` and attaches it to a GitHub release.
