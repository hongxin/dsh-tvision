/**
 * The workspace watcher: turns filesystem events into index refreshes.
 *
 * The Project index refreshes on mount and after tools that write, which
 * misses everything an editor outside the agent does. This module owns the
 * watching half so `ProjectIndex` can stay synchronous, cordis-free, and
 * app-layer-clean; the harness mount owns the wiring and disposal.
 *
 * One watcher, one file descriptor: `fs.watch(root, { recursive: true })`
 * covers the whole tree natively (FSEvents on macOS, ReadDirectoryChangesW
 * on Windows, inotify-based recursion on Linux since Node 20; this package
 * runs on Node ≥ 22). The chokidar shape this replaced opened a descriptor
 * per directory, which exhausted the process limit on any large root — a
 * home directory took the desktop down with `EMFILE: too many open files`.
 * Excluded directories are filtered here in the event callback instead: the
 * watcher sees everything, the index hears only what it lists.
 * @module dsh-tvision/app/project-watch
 */

import { watch } from 'node:fs'
import { join, sep } from 'node:path'
import { DEFAULT_EXCLUDED_DIRECTORIES } from './project.ts'

/** The minimal watcher surface createProjectWatcher consumes. */
export interface WatchHandle {
  /** The native watcher forwards errors here; this is the real containment. */
  on(event: 'error', listener: (error: unknown) => void): unknown
  close(): void
}

/** What createProjectWatcher uses to start watching; overridable for tests. */
export type WatchStarter = (root: string, options: { recursive: boolean }) => WatchHandle

/**
 * Watch the workspace root and call `onChange` (already coalesced) when
 * something under it settles.
 * @param root - The directory to watch, recursively.
 * @param onChange - Called after a filesystem change settles.
 * @param onError - Called with watcher errors; must not throw.
 * @param watchImpl - The watching implementation (default the native watcher).
 * @returns A disposer that stops the watcher.
 */
export function createProjectWatcher(
  root: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
  watchImpl: WatchStarter = (path, options) => watch(path, options) as unknown as WatchHandle,
): () => void {
  const excluded = new Set(DEFAULT_EXCLUDED_DIRECTORIES)
  let pending: ReturnType<typeof setTimeout> | undefined
  const trigger = (): void => {
    if (pending !== undefined) clearTimeout(pending)
    // The index refresh is the expensive half; give a burst of editor saves
    // one pass. The tool-triggered refresh keeps its own, longer debounce.
    pending = setTimeout(() => {
      pending = undefined
      onChange()
    }, 250)
  }
  /** Whether any path segment of the event sits in an excluded directory. */
  const isExcluded = (filename: string | null): boolean => {
    if (filename === null || filename === '') return false
    const full = join(root, filename)
    for (const segment of full.split(sep)) {
      if (excluded.has(segment)) return true
    }
    return false
  }
  const handle = watchImpl(root, { recursive: true })
  // A native watcher with a listener on 'error' never throws the process
  // away; degrading to "no watching" is the worst outcome, and the
  // tool-triggered refresh keeps the index honest without us.
  handle.on('error', (error) => {
    if (pending !== undefined) clearTimeout(pending)
    try {
      handle.close()
    } catch {
      /* c8 ignore next -- an already-dead watcher is dead. */
    }
    onError?.(error)
  })
  // The callback form is not on the minimal handle interface, so subscribe
  // through the native surface the default starter produced.
  const subscribe = handle as unknown as {
    on?: (event: 'change', listener: (eventType: string, filename: string | null) => void) => unknown
  }
  subscribe.on?.('change', (_eventType, filename) => {
    if (!isExcluded(filename)) trigger()
  })
  return () => {
    if (pending !== undefined) clearTimeout(pending)
    try {
      handle.close()
    } catch {
      /* c8 ignore next -- teardown of a dead watcher is fine. */
    }
  }
}
