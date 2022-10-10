/**
 * api-contract-fixture-runner -- the three documents and their closed shapes.
 *
 * A run reads a plan, a contract and a fixture set. Every key at every level of
 * all three is closed: an undeclared key is refused by name rather than
 * ignored, because a one-character typo that is quietly dropped turns a real
 * failure into a green run. `expct` must not disable the response check.
 *
 * Nothing here touches the filesystem, the clock, the locale or the network;
 * these functions see parsed JSON and return findings-shaped rows.
 */

import { isRecord } from './schema.mjs'
import { describeValue, pointerAppend, sanitize } from './text.mjs'

/** An identifier must still name something after the report's rendering rules. */
function hasVisibleId(value) {
  return typeof value === 'string' && sanitize(value) !== ''
}

export const CONTRACT_VERSION = '1'
export const FIXTURE_VERSION = '1'

export const METHODS = Object.freeze(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'])

/** The only mock transport. A socket transport is absent rather than unfinished. */
export const MOCK_MODES = Object.freeze(['in-process'])

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 65536,
  maxBodyDepth: 16,
  maxCases: 500,
  maxDocumentBytes: 1048576,
  maxFindings: 500,
  maxOperations: 200,
  maxSchemaDepth: 24,
})

/** A configured limit may never be raised past these. A bound the config can spell past is not a bound. */
export const HARD_LIMITS = Object.freeze({
  maxBodyBytes: 1048576,
  maxBodyDepth: 64,
  maxCases: 5000,
  maxDocumentBytes: 8388608,
  maxFindings: 5000,
  maxOperations: 2000,
  maxSchemaDepth: 64,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))

/**
 * Merge configured limits over the defaults.
 *
 * Throws on an unknown name, a non-integer, a non-positive value or a value
 * above the hard cap. A limit is configuration, so a bad one is a usage error
 * and stdout stays empty.
 */
export function applyLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new TypeError(`Unknown limit "${sanitize(name, 60)}"; known limits are ${LIMIT_NAMES.join(', ')}`)
    }
    const value = overrides[name]
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`limits.${name} must be a positive integer`)
    if (value > HARD_LIMITS[name]) throw new TypeError(`limits.${name} must be no greater than ${HARD_LIMITS[name]}`)
    limits[name] = value
  }
  return Object.freeze(limits)
}

/* ------------------------------------------------------------------ media types */

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Split a media type into its essence and its parameters.
 *
 * Case is folded with `toLowerCase`, never its locale-sensitive sibling: the
 * Turkish dotless i would otherwise make `APPLICATION/JSON` fold differently
 * depending on the host locale, and this comparison decides pass or fail.
 */
export function parseMediaType(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'a media type must be a string' }
  const segments = value.split(';')
  const essence = segments[0].trim().toLowerCase()
  const slash = essence.indexOf('/')
  if (slash < 1 || slash === essence.length - 1) return { ok: false, reason: 'a media type must be type/subtype' }
  if (!TOKEN.test(essence.slice(0, slash)) || !TOKEN.test(essence.slice(slash + 1))) {
    return { ok: false, reason: 'a media type must be type/subtype' }
  }
  const parameters = new Map()
  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim()
    if (trimmed === '') continue
    const equals = trimmed.indexOf('=')
    if (equals < 1) return { ok: false, reason: 'a media type parameter must be name=value' }
    const name = trimmed.slice(0, equals).trim().toLowerCase()
    let parameterValue = trimmed.slice(equals + 1).trim()
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"') && parameterValue.length >= 2) {
      parameterValue = parameterValue.slice(1, -1)
    }
    parameters.set(name, parameterValue.toLowerCase())
  }
  return { ok: true, essence, parameters }
}

/**
 * Whether an actual media type satisfies a declared one.
 *
 * The essence must be equal, so `application/problem+json` does **not** satisfy
 * a declared `application/json`: a structured suffix is a hint to a generic
 * parser, not a licence to answer with a different media type than the contract
 * documents. Every parameter the contract declares must be present and equal;
 * a parameter the contract does not mention (a `charset` it is silent about) is
 * allowed through.
 */
export function mediaTypeMatches(declared, actual) {
  const left = parseMediaType(declared)
  const right = parseMediaType(actual)
  if (!left.ok || !right.ok) return false
  if (left.essence !== right.essence) return false
  for (const [name, value] of left.parameters) {
    if (right.parameters.get(name) !== value) return false
  }
  return true
}

/* ------------------------------------------------------------------ paths */

const TEMPLATE_SEGMENT = /^\{[^{}/]+\}$/

