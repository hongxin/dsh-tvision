/**
 * The project index: what files exist under the working directory.
 *
 * This is a *bounded* index, not a filesystem walk. A coding agent's workspace
 * can hold a hundred thousand files in `node_modules` alone, and a desktop that
 * stalls for two seconds on startup to list them is worse than one that shows
 * the thousand files you might actually open. So the walk:
 *
 * - skips the directories that are never interesting (dependency trees, build
 *   output, VCS internals, caches) by name, at any depth;
 * - stops at a configurable entry budget, so a pathological tree degrades into a
 *   partial listing rather than a hang;
 * - does no I/O during a frame — the caller asks for a refresh, the work happens
 *   in the background, and the window repaints when it lands.
 *
 * Ranking is the part that makes the list useful: a file you edited recently or
 * one near the top of the tree should beat an alphabetically earlier file in a
 * test fixture.
 * @module dsh-tvision/app/project
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** How the index is built. */
export interface ProjectIndexOptions {
  /** Hard ceiling on how many files are listed (default 4000). */
  readonly maxEntries?: number
  /** Directory names to skip at any depth. */
  readonly excludedDirectories?: readonly string[]
  /** Path fragments that disqualify a file (default: none). */
  readonly excludedSuffixes?: readonly string[]
}

/**
 * Directories that are never worth walking.
 *
 * Named rather than pattern-matched because a pattern would also match a project
 * directory called `distributed-systems`, which is exactly the kind of mistake
 * that makes a tool feel unreliable.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.DS_Store',
])

/** A listed file. */
export interface ProjectFile {
  /** Path relative to the index root, using forward slashes on every platform. */
  readonly path: string
  /** File size in bytes. */
  readonly size: number
  /** Modification time in epoch milliseconds. */
  readonly modifiedAt: number
}

/** The outcome of one walk. */
export interface ProjectSnapshot {
  /** The absolute directory that was walked. */
  readonly root: string
  /** The files found, best first. */
  readonly files: readonly ProjectFile[]
  /** Whether the entry budget stopped the walk early. */
  readonly truncated: boolean
  /** How long the walk took, in milliseconds. */
  readonly elapsedMs: number
}

/**
 * Score a file for ordering.
 *
 * The weights are the whole design: a file at the repository root is more likely
 * to be what you want than one eight directories down, a source file beats a
 * lockfile, and a recently touched file beats a stale one. None of it is
 * clever — it is the ordering that makes a plain list feel curated.
 * @param file - The file to score.
 * @param now - Current time, for the recency term.
 * @returns A score; higher sorts first.
 */
export function scoreFile(file: ProjectFile, now: number): number {
  const depth = file.path.split('/').length - 1
  let score = 100 - depth * 8
  const base = file.path.slice(file.path.lastIndexOf('/') + 1)
  // Names that mean "this is the thing you came for".
  if (/^(readme|license|makefile|dockerfile|package\.json|cargo\.toml|pyproject\.toml|go\.mod)/iu.test(base)) {
    score += 60
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|c|h|cc|cpp|hpp|cs|swift|sh|sql|md)$/iu.test(base)) {
    score += 25
  }
  // Generated files and lockfiles are noise in a picker.
  if (/\.(lock|sum|min\.js|map|snap)$/iu.test(base)) score -= 70
  if (/^(pnpm-lock|package-lock|yarn\.lock|bun\.lockb)/iu.test(base)) score -= 90
  // A file in a test directory is usually not what you are opening.
  if (/(^|\/)(tests?|__tests__|spec)\//u.test(file.path)) score -= 15
  // Recency: an hour of freshness is worth about as much as being one level up.
  const ageHours = Math.max(0, (now - file.modifiedAt) / 3_600_000)
  score += Math.max(0, 20 - Math.log2(ageHours + 1) * 4)
  return score
}

/**
 * The project index.
 *
 * Holds the last snapshot and rebuilds it on request. Deliberately synchronous
 * inside {@link refresh}: the caller decides when to pay for the walk, and the
 * desktop's frame loop never calls it.
 */
export class ProjectIndex {
  private readonly root: string
  private readonly options: Required<ProjectIndexOptions>
  private snapshot: ProjectSnapshot | undefined

  /**
   * @param root - The absolute directory to index.
   * @param options - Budgets and exclusions.
   */
  constructor(root: string, options: ProjectIndexOptions = {}) {
    this.root = root
    this.options = {
      maxEntries: options.maxEntries ?? 4000,
      excludedDirectories: options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES,
      excludedSuffixes: options.excludedSuffixes ?? [],
    }
  }

  /** The directory being indexed. */
  get indexedRoot(): string {
    return this.root
  }

  /** The last snapshot, or undefined before the first refresh. */
  get current(): ProjectSnapshot | undefined {
    return this.snapshot
  }

