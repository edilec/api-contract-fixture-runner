import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Two runs over the same bytes produce the same stdout, on any machine.
 *
 * The byte-identity test is the real one. The source scan that follows it is
 * support, not proof: a grep for `localeCompare` is exactly the guard this
 * catalog found to be worthless on its own, because `Intl.Collator` drifts
 * identically and spells differently. The ordering that matters is pinned
 * behaviourally in `test/finding-order.test.mjs`.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

async function cli(args, environment) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory, env: { ...process.env, ...environment } })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code, stdout: error.stdout }
  }
}

test('the same plan produces byte-identical stdout twice', async () => {
  const first = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  const second = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  assert.equal(first.code, 0)
  assert.equal(first.stdout, second.stdout)

  const brokenFirst = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  const brokenSecond = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  assert.equal(brokenFirst.code, 1)
  assert.equal(brokenFirst.stdout, brokenSecond.stdout)
})

test('the locale environment does not change a byte of the output', async () => {
  const posix = await cli(['--plan', 'examples/broken/plan.json', '--json'], { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' })
  const turkish = await cli(['--plan', 'examples/broken/plan.json', '--json'], { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' })

  assert.equal(posix.code, 1)
  assert.equal(turkish.code, 1)
  assert.equal(posix.stdout, turkish.stdout)
})

/**
 * Anything that looks like a reading of a wall clock.
 *
 * The earlier spelling demanded exactly three fractional digits and a literal
 * `Z`, so a clock printed to whole seconds, to a local offset, or as an epoch
 * number walked straight past it. A negative assertion is only as good as its
 * detector, so the shapes this one must catch are asserted below before it is
 * pointed at the report.
 */
const WALL_CLOCK = /\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}|(?<!\d)1[5-9]\d{8}(\d{3})?(?!\d)/

test('the wall-clock detector catches the shapes a clock is printed in', () => {
  for (const shape of [
    '"generatedAt":"2026-02-03T09:15:00.123Z"',
    '"generatedAt":"2026-02-03T09:15:00Z"',
    '"generatedAt":"2026-02-03T09:15:00+05:30"',
    '"generatedAt":"2026-02-03T09:15"',
    '"generatedAt":"2026-02-03 09:15:00"',
    '"startedAt":1770000000000',
    '"startedAt":1770000000',
  ]) {
    assert.equal(WALL_CLOCK.test(shape), true, shape)
  }

  for (const shape of [
    '"id":"6f1c2a10-5b8d-4f2e-9a21-0c7d3e5b91aa"',
    '"status":201,"maxBodyBytes":1048576',
    '"pointer":"/cases/10/expect/body"',
    '"placedAt":"2026-02-03"',
  ]) {
    assert.equal(WALL_CLOCK.test(shape), false, shape)
  }
})

test('the report carries no timestamp, and nothing in it changes between runs', async () => {
  const { stdout } = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  const report = JSON.parse(stdout)
  const serialized = JSON.stringify(report)

  assert.equal(WALL_CLOCK.test(serialized), false, 'no wall-clock timestamp')
  assert.equal(Object.hasOwn(report, 'generatedAt'), false)
  assert.equal(Object.hasOwn(report.summary, 'durationMs'), false)
})

test('the source reaches for no clock, no randomness and no locale comparison', async () => {
  const names = await readdir(join(projectDirectory, 'src'))
  const sources = [join(projectDirectory, 'bin/api-contract-fixture-runner.mjs'), ...names.map((name) => join(projectDirectory, 'src', name))]

  for (const file of sources) {
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes('localeCompare'), false, `${file}: localeCompare`)
    assert.equal(text.includes('toLocaleLowerCase'), false, `${file}: toLocaleLowerCase`)
    assert.equal(text.includes('toLocaleUpperCase'), false, `${file}: toLocaleUpperCase`)
    assert.equal(/\bIntl\./.test(text), false, `${file}: Intl`)
    assert.equal(/\bDate\.now\b/.test(text), false, `${file}: Date.now`)
    assert.equal(/\bnew Date\b/.test(text), false, `${file}: new Date`)
    assert.equal(/\bMath\.random\b/.test(text), false, `${file}: Math.random`)
    assert.equal(/\bperformance\.now\b/.test(text), false, `${file}: performance.now`)
    assert.equal(/\breaddir\b/.test(text), false, `${file}: directory enumeration`)
    assert.equal(/\bsetTimeout\b/.test(text), false, `${file}: setTimeout`)
    assert.equal(/\bprocess\.env\b/.test(text), false, `${file}: process.env`)
  }
})

test('the order of keys inside a fixture body does not change the report', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-determinism-'))
  try {
    const contract = {
      contractVersion: '1',
      operations: [
        {
          id: 'getThing',
          method: 'GET',
          path: '/t',
          responses: [{ status: 200, body: { type: 'object', additionalProperties: false, properties: {} } }],
        },
      ],
    }
    const caseFor = (body) => ({
      fixtureVersion: '1',
      cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200, body } }],
    })

    await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    await writeFile(join(base, 'fixtures.json'), JSON.stringify(caseFor({ zebra: 1, apple: 2, Mango: 3 })))
    const forwards = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'])

    await writeFile(join(base, 'fixtures.json'), JSON.stringify(caseFor({ Mango: 3, apple: 2, zebra: 1 })))
    const backwards = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'])

    const pointersOf = (result) => JSON.parse(result.stdout).findings.map((finding) => finding.location.pointer)
    assert.deepEqual(pointersOf(forwards), [
      '/cases/0/expect/body/Mango',
      '/cases/0/expect/body/apple',
      '/cases/0/expect/body/zebra',
    ])
    assert.deepEqual(pointersOf(forwards), pointersOf(backwards))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the file the plan declares, not the directory listing, decides what is read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-determinism-'))
  try {
    const contract = {
      contractVersion: '1',
      operations: [{ id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200 }] }],
    }
    await writeFile(join(base, 'contract.json'), JSON.stringify(contract))
    await writeFile(join(base, 'aaa-decoy.json'), '{ this is not json')
    await writeFile(join(base, 'zzz-decoy.json'), '{ neither is this')
    await writeFile(
      join(base, 'fixtures.json'),
      JSON.stringify({
        fixtureVersion: '1',
        cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200 } }],
      }),
    )
    await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }))

    const { code, stdout } = await cli(['--plan', join(base, 'plan.json'), '--label', 'plan.json', '--json'])
    assert.equal(code, 0)
    assert.equal(JSON.parse(stdout).status, 'pass')
    assert.equal(stdout.includes('decoy'), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
