/**
 * api-contract-fixture-runner -- the bounded schema subset, and its boundary.
 *
 * This is a purpose-built validator for a declared subset of JSON Schema
 * 2020-12 as it is used inside an API contract. It is not a general validator
 * and does not pretend to be one. The whole point of writing it rather than
 * delegating is that its boundary is visible: a keyword, a dialect, a format,
 * a construct or a pattern outside the subset is *reported* and makes the run
 * `incomplete`. It is never treated as satisfied, because "we did not check it"
 * and "it is correct" are different answers and only one of them is honest.
 *
 * Two kinds of result come out of here and they must not be confused:
 *
 * - an **issue** is a contract violation: the value is not what the schema
 *   says. It carries a JSON Pointer into the value.
 * - a **gap** is an absence of evidence: the schema said something this tool
 *   cannot evaluate. It carries a rule id that sets `incomplete`.
 *
 * Nothing here touches the filesystem, the clock, the locale or the network.
 */

import { byCodeUnit, describeValue, pointerAppend, sanitize } from './text.mjs'

/** The only `$schema` values this validator will act on. */
export const SUPPORTED_DIALECTS = Object.freeze(['https://json-schema.org/draft/2020-12/schema'])

/**
 * Every keyword this validator understands. Anything else in a schema object
 * is refused by name rather than ignored -- an ignored `oneOf` is a constraint
 * silently reported as satisfied.
 *
 * `title`, `description`, `example` and `default` are annotations: recognised,
 * and deliberately without effect.
 */
export const SUPPORTED_KEYWORDS = Object.freeze([
  '$ref',
  '$schema',
  'additionalProperties',
  'const',
  'default',
  'description',
  'enum',
  'example',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
])

/** Keywords a reader is most likely to reach for that are outside the subset. */
export const KNOWN_UNSUPPORTED_KEYWORDS = Object.freeze([
  '$dynamicRef',
  'allOf',
  'anyOf',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'discriminator',
  'else',
  'if',
  'multipleOf',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedProperties',
])

export const SUPPORTED_TYPES = Object.freeze(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

/** Formats with a real implementation. An unimplemented format is reported. */
export const SUPPORTED_FORMATS = Object.freeze(['date', 'date-time', 'email', 'ipv4', 'uri', 'uuid'])

/** A `pattern` longer than this is refused unread rather than compiled. */
export const MAX_PATTERN_LENGTH = 200

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality over JSON values, used by `enum`, `const` and `uniqueItems`. */
export function jsonEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index], right[index])) return false
    }
    return true
  }
  if (typeof left !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false
    if (!jsonEqual(left[key], right[key])) return false
  }
  return true
}

/** The JSON type name of a value, with `integer` distinguished from `number`. */
export function jsonTypeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (type === 'string' || type === 'boolean' || type === 'object') return type
  return 'unsupported'
}

/* ------------------------------------------------------------------ patterns */

/**
 * The character sets the pattern analyser below reasons about.
 *
 * `any` is the dot, `unknown` is a construct this analyser does not model, and
 * `none` is a zero-width assertion. Only `chars` carries real ranges. Neither
 * `any` nor `unknown` is ever disjoint from anything: a construct this analyser
 * cannot read must never be the reason a pattern is accepted.
 */
const ANY_SET = Object.freeze({ kind: 'any' })
const UNKNOWN_SET = Object.freeze({ kind: 'unknown' })
const NONE_SET = Object.freeze({ kind: 'none' })

const DIGIT_RANGES = Object.freeze([[0x30, 0x39]])
const WORD_RANGES = Object.freeze([[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]])
const SPACE_RANGES = Object.freeze([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
])

function mergeRanges(ranges) {
  const sorted = [...ranges].map(([low, high]) => [low, high]).sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && low <= last[1] + 1) {
      if (high > last[1]) last[1] = high
    } else {
      merged.push([low, high])
    }
  }
  return merged
}

function charSet(ranges, negated = false) {
  return { kind: 'chars', negated, ranges: mergeRanges(ranges) }
}

function rangesOverlap(left, right) {
  for (const [lowLeft, highLeft] of left) {
    for (const [lowRight, highRight] of right) {
      if (lowLeft <= highRight && lowRight <= highLeft) return true
    }
  }
  return false
}

