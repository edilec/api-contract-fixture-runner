import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import {
  TOOL_ID,
  diffPointers,
  exitCodeFor,
  formatReport,
  isInside,
  responseClassOf,
  runPlan,
  runPlanFile,
  serializeReport,
} from '../src/index.mjs'

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-api-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const contract = {
  contractVersion: '1',
  operations: [
    {
      id: 'getThing',
      method: 'GET',
      path: '/things/{id}',
      responses: [{ status: 200, contentType: 'application/json', body: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }],
    },
  ],
}

const fixtures = {
  fixtureVersion: '1',
  cases: [
    {
      id: 'found',
      operationId: 'getThing',
      request: { method: 'GET', path: '/things/7' },
      expect: { status: 200, contentType: 'application/json', body: { id: '7' } },
    },
  ],
}

async function seed(base, plan = {}) {
  await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
  await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures))
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...plan }))
  return join(base, 'plan.json')
}

test('the report envelope is the one the contract describes', async () => {
  await withBase(async (base) => {
    const report = await runPlanFile(await seed(base), { label: 'plan.json' })

    assert.equal(report.schemaVersion, '1')
    assert.equal(report.tool, TOOL_ID)
    assert.equal(report.status, 'pass')
    assert.equal(typeof report.summary.checked, 'number')
    assert.equal(Array.isArray(report.findings), true)
    assert.equal(exitCodeFor(report), 0)
    assert.equal(serializeReport(report), JSON.stringify(report, null, 2))
    assert.equal(formatReport(report).endsWith('\n'), true)
  })
})

test('location.file is never an absolute host path', async () => {
  await withBase(async (base) => {
    const fixturesWithFault = structuredClone(fixtures)
    fixturesWithFault.cases[0].expect.body = { id: 7 }
    await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixturesWithFault))
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const report = await runPlanFile(planPath, { label: 'plan.json' })
    assert.equal(report.status, 'fail')
    for (const finding of report.findings) {
      assert.equal(finding.location.file.startsWith(sep), false, finding.location.file)
      assert.equal(finding.location.file.includes(base), false, finding.location.file)
    }
  })
})

test('a document genuinely inside a symlinked root is still read: a false refusal is a bug too', async () => {
  await withBase(async (real) => {
    await withBase(async (outer) => {
      await seed(real)
      const link = join(outer, 'via-link')
      await symlink(real, link)

      const report = await runPlanFile(join(link, 'plan.json'), { label: 'plan.json' })
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.checked, 1)
      assert.equal(report.findings.length, 0)
    })
  })
})

test('containment is decided on real paths on both sides', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b/', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a'), false)
})

test('the public entry points refuse an unknown option rather than ignoring it', async () => {
  await withBase(async (base) => {
    const planPath = await seed(base)
    await assert.rejects(() => runPlanFile(planPath, { labl: 'plan.json' }), /Unknown option "labl"/)
    await assert.rejects(() => runPlanFile(planPath, { limits: { maxCase: 1 } }), /Unknown limit "maxCase"/)
    await assert.rejects(() => runPlanFile('', {}), /A plan path is required/)
    await assert.rejects(() => runPlan({}, {}), /baseDir is required/)
    await assert.rejects(() => runPlan({}, { baseDir: base, nope: 1 }), /Unknown option "nope"/)
  })
})

test('runPlan takes a parsed plan and resolves its documents against the given root', async () => {
  await withBase(async (base) => {
    await seed(base)
    const report = await runPlan({ contract: 'contract.json', fixtures: 'fixtures.json' }, { baseDir: base, label: 'plan.json' })
    assert.equal(report.status, 'pass')
    assert.equal(report.run.contract.file, 'contract.json')
    assert.equal(report.run.fixtures.cases, 1)
  })
})

test('the run object records the outcome of every case in declared order', async () => {
  await withBase(async (base) => {
    const many = structuredClone(fixtures)
    many.cases.push({
      id: 'wrong',
      operationId: 'getThing',
      request: { method: 'GET', path: '/things/8' },
      expect: { status: 404 },
    })
    await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(many))
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const report = await runPlanFile(planPath, { label: 'plan.json' })
    assert.deepEqual(report.run.cases, [
      { id: 'found', operationId: 'getThing', verdict: 'pass', expectedStatus: 200, responseClass: 'success' },
      { id: 'wrong', operationId: 'getThing', verdict: 'fail', expectedStatus: 404, responseClass: 'client-error' },
    ])
  })
})

test('the status class is recorded and never consulted for a verdict', () => {
  assert.equal(responseClassOf(100), 'informational')
  assert.equal(responseClassOf(200), 'success')
  assert.equal(responseClassOf(301), 'redirect')
  assert.equal(responseClassOf(404), 'client-error')
  assert.equal(responseClassOf(503), 'server-error')
})

test('diffPointers names every leaf at which two bodies differ', () => {
  assert.deepEqual(diffPointers({ a: 1 }, { a: 1 }, '/b'), [])
  assert.deepEqual(diffPointers({ a: 1 }, { a: 2 }, '/b').map((row) => row.pointer), ['/b/a'])
  assert.deepEqual(diffPointers({ a: 1 }, { b: 1 }, '/b').map((row) => row.pointer).sort(), ['/b/a', '/b/b'])
  assert.deepEqual(diffPointers([1, 2], [1, 2, 3], '/b').map((row) => row.pointer), ['/b/2'])
  assert.deepEqual(diffPointers([1, 2, 3], [1, 2], '/b').map((row) => row.pointer), ['/b/2'])
  assert.deepEqual(diffPointers({ a: { b: [1, { c: 1 }] } }, { a: { b: [1, { c: 2 }] } }, '').map((row) => row.pointer), ['/a/b/1/c'])
  assert.deepEqual(diffPointers(1, 2, '').map((row) => row.pointer), ['/'])
})

test('the human summary carries the counts and one line per finding', async () => {
  await withBase(async (base) => {
    const fixturesWithFault = structuredClone(fixtures)
    fixturesWithFault.cases[0].expect.body = { id: 7 }
    await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixturesWithFault))
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const report = await runPlanFile(planPath, { label: 'plan.json' })
    const lines = formatReport(report).trimEnd().split('\n')
    assert.equal(lines.length, 5)
    assert.equal(lines[0], '1 of 1 fixture case(s) reached a verdict: 1 error, 0 warning, 0 info, status fail.')
    assert.equal(lines[3].includes('no socket was opened and nothing left this machine'), true)
    assert.equal(lines[4].startsWith('ERROR   '), true)
  })
})
