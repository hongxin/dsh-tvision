/**
 * The workspace watcher: turns filesystem events into index refreshes.
 *
 * The Project index refreshes on mount and after tools that write, which
 * misses everything an editor outside the agent does. This module owns the
 * watching half so `ProjectIndex` can stay synchronous, cordis-free, and
 * app-layer-clean; the harness mount owns the wiring and disposal.
 *
 * The option set follows the harness's own directory-watch precedent
 * (dsh-skill-filesystem): atomic renames, write-settling, symlink following —
 * and, critically, the exclusion list, without which an unbounded watch fans
 * out over every `node_modules` in the tree.
 * @module @dsh-tvision/dsh-tvision/app/project-watch
 */

import { basename } from 'node:path'
import { watch } from 'chokidar'
import { DEFAULT_EXCLUDED_DIRECTORIES } from './project.ts'

/** The minimal watcher surface createProjectWatcher consumes. */
export interface WatchHandle {
  on(event: 'error', listener: (error: unknown) => void): unknown
  close(): Promise<void> | void
}

/** What createProjectWatcher uses to start watching; overridable for tests. */
export type WatchStarter = (root: string, options: Record<string, unknown>) => WatchHandle

/**
 * Watch the workspace root and call `onChange` (already coalesced by the
 * caller) when something under it settles.
 * @param root - The directory to watch, recursively.
 * @param onChange - Called after a filesystem change settles.
 * @param onError - Called with watcher errors; must not throw.
 * @param watchImpl - The watching implementation (default chokidar).
 * @returns A disposer that stops the watcher.
 */
export function createProjectWatcher(
  root: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
  watchImpl: WatchStarter = (path, options) => watch(path, options),
): () => void {
  const excluded = new Set(DEFAULT_EXCLUDED_DIRECTORIES)
  const handle = watchImpl(root, {
    persistent: false,
    ignoreInitial: true,
    followSymlinks: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    // Without the exclusions, watching a workspace means watching its
    // dependency trees — tens of thousands of inodes for events the index
    // deliberately never lists.
    ignored: (path: string) => excluded.has(basename(path)),
  })
  // A watcher error must degrade to "no watching", never to a crashed desktop.
  handle.on('error', (error) => { onError?.(error) })
  let pending: ReturnType<typeof setTimeout> | undefined
  const trigger = (): void => {
    if (pending !== undefined) clearTimeout(pending)
    // The index refresh itself is the expensive half; give a burst of edits
    // one pass. The tool-triggered refresh keeps its own, longer debounce.
    pending = setTimeout(() => {
      pending = undefined
      onChange()
    }, 250)
  }
  // chokidar surfaces add/change/unlink via .on too; the coalescing above
  // means the event kind never matters, only that something settled.
  const generic = handle as unknown as { on?: (event: string, listener: () => void) => unknown }
  generic.on?.('add', trigger)
  generic.on?.('change', trigger)
  generic.on?.('unlink', trigger)
  generic.on?.('addDir', trigger)
  generic.on?.('unlinkDir', trigger)
  return () => {
    if (pending !== undefined) clearTimeout(pending)
    void handle.close()
  }
}
