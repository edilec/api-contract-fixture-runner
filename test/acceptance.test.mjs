import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

/**
 * The two things this tool exists to get right.
 *
 * 1. An **expected application error passes its contract.** A fixture that
 *    documents a 422 with the error body the contract declares is a pass, not a
 *    failure for being a 4xx. The classic bug in this shape of tool is treating
 *    "the response was an error" and "the contract was violated" as the same
 *    thing, and it is worth pinning by exit code rather than by inspection.
 * 2. **Status, content type and body mismatches fail, with the field path.**
 *    Three separate checks, three separate rules, and a JSON Pointer on every
 *    body finding.
 */

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const CONTRACT = {
  contractVersion: '1',
  components: {
    schemas: {
      Problem: {
        type: 'object',
        required: ['title', 'status'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          status: { type: 'integer', minimum: 400, maximum: 599 },
          field: { type: 'string' },
        },
      },
    },
  },
  operations: [
    {
      id: 'createThing',
      method: 'POST',
      path: '/things',
      request: { contentType: 'application/json', body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
      responses: [
        { status: 201, contentType: 'application/json', body: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } } },
        { status: 422, contentType: 'application/problem+json', body: { $ref: '#/components/schemas/Problem' } },
        { status: 500, contentType: 'application/problem+json', body: { $ref: '#/components/schemas/Problem' } },
      ],
    },
  ],
}

const REQUEST = { method: 'POST', path: '/things', contentType: 'application/json', body: { name: 'a' } }

async function withFixtures(cases, use, planExtras = {}) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-acceptance-'))
  try {
    await writeFile(join(base, 'contract.json'), JSON.stringify(CONTRACT, null, 2))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify({ fixtureVersion: '1', cases }, null, 2))
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...planExtras }, null, 2))
    return await use(join(base, 'plan.json'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a fixture documenting a 422 application error PASSES its contract', async () => {
  await withFixtures(
    [
      {
        id: 'validation-rejected',
        operationId: 'createThing',
        request: REQUEST,
        expect: {
          status: 422,
          contentType: 'application/problem+json',
          body: { title: 'name is already taken', status: 422, field: '/name' },
        },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.errors, 0)
      assert.equal(report.summary.passed, 1)
      assert.equal(report.summary.failed, 0)
      assert.equal(report.summary.checked, 1)
      assert.equal(report.run.cases[0].verdict, 'pass')
      assert.equal(report.run.cases[0].responseClass, 'client-error')
    },
  )
})

test('a fixture documenting a 500 application error passes too: the class is never the verdict', async () => {
  await withFixtures(
    [
      {
        id: 'upstream-failed',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 500, contentType: 'application/problem+json', body: { title: 'upstream unavailable', status: 500 } },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.errors, 0)
      assert.equal(report.run.cases[0].responseClass, 'server-error')
    },
  )
})

test('the passing error case is visible in the report as its own finding', async () => {
  await withFixtures(
    [
      {
        id: 'validation-rejected',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 422, contentType: 'application/problem+json', body: { title: 'nope', status: 422 } },
      },
    ],
    async (planPath) => {
      const { code, stdout, stderr } = await cli(['--plan', planPath])
      const report = JSON.parse(stdout)

      assert.equal(code, 0)
      assert.equal(report.summary.info, 1)
      assert.equal(report.findings[0].ruleId, 'expected-application-error-verified')
      assert.equal(report.findings[0].severity, 'info')
      assert.equal(stderr.includes('INFO'), true)
      assert.equal(stderr.includes('ERROR'), false)
    },
  )
})

test('an error status the contract does not document fails, and it is the silence that fails it', async () => {
  await withFixtures(
    [
      {
        id: 'undocumented-418',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 418, contentType: 'application/problem+json' },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 1)
      assert.equal(report.status, 'fail')
      assert.equal(report.summary.errors, 1)
      assert.equal(report.findings[0].ruleId, 'response-status-undeclared')
      assert.equal(report.findings[0].location.pointer, '/cases/0/expect/status')
      assert.equal(report.findings[0].evidence, 'declared: 201, 422, 500')
    },
  )
})

test('a content-type mismatch fails on its own rule, with the status untouched', async () => {
  await withFixtures(
    [
      {
        id: 'wrong-media-type',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 422, contentType: 'application/json', body: { title: 'nope', status: 422 } },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 1)
      assert.equal(report.status, 'fail')
      assert.equal(report.summary.errors, 1)
      assert.equal(report.findings[0].ruleId, 'response-content-type-mismatch')
      assert.equal(report.findings[0].location.pointer, '/cases/0/expect/contentType')
      assert.equal(report.findings[0].evidence, 'application/json')
    },
  )
})

