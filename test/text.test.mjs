import assert from 'node:assert/strict'
import test from 'node:test'

import { STRIPPED_RANGES, byCodeUnit, decodeUtf8, isStripped, sanitize } from '../src/text.mjs'
import { exceedsDepth, jsonByteLength, pointerAppend, pointerToken, describeComparison, describeValue } from '../src/text.mjs'

test('byCodeUnit orders by code unit, not by collation', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('the strip set covers every class the report contract names', () => {
  const cases = [
    [0x0000, 'NUL'],
    [0x0009, 'TAB'],
    [0x000a, 'LF'],
    [0x001b, 'ESC'],
    [0x007f, 'DEL'],
    [0x0085, 'NEL'],
    [0x009b, '8-bit CSI'],
    [0x2028, 'line separator'],
    [0x2029, 'paragraph separator'],
    [0x200e, 'left-to-right mark'],
    [0x200f, 'right-to-left mark'],
    [0x202a, 'left-to-right embedding'],
    [0x202e, 'right-to-left override'],
    [0x2066, 'left-to-right isolate'],
    [0x2069, 'pop directional isolate'],
  ]
  for (const [code, name] of cases) {
    assert.equal(isStripped(code), true, `${name} must be stripped`)
    assert.equal(sanitize(`a${String.fromCharCode(code)}b`).includes(String.fromCharCode(code)), false, name)
  }
})

test('ordinary text and astral characters survive intact', () => {
  assert.equal(isStripped(0x0041), false)
  assert.equal(isStripped(0x00a0), false)
  assert.equal(isStripped(0x2010), false)
  assert.equal(isStripped(0x206a), false)
  assert.equal(sanitize('an ordinary id'), 'an ordinary id')
  assert.equal(sanitize(String.fromCodePoint(0x1f600)), String.fromCodePoint(0x1f600))
})

test('a stripped character becomes a space so two ids do not collapse into one', () => {
  const joined = sanitize(`ab${String.fromCharCode(0x0085)}cd`)
  assert.equal(joined, 'ab cd')
  assert.notEqual(joined, sanitize('abcd'))
})

test('sanitize bounds its output and says so', () => {
  assert.equal(sanitize('x'.repeat(400), 10), 'xxxxxxxxxx...')
  assert.equal(sanitize('short', 10), 'short')
})

test('every declared range is ordered and non-overlapping', () => {
  let previous = -1
  for (const range of STRIPPED_RANGES) {
    assert.equal(range.first <= range.last, true, range.name)
    assert.equal(range.first > previous, true, range.name)
    previous = range.last
  }
})

test('decoding is the decoder\'s decision and never an inference from the text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])).ok, false)

  // A document that legitimately contains U+FFFD is valid UTF-8 and must decode.
  const replacement = new TextEncoder().encode(String.fromCharCode(0xfffd))
  assert.equal(decodeUtf8(replacement).ok, true)
})

test('pointer tokens escape tilde before slash', () => {
  assert.equal(pointerToken('a/b'), 'a~1b')
  assert.equal(pointerToken('a~b'), 'a~0b')
  assert.equal(pointerToken('a~/b'), 'a~0~1b')
  assert.equal(pointerAppend('/cases/0', 'expect', 'body'), '/cases/0/expect/body')
  assert.equal(pointerAppend('', 'a'), '/a')
  assert.equal(pointerAppend(''), '/')
})

test('depth is measured iteratively so a deep body is a finding, not a stack overflow', () => {
  let deep = 0
  for (let index = 0; index < 5000; index += 1) deep = { deep }
  assert.equal(exceedsDepth(deep, 16), true)
  assert.equal(exceedsDepth({ a: { b: 1 } }, 2), false)
  assert.equal(exceedsDepth({ a: { b: 1 } }, 1), true)
  assert.equal(exceedsDepth('scalar', 0), false)
})

test('jsonByteLength counts UTF-8 bytes and refuses what has no JSON encoding', () => {
  assert.equal(jsonByteLength('ab'), 4)
  assert.equal(jsonByteLength({ a: 1 }), 7)
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(jsonByteLength(cyclic), null)
  assert.equal(jsonByteLength(undefined), null)
})

test('describeValue renders and sanitises an arbitrary value', () => {
  assert.equal(describeValue(undefined), 'absent')
  assert.equal(describeValue(''), '""')
  assert.equal(describeValue({ a: 1 }), '{"a":1}')

  // JSON.stringify escapes C0 itself, so a newline arrives here already inert.
  assert.equal(describeValue(`a${String.fromCharCode(10)}b`).includes(String.fromCharCode(10)), false)

  // It does not escape C1, U+2028 or U+2029: those are valid JSON string
  // content, and stripping them is this function's job rather than the
  // serializer's. This is the case four tools in this catalog got wrong.
  for (const code of [0x0085, 0x009b, 0x2028, 0x2029, 0x202e]) {
    const rendered = describeValue(`a${String.fromCharCode(code)}b`)
    assert.equal(rendered.includes(String.fromCharCode(code)), false, `U+${code.toString(16)} must not survive`)
    assert.equal(rendered, '"a b"')
  }
})

test('describeComparison gives source guidance rather than raw units for a rendered collision', () => {
  const hidden = `token${String.fromCharCode(0x85)}part`
  const evidence = describeComparison(hidden, 'token part')
  assert.equal(evidence,
    'Expected and answered strings differ, but safe renderings are identical; inspect the fixture expectation and mock answer at this finding\'s location.')
  assert.doesNotMatch(evidence, /U\+[0-9A-F]{4}/u)
  assert.equal(describeComparison('same', 'same'), 'expected "same", answered "same"')
})
