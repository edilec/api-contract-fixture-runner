import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by what actually happens -- for the rules where severity is
 * the whole of the verdict.
 *
 * A frozen table is the right source of truth, and a test that asserts the
 * table against a documented catalog and against a hand-written copy in the
 * tests is three declarations agreeing with each other: an edit that changes
 * all three at once passes every assertion, and a rule quietly demoted from
 * `error` to `warning` reaches exit 0 with the suite still green. That is a
 * fourth mirror, not a test.
 *
 * So this file imports nothing from `src`. It holds no rule table, no severity
 * map, no shared list of expectations and no parameterised case array. Every
 * test builds its own three documents, runs the real binary over them, and
 * states the exit code, the status and the counted errors as literals written
 * out at the assertion. A demotion changes `fail` to `pass`, 1 to 0 and the
 * error count -- and no coordinated edit to a table, a document and a test map
 * can satisfy an exit code.
 *
 * The rules in this file set no `incomplete` flag. `test/incomplete-severity`
 * pins the ones that do, where the exit code is 2 either way.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

/** Plumbing only: write three documents into a fresh directory and run the binary. */
async function check(contract, fixtures, plan = {}, extraArgs = []) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-decides-'))
  try {
    await writeFile(join(base, 'contract.json'), JSON.stringify(contract, null, 2))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures, null, 2))
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...plan }, null, 2))
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', planPath, ...extraArgs], { cwd: base })
      return { code: 0, report: JSON.parse(stdout), stderr }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Fresh input data, never an expectation. */
function contractWithOneOperation(overrides = {}) {
  return {
    contractVersion: '1',
    operations: [
      {
        id: 'createThing',
        method: 'POST',
        path: '/things',
        request: {
          contentType: 'application/json',
          body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
        responses: [
          {
            status: 201,
            contentType: 'application/json',
            body: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          },
        ],
        ...overrides,
      },
    ],
  }
}

function fixtureWithOneCase(overrides = {}) {
  return {
    fixtureVersion: '1',
    cases: [
      {
        id: 'the-case',
        operationId: 'createThing',
        request: { method: 'POST', path: '/things', contentType: 'application/json', body: { name: 'a' } },
        expect: { status: 201, contentType: 'application/json', body: { id: 'x' } },
        ...overrides,
      },
    ],
  }
}

test('a matching fixture passes, so every failure below is caused by its own defect', async () => {
  const { code, report } = await check(contractWithOneOperation(), fixtureWithOneCase(), {}, ['--json'])
  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.passed, 1)
})

test('request-method-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].request.method = 'PUT'
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.passed, 0)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/request/method request-method-mismatch'), true)
})

test('request-path-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].request.path = '/things/extra'
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/request/path request-path-mismatch'), true)
})

test('request-content-type-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].request.contentType = 'text/plain'
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/request/contentType request-content-type-mismatch'), true)
})

test('request-header-missing fails the run', async () => {
  const contract = contractWithOneOperation()
  contract.operations[0].request.headers = { 'Idempotency-Key': { required: true } }
  const { code, report, stderr } = await check(contract, fixtureWithOneCase())

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/request/headers request-header-missing'), true)
})

test('request-body-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].request.body = { name: 99 }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/request/body/name request-body-mismatch'), true)
})

test('request-operation-unknown fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].operationId = 'noSuchOperation'
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/operationId request-operation-unknown'), true)
  assert.equal(stderr.includes('WARNING contract.json/operations operation-without-fixture'), true)
})

test('response-status-undeclared fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect = { status: 409, contentType: 'application/json' }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/status response-status-undeclared'), true)
})

test('response-content-type-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.contentType = 'application/problem+json'
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/contentType response-content-type-mismatch'), true)
})

test('response-header-missing fails the run', async () => {
  const contract = contractWithOneOperation()
  contract.operations[0].responses[0].headers = { Location: { required: true } }
  const { code, report, stderr } = await check(contract, fixtureWithOneCase())

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/headers response-header-missing'), true)
})

test('response-body-mismatch fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.body = { id: 42 }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/id response-body-mismatch'), true)
})

test('duplicate-case-id fails the run', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases.push(JSON.parse(JSON.stringify(fixtures.cases[0])))
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.passed, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/1/id duplicate-case-id'), true)
})

test('live-status-mismatch fails the run', async () => {
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 500, contentType: 'application/json', body: { id: 'x' } }],
    },
  }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtureWithOneCase(), plan)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.liveCalls, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/status live-status-mismatch'), true)
})

