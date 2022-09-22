import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { MAX_PATTERN_INPUT, checkPattern, validateValue } from '../src/schema.mjs'

/**
 * The pattern bound, measured rather than asserted.
 *
 * A regular expression is the one thing in this package that cannot be stopped
 * once it has started. The engine does not yield, so a deadline checked around
 * the call never fires during it and a budget "enforced" between operations
 * enforces nothing at all. The bound has to be decided *before* the match, by
 * refusing every shape the analyser in `src/schema.mjs` cannot vouch for.
 *
 * A refusal that is only declared is not a bound either, so this file measures
 * it. `^(\d+){20}$` written out as twenty adjacent `\d+` is not nested, does
 * not alternate, and contains no group at all -- and against a forty-character
 * subject it ran for **109 seconds** before this analyser refused it. Every
 * test here fails if the work does not finish inside the stated bound: the
 * in-process half by the clock, the end-to-end half by killing the child.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

/** The whole run, process start included, must finish inside this. */
const RUN_BOUND_MS = 5000

/** One `checkPattern` call, refusal included, must finish inside this. */
const CHECK_BOUND_MS = 100

/** Patterns that backtrack catastrophically, one per shape the analyser refuses. */
const ADJACENT_QUANTIFIERS = `^${'\\d+'.repeat(20)}$`
const NESTED_QUANTIFIER = '^(a+)+$'
const ALTERNATING_GROUP = '^(a|a)*$'
const ADJACENT_DOTS = `^${'.*'.repeat(8)}x$`
const ADJACENT_OPTIONALS = `^${'\\d?'.repeat(40)}\\d$`

const HOSTILE = [ADJACENT_QUANTIFIERS, NESTED_QUANTIFIER, ALTERNATING_GROUP, ADJACENT_DOTS, ADJACENT_OPTIONALS]

/** The subject that makes the adjacent-quantifier pattern run for minutes. */
const WORST_SUBJECT = `${'1'.repeat(40)}!`

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1e6
}

test('every catastrophic pattern is refused, and the refusal itself is fast', () => {
  for (const pattern of HOSTILE) {
    const started = process.hrtime.bigint()
    const result = checkPattern(pattern)
    const took = elapsedMs(started)

    assert.equal(result.ok, false, `this pattern must never be compiled: ${pattern}`)
    assert.equal(took < CHECK_BOUND_MS, true, `checkPattern took ${took.toFixed(1)} ms for ${pattern}`)
  }
})

test('a pattern that is compiled is one whose boundaries cannot move', () => {
  // Refusing everything would be a bound too, and a useless one. These are the
  // shapes a contract actually writes, and they are still accepted.
  for (const pattern of ['^[a-z]+$', '^(?:ab)+$', '^EDL-\\d+$', '^[a-z]+-[0-9]+$', '^\\w+@\\w+\\.\\w+$', '^[A-Z]+\\d{4}$']) {
    assert.equal(checkPattern(pattern).ok, true, pattern)
  }
})

test('an accepted pattern run against the largest string a default body can hold stays inside the bound', () => {
  const result = checkPattern('^[a-z]+-[0-9]+$')
  assert.equal(result.ok, true)

  const started = process.hrtime.bigint()
  assert.equal(result.regex.test('a'.repeat(65536)), false)
  const took = elapsedMs(started)

  assert.equal(took < CHECK_BOUND_MS, true, `the match took ${took.toFixed(1)} ms`)
})

/**
 * Drive the real binary over a contract carrying hostile patterns, and kill it
 * if it does not answer. A killed child fails the test: "it would have finished
 * eventually" is not a bound.
 */
async function runWithPatterns(patterns, value) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-pattern-'))
  try {
    const properties = {}
    const body = {}
    for (let index = 0; index < patterns.length; index += 1) {
      properties[`field${index}`] = { type: 'string', pattern: patterns[index] }
      body[`field${index}`] = value
    }
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          {
            id: 'getThing',
            method: 'GET',
            path: '/things',
            responses: [{ status: 200, contentType: 'application/json', body: { type: 'object', properties } }],
          },
        ],
      }),
    )
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [
          {
            id: 'the-case',
            operationId: 'getThing',
            request: { method: 'GET', path: '/things' },
            expect: { status: 200, contentType: 'application/json', body },
          },
        ],
      }),
    )
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const started = process.hrtime.bigint()
    try {
      const { stdout } = await run(process.execPath, [CLI, '--plan', planPath, '--json'], { cwd: base, timeout: RUN_BOUND_MS })
      return { code: 0, report: JSON.parse(stdout), took: elapsedMs(started) }
    } catch (error) {
      if (error.killed === true) {
        assert.fail(`the run did not return within ${RUN_BOUND_MS} ms; the pattern bound is not a bound`)
      }
      return { code: error.code, report: JSON.parse(error.stdout), took: elapsedMs(started) }
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('the run returns, and says the value was not checked, for the pattern that ran for 109 seconds', async () => {
  const { code, report, took } = await runWithPatterns([ADJACENT_QUANTIFIERS], WORST_SUBJECT)

  assert.equal(took < RUN_BOUND_MS, true, `the run took ${took.toFixed(0)} ms`)
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.filter((finding) => finding.ruleId === 'schema-pattern-refused').length,
    1,
  )
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.summary.passed, 0)
})

test('every hostile pattern in one contract still returns inside the bound, and none of them passes', async () => {
  const { code, report, took } = await runWithPatterns(HOSTILE, WORST_SUBJECT)

  assert.equal(took < RUN_BOUND_MS, true, `the run took ${took.toFixed(0)} ms`)
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'schema-pattern-refused').length, HOSTILE.length)
  assert.equal(report.summary.checked, 0)
})

test('a value longer than the pattern bound is left unchecked, not matched', async () => {
  /*
   * The shape analyser refuses exponential patterns. It does not refuse
   * polynomial ones, and it should not: `\w+@\w+\.\w+` is an ordinary, correct
   * pattern. But it backtracks quadratically, so the cost lives in the INPUT,
   * not the pattern -- 2.7 seconds at 65 kB, and past twelve minutes
   * extrapolated to the hard maxBodyBytes cap.
   *
   * A deadline cannot catch it: the engine does not yield, so a time check
   * around the call never runs during it. This asserts the bound that does
   * hold, and asserts it by the clock as well as by the finding, because the
   * whole point is that the work does not happen.
   */
  const schema = { type: 'string', pattern: '\\w+@\\w+\\.\\w+' }
  const long = 'a'.repeat(MAX_PATTERN_INPUT + 1)

  const started = process.hrtime.bigint()
  const result = validateValue(schema, long)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(result.issues.length, 0, 'an unchecked value must not be reported as failing')
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].ruleId, 'schema-pattern-input-too-long')
  assert.match(result.gaps[0].message, /not checked/)
  assert.ok(elapsedMs < 100, `the pattern must not be run at all; took ${elapsedMs.toFixed(1)}ms`)
})

test('a value at the bound is still checked', () => {
  // The bound is only honest if it is exclusive: one character shorter must
  // behave normally, or the guard is hiding work rather than bounding it.
  const schema = { type: 'string', pattern: '^[a-z]+$' }

  const atBound = validateValue(schema, 'a'.repeat(MAX_PATTERN_INPUT))
  assert.deepEqual(atBound.gaps, [])
  assert.deepEqual(atBound.issues, [])

  const failing = validateValue(schema, `${'a'.repeat(MAX_PATTERN_INPUT - 1)}1`)
  assert.deepEqual(failing.gaps, [])
  assert.equal(failing.issues.length, 1)
})
