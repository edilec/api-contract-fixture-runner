import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { STRIPPED_RANGES } from '../src/text.mjs'

/**
 * Sanitisation, proved at the report rather than at the helper.
 *
 * Four tools in this catalog stripped C0 and the line separators and let the
 * C1 range through, and one of them sanitised its evidence field carefully
 * while an identifier carrying a newline forged whole lines in the report. So
 * every class below is driven through the real binary, and the character
 * arrives through an **operation id** and a **case id** -- identifiers, not
 * excerpts -- as well as through a body value.
 *
 * The characters are built with `String.fromCharCode`; no escape sequence for
 * any of them appears in this file, so an editor cannot turn one into a literal.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

const NEWLINE = String.fromCharCode(10)

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-sanitise-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(base, args = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', ...args], { cwd: base })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/**
 * An operation id and a case id that both carry the hostile character, in
 * documents chosen so that both of them are **printed**.
 *
 * An earlier version of this helper produced findings that named neither id:
 * every `stderr.includes(character) === false` below was then true because
 * nothing had been written there to begin with, and half this file could not
 * fail. The documents are now built so that the human report has to print both.
 * `request-header-missing` names the operation, `duplicate-case-id` quotes the
 * case id, and `operation-without-fixture` names a second operation that
 * carries the character too -- and `SANITISED_OPERATION_ID` and
 * `SANITISED_CASE_ID` are asserted present, so the day a message stops naming
 * an id this test says so instead of quietly passing.
 */
const SANITISED_OPERATION_ID = 'get Thing'
const SANITISED_CASE_ID = 'case one'

async function runWithIdentifier(base, character) {
  const operationId = `get${character}Thing`
  const caseId = `case${character}one`
  await writeFile(
    join(base, 'contract.json'),
    JSON.stringify({
      contractVersion: '1',
      operations: [
        {
          id: operationId,
          method: 'GET',
          path: '/t',
          request: { headers: { 'X-Required': { required: true } } },
          responses: [{ status: 200 }],
        },
        { id: `unexercised${character}operation`, method: 'GET', path: '/u', responses: [{ status: 200 }] },
      ],
    }),
  )
  await writeFile(
    join(base, 'fixtures.json'),
    JSON.stringify({
      fixtureVersion: '1',
      cases: [
        { id: caseId, operationId, request: { method: 'GET', path: '/t' }, expect: { status: 200 } },
        { id: caseId, operationId, request: { method: 'GET', path: '/t' }, expect: { status: 200 } },
      ],
    }),
  )
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))
  return cli(base)
}

test('every stripped class is removed when it arrives through an identifier', async () => {
  for (const range of STRIPPED_RANGES) {
    for (const code of [range.first, range.last]) {
      const character = String.fromCharCode(code)
      await withBase(async (base) => {
        const { stdout, stderr } = await runWithIdentifier(base, character)

        assert.equal(stdout.includes(character), false, `U+${code.toString(16)} must not reach stdout (${range.name})`)
        assert.equal(stderr.includes(character), false, `U+${code.toString(16)} must not reach stderr (${range.name})`)

        // Both ids did reach both streams, sanitised. Without this the two
        // assertions above would hold for a report that printed neither.
        assert.equal(stderr.includes(SANITISED_OPERATION_ID), true, `the operation id must be printed (${range.name})`)
        assert.equal(stderr.includes(SANITISED_CASE_ID), true, `the case id must be printed (${range.name})`)
        assert.equal(stdout.includes(SANITISED_OPERATION_ID), true, `the operation id must be reported (${range.name})`)
        assert.equal(stdout.includes(SANITISED_CASE_ID), true, `the case id must be reported (${range.name})`)
      })
    }
  }
})

test('a newline in a case id cannot forge a line in the human report', async () => {
  await withBase(async (base) => {
    const { stderr } = await runWithIdentifier(base, NEWLINE)
    const lines = stderr.trimEnd().split(NEWLINE)

    // The forged line would have to come from somewhere: both ids are printed.
    assert.equal(stderr.includes(SANITISED_OPERATION_ID), true)
    assert.equal(stderr.includes(SANITISED_CASE_ID), true)

    // Four summary lines, then exactly one line per finding. A forged newline
    // would show up here as an extra line that starts with none of the words a
    // report line can start with.
    for (const line of lines.slice(4)) {
      const first = line.split(' ')[0]
      assert.equal(['ERROR', 'WARNING', 'INFO', 'incomplete:'].includes(first), true, `unexpected line: ${line}`)
    }
  })
})

test('a right-to-left override in an identifier does not reverse the report', async () => {
  await withBase(async (base) => {
    const { stdout, stderr } = await runWithIdentifier(base, String.fromCharCode(0x202e))
    assert.equal(stdout.includes(String.fromCharCode(0x202e)), false)
    assert.equal(stderr.includes(String.fromCharCode(0x202e)), false)
    assert.equal(stderr.includes(SANITISED_OPERATION_ID), true)
    assert.equal(stderr.includes(SANITISED_CASE_ID), true)
  })
})

test('a hostile body key keeps a safe pointer while its value is reported by kind only', async () => {
  await withBase(async (base) => {
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
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [
          {
            id: 'c',
            operationId: 'getThing',
            request: { method: 'GET', path: '/t' },
            expect: { status: 200, body: { [`k${String.fromCharCode(0x0085)}ey`]: `v${String.fromCharCode(0x2028)}alue` } },
          },
        ],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const { code, stdout, stderr } = await cli(base)
    assert.equal(code, 1)
    assert.equal(stdout.includes(String.fromCharCode(0x0085)), false, 'NEL in a property name')
    assert.equal(stdout.includes(String.fromCharCode(0x2028)), false, 'U+2028 in a property value')
    assert.equal(stderr.includes(String.fromCharCode(0x0085)), false)
    assert.equal(stderr.includes(String.fromCharCode(0x2028)), false)

    // The pointer still identifies the field: the character became a space
    // rather than vanishing, so two keys do not collapse into one. The value
    // itself is not copied into diagnostic evidence.
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'fail')
    assert.equal(report.findings[0].ruleId, 'response-body-mismatch')
    assert.equal(report.findings[0].location.pointer, '/cases/0/expect/body/k ey')
    assert.equal(report.findings[0].evidence, 'string')
  })
})

test('a hostile character in the declared document path is stripped from location.file', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'contract.json'), JSON.stringify({ contractVersion: '1', operations: [] }))
    await writeFile(join(base, 'fixtures.json'), JSON.stringify({ fixtureVersion: '1', cases: [] }))
    await writeFile(
      join(base, 'plan.json'),
      JSON.stringify({ contract: `contract${String.fromCharCode(0x009b)}.json`, fixtures: 'fixtures.json' }),
    )

    const { code, stdout } = await cli(base, ['--json'])
    assert.equal(code, 2)
    assert.equal(stdout.includes(String.fromCharCode(0x009b)), false, '8-bit CSI in a path')
    const report = JSON.parse(stdout)
    assert.equal(report.findings.some((finding) => finding.location.file === 'contract .json'), true)
  })
})

test('stdout stays parseable JSON however hostile the input is', async () => {
  for (const code of [0x0000, 0x000a, 0x001b, 0x007f, 0x0085, 0x009b, 0x2028, 0x2029, 0x202e, 0x2066]) {
    await withBase(async (base) => {
      const { stdout } = await runWithIdentifier(base, String.fromCharCode(code))
      const report = JSON.parse(stdout)
      assert.equal(report.tool, 'api-contract-fixture-runner')
    })
  }
})
