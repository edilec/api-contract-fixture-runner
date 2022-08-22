import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KNOWN_UNSUPPORTED_KEYWORDS,
  MAX_PATTERN_LENGTH,
  SUPPORTED_FORMATS,
  SUPPORTED_KEYWORDS,
  checkPattern,
  jsonEqual,
  jsonTypeOf,
  matchesFormat,
  validateValue,
} from '../src/schema.mjs'

const pointers = (result) => result.issues.map((issue) => issue.pointer)
const gapRules = (result) => result.gaps.map((gap) => gap.ruleId)

test('a matching value produces neither an issue nor a gap', () => {
  const schema = {
    type: 'object',
    required: ['sku'],
    additionalProperties: false,
    properties: { sku: { type: 'string', minLength: 3 }, quantity: { type: 'integer', minimum: 1 } },
  }
  const result = validateValue(schema, { sku: 'EDL-1', quantity: 2 }, { valuePointer: '/body' })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.gaps, [])
})

test('every violation carries a JSON Pointer to the field', () => {
  const schema = {
    type: 'object',
    required: ['sku', 'placedAt'],
    additionalProperties: false,
    properties: {
      sku: { type: 'string' },
      quantity: { type: 'integer', minimum: 1 },
      placedAt: { type: 'string', format: 'date-time' },
    },
  }
  const result = validateValue(schema, { quantity: 0, placedAt: 'yesterday', extra: 1 }, { valuePointer: '/body' })
  assert.deepEqual(pointers(result).sort(), ['/body/extra', '/body/placedAt', '/body/quantity', '/body/sku'])
  assert.deepEqual(result.gaps, [])
})

test('a property whose name contains a slash is escaped in its pointer', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {} }
  const result = validateValue(schema, { 'a/b': 1, 'c~d': 2 }, { valuePointer: '/body' })
  assert.deepEqual(pointers(result).sort(), ['/body/a~1b', '/body/c~0d'])
})

test('array items are validated by index', () => {
  const schema = { type: 'array', minItems: 2, items: { type: 'integer' } }
  const result = validateValue(schema, [1, 'two'], { valuePointer: '/body/errors' })
  assert.deepEqual(pointers(result), ['/body/errors/1'])
})

test('uniqueItems names the repeat, not the array', () => {
  const schema = { type: 'array', uniqueItems: true }
  const result = validateValue(schema, [{ a: 1 }, { a: 2 }, { a: 1 }], { valuePointer: '/body' })
  assert.deepEqual(pointers(result), ['/body/2'])
})

test('integer and number are distinguished, and number accepts an integer', () => {
  assert.equal(jsonTypeOf(1), 'integer')
  assert.equal(jsonTypeOf(1.5), 'number')
  assert.deepEqual(validateValue({ type: 'number' }, 3, {}).issues, [])
  assert.equal(validateValue({ type: 'integer' }, 3.5, {}).issues.length, 1)
})

test('nullable and a type array both admit null', () => {
  assert.deepEqual(validateValue({ type: 'string', nullable: true }, null, {}).issues, [])
  assert.deepEqual(validateValue({ type: ['string', 'null'] }, null, {}).issues, [])
  assert.equal(validateValue({ type: 'string' }, null, {}).issues.length, 1)
})

test('enum and const compare structurally', () => {
  assert.equal(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: undefined }), false)
  assert.deepEqual(validateValue({ enum: ['a', 'b'] }, 'b', {}).issues, [])
  assert.equal(validateValue({ enum: ['a', 'b'] }, 'c', {}).issues.length, 1)
  assert.deepEqual(validateValue({ const: { a: 1 } }, { a: 1 }, {}).issues, [])
  assert.equal(validateValue({ const: { a: 1 } }, { a: 2 }, {}).issues.length, 1)
})

test('an unsupported keyword is a gap, never a silent pass', () => {
  for (const keyword of KNOWN_UNSUPPORTED_KEYWORDS) {
    const result = validateValue({ [keyword]: [{ type: 'string' }] }, 12345, { valuePointer: '/body' })
    assert.deepEqual(gapRules(result), ['schema-keyword-unsupported'], keyword)
    assert.deepEqual(result.issues, [], keyword)
  }
})

test('the unsupported keyword names are listed in code-unit order', () => {
  const result = validateValue({ Z: 1, a: 1, 'a-b': 1, a_b: 1 }, 'x', { valuePointer: '/body' })
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].evidence, '#: Z, a, a-b, a_b')
})

