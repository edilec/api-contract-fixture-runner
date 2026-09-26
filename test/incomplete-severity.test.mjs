import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by consequence -- for the rules that also mark the run
 * `incomplete`.
 *
 * These rules exit 2 whatever their severity says, so an exit code alone cannot
 * pin them. Two other observables can, and both are literal here: the number of
 * errors `summary` counts, and the severity word the human report prints on the
 * rule's own line. Demoting one of these rules from `error` to `warning` moves
 * a number and changes `ERROR` to `WARNING`, and no coordinated edit of the
 * frozen table, the documented catalog and a map in the tests can put them back.
 *
 * As in `test/severity-decides.test.mjs`, this file imports nothing from `src`.
 * No rule table, no severity map, no parameterised expectation: every number
 * and every word below is written out at the assertion that uses it.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-incomplete-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', ...args], { cwd: base })
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }
  }
}

/** Fresh input data. A GET operation, so only the response body is ever validated. */
function contractWithBody(bodySchema, components) {
  return {
    contractVersion: '1',
    ...(components === undefined ? {} : { components: { schemas: components } }),
    operations: [
      {
        id: 'getThing',
        method: 'GET',
        path: '/things/1',
        responses: [{ status: 200, contentType: 'application/json', body: bodySchema }],
      },
    ],
  }
}

function fixturesWithBody(body) {
  return {
    fixtureVersion: '1',
    cases: [
      {
        id: 'the-case',
        operationId: 'getThing',
        request: { method: 'GET', path: '/things/1' },
        expect: { status: 200, contentType: 'application/json', body },
      },
    ],
  }
}

async function writeAll(base, contract, fixtures, plan = {}) {
  await writeFile(join(base, 'contract.json'), JSON.stringify(contract, null, 2))
  await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures, null, 2))
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json', ...plan }, null, 2))
}

test('document-unreadable: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'absent.json', fixtures: 'fixtures.json' }))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.checked, 0)
    assert.equal(stderr.includes('ERROR   absent.json/ document-unreadable'), true)
  })
})

test('document-not-utf8: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    await writeFile(join(base, 'contract.json'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   contract.json/ document-not-utf8'), true)
  })
})

test('document-not-json: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    await writeFile(join(base, 'fixtures.json'), '{ "fixtureVersion": ')
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/ document-not-json'), true)
  })
})

test('document-invalid: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    contract.contractVersion = '2'
    await writeAll(base, contract, fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   contract.json/contractVersion document-invalid'), true)
  })
})

test('document-unknown-key: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    contract.operatoins = []
    await writeAll(base, contract, fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   contract.json/operatoins document-unknown-key'), true)
  })
})

test('document-outside-root: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await withBase(async (outside) => {
      await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
      const smuggled = join(outside, 'contract.json')
      await writeFile(smuggled, JSON.stringify(contractWithBody({ type: 'object' })))
      await rm(join(base, 'contract.json'))
      await symlink(smuggled, join(base, 'contract.json'))

      const { code, report, stderr } = await cli(base, [])
      assert.equal(code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.errors, 2)
      assert.equal(stderr.includes('ERROR   contract.json/ document-outside-root'), true)

      // The refusal is unread: no content from the outside file reaches the report.
      assert.equal(JSON.stringify(report).includes('getThing'), false)
    })
  })
})

test('no-cases-checked: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), { fixtureVersion: '1', cases: [] })
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 1)
    assert.equal(report.summary.checked, 0)
    assert.equal(stderr.includes('ERROR   plan.json/cases no-cases-checked'), true)
  })
})

test('mock-not-declared: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, ['--call'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.checked, 1)
    assert.equal(report.summary.liveCalls, 0)
    assert.equal(stderr.includes('ERROR   plan.json/mock mock-not-declared'), true)
  })
})

test('mock-target-refused: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}), {
      call: true,
      mock: { mode: 'in-process', baseUrl: 'https://api.example.com/v1', routes: [{ operationId: 'getThing', status: 200 }] },
    })
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.liveCalls, 0)
    assert.equal(stderr.includes('ERROR   plan.json/mock/baseUrl mock-target-refused'), true)
  })
})

