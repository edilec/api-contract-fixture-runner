# Rules, document schemas, the supported schema subset, and limits

Reference for `api-contract-fixture-runner`. The authoritative severity table lives in
`src/rules.mjs`; this document records the same catalog for a reader. The behaviour of every rule
is pinned by tests that run the real binary — `test/severity-decides.test.mjs` and
`test/incomplete-severity.test.mjs` — and those tests import nothing from `src` and hold no copy of
this table, because three declarations agreeing with each other can be edited together.

## The one thing to read first

**An error response is not a contract violation.** A fixture that declares a `422` with the error
body the contract documents is a **pass**. Status, content type and body are three separate checks
with three separate rules, and not one of them consults the status *class*. A `4xx` or `5xx` fails
only when it is undeclared, or when its content type or its body does not match what the contract
says that status carries.

## The rule catalog

Severity decides the verdict: any `error` fails the run, a `warning` or `info` does not. Rules in
the second and third tables also mark the run `incomplete`, so they exit `2` whatever their severity
says.

### Verdicts — the run completed and the fixtures failed

| Rule | Severity | Raised when |
| --- | --- | --- |
| `request-operation-unknown` | `error` | The case names an operation the contract does not declare, so there is no contract to check it against. |
| `request-method-mismatch` | `error` | The fixture request method is not the operation's method. |
| `request-path-mismatch` | `error` | The fixture request path does not fit the operation's path template. |
| `request-content-type-mismatch` | `error` | The fixture request content type is not the declared one, or is absent where one is declared. |
| `request-header-missing` | `error` | The contract marks a request header `required` and the fixture does not send it. The header name is in `evidence`. |
| `request-body-mismatch` | `error` | The fixture request body fails the declared request schema, is absent where one is declared, or is present where none is. Carries a JSON Pointer to the field. |
| `response-status-undeclared` | `error` | The contract declares no response with the status the fixture expects. `evidence` lists the statuses it does declare. |
| `response-content-type-mismatch` | `error` | The content type the fixture expects is not the one declared for that status. |
| `response-header-missing` | `error` | The contract marks a response header `required` and the fixture does not expect it. The header name is in `evidence`. |
| `response-body-mismatch` | `error` | The body the fixture expects fails the schema declared for that status, is absent where one is declared, or is present where none is. Carries a JSON Pointer. |
| `live-status-mismatch` | `error` | The in-process mock answered a different status than the fixture expects. |
| `live-content-type-mismatch` | `error` | The in-process mock answered a different content type than the fixture expects. |
| `live-header-mismatch` | `error` | The in-process mock answered without a response header the fixture expects, or with a different value for one. The header name is in `evidence`. |
| `live-body-mismatch` | `error` | The in-process mock answered a body the fixture does not expect, or one that fails the contract schema for the status it actually returned. Carries a JSON Pointer per differing field. |
| `duplicate-case-id` | `error` | Two fixture cases declare the same id, so their results cannot be told apart. |
| `output-destination-refused` | `error` | The `--out` destination is the same file as an input of the run, or could not be written at all -- `evidence` carries the inode clash or the error code. Nothing was written, the input is intact, and the report still goes to stdout. |
| `operation-without-fixture` | `warning` | A contract operation that no fixture case exercises. |
| `expected-application-error-verified` | `info` | A case expecting a `4xx` or `5xx` matched its documented contract and passed. Emitted so that the thing this tool most easily gets wrong is visible in the report when it goes right. |

### Evidence that could not be obtained

