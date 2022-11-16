import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('an invalid mock mode reports its position without echoing its value', async () => {
  await withPlan(async (base) => {
    const planPath = join(base, 'plan.json')
    const plan = JSON.parse(await readFile(planPath, 'utf8'))
    const canary = 'token=SYNTHETIC_SECRET_CANARY'
    plan.call = true
    plan.mock = {
      mode: canary,
      baseUrl: 'http://127.0.0.1:9099',
      routes: [{ operationId: 'getThing', status: 200 }],
    }
    await writeFile(planPath, JSON.stringify(plan))
    const invalid = await cli(['--plan', planPath])
    assert.equal(invalid.code, 2)
    const report = JSON.parse(invalid.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    const finding = report.findings.find((row) => row.ruleId === 'document-invalid'
      && row.location.pointer === '/mock/mode')
    assert.ok(finding)
    assert.equal(invalid.stdout.includes(canary), false)
    assert.equal(invalid.stderr.includes(canary), false)

    plan.mock.mode = 'in-process'
    await writeFile(planPath, JSON.stringify(plan))
    const valid = await cli(['--plan', planPath])
    assert.equal(valid.code, 0)
    assert.equal(JSON.parse(valid.stdout).status, 'pass')
  })
})

test('media-type evidence that changes when rendered is incomplete on every comparison side', async () => {
  await withPlan(async (base) => {
    const files = ['contract.json', 'fixtures.json', 'plan.json']
    const original = Object.fromEntries(await Promise.all(files.map(async (file) =>
      [file, JSON.parse(await readFile(join(base, file), 'utf8'))])))
    const visible = 'application/json; charset=utf-8'
    const hidden = `${visible}${String.fromCharCode(0x200e)}`
    const makeDocuments = () => {
      const documents = structuredClone(original)
      const operation = documents['contract.json'].operations[0]
      const fixture = documents['fixtures.json'].cases[0]
      operation.request = { contentType: visible }
      operation.responses[0].contentType = visible
      fixture.request.contentType = visible
      fixture.expect.contentType = visible
      documents['plan.json'].call = true
      documents['plan.json'].mock = {
        mode: 'in-process', baseUrl: 'http://127.0.0.1:9099',
        routes: [{ operationId: 'getThing', status: 200, contentType: visible }],
      }
      return documents
    }
    const runDocuments = async (documents) => {
      for (const file of files) await writeFile(join(base, file), JSON.stringify(documents[file]))
      const result = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'], base)
      return { ...result, report: JSON.parse(result.stdout) }
    }

    const clean = await runDocuments(makeDocuments())
    assert.equal(clean.code, 0)
    assert.equal(clean.report.status, 'pass')
    assert.equal(clean.report.summary.checked, 1)

    const visibleMismatch = makeDocuments()
    visibleMismatch['fixtures.json'].cases[0].expect.contentType = 'application/xml; charset=utf-8'
    const different = await runDocuments(visibleMismatch)
    assert.equal(different.code, 1)
    assert.equal(different.report.status, 'fail')
    assert.equal(different.report.findings.some((row) => row.ruleId === 'response-content-type-mismatch'), true)

    const sides = [
      ['contract.json', '/operations/0/request/contentType', (documents) => documents['contract.json'].operations[0].request],
      ['fixtures.json', '/cases/0/request/contentType', (documents) => documents['fixtures.json'].cases[0].request],
      ['contract.json', '/operations/0/responses/0/contentType', (documents) => documents['contract.json'].operations[0].responses[0]],
      ['fixtures.json', '/cases/0/expect/contentType', (documents) => documents['fixtures.json'].cases[0].expect],
      ['plan.json', '/mock/routes/0/contentType', (documents) => documents['plan.json'].mock.routes[0]],
    ]
    for (const [file, pointer, select] of sides) {
      const documents = makeDocuments()
      select(documents).contentType = hidden
      const result = await runDocuments(documents)
      assert.equal(result.code, 2, `${file}${pointer}`)
      assert.equal(result.report.status, 'incomplete', `${file}${pointer}`)
      assert.equal(result.report.summary.checked, 0, `${file}${pointer}`)
      assert.equal(result.report.findings.some((row) => row.ruleId === 'document-invalid'
        && row.location.file === file && row.location.pointer === pointer), true, `${file}${pointer}`)
      assert.equal(result.report.findings.some((row) => row.ruleId.endsWith('content-type-mismatch')), false, `${file}${pointer}`)
      assert.equal(result.stdout.includes(String.fromCharCode(0x200e)), false, `${file}${pointer}`)
    }

    const bothSides = makeDocuments()
    for (const [, , select] of sides) select(bothSides).contentType = hidden
    const both = await runDocuments(bothSides)
    assert.equal(both.code, 2)
    assert.equal(both.report.status, 'incomplete')
    assert.equal(both.report.summary.checked, 0)
    assert.equal(both.report.findings.some((row) => row.ruleId === 'document-invalid'), true)
  })
})

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

test('a fixture case id that renders empty cannot pass or appear as an empty reported id', async () => {
  await withPlan(async (base) => {
    const fixturesPath = join(base, 'fixtures.json')
    const fixtures = JSON.parse(await readFile(fixturesPath))
    fixtures.cases[0].id = String.fromCharCode(0x200e)
    await writeFile(fixturesPath, JSON.stringify(fixtures))

    const result = await cli(['--plan', join(base, 'plan.json'), '--no-call', '--json'], base)
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(report.run.cases, [])
    assert.equal(report.findings.some((row) => row.ruleId === 'document-invalid'
      && row.location.file === 'fixtures.json' && row.location.pointer === '/cases/0/id'), true)
  })
})

test('an invisible operation id on both comparison sides is invalid, not a matching operation', async () => {
  await withPlan(async (base) => {
    const invisible = String.fromCharCode(0x200e)
    const contractPath = join(base, 'contract.json')
    const fixturesPath = join(base, 'fixtures.json')
    const contract = JSON.parse(await readFile(contractPath))
    const fixtures = JSON.parse(await readFile(fixturesPath))
    contract.operations[0].id = invisible
    fixtures.cases[0].operationId = invisible
    await writeFile(contractPath, JSON.stringify(contract))
    await writeFile(fixturesPath, JSON.stringify(fixtures))

    const result = await cli(['--plan', join(base, 'plan.json'), '--no-call', '--json'], base)
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(report.run.cases, [])
    assert.equal(report.findings.some((row) => row.ruleId === 'document-invalid'
      && row.location.file === 'contract.json' && row.location.pointer === '/operations/0/id'), true)
    assert.equal(report.findings.some((row) => row.ruleId === 'document-invalid'
      && row.location.file === 'fixtures.json' && row.location.pointer === '/cases/0/operationId'), true)
  })
})

test('an invisible operation reference alone is invalid, not an absent operation finding', async () => {
  await withPlan(async (base) => {
    const fixturesPath = join(base, 'fixtures.json')
    const fixtures = JSON.parse(await readFile(fixturesPath))
    fixtures.cases[0].operationId = String.fromCharCode(0x200e)
    await writeFile(fixturesPath, JSON.stringify(fixtures))

    const result = await cli(['--plan', join(base, 'plan.json'), '--no-call', '--json'], base)
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((row) => row.ruleId === 'document-invalid'
      && row.location.pointer === '/cases/0/operationId'), true)
    assert.equal(report.findings.some((row) => row.ruleId === 'request-operation-unknown'), false)
  })
})

