# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a fixture runner that checks each case's request and expected response against
  a contract, with status, content type and body as three separate checks
  carrying three separate rules — and with the status *class* consulted by none
  of them, so a fixture documenting a `422` with the error body the contract
  declares is a **pass**;
- an `expected-application-error-verified` finding, emitted when a case expecting
  a `4xx` or `5xx` matches its documented contract, so the property this shape of
  tool most easily gets wrong is visible in the report when it goes right;
- a JSON Pointer on every body mismatch, escaped per RFC 6901, so a property
  literally named `a/b` does not silently become two path segments;
- a purpose-built validator for a declared bounded subset of JSON Schema
  2020-12 — no dependency, and a visible boundary: a keyword, dialect, format,
  construct, reference or pattern outside the subset leaves the value unchecked,
  the case uncounted and the run `incomplete`, and is never treated as satisfied;
- conservative refusal of a `pattern` rather than compilation of it — a contract
  is untrusted input, and a regular expression cannot be stopped once it has
  started, so the bound is decided *before* the match: a length bound,
  lookaround, back references and property escapes, any quantifier applied to a
  group that itself repeats or alternates, and any two variable-length parts of
  one sequence whose boundary no character between them can fix. `[A-Z]+\d+` and
  `\w+@\w+\.\w+` are compiled and applied; `\d+\d+`, `.*.*x` and forty adjacent
  `\d?` are refused, unchecked, `incomplete`;
- `jsonSchemaDialect` on the contract document, read rather than accepted and
  dropped: it must name the one dialect this validator implements, and any other
  value stops the run before a fixture is checked;
- comparison of the headers the in-process mock answers against the ones the
  fixture expects, `live-header-mismatch`, so `mock.routes[].headers` decides
  something rather than decorating the plan;
- calendar-correct `date` and `date-time` checking computed with arithmetic
  rather than a host date parser, so a leap day is judged identically on every
  machine and in every time zone;
- media-type comparison on the essence and the contract's declared parameters,
  in which `application/problem+json` does *not* satisfy a declared
  `application/json`: a structured suffix tells a parser how to read the bytes,
  it does not make two media types interchangeable in a contract;
- an optional live call against an in-process mock declared in the plan, with
  per-case routes so one operation can answer `201` to its success fixture and
  `422` to its validation fixture;
- refusal of any target that is not that local in-process mock — an external
  host, a non-loopback address, a non-HTTP scheme, a URL carrying credentials —
  decided *before* a call is constructed, and reported as evidence that was never
  obtained rather than quietly answered from the local table;
- three closed document shapes: every key of the plan, the contract and the
  fixture set is declared, and an undeclared one is refused by name, so `expct`
  cannot disable the response check;
- real-path containment on both sides for the documents a plan declares, so a
  symlink out of the plan directory is refused unread while a document genuinely
  inside a root reached through a symlink is still read;