/** Whether a concrete request path satisfies an operation's path template. */
export function pathMatches(template, path) {
  const left = String(template).split('/')
  const right = String(path).split('/')
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (TEMPLATE_SEGMENT.test(left[index])) {
      if (right[index] === '') return false
      continue
    }
    if (left[index] !== right[index]) return false
  }
  return true
}

/* ------------------------------------------------------------------ shared shape helpers */

function fail(errors, pointer, message, evidence) {
  errors.push({ pointer, message, ...(evidence === undefined ? {} : { evidence }) })
}

function closedKeys(record, allowed, pointer, unknown) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      unknown.push({
        pointer: pointerAppend(pointer, key),
        message: `The key "${sanitize(key, 60)}" is not part of this document's schema, so it was not applied.`,
        evidence: `known keys: ${allowed.join(', ')}`,
      })
    }
  }
}

function requireRecord(value, errors, pointer, label) {
  if (isRecord(value)) return true
  fail(errors, pointer, `${label} must be a JSON object.`, describeValue(value, 40))
  return false
}

function checkHeaderDeclaration(value, errors, unknown, pointer, label) {
  if (!requireRecord(value, errors, pointer, label)) return
  for (const name of Object.keys(value)) {
    const declaration = value[name]
    const here = pointerAppend(pointer, name)
    if (!requireRecord(declaration, errors, here, `The declaration of header "${sanitize(name, 40)}"`)) continue
    closedKeys(declaration, ['required'], here, unknown)
    if (Object.hasOwn(declaration, 'required') && typeof declaration.required !== 'boolean') {
      fail(errors, pointerAppend(here, 'required'), 'A header "required" flag must be a boolean.', describeValue(declaration.required, 40))
    }
  }
}

function checkHeaderValues(value, errors, pointer, label) {
  if (!requireRecord(value, errors, pointer, label)) return
  for (const name of Object.keys(value)) {
    if (typeof value[name] !== 'string') {
      fail(errors, pointerAppend(pointer, name), 'A header value must be a string.', describeValue(value[name], 40))
    }
  }
}

function checkStatus(value, errors, pointer) {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    fail(errors, pointer, 'A status must be an integer from 100 to 599.', describeValue(value, 40))
    return false
  }
  return true
}

function checkContentType(value, errors, pointer) {
  const parsed = parseMediaType(value)
  if (!parsed.ok) {
    fail(errors, pointer, `A content type could not be parsed: ${parsed.reason}.`, describeValue(value, 60))
    return false
  }
  return true
}

/* ------------------------------------------------------------------ the contract document */

const CONTRACT_KEYS = ['components', 'contractVersion', 'jsonSchemaDialect', 'operations', 'title']
const OPERATION_KEYS = ['description', 'id', 'method', 'path', 'request', 'responses']
const REQUEST_KEYS = ['body', 'contentType', 'headers']
const RESPONSE_KEYS = ['body', 'contentType', 'headers', 'status']

/**
 * Validate the shape of a contract document.
 *
 * Only the shape. Whether a schema inside it is one this tool can evaluate is
 * decided later, when a value is actually checked against it, because that is
 * the only place the answer can be attached to the field it affects.
 */
