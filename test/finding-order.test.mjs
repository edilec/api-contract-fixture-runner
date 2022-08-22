import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY } from '../src/rules.mjs'

/**
 * The finding order, pinned at every site that decides it.
 *
 * Scanning the source for a comparator name proves nothing: `Intl.Collator`
 * collates like `localeCompare`, spells like neither, and either of them can be
 * substituted at one call site at a time while a grep over the source stays
 * green. Pinning the `byCodeUnit` helper proves nothing either, for the same
 * reason -- the helper is not the call site.
 *
 * This tool has exactly six sites that order anything reaching output: the five
 * keys of `compareFindings` (file, pointer, ruleId, message, evidence) and the
 * unsupported-keyword list that `src/schema.mjs` renders into one finding. Each
 * one below is driven through the real binary with values whose collation order
 * genuinely disagrees with their code-unit order, and the exact emitted
 * sequence is asserted.
 *
 * The disagreements used: `Z` sorts before `a` by code unit (0x5A before 0x61)
 * and after it by English collation; `a-b` sorts before `a_b` by code unit
 * (0x2D before 0x5F) and after it by collation, because collation treats the
 * hyphen as ignorable punctuation.
 *
 * The ruleId site is the one exception, and it is proved rather than skipped:
 * rule ids are drawn from a closed `[a-z0-9-]` alphabet on which the two
 * orderings agree for every ordered pair of the real ids, so substituting a
 * collator there provably changes no output. That is recorded below as an
 * equivalent mutant, by enumeration.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-order-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base, args = []) {
  try {
    const { stdout } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json', ...args], { cwd: base })
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) }
  }
}

const files = (report) => report.findings.map((finding) => finding.location.file)
const pointers = (report) => report.findings.map((finding) => finding.location.pointer)

test('an English collator really does order these strings the other way', () => {
  const collator = new Intl.Collator('en')
  const sample = ['Z', 'a', 'a-b', 'a_b']

  assert.equal([...sample].sort((left, right) => collator.compare(left, right)).join(' '), 'a a_b a-b Z')
  assert.equal([...sample].sort().join(' '), 'Z a a-b a_b', 'otherwise every test below would prove nothing')
})

/* ---- site 1: location.file ---- */

async function twoDocumentsNamed(contractName, fixturesName) {
  return withBase(async (base) => {
    await writeFile(
      join(base, contractName),
      JSON.stringify({
        contractVersion: '1',
        unknownInContract: 1,
        operations: [{ id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200 }] }],
      }),
    )
    await writeFile(
      join(base, fixturesName),
      JSON.stringify({
        fixtureVersion: '1',
        unknownInFixtures: 1,
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200 } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: contractName, fixtures: fixturesName }))
    return cli(base)
  })
}

test('findings order by location.file in code units, through the real binary', async () => {
  const upper = await twoDocumentsNamed('Z.json', 'a.json')
  assert.equal(upper.code, 2)
  assert.deepEqual(files(upper.report), ['Z.json', 'a.json', 'plan.json'])

  const punctuated = await twoDocumentsNamed('a-b.json', 'a_b.json')
  assert.equal(punctuated.code, 2)
  assert.deepEqual(files(punctuated.report), ['a-b.json', 'a_b.json', 'plan.json'])
})

/* ---- site 2: location.pointer ---- */

async function bodyWithProperties(names) {
  return withBase(async (base) => {
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          {
            id: 'getThing',
            method: 'GET',
            path: '/t',
            responses: [{ status: 200, body: { type: 'object', additionalProperties: false, properties: {} } }],
          },
        ],
      }),
    )
    const body = {}
    for (const name of names) body[name] = 1
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200, body } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))
    return cli(base)
  })
}

test('findings order by location.pointer in code units, through the real binary', async () => {
  // Written into the document in the order collation would produce, so a
  // collator at this site would leave them where they started.
  const upper = await bodyWithProperties(['a', 'Z'])
  assert.equal(upper.code, 1)
  assert.deepEqual(pointers(upper.report), ['/cases/0/expect/body/Z', '/cases/0/expect/body/a'])

  const punctuated = await bodyWithProperties(['a_b', 'a-b'])
  assert.equal(punctuated.code, 1)
  assert.deepEqual(pointers(punctuated.report), ['/cases/0/expect/body/a-b', '/cases/0/expect/body/a_b'])
})

/* ---- site 3: ruleId ---- */

test('the ruleId tie-break is reached, and it is an equivalent mutant proved by enumeration', async () => {
  const result = await withBase(async (base) => {
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
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 418 } }],
      }),
    )
    await writeFile(
      join(base, 'plan.json'),
      JSON.stringify({
        contract: 'contract.json',
        fixtures: 'fixtures.json',
        call: true,
        mock: { mode: 'in-process', baseUrl: 'http://127.0.0.1:9099', routes: [{ operationId: 'getThing', status: 200 }] },
      }),
    )
    return cli(base)
  })

  // Two findings at the same file and the same pointer: only the rule id
  // separates them, so this site really is exercised.
  assert.equal(result.code, 1)
  assert.deepEqual(pointers(result.report), ['/cases/0/expect/status', '/cases/0/expect/status'])
  assert.deepEqual(result.report.findings.map((finding) => finding.ruleId), [
    'live-status-mismatch',
    'response-status-undeclared',
  ])

  // And the proof that a collator here changes nothing: every ordered pair of
  // every real rule id sorts the same way under both orderings. Rule ids are
  // drawn from [a-z0-9-] and this enumeration is what makes that claim a fact
  // rather than a hope -- a future id that disagrees fails here.
  const ids = Object.keys(RULE_SEVERITY)
  const collator = new Intl.Collator('en')
  const sign = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0)
  let compared = 0
  for (const left of ids) {
    for (const right of ids) {
      if (left === right) continue
      assert.equal(sign(collator.compare(left, right)), left < right ? -1 : 1, `${left} vs ${right}`)
      compared += 1
    }
  }
  assert.equal(compared, ids.length * (ids.length - 1))
  assert.equal(compared > 1000, true, 'the enumeration must actually be large')
})