test('a fixture request method changed by rendering is invalid before method comparison', async () => {
  await withPlan(async (base) => {
    const fixturesPath = join(base, 'fixtures.json')
    const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'))
    const runMethod = async (method) => {
      fixtures.cases[0].request.method = method
      await writeFile(fixturesPath, JSON.stringify(fixtures))
      const result = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'], base)
      return { ...result, report: JSON.parse(result.stdout) }
    }

    const exact = await runMethod('GET')
    assert.equal(exact.code, 0)
    assert.equal(exact.report.status, 'pass')
    assert.equal(exact.report.summary.checked, 1)

    const different = await runMethod('POST')
    assert.equal(different.code, 1)
    assert.equal(different.report.status, 'fail')
    assert.equal(different.report.findings.some((row) => row.ruleId === 'request-method-mismatch'), true)

    const hidden = await runMethod(`GET${String.fromCharCode(0x200e)}`)
    assert.equal(hidden.code, 2)
    assert.equal(hidden.report.status, 'incomplete')
    assert.equal(hidden.report.summary.checked, 0)
    assert.equal(hidden.report.findings.some((row) => row.ruleId === 'document-invalid'
      && row.location.file === 'fixtures.json' && row.location.pointer === '/cases/0/request/method'), true)
    assert.equal(hidden.report.findings.some((row) => row.ruleId === 'request-method-mismatch'), false)
    assert.equal(hidden.stdout.includes(String.fromCharCode(0x200e)), false)
  })
})

test('an id with visible text remains legal when an invisible mark is stripped for display', async () => {
  await withPlan(async (base) => {
    const mark = String.fromCharCode(0x200e)
    const contractPath = join(base, 'contract.json')
    const fixturesPath = join(base, 'fixtures.json')
    const contract = JSON.parse(await readFile(contractPath))
    const fixtures = JSON.parse(await readFile(fixturesPath))
    contract.operations[0].id = `getThing${mark}`
    fixtures.cases[0].operationId = contract.operations[0].id
    fixtures.cases[0].id = `c${mark}`
    await writeFile(contractPath, JSON.stringify(contract))
    await writeFile(fixturesPath, JSON.stringify(fixtures))

    const result = await cli(['--plan', join(base, 'plan.json'), '--no-call', '--json'], base)
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(report.status, 'pass')
    assert.deepEqual(report.run.cases.map(({ id, operationId, verdict }) => ({ id, operationId, verdict })),
      [{ id: 'c', operationId: 'getThing', verdict: 'pass' }])
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
