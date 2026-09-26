import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Every documented bound, exercised from both sides.
 *
 * A limit tested only from above proves the message exists; it does not prove
 * the limit is where the documentation says it is. Each test below runs once at
 * the bound, where the run must complete, and once one step past it, where the
 * run must be `incomplete` with the limit named. A limit the configuration can
 * spell past is not a limit, so the caps are exercised too.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-limits-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base, args = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json', ...args], { cwd: base })
    return { code: 0, stdout, stderr, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, report: error.stdout === '' ? null : JSON.parse(error.stdout) }
  }
}

async function write(base, contract, fixtures, plan = {}) {
  await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
  await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures))
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...plan }))
}

function operation(id, path, bodySchema) {
  return {
    id,
    method: 'GET',
    path,
    responses: [{ status: 200, ...(bodySchema === undefined ? {} : { body: bodySchema }) }],
  }
}

function fixtureCase(id, operationId, path, body) {
  return {
    id,
    operationId,
    request: { method: 'GET', path },
    expect: { status: 200, ...(body === undefined ? {} : { body }) },
  }
}

const rules = (result) => result.report.findings.map((finding) => finding.ruleId)

test('maxDocumentBytes: at the bound the run completes, one byte under it does not', async () => {
  await withBase(async (base) => {
    await write(base, { contractVersion: '1', operations: [operation('a', '/a')] }, { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] })
    const sizes = await Promise.all(
      ['plan.json', 'contract.json', 'fixtures.json'].map(async (name) => (await stat(join(base, name))).size),
    )
    const largest = Math.max(...sizes)

    const atBound = await cli(base, ['--max-document-bytes', String(largest)])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.status, 'pass')

    const past = await cli(base, ['--max-document-bytes', String(largest - 1)])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(rules(past).includes('limit-document-bytes-exceeded'), true)
  })
})

test('maxOperations: at the bound the run completes, one under it does not', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a'), operation('b', '/b')] },
      { fixtureVersion: '1', cases: [fixtureCase('c1', 'a', '/a'), fixtureCase('c2', 'b', '/b')] },
    )

    const atBound = await cli(base, ['--max-operations', '2'])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.summary.operations, 2)

    const past = await cli(base, ['--max-operations', '1'])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(rules(past).includes('limit-operations-exceeded'), true)
  })
})

test('maxCases: at the bound the run completes, one under it does not', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a')] },
      { fixtureVersion: '1', cases: [fixtureCase('c1', 'a', '/a'), fixtureCase('c2', 'a', '/a')] },
    )

    const atBound = await cli(base, ['--max-cases', '2'])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.summary.cases, 2)

    const past = await cli(base, ['--max-cases', '1'])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(rules(past).includes('limit-cases-exceeded'), true)
  })
})

test('maxBodyBytes: at the bound the run completes, one byte under it does not', async () => {
  await withBase(async (base) => {
    const body = { note: 'abcdefghij' }
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a', { type: 'object' })] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a', body)] },
    )

    const atBound = await cli(base, ['--max-body-bytes', String(bytes)])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.summary.checked, 1)

    const past = await cli(base, ['--max-body-bytes', String(bytes - 1)])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(past.report.summary.skipped, 1)
    assert.equal(rules(past).includes('limit-body-bytes-exceeded'), true)
  })
})

test('maxBodyDepth: at the bound the run completes, one under it does not', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a', { type: 'object' })] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a', { one: { two: { three: 1 } } })] },
    )

    const atBound = await cli(base, ['--max-body-depth', '3'])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.summary.checked, 1)

    const past = await cli(base, ['--max-body-depth', '2'])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(rules(past).includes('limit-body-depth-exceeded'), true)
  })
})

test('maxSchemaDepth: at the bound the run completes, one under it does not', async () => {
  await withBase(async (base) => {
    const schema = { type: 'object', properties: { one: { type: 'object', properties: { two: { type: 'integer' } } } } }
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a', schema)] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a', { one: { two: 1 } })] },
    )

    const atBound = await cli(base, ['--max-schema-depth', '2'])
    assert.equal(atBound.code, 0)
    assert.equal(atBound.report.summary.checked, 1)

    const past = await cli(base, ['--max-schema-depth', '1'])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(rules(past).includes('limit-schema-depth-exceeded'), true)
  })
})