/* ---- site 4: message ---- */

async function unexercisedOperations(ids) {
  return withBase(async (base) => {
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          { id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200 }] },
          ...ids.map((id, index) => ({ id, method: 'GET', path: `/u${index}`, responses: [{ status: 200 }] })),
        ],
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
    return cli(base)
  })
}

test('findings order by message in code units, through the real binary', async () => {
  const upper = await unexercisedOperations(['a', 'Z'])
  assert.equal(upper.code, 0)
  assert.deepEqual(upper.report.findings.map((finding) => finding.location.pointer), ['/operations', '/operations'])
  assert.deepEqual(upper.report.findings.map((finding) => finding.ruleId), [
    'operation-without-fixture',
    'operation-without-fixture',
  ])
  assert.equal(upper.report.findings[0].message.startsWith('Operation "Z" '), true)
  assert.equal(upper.report.findings[1].message.startsWith('Operation "a" '), true)

  const punctuated = await unexercisedOperations(['a_b', 'a-b'])
  assert.equal(punctuated.report.findings[0].message.startsWith('Operation "a-b" '), true)
  assert.equal(punctuated.report.findings[1].message.startsWith('Operation "a_b" '), true)
})

/* ---- site 5: evidence ---- */

async function missingRequiredHeaders(names) {
  return withBase(async (base) => {
    const headers = {}
    for (const name of names) headers[name] = { required: true }
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [{ id: 'getThing', method: 'GET', path: '/t', request: { headers }, responses: [{ status: 200 }] }],
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
    return cli(base)
  })
}

test('findings order by evidence in code units, through the real binary', async () => {
  const upper = await missingRequiredHeaders(['a', 'Z'])
  assert.equal(upper.code, 1)

  // Same file, same pointer, same rule, same message: only the evidence can
  // separate these two, which is what makes this site reachable at all.
  assert.deepEqual(upper.report.findings.map((finding) => finding.location.pointer), [
    '/cases/0/request/headers',
    '/cases/0/request/headers',
  ])
  assert.equal(upper.report.findings[0].message, upper.report.findings[1].message)
  assert.deepEqual(upper.report.findings.map((finding) => finding.evidence), ['Z', 'a'])

  const punctuated = await missingRequiredHeaders(['a_b', 'a-b'])
  assert.deepEqual(punctuated.report.findings.map((finding) => finding.evidence), ['a-b', 'a_b'])
})

/* ---- site 6: the unsupported-keyword list ---- */

test('the unsupported keyword list is rendered in code-unit order, through the real binary', async () => {
  const result = await withBase(async (base) => {
    await writeFile(
      join(base, 'contract.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          {
            id: 'getThing',
            method: 'GET',
            path: '/t',
            responses: [{ status: 200, body: { a: 1, Z: 1, a_b: 1, 'a-b': 1 } }],
          },
        ],
      }),
    )
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200, body: {} } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))
    return cli(base)
  })

  assert.equal(result.code, 2)
  const gap = result.report.findings.find((finding) => finding.ruleId === 'schema-keyword-unsupported')
  assert.equal(gap.evidence, '#: Z, a, a-b, a_b')
})

/* ---- the whole order, end to end ---- */

test('the documented sort key is file, then pointer, then ruleId, then message, then evidence', async () => {
  const result = await withBase(async (base) => {
    await writeFile(
      join(base, 'Z.json'),
      JSON.stringify({
        contractVersion: '1',
        operations: [
          { id: 'getThing', method: 'GET', path: '/t', request: { headers: { a: { required: true }, Z: { required: true } } }, responses: [{ status: 200 }] },
          { id: 'a', method: 'GET', path: '/u', responses: [{ status: 200 }] },
          { id: 'Z', method: 'GET', path: '/v', responses: [{ status: 200 }] },
        ],
      }),
    )
    await writeFile(
      join(base, 'a.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200 } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'Z.json', fixtures: 'a.json' }))
    return cli(base)
  })

  assert.equal(result.code, 1)
  assert.deepEqual(
    result.report.findings.map((finding) => `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.evidence ?? ''}`),
    [
      'Z.json/operations operation-without-fixture ',
      'Z.json/operations operation-without-fixture ',
      'a.json/cases/0/request/headers request-header-missing Z',
      'a.json/cases/0/request/headers request-header-missing a',
    ],
  )
  assert.equal(result.report.findings[0].message.startsWith('Operation "Z" '), true)
  assert.equal(result.report.findings[1].message.startsWith('Operation "a" '), true)
})
