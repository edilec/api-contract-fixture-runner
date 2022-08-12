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

const QUANTIFIERS = new Set(['*', '+', '?', '{'])

/** Whether a group body repeats or alternates, which is what makes a quantifier over it dangerous. */
function repeatsOrAlternates(body) {
  let inClass = false
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (inClass) {
      if (character === ']') inClass = false
      continue
    }
    if (character === '[') {
      inClass = true
      continue
    }
    if (character === '(' && body.slice(index, index + 3) === '(?:') {
      index += 2
      continue
    }
    if (character === '|' || QUANTIFIERS.has(character)) return true
  }
  return false
}

/**
 * Decide whether a `pattern` from a contract may be compiled and run.
 *
 * A contract is untrusted input, and `(a+)+$` against a long string is a denial
 * of service with no network and no dependency in sight. Rather than pretend to
 * detect every catastrophic pattern, this refuses a conservative superset:
 * anything over the length bound, any lookaround or named group, and any
 * quantifier applied to a group that itself repeats or alternates. A refusal is
 * reported and makes the run `incomplete`; it is never a quiet pass.
 */
export function checkPattern(source) {
  if (typeof source !== 'string') return { ok: false, reason: 'a pattern must be a string' }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `a pattern may be at most ${MAX_PATTERN_LENGTH} characters and this one is ${source.length}` }
  }

  const groupStarts = []
  let inClass = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (inClass) {
      if (character === ']') inClass = false
      continue
    }
    if (character === '[') {
      inClass = true
      continue
    }
    if (character === '(') {
      if (source[index + 1] === '?' && source[index + 2] !== ':') {
        return { ok: false, reason: 'lookaround, named groups and other extended group forms are outside the supported subset' }
      }
      groupStarts.push(index)
      continue
    }
    if (character === ')') {
      const start = groupStarts.pop()
      if (start === undefined) return { ok: false, reason: 'the pattern has an unbalanced group' }
      if (QUANTIFIERS.has(source[index + 1] ?? '') && repeatsOrAlternates(source.slice(start + 1, index))) {
        return { ok: false, reason: 'a quantifier is applied to a group that itself repeats or alternates, which can backtrack catastrophically' }
      }
    }
  }
  if (groupStarts.length > 0) return { ok: false, reason: 'the pattern has an unbalanced group' }

  let regex
  try {
    regex = new RegExp(source, 'u')
  } catch {
    return { ok: false, reason: 'the pattern did not compile as a Unicode regular expression' }
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
 * `new Date(...)` is not used anywhere in this package: a date check must not
 * depend on a host clock, a host time zone, or the parsing quirks of whatever
 * runtime is executing.
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
