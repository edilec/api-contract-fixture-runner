#!/usr/bin/env node

import process from 'node:process'

import { exitCodeFor, formatReport, runPlanFile, serializeReport } from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `api-contract-fixture-runner

Check API fixtures against a contract: the request each fixture sends, the
response it expects, and -- optionally -- what a local in-process mock answers.

An error response is not a contract violation. A fixture declaring a 422 with
the error body the contract documents is a PASS. Status, content type and body
are three separate checks with three separate rules, and none of them consults
the status class.

Optional live calls go to an in-process mock declared in the plan and nowhere
else. Any other target -- an external host, a non-loopback address, a
non-HTTP scheme, a URL carrying credentials -- is refused before a call is
constructed. No socket is opened, no hostname is resolved, and the run is
reported "incomplete" because the live evidence it asked for was never obtained.

Usage:
  api-contract-fixture-runner --plan FILE [--json] [--call|--no-call] [limits]

Options:
  --plan FILE              Run plan to check (JSON) (required)
  --label NAME             Value recorded as location.file for plan-level
                           findings (defaults to the --plan value as written)
  --call                   Make the optional in-process calls
  --no-call                Skip them, whatever the plan says
  --out FILE               Also write the JSON report to FILE. A destination
                           that is the same file as an input -- by path, by
                           symlink, or by hard link -- is refused and nothing
                           is written. A destination that cannot be written at
                           all is reported the same way, and the report still
                           goes to stdout rather than being thrown away.
  --json                   Suppress the human summary on stderr
  --max-document-bytes N   Maximum bytes per document (default 1048576)
  --max-operations N       Maximum contract operations (default 200)
  --max-cases N            Maximum fixture cases (default 500)
  --max-body-bytes N       Maximum bytes per body (default 65536)
  --max-body-depth N       Maximum nesting depth per body (default 16)
  --max-schema-depth N     Maximum schema nesting depth (default 24)
  --max-findings N         Maximum findings in the report (default 500)
  -h, --help               Show this help
  -v, --version            Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Documents are read, never written. There is no auto-fix.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Exit codes:
  0  every fixture case reached a verdict and the policy was satisfied
  1  the run completed and the policy failed (a status, content-type or body
     mismatch, a fixture naming an operation the contract does not declare)
  2  invalid usage or configuration (stdout is empty), or evidence that could
     not be obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-body-bytes', 'maxBodyBytes'],
  ['--max-body-depth', 'maxBodyDepth'],
  ['--max-cases', 'maxCases'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-operations', 'maxOperations'],
  ['--max-schema-depth', 'maxSchemaDepth'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { plan: null, label: null, out: null, json: false, call: null, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value, or that sets a mode, is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--plan a --plan b` checks a plan nobody named and `--max-cases 5
   * --max-cases 1` enforces a limit nobody asked for. That is the same defect
   * as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--call') {
      once('--call')
      if (given.has('--no-call')) throw new Error('--call and --no-call cannot both be given')
      options.call = true
    } else if (argument === '--no-call') {
      once('--no-call')
      if (given.has('--call')) throw new Error('--call and --no-call cannot both be given')
      options.call = false
    } else if (argument === '--plan') {
      once('--plan')
      options.plan = takeValue('--plan')
    } else if (argument === '--label') {
      once('--label')
      options.label = takeValue('--label')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.plan === null) throw new Error('--plan is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await runPlanFile(options.plan, {
      ...(options.label === null ? {} : { label: options.label }),
      ...(options.out === null ? {} : { out: options.out }),
      ...(options.call === null ? {} : { call: options.call }),
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))

  if (report.status === 'incomplete') {
    const { checked, cases, skipped } = report.summary
    process.stderr.write(
      `incomplete: ${checked} of ${cases} declared case(s) reached a verdict and ${skipped} were not checked. ` +
      `The findings say what was not examined; this is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