/** Whether every range of `inner` sits inside one range of `outer`. */
function rangesContain(outer, inner) {
  for (const [low, high] of inner) {
    let covered = false
    for (const [lowOuter, highOuter] of outer) {
      if (lowOuter <= low && high <= highOuter) {
        covered = true
        break
      }
    }
    if (!covered) return false
  }
  return true
}

/**
 * Whether two sets can never match the same character.
 *
 * Two negated sets are never called disjoint: their complements both cover the
 * overwhelming majority of Unicode, so they overlap in practice and proving
 * otherwise is not worth a wrong answer.
 */
function disjointSets(left, right) {
  if (left.kind === 'none' || right.kind === 'none') return true
  if (left.kind !== 'chars' || right.kind !== 'chars') return false
  if (left.negated && right.negated) return false
  if (!left.negated && !right.negated) return !rangesOverlap(left.ranges, right.ranges)
  const negated = left.negated ? left : right
  const positive = left.negated ? right : left
  return rangesContain(negated.ranges, positive.ranges)
}

function classEscapeSet(character) {
  if (character === 'd') return charSet(DIGIT_RANGES)
  if (character === 'D') return charSet(DIGIT_RANGES, true)
  if (character === 'w') return charSet(WORD_RANGES)
  if (character === 'W') return charSet(WORD_RANGES, true)
  if (character === 's') return charSet(SPACE_RANGES)
  if (character === 'S') return charSet(SPACE_RANGES, true)
  return null
}

const CONTROL_ESCAPES = new Map([
  ['0', 0x00],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['v', 0x0b],
])

const NOT_COMPILABLE = 'the pattern did not compile as a Unicode regular expression'
const UNSUPPORTED_ESCAPE = 'a back reference, a control escape or a Unicode property escape is outside the supported subset'
const AMBIGUOUS =
  'two variable-length parts of the pattern can match the same characters with nothing between them to fix the boundary, which can backtrack catastrophically'
const NESTED_REPETITION = 'a quantifier is applied to a group that itself repeats or alternates, which can backtrack catastrophically'

/** Read `\uXXXX`, `\u{XXXX}` or `\xXX` as one code point, or refuse. */
function readCodePointEscape(state) {
  const source = state.source
  const kind = source[state.index + 1]
  if (kind === 'x') {
    const digits = source.slice(state.index + 2, state.index + 4)
    if (!/^[0-9a-fA-F]{2}$/.test(digits)) return null
    state.index += 4
    return Number.parseInt(digits, 16)
  }
  if (source[state.index + 2] === '{') {
    const close = source.indexOf('}', state.index + 3)
    if (close === -1) return null
    const digits = source.slice(state.index + 3, close)
    if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) return null
    state.index = close + 1
    return Number.parseInt(digits, 16)
  }
  const digits = source.slice(state.index + 2, state.index + 6)
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null
  state.index += 6
  return Number.parseInt(digits, 16)
}

/**
 * One escape, as an atom set. `null` means refused, and `state.reason` says why.
 */
function parseEscape(state) {
  const source = state.source
  const next = source[state.index + 1]
  if (next === undefined) {
    state.reason = NOT_COMPILABLE
    return null
  }
  const classSet = classEscapeSet(next)
  if (classSet !== null) {
    state.index += 2
    return classSet
  }
  if (next === 'b' || next === 'B') {
    state.index += 2
    return NONE_SET
  }
  if (CONTROL_ESCAPES.has(next)) {
    const code = CONTROL_ESCAPES.get(next)
    state.index += 2
    return charSet([[code, code]])
  }
  if (next === 'u' || next === 'x') {
    const code = readCodePointEscape(state)
    if (code === null) {
      state.reason = NOT_COMPILABLE
      return null
    }
    return charSet([[code, code]])
  }
  if (next === 'c' || next === 'p' || next === 'P' || /[1-9k]/.test(next)) {
    state.reason = UNSUPPORTED_ESCAPE
    return null
  }
  const code = source.codePointAt(state.index + 1)
  state.index += 1 + String.fromCodePoint(code).length
  return charSet([[code, code]])
}

