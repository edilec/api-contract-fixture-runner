/**
 * api-contract-fixture-runner -- text handling for everything untrusted.
 *
 * A contract document and a fixture document are untrusted input. Their
 * operation ids, case ids, header names, property names, media types, paths and
 * JSON Pointers all reach the report, and every one of them goes through
 * `sanitize` first. Nothing in this module touches the filesystem, the clock,
 * the locale or the network.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Never a locale-aware comparison under any of its spellings. Collation depends
 * on the ICU data compiled into whatever Node build happens to run, and every
 * spelling of it -- the locale-aware String method, the collator object, a
 * collator captured in a module-level constant -- drifts the same way. `Z` must
 * precede `a`, `a-b` must precede `a_b`, and `README` must precede `assets`, on
 * every machine, for ever.
 *
 * Pinning this function is not pinning the tool: every call site can be swapped
 * independently. `test/finding-order.test.mjs` pushes strings whose collation
 * order disagrees with their code-unit order through the real binary and pins
 * the exact emitted sequence, one call site at a time.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters removed from every untrusted string before it reaches output,
 * written as numeric ranges rather than as escapes in a regular expression.
 *
 * A literal U+2028 inside a module is a hazard of its own, and an escape
 * sequence in a source file is one editor away from becoming that literal. The
 * ranges are data here, they are exported, and `test/sanitisation.test.mjs`
 * walks every one of them through the real binary.
 *
 * Five classes, each for a reason a reader of the report would care about:
 *
 * - C0 and DEL. A newline forges a report line; an ESC opens a terminal escape
 *   sequence.
 * - C1, half-forgotten and twice as dangerous: U+0085 NEL is a line break to a
 *   great many readers, and U+009B is the 8-bit form of CSI, so it opens a
 *   terminal control sequence with no ESC in sight.
 * - The line and paragraph separators, U+2028 and U+2029.
 * - The bidirectional formatting characters. U+202E RIGHT-TO-LEFT OVERRIDE
 *   reverses everything displayed after it, so an operation id can be made to
 *   read as something else entirely while the bytes say otherwise.
 *
 * This is applied to identifiers, not only to excerpts. A case id carrying
 * U+0085 forges a report line exactly as well as a body excerpt would, and an
 * id is the field this tool prints most.
 */
export const STRIPPED_RANGES = Object.freeze([
  Object.freeze({ name: 'C0', first: 0x0000, last: 0x001f }),
  Object.freeze({ name: 'DEL and C1', first: 0x007f, last: 0x009f }),
  Object.freeze({ name: 'bidi marks', first: 0x200e, last: 0x200f }),
  Object.freeze({ name: 'line and paragraph separators', first: 0x2028, last: 0x2029 }),
  Object.freeze({ name: 'bidi embedding and override', first: 0x202a, last: 0x202e }),
  Object.freeze({ name: 'bidi isolates', first: 0x2066, last: 0x2069 }),
])

/** Whether one code point is removed from untrusted text. */
export function isStripped(code) {
  for (const range of STRIPPED_RANGES) {
    if (code >= range.first && code <= range.last) return true
  }
  return false
}

export const TEXT_LIMIT = 160

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every removed character becomes a space rather than vanishing, so two ids
 * that differ only by a stripped character do not silently become the same
 * string in the report. Iteration is by code point, so a stripped character
 * that happens to sit beside an astral pair is removed without splitting it.
 */