export function validateContract(document, limits) {
  const errors = []
  const unknown = []
  if (!requireRecord(document, errors, '/', 'A contract document')) return { ok: false, errors, unknown }

  closedKeys(document, CONTRACT_KEYS, '', unknown)

  if (document.contractVersion !== CONTRACT_VERSION) {
    fail(
      errors,
      '/contractVersion',
      `This tool reads contract documents of version "${CONTRACT_VERSION}".`,
      describeValue(document.contractVersion, 40),
    )
  }
  if (Object.hasOwn(document, 'title') && typeof document.title !== 'string') {
    fail(errors, '/title', 'A contract title must be a string.', describeValue(document.title, 40))
  }
  if (Object.hasOwn(document, 'jsonSchemaDialect') && typeof document.jsonSchemaDialect !== 'string') {
    fail(
      errors,
      '/jsonSchemaDialect',
      'A contract "jsonSchemaDialect" must be a string naming the dialect its schemas are written in.',
      describeValue(document.jsonSchemaDialect, 60),
    )
  }
  if (Object.hasOwn(document, 'components')) {
    if (requireRecord(document.components, errors, '/components', 'The "components" section')) {
      closedKeys(document.components, ['schemas'], '/components', unknown)
      if (Object.hasOwn(document.components, 'schemas')) {
        requireRecord(document.components.schemas, errors, '/components/schemas', 'The "components.schemas" section')
      }
    }
  }

  if (!Array.isArray(document.operations)) {
    fail(errors, '/operations', 'A contract must declare an "operations" array.', describeValue(document.operations, 40))
    return { ok: errors.length === 0, errors, unknown }
  }
  if (document.operations.length === 0) {
    fail(errors, '/operations', 'A contract must declare at least one operation; a contract with none can only produce a verdict on no evidence.')
  }
  if (document.operations.length > limits.maxOperations) {
    return { ok: false, errors, unknown, tooManyOperations: document.operations.length }
  }

  const seen = new Set()
  for (let index = 0; index < document.operations.length; index += 1) {
    const pointer = `/operations/${index}`
    const operation = document.operations[index]
    if (!requireRecord(operation, errors, pointer, 'An operation')) continue
    closedKeys(operation, OPERATION_KEYS, pointer, unknown)

    if (!hasVisibleId(operation.id)) {
      fail(errors, pointerAppend(pointer, 'id'), 'An operation must declare a non-empty string id.', describeValue(operation.id, 40))
    } else if (seen.has(operation.id)) {
      fail(errors, pointerAppend(pointer, 'id'), 'Two operations declare the same id, so a fixture could not name one of them.', sanitize(operation.id, 60))
    } else {
      seen.add(operation.id)
    }

    if (typeof operation.method !== 'string' || !METHODS.includes(operation.method)) {
      fail(errors, pointerAppend(pointer, 'method'), `An operation method must be one of ${METHODS.join(', ')}.`, describeValue(operation.method, 40))
    }
    if (typeof operation.path !== 'string' || !operation.path.startsWith('/')) {
      fail(errors, pointerAppend(pointer, 'path'), 'An operation path must be a string beginning with "/".', describeValue(operation.path, 60))
    }
    if (Object.hasOwn(operation, 'description') && typeof operation.description !== 'string') {
      fail(errors, pointerAppend(pointer, 'description'), 'An operation description must be a string.', describeValue(operation.description, 40))
    }

    if (Object.hasOwn(operation, 'request')) {
      const requestPointer = pointerAppend(pointer, 'request')
      if (requireRecord(operation.request, errors, requestPointer, 'An operation request')) {
        closedKeys(operation.request, REQUEST_KEYS, requestPointer, unknown)
        if (Object.hasOwn(operation.request, 'contentType')) {
          checkContentType(operation.request.contentType, errors, pointerAppend(requestPointer, 'contentType'))
        }
        if (Object.hasOwn(operation.request, 'headers')) {
          checkHeaderDeclaration(operation.request.headers, errors, unknown, pointerAppend(requestPointer, 'headers'), 'Request headers')
        }
      }
    }

    const responsesPointer = pointerAppend(pointer, 'responses')
    if (!Array.isArray(operation.responses) || operation.responses.length === 0) {
      fail(errors, responsesPointer, 'An operation must declare a non-empty "responses" array.', describeValue(operation.responses, 40))
      continue
    }
    const statuses = new Set()
    for (let responseIndex = 0; responseIndex < operation.responses.length; responseIndex += 1) {
      const here = `${responsesPointer}/${responseIndex}`
      const response = operation.responses[responseIndex]
      if (!requireRecord(response, errors, here, 'A response')) continue
      closedKeys(response, RESPONSE_KEYS, here, unknown)
      if (checkStatus(response.status, errors, pointerAppend(here, 'status'))) {
        if (statuses.has(response.status)) {
          fail(errors, pointerAppend(here, 'status'), 'Two responses of one operation declare the same status.', String(response.status))
        }
        statuses.add(response.status)
      }
      if (Object.hasOwn(response, 'contentType')) {
        checkContentType(response.contentType, errors, pointerAppend(here, 'contentType'))
      }
      if (Object.hasOwn(response, 'headers')) {
        checkHeaderDeclaration(response.headers, errors, unknown, pointerAppend(here, 'headers'), 'Response headers')
      }
    }
  }

  return { ok: errors.length === 0, errors, unknown }
}

/* ------------------------------------------------------------------ the fixture document */

const FIXTURES_KEYS = ['cases', 'description', 'fixtureVersion']
const CASE_KEYS = ['call', 'description', 'expect', 'id', 'operationId', 'request']
const CASE_REQUEST_KEYS = ['body', 'contentType', 'headers', 'method', 'path']
const CASE_EXPECT_KEYS = ['body', 'contentType', 'headers', 'status']

