import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { INCOMPLETE_RULES, RULE_SEVERITY, SEVERITY_DECIDES, SEVERITY_VALUES } from '../src/rules.mjs'

/**
 * A documentation-consistency check, and deliberately not a severity guard.
 *
 * Comparing the frozen table with the documented catalog catches a rule that
 * was added to one and forgotten in the other, which is worth catching. It
 * cannot catch a severity that was changed in both at once, and it is important
 * not to mistake it for a test that can: severity is pinned by consequence in
 * `test/severity-decides.test.mjs` and `test/incomplete-severity.test.mjs`,
 * which import nothing from `src` and hold no copy of this table.
 */

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function catalog() {
  const text = await readFile(join(projectDirectory, 'docs/contract-rules.md'), 'utf8')
  const rows = new Map()
  for (const match of text.matchAll(/^\| `([a-z0-9-]+)` \| `(error|warning|info)` \|/gm)) {
    rows.set(match[1], match[2])
  }
  return rows
}

test('every rule in the table is documented, and every documented rule is in the table', async () => {
  const documented = catalogOrder(await catalog())
  const table = Object.keys(RULE_SEVERITY).sort()

  assert.deepEqual(documented, table)
})

function catalogOrder(rows) {
  return [...rows.keys()].sort()
}

test('the documented severity matches the table for every rule', async () => {
  const rows = await catalog()
  for (const [ruleId, severity] of rows) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `docs/contract-rules.md disagrees about ${ruleId}`)
  }
})

test('every rule is in exactly one of the two behaviour classes', () => {
  const ids = Object.keys(RULE_SEVERITY)
  const errors = ids.filter((ruleId) => RULE_SEVERITY[ruleId] === 'error')

  for (const ruleId of errors) {
    const decides = SEVERITY_DECIDES.includes(ruleId)
    const incomplete = INCOMPLETE_RULES.includes(ruleId)
    assert.equal(decides || incomplete, true, `${ruleId} is pinned by neither severity test`)
    assert.equal(decides && incomplete, false, `${ruleId} cannot be in both classes`)
  }

  for (const ruleId of [...SEVERITY_DECIDES, ...INCOMPLETE_RULES]) {
    assert.equal(RULE_SEVERITY[ruleId], 'error', `${ruleId} is listed as an error rule`)
  }
  assert.equal(errors.length, SEVERITY_DECIDES.length + INCOMPLETE_RULES.length)
})

test('every severity in the table is one the contract allows', () => {
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.equal(SEVERITY_VALUES.includes(RULE_SEVERITY[ruleId]), true, ruleId)
  }
})

test('the table, the decides list and the incomplete list are each sorted and duplicate-free', () => {
  for (const [name, list] of [
    ['RULE_SEVERITY', Object.keys(RULE_SEVERITY)],
    ['SEVERITY_DECIDES', [...SEVERITY_DECIDES]],
    ['INCOMPLETE_RULES', [...INCOMPLETE_RULES]],
  ]) {
    const sorted = [...list].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
    assert.deepEqual(list, sorted, `${name} must be in code-unit order`)
    assert.equal(new Set(list).size, list.length, `${name} must have no duplicate`)
  }
})

test('the README and the rule document agree about what the tool cannot conclude', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const rules = await readFile(join(projectDirectory, 'docs/contract-rules.md'), 'utf8')

  assert.equal(readme.includes('## Limits and non-goals'), true)
  assert.equal(rules.includes('## What this tool cannot conclude'), true)
  assert.equal(readme.includes('has never spoken to your implementation'), true)
})