test('live-content-type-mismatch fails the run', async () => {
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'text/plain', body: { id: 'x' } }],
    },
  }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtureWithOneCase(), plan)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/contentType live-content-type-mismatch'), true)
})

test('live-header-mismatch fails the run when the mock answers without the header', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.headers = { Location: '/things/1' }
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json', body: { id: 'x' } }],
    },
  }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures, plan)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.liveCalls, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/headers live-header-mismatch'), true)
  assert.equal(stderr.includes('-- Location'), true)
})

test('live-header-mismatch fails the run when the mock answers a different value', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.headers = { Location: '/things/1' }
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [
        {
          operationId: 'createThing',
          status: 201,
          contentType: 'application/json',
          headers: { location: '/completely/different' },
          body: { id: 'x' },
        },
      ],
    },
  }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtures, plan)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/headers live-header-mismatch'), true)
  assert.equal(stderr.includes('The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.'), true)
  assert.equal(stderr.includes('/completely/different'), false)
})

test('a mock route that answers the header the fixture expects passes, whatever the case of its name', async () => {
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.headers = { Location: '/things/1' }
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [
        {
          operationId: 'createThing',
          status: 201,
          contentType: 'application/json',
          headers: { LOCATION: '/things/1' },
          body: { id: 'x' },
        },
      ],
    },
  }
  const { code, report } = await check(contractWithOneOperation(), fixtures, plan, ['--json'])

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.passed, 1)
  assert.equal(report.summary.liveCalls, 1)
})

test('a live header mismatch hidden by rendering fails without exposing raw units', async () => {
  const hidden = `token${String.fromCharCode(0x85)}part`
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.headers = { Location: hidden }
  const plan = {
    call: true,
    mock: {
      mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json',
        headers: { Location: 'token part' }, body: { id: 'x' } }],
    },
  }

  const mismatch = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(mismatch.code, 1)
  assert.equal(mismatch.report.status, 'fail')
  assert.deepEqual(mismatch.report.findings.map((row) => row.ruleId), ['live-header-mismatch'])
  assert.equal(mismatch.report.findings[0].location.pointer, '/cases/0/expect/headers')
  assert.equal(mismatch.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.doesNotMatch(mismatch.report.findings[0].evidence, /U\+[0-9A-F]{4}/u)

  plan.mock.routes[0].headers.Location = hidden
  const equal = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(equal.code, 0)
  assert.equal(equal.report.status, 'pass')
  assert.deepEqual(equal.report.findings, [])
})

test('a live header mismatch keeps short secret-shaped values out of JSON and human output', async () => {
  const canary = 'token=SYNTHETIC_SECRET_CANARY'
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.headers = { Location: canary }
  const plan = {
    call: true,
    mock: {
      mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json',
        headers: { Location: 'OTHER' }, body: { id: 'x' } }],
    },
  }

  const mismatch = await check(contractWithOneOperation(), fixtures, plan)
  assert.equal(mismatch.code, 1)
  assert.equal(mismatch.report.status, 'fail')
  assert.deepEqual(mismatch.report.findings.map((row) => row.ruleId), ['live-header-mismatch'])
  assert.equal(mismatch.report.findings[0].location.pointer, '/cases/0/expect/headers')
  assert.equal(mismatch.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.equal(JSON.stringify(mismatch.report).includes(canary), false)
  assert.equal(mismatch.stderr.includes('live-header-mismatch'), true)
  assert.equal(mismatch.stderr.includes(canary), false)

  plan.mock.routes[0].headers.Location = canary
  const equal = await check(contractWithOneOperation(), fixtures, plan)
  assert.equal(equal.code, 0)
  assert.equal(equal.report.status, 'pass')
  assert.deepEqual(equal.report.findings, [])
})

test('live-body-mismatch fails the run', async () => {
  const plan = {
    call: true,
    mock: {
      mode: 'in-process',
      baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json', body: { id: 'other' } }],
    },
  }
  const { code, report, stderr } = await check(contractWithOneOperation(), fixtureWithOneCase(), plan)

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/id live-body-mismatch'), true)
})

