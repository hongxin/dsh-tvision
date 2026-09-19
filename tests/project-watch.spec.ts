/**
 * Workspace watcher tests.
 *
 * The real watcher runs against a real temporary tree, the way the index's
 * own tests do — a fake would only pin the fake. The option shape is pinned
 * separately through an injected starter, so the exclusion list and the
 * settle behaviour cannot silently drift from the walk's.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectWatcher, type WatchHandle } from '../src/app/project-watch.ts'
import { ProjectIndex } from '../src/app/project.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tvision-watch-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the real watcher', () => {
  it('an external edit reaches the index', async () => {
    writeFileSync(join(root, 'a.ts'), 'one')
    const index = new ProjectIndex(root)
    index.refresh()
    expect(index.current?.files.length).toBe(1)
    const onChange = vi.fn(() => { index.refresh() })
    const stop = createProjectWatcher(root, onChange)
    try {
      // Let the initial scan finish first: a file created mid-scan is counted
      // as initial and (rightly) ignored, which would swallow the event.
      await new Promise(resolve => setTimeout(resolve, 500))
      writeFileSync(join(root, 'b.ts'), 'two')
      await vi.waitFor(() => {
        expect(index.current?.files.some(file => file.path === 'b.ts')).toBe(true)
      })
    } finally {
      await stop()
    }
  })

  it('excluded directories raise no events', async () => {
    mkdirSync(join(root, 'node_modules'))
    const onChange = vi.fn()
    const stop = createProjectWatcher(root, onChange)
    try {
      writeFileSync(join(root, 'node_modules', 'pkg.js'), 'junk')
      // Long enough for a real watcher to have said something if it were
      // watching the wrong tree; short enough to keep the suite quick.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      await stop()
    }
  })
})

describe('the option shape', () => {
  it('watches with exclusions, symlink following, and write settling', () => {
    const seen: { root: string; options: Record<string, unknown> }[] = []
    const fake = (root: string, options: Record<string, unknown>): WatchHandle => {
      seen.push({ root, options })
      return {
        on: (event: string, listener: (error: unknown) => void) => {
          if (event === 'error') listener(new Error('boom'))
          return fake
        },
        close: () => {},
      }
    }
    const onError = vi.fn()
    const stop = createProjectWatcher('/ws', () => {}, onError, fake)
    stop()
    expect(seen[0]?.root).toBe('/ws')
    expect(seen[0]?.options.ignoreInitial).toBe(true)
    expect(seen[0]?.options.followSymlinks).toBe(true)
    // chokidar prunes by calling ignored on each directory as it descends,
    // so the check that matters is on the directory itself.
    const ignored = seen[0]?.options.ignored as (path: string) => boolean
    expect(ignored(join('/ws', 'node_modules'))).toBe(true)
    expect(ignored(join('/ws', 'src'))).toBe(false)
    // A watcher error is contained: reported, never thrown.
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })
})
