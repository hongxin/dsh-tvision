/**
 * The package's invariant companion.
 *
 * tvision owns no cross-package invariants: it reads the session log, it never
 * writes it, and it holds no shared registry. The module exists so the loader
 * sees a declared companion rather than an absent one.
 * @module dsh-tvision/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name. */
export const name = 'tvision-invariant'

/** No services are required to state this package's invariants. */
export const inject = [] as const

/**
 * Declare the package's invariants. There are none beyond the type system's.
 * @param _ctx - The owning context, unused.
 */
export function install(_ctx: Context): void {
  // Intentionally empty: see the module note.
}