/** Validate the shape of a fixture document. */
export function validateFixtures(document, limits) {
  const errors = []
  const unknown = []
  if (!requireRecord(document, errors, '/', 'A fixture document')) return { ok: false, errors, unknown }

  closedKeys(document, FIXTURES_KEYS, '', unknown)
  if (document.fixtureVersion !== FIXTURE_VERSION) {
    fail(
      errors,
      '/fixtureVersion',
      `This tool reads fixture documents of version "${FIXTURE_VERSION}".`,
      describeValue(document.fixtureVersion, 40),
    )
  }
  if (Object.hasOwn(document, 'description') && typeof document.description !== 'string') {
    fail(errors, '/description', 'A fixture description must be a string.', describeValue(document.description, 40))
  }

  if (!Array.isArray(document.cases)) {
    fail(errors, '/cases', 'A fixture document must declare a "cases" array.', describeValue(document.cases, 40))
    return { ok: false, errors, unknown }
  }
  if (document.cases.length > limits.maxCases) {
    return { ok: false, errors, unknown, tooManyCases: document.cases.length }
  }

  for (let index = 0; index < document.cases.length; index += 1) {
    const pointer = `/cases/${index}`
    const fixture = document.cases[index]
    if (!requireRecord(fixture, errors, pointer, 'A fixture case')) continue
    closedKeys(fixture, CASE_KEYS, pointer, unknown)

    if (!hasVisibleId(fixture.id)) {
      fail(errors, pointerAppend(pointer, 'id'), 'A fixture case must declare a non-empty string id.', describeValue(fixture.id, 40))
    }
    if (!hasVisibleId(fixture.operationId)) {
      fail(errors, pointerAppend(pointer, 'operationId'), 'A fixture case must name the operation it exercises.', describeValue(fixture.operationId, 40))
    }
    if (Object.hasOwn(fixture, 'description') && typeof fixture.description !== 'string') {
      fail(errors, pointerAppend(pointer, 'description'), 'A fixture description must be a string.', describeValue(fixture.description, 40))
    }
    if (Object.hasOwn(fixture, 'call') && typeof fixture.call !== 'boolean') {
      fail(errors, pointerAppend(pointer, 'call'), 'A fixture "call" flag must be a boolean.', describeValue(fixture.call, 40))
    }

    const requestPointer = pointerAppend(pointer, 'request')
    if (requireRecord(fixture.request, errors, requestPointer, 'A fixture request')) {
      closedKeys(fixture.request, CASE_REQUEST_KEYS, requestPointer, unknown)
      if (typeof fixture.request.method !== 'string' || !METHODS.includes(fixture.request.method)) {
        fail(errors, pointerAppend(requestPointer, 'method'), `A fixture request method must be one of ${METHODS.join(', ')}.`, describeValue(fixture.request.method, 40))
      }
      if (typeof fixture.request.path !== 'string' || !fixture.request.path.startsWith('/')) {
        fail(errors, pointerAppend(requestPointer, 'path'), 'A fixture request path must be a string beginning with "/".', describeValue(fixture.request.path, 60))
      } else if (fixture.request.path.includes('?') || fixture.request.path.includes('#')) {
        fail(
          errors,
          pointerAppend(requestPointer, 'path'),
          'A fixture request path carries a query string or fragment, and query parameters are outside what this tool checks.',
          describeValue(fixture.request.path, 60),
        )
      }
      if (Object.hasOwn(fixture.request, 'contentType')) {
        checkContentType(fixture.request.contentType, errors, pointerAppend(requestPointer, 'contentType'))
      }
      if (Object.hasOwn(fixture.request, 'headers')) {
        checkHeaderValues(fixture.request.headers, errors, pointerAppend(requestPointer, 'headers'), 'Fixture request headers')
      }
    }

    const expectPointer = pointerAppend(pointer, 'expect')
    if (requireRecord(fixture.expect, errors, expectPointer, 'A fixture expectation')) {
      closedKeys(fixture.expect, CASE_EXPECT_KEYS, expectPointer, unknown)
      checkStatus(fixture.expect.status, errors, pointerAppend(expectPointer, 'status'))
      if (Object.hasOwn(fixture.expect, 'contentType')) {
        checkContentType(fixture.expect.contentType, errors, pointerAppend(expectPointer, 'contentType'))
      }
      if (Object.hasOwn(fixture.expect, 'headers')) {
        checkHeaderValues(fixture.expect.headers, errors, pointerAppend(expectPointer, 'headers'), 'Fixture expected headers')
      }
    }
  }

  return { ok: errors.length === 0, errors, unknown }
}

/* ------------------------------------------------------------------ the plan document */

