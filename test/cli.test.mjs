import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The command-line surface: streams, exit codes and the refusals.
 *
 * stdout carries the JSON report and nothing else, so a consumer can pipe it
 * straight into a parser. stderr carries the human summary and the
 * diagnostics, and a non-empty stderr is correct rather than a fault.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function cli(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withPlan(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-cli-'))
  try {
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [{ id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200 }] }],
      }),
    )
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200 } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('--help and --version print to stdout and exit 0', async () => {
  const help = await cli(['--help'])
  assert.equal(help.code, 0)
  assert.equal(help.stdout.startsWith('api-contract-fixture-runner'), true)
  assert.equal(help.stdout.includes('--plan FILE'), true)
  assert.equal(help.stdout.includes('An error response is not a contract violation'), true)
  assert.equal(help.stderr, '')

  const short = await cli(['-h'])
  assert.equal(short.stdout, help.stdout)

  const version = await cli(['--version'])
  assert.equal(version.code, 0)
  assert.equal(version.stdout, '0.1.0\n')
})

test('the help text names every exit code and every --out refusal', async () => {
  const { stdout } = await cli(['--help'])
  assert.equal(stdout.includes('Exit codes:'), true)
  assert.equal(stdout.includes('  0  '), true)
  assert.equal(stdout.includes('  1  '), true)
  assert.equal(stdout.includes('  2  '), true)
  // The three ways a destination writes somewhere it does not name, and the
  // two ways it lands on an input.
  assert.equal(stdout.includes('a symbolic link'), true)
  assert.equal(stdout.includes('outside the'), true)
  assert.equal(stdout.includes('by hard link'), true)
  assert.equal(stdout.includes('--out-root DIR'), true)
  // And the one shape every refusal has, which is the part a consumer that
  // pipes stdout has to handle.
  assert.equal(stdout.includes('stdout stays empty and the exit code is 2'), true)
})

test('stdout carries only JSON, and the summary goes to stderr', async () => {
  await withPlan(async (base) => {
    const result = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json'], base)
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
    assert.equal(result.stderr.length > 0, true, 'a non-empty stderr is correct')
    assert.equal(result.stderr.includes('fixture case(s) reached a verdict'), true)

    const quiet = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'], base)
    assert.equal(quiet.stdout, result.stdout)
    assert.equal(quiet.stderr, '')
  })
})

test('an unknown option is refused with an empty stdout', async () => {
  await withPlan(async (base) => {
    const result = await cli(['--plan', join(base, 'plan.json'), '--jsonn'], base)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('Unknown option "--jsonn"'), true)
  })
})

test('a missing --plan, a valueless flag and a repeated flag are all configuration errors', async () => {
  const missing = await cli([])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--plan is required'), true)

  const valueless = await cli(['--plan'])
  assert.equal(valueless.code, 2)
  assert.equal(valueless.stdout, '')
  assert.equal(valueless.stderr.includes('--plan requires a value'), true)

  const repeated = await cli(['--plan', 'a.json', '--plan', 'b.json'])
  assert.equal(repeated.code, 2)
  assert.equal(repeated.stdout, '')
  assert.equal(repeated.stderr.includes('--plan was given more than once'), true)
})

test('--call and --no-call cannot both be given', async () => {
  const both = await cli(['--plan', 'a.json', '--call', '--no-call'])
  assert.equal(both.code, 2)
  assert.equal(both.stdout, '')
  assert.equal(both.stderr.includes('--call and --no-call cannot both be given'), true)
})

test('--no-call overrides a plan that asked for calls', async () => {
  await withPlan(async (base) => {
    await writeFile(
      join(base, 'plan.json'),
      JSON.stringify({
        contract: 'contract.json',
        fixtures: 'fixtures.json',
        call: true,
        mock: { mode: 'in-process', baseUrl: 'http://127.0.0.1:9099', routes: [{ operationId: 'getThing', status: 200 }] },
      }),
    )

    const called = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'], base)
    assert.equal(JSON.parse(called.stdout).summary.liveCalls, 1)

    const skipped = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json', '--no-call'], base)
    assert.equal(skipped.code, 0)
    assert.equal(JSON.parse(skipped.stdout).summary.liveCalls, 0)
    assert.equal(JSON.parse(skipped.stdout).run.mock.called, false)
  })
})

test('a plan file that does not exist is an incomplete report, not an empty stdout', async () => {
  const result = await cli(['--plan', 'no-such-plan.json', '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout.length > 0, true)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'document-unreadable'), true)
})

test('a directory passed as the plan is reported rather than crashing', async () => {
  const result = await cli(['--plan', 'examples', '--json'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  assert.equal(JSON.parse(result.stdout).findings.some((finding) => finding.ruleId === 'document-unreadable'), true)
})

test('--label decides the plan-level location.file and never a host path', async () => {
  await withPlan(async (base) => {
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', unknownKey: 1 }))
    const result = await cli(['--plan', join(base, 'plan.json'), '--label', 'fixtures/plan.json', '--json'], base)

    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.findings[0].location.file, 'fixtures/plan.json')
    assert.equal(result.stdout.includes(base), false)
  })
})

test('the three exit codes are produced by the three shipped situations', async () => {
  const passing = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  assert.equal(passing.code, 0)
  assert.equal(JSON.parse(passing.stdout).status, 'pass')

  const failing = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  assert.equal(failing.code, 1)
  assert.equal(JSON.parse(failing.stdout).status, 'fail')

  const incomplete = await cli(['--plan', 'examples/clean/plan.json', '--json', '--max-body-bytes', '1'])
  assert.equal(incomplete.code, 2)
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete')
})