test('a refused mock URL is reported by source field without echoing URL parts', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    const fixtures = fixturesWithBody({})
    const route = { operationId: 'getThing', status: 200, contentType: 'application/json', body: {} }
    await writeAll(base, contract, fixtures, {
      call: true,
      mock: { mode: 'in-process', baseUrl: 'http://127.0.0.1:9099', routes: [route] },
    })
    const good = await cli(base, [])
    assert.equal(good.code, 0)
    assert.equal(good.report.status, 'pass')
    assert.equal(good.report.summary.liveCalls, 1)

    const canary = 'SYNTHETIC_SECRET_CANARY'
    for (const baseUrl of [
      `https://api.example.com/private?token=${canary}`,
      `https://${canary.toLowerCase()}.example.com/private`,
      `not an absolute URL ${canary}`,
      `ftp://127.0.0.1/private/${canary}`,
      `http://user:${canary}@127.0.0.1/private`,
    ]) {
      await writeAll(base, contract, fixtures, {
        call: true,
        mock: { mode: 'in-process', baseUrl, routes: [route] },
      })
      const bad = await cli(base, [])
      assert.equal(bad.code, 2)
      assert.equal(bad.report.status, 'incomplete')
      assert.equal(bad.report.summary.checked, 1, 'the fixture contract check still completed; only the requested mock evidence is missing')
      assert.equal(bad.report.summary.liveCalls, 0)
      const finding = bad.report.findings.find((row) => row.ruleId === 'mock-target-refused'
        && row.location.pointer === '/mock/baseUrl')
      assert.ok(finding)
      assert.equal(bad.report.run.mock.called, false)
      assert.equal(bad.report.run.mock.baseUrl, '[redacted]')
      assert.equal(JSON.stringify(bad.report).toLowerCase().includes(canary.toLowerCase()), false)
      assert.equal(bad.stderr.includes('mock-target-refused'), true)
      assert.equal(bad.stderr.toLowerCase().includes(canary.toLowerCase()), false)
    }
  })
})

test('live-route-missing: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}), {
      call: true,
      mock: { mode: 'in-process', baseUrl: 'http://127.0.0.1:9099', routes: [] },
    })
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.summary.skipped, 1)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/operationId live-route-missing'), true)
  })
})

test('schema-keyword-unsupported: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ oneOf: [{ type: 'object' }] }), fixturesWithBody({ a: 1 }))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.summary.skipped, 1)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body schema-keyword-unsupported'), true)
  })
})

test('schema-dialect-unsupported: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }),
      fixturesWithBody({ a: 1 }),
    )
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body schema-dialect-unsupported'), true)
  })
})

test('schema-dialect-unsupported: a dialect the contract declares for itself stops the run too', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    contract.jsonSchemaDialect = 'http://json-schema.org/draft-07/schema#'
    await writeAll(base, contract, fixturesWithBody({ a: 1 }))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.summary.checked, 0)
    assert.equal(stderr.includes('ERROR   contract.json/jsonSchemaDialect schema-dialect-unsupported'), true)
  })
})

test('an unsupported contract dialect is incomplete without echoing its short value', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    contract.jsonSchemaDialect = 'https://json-schema.org/draft/2020-12/schema'
    await writeAll(base, contract, fixturesWithBody({ a: 1 }))
    const good = await cli(base, [])
    assert.equal(good.code, 0)
    assert.equal(good.report.status, 'pass')
    assert.equal(good.report.summary.checked, 1)

    const canary = 'token=SYNTHETIC_SECRET_CANARY'
    contract.jsonSchemaDialect = canary
    await writeAll(base, contract, fixturesWithBody({ a: 1 }))
    const bad = await cli(base, [])
    assert.equal(bad.code, 2)
    assert.equal(bad.report.status, 'incomplete')
    assert.equal(bad.report.summary.checked, 0)
    const finding = bad.report.findings.find((row) => row.ruleId === 'schema-dialect-unsupported'
      && row.location.pointer === '/jsonSchemaDialect')
    assert.ok(finding)
    assert.equal(JSON.stringify(bad.report).includes(canary), false)
    assert.equal(bad.stderr.includes('schema-dialect-unsupported'), true)
    assert.equal(bad.stderr.includes(canary), false)
  })
})