  /**
   * Walk the tree and replace the snapshot.
   *
   * Never throws: a workspace with an unreadable subdirectory should still list
   * the rest of it, because the alternative is an empty window and no
   * explanation.
   * @param now - Current time, for the recency term.
   * @returns The new snapshot.
   */
  refresh(now = Date.now()): ProjectSnapshot {
    const started = Date.now()
    const files: ProjectFile[] = []
    const excluded = new Set(this.options.excludedDirectories)
    let truncated = false
    const queue: string[] = ['']
    // Canonical paths of directories already walked. A symlinked directory
    // that points back up the tree would otherwise be queued again at every
    // visit, and the entry budget would paper over the loop with a listing
    // full of duplicates rather than failing loudly.
    const visited = new Set<string>([this.canonicalRoot()])
    while (queue.length > 0) {
      const directory = queue.shift()
      /* c8 ignore next -- the queue is only pushed to with a string. */
      if (directory === undefined) break
      let entries: string[]
      try {
        entries = readdirSync(directory === '' ? this.root : join(this.root, directory))
      } catch {
        // Unreadable directory: skip it and keep the rest of the tree.
        continue
      }
      for (const name of entries) {
        const relativePath = directory === '' ? name : `${directory}${sep}${name}`
        if (excluded.has(name)) continue
        let stats
        try {
          stats = statSync(join(this.root, relativePath))
        } catch {
          /* c8 ignore next -- a file removed mid-walk is simply not listed. */
          continue
        }
        if (stats.isDirectory()) {
          // Resolve the symlink before descending: a directory already walked
          // under another name is a loop, not new content. A resolution failure
          // degrades to the old behaviour (the budget still bounds the walk)
          // rather than taking the listing down.
          try {
            const real = realpathSync(join(this.root, relativePath))
            if (visited.has(real)) continue
            visited.add(real)
          } catch {
            /* c8 ignore next -- an unresolvable link is simply descended into. */
          }
          queue.push(relativePath)
          continue
        }
        if (!stats.isFile()) continue
        const path = relativePath.split(sep).join('/')
        if (this.options.excludedSuffixes.some(suffix => path.endsWith(suffix))) continue
        files.push({ path, size: stats.size, modifiedAt: stats.mtimeMs })
        if (files.length >= this.options.maxEntries) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }
    files.sort((a, b) => {
      const difference = scoreFile(b, now) - scoreFile(a, now)
      // Ties broken by path so the list is stable across runs, which matters
      // because a list that reorders itself is unusable with a keyboard.
      return difference !== 0 ? difference : a.path.localeCompare(b.path)
    })
    this.snapshot = Object.freeze({
      root: this.root,
      files: Object.freeze(files),
      truncated,
      elapsedMs: Date.now() - started,
    })
    return this.snapshot
  }

  /** The root's canonical path, seeding the visited set. */
  private canonicalRoot(): string {
    try {
      return realpathSync(this.root)
    } catch {
      /* c8 ignore next -- an unresolvable root lists what it can. */
      return this.root
    }
  }

  /**
   * Filter the snapshot by a prefix, for the `@file` completion.
   * @param prefix - What the user has typed after `@`.
   * @param limit - Maximum results.
   * @returns Matching paths, best first.
   */
  complete(prefix: string, limit = 8): string[] {
    const files = this.snapshot?.files ?? []
    if (prefix === '') return files.slice(0, limit).map(file => file.path)
    const needle = prefix.toLowerCase()
    const out: string[] = []
    // Two passes so a match in the basename always beats a match in a directory
    // name, which is what makes `@parser` find `src/parser.ts`.
    for (const file of files) {
      const base = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase()
      if (base.startsWith(needle)) out.push(file.path)
      if (out.length >= limit) return out
    }
    for (const file of files) {
      if (out.includes(file.path)) continue
      if (file.path.toLowerCase().includes(needle)) out.push(file.path)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * The rows the Project window shows: a path, plus its directory as detail.
   * @param limit - Maximum rows.
   * @returns One row per file.
   */
  rows(limit = 200): { label: string; detail?: string }[] {
    const files = this.snapshot?.files ?? []
    return files.slice(0, limit).map((file) => {
      const cut = file.path.lastIndexOf('/')
      return {
        label: cut < 0 ? file.path : file.path.slice(cut + 1),
        ...(cut < 0 ? {} : { detail: file.path.slice(0, cut) }),
      }
    })
  }

  /**
   * A human summary for the status line.
   * @returns Something like `412 files`.
   */
  summary(): string {
    const snapshot = this.snapshot
    if (snapshot === undefined) return 'not indexed'
    const count = snapshot.files.length
    return snapshot.truncated ? `${count}+ files (truncated)` : `${count} files`
  }
}

/**
 * Format a file size for a window's detail column.
 * @param bytes - The size.
 * @returns A short label.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Whether a path is inside a root, for guarding a file-reference insert.
 * @param root - The absolute root directory.
 * @param path - The candidate path.
 * @returns True when the path is the root or beneath it.
 */
export function isInside(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return path === root || path.startsWith(normalizedRoot)
}

/**
 * Express a path relative to a root where possible.
 * @param root - The absolute root directory.
 * @param path - The absolute path.
 * @returns The relative path, or the input when it is not beneath the root.
 */
export function relativeTo(root: string, path: string): string {
  if (!isInside(root, path)) return path
  return relative(root, path).split(sep).join('/')
}
