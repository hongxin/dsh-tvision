/**
 * Workspace watcher tests.
 *
 * The real watcher runs against a real temporary tree, the way the index's
 * own tests do. The EMFILE that motivated the native rewrite is pinned
 * structurally — one recursive watcher, not one per directory — and the
 * error containment is pinned at the layer that actually emits: the native
 * watcher's own 'error' event.
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
      // The recursive watcher needs a moment before it sees events.
      await new Promise(resolve => setTimeout(resolve, 200))
      writeFileSync(join(root, 'b.ts'), 'two')
      await vi.waitFor(() => {
        expect(index.current?.files.some(file => file.path === 'b.ts')).toBe(true)
      })
    } finally {
      stop()
    }
  })

  it('changes inside excluded directories trigger nothing', async () => {
    mkdirSync(join(root, 'node_modules'))
    const onChange = vi.fn()
    const stop = createProjectWatcher(root, onChange)
    try {
      // macOS FSEvents is latency-based: the mkdir from before the watcher
      // started can arrive after. Let the history drain, then measure.
      await new Promise(resolve => setTimeout(resolve, 700))
      onChange.mockClear()
      writeFileSync(join(root, 'node_modules', 'pkg.js'), 'junk')
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

describe('the watcher shape', () => {
  it('starts one recursive watcher — the EMFILE fix, pinned', () => {
    const seen: { root: string; options: { recursive: boolean } }[] = []
    const fake = (root: string, options: { recursive: boolean }): WatchHandle => {
      seen.push({ root, options })
      return { on: () => fake, close: () => {} }
    }
    const stop = createProjectWatcher('/ws', () => {}, undefined, fake)
    stop()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.options.recursive).toBe(true)
  })

  it('a native error closes the watcher and is reported, never thrown', () => {
    const listeners = new Map<string, (arg: unknown) => void>()
    const closed: boolean[] = []
    const handle: WatchHandle = {
      on: (event, listener) => {
        listeners.set(event, listener as (arg: unknown) => void)
        return handle
      },
      close: () => { closed.push(true) },
    }
    const fake = (): WatchHandle => handle
    const onError = vi.fn()
    const stop = createProjectWatcher('/ws', () => {}, onError, fake)
    // The error arrives on the native watcher itself — the layer that
    // crashed the desktop before the listener lived here.
    listeners.get('error')?.(new Error('EMFILE'))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EMFILE' }))
    expect(closed).toHaveLength(1)
    stop()
  })
})
