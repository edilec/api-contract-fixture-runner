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
 *
 * Which files the run read is only known once it has read them, so the
 * destination is settled twice -- before the plan is opened, and again
 * immediately before the copy is written. Both settlings answer the same way,
 * and that is what the assertions below are on: a refused destination is a
 * configuration error, so stdout carries nothing at all.
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
    const { code, stdout, stderr } = await cli(base, ['--out', hardLink, '--json'])

    // The contract is named by the plan, so this destination cannot be
    // recognised as an input until the plan has been read. It is recognised
    // before the copy is written, which is still before anything has reached
    // stdout, so the answer is the one a refused destination always gets.
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('same file as an input'), true)
    assert.equal(await readFile(contractPath, 'utf8'), before, 'the contract must be untouched')
  })
})

test('a symlink to an input is refused before the run starts, not after it', async () => {
  await withBase(async (base) => {
    await seed(base)
    const fixturesPath = join(base, 'fixtures.json')
    const soft = join(base, 'soft-report.json')
    await symlink(fixturesPath, soft)

    const before = await readFile(fixturesPath, 'utf8')
    const { code, stdout, stderr } = await cli(base, ['--out', soft, '--json'])

    // A symbolic link at the destination is refused on sight, whatever it
    // points at: resolving it to find out is the dangerous act. That makes it
    // a configuration error rather than a finding -- nothing has been read
    // yet -- so stdout carries no report at all.
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('symbolic link'), true)
    assert.equal(await readFile(fixturesPath, 'utf8'), before)
  })
})

test('the plan file itself is an input, and is refused as a destination before the run starts', async () => {
  await withBase(async (base) => {
    await seed(base)
    const planPath = join(base, 'plan.json')
    const before = await readFile(planPath, 'utf8')
    const { code, stdout, stderr } = await cli(base, ['--out', planPath, '--json'])

    // The plan is the one input the run knows about before it begins, so
    // pointing --out at it is configuration and is answered as configuration.
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('same file as an input'), true)
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

test('a directory on the way to the destination is created rather than refused', async () => {
  await withBase(async (base) => {
    await seed(base)
    // The guard already permits a destination whose directories do not exist
    // yet -- it resolves the nearest existing ancestor and appends the missing
    // segments -- so refusing the write at the last moment would be a refusal
    // the check itself does not make.
    const out = join(base, 'no', 'such', 'report.json')
    const { code, stdout } = await cli(base, ['--out', out, '--json'])

    assert.equal(code, 0)
    assert.equal(await readFile(out, 'utf8'), stdout)
  })
})

test('a destination that cannot be written at all is configuration, so stdout stays empty', async () => {
  await withBase(async (base) => {
    await seed(base)
    // A destination underneath a regular file. Nothing can be created there,
    // and a run that could not file the copy it was asked for has not done
    // what it was asked -- so it says so on stderr and prints no report.
    const { code, stdout, stderr } = await cli(base, ['--out', join(base, 'contract.json', 'report.json'), '--json'])

    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('--out could not be written'), true)
  })
})

test('a document the run could not parse is still an input the destination is refused against', async () => {
  await withBase(async (base) => {
    await seed(base)
    const contractPath = join(base, 'contract.json')
    await writeFile(contractPath, 'not json')
    const { code, stdout, stderr } = await cli(base, ['--out', contractPath, '--json'])

    // The run failed to use this document, which is not the same as not
    // having needed it: it was resolved, opened and read, and it is not the
    // place to put the report.
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('same file as an input'), true)
    assert.equal(await readFile(contractPath, 'utf8'), 'not json')
  })
})
