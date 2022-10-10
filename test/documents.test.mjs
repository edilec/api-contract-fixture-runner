import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  HARD_LIMITS,
  LIMIT_NAMES,
  applyLimits,
  mediaTypeMatches,
  parseMediaType,
  pathMatches,
  validateContract,
  validateFixtures,
  validatePlan,
} from '../src/documents.mjs'

const limits = DEFAULT_LIMITS

test('a media type splits into an essence and parameters', () => {
  const parsed = parseMediaType('Application/JSON; charset="UTF-8"')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.essence, 'application/json')
  assert.equal(parsed.parameters.get('charset'), 'utf-8')
  assert.equal(parseMediaType('json').ok, false)
  assert.equal(parseMediaType('application/').ok, false)
  assert.equal(parseMediaType('/json').ok, false)
  assert.equal(parseMediaType('application/json; charset').ok, false)
  assert.equal(parseMediaType(7).ok, false)
})

test('a structured suffix is not a licence to answer with a different media type', () => {
  assert.equal(mediaTypeMatches('application/json', 'application/json'), true)
  assert.equal(mediaTypeMatches('application/json', 'application/json; charset=utf-8'), true)
  assert.equal(mediaTypeMatches('application/json; charset=utf-8', 'application/json'), false)
  assert.equal(mediaTypeMatches('application/json', 'application/problem+json'), false)
  assert.equal(mediaTypeMatches('application/problem+json', 'application/json'), false)
  assert.equal(mediaTypeMatches('application/json', 'APPLICATION/JSON'), true)
})

test('a path template matches a concrete path segment by segment', () => {
  assert.equal(pathMatches('/orders/{orderId}', '/orders/42'), true)
  assert.equal(pathMatches('/orders/{orderId}', '/orders/42/items'), false)
  assert.equal(pathMatches('/orders/{orderId}', '/orders/'), false)
  assert.equal(pathMatches('/orders', '/orders'), true)
  assert.equal(pathMatches('/orders', '/Orders'), false)
  assert.equal(pathMatches('/orders/{a}/items/{b}', '/orders/1/items/2'), true)
})

test('limits merge over the defaults and refuse anything outside their bounds', () => {
  assert.equal(applyLimits({}).maxCases, DEFAULT_LIMITS.maxCases)
  assert.equal(applyLimits({ maxCases: 7 }).maxCases, 7)
  assert.throws(() => applyLimits({ maxCase: 7 }), /Unknown limit "maxCase"/)
  assert.throws(() => applyLimits({ maxCases: 0 }), /positive integer/)
  assert.throws(() => applyLimits({ maxCases: 1.5 }), /positive integer/)
  assert.throws(() => applyLimits({ maxCases: HARD_LIMITS.maxCases + 1 }), /no greater than/)
  assert.throws(() => applyLimits('nope'), /limits must be an object/)
  for (const name of LIMIT_NAMES) {
    assert.equal(applyLimits({ [name]: HARD_LIMITS[name] })[name], HARD_LIMITS[name], `${name} at the cap`)
    assert.throws(() => applyLimits({ [name]: HARD_LIMITS[name] + 1 }), new RegExp(name), `${name} above the cap`)
  }
})

const goodContract = {
  contractVersion: '1',
  operations: [
    {
      id: 'createOrder',
      method: 'POST',
      path: '/orders',
      request: { contentType: 'application/json', headers: { 'Idempotency-Key': { required: true } }, body: { type: 'object' } },
      responses: [{ status: 201, contentType: 'application/json', body: { type: 'object' } }],
    },
  ],
}

test('a well-formed contract validates', () => {
  const result = validateContract(goodContract, limits)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.unknown, [])
  assert.equal(result.ok, true)
})

test('the contract shape is closed at every level', () => {
  const withTypo = structuredClone(goodContract)
  withTypo.operatoins = []
  withTypo.operations[0].reqeust = {}
  withTypo.operations[0].responses[0].contnetType = 'application/json'
  const result = validateContract(withTypo, limits)
  assert.deepEqual(result.unknown.map((row) => row.pointer).sort(), [
    '/operations/0/reqeust',
    '/operations/0/responses/0/contnetType',
    '/operatoins',
  ])
})

test('the contract refuses the shapes that would make a verdict meaningless', () => {
  const cases = [
    [{}, '/contractVersion'],
    [{ contractVersion: '1' }, '/operations'],
    [{ contractVersion: '1', operations: [] }, '/operations'],
    [{ contractVersion: '1', operations: [{ id: '', method: 'POST', path: '/a', responses: [{ status: 201 }] }] }, '/operations/0/id'],
    [{ contractVersion: '1', operations: [{ id: 'a', method: 'FETCH', path: '/a', responses: [{ status: 201 }] }] }, '/operations/0/method'],
    [{ contractVersion: '1', operations: [{ id: 'a', method: 'GET', path: 'a', responses: [{ status: 201 }] }] }, '/operations/0/path'],
    [{ contractVersion: '1', operations: [{ id: 'a', method: 'GET', path: '/a', responses: [] }] }, '/operations/0/responses'],
    [{ contractVersion: '1', operations: [{ id: 'a', method: 'GET', path: '/a', responses: [{ status: 99 }] }] }, '/operations/0/responses/0/status'],
    [
      { contractVersion: '1', operations: [{ id: 'a', method: 'GET', path: '/a', responses: [{ status: 200 }, { status: 200 }] }] },
      '/operations/0/responses/1/status',
    ],
  ]
  for (const [document, pointer] of cases) {
    const result = validateContract(document, limits)
    assert.equal(result.ok, false, pointer)
    assert.equal(result.errors.some((row) => row.pointer === pointer), true, `${pointer} must be reported`)
  }
})

