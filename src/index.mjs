/**
 * api-contract-fixture-runner
 *
 * Checks a set of API fixtures against a contract: the request each fixture
 * sends, the response it expects, and -- optionally -- what a local in-process
 * mock actually answers. Four properties are structural rather than incidental.
 *
 * 1. **An error response is not a contract violation.** A fixture declaring a
 *    422 with the error body the contract documents is a **pass**. Status,
 *    content type and body are three separate checks with three separate rules,
 *    and none of them consults the status *class*. Conflating "the response was
 *    an error" with "the contract was broken" is the classic bug in this shape
 *    of tool, and `test/acceptance.test.mjs` pins the opposite behaviour with
 *    literal assertions.
 * 2. **A call never leaves this machine.** The mock is a table in this process
 *    and a "call" is a function call. This package imports no socket, HTTP,
 *    datagram, resolver or TLS module, invokes no fetch primitive and spawns no
 *    process. A plan naming any other target is refused *before* a call is
 *    constructed, and the run is `incomplete` because the live evidence it
 *    asked for was never obtained.
 * 3. **Unknown is never a pass.** A schema keyword, dialect, format, pattern or
 *    reference outside the supported subset leaves the value unchecked, and an
 *    unchecked value makes the case unchecked and the run `incomplete`. So does
 *    a bound that stopped the run short, a document that could not be read, and
 *    a run that reached a verdict on nothing. `pass` with `checked: 0` is not
 *    reachable.
 * 4. **Nothing is ever written over an input.** The optional `--out` copy of
 *    the report is refused when its destination is the same *inode* as any
 *    document the run read. A real-path comparison would not catch this: a hard
 *    link has no target to resolve, so two names for one file resolve to two
 *    different real paths and the comparison passes. Which documents the run
 *    read is only established by reading them, so the destination is settled
 *    twice -- once before the plan is opened and once more immediately before
 *    the copy is written, where stdout is still empty. Every refusal is
 *    therefore the one shape: exit 2, an empty stdout, nothing written.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import {
  applyLimits,
  mediaTypeMatches,
  pathMatches,
  validateContract,
  validateFixtures,
  validatePlan,
} from './documents.mjs'
import { DestinationError, assertWritableDestination } from './destination.mjs'
import { classifyTarget, createInProcessMock } from './mock.mjs'
import { INCOMPLETE_RULES, compareFindings, createFinding, sortFindings } from './rules.mjs'
import { SUPPORTED_DIALECTS, isRecord, jsonEqual, validateValue } from './schema.mjs'
import { decodeUtf8, describeComparison, describeValue, exceedsDepth, jsonByteLength, parseFailureDetail, pointerAppend, sanitize } from './text.mjs'

export const TOOL_ID = 'api-contract-fixture-runner'
export const REPORT_SCHEMA_VERSION = '1'

const RUN_OPTION_KEYS = Object.freeze(['baseDir', 'call', 'label', 'limits', 'opened'])
const FILE_OPTION_KEYS = Object.freeze(['call', 'label', 'limits', 'out', 'outRoot'])

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` is not confinement: a symbolic link planted beside the plan
 * resolves out of the tree without ever spelling a traversal. Both sides of
 * this comparison have been through `realpath` before they arrive -- comparing
 * a real root against an unresolved candidate is the over-correction, and it
 * refuses a document that genuinely is inside a root reached through a symlink.
 * A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function createCollector(label) {
  return { label, rows: [], incomplete: false }
}

/**
 * Record one finding row.
 *
 * The `incomplete` flag is set here, from one list, rather than at each call
 * site. A flag scattered across forty sites is a flag that will be missing from
 * one of them; from here, every rule that means "evidence was not obtained"
 * raises it, and `test/incomplete-backstop.test.mjs` pins the consequence.
 */
function record(collector, row) {
  if (INCOMPLETE_RULES.includes(row.ruleId)) collector.incomplete = true
  collector.rows.push({ file: collector.label, ...row })
}

function emptyCounts() {
  return { cases: 0, checked: 0, passed: 0, failed: 0, skipped: 0, operations: 0, exercised: 0, liveCalls: 0 }
}

function emptyRun() {
  return {
    contract: null,
    fixtures: null,
    mock: null,
    cases: [],
  }
}

