import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Path identity: the inode, not the path.
 *
 * `realpath` resolves a symbolic link, so it catches a destination that *points
 * at* an input. It cannot catch a **hard link**, because a hard link has no
 * target: two names for one inode resolve to two different real paths, a
 * real-path comparison sees two different files, and the run writes its report
 * over its own contract. One tool in this catalog destroyed its own input
 * exactly this way.
 *
 * So the refusal compares `dev` and `ino`. The first test below asserts both
 * halves: that the real paths genuinely differ (so a real-path check would
 * have passed) and that the write was refused anyway.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-contract-fixture-runner.mjs')

const CONTRACT = {
  contractVersion: '1',
  operations: [{ id: 'getThing', method: 'GET', path: '/t', responses: [{ status: 200 }] }],
}
const FIXTURES = {
  fixtureVersion: '1',
  cases: [{ id: 'c', operationId: 'getThing', request: { method: 'GET', path: '/t' }, expect: { status: 200 } }],
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-identity-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function seed(base) {
  await writeFile(join(base, 'contract.json'), JSON.stringify(CONTRACT, null, 2))
  await writeFile(join(base, 'fixtures.json'), JSON.stringify(FIXTURES, null, 2))
  await writeFile(join(base, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }, null, 2))
}

async function cli(base, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'plan.json'), '--label', 'plan.json', ...args], { cwd: base })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('a hard link to an input is refused, though its real path is different', async () => {
  await withBase(async (base) => {
    await seed(base)
    const contractPath = join(base, 'contract.json')
    const hardLink = join(base, 'report.json')
    await link(contractPath, hardLink)

    // The trap: these two names resolve to two different real paths...
    assert.notEqual(await realpath(hardLink), await realpath(contractPath))
    // ...while naming one and the same file.
    const left = await stat(hardLink)
    const right = await stat(contractPath)
    assert.equal(left.ino, right.ino)
    assert.equal(left.dev, right.dev)

    const before = await readFile(contractPath, 'utf8')
    const { code, stdout } = await cli(base, ['--out', hardLink, '--json'])
    const report = JSON.parse(stdout)

    assert.equal(code, 1)
    assert.equal(report.status, 'fail')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)
    assert.equal(await readFile(contractPath, 'utf8'), before, 'the contract must be untouched')
  })
})

test('a symlink to an input is refused too', async () => {
  await withBase(async (base) => {
    await seed(base)
    const fixturesPath = join(base, 'fixtures.json')
    const soft = join(base, 'soft-report.json')
    await symlink(fixturesPath, soft)

    const before = await readFile(fixturesPath, 'utf8')
    const { code, stdout } = await cli(base, ['--out', soft, '--json'])

    assert.equal(code, 1)
    assert.equal(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)
    assert.equal(await readFile(fixturesPath, 'utf8'), before)
  })
})

test('the plan file itself is an input, and is refused as a destination', async () => {
  await withBase(async (base) => {
    await seed(base)
    const planPath = join(base, 'plan.json')
    const before = await readFile(planPath, 'utf8')
    const { code, stdout } = await cli(base, ['--out', planPath, '--json'])

    assert.equal(code, 1)
    assert.equal(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)
    assert.equal(await readFile(planPath, 'utf8'), before)
  })
})

test('a destination that is not an input is written, byte for byte what stdout carried', async () => {
  await withBase(async (base) => {
    await seed(base)
    const out = join(base, 'report.json')
    const { code, stdout } = await cli(base, ['--out', out, '--json'])

    assert.equal(code, 0)
    assert.equal(await readFile(out, 'utf8'), stdout)
  })
})

test('a destination that does not exist yet is created without complaint', async () => {
  await withBase(async (base) => {
    await seed(base)
    const out = join(base, 'fresh-report.json')
    const { code, stdout } = await cli(base, ['--out', out, '--json'])

    assert.equal(code, 0)
    assert.equal(JSON.parse(stdout).status, 'pass')
    assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'pass')
  })
})

test('a destination the run cannot write is reported, and the evidence it computed is not thrown away', async () => {
  await withBase(async (base) => {
    await seed(base)
    // A directory that does not exist. The run has already checked everything
    // by the time the copy is attempted, and throwing that away leaves a user
    // with an exit code, an empty stdout and no report -- for a mistyped path.
    const { code, stdout } = await cli(base, ['--out', join(base, 'no', 'such', 'report.json'), '--json'])

    assert.equal(code, 1)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.checked, 1)

    const refusal = report.findings.find((finding) => finding.ruleId === 'output-destination-refused')
    assert.notEqual(refusal, undefined)
    assert.equal(refusal.evidence, 'ENOENT')
    assert.equal(refusal.location.file, 'plan.json')

    // The host path is in the error and never in the report.
    assert.equal(stdout.includes(base), false)
  })
})

test('an unwritable destination leaves an incomplete run incomplete', async () => {
  await withBase(async (base) => {
    await seed(base)
    await writeFile(join(base, 'contract.json'), 'not json')
    const { code, stdout } = await cli(base, ['--out', join(base, 'no', 'such', 'report.json'), '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'output-destination-refused'), true)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'document-not-json'), true)
  })
})
