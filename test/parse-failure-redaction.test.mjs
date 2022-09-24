import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/text.mjs'

/**
 * A parse failure must not quote the document it failed on.
 *
 * V8 writes `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`,
 * so a plan or a declared document short enough to be nothing but a credential
 * is reproduced in full by its own error message -- on exactly the path an
 * untrusted or malformed document takes. Sanitising did not help: the quoted
 * span sits at the front of the message and a cut from the end leaves it.
 *
 * The canary below is the AWS documentation placeholder, not a key. It is
 * asserted absent from stdout, from stderr, and from every prefix down to
 * eight characters, because V8 quotes a ten-character prefix once the input is
 * long enough -- an assertion on the whole string alone passes while ten
 * characters of the secret still ship.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-parse-failure-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json'], { cwd: base })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/** Every prefix of the canary from its full length down to eight characters. */
function assertNoPrefix(text, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(text.includes(prefix), false, `${where} carried ${length} characters of the canary`)
  }
}

test('a plan that is only a credential is not echoed by its own parse error', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'plan.json'), CANARY)

    const { code, stdout, stderr } = await cli(base)
    assert.equal(code, 2)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const report = JSON.parse(stdout)
    const finding = report.findings.find((row) => row.ruleId === 'document-not-json')
    assert.notEqual(finding, undefined, 'the run still said the plan was not JSON')
    assert.equal(finding.message.includes('token'), true, 'the diagnostic still says what went wrong')
  })
})

test('a declared document that is only a credential is not echoed either', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'contract.json'), CANARY)
    await writeFile(join(base, 'fixtures.json'), JSON.stringify({ fixtureVersion: '1', cases: [] }))
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const { stdout, stderr } = await cli(base)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const report = JSON.parse(stdout)
    assert.equal(
      report.findings.some((row) => row.ruleId === 'document-not-json' && row.location.file === 'contract.json'),
      true,
      'the contract was still reported as unparseable',
    )
  })
})

test('a plan that fails after a valid property keeps its position, line and column', async () => {
  await withBase(async (base) => {
    // V8 answers this one with the safe spelling: a position and no quoted
    // span. The diagnostic must arrive whole -- a parse error that says
    // nothing is a different defect.
    await writeFile(join(base, 'plan.json'), `{"contract": "c.json" ${CANARY}}`)

    const { stdout, stderr } = await cli(base)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const report = JSON.parse(stdout)
    const finding = report.findings.find((row) => row.ruleId === 'document-not-json')
    assert.notEqual(finding, undefined)
    assert.match(finding.message, /at position \d+/, 'the position a reader needs is still there')
    assert.match(finding.message, /line \d+ column \d+/, 'line and column are still there')
  })
})

test('a secret deep inside a longer plan is not echoed by the windowed spelling', async () => {
  await withBase(async (base) => {
    // The third V8 spelling quotes a window rather than a prefix,
    // `..."fixtures": AKIAIOSFOD"...`, and carries no position. Only the
    // offending token survives it.
    await writeFile(join(base, 'plan.json'), `{"contract": "c.json", "fixtures": ${CANARY}}`)

    const { stdout, stderr } = await cli(base)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const report = JSON.parse(stdout)
    const finding = report.findings.find((row) => row.ruleId === 'document-not-json')
    assert.notEqual(finding, undefined)
    assert.match(finding.message, /unexpected token/, 'the diagnostic still says what went wrong')
  })
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const quoted = (() => {
    try {
      JSON.parse(CANARY)
      return null
    } catch (error) {
      return error
    }
  })()
  assert.equal(quoted.message.includes(CANARY), true, 'V8 still quotes the input, so this test still has a subject')
  assert.equal(parseFailureDetail(quoted).includes(CANARY.slice(0, SHORTEST_PREFIX)), false)

  const positioned = (() => {
    try {
      JSON.parse(`{"a": 1 ${CANARY}}`)
      return null
    } catch (error) {
      return error
    }
  })()
  const detail = parseFailureDetail(positioned)
  assert.equal(detail.includes(CANARY.slice(0, SHORTEST_PREFIX)), false)
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)

  const truncated = (() => {
    try {
      JSON.parse('password=hunter2-correct-horse')
      return null
    } catch (error) {
      return error
    }
  })()
  assert.equal(parseFailureDetail(truncated).includes('password'), false)

  assert.equal(parseFailureDetail(new SyntaxError('Unexpected end of JSON input')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
