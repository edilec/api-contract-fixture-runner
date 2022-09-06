import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The `incomplete` flag, shown to be load-bearing rather than decorative.
 *
 * Deleting one `incomplete = true` once let an entirely unread input report
 * `pass` with a full suite still green. The flag here is raised in exactly one
 * place -- the list of rules that mean "evidence was not obtained" -- and every
 * test below pins a consequence of raising it, so removing a rule from that
 * list moves an exit code from 2 to 1 and fails here.
 *
 * The pair in the first test is the point: the same fixture set, differing only
 * in whether the schema is one this tool can evaluate, must come out as two
 * different statuses and two different exit codes. If the flag stopped working,
 * the two halves would agree and the test would fail.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-backstop-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base, args = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json', ...args], { cwd: base })
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }
  }
}

async function seed(base, responseBodySchema, expectedBody, plan = {}) {
  await writeFile(
    join(base, 'contract.json'),
    JSON.stringify({
      contractVersion: '1',
      operations: [
        { id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200, body: responseBodySchema }] },
      ],
    }),
  )
  await writeFile(
    join(base, 'fixtures.json'),
    JSON.stringify({
      fixtureVersion: '1',
      cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200, body: expectedBody } }],
    }),
  )
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...plan }))
}

test('a checkable mismatch fails; the same mismatch under an uncheckable schema is incomplete', async () => {
  const checkable = await withBase(async (base) => {
    await seed(base, { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { id: 7 })
    return cli(base)
  })
  assert.equal(checkable.code, 1)
  assert.equal(checkable.report.status, 'fail')
  assert.equal(checkable.report.summary.checked, 1)
  assert.equal(checkable.report.summary.failed, 1)
  assert.equal(checkable.report.summary.skipped, 0)

  const uncheckable = await withBase(async (base) => {
    await seed(base, { anyOf: [{ type: 'object' }] }, { id: 7 })
    return cli(base)
  })
  assert.equal(uncheckable.code, 2)
  assert.equal(uncheckable.report.status, 'incomplete')
  assert.equal(uncheckable.report.summary.checked, 0)
  assert.equal(uncheckable.report.summary.failed, 0)
  assert.equal(uncheckable.report.summary.skipped, 1)

  // The two halves must genuinely disagree, or this test proves nothing.
  assert.notEqual(checkable.code, uncheckable.code)
  assert.notEqual(checkable.report.status, uncheckable.report.status)
})

test('a "pass" with nothing checked is unreachable, whichever way the evidence went missing', async () => {
  const emptyCases = await withBase(async (base) => {
    await seed(base, { type: 'object' }, {})
    await writeFile(join(base, 'fixtures.json'), JSON.stringify({ fixtureVersion: '1', cases: [] }))
    return cli(base)
  })
  assert.equal(emptyCases.report.summary.checked, 0)
  assert.notEqual(emptyCases.report.status, 'pass')
  assert.equal(emptyCases.code, 2)
  assert.equal(emptyCases.report.findings.some((finding) => finding.ruleId === 'no-cases-checked'), true)

  const everyCaseSkipped = await withBase(async (base) => {
    await seed(base, { oneOf: [{ type: 'object' }] }, {})
    return cli(base)
  })
  assert.equal(everyCaseSkipped.report.summary.checked, 0)
  assert.notEqual(everyCaseSkipped.report.status, 'pass')
  assert.equal(everyCaseSkipped.code, 2)
  assert.equal(everyCaseSkipped.report.findings.some((finding) => finding.ruleId === 'no-cases-checked'), true)

  const unreadable = await withBase(async (base) => {
    await seed(base, { type: 'object' }, {})
    await writeFile(join(base, 'contract.json'), 'not json')
    return cli(base)
  })
  assert.equal(unreadable.report.summary.checked, 0)
  assert.notEqual(unreadable.report.status, 'pass')
  assert.equal(unreadable.code, 2)
})

test('an incomplete report never exits 0 or 1, and a passing report is never incomplete', async () => {
  const runs = []

  runs.push(await withBase(async (base) => {
    await seed(base, { type: 'object' }, {})
    return cli(base)
  }))
  runs.push(await withBase(async (base) => {
    await seed(base, { type: 'object', required: ['id'] }, {})
    return cli(base)
  }))
  runs.push(await withBase(async (base) => {
    await seed(base, { not: { type: 'string' } }, {})
    return cli(base)
  }))
  runs.push(await withBase(async (base) => {
    await seed(base, { type: 'object' }, {}, { call: true })
    return cli(base)
  }))

  for (const result of runs) {
    if (result.report.status === 'incomplete') assert.equal(result.code, 2, JSON.stringify(result.report.summary))
    if (result.report.status === 'pass') assert.equal(result.code, 0)
    if (result.report.status === 'fail') assert.equal(result.code, 1)
    assert.equal(['pass', 'fail', 'incomplete'].includes(result.report.status), true)
  }

  assert.deepEqual(runs.map((result) => result.report.status), ['pass', 'fail', 'incomplete', 'incomplete'])
  assert.deepEqual(runs.map((result) => result.code), [0, 1, 2, 2])
})

test('a gap stops one case, not the whole run: the others still reach a verdict', async () => {
  const result = await withBase(async (base) => {
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          { id: 'checkable', method: 'GET', path: '/a', responses: [{ status: 200, body: { type: 'object', required: ['id'] } }] },
          { id: 'uncheckable', method: 'GET', path: '/b', responses: [{ status: 200, body: { allOf: [{ type: 'object' }] } }] },
        ],
      }),
    )
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [
          { id: 'good', operationId: 'checkable', request: { method: 'GET', path: '/a' }, expect: { status: 200, body: { id: 1 } } },
          { id: 'unknown', operationId: 'uncheckable', request: { method: 'GET', path: '/b' }, expect: { status: 200, body: {} } },
        ],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))
    return cli(base)
  })

  assert.equal(result.code, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.report.summary.checked, 1)
  assert.equal(result.report.summary.passed, 1)
  assert.equal(result.report.summary.skipped, 1)
  assert.deepEqual(result.report.run.cases.map((entry) => entry.verdict), ['pass', 'skipped'])
})