test('an unsupported dialect stops the check', () => {
  const result = validateValue({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' }, 12, {})
  assert.deepEqual(gapRules(result), ['schema-dialect-unsupported'])
  assert.deepEqual(result.issues, [])
})

test('the supported dialect is accepted and the check proceeds', () => {
  const result = validateValue({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' }, 12, {})
  assert.deepEqual(result.gaps, [])
  assert.equal(result.issues.length, 1)
})

test('an unimplemented format is reported rather than ignored', () => {
  const result = validateValue({ type: 'string', format: 'hostname' }, 'not a hostname at all', {})
  assert.deepEqual(gapRules(result), ['schema-format-unsupported'])
  assert.deepEqual(result.issues, [])
})

test('every implemented format accepts and rejects', () => {
  const good = {
    date: '2026-02-28',
    'date-time': '2026-02-28T09:15:00Z',
    email: 'orders@example.test',
    ipv4: '127.0.0.1',
    uri: 'https://example.test/a',
    uuid: '6f1c2a10-5b8d-4f2e-9a21-0c7d3e5b91aa',
  }
  const bad = {
    date: '2026-02-30',
    'date-time': '2026-02-28 09:15:00',
    email: 'orders-at-example',
    ipv4: '127.0.0.256',
    uri: '/relative',
    uuid: '6f1c2a10-5b8d-4f2e-9a21',
  }
  for (const format of SUPPORTED_FORMATS) {
    assert.equal(matchesFormat(format, good[format]), true, `${format} must accept ${good[format]}`)
    assert.equal(matchesFormat(format, bad[format]), false, `${format} must reject ${bad[format]}`)
  }
  assert.equal(matchesFormat('date', '2028-02-29'), true, 'a leap day in a leap year')
  assert.equal(matchesFormat('date', '2027-02-29'), false, 'a leap day in an ordinary year')
  assert.equal(matchesFormat('ipv4', '127.00.0.1'), false, 'a leading zero is not an octet')
})

test('a pattern that can backtrack catastrophically is refused rather than run', () => {
  assert.equal(checkPattern('^[a-z]+$').ok, true)
  assert.equal(checkPattern('^(?:ab)+$').ok, true)
  assert.equal(checkPattern('^(a+)+$').ok, false)
  assert.equal(checkPattern('^(a|a)*$').ok, false)
  assert.equal(checkPattern('^(?=x)a$').ok, false)
  assert.equal(checkPattern('^(?<name>a)$').ok, false)
  assert.equal(checkPattern('^(a$').ok, false)
  assert.equal(checkPattern('['.repeat(3)).ok, false)
  assert.equal(checkPattern('a'.repeat(MAX_PATTERN_LENGTH + 1)).ok, false)
  assert.equal(checkPattern(42).ok, false)
})

test('a refused pattern is a gap and the value is not reported as matching', () => {
  const result = validateValue({ type: 'string', pattern: '^(a+)+$' }, 'zzzz', { valuePointer: '/body/sku' })
  assert.deepEqual(gapRules(result), ['schema-pattern-refused'])
  assert.deepEqual(result.issues, [])
})

test('an accepted pattern is applied', () => {
  assert.deepEqual(validateValue({ type: 'string', pattern: '^EDL-\\d+$' }, 'EDL-22', {}).issues, [])
  assert.equal(validateValue({ type: 'string', pattern: '^EDL-\\d+$' }, 'XXX', {}).issues.length, 1)
})

test('a local reference resolves and an absent or remote one is a gap', () => {
  const components = { Order: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
  assert.deepEqual(validateValue({ $ref: '#/components/schemas/Order' }, { id: 'a' }, { components }).issues, [])
  assert.deepEqual(
    gapRules(validateValue({ $ref: '#/components/schemas/Missing' }, {}, { components })),
    ['schema-ref-unresolved'],
  )
  assert.deepEqual(
    gapRules(validateValue({ $ref: 'https://example.test/schema.json' }, {}, { components })),
    ['schema-ref-unresolved'],
  )
  assert.deepEqual(
    gapRules(validateValue({ $ref: '#/components/schemas/Order', minLength: 2 }, {}, { components })),
    ['schema-keyword-unsupported'],
  )
})

test('a recursive reference is a gap, not a stack overflow', () => {
  const components = {
    Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
  }
  const result = validateValue({ $ref: '#/components/schemas/Node' }, { child: { child: {} } }, { components })
  assert.deepEqual(gapRules(result), ['schema-ref-cycle'])
})

test('schema depth is bounded and the bound is a gap', () => {
  let schema = { type: 'integer' }
  for (let index = 0; index < 12; index += 1) schema = { type: 'object', properties: { a: schema } }
  let value = 1
  for (let index = 0; index < 12; index += 1) value = { a: value }

  assert.deepEqual(validateValue(schema, value, { maxSchemaDepth: 24 }).gaps, [])
  assert.deepEqual(gapRules(validateValue(schema, value, { maxSchemaDepth: 4 })), ['limit-schema-depth-exceeded'])
})

test('a boolean schema and the object form of additionalProperties are declared, not ignored', () => {
  assert.deepEqual(gapRules(validateValue(true, 'anything', {})), ['schema-keyword-unsupported'])
  assert.deepEqual(
    gapRules(validateValue({ type: 'object', additionalProperties: { type: 'string' } }, { a: 1 }, {})),
    ['schema-keyword-unsupported'],
  )
  assert.deepEqual(
    gapRules(validateValue({ type: 'array', items: [{ type: 'string' }] }, ['a'], {})),
    ['schema-keyword-unsupported'],
  )
  assert.deepEqual(
    gapRules(validateValue({ type: 'integer', minimum: true }, 5, {})),
    ['schema-keyword-unsupported'],
  )
  assert.deepEqual(gapRules(validateValue({ type: 'chair' }, 5, {})), ['schema-keyword-unsupported'])
})

test('the supported keyword list is sorted and free of duplicates', () => {
  const sorted = [...SUPPORTED_KEYWORDS].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  assert.deepEqual([...SUPPORTED_KEYWORDS], sorted)
  assert.equal(new Set(SUPPORTED_KEYWORDS).size, SUPPORTED_KEYWORDS.length)
  for (const keyword of KNOWN_UNSUPPORTED_KEYWORDS) {
    assert.equal(SUPPORTED_KEYWORDS.includes(keyword), false, `${keyword} must not be in both lists`)
  }
})