/**
 * One character class, as an atom set.
 *
 * A member this analyser cannot model -- a negated class escape inside a class,
 * an escape outside the subset -- makes the whole class `unknown`, which is
 * never disjoint from anything and so can only lead to a refusal.
 */
function parseCharacterClass(state) {
  const source = state.source
  state.index += 1
  let negated = false
  if (source[state.index] === '^') {
    negated = true
    state.index += 1
  }
  const ranges = []
  let unknown = false
  while (state.index < source.length && source[state.index] !== ']') {
    let low
    if (source[state.index] === '\\') {
      const member = parseEscape(state)
      if (member === null) {
        if (state.reason === UNSUPPORTED_ESCAPE) {
          state.reason = undefined
          unknown = true
          state.index += 2
          continue
        }
        return null
      }
      if (member.kind !== 'chars' || member.negated) {
        unknown = true
        continue
      }
      if (member.ranges.length !== 1 || member.ranges[0][0] !== member.ranges[0][1]) {
        ranges.push(...member.ranges)
        continue
      }
      low = member.ranges[0][0]
    } else {
      low = source.codePointAt(state.index)
      state.index += String.fromCodePoint(low).length
    }
    if (source[state.index] === '-' && source[state.index + 1] !== undefined && source[state.index + 1] !== ']') {
      state.index += 1
      let high
      if (source[state.index] === '\\') {
        const member = parseEscape(state)
        if (member === null) {
          if (state.reason === UNSUPPORTED_ESCAPE) {
            state.reason = undefined
            unknown = true
            state.index += 2
            continue
          }
          return null
        }
        if (member.kind !== 'chars' || member.negated || member.ranges.length !== 1 || member.ranges[0][0] !== member.ranges[0][1]) {
          unknown = true
          continue
        }
        high = member.ranges[0][0]
      } else {
        high = source.codePointAt(state.index)
        state.index += String.fromCodePoint(high).length
      }
      if (high < low) {
        state.reason = NOT_COMPILABLE
        return null
      }
      ranges.push([low, high])
      continue
    }
    ranges.push([low, low])
  }
  if (source[state.index] !== ']') {
    state.reason = NOT_COMPILABLE
    return null
  }
  state.index += 1
  if (unknown) return UNKNOWN_SET
  return charSet(ranges, negated)
}

/** The quantifier following an atom, defaulting to exactly one. */
function parseQuantifier(state) {
  const source = state.source
  const character = source[state.index]
  let min = 1
  let max = 1
  if (character === '*') {
    min = 0
    max = Number.POSITIVE_INFINITY
    state.index += 1
  } else if (character === '+') {
    min = 1
    max = Number.POSITIVE_INFINITY
    state.index += 1
  } else if (character === '?') {
    min = 0
    max = 1
    state.index += 1
  } else if (character === '{') {
    const close = source.indexOf('}', state.index)
    if (close === -1) {
      state.reason = NOT_COMPILABLE
      return null
    }
    const parts = /^(\d+)(,(\d*))?$/.exec(source.slice(state.index + 1, close))
    if (parts === null) {
      state.reason = NOT_COMPILABLE
      return null
    }
    min = Number(parts[1])
    max = parts[2] === undefined ? min : parts[3] === '' ? Number.POSITIVE_INFINITY : Number(parts[3])
    if (max < min) {
      state.reason = NOT_COMPILABLE
      return null
    }
    state.index = close + 1
  } else {
    return { min, max }
  }
  // A lazy quantifier backtracks exactly as badly as a greedy one.
  if (source[state.index] === '?') state.index += 1
  return { min, max }
}

/**
 * Whether a group can match a different number of characters in two ways, which
 * is what lets a boundary beside it move. Alternation counts, conservatively.
 */
function branchesAreVariable(branches) {
  if (branches.length > 1) return true
  return branches[0].some((atom) => atom.variable)
}

/** Whether any atom of any branch carries a quantifier, or the group alternates. */
function repeatsOrAlternates(branches) {
  if (branches.length > 1) return true
  for (const atom of branches[0]) {
    if (atom.minRep !== 1 || atom.maxRep !== 1) return true
    if (atom.group !== null && repeatsOrAlternates(atom.group)) return true
  }
  return false
}