Each of these sets `incomplete`, so the run exits `2`.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `document-unreadable` | `error` | A document could not be opened, or is not a regular file. |
| `document-not-utf8` | `error` | A document is not valid UTF-8. Decided by the decoder, never inferred from decoded text. |
| `document-not-json` | `error` | A document is not valid JSON. |
| `document-invalid` | `error` | A document does not match its schema below. |
| `document-unknown-key` | `error` | A document declares a key its schema does not define. A typo is refused, never ignored. |
| `document-outside-root` | `error` | A declared document resolves outside the plan's directory. Refused unread; none of its content reaches the report. |
| `schema-dialect-unsupported` | `error` | A schema declares a `$schema`, or the contract declares a `jsonSchemaDialect`, outside the supported dialect. |
| `schema-keyword-unsupported` | `error` | A schema uses a keyword or construct outside the supported subset. |
| `schema-format-unsupported` | `error` | A schema declares a `format` this tool does not implement. |
| `schema-pattern-refused` | `error` | A `pattern` was refused rather than compiled. See [Patterns](#patterns). |
| `schema-ref-unresolved` | `error` | A `$ref` is remote, malformed, or names a schema `components.schemas` does not define. |
| `schema-ref-cycle` | `error` | A schema references itself. Recursive schemas are outside the subset. |
| `mock-not-declared` | `error` | Live calls were asked for and the plan declares no mock, so the live evidence was never obtained. |
| `mock-target-refused` | `error` | The declared mock is not a local in-process endpoint. No call was made and no socket was opened. |
| `live-route-missing` | `error` | Live calls were asked for and the mock has no route for the operation. |
| `no-cases-checked` | `error` | No fixture case reached a verdict. A `pass` on no evidence is not reachable. |

### Bounds

Each of these sets `incomplete`. A bound that was hit is never a smaller answer.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `limit-document-bytes-exceeded` | `error` | A document is larger than `maxDocumentBytes`. |
| `limit-operations-exceeded` | `error` | The contract declares more operations than `maxOperations`. |
| `limit-cases-exceeded` | `error` | The fixture document declares more cases than `maxCases`. |
| `limit-body-bytes-exceeded` | `error` | A body is larger than `maxBodyBytes`. |
| `limit-body-depth-exceeded` | `error` | A body nests deeper than `maxBodyDepth`. |
| `limit-schema-depth-exceeded` | `error` | A contract schema nests deeper than `maxSchemaDepth`. |
| `limit-findings-exceeded` | `error` | The run produced more findings than `maxFindings`; the report is partial and says so. |

## The plan document

```json
{
  "description": "optional",
  "contract": "contract.json",
  "fixtures": "fixtures.json",
  "call": false,
  "limits": { "maxCases": 200 },
  "mock": {
    "mode": "in-process",
    "baseUrl": "http://127.0.0.1:8080",
    "routes": [
      { "operationId": "createOrder", "caseId": "optional", "status": 201, "contentType": "application/json", "headers": {}, "body": {} }
    ]
  }
}
```

- `contract` and `fixtures` resolve against the plan's own directory, which is the root they are
  confined to. Both the root and the candidate go through `realpath`, so a symlink out of the tree
  is refused **and** a document genuinely inside a root reached through a symlink is still read.
- `call` asks for the optional in-process calls. `--call` and `--no-call` override it.
- `limits` configures the bounds below. A command-line flag overrides the plan. The plan file's own
  size bound is the one exception and is applied before the plan is parsed: a limit cannot be read
  out of a file the run has already refused to read.
- `mock.mode` accepts `in-process` and nothing else. A loopback socket transport is deliberately
  absent rather than unfinished.
- A route may narrow itself to one fixture case with `caseId`, so a stub can answer `201` to the
  success fixture and `422` to the validation fixture of the same operation. The narrower route
  wins; a route without a `caseId` answers every case the narrower ones did not claim.

Every key is closed at every level. An undeclared key raises `document-unknown-key` and the run
stops: a one-character typo must not quietly turn a real failure into a green run.

## The contract document

```json
{
  "contractVersion": "1",
  "title": "Orders API",
  "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema",
  "components": { "schemas": { "Order": { "type": "object" } } },
  "operations": [
    {
      "id": "createOrder",
      "description": "optional",
      "method": "POST",
      "path": "/orders/{orderId}",
      "request": {
        "contentType": "application/json",
        "headers": { "Idempotency-Key": { "required": true } },
        "body": { "$ref": "#/components/schemas/NewOrder" }
      },
      "responses": [
        {
          "status": 201,
          "contentType": "application/json",
          "headers": { "Location": { "required": true } },
          "body": { "$ref": "#/components/schemas/Order" }
        }
      ]
    }
  ]
}
```

- `jsonSchemaDialect` is optional and names the dialect every schema in the document is written
  in. It must be `https://json-schema.org/draft/2020-12/schema`; any other value raises
  `schema-dialect-unsupported` and stops the run before a fixture is checked, because it governs
  every schema in the document rather than one value. A per-schema `$schema` is checked the same
  way, where it stands. A declared key that is read only sometimes is the worst of both: this one
  decides the run.
- `method` is one of `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT`, `TRACE`.
- `path` may carry `{name}` template segments, which match any one non-empty segment.
- `status` is an integer from 100 to 599, and an operation may declare each status once.
- An operation with no `request` declares no request expectations at all; a fixture that sends a
  body to it raises `request-body-mismatch`, because an undocumented body is a mismatch rather than
  a default.
- Operation ids are unique. A contract must declare at least one operation: a contract with none
  can only produce a verdict on no evidence.

## The fixture document

```json
{
  "fixtureVersion": "1",
  "description": "optional",
  "cases": [
    {
      "id": "create-order-accepted",
      "operationId": "createOrder",
      "description": "optional",
      "call": true,
      "request": {
        "method": "POST",
        "path": "/orders",
        "contentType": "application/json",
        "headers": { "Idempotency-Key": "fixture-0001" },
        "body": { "sku": "EDL-2200" }
      },
      "expect": {
        "status": 201,
        "contentType": "application/json",
        "headers": { "Location": "/orders/1" },
        "body": { "id": "1" }
      }
    }
  ]
}
```

- `request.path` is a path only. A `?` or `#` in it is refused, because query parameters are outside
  what this tool checks and silently ignoring them would be worse than saying so.
- `call` on a case turns the optional live call on or off for that case alone; it defaults to on
  when the plan asked for calls.
- Header names are matched case-insensitively, as HTTP requires.

## Content types

The **essence** — `type/subtype`, case-folded — must be equal. Every parameter the contract declares
must be present and equal; a parameter the contract is silent about (a `charset` it does not
mention) is allowed through.

A structured suffix is not a licence to answer with a different media type:
`application/problem+json` does **not** satisfy a declared `application/json`, and the reverse is
equally a mismatch. The suffix tells a generic parser how to read the bytes; it does not make two
media types interchangeable in a contract.

## The supported schema subset

This is a purpose-built validator for a bounded subset of JSON Schema 2020-12 as it is used inside
an API contract. It is not a general validator and does not pretend to be one. The point of writing
it rather than delegating is that the boundary is **visible**: anything outside the subset is
reported and makes the run `incomplete`. It is never treated as satisfied.

**Dialect.** `$schema`, when present on a schema, must be
`https://json-schema.org/draft/2020-12/schema`, and so must the contract-level `jsonSchemaDialect`
that stands for all of them. Either one naming another dialect raises `schema-dialect-unsupported`:
the document-level key stops the run, the per-schema one leaves that value unchecked.

**Keywords implemented.** `$ref`, `$schema`, `additionalProperties` (boolean only), `const`,
`enum`, `exclusiveMaximum`, `exclusiveMinimum`, `format`, `items` (single schema),
`maxItems`, `maxLength`, `maximum`, `minItems`, `minLength`, `minimum`, `nullable`, `pattern`,
`properties`, `required`, `type`, `uniqueItems`.

**Annotations, recognised and deliberately without effect.** `title`, `description`, `example`,
`default`.

**Types.** `array`, `boolean`, `integer`, `null`, `number`, `object`, `string`. `type` may be a
string or an array of them. `integer` satisfies a declared `number`; the reverse does not.

**Formats implemented.** `date`, `date-time`, `email`, `ipv4`, `uri`, `uuid`. Dates are checked
against the calendar with arithmetic rather than a host date parser, so a leap day is judged the
same way on every machine. Any other `format` raises `schema-format-unsupported`.

**References.** Only `#/components/schemas/NAME`, resolved in the same contract document, with no
sibling constraint keywords. A remote reference, a pointer into anything else, and a recursive
schema are each reported.

**Outside the subset**, and reported by name rather than ignored: `allOf`, `anyOf`, `oneOf`, `not`,
`if` / `then` / `else`, `patternProperties`, `propertyNames`, `dependentRequired`,
`dependentSchemas`, `prefixItems`, `contains`, `unevaluatedProperties`, `discriminator`,
`multipleOf`, `$dynamicRef`, the array (tuple) form of `items`, the schema form of
`additionalProperties`, the boolean forms of `minimum`/`maximum`, and boolean schemas.

### Patterns

A contract is untrusted input, and `^(a+)+$` matched against a long string is a denial of service
with no network and no dependency in sight. A regular expression is also the one thing here that
cannot be stopped once it has started: the engine does not yield, so a deadline checked around the
call never fires during it. The bound therefore has to be decided **before** the match, and a
conservative superset is refused:

- a pattern longer than 200 characters;
- any lookaround, named group or other extended group form — `(` and `(?:` are the group forms
  accepted;
- any back reference, control escape (`\cA`) or Unicode property escape (`\p{...}`);
- any quantifier applied to a group that itself repeats or alternates — `(a+)+`, the textbook
  exponential;
- any two variable-length parts of one sequence whose boundary is not forced by a character neither
  of them can match. `\d+\d+` is refused and so is `.*.*x`; `[A-Z]+\d+` and `\w+@\w+\.\w+` are
  accepted, because the boundary between their repeating parts cannot move. A `?` counts as
  variable-length exactly as a `*` does;
- anything that does not compile as a Unicode regular expression.

The second-to-last rule is not decoration. `^\d+\d+...\d+$` — twenty adjacent `\d+`, no nesting,
no alternation, no group at all — ran for **109 seconds** against a forty-character subject before
this refusal existed. `test/pattern-bound.test.mjs` measures the bound rather than declaring it: it
drives each of these shapes through the real binary and kills the run if it has not answered.

A refusal raises `schema-pattern-refused` and makes the run `incomplete`. It is never a quiet pass.

## The optional live call

A "live call" is a function call into the route table the plan declares, in this process. There is
no socket, no hostname resolution and no request: the package imports no socket, HTTP, datagram,
resolver or TLS module, invokes no fetch primitive, and spawns no process.

The declared target is classified before anything is asked of it. `mode` must be `in-process`, the
`baseUrl` must be an absolute `http`/`https` URL carrying no credentials, and its host must be
loopback — the whole `127.0.0.0/8` block, `::1`, or `localhost`. `0.0.0.0` is deliberately not
loopback: it is a wildcard bind address, not a destination. Anything else raises
`mock-target-refused` before a call is constructed, and the run is `incomplete` because the live
evidence it asked for was never obtained.

What the live call compares:

- the mock's status against `expect.status`;
- its content type against `expect.contentType`, when the fixture declares one;
- its headers against `expect.headers`, when the fixture declares any: every header the fixture
  names must be answered, with an equal value. Names are matched case-insensitively and values
  exactly. Where the fixture names no headers there is nothing to compare against, and a
  contract-`required` header the fixture does not expect has already been reported against the
  fixture as `response-header-missing`;
- its body against `expect.body` field by field, when the fixture declares one — and against the
  contract schema for the status the mock actually returned, when the fixture does not.

`mock.routes[].headers` is what the mock answers with, and it is read: a route that omits a header
its fixture expects, or answers a different value, fails the run.

The fixture has already been checked against the contract, so an implementation that matches its
fixture matches the contract.

## Limits

| Name | Default | Cap | CLI flag |
| --- | ---: | ---: | --- |
| `maxDocumentBytes` | 1048576 | 8388608 | `--max-document-bytes` |
| `maxOperations` | 200 | 2000 | `--max-operations` |
| `maxCases` | 500 | 5000 | `--max-cases` |
| `maxBodyBytes` | 65536 | 1048576 | `--max-body-bytes` |
| `maxBodyDepth` | 16 | 64 | `--max-body-depth` |
| `maxSchemaDepth` | 24 | 64 | `--max-schema-depth` |
| `maxFindings` | 500 | 5000 | `--max-findings` |

A limit must be a positive integer no greater than its cap. A limit the configuration can spell past
is not a limit, so the caps are enforced in the plan and on the command line alike, and every bound
is tested from both sides.

Two structural bounds are not configurable: a `pattern` is at most 200 characters, and the
`diffPointers` walk used for the live body comparison stops at depth 64 — well above `maxBodyDepth`,
which has already refused anything that deep.

## The report

```json
{
  "schemaVersion": "1",
  "tool": "api-contract-fixture-runner",
  "status": "pass",
  "summary": {
    "checked": 4, "errors": 0, "warnings": 0, "info": 2,
    "cases": 4, "passed": 4, "failed": 0, "skipped": 0,
    "operations": 2, "exercised": 2, "liveCalls": 4
  },
  "findings": [],
  "run": {
    "contract": { "file": "contract.json", "title": "Orders API", "operations": 2 },
    "fixtures": { "file": "fixtures.json", "cases": 4 },
    "mock": { "declared": true, "mode": "in-process", "baseUrl": "http://127.0.0.1:8080", "called": true, "refused": false, "calls": 4 },
    "cases": [
      { "id": "create-order-accepted", "operationId": "createOrder", "verdict": "pass", "expectedStatus": 201, "responseClass": "success" }
    ]
  }
}
```

`run` is an additional top-level object carrying the captured result; the four required envelope
fields of the Edilec report contract v1 are present and unchanged.

`checked` counts cases that reached a verdict — `passed` plus `failed`. A case left unchecked by a
gap or a bound is `skipped`, and it is never counted as anything else.

`responseClass` is recorded for the reader and **never consulted for a verdict**. It is in the
report so that a human can see at a glance which cases are error cases, and in the code it is
computed after the verdict is decided.

Findings sort by `(location.file, location.pointer, ruleId, message, evidence)`, every comparison by
UTF-16 code unit. `location.file` is the path the plan declared, never an absolute host path.
`location.pointer` is a JSON Pointer into that document, with `~` and `/` escaped per RFC 6901.

Every untrusted string reaching output — ids, keys, media types, paths, pointers, messages and
evidence alike — has C0, DEL, the whole C1 range, `U+2028`, `U+2029` and the bidi formatting
characters removed, each replaced by a space so two values that differ only by a stripped character
do not silently become one.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every case reached a verdict and the policy was satisfied | the report |
| `1` | the run completed and the policy failed | the report |
| `2` | invalid usage or configuration | **empty** |
| `2` | evidence that could not be obtained | an `incomplete` report |

A consumer that pipes stdout must handle an empty stdout on exit 2. A configuration error means the
run never had a subject, so there is nothing to report about; an unreadable input means the run had
a subject and failed to obtain evidence about it, which is exactly what `incomplete` exists to say.

## What this tool cannot conclude

- **That your API is correct.** It compares fixtures with a contract, and optionally a local stub
  with those fixtures. It has never spoken to your implementation.
- **That a passing fixture set is complete.** `operation-without-fixture` names operations nobody
  exercised, but nothing here can tell you that the cases you wrote are the cases that matter.
- **That a schema outside the subset is satisfied.** It says so instead, and the run is
  `incomplete`. "We did not check it" and "it is correct" are different answers.
- **Anything about query parameters, cookies, authentication, rate limits, pagination, streaming
  bodies, multipart bodies, or any body that is not JSON.** None of these is checked, and a fixture
  that tries to smuggle a query string into `request.path` is refused rather than half-checked.
- **Anything about response header values a contract could declare.** A contract says only whether
  a response header is `required`, so a fixture is checked for its presence and nothing more. Header
  *values* are compared only on the live path, where the fixture states one and the in-process mock
  answers one.
- **Anything about timing, ordering between cases, or state.** Each case is evaluated
  independently, and the mock has no memory between cases beyond the record of what it was asked.
- **That a refused pattern is unsatisfiable or dangerous.** The refusal is conservative: some
  perfectly safe patterns are refused, and that is reported as unchecked rather than guessed at.
- **That a run which exits 0 proves anything about production.** These are local checks over local
  documents.