test('a body mismatch fails with a JSON Pointer to every offending field', async () => {
  await withFixtures(
    [
      {
        id: 'wrong-body',
        operationId: 'createThing',
        request: REQUEST,
        expect: {
          status: 422,
          contentType: 'application/problem+json',
          body: { status: '422', detail: 'undocumented', field: 7 },
        },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 1)
      assert.equal(report.status, 'fail')
      assert.equal(report.summary.errors, 4)
      assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
        '/cases/0/expect/body/detail',
        '/cases/0/expect/body/field',
        '/cases/0/expect/body/status',
        '/cases/0/expect/body/title',
      ])
      for (const finding of report.findings) assert.equal(finding.ruleId, 'response-body-mismatch')
    },
  )
})

test('a request body mismatch is its own rule with its own field path', async () => {
  await withFixtures(
    [
      {
        id: 'wrong-request',
        operationId: 'createThing',
        request: { method: 'POST', path: '/things', contentType: 'application/json', body: { name: 12 } },
        expect: { status: 201, contentType: 'application/json', body: { id: 'x' } },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 1)
      assert.equal(report.summary.errors, 1)
      assert.equal(report.findings[0].ruleId, 'request-body-mismatch')
      assert.equal(report.findings[0].location.pointer, '/cases/0/request/body/name')
      assert.equal(report.findings[0].message, 'Expected type string and found integer.')
    },
  )
})

test('a live call against the in-process mock compares status, content type and body separately', async () => {
  await withFixtures(
    [
      {
        id: 'live',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 422, contentType: 'application/problem+json', body: { title: 'nope', status: 422 } },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 1)
      assert.equal(report.summary.liveCalls, 1)
      assert.equal(report.summary.errors, 3)
      // Sorted by pointer, so the body field comes before the two envelope
      // checks. Three findings, three rules: the mismatches are separate.
      assert.deepEqual(report.findings.map((finding) => finding.ruleId), [
        'live-body-mismatch',
        'live-content-type-mismatch',
        'live-status-mismatch',
      ])
      assert.equal(report.findings[0].location.pointer, '/cases/0/expect/body/title')
      assert.equal(report.findings[1].location.pointer, '/cases/0/expect/contentType')
      assert.equal(report.findings[2].location.pointer, '/cases/0/expect/status')
    },
    {
      call: true,
      mock: {
        mode: 'in-process',
        baseUrl: 'http://127.0.0.1:9099',
        routes: [{ operationId: 'createThing', status: 500, contentType: 'application/json', body: { title: 'boom', status: 422 } }],
      },
    },
  )
})

test('a mock that answers exactly what the fixture documents passes, error status and all', async () => {
  await withFixtures(
    [
      {
        id: 'live-agrees',
        operationId: 'createThing',
        request: REQUEST,
        expect: { status: 422, contentType: 'application/problem+json', body: { title: 'nope', status: 422 } },
      },
    ],
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.errors, 0)
      assert.equal(report.summary.liveCalls, 1)
      assert.equal(report.run.mock.calls, 1)
    },
    {
      call: true,
      mock: {
        mode: 'in-process',
        baseUrl: 'http://127.0.0.1:9099',
        routes: [{ operationId: 'createThing', status: 422, contentType: 'application/problem+json', body: { title: 'nope', status: 422 } }],
      },
    },
  )
})

test('the shipped clean example passes and the shipped broken example fails with field paths', async () => {
  const clean = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  const cleanReport = JSON.parse(clean.stdout)
  assert.equal(clean.code, 0)
  assert.equal(cleanReport.status, 'pass')
  assert.equal(cleanReport.summary.errors, 0)
  assert.equal(cleanReport.summary.passed, 4)
  assert.equal(cleanReport.summary.info, 2)

  const broken = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  const brokenReport = JSON.parse(broken.stdout)
  assert.equal(broken.code, 1)
  assert.equal(brokenReport.status, 'fail')
  assert.equal(brokenReport.summary.failed, 5)
  assert.deepEqual(brokenReport.findings.map((finding) => finding.ruleId), [
    'response-status-undeclared',
    'response-content-type-mismatch',
    'response-body-mismatch',
    'response-body-mismatch',
    'response-body-mismatch',
    'request-header-missing',
    'live-body-mismatch',
    'live-body-mismatch',
  ])
  assert.equal(brokenReport.findings[2].location.pointer, '/cases/2/expect/body/discount')
  assert.equal(brokenReport.findings[6].location.pointer, '/cases/4/expect/body/id')
})