function parseAtom(state) {
  const source = state.source
  const character = source[state.index]
  let set
  let group = null

  if (character === '(') {
    if (source[state.index + 1] === '?' && !source.startsWith('(?:', state.index)) {
      state.reason = 'lookaround, named groups and other extended group forms are outside the supported subset'
      return null
    }
    state.index += source.startsWith('(?:', state.index) ? 3 : 1
    group = parseAlternation(state)
    if (group === null) return null
    if (source[state.index] !== ')') {
      state.reason = 'the pattern has an unbalanced group'
      return null
    }
    state.index += 1
    set = UNKNOWN_SET
  } else if (character === '[') {
    set = parseCharacterClass(state)
    if (set === null) return null
  } else if (character === '\\') {
    set = parseEscape(state)
    if (set === null) return null
  } else if (character === '^' || character === '$') {
    state.index += 1
    set = NONE_SET
  } else if (character === '.') {
    state.index += 1
    set = ANY_SET
  } else if (character === '*' || character === '+' || character === '?' || character === '{') {
    state.reason = NOT_COMPILABLE
    return null
  } else if (character === ']' || character === '}') {
    state.reason = NOT_COMPILABLE
    return null
  } else {
    const code = source.codePointAt(state.index)
    state.index += String.fromCodePoint(code).length
    set = charSet([[code, code]])
  }

  const quantifier = parseQuantifier(state)
  if (quantifier === null) return null

  const atom = {
    set,
    group,
    minRep: quantifier.min,
    maxRep: quantifier.max,
    zeroWidth: set === NONE_SET,
  }
  // "Variable" is the property that matters: an atom that can match a different
  // number of characters in two different ways is where a boundary can move,
  // and `x?` moves it exactly as surely as `x*` does.
  atom.variable = quantifier.max > quantifier.min || (group !== null && branchesAreVariable(group))
  return atom
}

function parseAlternation(state) {
  const branches = []
  let atoms = []
  while (state.index < state.source.length) {
    const character = state.source[state.index]
    if (character === ')') break
    if (character === '|') {
      state.index += 1
      branches.push(atoms)
      atoms = []
      continue
    }
    const atom = parseAtom(state)
    if (atom === null) return null
    atoms.push(atom)
  }
  branches.push(atoms)
  return branches
}

/**
 * Whether the boundary between two variable-length atoms of one sequence is
 * forced by something between them.
 *
 * It is forced when some atom between the two must match at least one
 * character that the left atom cannot match: the left atom then has exactly one
 * possible extent, and the split between them cannot move. Everything before
 * that barrier must itself be disjoint from the left atom, or the ambiguity
 * simply moves there.
 *
 * With no barrier, the two are effectively adjacent, and they are safe only
 * when no single character could be claimed by either of them -- `[A-Z]+\d+`
 * is unambiguous, `\d+\d+` is the pattern that runs for two minutes.
 */
function boundaryIsForced(atoms, left, right) {
  const leftSet = atoms[left].set
  for (let index = left + 1; index < right; index += 1) {
    const between = atoms[index]
    if (!disjointSets(leftSet, between.set)) return false
    if (between.minRep >= 1 && !between.zeroWidth) return true
  }
  const rightSet = atoms[right].set
  if (!disjointSets(leftSet, rightSet)) return false
  for (let index = left + 1; index < right; index += 1) {
    if (!disjointSets(rightSet, atoms[index].set)) return false
  }
  return true
}

/** Refuse a sequence in which any two variable-length atoms can share a boundary. */
function analyseSequence(atoms) {
  const variable = []
  for (let index = 0; index < atoms.length; index += 1) {
    if (atoms[index].variable) variable.push(index)
  }
  for (let left = 0; left < variable.length; left += 1) {
    for (let right = left + 1; right < variable.length; right += 1) {
      if (!boundaryIsForced(atoms, variable[left], variable[right])) return AMBIGUOUS
    }
  }
  return null
}