test('the dialect this tool does implement, declared for the whole contract, checks the fixtures', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object', required: ['a'], properties: { a: { type: 'integer' } } })
    contract.jsonSchemaDialect = 'https://json-schema.org/draft/2020-12/schema'
    await writeAll(base, contract, fixturesWithBody({ a: 1 }))
    const { code, report } = await cli(base, ['--json'])

    assert.equal(code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.equal(report.summary.passed, 1)
  })
})

test('schema-format-unsupported: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ type: 'object', properties: { host: { type: 'string', format: 'hostname' } } }),
      fixturesWithBody({ host: 'not a hostname' }),
    )
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/host schema-format-unsupported'), true)
  })
})

test('schema-pattern-refused: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ type: 'object', properties: { sku: { type: 'string', pattern: '^(a+)+$' } } }),
      fixturesWithBody({ sku: 'zzz' }),
    )
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/sku schema-pattern-refused'), true)
  })
})

test('schema-ref-unresolved: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ $ref: '#/components/schemas/Absent' }, { Present: { type: 'object' } }), fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body schema-ref-unresolved'), true)
  })
})

test('schema-ref-cycle: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ $ref: '#/components/schemas/Node' }, {
        Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
      }),
      fixturesWithBody({ child: { child: {} } }),
    )
    const { code, report, stderr } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/child schema-ref-cycle'), true)
  })
})

test('limit-document-bytes-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, ['--max-document-bytes', '20'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   plan.json/ limit-document-bytes-exceeded'), true)
  })
})

test('limit-operations-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    const contract = contractWithBody({ type: 'object' })
    contract.operations.push({ id: 'other', method: 'GET', path: '/other', responses: [{ status: 200 }] })
    await writeAll(base, contract, fixturesWithBody({}))
    const { code, report, stderr } = await cli(base, ['--max-operations', '1'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   contract.json/operations limit-operations-exceeded'), true)
  })
})

test('limit-cases-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    const fixtures = fixturesWithBody({})
    fixtures.cases.push({ ...fixtures.cases[0], id: 'second' })
    await writeAll(base, contractWithBody({ type: 'object' }), fixtures)
    const { code, report, stderr } = await cli(base, ['--max-cases', '1'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases limit-cases-exceeded'), true)
  })
})

test('limit-body-bytes-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({ note: 'x'.repeat(200) }))
    const { code, report, stderr } = await cli(base, ['--max-body-bytes', '30'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.summary.skipped, 1)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body limit-body-bytes-exceeded'), true)
  })
})

test('limit-body-depth-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({ a: { b: { c: { d: 1 } } } }))
    const { code, report, stderr } = await cli(base, ['--max-body-depth', '2'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body limit-body-depth-exceeded'), true)
  })
})

test('limit-schema-depth-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'integer' } } } } } } }),
      fixturesWithBody({ a: { b: { c: 1 } } }),
    )
    const { code, report, stderr } = await cli(base, ['--max-schema-depth', '2'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(stderr.includes('ERROR   fixtures.json/cases/0/expect/body/a/b/c limit-schema-depth-exceeded'), true)
  })
})

test('limit-findings-exceeded: the run is incomplete and the rule prints as an error', async () => {
  await withBase(async (base) => {
    await writeAll(
      base,
      contractWithBody({ type: 'object', additionalProperties: false, properties: {} }),
      fixturesWithBody({ one: 1, two: 2, three: 3, four: 4 }),
    )
    const { code, report, stderr } = await cli(base, ['--max-findings', '2'])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 2)
    assert.equal(report.findings.length, 2)
    assert.equal(stderr.includes('ERROR   plan.json/ limit-findings-exceeded'), true)
  })
})

test('an unreadable input still produces a report on stdout, and the plan file is left alone', async () => {
  await withBase(async (base) => {
    await writeAll(base, contractWithBody({ type: 'object' }), fixturesWithBody({}))
    const before = await readFile(join(base, 'fixtures.json'), 'utf8')
    await writeFile(join(base, 'contract.json'), 'not json at all')
    const { code, report } = await cli(base, [])

    assert.equal(code, 2)
    assert.equal(report.tool, 'api-contract-fixture-runner')
    assert.equal(report.schemaVersion, '1')
    assert.equal(await readFile(join(base, 'fixtures.json'), 'utf8'), before)
  })
})