function buildReport(collector, counts, run, limits) {
  let findings = sortFindings(collector.rows.map(createFinding))
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(
      createFinding({
        file: collector.label,
        pointer: '/',
        ruleId: 'limit-findings-exceeded',
        message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} of them are not in this report.`,
        suggestion: 'Raise limits.maxFindings or split the fixture set, then re-run; this report is partial.',
      }),
    )
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = collector.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      cases: counts.cases,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      operations: counts.operations,
      exercised: counts.exercised,
      liveCalls: counts.liveCalls,
    },
    findings,
    run,
  }
}

/** A report that carries the reason a run could not be evaluated. */
function haltedReport(label, limits, rows) {
  const collector = createCollector(label)
  for (const row of rows) record(collector, row)
  record(collector, {
    pointer: '/cases',
    ruleId: 'no-cases-checked',
    message: 'No fixture case reached a verdict, so this run checked nothing. A report with no evidence in it is not a passing report.',
  })
  return buildReport(collector, emptyCounts(), emptyRun(), limits)
}

/* ------------------------------------------------------------------ reading a document */

/**
 * Read one JSON document declared by the plan.
 *
 * Containment is decided on the real path of both the root and the candidate,
 * the bytes are decoded with the same strict decoder as the plan itself, and
 * every failure is reported by the name the plan used rather than by a host
 * path -- `location.file` is never absolute.
 *
 * The real path of every document that got past containment is recorded in
 * `opened`, which is what the `--out` destination is settled against before
 * the copy is written. It is recorded *before* the file is opened, so a
 * document that turned out to be unreadable, too large, not UTF-8 or not JSON
 * is protected as well: the run failed to read it, which is not the same as
 * not needing it.
 */
async function readDocument(collector, root, declared, limits, opened) {
  const label = sanitize(declared, 200)
  const absolute = resolve(root, declared)

  let real
  try {
    real = await realpath(absolute)
  } catch (error) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-unreadable',
      message: `This document could not be resolved: ${error.code ?? 'unknown error'}.`,
      suggestion: 'Check the path the plan declares and its permissions.',
    })
    return null
  }

  if (!isInside(root, real)) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-outside-root',
      message: 'This document resolves outside the plan directory, so it was refused unread and none of its content reaches this report.',
      suggestion: 'Move the document inside the plan directory, or run the plan from the directory that contains it.',
    })
    return null
  }

  opened.add(real)

  let info
  try {
    info = await stat(real)
  } catch (error) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-unreadable',
      message: `This document could not be read: ${error.code ?? 'unknown error'}.`,
    })
    return null
  }

  if (!info.isFile()) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-unreadable',
      message: 'This path is not a regular file.',
    })
    return null
  }
  if (info.size > limits.maxDocumentBytes) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'limit-document-bytes-exceeded',
      message: `This document is ${info.size} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not parsed.`,
      suggestion: 'Raise limits.maxDocumentBytes, or split the document.',
    })
    return null
  }

  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-unreadable',
      message: `This document could not be read: ${error.code ?? 'unknown error'}.`,
    })
    return null
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-not-utf8',
      message: 'This document is not valid UTF-8, so it was not parsed.',
      suggestion: 'Re-encode the document as UTF-8.',
    })
    return null
  }

  try {
    return { label, value: JSON.parse(decoded.text) }
  } catch (error) {
    record(collector, {
      file: label,
      pointer: '/',
      ruleId: 'document-not-json',
      message: `This document is not valid JSON: ${sanitize(parseFailureDetail(error), 160)}.`,
      suggestion: 'Validate the document with a JSON parser before re-running.',
    })
    return null
  }
}

/** Turn a shape validator's rows into findings attributed to one document. */
function recordShape(collector, label, result) {
  for (const row of result.unknown) {
    record(collector, { file: label, pointer: row.pointer, ruleId: 'document-unknown-key', message: row.message, evidence: row.evidence })
  }
  for (const row of result.errors) {
    record(collector, { file: label, pointer: row.pointer, ruleId: 'document-invalid', message: row.message, evidence: row.evidence })
  }
}

/* ------------------------------------------------------------------ comparing values */

/**
 * Every leaf at which two JSON values differ, as JSON Pointers.
 *
 * Used for the live comparison, where the fixture states the exact response it
 * expects. A single "the bodies differ" would be true and useless; a reader
 * needs the field.
 */
export function diffPointers(expected, actual, base = '', out = [], depth = 0) {
  if (depth > 64) return out
  if (jsonEqual(expected, actual)) return out

  const bothArrays = Array.isArray(expected) && Array.isArray(actual)
  const bothObjects = isRecord(expected) && isRecord(actual)

  if (bothArrays) {
    const length = Math.max(expected.length, actual.length)
    for (let index = 0; index < length; index += 1) {
      if (index >= expected.length) {
        out.push({ pointer: pointerAppend(base, String(index)), expected: undefined, actual: actual[index] })
      } else if (index >= actual.length) {
        out.push({ pointer: pointerAppend(base, String(index)), expected: expected[index], actual: undefined })
      } else {
        diffPointers(expected[index], actual[index], pointerAppend(base, String(index)), out, depth + 1)
      }
    }
    return out
  }

  if (bothObjects) {
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(actual, key)) {
        out.push({ pointer: pointerAppend(base, key), expected: expected[key], actual: undefined })
      } else {
        diffPointers(expected[key], actual[key], pointerAppend(base, key), out, depth + 1)
      }
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key)) {
        out.push({ pointer: pointerAppend(base, key), expected: undefined, actual: actual[key] })
      }
    }
    return out
  }

  out.push({ pointer: base === '' ? '/' : base, expected, actual })
  return out
}

/** The class of a status code, recorded for the reader and never consulted for a verdict. */
export function responseClassOf(status) {
  if (status < 200) return 'informational'
  if (status < 300) return 'success'
  if (status < 400) return 'redirect'
  if (status < 500) return 'client-error'
  return 'server-error'
}

function headerNames(headers) {
  const lowered = new Map()
  if (isRecord(headers)) {
    for (const name of Object.keys(headers)) lowered.set(name.toLowerCase(), headers[name])
  }
  return lowered
}

/* ------------------------------------------------------------------ the run */

/**
 * Check a parsed plan.
 *
 * `baseDir` is the directory the plan's document paths resolve against, and the
 * root every one of them is confined to.
 */
export async function runPlan(rawPlan, options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!RUN_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  if (typeof options.baseDir !== 'string' || options.baseDir === '') {
    throw new TypeError('A baseDir is required so the plan\'s document paths can be resolved and confined')
  }
  let limits = applyLimits(options.limits ?? {})
  const label = sanitize(options.label ?? 'plan.json', 200)

  const collector = createCollector(label)
  const counts = emptyCounts()
  const run = emptyRun()
  const opened = options.opened instanceof Set ? options.opened : new Set()

  const planShape = validatePlan(rawPlan)
  recordShape(collector, label, planShape)
  if (!planShape.ok || planShape.unknown.length > 0) {
    return haltedReport(label, limits, collector.rows)
  }

  /**
   * The plan may configure limits, and a command-line flag overrides it.
   *
   * This merge is the difference between a documented key and a decorative one.
   * The values were validated with the rest of the plan above, so nothing here
   * can throw. The plan file's *own* size bound is the one exception and is
   * necessarily applied before this point: a limit cannot be read out of a file
   * the run has already refused to read.
   */
  limits = applyLimits({ ...(isRecord(rawPlan.limits) ? rawPlan.limits : {}), ...(options.limits ?? {}) })

  let root
  try {
    root = await realpath(options.baseDir)
  } catch {
    root = resolve(options.baseDir)
  }

  const contractDocument = await readDocument(collector, root, rawPlan.contract, limits, opened)
  const fixturesDocument = await readDocument(collector, root, rawPlan.fixtures, limits, opened)
  if (contractDocument === null || fixturesDocument === null) {
    return haltedReport(label, limits, collector.rows)
  }

  const contractShape = validateContract(contractDocument.value, limits)
  if (contractShape.tooManyOperations !== undefined) {
    record(collector, {
      file: contractDocument.label,
      pointer: '/operations',
      ruleId: 'limit-operations-exceeded',
      message: `The contract declares ${contractShape.tooManyOperations} operations, above the maxOperations limit of ${limits.maxOperations}; none of them were checked.`,
      suggestion: 'Raise limits.maxOperations, or split the contract.',
    })
    return haltedReport(label, limits, collector.rows)
  }
  recordShape(collector, contractDocument.label, contractShape)

  const fixturesShape = validateFixtures(fixturesDocument.value, limits)
  if (fixturesShape.tooManyCases !== undefined) {
    record(collector, {
      file: fixturesDocument.label,
      pointer: '/cases',
      ruleId: 'limit-cases-exceeded',
      message: `The fixture document declares ${fixturesShape.tooManyCases} cases, above the maxCases limit of ${limits.maxCases}; none of them were checked.`,
      suggestion: 'Raise limits.maxCases, or split the fixture document.',
    })
    return haltedReport(label, limits, collector.rows)
  }
  recordShape(collector, fixturesDocument.label, fixturesShape)

  if (!contractShape.ok || !fixturesShape.ok || contractShape.unknown.length > 0 || fixturesShape.unknown.length > 0) {
    return haltedReport(label, limits, collector.rows)
  }

  const contract = contractDocument.value

  /**
   * The dialect the contract declares for its own schemas.
   *
   * A key a document may declare and the tool never reads is worse than a key
   * it refuses: `document-unknown-key` catches the typo, and a *declared* key
   * that is quietly dropped lets a contract assert a dialect this validator
   * does not implement and still reach a clean pass. It governs every schema in
   * the document, so an unsupported one stops the run here rather than leaving
   * a gap per value -- nothing in the document was checked against it.
   */
  if (Object.hasOwn(contract, 'jsonSchemaDialect') && !SUPPORTED_DIALECTS.includes(contract.jsonSchemaDialect)) {
    record(collector, {
      file: contractDocument.label,
      pointer: '/jsonSchemaDialect',
      ruleId: 'schema-dialect-unsupported',
      message: `This tool implements a bounded subset of ${SUPPORTED_DIALECTS[0]} only, and this contract declares that its schemas are written in another dialect, so none of them were applied.`,
      evidence: describeValue(contract.jsonSchemaDialect, 80),
      suggestion: `Declare "jsonSchemaDialect": "${SUPPORTED_DIALECTS[0]}", or remove the key.`,
    })
    return haltedReport(label, limits, collector.rows)
  }

  const fixtures = fixturesDocument.value
  const components = isRecord(contract.components?.schemas) ? contract.components.schemas : {}

  run.contract = {
    file: contractDocument.label,
    title: typeof contract.title === 'string' ? sanitize(contract.title, 120) : null,
    operations: contract.operations.length,
  }
  run.fixtures = { file: fixturesDocument.label, cases: fixtures.cases.length }
  counts.operations = contract.operations.length
  counts.cases = fixtures.cases.length

  /* ---- the mock, classified before anything is ever asked of it ---- */

  const planCall = options.call ?? rawPlan.call ?? false
  let mock = null
  let mockRefused = false
  if (planCall) {
    if (!Object.hasOwn(rawPlan, 'mock')) {
      record(collector, {
        pointer: '/mock',
        ruleId: 'mock-not-declared',
        message: 'The plan asked for live calls and declares no mock, so the live evidence it asked for was never obtained.',
        suggestion: 'Declare an in-process mock, or set "call": false and check the fixtures against the contract alone.',
      })
      mockRefused = true
    } else {
      const target = classifyTarget(rawPlan.mock)
      if (!target.ok) {
        record(collector, {
          pointer: '/mock/baseUrl',
          ruleId: 'mock-target-refused',
          message: `No call was made and no socket was opened: ${target.reason}. This tool only ever calls an in-process mock on this machine.`,
          evidence: describeValue(rawPlan.mock.baseUrl, 80),
          suggestion: 'Point the plan at an in-process mock on a loopback address, or set "call": false.',
        })
        mockRefused = true
      } else {
        mock = createInProcessMock(rawPlan.mock)
      }
    }
  }
  run.mock = Object.hasOwn(rawPlan, 'mock')
    ? {
        declared: true,
        mode: sanitize(rawPlan.mock?.mode ?? '', 40),
        baseUrl: sanitize(rawPlan.mock?.baseUrl ?? '', 120),
        called: mock !== null,
        refused: mockRefused,
        calls: 0,
      }
    : { declared: false, mode: null, baseUrl: null, called: false, refused: mockRefused, calls: 0 }

  /* ---- every case ---- */

  const operations = new Map()
  for (const operation of contract.operations) operations.set(operation.id, operation)
  const exercised = new Set()
  const seenCaseIds = new Set()

  for (let index = 0; index < fixtures.cases.length; index += 1) {
    const fixture = fixtures.cases[index]
    const base = `/cases/${index}`
    const outcome = { errors: 0, gaps: 0 }
    const file = fixturesDocument.label

    const emit = (row) => {
      record(collector, { file, ...row })
      outcome.errors += 1
    }
    const emitGap = (row) => {
      record(collector, { file, ...row })
      outcome.gaps += 1
    }

    if (seenCaseIds.has(fixture.id)) {
      emit({
        pointer: pointerAppend(base, 'id'),
        ruleId: 'duplicate-case-id',
        message: 'Two fixture cases declare the same id, so a report reader cannot tell their results apart.',
        evidence: sanitize(fixture.id, 60),
        suggestion: 'Give every case a distinct id.',
      })
    }
    seenCaseIds.add(fixture.id)

    const operation = operations.get(fixture.operationId)
    if (operation === undefined) {
      emit({
        pointer: pointerAppend(base, 'operationId'),
        ruleId: 'request-operation-unknown',
        message: 'This case names an operation the contract does not declare, so there is no contract to check it against.',
        evidence: sanitize(fixture.operationId, 60),
        suggestion: 'Correct the operationId, or add the operation to the contract.',
      })
    } else {
      exercised.add(operation.id)
      checkRequest(fixture, operation, base, components, limits, emit, emitGap)
      checkExpectation(fixture, operation, base, components, limits, emit, emitGap)
      if (mock !== null && (fixture.call ?? true)) {
        counts.liveCalls += checkLiveCall(fixture, operation, base, components, limits, mock, emit, emitGap)
      }
    }

    const verdict = outcome.gaps > 0 ? 'skipped' : outcome.errors > 0 ? 'fail' : 'pass'
    if (verdict === 'skipped') counts.skipped += 1
    else {
      counts.checked += 1
      if (verdict === 'pass') counts.passed += 1
      else counts.failed += 1
    }

    const expectedStatus = Number.isInteger(fixture.expect?.status) ? fixture.expect.status : null
    if (verdict === 'pass' && expectedStatus !== null && expectedStatus >= 400) {
      record(collector, {
        file,
        pointer: base,
        ruleId: 'expected-application-error-verified',
        message: `This case expects the documented ${expectedStatus} application error and it matches the contract, so it passes. An error response is not a contract violation.`,
        evidence: sanitize(fixture.id, 60),
      })
    }

    run.cases.push({
      id: sanitize(fixture.id, 80),
      operationId: sanitize(fixture.operationId, 80),
      verdict,
      expectedStatus,
      responseClass: expectedStatus === null ? null : responseClassOf(expectedStatus),
    })
  }

  if (mock !== null) run.mock.calls = mock.calls.length
  counts.exercised = exercised.size

  for (const operation of contract.operations) {
    if (exercised.has(operation.id)) continue
    record(collector, {
      file: contractDocument.label,
      pointer: '/operations',
      ruleId: 'operation-without-fixture',
      message: `Operation "${sanitize(operation.id, 60)}" (${sanitize(operation.method, 10)} ${sanitize(operation.path, 80)}) is declared in the contract and no fixture case exercises it.`,
      suggestion: 'Add a fixture case for the operation, or remove it from the contract.',
    })
  }

  if (counts.checked === 0) {
    record(collector, {
      pointer: '/cases',
      ruleId: 'no-cases-checked',
      message: 'No fixture case reached a verdict, so this run checked nothing. A report with no evidence in it is not a passing report.',
      suggestion: 'Add fixture cases, or resolve the findings that left every case unchecked.',
    })
  }

  return buildReport(collector, counts, run, limits)
}

/* ------------------------------------------------------------------ the three checks */

function boundBody(value, pointer, limits, emitGap, what) {
  const bytes = jsonByteLength(value)
  if (bytes === null) {
    emitGap({
      pointer,
      ruleId: 'document-invalid',
      message: `The ${what} could not be encoded as JSON, so it was not checked.`,
    })
    return false
  }
  if (bytes > limits.maxBodyBytes) {
    emitGap({
      pointer,
      ruleId: 'limit-body-bytes-exceeded',
      message: `The ${what} is ${bytes} bytes, above the maxBodyBytes limit of ${limits.maxBodyBytes}, so it was not checked.`,
      suggestion: 'Raise limits.maxBodyBytes, or shrink the fixture body.',
    })
    return false
  }
  if (exceedsDepth(value, limits.maxBodyDepth)) {
    emitGap({
      pointer,
      ruleId: 'limit-body-depth-exceeded',
      message: `The ${what} nests deeper than the maxBodyDepth limit of ${limits.maxBodyDepth}, so it was not checked.`,
      suggestion: 'Raise limits.maxBodyDepth, or flatten the fixture body.',
    })
    return false
  }
  return true
}

/**
 * Check a body against a schema and route the two kinds of result apart.
 *
 * An issue is a violation and carries the mismatch rule. A gap is an absence of
 * evidence: it keeps its own rule id, marks the run `incomplete`, and leaves
 * the case unchecked. Never the other way round -- a keyword this tool cannot
 * evaluate must not be reported as a body that matched.
 */
function checkBody(schema, value, valuePointer, components, limits, ruleId, emit, emitGap) {
  const { issues, gaps } = validateValue(schema, value, {
    components,
    valuePointer,
    schemaPath: '#',
    maxSchemaDepth: limits.maxSchemaDepth,
  })
  for (const gap of gaps) {
    emitGap({ pointer: gap.pointer, ruleId: gap.ruleId, message: gap.message, evidence: gap.evidence, suggestion: gap.suggestion })
  }
  for (const issue of issues) {
    emit({ pointer: issue.pointer, ruleId, message: issue.message, evidence: issue.evidence })
  }
}

function checkRequest(fixture, operation, base, components, limits, emit, emitGap) {
  const request = fixture.request
  const declared = isRecord(operation.request) ? operation.request : {}

  if (request.method !== operation.method) {
    emit({
      pointer: pointerAppend(base, 'request', 'method'),
      ruleId: 'request-method-mismatch',
      message: `The contract declares ${sanitize(operation.method, 10)} for this operation and the fixture sends ${sanitize(request.method, 10)}.`,
      evidence: sanitize(`${request.method} ${request.path}`, 80),
    })
  }
  if (!pathMatches(operation.path, request.path)) {
    emit({
      pointer: pointerAppend(base, 'request', 'path'),
      ruleId: 'request-path-mismatch',
      message: `The fixture path does not fit the contract path template ${sanitize(operation.path, 80)}.`,
      evidence: sanitize(request.path, 80),
    })
  }

  if (Object.hasOwn(declared, 'contentType')) {
    if (!Object.hasOwn(request, 'contentType')) {
      emit({
        pointer: pointerAppend(base, 'request', 'contentType'),
        ruleId: 'request-content-type-mismatch',
        message: `The contract declares a request content type of ${sanitize(declared.contentType, 60)} and the fixture declares none.`,
      })
    } else if (!mediaTypeMatches(declared.contentType, request.contentType)) {
      emit({
        pointer: pointerAppend(base, 'request', 'contentType'),
        ruleId: 'request-content-type-mismatch',
        message: `The contract declares a request content type of ${sanitize(declared.contentType, 60)}.`,
        evidence: sanitize(request.contentType, 60),
      })
    }
  }

  const sent = headerNames(request.headers)
  const declaredHeaders = isRecord(declared.headers) ? declared.headers : {}
  for (const name of Object.keys(declaredHeaders)) {
    if (declaredHeaders[name]?.required !== true) continue
    if (sent.has(name.toLowerCase())) continue
    emit({
      pointer: pointerAppend(base, 'request', 'headers'),
      ruleId: 'request-header-missing',
      message: `The contract requires this request to carry a header the fixture does not send (operation "${sanitize(operation.id, 60)}").`,
      evidence: sanitize(name, 80),
      suggestion: 'Add the header to the fixture request, or make it optional in the contract.',
    })
  }

  const bodyPointer = pointerAppend(base, 'request', 'body')
  if (Object.hasOwn(declared, 'body')) {
    if (!Object.hasOwn(request, 'body')) {
      emit({
        pointer: bodyPointer,
        ruleId: 'request-body-mismatch',
        message: 'The contract declares a request body for this operation and the fixture sends none.',
      })
    } else if (boundBody(request.body, bodyPointer, limits, emitGap, 'fixture request body')) {
      checkBody(declared.body, request.body, bodyPointer, components, limits, 'request-body-mismatch', emit, emitGap)
    }
  } else if (Object.hasOwn(request, 'body')) {
    emit({
      pointer: bodyPointer,
      ruleId: 'request-body-mismatch',
      message: 'The fixture sends a request body and the contract documents none for this operation.',
      evidence: describeValue(request.body, 60),
    })
  }
}

/**
 * Check the response a fixture *expects* against the contract.
 *
 * The status class is never consulted. A 422 the contract documents is as
 * ordinary here as a 200: it is looked up, its content type is compared, and
 * its body is validated against the schema declared for that status. That is
 * the whole of it, and it is why an expected application error can pass.
 */
function checkExpectation(fixture, operation, base, components, limits, emit, emitGap) {
  const expect = fixture.expect
  const declared = operation.responses.find((response) => response.status === expect.status)

  if (declared === undefined) {
    const statuses = operation.responses
      .map((response) => response.status)
      .filter((status) => Number.isInteger(status))
      .sort((left, right) => left - right)
    emit({
      pointer: pointerAppend(base, 'expect', 'status'),
      ruleId: 'response-status-undeclared',
      message: `The contract declares no ${expect.status} response for this operation, so a fixture expecting one is documenting behaviour the contract does not.`,
      evidence: `declared: ${statuses.join(', ')}`,
      suggestion: 'Document the status in the contract, or correct the fixture.',
    })
    return
  }

  if (Object.hasOwn(declared, 'contentType')) {
    if (!Object.hasOwn(expect, 'contentType')) {
      emit({
        pointer: pointerAppend(base, 'expect', 'contentType'),
        ruleId: 'response-content-type-mismatch',
        message: `The contract declares a ${declared.status} content type of ${sanitize(declared.contentType, 60)} and the fixture expects none.`,
      })
    } else if (!mediaTypeMatches(declared.contentType, expect.contentType)) {
      emit({
        pointer: pointerAppend(base, 'expect', 'contentType'),
        ruleId: 'response-content-type-mismatch',
        message: `The contract declares a ${declared.status} content type of ${sanitize(declared.contentType, 60)}.`,
        evidence: sanitize(expect.contentType, 60),
      })
    }
  }

  const present = headerNames(expect.headers)
  const declaredHeaders = isRecord(declared.headers) ? declared.headers : {}
  for (const name of Object.keys(declaredHeaders)) {
    if (declaredHeaders[name]?.required !== true) continue
    if (present.has(name.toLowerCase())) continue
    emit({
      pointer: pointerAppend(base, 'expect', 'headers'),
      ruleId: 'response-header-missing',
      message: `The contract requires the ${declared.status} response to carry a header this fixture does not expect (operation "${sanitize(operation.id, 60)}").`,
      evidence: sanitize(name, 80),
      suggestion: 'Add the header to the fixture expectation, or make it optional in the contract.',
    })
  }

  const bodyPointer = pointerAppend(base, 'expect', 'body')
  if (Object.hasOwn(declared, 'body')) {
    if (!Object.hasOwn(expect, 'body')) {
      emit({
        pointer: bodyPointer,
        ruleId: 'response-body-mismatch',
        message: `The contract declares a ${declared.status} response body and the fixture expects none.`,
      })
    } else if (boundBody(expect.body, bodyPointer, limits, emitGap, 'fixture expected body')) {
      checkBody(declared.body, expect.body, bodyPointer, components, limits, 'response-body-mismatch', emit, emitGap)
    }
  } else if (Object.hasOwn(expect, 'body')) {
    emit({
      pointer: bodyPointer,
      ruleId: 'response-body-mismatch',
      message: `The fixture expects a ${declared.status} response body and the contract documents none.`,
      evidence: describeValue(expect.body, 60),
    })
  }
}

/**
 * Ask the in-process mock, and compare what it said with what the fixture says.
 *
 * The fixture has already been checked against the contract above, so an
 * implementation that matches its fixture matches the contract. Where the
 * fixture states no body, the mock's body is checked against the contract
 * schema for the status the mock actually returned -- otherwise the live call
 * would confirm nothing about the payload.
 *
 * Returns the number of calls made, which is zero when the route table has no
 * answer for the operation.
 */
function checkLiveCall(fixture, operation, base, components, limits, mock, emit, emitGap) {
  const actual = mock.respond(operation.id, fixture.id)
  if (actual === null) {
    emitGap({
      pointer: pointerAppend(base, 'operationId'),
      ruleId: 'live-route-missing',
      message: 'The plan asked for a live call and the in-process mock declares no route for this operation, so the live evidence was never obtained.',
      evidence: sanitize(operation.id, 60),
      suggestion: 'Add a route for the operation to the mock, or set "call": false on the case.',
    })
    return 0
  }

  if (actual.status !== fixture.expect.status) {
    emit({
      pointer: pointerAppend(base, 'expect', 'status'),
      ruleId: 'live-status-mismatch',
      message: `The fixture expects ${fixture.expect.status} and the in-process mock answered ${actual.status}.`,
      evidence: `mock route for "${sanitize(operation.id, 50)}"`,
    })
  }

  if (Object.hasOwn(fixture.expect, 'contentType')) {
    const answered = actual.contentType
    if (answered === null) {
      emit({
        pointer: pointerAppend(base, 'expect', 'contentType'),
        ruleId: 'live-content-type-mismatch',
        message: `The fixture expects ${sanitize(fixture.expect.contentType, 60)} and the in-process mock answered with no content type.`,
      })
    } else if (!mediaTypeMatches(fixture.expect.contentType, answered)) {
      emit({
        pointer: pointerAppend(base, 'expect', 'contentType'),
        ruleId: 'live-content-type-mismatch',
        message: `The fixture expects ${sanitize(fixture.expect.contentType, 60)} and the in-process mock answered ${sanitize(answered, 60)}.`,
      })
    }
  }

  /**
   * The headers the mock answered, against the ones the fixture expects.
   *
   * `mock.routes[].headers` is a key the plan may declare, so it is a key that
   * has to decide something: a stub that omits the `Location` the contract
   * marks `required`, or answers a different one, is exactly the disagreement
   * this run exists to find. Presence and value both, because a header whose
   * value is wrong is not a header that is there.
   *
   * Where the fixture expects no headers there is nothing to compare against --
   * a contract-required header the fixture does not expect has already been
   * reported as `response-header-missing` against the fixture itself.
   */
  if (Object.hasOwn(fixture.expect, 'headers')) {
    const answered = headerNames(actual.headers)
    for (const name of Object.keys(fixture.expect.headers)) {
      const value = answered.get(name.toLowerCase())
      if (value === undefined) {
        emit({
          pointer: pointerAppend(base, 'expect', 'headers'),
          ruleId: 'live-header-mismatch',
          message: 'The fixture expects a response header the in-process mock answered without.',
          evidence: sanitize(name, 80),
          suggestion: 'Add the header to the mock route, or stop expecting it in the fixture.',
        })
      } else if (value !== fixture.expect.headers[name]) {
        emit({
          pointer: pointerAppend(base, 'expect', 'headers'),
          ruleId: 'live-header-mismatch',
          message: `The in-process mock answered a different value for the "${sanitize(name, 40)}" header than the fixture expects.`,
          evidence: describeComparison(fixture.expect.headers[name], value),
        })
      }
    }
  }

  const bodyPointer = pointerAppend(base, 'expect', 'body')
  if (Object.hasOwn(fixture.expect, 'body')) {
    if (!actual.hasBody) {
      emit({
        pointer: bodyPointer,
        ruleId: 'live-body-mismatch',
        message: 'The fixture expects a response body and the in-process mock answered with none.',
      })
    } else if (boundBody(actual.body, bodyPointer, limits, emitGap, 'in-process mock response body')) {
      for (const difference of diffPointers(fixture.expect.body, actual.body, bodyPointer)) {
        emit({
          pointer: difference.pointer,
          ruleId: 'live-body-mismatch',
          message: 'The in-process mock answered with a value the fixture does not expect at this field.',
          evidence: describeComparison(difference.expected, difference.actual),
        })
      }
    }
    return 1
  }

  const declared = operation.responses.find((response) => response.status === actual.status)
  if (declared === undefined || !Object.hasOwn(declared, 'body')) {
    if (actual.hasBody && declared !== undefined) {
      emit({
        pointer: bodyPointer,
        ruleId: 'live-body-mismatch',
        message: `The in-process mock answered ${actual.status} with a body and the contract documents none for that status.`,
      })
    }
    return 1
  }
  if (!actual.hasBody) {
    emit({
      pointer: bodyPointer,
      ruleId: 'live-body-mismatch',
      message: `The contract declares a ${actual.status} response body and the in-process mock answered with none.`,
    })
  } else if (boundBody(actual.body, bodyPointer, limits, emitGap, 'in-process mock response body')) {
    checkBody(declared.body, actual.body, bodyPointer, components, limits, 'live-body-mismatch', emit, emitGap)
  }
  return 1
}

/* ------------------------------------------------------------------ file entry point */

/**
 * Read a plan file and check it.
 *
 * The plan file is decoded with the same strict decoder as every other
 * document: a tool that hardens its data path and leaves its own configuration
 * path lossy has hardened nothing.
 */
export async function runPlanFile(planPath, options = {}) {
  if (typeof planPath !== 'string' || planPath.trim() === '') throw new TypeError('A plan path is required')
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!FILE_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const limits = applyLimits(options.limits ?? {})
  const label = sanitize(options.label ?? planPath, 200)
  const absolute = resolve(planPath)

  /**
   * Every document this run resolved inside the plan's directory, by real path.
   *
   * This is the input set the `--out` destination has to be compared against,
   * and it is only known once the plan has been read: the plan names the
   * contract and the fixtures as relative paths a symbolic link may move.
   */
  const opened = new Set()

  /**
   * Where the `--out` copy may land, settled against the inputs known so far.
   *
   * This tool wrote its report through a symbolic link at the destination and
   * destroyed a file outside the working directory, exiting 0 with a "pass"
   * report on stdout. The three holes -- a link at the destination, a link in
   * its parent, an escape from the output root -- are documented one by one in
   * ./destination.mjs, and the fourth question, whether the destination is one
   * of the run's own inputs, is the reason this is called twice.
   *
   * A refused destination is configuration, so it throws rather than
   * reporting: the run was asked to write somewhere it must not write, so
   * nothing is written, stdout stays empty and the caller exits 2. That is the
   * shape whichever settling refuses, which is why the second one happens
   * before a single byte of the report has reached stdout.
   */
  const settleDestination = (inputs) => assertWritableDestination(options.out, {
    inputs,
    root: options.outRoot ?? process.cwd(),
    label: '--out',
  })

  /**
   * Settled the first time against the one input known this early: the plan.
   *
   * A destination that is a link, or that leaves the output root, or that is
   * the plan itself costs nothing here -- nothing read, nothing written, an
   * empty stdout -- and the run never starts.
   */
  if (options.out !== undefined) await settleDestination([absolute])

  /**
   * Settled a second time, now that the run knows what it read, and only then
   * written.
   *
   * Naming only the plan the first time is how this tool wrote its report over
   * the contract it had just checked. The contract and the fixture documents
   * are discovered by reading the plan, so a destination that turns out to be
   * one of them -- by path, or by a hard link, which shares no path with the
   * file it names -- can only be recognised here. Nothing has reached stdout
   * yet, so the refusal keeps the contract shape.
   */
  const finish = async (report) => {
    if (options.out === undefined) return report
    const destination = await settleDestination([absolute, ...opened])
    try {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, `${serializeReport(report)}\n`)
    } catch (error) {
      throw new DestinationError(
        `--out could not be written: ${error.code ?? 'unknown error'}. Nothing was written to stdout either, `
        + 'because a run that could not file the copy it was asked for has not done what it was asked; '
        + 're-run without --out for the report.',
      )
    }
    return report
  }

  const halt = (ruleId, message, suggestion) =>
    haltedReport(label, limits, [{ file: label, pointer: '/', ruleId, message, ...(suggestion === undefined ? {} : { suggestion }) }])
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    return finish(halt('document-unreadable', `The plan file could not be read: ${error.code ?? 'unknown error'}.`, 'Check the --plan path and its permissions.'))
  }
  if (!info.isFile()) {
    return finish(halt('document-unreadable', 'The plan path is not a regular file.', 'Pass the JSON plan file to --plan.'))
  }
  if (info.size > limits.maxDocumentBytes) {
    return finish(halt(
      'limit-document-bytes-exceeded',
      `The plan file is ${info.size} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not parsed.`,
      'Raise limits.maxDocumentBytes, or move the detail into the contract and fixture documents.',
    ))
  }

  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    return finish(halt('document-unreadable', `The plan file could not be read: ${error.code ?? 'unknown error'}.`))
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return finish(halt('document-not-utf8', 'The plan file is not valid UTF-8, so it was not parsed.', 'Re-encode the plan as UTF-8.'))
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return finish(halt('document-not-json', `The plan file is not valid JSON: ${sanitize(parseFailureDetail(error), 160)}.`, 'Validate the plan with a JSON parser before re-running.'))
  }

  let baseDir
  try {
    baseDir = await realpath(dirname(absolute))
  } catch {
    baseDir = dirname(absolute)
  }

  const report = await runPlan(parsed, {
    label,
    baseDir,
    opened,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.call === undefined ? {} : { call: options.call }),
  })
  return finish(report)
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

/** The JSON report, exactly as it goes to stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

const SEVERITY_WIDTH = 7

/**
 * The human summary. Every untrusted string in it was sanitised on the way into
 * the finding, so a document cannot forge a line here.
 */
export function formatReport(report) {
  const { summary, run } = report
  const mock =
    run.mock === null || !run.mock.declared
      ? 'none declared'
      : `${run.mock.mode} at ${run.mock.baseUrl}${run.mock.refused ? ' (refused, no call was made)' : ''}`
  const lines = [
    `${summary.checked} of ${summary.cases} fixture case(s) reached a verdict: ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `cases: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} not checked.`,
    `contract: ${summary.exercised} of ${summary.operations} operation(s) exercised by a fixture.`,
    `mock: ${mock}. ${summary.liveCalls} in-process call(s); no socket was opened and nothing left this machine.`,
  ]
  for (const finding of report.findings) {
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}${quoted}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { DEFAULT_LIMITS, HARD_LIMITS, LIMIT_NAMES, METHODS, applyLimits, mediaTypeMatches, parseMediaType, pathMatches, validateContract, validateFixtures, validatePlan } from './documents.mjs'
export { INCOMPLETE_RULES, RULE_SEVERITY, SEVERITY_DECIDES, SEVERITY_VALUES, compareFindings, createFinding, sortFindings } from './rules.mjs'
export { classifyTarget, createInProcessMock, isLoopbackHost } from './mock.mjs'
export {
  KNOWN_UNSUPPORTED_KEYWORDS,
  MAX_PATTERN_LENGTH,
  SUPPORTED_DIALECTS,
  SUPPORTED_FORMATS,
  SUPPORTED_KEYWORDS,
  SUPPORTED_TYPES,
  checkPattern,
  jsonEqual,
  matchesFormat,
  validateValue,
} from './schema.mjs'
export { STRIPPED_RANGES, byCodeUnit, decodeUtf8, isStripped, parseFailureDetail, sanitize } from './text.mjs'
