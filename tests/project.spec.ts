/**
 * Project index tests.
 *
 * The index runs against a real temporary tree rather than a mocked filesystem,
 * because the things worth testing are exactly the things a mock would not
 * reproduce: which directories get skipped, what happens at the entry budget,
 * whether a symlink loop terminates, and whether an unreadable subdirectory
 * takes the rest of the listing down with it.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  ProjectIndex,
  formatSize,
  isInside,
  relativeTo,
  scoreFile,
} from '../src/app/project.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tvision-project-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Create a file, making its parent directories.
 * @param path - Path relative to the temporary root.
 * @param contents - File contents.
 */
function make(path: string, contents = 'x'): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
}

describe('the walk', () => {
  it('lists files with their sizes', () => {
    make('src/index.ts', 'hello')
    const snapshot = new ProjectIndex(root).refresh()
    expect(snapshot.files.map(file => file.path)).toEqual(['src/index.ts'])
    expect(snapshot.files[0]?.size).toBe(5)
  })

  it('uses forward slashes on every platform', () => {
    make('a/b/c/deep.ts')
    const snapshot = new ProjectIndex(root).refresh()
    expect(snapshot.files[0]?.path).toBe('a/b/c/deep.ts')
  })

  it('skips the directories that are never interesting', () => {
    make('src/index.ts')
    for (const excluded of ['node_modules', 'dist', '.git', '__pycache__', 'target']) {
      make(`${excluded}/junk.ts`)
    }
    const paths = new ProjectIndex(root).refresh().files.map(file => file.path)
    expect(paths).toEqual(['src/index.ts'])
  })

  it('skips an excluded directory at any depth', () => {
    make('packages/app/node_modules/dep/index.js')
    make('packages/app/src/index.ts')
    const paths = new ProjectIndex(root).refresh().files.map(file => file.path)
    expect(paths).toEqual(['packages/app/src/index.ts'])
  })

  it('does not skip a directory whose name merely contains an excluded one', () => {
    // `distributed` must not be mistaken for `dist`; that class of mistake makes
    // a file picker feel unreliable.
    make('src/distributed/thing.ts')
    const paths = new ProjectIndex(root).refresh().files.map(file => file.path)
    expect(paths).toEqual(['src/distributed/thing.ts'])
  })

  it('honours a custom exclusion list', () => {
    make('keep/a.ts')
    make('drop/b.ts')
    const index = new ProjectIndex(root, { excludedDirectories: ['drop'] })
    expect(index.refresh().files.map(file => file.path)).toEqual(['keep/a.ts'])
  })

  it('honours an excluded suffix', () => {
    make('a.ts')
    make('b.generated.ts')
    const index = new ProjectIndex(root, { excludedSuffixes: ['.generated.ts'] })
    expect(index.refresh().files.map(file => file.path)).toEqual(['a.ts'])
  })

  it('stops at the entry budget and says so', () => {
    for (let index = 0; index < 20; index++) make(`src/file-${index}.ts`)
    const snapshot = new ProjectIndex(root, { maxEntries: 5 }).refresh()
    expect(snapshot.files).toHaveLength(5)
    expect(snapshot.truncated).toBe(true)
  })

  it('reports not being truncated when the budget is not reached', () => {
    make('a.ts')
    expect(new ProjectIndex(root).refresh().truncated).toBe(false)
  })

  it('records how long it took', () => {
    make('a.ts')
    expect(new ProjectIndex(root).refresh().elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('returns an empty listing for an empty directory', () => {
    const snapshot = new ProjectIndex(root).refresh()
    expect(snapshot.files).toEqual([])
    expect(snapshot.root).toBe(root)
  })

  it('fails soft on a root that does not exist', () => {
    const index = new ProjectIndex(join(root, 'nope'))
    expect(() => index.refresh()).not.toThrow()
    expect(index.refresh().files).toEqual([])
  })

  it('keeps the rest of the tree when a subdirectory is unreadable', () => {
    make('src/a.ts')
    make('locked/b.ts')
    chmodSync(join(root, 'locked'), 0o000)
    try {
      const paths = new ProjectIndex(root).refresh().files.map(file => file.path)
      // Root can read anything, so the assertion is conditional on the mode
      // actually taking effect; either way the good file must be listed.
      expect(paths).toContain('src/a.ts')
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
    }
  })

  it('does not follow a symlinked directory into a loop', () => {
    make('src/a.ts')
    // A self-referential symlink is the classic way to make a naive walker spin.
    // `statSync` on a symlinked directory reports a directory, so the walk would
    // descend; this asserts the walk still terminates and lists the real file.
    try {
      symlinkSync(root, join(root, 'src', 'loop'), 'dir')
    } catch {
      return // No symlink permission in this environment.
    }
    const index = new ProjectIndex(root, { maxEntries: 50 })
    const snapshot = index.refresh()
    expect(snapshot.files.length).toBeLessThanOrEqual(50)
    expect(snapshot.files.some(file => file.path === 'src/a.ts')).toBe(true)
  })
})

describe('ranking', () => {
  const now = 1_700_000_000_000

  it('puts a source file ahead of a lockfile', () => {
    const source = scoreFile({ path: 'pnpm-lock.yaml', size: 1, modifiedAt: now }, now)
    const code = scoreFile({ path: 'src/index.ts', size: 1, modifiedAt: now }, now)
    expect(code).toBeGreaterThan(source)
  })

  it('prefers a shallower path', () => {
    const shallow = scoreFile({ path: 'index.ts', size: 1, modifiedAt: now }, now)
    const deep = scoreFile({ path: 'a/b/c/d/e/index.ts', size: 1, modifiedAt: now }, now)
    expect(shallow).toBeGreaterThan(deep)
  })

  it('prefers a recently modified file', () => {
    const fresh = scoreFile({ path: 'a.ts', size: 1, modifiedAt: now }, now)
    const stale = scoreFile({ path: 'b.ts', size: 1, modifiedAt: now - 90 * 24 * 3_600_000 }, now)
    expect(fresh).toBeGreaterThan(stale)
  })

  it('promotes the files that mean "this is the project"', () => {
    const readme = scoreFile({ path: 'README.md', size: 1, modifiedAt: now }, now)
    const other = scoreFile({ path: 'src/other.md', size: 1, modifiedAt: now }, now)
    expect(readme).toBeGreaterThan(other)
  })

  it('demotes a file in a test directory', () => {
    const source = scoreFile({ path: 'src/parser.ts', size: 1, modifiedAt: now }, now)
    const test = scoreFile({ path: 'tests/parser.ts', size: 1, modifiedAt: now }, now)
    expect(source).toBeGreaterThan(test)
  })

  it('orders a real tree the way a person would expect', () => {
    make('pnpm-lock.yaml')
    make('README.md')
    make('src/parser.ts')
    make('tests/parser.spec.ts')
    make('src/deep/nested/thing.ts')
    const paths = new ProjectIndex(root).refresh().files.map(file => file.path)
    expect(paths[0]).toBe('README.md')
    expect(paths.indexOf('src/parser.ts')).toBeLessThan(paths.indexOf('pnpm-lock.yaml'))
    expect(paths.indexOf('src/parser.ts')).toBeLessThan(paths.indexOf('src/deep/nested/thing.ts'))
    expect(paths.indexOf('src/parser.ts')).toBeLessThan(paths.indexOf('tests/parser.spec.ts'))
  })

  it('breaks ties by path so the order is stable', () => {
    make('src/b.ts')
    make('src/a.ts')
    const first = new ProjectIndex(root).refresh().files.map(file => file.path)
    const second = new ProjectIndex(root).refresh().files.map(file => file.path)
    expect(first).toEqual(second)
    expect(first).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('completion', () => {
  /** An index over a tree with a predictable shape. */
  function build(): ProjectIndex {
    make('src/parser.ts')
    make('src/stream.ts')
    make('tests/parser.spec.ts')
    make('README.md')
    const index = new ProjectIndex(root)
    index.refresh()
    return index
  }

  it('offers everything, best first, for an empty prefix', () => {
    const index = build()
    expect(index.complete('', 2)).toHaveLength(2)
    expect(index.complete('')[0]).toBe('README.md')
  })

  it('matches a basename prefix before anywhere else in the path', () => {
    const index = build()
    // `parser` appears in `src/parser.ts` (basename) and `tests/parser.spec.ts`
    // (basename too); the shallower, non-test one must come first.
    const results = index.complete('pars')
    expect(results[0]).toBe('src/parser.ts')
  })

  it('falls back to a substring match in the whole path', () => {
    const index = build()
    expect(index.complete('stream')).toContain('src/stream.ts')
    expect(index.complete('src/')).toContain('src/parser.ts')
  })

  it('respects the limit', () => {
    const index = build()
    expect(index.complete('s', 1)).toHaveLength(1)
  })

  it('returns nothing for an unmatched prefix', () => {
    const index = build()
    expect(index.complete('zzzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    const index = build()
    expect(index.complete('README')).toContain('README.md')
    expect(index.complete('readme')).toContain('README.md')
  })
})

describe('rows', () => {
  it('shows the basename with its directory as detail', () => {
    make('src/deep/thing.ts')
    const index = new ProjectIndex(root)
    index.refresh()
    expect(index.rows()).toEqual([{ label: 'thing.ts', detail: 'src/deep' }])
  })

  it('shows a root-level file with no detail', () => {
    make('README.md')
    const index = new ProjectIndex(root)
    index.refresh()
    expect(index.rows()).toEqual([{ label: 'README.md' }])
  })

  it('honours the row limit', () => {
    for (let index = 0; index < 10; index++) make(`f${index}.ts`)
    const project = new ProjectIndex(root)
    project.refresh()
    expect(project.rows(3)).toHaveLength(3)
  })

  it('is empty before the first refresh', () => {
    expect(new ProjectIndex(root).rows()).toEqual([])
  })

  it('summarises what it found', () => {
    expect(new ProjectIndex(root).summary()).toBe('not indexed')
    make('a.ts')
    const index = new ProjectIndex(root)
    index.refresh()
    expect(index.summary()).toBe('1 files')
  })

  it('says so when it truncated', () => {
    make('a.ts')
    make('b.ts')
    const index = new ProjectIndex(root, { maxEntries: 1 })
    index.refresh()
    expect(index.summary()).toBe('1+ files (truncated)')
  })

  it('exposes its root', () => {
    expect(new ProjectIndex(root).indexedRoot).toBe(root)
  })
})

describe('path helpers', () => {
  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2 kB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('detects containment', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })

  it('relativises a path beneath the root', () => {
    expect(relativeTo('/a/b', '/a/b/c/d')).toBe('c/d')
  })

  it('leaves a path outside the root alone', () => {
    expect(relativeTo('/a/b', '/x/y')).toBe('/x/y')
  })

  it('ships a default exclusion list with no duplicates', () => {
    expect(new Set(DEFAULT_EXCLUDED_DIRECTORIES).size).toBe(DEFAULT_EXCLUDED_DIRECTORIES.length)
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain('node_modules')
  })
})