test('an unexpected in-process body fails without exposing its scalar in JSON or human output', async () => {
  const canary = 'token=SYNTHETIC_SECRET_CANARY'
  const contract = contractWithOneOperation({ responses: [{ status: 200 }] })
  const fixtures = fixtureWithOneCase({ expect: { status: 200 } })
  const plan = {
    call: true,
    mock: {
      mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 200 }],
    },
  }

  const good = await check(contract, fixtures, plan)
  assert.equal(good.code, 0)
  assert.equal(good.report.status, 'pass')
  assert.deepEqual(good.report.findings, [])

  plan.mock.routes[0].body = canary
  const mismatch = await check(contract, fixtures, plan)
  assert.equal(mismatch.code, 1)
  assert.equal(mismatch.report.status, 'fail')
  assert.equal(mismatch.report.summary.failed, 1)
  assert.deepEqual(mismatch.report.findings.map((row) => row.ruleId), ['live-body-mismatch'])
  assert.equal(mismatch.report.findings[0].location.pointer, '/cases/0/expect/body')
  assert.equal(Object.hasOwn(mismatch.report.findings[0], 'evidence'), false)
  assert.equal(JSON.stringify(mismatch.report).includes(canary), false)
  assert.equal(mismatch.stderr.includes('live-body-mismatch'), true)
  assert.equal(mismatch.stderr.includes(canary), false)
})

test('a live body mismatch hidden by rendering fails safely on either side', async () => {
  const hidden = `token${String.fromCharCode(0x85)}part`
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.body.note = hidden
  const plan = {
    call: true,
    mock: {
      mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json',
        body: { id: 'x', note: 'token part' } }],
    },
  }

  const expectedHidden = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(expectedHidden.code, 1)
  assert.equal(expectedHidden.report.status, 'fail')
  assert.deepEqual(expectedHidden.report.findings.map((row) => row.ruleId), ['live-body-mismatch'])
  assert.equal(expectedHidden.report.findings[0].location.pointer, '/cases/0/expect/body/note')
  assert.equal(expectedHidden.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.doesNotMatch(expectedHidden.report.findings[0].evidence, /U\+[0-9A-F]{4}/u)

  fixtures.cases[0].expect.body.note = 'token part'
  plan.mock.routes[0].body.note = hidden
  const answeredHidden = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(answeredHidden.code, 1)
  assert.equal(answeredHidden.report.status, 'fail')
  assert.deepEqual(answeredHidden.report.findings.map((row) => row.ruleId), ['live-body-mismatch'])
  assert.equal(answeredHidden.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.doesNotMatch(answeredHidden.report.findings[0].evidence, /U\+[0-9A-F]{4}/u)

  fixtures.cases[0].expect.body.note = hidden
  const equal = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(equal.code, 0)
  assert.equal(equal.report.status, 'pass')
  assert.deepEqual(equal.report.findings, [])

  fixtures.cases[0].expect.body.note = `${'A'.repeat(90)}SYNTHETIC_SECRET_CANARY`
  plan.mock.routes[0].body.note = `${'A'.repeat(90)}OTHER`
  const hiddenTail = await check(contractWithOneOperation(), fixtures, plan, ['--json'])
  assert.equal(hiddenTail.code, 1)
  assert.equal(hiddenTail.report.status, 'fail')
  assert.equal(hiddenTail.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.doesNotMatch(hiddenTail.report.findings[0].evidence, /U\+[0-9A-F]{4}/u)
  assert.equal(hiddenTail.report.findings[0].evidence.includes('SYNTHETIC_SECRET_CANARY'), false)
  assert.equal(hiddenTail.report.findings[0].evidence.length <= 160, true)
})

test('a live body mismatch keeps short secret-shaped values out of JSON and human output', async () => {
  const canary = 'token=SYNTHETIC_SECRET_CANARY'
  const fixtures = fixtureWithOneCase()
  fixtures.cases[0].expect.body.note = canary
  const plan = {
    call: true,
    mock: {
      mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'createThing', status: 201, contentType: 'application/json',
        body: { id: 'x', note: 'OTHER' } }],
    },
  }

  const mismatch = await check(contractWithOneOperation(), fixtures, plan)
  assert.equal(mismatch.code, 1)
  assert.equal(mismatch.report.status, 'fail')
  assert.deepEqual(mismatch.report.findings.map((row) => row.ruleId), ['live-body-mismatch'])
  assert.equal(mismatch.report.findings[0].location.pointer, '/cases/0/expect/body/note')
  assert.equal(mismatch.report.findings[0].evidence,
    'The fixture expectation and in-process mock answer differ at this finding\'s location; compare those source fields.')
  assert.equal(JSON.stringify(mismatch.report).includes(canary), false)
  assert.equal(mismatch.stderr.includes('live-body-mismatch'), true)
  assert.equal(mismatch.stderr.includes(canary), false)

  plan.mock.routes[0].body.note = canary
  const equal = await check(contractWithOneOperation(), fixtures, plan)
  assert.equal(equal.code, 0)
  assert.equal(equal.report.status, 'pass')
  assert.deepEqual(equal.report.findings, [])
})
