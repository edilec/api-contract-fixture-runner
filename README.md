# api-contract-fixture-runner

Check API fixtures against a contract: the request each fixture sends, the response it expects, and
— optionally — what a **local in-process mock** answers. Every body mismatch carries a JSON Pointer
to the field.

- **Repository:** [edilec/api-contract-fixture-runner](https://github.com/edilec/api-contract-fixture-runner)
- **Area:** API & Integration
- **License:** MIT
- **Dependencies:** none. Node built-ins only, Node >= 22.

## An error response is not a contract violation

A fixture that declares a `422` with the error body the contract documents is a **pass**. Not a
warning, not a failure for being a `4xx` — a pass, exit 0.

This is the bug this shape of tool is most prone to: conflating "the response was an error" with
"the contract was broken". Here, status, content type and body are three separate checks with three
separate rules, and not one of them consults the status *class*. An error response fails only when
it is **undeclared**, or when its content type or body is not what the contract says that status
carries.

```
INFO    fixtures.json/cases/1 expected-application-error-verified This case expects the documented
        422 application error and it matches the contract, so it passes. An error response is not a
        contract violation. -- create-order-quantity-rejected
```

The passing error case gets its own `info` finding, so the thing most easily got wrong is visible in
the report when it goes right. `test/acceptance.test.mjs` pins it by exit code.

## A call never leaves this machine

The optional live call is a function call into a route table declared in the plan. There is no
socket, no hostname resolution and no request: the package imports no socket, HTTP, datagram,
resolver or TLS module, invokes no fetch primitive, and spawns no process.

A plan naming anything but a loopback in-process endpoint — an external host, a non-HTTP scheme, a
URL carrying credentials — is **refused before a call is constructed**, and the run is reported
`incomplete`, because the live evidence it asked for was never obtained. It is never quietly
answered from the local table as though the remote host had replied.

`test/no-network.test.mjs` proves it the direct way: it opens a real HTTP listener on a real
loopback port, declares that exact port as the plan's mock, runs the whole check, and asserts the
listener saw **zero connections and zero requests**.

## Install

```sh
npm install api-contract-fixture-runner
```

Or run it from a checkout with no install at all:

```sh
node bin/api-contract-fixture-runner.mjs --plan examples/clean/plan.json
```

## Use

```sh
api-contract-fixture-runner --plan fixtures/orders.plan.json
api-contract-fixture-runner --plan fixtures/orders.plan.json --json
api-contract-fixture-runner --plan fixtures/orders.plan.json --call --out report.json
```

The JSON report goes to **stdout and nothing else**, so it pipes straight into a parser. The human
summary and every diagnostic go to **stderr**; `--json` silences the summary.

```
4 of 4 fixture case(s) reached a verdict: 0 error, 0 warning, 2 info, status pass.
cases: 4 passed, 0 failed, 0 not checked.
contract: 2 of 2 operation(s) exercised by a fixture.
mock: in-process at http://127.0.0.1:8080. 4 in-process call(s); no socket was opened and nothing left this machine.
```

The deliberately broken example collects one rule per case:

```
ERROR   fixtures.json/cases/0/expect/status response-status-undeclared The contract declares no 418
        response for this operation, so a fixture expecting one is documenting behaviour the
        contract does not. -- declared: 201
ERROR   fixtures.json/cases/1/expect/contentType response-content-type-mismatch The contract
        declares a 201 content type of application/json. -- application/xml
ERROR   fixtures.json/cases/2/expect/body/quantity response-body-mismatch Expected type integer and
        found string. -- "1"
ERROR   fixtures.json/cases/4/expect/body/id live-body-mismatch The in-process mock answered with a
        value the fixture does not expect at this field. -- expected "6f1c2a10-...", answered
        "11111111-..."
```

## The three documents

One **plan** names a **contract** and a **fixture set**, and optionally declares the in-process mock.

```json
{
  "contract": "contract.json",
  "fixtures": "fixtures.json",
  "call": true,
  "mock": {
    "mode": "in-process",
    "baseUrl": "http://127.0.0.1:8080",
    "routes": [
      { "operationId": "createOrder", "caseId": "create-order-accepted", "status": 201,
        "contentType": "application/json", "body": { "id": "1" } }
    ]
  }
}
```

The contract declares operations and, per status, a content type, required headers and a body
schema. The fixture set declares cases, each with the request it sends and the response it expects.
A route may narrow itself to one case with `caseId`, so a stub can answer `201` to the success
fixture and `422` to the validation fixture of the same operation.

Every key of all three documents is closed. An undeclared key is refused by name rather than
ignored, because a one-character typo that is quietly dropped turns a real failure into a green run:
`expct` must not disable the response check.

`contract` and `fixtures` resolve against the plan's directory and are confined to it. Both the root
and the candidate go through `realpath`, so a symlink out of the tree is refused unread **and** a
document genuinely inside a root reached through a symlink is still read. A false refusal is a bug
too.

The full schemas are in [`docs/contract-rules.md`](./docs/contract-rules.md), with the rule catalog,
the supported schema subset, and the limits.

## Nothing is ever written over an input, or anywhere it was not pointed

`--out` writes the same bytes stdout carried to a file, for archiving from CI. Every destination
below is refused, and a refusal is always the same shape: **nothing is written, stdout stays empty
and the exit code is 2**. A refused destination is a configuration error — the run was asked to
write somewhere it must not write — so there is no report about it to print.

| Refused | Why the obvious guard misses it |
| --- | --- |
| a **symbolic link at the destination** | `realpath` on the destination *resolves* the link, and resolving is the dangerous act, so it is refused on sight with `lstat` before anything is opened. A link whose target does not exist yet is the same hole: following it creates a new file outside the root. |
| a **symlinked parent directory** | a lexical prefix check passes for `root/link/report.json` where `link` leaves the root, so the parent is resolved and then compared. |
| a destination **outside the output root** | the working directory, unless `--out-root DIR` names another. A `..` segment does not widen it. |
| an **input of this run**, by path or hard link | the plan, and the contract and fixture documents it names. |
| a destination that **cannot be written at all** | a run that could not file the copy it was asked for has not done what it was asked, so it says the error code on stderr rather than printing a report that claims otherwise. |

The input comparison is on `dev` and `ino`, not on the real path. `realpath` resolves a symbolic
link, but a **hard link has no target**: two names for one inode resolve to two different real
paths, a real-path comparison sees two different files, and the run writes its report over its own
contract. `test/path-identity.test.mjs` asserts both halves — that the real paths genuinely differ,
and that the write was refused anyway.

Which files are inputs is the one question that cannot be answered before the run: the plan names
the contract and the fixture documents, and a plan has to be read to know what it names. So the
destination is settled **twice** — once before the plan is opened, against the plan alone, and once
more immediately before the copy is written, against every document the run resolved. The second
settling happens while stdout is still empty, which is what lets both refusals have one shape. The
real path of each document is recorded before it is opened, so one that turned out to be unreadable,
too large or unparseable is protected as well: failing to read a file is not the same as not having
needed it.

Destinations that must still work, pinned in `test/destination.test.mjs` with the same weight as the
refusals: a plain path, a subdirectory, a directory that does not exist yet (it is created), a
rewrite of the previous run's report, a directory reached through a symbolic link that stays inside
the root, and a path outside the working directory once `--out-root` names the root it belongs to. A
guard that refuses everything passes every data-loss test while making the tool useless.

## The bounded schema subset

There is no JSON Schema or OpenAPI dependency here, and no plan to add one. What exists is a
purpose-built validator for a declared subset of JSON Schema 2020-12 as it is used inside an API
contract — and the point of writing it rather than delegating is that its **boundary is visible**.

A keyword, dialect, format, construct, reference or pattern outside the subset is *reported*, the
value is left unchecked, the case is not counted as checked, and the run is `incomplete`. It is
never treated as satisfied, because "we did not check it" and "it is correct" are different answers
and only one of them is honest.

The dialect is `https://json-schema.org/draft/2020-12/schema` and nothing else — as a per-schema
`$schema`, or as the contract-level `jsonSchemaDialect` that stands for all of them. A contract
declaring another dialect is told so and the run is `incomplete`; it is not a key this tool accepts
and then ignores.

Implemented: `$ref` (local), `type` (including an array of types and `nullable`), `enum`, `const`,
`properties`, `required`, `additionalProperties: false`, `items`, `minItems`, `maxItems`,
`uniqueItems`, `minLength`, `maxLength`, `pattern`, `format` (`date`, `date-time`, `email`, `ipv4`,
`uri`, `uuid`), `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`.

Reported rather than ignored: `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`,
`patternProperties`, `prefixItems`, `discriminator`, `multipleOf`, recursive `$ref`, remote `$ref`,
tuple `items`, schema-valued `additionalProperties`, boolean schemas, any other dialect, any other
format.

A `pattern` is refused rather than compiled when it is over 200 characters, uses lookaround, a back
reference or a property escape, applies a quantifier to a group that itself repeats or alternates,
or puts two variable-length parts side by side with nothing between them to fix the boundary — a
contract is untrusted input, and `^(a+)+$` is a denial of service with no network in sight. So is
`^\d+\d+...\d+$`, which has no nesting in it at all and ran for 109 seconds against a
forty-character string before that last rule existed.

A regular expression cannot be stopped once it has started — the engine does not yield, so a
deadline checked around the call never fires during it — which is why the bound is a refusal
decided before the match rather than a timeout around it. `test/pattern-bound.test.mjs` measures it:
it drives each hostile shape through the real binary and fails if the run has not answered.
`[A-Z]+\d+` and `\w+@\w+\.\w+` are still compiled and applied. The refusal is conservative and is
reported as unchecked rather than guessed at.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every case reached a verdict and the policy was satisfied | the report |
| `1` | the run completed and the policy failed | the report |
| `2` | invalid usage or configuration, including any refused or unwritable `--out` destination | **empty** |
| `2` | evidence that could not be obtained | an `incomplete` report |

Unknown evidence is never a pass. `pass` with `checked: 0` is not reachable: a run that reached a
verdict on nothing emits `no-cases-checked` and exits 2.

## Determinism

Two runs over the same bytes produce byte-identical stdout. No wall clock, random source, locale,
environment variable or directory listing reaches the output. Findings sort by
`(location.file, location.pointer, ruleId, message, evidence)`, every comparison by UTF-16 code
unit, so `Z` precedes `a` and `a-b` precedes `a_b` on every machine.

That ordering is pinned by what the tool emits, not by a grep over its own source: each of the six
ordering sites is driven through the real binary with values whose collation order genuinely
disagrees with their code-unit order. The one site whose alphabet makes both orders identical is
proved equivalent by enumerating all 1640 ordered pairs of the real rule ids rather than left
unpinned.

Severity is pinned the same way. `test/severity-decides.test.mjs` and
`test/incomplete-severity.test.mjs` import nothing from `src`, hold no rule table, no severity map
and no parameterised expectation: every exit code, count and printed severity word is a literal
written at the assertion that uses it.

## Verify

```sh
npm run check
```

which runs `lint` (`node --check` over every file), `test` (`node --test`), the clean example, and
`npm pack --dry-run`. There is nothing to install first.

## Limits and non-goals

What this tool **cannot** conclude:

- **That your API is correct.** It compares fixtures with a contract, and optionally a local stub
  with those fixtures. It has never spoken to your implementation, and an exit 0 here says nothing
  about what a deployed service does.
- **That a passing fixture set is complete.** `operation-without-fixture` names operations nobody
  exercised. Nothing here can tell you the cases you wrote are the cases that matter.
- **That a schema outside the supported subset is satisfied.** It says so instead, and the run is
  `incomplete`.
- **Anything about query parameters, cookies, authentication, authorization, rate limits,
  pagination, streaming bodies, multipart bodies, or any body that is not JSON.** A fixture that
  tries to put a query string in `request.path` is refused rather than half-checked.
- **Anything about response header values a contract could declare.** A contract says only whether
  a header is `required`, so a fixture is checked for presence and nothing more. Values are
  compared only where two documents actually state one: `expect.headers` against what the
  in-process mock answers, name-insensitively and value-exactly.
- **Anything about timing, ordering between cases, or state.** Each case is evaluated
  independently.
- **That a refused pattern is dangerous.** The refusal is deliberately conservative, and some safe
  patterns are refused. That is reported as unchecked, never as passed.
- **That an OpenAPI document will work here unchanged.** The contract document is this tool's own
  bounded shape, not OpenAPI. Converting one is a separate job and is not attempted, because a
  half-understood conversion is exactly how an unchecked field comes to look checked.

## License

MIT. See [LICENSE](./LICENSE).