function analyseBranches(branches) {
  for (const atoms of branches) {
    const ambiguous = analyseSequence(atoms)
    if (ambiguous !== null) return ambiguous
    for (const atom of atoms) {
      if (atom.group === null) continue
      if (atom.maxRep > 1 && repeatsOrAlternates(atom.group)) return NESTED_REPETITION
      const nested = analyseBranches(atom.group)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Decide whether a `pattern` from a contract may be compiled and run.
 *
 * A contract is untrusted input, and a regular expression is the one thing in
 * this package that cannot be stopped once it has started: the engine does not
 * yield, so a deadline checked around the call never fires during it. The bound
 * therefore has to be decided *before* the match, by refusing every shape this
 * analyser cannot vouch for:
 *
 * - anything over the length bound;
 * - any lookaround, named group, back reference, control escape or Unicode
 *   property escape;
 * - any quantifier applied to a group that itself repeats or alternates --
 *   `(a+)+`, the textbook exponential;
 * - any two variable-length parts of one sequence whose boundary is not forced
 *   by a character neither of them can match -- `\d+\d+`, which is just as
 *   catastrophic and has no nesting in it at all;
 * - anything that does not compile as a Unicode regular expression.
 *
 * The refusal is conservative: safe patterns are refused too, and that is
 * reported as `schema-pattern-refused`, an unchecked value and an `incomplete`
 * run. It is never a quiet pass. `test/pattern-bound.test.mjs` measures the
 * whole of it against patterns that would otherwise run for minutes.
 */
export function checkPattern(source) {
  if (typeof source !== 'string') return { ok: false, reason: 'a pattern must be a string' }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `a pattern may be at most ${MAX_PATTERN_LENGTH} characters and this one is ${source.length}` }
  }

  const state = { source, index: 0, reason: undefined }
  const branches = parseAlternation(state)
  if (branches === null) return { ok: false, reason: state.reason ?? NOT_COMPILABLE }
  if (state.index !== source.length) return { ok: false, reason: 'the pattern has an unbalanced group' }

  const refusal = analyseBranches(branches)
  if (refusal !== null) return { ok: false, reason: refusal }

  let regex
  try {
    regex = new RegExp(source, 'u')
  } catch {
    return { ok: false, reason: NOT_COMPILABLE }
  }
  return { ok: true, regex }
}

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Calendar validity, computed rather than delegated.
 *
 * The platform's date constructor is not used anywhere in this package: a date
 * check must not depend on a host clock, a host time zone, or the parsing
 * quirks of whatever runtime is executing.
 */
function isCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day <= limit
}

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_SHAPE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EMAIL_SHAPE = /^[^@\s]+@[^@.\s]+\.[^@\s]+$/
const IPV4_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Whether a string satisfies one of the implemented formats. */
export function matchesFormat(format, value) {
  if (format === 'date') {
    const parts = DATE_SHAPE.exec(value)
    return parts !== null && isCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))
  }
  if (format === 'date-time') {
    const parts = DATE_TIME_SHAPE.exec(value)
    if (parts === null) return false
    if (!isCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))) return false
    return Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 60
  }
  if (format === 'uuid') return UUID_SHAPE.test(value)
  if (format === 'email') return EMAIL_SHAPE.test(value)
  if (format === 'ipv4') {
    const parts = IPV4_SHAPE.exec(value)
    if (parts === null) return false
    for (let index = 1; index <= 4; index += 1) {
      const octet = parts[index]
      if (octet.length > 1 && octet.startsWith('0')) return false
      if (Number(octet) > 255) return false
    }
    return true
  }
  if (format === 'uri') {
    try {
      const url = new URL(value)
      return url.protocol.length > 1
    } catch {
      return false
    }
  }
  return false
}

const REF_PREFIX = '#/components/schemas/'

function context(options) {
  return {
    components: isRecord(options.components) ? options.components : {},
    maxSchemaDepth: options.maxSchemaDepth ?? 24,
    issues: [],
    gaps: [],
  }
}

function issue(ctx, pointer, message, evidence) {
  ctx.issues.push({ pointer, message, ...(evidence === undefined ? {} : { evidence }) })
}

function gap(ctx, ruleId, pointer, message, evidence, suggestion) {
  ctx.gaps.push({
    ruleId,
    pointer,
    message,
    ...(evidence === undefined ? {} : { evidence }),
    ...(suggestion === undefined ? {} : { suggestion }),
  })
}

