/**
 * api-contract-fixture-runner -- the rules, and the one table that pins them.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and demoting one body-mismatch rule to a warning turns "the response this
 * fixture documents is not the one the contract declares" into a green build.
 *
 * So there is exactly one table, every finding takes its severity from it, and
 * an unknown rule id throws rather than defaulting. The table is the source of
 * truth -- it is not the test. `test/severity-decides.test.mjs` and
 * `test/incomplete-severity.test.mjs` drive real documents through the real
 * binary and state every expectation as an inline literal, because three
 * declarations agreeing with each other can be edited together and an exit code
 * cannot be edited at all.
 */

import { TEXT_LIMIT, byCodeUnit, sanitize } from './text.mjs'

export const RULE_SEVERITY = Object.freeze({
  'document-invalid': 'error',
  'document-not-json': 'error',
  'document-not-utf8': 'error',
  'document-outside-root': 'error',
  'document-unknown-key': 'error',
  'document-unreadable': 'error',
  'duplicate-case-id': 'error',
  'expected-application-error-verified': 'info',
  'limit-body-bytes-exceeded': 'error',
  'limit-body-depth-exceeded': 'error',
  'limit-cases-exceeded': 'error',
  'limit-document-bytes-exceeded': 'error',
  'limit-findings-exceeded': 'error',
  'limit-operations-exceeded': 'error',
  'limit-schema-depth-exceeded': 'error',
  'live-body-mismatch': 'error',
  'live-content-type-mismatch': 'error',
  'live-header-mismatch': 'error',
  'live-route-missing': 'error',
  'live-status-mismatch': 'error',
  'mock-not-declared': 'error',
  'mock-target-refused': 'error',
  'no-cases-checked': 'error',
  'operation-without-fixture': 'warning',
  'output-destination-refused': 'error',
  'request-body-mismatch': 'error',
  'request-content-type-mismatch': 'error',
  'request-header-missing': 'error',
  'request-method-mismatch': 'error',
  'request-operation-unknown': 'error',
  'request-path-mismatch': 'error',
  'response-body-mismatch': 'error',
  'response-content-type-mismatch': 'error',
  'response-header-missing': 'error',
  'response-status-undeclared': 'error',
  'schema-dialect-unsupported': 'error',
  'schema-format-unsupported': 'error',
  'schema-keyword-unsupported': 'error',
  'schema-pattern-refused': 'error',
  'schema-ref-cycle': 'error',
  'schema-ref-unresolved': 'error',
})

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

/**
 * The rules whose severity alone decides the verdict.
 *
 * Every other error rule also sets the `incomplete` flag, so it exits 2
 * whatever its severity says, and `test/incomplete-severity.test.mjs` pins
 * those by the counted errors and the printed severity word instead. These
 * sixteen have no second line of defence: severity is the whole of it, and
 * `test/severity-decides.test.mjs` drives each one through the binary and pins
 * status `fail` and exit code 1.
 */
export const SEVERITY_DECIDES = Object.freeze([
  'duplicate-case-id',
  'live-body-mismatch',
  'live-content-type-mismatch',
  'live-header-mismatch',
  'live-status-mismatch',
  'output-destination-refused',
  'request-body-mismatch',
  'request-content-type-mismatch',
  'request-header-missing',
  'request-method-mismatch',
  'request-operation-unknown',
  'request-path-mismatch',
  'response-body-mismatch',
  'response-content-type-mismatch',
  'response-header-missing',
  'response-status-undeclared',
])

/**
 * The rules that also set `incomplete`, so the run exits 2 whatever their
 * severity says. Demoting one of these still changes `summary.errors` and the
 * severity word printed on its line, and that is what pins them.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'document-invalid',
  'document-not-json',
  'document-not-utf8',
  'document-outside-root',
  'document-unknown-key',
  'document-unreadable',
  'limit-body-bytes-exceeded',
  'limit-body-depth-exceeded',
  'limit-cases-exceeded',
  'limit-document-bytes-exceeded',
  'limit-findings-exceeded',
  'limit-operations-exceeded',
  'limit-schema-depth-exceeded',
  'live-route-missing',
  'mock-not-declared',
  'mock-target-refused',
  'no-cases-checked',
  'schema-dialect-unsupported',
  'schema-format-unsupported',
  'schema-keyword-unsupported',
  'schema-pattern-refused',
  'schema-ref-cycle',
  'schema-ref-unresolved',
])

const MESSAGE_LIMIT = 400
const PATH_LIMIT = 200

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here -- the file label and the pointer as
 * much as the message and the evidence. A case id carrying a newline would
 * otherwise forge whole lines in the human report, and a report a reader cannot
 * trust line by line is worse than no report at all.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${sanitize(row.ruleId, 80)}" is not in RULE_SEVERITY; add it to the table and to docs/contract-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: sanitize(row.file, PATH_LIMIT), pointer: sanitize(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = sanitize(row.evidence, TEXT_LIMIT)
  if (row.suggestion !== undefined) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: file, pointer, ruleId, message, evidence.
 *
 * Every comparison is by code unit. The pointer is compared as the string it
 * is, so `/cases/10` precedes `/cases/2` -- unlovely, and deterministic, which
 * is the property that matters. Per-case outcomes are captured separately and
 * in declared order, in `run.cases`.
 */
export function compareFindings(left, right) {
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message) ||
    byCodeUnit(left.evidence ?? '', right.evidence ?? '')
  )
}

/** Findings in the documented order. The input array is not mutated. */
export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}
