## Preferences pane
mm-prefs-keys-header = API access
mm-prefs-keys-hint = All fields are optional. Keys raise your rate limits and (for OpenAlex) are needed beyond the free daily allowance. A contact email puts Crossref requests into the faster polite pool.
mm-prefs-mailto =
    .value = Contact email (mailto):
mm-prefs-openalex =
    .value = OpenAlex API key:
mm-prefs-ncbi =
    .value = NCBI (PubMed) API key:
mm-prefs-crossref-plus =
    .value = Crossref Plus token:
mm-prefs-semanticscholar =
    .value = Semantic Scholar API key:
mm-prefs-core =
    .value = CORE API key:
mm-prefs-behavior-header = Behaviour
mm-prefs-priority =
    .value = Source priority:
mm-prefs-priority-hint = Comma-separated, highest priority first. Default: pubmed,openalex,crossref,semanticscholar,openaire,unpaywall,core,cran
mm-prefs-mode =
    .value = Update mode:
mm-prefs-initials =
    .label = Abbreviate author first names to initials (PubMed style)
mm-prefs-title-fallback =
    .label = Look up DOI by title when item has no DOI/PMID
mm-prefs-tag-policy =
    .value = Mended-tag policy:
mm-prefs-concurrency =
    .value = Parallel items per batch:

## Menu, progress, and alerts
mm-menu-mend =
    .label = Mend metadata (DOI/PMID lookup)
mm-alert-no-selection = No regular items selected.
mm-progress-tick = Reconciling { $done }/{ $total }… (Esc to cancel)
mm-progress-done = Done. { $updated } updated, { $unchanged } unchanged, { $skipped } skipped, { $notfound } not found, { $errored } errored.
mm-progress-cancelled = Cancelled. { $updated } updated, { $unchanged } unchanged, { $skipped } skipped, { $notfound } not found, { $errored } errored.
