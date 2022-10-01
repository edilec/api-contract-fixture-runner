import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { sameFileReason } from '../src/destination.mjs'

/**
 * Where the `--out` copy may land.
 *
 * This tool wrote its report through a symbolic link at the destination and
 * destroyed a file outside the working directory, exiting 0 with a "pass"
 * report on stdout. It already compared the destination against the inode of
 * every document it read -- the hard-link hole, closed, and pinned in
 * test/path-identity.test.mjs -- which is exactly the guard that cannot see a
 * link pointing at a file that is not an input at all.
 *
 * The three holes are independent, and guarding one or two is what every tool
 * in this catalog that lost data had already done:
 *
 *   symlink at the destination   `realpath` RESOLVES the link, and resolving
 *                                is the dangerous act, so it is refused on
 *                                sight with `lstat` before anything is opened
 *   symlinked parent directory   a lexical prefix check passes for
 *                                `root/link/out` where `link` leaves the root
 *   hard link to an input        no target to resolve and no shared path; only
 *                                device plus inode sees one file
 *
 * The ALLOWED rows carry the same weight as the refusals: a guard that refuses
 * everything passes every data-loss test above while making the tool useless.
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

async function withWorkspace(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-contract-fixture-runner-destination-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'contract.json'), JSON.stringify(CONTRACT, null, 2))
  await writeFile(join(root, 'fixtures.json'), JSON.stringify(FIXTURES, null, 2))
  await writeFile(join(root, 'plan.json'), JSON.stringify({ contract: 'contract.json', fixtures: 'fixtures.json' }, null, 2))
  try {
    return await body({ base, root, outside })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function check(root, args) {
  return run(process.execPath, [CLI, '--plan', 'plan.json', '--label', 'plan.json', '--json', ...args], { cwd: root })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

/** A refused destination is a configuration error: exit 2, stdout empty, nothing written. */
function assertRefused(result) {
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.notEqual(result.stderr, '')
}

test('a symbolic link at the destination is refused, and the file it points at survives', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const victim = join(outside, 'precious.txt')
    await writeFile(victim, 'PRECIOUS\n')
    await symlink(victim, join(root, 'report.json'))

    const result = await check(root, ['--out', 'report.json'])

    assertRefused(result)
    assert.equal(result.stderr.includes('symbolic link'), true)
    assert.equal(await readFile(victim, 'utf8'), 'PRECIOUS\n')
  })
})

test('a symbolic link whose target does not exist yet creates nothing outside the root', async () => {
  await withWorkspace(async ({ root, outside }) => {
    await symlink(join(outside, 'invented.json'), join(root, 'report.json'))

    const result = await check(root, ['--out', 'report.json'])

    assertRefused(result)
    assert.deepEqual(await readdir(outside), [], 'the run must not create a file outside the root')
  })
})

test('a symlinked parent directory that leaves the root is refused, which no lexical check catches', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const victim = join(outside, 'report.json')
    await writeFile(victim, 'KEEP\n')
    await symlink(outside, join(root, 'link'))

    // Lexically "link/report.json" sits under the root. It does not.
    const result = await check(root, ['--out', join('link', 'report.json')])

    assertRefused(result)
    assert.equal(result.stderr.includes('outside the permitted root'), true)
    assert.equal(await readFile(victim, 'utf8'), 'KEEP\n')
  })
})

test('a lexical ".." escape is refused', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const result = await check(root, ['--out', join('..', 'outside', 'report.json')])

    assertRefused(result)
    assert.deepEqual(await readdir(outside), [])
  })
})

test('a destination that is a directory is refused rather than opened', async () => {
  await withWorkspace(async ({ root }) => {
    await mkdir(join(root, 'build'))

    const result = await check(root, ['--out', 'build'])

    assertRefused(result)
    assert.equal(result.stderr.includes('not a regular file'), true)
  })
})

test('ALLOWED: a plain destination, a rewrite of the previous run, and a subdirectory', async () => {
  await withWorkspace(async ({ root }) => {
    const first = await check(root, ['--out', 'report.json'])
    assert.equal(first.code, 0)
    assert.equal(await readFile(join(root, 'report.json'), 'utf8'), first.stdout)

    // Writing over the report from the previous run is the normal case.
    assert.equal((await check(root, ['--out', 'report.json'])).code, 0)

    await mkdir(join(root, 'build'))
    assert.equal((await check(root, ['--out', join('build', 'report.json')])).code, 0)
    assert.equal(JSON.parse(await readFile(join(root, 'build', 'report.json'), 'utf8')).status, 'pass')
  })
})

test('ALLOWED: a directory reached through a symbolic link that stays inside the root', async () => {
  await withWorkspace(async ({ root }) => {
    await mkdir(join(root, 'real-build'))
    await symlink(join(root, 'real-build'), join(root, 'build'))

    const result = await check(root, ['--out', join('build', 'report.json')])

    assert.equal(result.code, 0)
    assert.deepEqual(await readdir(join(root, 'real-build')), ['report.json'])
  })
})

test('ALLOWED: a destination outside the working directory once --out-root names its root', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const target = join(outside, 'report.json')

    assertRefused(await check(root, ['--out', target]))

    const named = await check(root, ['--out', target, '--out-root', outside])
    assert.equal(named.code, 0)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).status, 'pass')
  })
})

test('identity is decided by inode, with the resolved path only as a backstop', () => {
  const inode = (dev, ino) => ({ dev: BigInt(dev), ino: BigInt(ino) })

  // A hard link: one inode, two paths. Only the inode comparison sees it.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(1, 7), '/a/input.json'), 'inode')
  // Two different files that happen to sit side by side.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(1, 8), '/a/input.json'), null)
  // Same inode number on a different device is a different file.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(2, 7), '/a/input.json'), null)

  // A filesystem that reports no inode number at all cannot be asked about
  // identity, and this is the only case the resolved-path backstop decides.
  assert.equal(sameFileReason(inode(1, 0), '/a/input.json', inode(1, 0), '/a/input.json'), 'path')
  assert.equal(sameFileReason(inode(1, 0), '/a/out.json', inode(1, 0), '/a/input.json'), null)
  // An input that could not be stat'ed at all still cannot be written over.
  assert.equal(sameFileReason(inode(1, 7), '/a/input.json', null, '/a/input.json'), 'path')
})
