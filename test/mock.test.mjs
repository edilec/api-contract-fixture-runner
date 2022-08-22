import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTarget, createInProcessMock, isLoopbackHost } from '../src/mock.mjs'

test('loopback is the whole 127 block, ::1 and localhost, and nothing else', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['0.0.0.0', '10.0.0.1', '128.0.0.1', '126.255.255.255', 'example.test', '127.0.0.256', '', 7, null]) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('an in-process mock on a loopback address is accepted', () => {
  const target = classifyTarget({ mode: 'in-process', baseUrl: 'http://127.0.0.1:8080/api' })
  assert.equal(target.ok, true)
  assert.equal(target.host, '127.0.0.1')
})

test('every other target is refused, and the reason names what was refused', () => {
  const cases = [
    [null, /no mock was declared/],
    [{ mode: 'http', baseUrl: 'http://127.0.0.1:8080' }, /only ever calls an in-process mock/],
    [{ mode: 'in-process', baseUrl: 'not a url' }, /not an absolute URL/],
    [{ mode: 'in-process', baseUrl: 'ftp://127.0.0.1/x' }, /ftp scheme/],
    [{ mode: 'in-process', baseUrl: 'http://user:secret@127.0.0.1/x' }, /carries credentials/],
    [{ mode: 'in-process', baseUrl: 'https://api.example.com/v1' }, /not a loopback address/],
    [{ mode: 'in-process', baseUrl: 'http://0.0.0.0:8080' }, /not a loopback address/],
  ]
  for (const [mock, expected] of cases) {
    const target = classifyTarget(mock)
    assert.equal(target.ok, false, JSON.stringify(mock))
    assert.match(target.reason, expected)
  }
})

test('the mock answers from its table and records every call in order', () => {
  const mock = createInProcessMock({
    mode: 'in-process',
    baseUrl: 'http://127.0.0.1:8080',
    routes: [
      { operationId: 'createOrder', caseId: 'rejected', status: 422, contentType: 'application/problem+json', body: { status: 422 } },
      { operationId: 'createOrder', status: 201, contentType: 'application/json', body: { id: 'a' } },
    ],
  })

  const narrow = mock.respond('createOrder', 'rejected')
  assert.equal(narrow.status, 422)
  assert.deepEqual(narrow.body, { status: 422 })

  const general = mock.respond('createOrder', 'accepted')
  assert.equal(general.status, 201)

  assert.equal(mock.respond('getOrder', 'anything'), null)
  assert.deepEqual(mock.calls, [
    { operationId: 'createOrder', caseId: 'rejected', status: 422, contentType: 'application/problem+json' },
    { operationId: 'createOrder', caseId: 'accepted', status: 201, contentType: 'application/json' },
  ])
})

test('a route without a body answers without one, which is not the same as an empty body', () => {
  const mock = createInProcessMock({
    mode: 'in-process',
    baseUrl: 'http://127.0.0.1:8080',
    routes: [{ operationId: 'deleteOrder', status: 204 }],
  })
  const answer = mock.respond('deleteOrder', 'any')
  assert.equal(answer.hasBody, false)
  assert.equal(answer.contentType, null)
})

test('the same plan produces the same answers every time', () => {
  const plan = {
    mode: 'in-process',
    baseUrl: 'http://127.0.0.1:8080',
    routes: [{ operationId: 'a', status: 200, body: { n: 1 } }],
  }
  const first = createInProcessMock(plan).respond('a', 'c')
  const second = createInProcessMock(plan).respond('a', 'c')
  assert.deepEqual(first, second)
})