test('the incomplete diagnostic on stderr says what was not examined', async () => {
  const result = await withBase(async (base) => {
    await seed(base, { oneOf: [{ type: 'object' }] }, {})
    return cli(base, [])
  })

  assert.equal(result.code, 2)
  assert.equal(result.stderr.includes('incomplete: 0 of 1 declared case(s) reached a verdict and 1 were not checked.'), true)
  assert.equal(result.stderr.includes('this is not a pass'), true)
})

test('a refused --out destination rebuilds the report and the incomplete verdict survives the rebuild', async () => {
  // The `--out` refusal does not add a finding to the run: it rebuilds the
  // whole report around one. A rebuild that carries the findings across but
  // drops the flag turns "evidence could not be obtained" into "the policy
  // failed" -- a verdict about a contract this run never even parsed.
  const unread = await withBase(async (base) => {
    await seed(base, { type: 'object' }, {})
    await writeFile(join(base, 'contract.json'), 'this is not json')
    return cli(base, ['--out', join(base, 'contract.json')])
  })

  assert.equal(unread.code, 2)
  assert.equal(unread.report.status, 'incomplete')
  assert.equal(unread.report.summary.checked, 0)
  assert.deepEqual(
    unread.report.findings.map((finding) => finding.ruleId),
    ['document-not-json', 'output-destination-refused', 'no-cases-checked'],
  )

  // The same refusal over a run that did read everything is an ordinary
  // failure, so the two halves must genuinely disagree.
  const failed = await withBase(async (base) => {
    await seed(base, { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { id: 7 })
    return cli(base, ['--out', join(base, 'contract.json')])
  })

  assert.equal(failed.code, 1)
  assert.equal(failed.report.status, 'fail')
  assert.equal(failed.report.findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)

  assert.notEqual(unread.code, failed.code)
  assert.notEqual(unread.report.status, failed.report.status)
})

test('the refused --out destination leaves the input it was pointed at byte-identical', async () => {
  await withBase(async (base) => {
    await seed(base, { type: 'object' }, {})
    await writeFile(join(base, 'contract.json'), 'this is not json')
    const result = await cli(base, ['--out', join(base, 'contract.json')])

    assert.equal(result.code, 2)
    assert.equal(await readFile(join(base, 'contract.json'), 'utf8'), 'this is not json')
    assert.equal(result.report.findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)
  })
})
