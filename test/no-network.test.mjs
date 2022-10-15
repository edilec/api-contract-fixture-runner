import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * No call ever leaves this machine, checked without opening a socket.
 *
 * The first test runs the real binary under a preload that throws before socket
 * connection, listener binding, host resolution or fetch can occur. Its mock
 * URL is inert input data, and a successful in-process call needs no network.
 *
 * The second test is the other half: a plan naming an external host is refused
 * before any call is constructed, the mock answers nothing, and the run is
 * `incomplete` because the live evidence it asked for was never obtained. A
 * refusal that still let the local table answer as though the remote host had
 * replied would be worse than no refusal at all.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')
const DENY_NETWORK = join(projectDirectory, 'test/support/deny-network.mjs')

const CONTRACT = {
  contractVersion: '1',
  operations: [
    {
      id: 'getThing',
      method: 'GET',
      path: '/t',
      responses: [{ status: 200, contentType: 'application/json', body: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }],
    },
  ],
}
const FIXTURES = {
  fixtureVersion: '1',
  cases: [
    {
      id: 'c',
      operationId: 'getThing',
      request: { method: 'GET', path: '/t' },
      expect: { status: 200, contentType: 'application/json', body: { id: '1' } },
    },
  ],
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-network-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base) {
  try {
    const { stdout } = await run(process.execPath, ['--import', DENY_NETWORK, CLI,
      '--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'], { cwd: base })
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) }
  }
}

test('the real binary uses an in-process mock with all socket APIs denied', async () => {
  const result = await withBase(async (base) => {
    await writeFile(join(base, 'contract.json'), JSON.stringify(CONTRACT))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(FIXTURES))
    await writeFile(
      join(base, 'plan.json'),
      JSON.stringify({
        contract: 'contract.json',
        fixtures: 'fixtures.json',
        call: true,
        mock: {
          mode: 'in-process',
          baseUrl: 'http://127.0.0.1:8080',
          routes: [{ operationId: 'getThing', status: 200, contentType: 'application/json', body: { id: '1' } }],
        },
      }),
    )
    return cli(base)
  })

  assert.equal(result.code, 0)
  assert.equal(result.report.status, 'pass')
  assert.equal(result.report.summary.liveCalls, 1, 'the call really was made -- in this process')
  assert.equal(result.report.run.mock.called, true)
  assert.equal(result.report.run.mock.calls, 1)
})

test('an external target is refused before a call, and the local table does not answer for it', async () => {
  const result = await withBase(async (base) => {
    await writeFile(join(base, 'contract.json'), JSON.stringify(CONTRACT))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(FIXTURES))
    await writeFile(
      join(base, 'plan.json'),
      JSON.stringify({
        contract: 'contract.json',
        fixtures: 'fixtures.json',
        call: true,
        mock: {
          mode: 'in-process',
          baseUrl: 'https://api.example.com/v1',
          routes: [{ operationId: 'getThing', status: 200, contentType: 'application/json', body: { id: '1' } }],
        },
      }),
    )
    return cli(base)
  })

  assert.equal(result.code, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.report.summary.liveCalls, 0)
  assert.equal(result.report.run.mock.refused, true)
  assert.equal(result.report.run.mock.called, false)
  assert.equal(result.report.run.mock.calls, 0)
  assert.equal(result.report.findings.some((finding) => finding.ruleId === 'mock-target-refused'), true)
})

test('the package imports nothing that could open a socket', async () => {
  const names = await readdir(join(projectDirectory, 'src'))
  const forbidden = [
    'node:net',
    'node:http',
    'node:https',
    'node:http2',
    'node:tls',
    'node:dgram',
    'node:dns',
    'node:child_process',
    'node:worker_threads',
    'undici',
  ]
  const sources = [join(projectDirectory, 'bin/api-contract-fixture-runner.mjs'), ...names.map((name) => join(projectDirectory, 'src', name))]

  for (const file of sources) {
    const text = await readFile(file, 'utf8')
    for (const module of forbidden) {
      assert.equal(text.includes(`'${module}'`), false, `${file} must not import ${module}`)
    }
    assert.equal(/\bfetch\s*\(/.test(text), false, `${file} must not call fetch`)
    assert.equal(/\bXMLHttpRequest\b/.test(text), false, `${file} must not use XMLHttpRequest`)
  }
})