/**
 * Validate one value against one schema from the supported subset.
 *
 * Returns `{ issues, gaps }`. A caller that sees any gap must treat the value
 * as unchecked: the schema asked a question this tool cannot answer, and an
 * unanswered question is not a pass.
 */
export function validateValue(schema, value, options = {}) {
  const ctx = context(options)
  walk(ctx, schema, value, options.valuePointer ?? '', options.schemaPath ?? '#', 0, [])
  return { issues: ctx.issues, gaps: ctx.gaps }
}

function walk(ctx, schema, value, valuePointer, schemaPath, depth, refStack) {
  if (depth > ctx.maxSchemaDepth) {
    gap(
      ctx,
      'limit-schema-depth-exceeded',
      valuePointer,
      `The contract schema nests deeper than the maxSchemaDepth limit of ${ctx.maxSchemaDepth}, so this value was not checked.`,
      schemaPath,
      'Raise limits.maxSchemaDepth, or flatten the schema.',
    )
    return
  }

  if (typeof schema === 'boolean') {
    gap(
      ctx,
      'schema-keyword-unsupported',
      valuePointer,
      'A boolean schema is outside the supported subset, so this value was not checked.',
      schemaPath,
      'Write the constraint as a schema object.',
    )
    return
  }
  if (!isRecord(schema)) {
    gap(
      ctx,
      'document-invalid',
      valuePointer,
      'A schema node must be a JSON object, so this value was not checked.',
      schemaPath,
    )
    return
  }

  if (Object.hasOwn(schema, '$schema')) {
    if (!SUPPORTED_DIALECTS.includes(schema.$schema)) {
      gap(
        ctx,
        'schema-dialect-unsupported',
        valuePointer,
        `This tool implements a bounded subset of ${SUPPORTED_DIALECTS[0]} only, so a schema declaring another dialect was not checked.`,
        describeValue(schema.$schema),
        `Declare "$schema": "${SUPPORTED_DIALECTS[0]}", or remove the keyword.`,
      )
      return
    }
  }

  // One sorted list reaches the report, so the order of these names is output.
  const unsupported = Object.keys(schema)
    .filter((keyword) => !SUPPORTED_KEYWORDS.includes(keyword))
    .sort(byCodeUnit)
  if (unsupported.length > 0) {
    gap(
      ctx,
      'schema-keyword-unsupported',
      valuePointer,
      `The contract uses ${unsupported.length} schema keyword(s) outside this tool's supported subset, so this value was not checked.`,
      `${schemaPath}: ${unsupported.map((keyword) => sanitize(keyword, 40)).join(', ')}`,
      'Rewrite the schema within the supported subset, or accept that this field is unverified.',
    )
    return
  }

  if (Object.hasOwn(schema, '$ref')) {
    const extra = Object.keys(schema).filter(
      (keyword) => !['$ref', '$schema', 'title', 'description'].includes(keyword),
    )
    if (extra.length > 0) {
      gap(
        ctx,
        'schema-keyword-unsupported',
        valuePointer,
        'A "$ref" combined with other constraint keywords is outside the supported subset, so this value was not checked.',
        schemaPath,
        'Move the extra keywords into the referenced schema.',
      )
      return
    }
    const reference = schema.$ref
    if (typeof reference !== 'string' || !reference.startsWith(REF_PREFIX) || reference.slice(REF_PREFIX.length).includes('/')) {
      gap(
        ctx,
        'schema-ref-unresolved',
        valuePointer,
        `Only local references of the form ${REF_PREFIX}NAME are supported, so this value was not checked.`,
        describeValue(reference),
        'Inline the schema, or move it under components.schemas in the same document.',
      )
      return
    }
    const name = reference.slice(REF_PREFIX.length)
    if (!Object.hasOwn(ctx.components, name)) {
      gap(
        ctx,
        'schema-ref-unresolved',
        valuePointer,
        'The contract references a schema that its components.schemas does not define, so this value was not checked.',
        sanitize(reference, 80),
        'Define the schema, or correct the reference.',
      )
      return
    }
    if (refStack.includes(name)) {
      gap(
        ctx,
        'schema-ref-cycle',
        valuePointer,
        'The contract schema references itself, and recursive schemas are outside the supported subset, so this value was not checked.',
        `${sanitize(reference, 60)} via ${refStack.map((entry) => sanitize(entry, 30)).join(' -> ')}`,
        'Flatten the recursion to a bounded depth, or accept that this field is unverified.',
      )
      return
    }
    walk(ctx, ctx.components[name], value, valuePointer, `#/components/schemas/${name}`, depth + 1, [...refStack, name])
    return
  }

  const allowed = allowedTypes(ctx, schema, valuePointer, schemaPath)
  if (allowed === null) return

  const actual = jsonTypeOf(value)
  if (allowed !== 'any') {
    const satisfied = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'))
    if (!satisfied) {
      issue(
        ctx,
        valuePointer,
        `Expected type ${allowed.join(' or ')} and found ${actual}.`,
        describeValue(value),
      )
      return
    }
  }

  if (Object.hasOwn(schema, 'const') && !jsonEqual(schema.const, value)) {
    issue(ctx, valuePointer, `Expected the constant ${describeValue(schema.const, 60)}.`, describeValue(value))
  }
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum)) {
      gap(ctx, 'document-invalid', valuePointer, 'The "enum" keyword must carry an array, so this value was not checked.', schemaPath)
      return
    }
    if (!schema.enum.some((candidate) => jsonEqual(candidate, value))) {
      issue(
        ctx,
        valuePointer,
        `Expected one of the ${schema.enum.length} enumerated value(s).`,
        `${describeValue(value, 40)} is not in ${describeValue(schema.enum, 90)}`,
      )
    }
  }

  if (actual === 'string') checkString(ctx, schema, value, valuePointer, schemaPath)
  else if (actual === 'number' || actual === 'integer') checkNumber(ctx, schema, value, valuePointer, schemaPath)
  else if (actual === 'array') checkArray(ctx, schema, value, valuePointer, schemaPath, depth, refStack)
  else if (actual === 'object') checkObject(ctx, schema, value, valuePointer, schemaPath, depth, refStack)
}