export function sanitize(value, limit = TEXT_LIMIT) {
  const source = String(value)
  let cleaned = ''
  for (const character of source) {
    cleaned += isStripped(character.codePointAt(0)) ? ' ' : character
  }
  const flattened = cleaned.replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * What a JSON parse failure may be told about itself, with the input removed.
 *
 * V8 writes a parse failure two ways, and one of them quotes the document:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A contract,
 * a fixture set or a plan short enough to be nothing but a credential is
 * therefore reproduced in full by its own error message, and an untrusted or
 * malformed document is exactly what takes this path. Sanitising does not help:
 * the quoted span sits at the front of the message and survives a cut from the
 * end.
 *
 * The quoting shape is recognised FIRST, and that ordering is the whole fix.
 * Searching for the offset first finds `at position 1` INSIDE the quoted span
 * whenever the document itself contains that text, and then slices the
 * document straight back out: a fixture set reading `at position 1` came back
 * as `Unexpected token 'a', "at position 1`.
 *
 * Position, line and column are the useful half and carry no content, so they
 * are kept verbatim when V8 offers them on their own. The quoted half never
 * leaves this function. The closing guard is deliberate belt and braces: every
 * parse message V8 emits without a quoted snippet spells JSON punctuation with
 * apostrophes and carries no double quote at all, so a double quote surviving
 * to the end means a snippet survived with it, whatever the branches above
 * concluded, and the generic sentence is returned instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. A leading `...` means the quoted run was
 * taken from the middle of the document rather than its start, which is the
 * only thing about the position this shape reveals. The `s` flag matters too:
 * the quoted span can contain a newline.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then hunting for a
 * replacement character cannot tell undecodable bytes from a document that
 * legitimately contains one, and that confusion is exactly how an unreadable
 * input comes to report a pass. Every byte source in this tool goes through
 * here, the plan file included -- a tool that hardens its data path and leaves
 * its own configuration path lossy has hardened nothing.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const encoder = new TextEncoder()

/** UTF-8 byte length of a value's JSON encoding, or null when it has none. */
export function jsonByteLength(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return null
  }
  if (text === undefined) return null
  return encoder.encode(text).length
}

/**
 * Whether a value nests deeper than `maxDepth`.
 *
 * Iterative on an explicit stack: a recursive walk over a fixture body built to
 * nest ten thousand deep would exhaust the call stack, which is the failure
 * this limit exists to replace with a finding. A scalar has depth 0.
 */
export function exceedsDepth(value, maxDepth) {
  const stack = [{ node: value, depth: 0 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (depth + 1 > maxDepth) return true
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 })
    } else {
      for (const key of Object.keys(node)) stack.push({ node: node[key], depth: depth + 1 })
    }
  }
  return false
}

/**
 * Escape one JSON Pointer reference token (RFC 6901): tilde first, then slash.
 *
 * A property literally named `a/b` must not silently become two path segments
 * in a pointer a reader is meant to follow back into the document.
 */
export function pointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Append reference tokens to a JSON Pointer. */
export function pointerAppend(base, ...tokens) {
  let pointer = base === '' ? '' : String(base)
  for (const token of tokens) pointer += `/${pointerToken(token)}`
  return pointer === '' ? '/' : pointer
}

/**
 * A short, redacted rendering of an arbitrary JSON value for the evidence field.
 *
 * The result is sanitised like any other untrusted string, so a body value
 * carrying a control character cannot forge a report line through the excerpt
 * either.
 */
export function describeValue(value, limit = 80) {
  if (value === undefined) return 'absent'
  let rendered
  try {
    rendered = JSON.stringify(value)
  } catch {
    rendered = String(value)
  }
  if (rendered === undefined) rendered = String(value)
  return sanitize(rendered, limit)
}

/** Keep exact comparisons explainable when two distinct strings render alike. */
export function describeComparison(expected, actual) {
  const left = describeValue(expected, 40)
  const right = describeValue(actual, 40)
  if (left !== right || typeof expected !== 'string' || typeof actual !== 'string' || expected === actual) {
    return `expected ${left}, answered ${right}`
  }

  let offset = 0
  while (offset < expected.length && offset < actual.length && expected.charCodeAt(offset) === actual.charCodeAt(offset)) {
    offset += 1
  }
  const unit = (value) => offset === value.length
    ? 'end of string'
    : `U+${value.charCodeAt(offset).toString(16).toUpperCase().padStart(4, '0')}`
  // Shorter excerpts leave room for the distinguishing detail inside the
  // report's 160-character evidence bound, even when the difference is late.
  return `expected ${describeValue(expected, 24)}, answered ${describeValue(actual, 24)}; `
    + `first differing UTF-16 unit at offset ${offset}: ${unit(expected)} vs ${unit(actual)}`
}