test('maxFindings: at the bound the report is whole, one under it is truncated and says so', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a', { type: 'object', additionalProperties: false, properties: {} })] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a', { one: 1, two: 2, three: 3 })] },
    )

    const atBound = await cli(base, ['--max-findings', '3'])
    assert.equal(atBound.code, 1)
    assert.equal(atBound.report.status, 'fail')
    assert.equal(atBound.report.findings.length, 3)

    const past = await cli(base, ['--max-findings', '2'])
    assert.equal(past.code, 2)
    assert.equal(past.report.status, 'incomplete')
    assert.equal(past.report.findings.length, 2)
    assert.equal(rules(past).includes('limit-findings-exceeded'), true)
  })
})

test('a limit above its hard cap is a configuration error with an empty stdout', async () => {
  await withBase(async (base) => {
    await write(base, { contractVersion: '1', operations: [operation('a', '/a')] }, { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] })
    const result = await cli(base, ['--max-cases', '5001'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error never had a subject to report on')
    assert.equal(result.stderr.includes('maxCases'), true)
  })
})

test('a limit of zero, a negative limit and a non-numeric limit are refused on the command line', async () => {
  await withBase(async (base) => {
    await write(base, { contractVersion: '1', operations: [operation('a', '/a')] }, { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] })
    for (const value of ['0', '-1', 'many', '1.5']) {
      const result = await cli(base, ['--max-cases', value])
      assert.equal(result.code, 2, value)
      assert.equal(result.stdout, '', value)
    }
  })
})

test('a limit configured in the plan is applied, and a misspelled one is refused', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a')] },
      { fixtureVersion: '1', cases: [fixtureCase('c1', 'a', '/a'), fixtureCase('c2', 'a', '/a')] },
      { limits: { maxCases: 1 } },
    )
    const applied = await cli(base)
    assert.equal(applied.code, 2)
    assert.equal(rules(applied).includes('limit-cases-exceeded'), true)

    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a')] },
      { fixtureVersion: '1', cases: [fixtureCase('c1', 'a', '/a')] },
      { limits: { maxCasses: 1 } },
    )
    const misspelled = await cli(base)
    assert.equal(misspelled.code, 2)
    assert.equal(misspelled.report.status, 'incomplete')
    assert.equal(rules(misspelled).includes('document-unknown-key'), true)
  })
})

test('a limit in the plan is really applied, not merely accepted', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a', { type: 'object' })] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a', { one: { two: { three: 1 } } })] },
      { limits: { maxBodyDepth: 2 } },
    )
    const applied = await cli(base)
    assert.equal(applied.code, 2)
    assert.equal(rules(applied).includes('limit-body-depth-exceeded'), true)

    // And the command line still wins over the plan.
    const overridden = await cli(base, ['--max-body-depth', '8'])
    assert.equal(overridden.code, 0)
    assert.equal(overridden.report.status, 'pass')
  })
})

test('a bad limit value in the plan is reported on stdout, with the key named', async () => {
  await withBase(async (base) => {
    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a')] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] },
      { limits: { maxCases: 0 } },
    )
    const zero = await cli(base)
    assert.equal(zero.code, 2)
    assert.equal(zero.report.status, 'incomplete')
    assert.equal(zero.report.findings.some((finding) => finding.location.pointer === '/limits/maxCases'), true)

    await write(
      base,
      { contractVersion: '1', operations: [operation('a', '/a')] },
      { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] },
      { limits: { maxCases: 999999 } },
    )
    const past = await cli(base)
    assert.equal(past.code, 2)
    assert.equal(past.report.findings.some((finding) => finding.location.pointer === '/limits/maxCases'), true)
  })
})

test('a limit given twice on the command line is a configuration error, not a last-wins', async () => {
  await withBase(async (base) => {
    await write(base, { contractVersion: '1', operations: [operation('a', '/a')] }, { fixtureVersion: '1', cases: [fixtureCase('c', 'a', '/a')] })
    const result = await cli(base, ['--max-cases', '5', '--max-cases', '1'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('--max-cases was given more than once'), true)
  })
})