const PLAN_KEYS = ['call', 'contract', 'description', 'fixtures', 'limits', 'mock']
const MOCK_KEYS = ['baseUrl', 'mode', 'routes']
const ROUTE_KEYS = ['body', 'caseId', 'contentType', 'headers', 'operationId', 'status']

/** Validate the shape of a plan document. */
export function validatePlan(document) {
  const errors = []
  const unknown = []
  if (!requireRecord(document, errors, '/', 'A plan document')) return { ok: false, errors, unknown }

  closedKeys(document, PLAN_KEYS, '', unknown)

  for (const key of ['contract', 'fixtures']) {
    if (typeof document[key] !== 'string' || document[key].trim() === '') {
      fail(errors, `/${key}`, `A plan must name its "${key}" document as a non-empty path.`, describeValue(document[key], 60))
    }
  }
  if (Object.hasOwn(document, 'description') && typeof document.description !== 'string') {
    fail(errors, '/description', 'A plan description must be a string.', describeValue(document.description, 40))
  }
  if (Object.hasOwn(document, 'call') && typeof document.call !== 'boolean') {
    fail(errors, '/call', 'A plan "call" flag must be a boolean.', describeValue(document.call, 40))
  }
  if (Object.hasOwn(document, 'limits')) {
    if (requireRecord(document.limits, errors, '/limits', 'The "limits" section')) {
      closedKeys(document.limits, LIMIT_NAMES, '/limits', unknown)
      // The values are checked here rather than left to `applyLimits`, so a bad
      // limit in a plan file is reported on stdout like any other defect in a
      // document the run did read -- not thrown as a usage error with nothing
      // on stdout to say which key was wrong.
      for (const name of LIMIT_NAMES) {
        if (!Object.hasOwn(document.limits, name)) continue
        const value = document.limits[name]
        if (!Number.isInteger(value) || value < 1) {
          fail(errors, `/limits/${name}`, `The limit "${name}" must be a positive integer.`, describeValue(value, 40))
        } else if (value > HARD_LIMITS[name]) {
          fail(errors, `/limits/${name}`, `The limit "${name}" must be no greater than ${HARD_LIMITS[name]}.`, String(value))
        }
      }
    }
  }

  if (Object.hasOwn(document, 'mock')) {
    const mock = document.mock
    if (requireRecord(mock, errors, '/mock', 'The "mock" section')) {
      closedKeys(mock, MOCK_KEYS, '/mock', unknown)
      if (typeof mock.mode !== 'string' || !MOCK_MODES.includes(mock.mode)) {
        fail(errors, '/mock/mode', `A mock mode must be one of ${MOCK_MODES.join(', ')}.`, describeValue(mock.mode, 40))
      }
      if (typeof mock.baseUrl !== 'string' || mock.baseUrl === '') {
        fail(errors, '/mock/baseUrl', 'A mock must declare the base URL it answers on.', describeValue(mock.baseUrl, 60))
      }
      if (!Array.isArray(mock.routes)) {
        fail(errors, '/mock/routes', 'A mock must declare a "routes" array.', describeValue(mock.routes, 40))
      } else {
        const seen = new Set()
        for (let index = 0; index < mock.routes.length; index += 1) {
          const pointer = `/mock/routes/${index}`
          const route = mock.routes[index]
          if (!requireRecord(route, errors, pointer, 'A mock route')) continue
          closedKeys(route, ROUTE_KEYS, pointer, unknown)
          if (Object.hasOwn(route, 'caseId') && !hasVisibleId(route.caseId)) {
            fail(errors, pointerAppend(pointer, 'caseId'), 'A mock route "caseId" must be a non-empty string.', describeValue(route.caseId, 40))
          }
          if (!hasVisibleId(route.operationId)) {
            fail(errors, pointerAppend(pointer, 'operationId'), 'A mock route must name the operation it answers.', describeValue(route.operationId, 40))
          } else {
            const key = JSON.stringify([route.operationId, Object.hasOwn(route, 'caseId') ? route.caseId : null])
            if (seen.has(key)) {
              fail(errors, pointerAppend(pointer, 'operationId'), 'Two mock routes answer the same operation for the same case.', sanitize(route.operationId, 60))
            } else {
              seen.add(key)
            }
          }
          checkStatus(route.status, errors, pointerAppend(pointer, 'status'))
          if (Object.hasOwn(route, 'contentType')) {
            checkContentType(route.contentType, errors, pointerAppend(pointer, 'contentType'))
          }
          if (Object.hasOwn(route, 'headers')) {
            checkHeaderValues(route.headers, errors, pointerAppend(pointer, 'headers'), 'Mock route headers')
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, unknown }
}
