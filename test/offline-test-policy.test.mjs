import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testRoot = dirname(fileURLToPath(import.meta.url))

test('test files never open a socket or bind a listener', async () => {
  for (const name of await readdir(testRoot)) {
    if (!name.endsWith('.mjs')) continue
    const source = await readFile(join(testRoot, name), 'utf8')
    assert.equal(/\b(?:createServer|createConnection|connect)\s*\(|\.listen\s*\(|\bfrom\s*['"]node:(?:http|https|net|tls|dgram|dns)['"]/.test(source), false,
      `${name} must not start a network operation`)
  }
})