/** The set of types a schema allows, `'any'` when it says nothing, or null when it said something unsupported. */
function allowedTypes(ctx, schema, valuePointer, schemaPath) {
  const nullable = schema.nullable === true
  if (!Object.hasOwn(schema, 'type')) return 'any'
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type]
  for (const name of declared) {
    if (typeof name !== 'string' || !SUPPORTED_TYPES.includes(name)) {
      gap(
        ctx,
        'schema-keyword-unsupported',
        valuePointer,
        `The schema declares a type this tool does not implement, so this value was not checked.`,
        `${schemaPath}: type ${describeValue(name, 40)}`,
        `Use one of: ${SUPPORTED_TYPES.join(', ')}.`,
      )
      return null
    }
  }
  return nullable && !declared.includes('null') ? [...declared, 'null'] : declared
}

function checkString(ctx, schema, value, valuePointer, schemaPath) {
  const length = [...value].length
  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    issue(ctx, valuePointer, `Expected at least ${schema.minLength} character(s) and found ${length}.`, describeValue(value))
  }
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    issue(ctx, valuePointer, `Expected at most ${schema.maxLength} character(s) and found ${length}.`, describeValue(value))
  }
  if (Object.hasOwn(schema, 'pattern')) {
    const compiled = checkPattern(schema.pattern)
    if (!compiled.ok) {
      gap(
        ctx,
        'schema-pattern-refused',
        valuePointer,
        `The contract pattern was refused rather than run: ${compiled.reason}. This value was not checked.`,
        `${schemaPath}: ${describeValue(schema.pattern, 60)}`,
        'Simplify the pattern, or express the constraint with minLength, maxLength, enum or format.',
      )
    } else if (!compiled.regex.test(value)) {
      issue(ctx, valuePointer, `Expected a value matching the contract pattern.`, describeValue(value))
    }
  }
  if (Object.hasOwn(schema, 'format')) {
    const format = schema.format
    if (typeof format !== 'string' || !SUPPORTED_FORMATS.includes(format)) {
      gap(
        ctx,
        'schema-format-unsupported',
        valuePointer,
        'The contract declares a format this tool does not implement, so this value was not checked against it.',
        `${schemaPath}: format ${describeValue(format, 40)}`,
        `Implemented formats: ${SUPPORTED_FORMATS.join(', ')}.`,
      )
    } else if (!matchesFormat(format, value)) {
      issue(ctx, valuePointer, `Expected a value in the "${sanitize(format, 40)}" format.`, describeValue(value))
    }
  }
}

