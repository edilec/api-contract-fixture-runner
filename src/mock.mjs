/**
 * api-contract-fixture-runner -- the local mock, and the refusal that guards it.
 *
 * An optional live call in this tool is a function call into a table declared
 * in the plan. There is no socket, no hostname resolution and no request: this
 * package imports no socket, HTTP, datagram, resolver or TLS module, invokes no
 * fetch primitive, and spawns no process, so there is no code path a contract
 * or a fixture could steer towards a network.
 *
 * The declared target is still classified, and anything that is not the local
 * in-process mock is refused **before** a call is constructed. That refusal is
 * not defence in depth for its own sake: it is the difference between a tool
 * that cannot reach your staging API and a tool that merely does not happen to.
 * A plan pointing at `https://api.example.com` is told so, loudly, and fails
 * the run -- it is never quietly answered from the local table as though the
 * remote host had replied.
 */

import { describeValue } from './text.mjs'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Whether a host names this machine.
 *
 * The whole 127.0.0.0/8 block, the IPv6 loopback, and the literal name
 * `localhost`. Nothing else, and `0.0.0.0` deliberately not: it is a wildcard
 * bind address, not a loopback destination.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const lowered = host.toLowerCase()
  if (lowered === 'localhost' || lowered === '::1' || lowered === '[::1]') return true
  const parts = IPV4.exec(lowered)
  if (parts === null) return false
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(parts[index])
    if (!Number.isInteger(octet) || octet > 255) return false
  }
  return Number(parts[1]) === 127
}

/**
 * Decide whether the declared mock may be called at all.
 *
 * Every refusal names what was refused and why. A refusal is a verdict about
 * the plan, so it is returned rather than thrown: the report must be able to
 * carry it.
 */
export function classifyTarget(mock) {
  if (mock === null || typeof mock !== 'object') {
    return { ok: false, reason: 'no mock was declared' }
  }
  if (mock.mode !== 'in-process') {
    return {
      ok: false,
      reason: `the mock mode is ${describeValue(mock.mode, 40)} and this tool only ever calls an in-process mock`,
    }
  }
  let url
  try {
    url = new URL(String(mock.baseUrl))
  } catch {
    return { ok: false, reason: 'the mock base URL is not an absolute URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'the mock base URL uses an unsupported scheme; only http and https are accepted' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the mock base URL carries credentials, which a fixture run must never handle' }
  }
  if (!isLoopbackHost(url.hostname)) {
    return { ok: false, reason: 'the mock base URL host is not a loopback address, so it names a machine other than this one' }
  }
  return { ok: true, host: url.hostname, url: url.href }
}

/**
 * Build the in-process mock from its declared route table.
 *
 * `respond` is a pure lookup: same plan, same answer, every time, with no
 * clock, no randomness and no I/O. Calls are recorded in the order they were
 * made so the report can show exactly what was asked and what came back.
 */
export function createInProcessMock(mock) {
  const routes = (Array.isArray(mock.routes) ? mock.routes : []).filter(
    (route) => typeof route?.operationId === 'string',
  )
  const calls = []

  return {
    mode: mock.mode,
    baseUrl: String(mock.baseUrl),
    calls,
    /**
     * The declared answer for one operation, or null when the table has none.
     *
     * A route may narrow itself to one fixture case with `caseId`, so a stub can
     * answer 201 to the success fixture and 422 to the validation fixture of the
     * same operation. The narrower route wins; a route without a `caseId`
     * answers every case the narrower ones did not claim.
     */
    respond(operationId, caseId) {
      const route =
        routes.find((candidate) => candidate.operationId === operationId && candidate.caseId === caseId) ??
        routes.find((candidate) => candidate.operationId === operationId && !Object.hasOwn(candidate, 'caseId'))
      if (route === undefined) return null
      const response = {
        status: route.status,
        contentType: Object.hasOwn(route, 'contentType') ? route.contentType : null,
        headers: Object.hasOwn(route, 'headers') ? route.headers : {},
        hasBody: Object.hasOwn(route, 'body'),
        body: Object.hasOwn(route, 'body') ? route.body : undefined,
      }
      calls.push({ operationId, caseId: caseId ?? null, status: response.status, contentType: response.contentType })
      return response
    },
  }
}