- an optional `--out` copy of the report, refused when its destination shares an
  inode with any input of the run — a hard link has no target for `realpath` to
  resolve, and a real-path comparison is exactly how a tool comes to write its
  report over its own contract — with every refusal answered as configuration:
  nothing written, an empty stdout and exit code 2;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` for every
  byte source, the plan file included, so whether an input is decodable is the
  decoder's decision and never an inference drawn from the decoded text;
- explicit bounds on document bytes, operations, cases, body bytes, body depth,
  schema depth and findings, each configurable in the plan and on the command
  line, each capped so the configuration cannot spell past it, and each making
  the run `incomplete` rather than truncating quietly;
- sanitisation of every untrusted string that reaches output — case ids,
  operation ids, header names, property names, media types, paths, pointers,
  messages and evidence alike — removing C0, DEL, the whole C1 range (where
  `U+0085` NEL and the 8-bit CSI `U+009B` live), the line and paragraph
  separators, and the bidi formatting characters, whose `U+202E` would otherwise
  reverse everything displayed after it;
- a `run` object alongside the report envelope carrying the contract, the fixture
  set, the mock and one record per case in declared order;
- a CLI with `--help`, `--version`, `--json`, `--label`, `--call`, `--no-call`,
  `--out` and the limit flags, the JSON report on stdout and nothing else,
  diagnostics on stderr, and exit codes 0 / 1 / 2 — with an empty stdout for a
  configuration error and an `incomplete` report for evidence that could not be
  obtained, and with an unknown option or a repeated value-carrying flag refused
  rather than silently overwriting the earlier value;
- `runPlan` and `runPlanFile` as the public API;
- runnable clean and deliberately broken example plans; the clean one passes with
  two documented application errors among its four cases, and the broken one
  fails with one rule per case;
- the rule catalog, the three document schemas, the supported schema subset, the
  limits, the report shape, the exit codes and the list of things this tool
  cannot conclude, in `docs/contract-rules.md`.

### Fixed

- `--out` no longer destroys a file it was never asked to touch. Pointed at a
  **symbolic link**, the run wrote its report through the link and destroyed a
  file outside the working directory, exiting 0 with a `pass` report on stdout;
  a link whose target did not exist yet created a brand new file out there the
  same way; and a **symlinked parent directory** carried the report out of a
  root a lexical prefix check said it was inside. The destination against every
  input's inode — the hard-link hole — was the one of the three this tool had
  closed, and it is exactly the check that cannot see a link pointing at a file
  that is not an input at all. The destination is now settled before the plan is
  opened, with `lstat`, a resolved parent and an output root that defaults to
  the working directory and is widened only by naming it: nothing is written,
  stdout stays empty, exit code 2. The inode comparison against the contract and
  fixture documents was left where it was, at the moment the copy is written —
  see the entry below, which is where that ended up.
- every refused `--out` destination now has one shape: exit 2, a stdout of
  exactly 0 bytes, nothing written. Two of the three did not. From inside a copy
  of `examples/clean`, `--out plan.json` exited 2 with an empty stdout — correct
  — while `--out contract.json` and `--out fixtures.json` exited **1 with the
  whole 2700-byte report on stdout**, because a document the plan names is only
  known to be an input once the plan has been read, and the refusal was reported
  as an `output-destination-refused` finding instead of answered as the
  configuration error it is. No input was ever destroyed; the exit shape was
  wrong. The destination is now settled a second time, against every document
  the run resolved, immediately before the copy is written — the shape
  `license-obligation-scanner` already uses — and each document's real path is
  recorded before the file is opened, so one that turned out to be unreadable,
  too large or unparseable is protected too. Consequences: a destination that
  cannot be written at all is exit 2 with an empty stdout rather than a finding,
  since a run that could not file the copy it was asked for has not done what it
  was asked; the missing directories of a destination are created, which is what
  the guard already permits by resolving through them; and
  `output-destination-refused` is gone from the rule table, from
  `SEVERITY_DECIDES` and from `docs/contract-rules.md`, because no run can raise
  it any more.

### Added

- `--out-root DIR`, naming the directory `--out` may write inside; it defaults
  to the working directory, so a destination elsewhere is reachable by naming
  its root rather than being refused outright.

### Guaranteed

- A destination that writes somewhere it does not name is refused, and the
  destinations that must still work are pinned with the same weight.
  `test/destination.test.mjs` drives the real binary once per hole — a symbolic
  link at the destination, a dangling one, a symlinked parent that leaves the
  root, a `..` escape, a destination that is a directory, the contract document
  the plan names, the fixture document it names, and a hard link to one of them
  — and once per allowed destination: a plain path, a subdirectory, a directory
  that does not exist yet, a rewrite of the previous run's report, a directory
  reached through a symbolic link that stays inside the root, and a path outside
  the working directory once `--out-root` names it. Every refusal asserts exit
  2, an empty stdout and the input byte-identical. A guard that refuses
  everything passes every data-loss test while making the tool useless.
- A parse failure does not quote the document it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, so a plan or
  a declared document short enough to be nothing but a credential was reproduced
  in full by its own error message, on the report path an untrusted document
  takes. Sanitising never helped: the quoted span sits at the front of the
  message and a cut from the end leaves it. `document-not-json` now carries the
  position, line and column and never the text at it, and
  `test/parse-failure-redaction.test.mjs` plants the AWS documentation
  placeholder in an unparseable plan and in an unparseable contract, runs the
  real binary, and asserts it absent from stdout, from stderr and from every
  prefix down to eight characters — the ten-character prefix V8 quotes for a
  longer input included.
- An expected application error passes its contract. `test/acceptance.test.mjs`
  drives a documented `422` and a documented `500` through the real binary and
  pins exit 0, `status: "pass"` and `summary.errors: 0` as literals — and drives
  an undeclared `418`, a wrong content type and a wrong body field through the
  same path to pin exit 1 with the field path.
- No call leaves this machine. `test/no-network.test.mjs` opens a real HTTP
  listener on a real loopback port, declares that exact port as the plan's mock,
  runs the check to a passing verdict, and asserts the listener saw zero
  connections and zero requests.
- Unknown evidence is never a pass. Every path that could report silence as
  health — an unreadable document, a schema outside the subset, a bound that was
  hit, a live call that was refused or had no route, a run that reached a verdict
  on nothing — sets `incomplete` and exits 2. `pass` with `checked: 0` is not
  reachable.
- Two runs over the same bytes produce byte-identical stdout, under a POSIX
  locale and a Turkish one alike. No wall clock, random source, environment
  variable or directory listing reaches the output.
- Severity is pinned by consequence rather than by declaration.
  `test/severity-decides.test.mjs` and `test/incomplete-severity.test.mjs` import
  nothing from `src` and hold no rule table, no severity map and no parameterised
  expectation: each case writes its own documents, runs the real binary, and
  states its exit code, status, counted errors and printed severity word as
  literals at the assertion. The coordinated flip — the frozen table, the
  documented catalog and the behaviour-class list, all at once — is caught for
  all 39 error rules, none surviving, each by the test that drives its own rule
  through the binary rather than by a consistency check between declarations.
- Ordering is pinned by what the tool emits. This tool has exactly six sites that
  order anything reaching output: the five keys of `compareFindings` and the
  unsupported-keyword list rendered into one finding. An English collator
  substituted at each of them in turn kills five, each caught by a fixture whose
  collation order and code-unit order genuinely disagree — `Z` against `a`,
  `a-b` against `a_b`. The sixth orders rule ids over a closed `[a-z0-9-]`
  alphabet on which both orderings agree for all 1640 ordered pairs of the real
  ids, so substituting a collator there provably changes no output; that
  enumeration is in `test/finding-order.test.mjs`, and the site is recorded as an
  equivalent mutant rather than counted as coverage or left unmentioned.
- Nothing is written over an input, and a refused destination never prints a
  report. The `--out` refusal compares inodes, and `test/path-identity.test.mjs`
  asserts both that a hard link's real path differs from its input's and that
  the write was refused anyway. Because the destination is settled again against
  the run's own documents before the copy is written, that refusal reaches the
  caller as exit 2 with a 0-byte stdout — the shape a configuration error has in
  this catalog — whatever verdict the run underneath it had reached, and
  `test/incomplete-backstop.test.mjs` pins that by showing the two runs it
  cannot distinguish with `--out` and the two exit codes and statuses they
  genuinely have without it.
- The pattern bound is measured, not declared. `test/pattern-bound.test.mjs`
  drives each catastrophic shape through the real binary and kills the child if
  it has not answered within five seconds — `^\d+\d+...\d+$`, twenty adjacent
  quantifiers with no nesting and no group in it, ran for 109 seconds against a
  forty-character subject before the refusal covered it.
- Each guarantee above was removed in turn and the failure watched: narrowing the
  strip set to leave C1 or the bidi overrides through, dropping a rule from the
  list that raises `incomplete`, replacing real-path containment with one that
  accepts everything, comparing real paths instead of inodes for the `--out`
  refusal, decoding leniently, dropping the vacuous-pass finding, ignoring
  unknown document keys, allowing any declared mock target, failing every `4xx`
  fixture for being a `4xx`, and unwiring the plan's limits from the run. All
  twelve were caught. Since then: deleting the one line that carried the
  `incomplete` flag through the `--out` rebuild (which the whole suite had
  missed), leaving the mock's answered headers unread, ignoring the contract's
  declared dialect, stripping nothing at all, and widening the pattern analyser
  back to the scanner that compiled `\d+\d+` — each was applied, watched to
  fail, and fixed. Where a substitution provably changes no output it is
  recorded as an equivalent mutant, with the enumeration that proves it, rather
  than counted as coverage: the rule-id ordering site, and the first of the two
  `--out` settlings, which no fixture can distinguish now that the second one
  answers every refusal the same way — it is kept because a destination that is
  already wrong should cost no reading, not because a test can see it.
- The second `--out` settling is pinned rather than declared. Removing it — the
  destination settled once, before the plan is opened, and written to
  afterwards, which is exactly the shape that put a 2700-byte report on stdout
  for `--out contract.json` — fails 7 of the 220 tests `npm test` runs on this
  tree: the contract document, the fixture document and the hard link to one of
  them in `test/destination.test.mjs`, the hard link and the unparsed document
  in `test/path-identity.test.mjs`, and both refusal tests in
  `test/incomplete-backstop.test.mjs`. Restored, 220 of 220 pass.

### Notes

- The report envelope is the Edilec report contract v1. `run` is an additional
  top-level object carrying the captured result; the four required envelope
  fields are present and unchanged.
- The contract document is this tool's own bounded shape, not OpenAPI. A
  converter is deliberately absent: a half-understood conversion is how an
  unchecked field comes to look checked.
- A loopback socket transport for the mock is deliberately absent rather than
  unfinished. `mock.mode` accepts `in-process` and nothing else.

No release has been published.