function checkNumber(ctx, schema, value, valuePointer, schemaPath) {
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== 'number') {
      gap(
        ctx,
        'schema-keyword-unsupported',
        valuePointer,
        `The "${keyword}" keyword is supported in its numeric form only, so this value was not checked.`,
        `${schemaPath}: ${keyword} ${describeValue(schema[keyword], 40)}`,
        'Write the bound as a number.',
      )
      return
    }
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    issue(ctx, valuePointer, `Expected a value of at least ${schema.minimum}.`, describeValue(value))
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    issue(ctx, valuePointer, `Expected a value of at most ${schema.maximum}.`, describeValue(value))
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    issue(ctx, valuePointer, `Expected a value above ${schema.exclusiveMinimum}.`, describeValue(value))
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    issue(ctx, valuePointer, `Expected a value below ${schema.exclusiveMaximum}.`, describeValue(value))
  }
}

function checkArray(ctx, schema, value, valuePointer, schemaPath, depth, refStack) {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    issue(ctx, valuePointer, `Expected at least ${schema.minItems} item(s) and found ${value.length}.`)
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    issue(ctx, valuePointer, `Expected at most ${schema.maxItems} item(s) and found ${value.length}.`)
  }
  if (schema.uniqueItems === true) {
    for (let index = 1; index < value.length; index += 1) {
      for (let earlier = 0; earlier < index; earlier += 1) {
        if (jsonEqual(value[earlier], value[index])) {
          issue(
            ctx,
            pointerAppend(valuePointer, String(index)),
            `Expected unique items and this one repeats the item at index ${earlier}.`,
            describeValue(value[index]),
          )
          break
        }
      }
    }
  }
  if (!Object.hasOwn(schema, 'items')) return
  if (Array.isArray(schema.items)) {
    gap(
      ctx,
      'schema-keyword-unsupported',
      valuePointer,
      'The array form of "items" (tuple validation) is outside the supported subset, so these items were not checked.',
      schemaPath,
      'Describe the items with a single schema, or accept that they are unverified.',
    )
    return
  }
  for (let index = 0; index < value.length; index += 1) {
    walk(ctx, schema.items, value[index], pointerAppend(valuePointer, String(index)), `${schemaPath}/items`, depth + 1, refStack)
  }
}

function checkObject(ctx, schema, value, valuePointer, schemaPath, depth, refStack) {
  const properties = isRecord(schema.properties) ? schema.properties : {}

  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required)) {
      gap(ctx, 'document-invalid', valuePointer, 'The "required" keyword must carry an array, so this value was not checked.', schemaPath)
      return
    }
    for (const name of schema.required) {
      if (typeof name !== 'string') {
        gap(ctx, 'document-invalid', valuePointer, 'Every entry in "required" must be a string, so this value was not checked.', schemaPath)
        return
      }
      if (!Object.hasOwn(value, name)) {
        issue(ctx, pointerAppend(valuePointer, name), 'The contract requires this property and it is absent.')
      }
    }
  }

  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    gap(
      ctx,
      'schema-keyword-unsupported',
      valuePointer,
      'The schema form of "additionalProperties" is outside the supported subset, so the extra properties of this object were not checked.',
      schemaPath,
      'Use additionalProperties: false, or accept that extra properties are unverified.',
    )
    return
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) {
        issue(
          ctx,
          pointerAppend(valuePointer, name),
          'The contract declares additionalProperties: false and does not define this property.',
          describeValue(value[name], 40),
        )
      }
    }
  }

  for (const name of Object.keys(properties)) {
    if (!Object.hasOwn(value, name)) continue
    walk(
      ctx,
      properties[name],
      value[name],
      pointerAppend(valuePointer, name),
      `${schemaPath}/properties/${name}`,
      depth + 1,
      refStack,
    )
  }
}
