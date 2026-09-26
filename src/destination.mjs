import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Raised when an output destination cannot be written to safely.
 *
 * A refused destination is a configuration error, not a finding: the run was
 * asked to write somewhere it must not write, so nothing is written, stdout
 * stays empty and the caller exits 2. There is no subject to report about --
 * the destination was wrong before any artifact was described.
 */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/** A path with more than this many missing ancestors is a mistake, not a tree. */
const ANCESTOR_PROBE_LIMIT = 64

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * Three distinct holes, and each one needs its own check because no one of them
 * catches the others. Measured across this catalog rather than imagined: ten
 * tools accepted a destination that destroyed a file they were never asked to
 * touch, and four of them exited 0 reporting success. This tool was one of
 * them -- `--out` pointed at a symbolic link destroyed a file outside the
 * working directory and exited 0 with a "pass" report on stdout.
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help: it
 *    resolves the link, and resolving is precisely the dangerous act. The link
 *    is refused on sight, by `lstat`, before anything is opened. This also
 *    covers a link whose target does not exist yet, which otherwise creates a
 *    brand new file outside the root and reports success.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and compared against the resolved root rather than compared
 *    lexically. A lexical prefix check passes for `root/link/out` where `link`
 *    leaves the root, and a lexical check also refuses an entirely legitimate
 *    destination under the macOS temporary directory, which is itself a link.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    the input, so `realpath` and string comparison both call it a different
 *    file. It is the same file. Only device plus inode sees that, read with
 *    `bigint: true` because an inode number can exceed what a double holds
 *    exactly. This one the run already caught, by comparing the destination
 *    against the inode of every document it read; the two holes either side
 *    of it it did not.
 *
 * The destination need not exist yet, and neither need its directories: the
 * nearest existing ancestor is resolved and the missing segments are appended.
 * Refusing a destination whose directory has still to be created would be a bug
 * of its own, and the segments that do not exist cannot be links.
 *
 * Returns the resolved absolute path to write to, so the write does not
 * traverse the parent's links a second time.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = process.cwd(), label = '--out' } = options
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new DestinationError(`${label} requires a non-empty path.`)
  }
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}.`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the output wherever the link points, `
      + 'which is not the path you named, so it is refused. Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  const tail = []
  let probe = dirname(target)
  let parent = null
  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      parent = await realpath(probe)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new DestinationError(`${label} could not be resolved: ${error.code ?? 'unknown error'}.`)
      }
      const above = dirname(probe)
      if (above === probe) throw new DestinationError(`${label} has no existing ancestor directory.`)
      tail.unshift(basename(probe))
      probe = above
    }
  }
  if (parent === null) throw new DestinationError(`${label} is nested too deeply to resolve.`)

  let base
  try {
    base = await realpath(resolve(root))
  } catch (error) {
    throw new DestinationError(`${label} cannot be checked: the permitted root could not be resolved (${error.code ?? 'unknown error'}).`)
  }
  const baseInfo = await stat(base).catch(() => null)
  if (baseInfo === null || !baseInfo.isDirectory()) {
    throw new DestinationError(`${label} cannot be checked: the permitted root is not a directory.`)
  }
  if (parent !== base && !parent.startsWith(base + sep)) {
    throw new DestinationError(
      `${label} resolves outside the permitted root ${base}. A link or a ".." segment on the way there `
      + 'does not widen it. Write inside the root, or name the root you mean.',
    )
  }

  const resolved = join(parent, ...tail, basename(target))
  if (existing === null) return resolved

  for (const input of inputs) {
    const source = await stat(input, { bigint: true }).catch(() => null)
    const sourcePath = await realpath(input).catch(() => null)
    if (source === null && sourcePath === null) continue

    const reason = sameFileReason(existing, resolved, source, sourcePath)
    if (reason === 'inode') {
      throw new DestinationError(
        `${label} is the same file as an input (they share device ${existing.dev} and inode ${existing.ino}, `
        + 'so a hard link does not make them different files). This tool never rewrites what it reads.',
      )
    }
    if (reason === 'path') {
      throw new DestinationError(
        `${label} is the same file as an input by resolved path. This tool never rewrites what it reads.`,
      )
    }
  }
  return resolved
}

/**
 * Whether a destination and an input are one file, and how that was decided.
 *
 * Identity, not paths: a hard link has no target to resolve and shares no path
 * with the file it names, so `realpath` and string comparison both call it a
 * different file. Device plus inode is the filesystem's own answer, read with
 * `bigint: true` because an inode number can exceed what a double holds
 * exactly.
 *
 * The resolved-path comparison behind it is a backstop for a filesystem that
 * reports no inode number at all -- `ino` of zero, which some Windows and
 * network filesystems do -- where the identity test cannot answer. It is a
 * backstop and never the check: a hard link is exactly what it misses. It
 * cannot be isolated by a test that goes through a filesystem reporting real
 * inode numbers, which is why this decision is a pure function with its own
 * test rather than a condition buried in the walk above.
 */
export function sameFileReason(destination, destinationPath, source, sourcePath) {
  if (
    source !== null
    && destination.ino !== 0n
    && source.dev === destination.dev
    && source.ino === destination.ino
  ) return 'inode'
  if (sourcePath !== null && sourcePath === destinationPath) return 'path'
  return null
}