test('the declared dialect must be a string, and a string is not enough', () => {
  const wrongType = structuredClone(goodContract)
  wrongType.jsonSchemaDialect = 12345
  const result = validateContract(wrongType, limits)
  assert.equal(result.ok, false)
  assert.equal(result.errors.some((row) => row.pointer === '/jsonSchemaDialect'), true)

  // The shape check only says it is a string. Whether it names a dialect this
  // tool implements is decided in the run, where it can stop one.
  const wrongDialect = structuredClone(goodContract)
  wrongDialect.jsonSchemaDialect = 'http://json-schema.org/draft-07/schema#'
  assert.equal(validateContract(wrongDialect, limits).ok, true)
})

test('two operations may not share an id', () => {
  const clashing = structuredClone(goodContract)
  clashing.operations.push(structuredClone(goodContract.operations[0]))
  const result = validateContract(clashing, limits)
  assert.equal(result.errors.some((row) => row.pointer === '/operations/1/id'), true)
})

const goodFixtures = {
  fixtureVersion: '1',
  cases: [
    {
      id: 'ok',
      operationId: 'createOrder',
      request: { method: 'POST', path: '/orders', contentType: 'application/json', headers: { 'Idempotency-Key': 'k' }, body: {} },
      expect: { status: 201, contentType: 'application/json', body: {} },
    },
  ],
}

test('a well-formed fixture document validates', () => {
  const result = validateFixtures(goodFixtures, limits)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.unknown, [])
})

test('a misspelled "expect" is refused rather than silently skipping the response check', () => {
  const typo = structuredClone(goodFixtures)
  typo.cases[0].expct = typo.cases[0].expect
  delete typo.cases[0].expect
  const result = validateFixtures(typo, limits)
  assert.equal(result.unknown.some((row) => row.pointer === '/cases/0/expct'), true)
  assert.equal(result.errors.some((row) => row.pointer === '/cases/0/expect'), true)
})

test('a fixture path may not smuggle a query string past the checker', () => {
  const query = structuredClone(goodFixtures)
  query.cases[0].request.path = '/orders?force=true'
  const result = validateFixtures(query, limits)
  assert.equal(result.errors.some((row) => row.pointer === '/cases/0/request/path'), true)
})

test('a fixture case must name itself and an operation', () => {
  for (const key of ['id', 'operationId']) {
    const broken = structuredClone(goodFixtures)
    delete broken.cases[0][key]
    const result = validateFixtures(broken, limits)
    assert.equal(result.errors.some((row) => row.pointer === `/cases/0/${key}`), true, key)
  }
})

const goodPlan = {
  contract: 'contract.json',
  fixtures: 'fixtures.json',
  call: true,
  mock: { mode: 'in-process', baseUrl: 'http://127.0.0.1:8080', routes: [{ operationId: 'createOrder', status: 201 }] },
}

test('a well-formed plan validates', () => {
  const result = validatePlan(goodPlan)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.unknown, [])
})

test('the plan shape is closed and its mock is checked', () => {
  const broken = structuredClone(goodPlan)
  broken.mock.mode = 'http'
  broken.mock.routes[0].status = 'created'
  broken.calls = true
  const result = validatePlan(broken)
  assert.equal(result.unknown.some((row) => row.pointer === '/calls'), true)
  assert.equal(result.errors.some((row) => row.pointer === '/mock/mode'), true)
  assert.equal(result.errors.some((row) => row.pointer === '/mock/routes/0/status'), true)
})

test('two mock routes may not answer the same operation for the same case', () => {
  const clashing = structuredClone(goodPlan)
  clashing.mock.routes.push({ operationId: 'createOrder', status: 500 })
  assert.equal(validatePlan(clashing).errors.some((row) => row.pointer === '/mock/routes/1/operationId'), true)

  const narrowed = structuredClone(goodPlan)
  narrowed.mock.routes[0].caseId = 'one'
  narrowed.mock.routes.push({ operationId: 'createOrder', caseId: 'two', status: 500 })
  assert.deepEqual(validatePlan(narrowed).errors, [])
})

test('a mock route identifier that renders empty is invalid at either field', () => {
  for (const key of ['operationId', 'caseId']) {
    const plan = structuredClone(goodPlan)
    plan.mock.routes[0][key] = String.fromCharCode(0x200e)
    const result = validatePlan(plan)
    assert.equal(result.ok, false, key)
    assert.equal(result.errors.some((row) => row.pointer === `/mock/routes/0/${key}`), true, key)
  }
})

test('a mock route identifier with visible text remains legal after rendering', () => {
  const plan = structuredClone(goodPlan)
  const mark = String.fromCharCode(0x200e)
  plan.mock.routes[0].operationId = `createOrder${mark}`
  plan.mock.routes[0].caseId = `case${mark}`
  assert.deepEqual(validatePlan(plan).errors, [])
})

test('a plan must name both documents', () => {
  for (const key of ['contract', 'fixtures']) {
    const broken = structuredClone(goodPlan)
    delete broken[key]
    assert.equal(validatePlan(broken).errors.some((row) => row.pointer === `/${key}`), true, key)
  }
})
