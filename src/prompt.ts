/**
 * The prompt service: named fragments the composer's sigil and the status line
 * can interpolate, so a deployment can restyle them without patching the app.
 *
 * A value is registered by name and may change at any time; a subscriber is
 * notified so the display can refresh. This is the same seam the upstream TUI
 * exposes, deliberately, so a plugin written against that one keeps working.
 * @module dsh-tvision/prompt
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** A handle onto one registered value. */
export interface TvisionPromptValueHandle {
  /**
   * Set the value.
   * @param value - The new text, or undefined to hide the fragment.
   */
  set(value: string | undefined): void
  /** Unregister the value. */
  dispose(): void
}

/** Unsubscribe a listener. */
export type TvisionPromptUnsubscribe = () => void

/** Plugin name. */
export const name = 'tvision-prompt'

/**
 * A registry of named display fragments.
 *
 * The service is trivial on purpose: it exists to be *the* one place a display
 * value can be overridden, so that a theme or a plugin never has to reach into
 * the application to change a string.
 */
export class TvisionPromptService extends Service {
  private readonly values = new Map<string, string | undefined>()
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - The owning context.
   */
  constructor(ctx: Context) {
    super(ctx, 'tvisionPrompt')
  }

  /**
   * Register a value.
   * @param key - The fragment name.
   * @param initial - Its starting text, if any.
   * @returns A handle to change or remove it.
   */
  register(key: string, initial?: string): TvisionPromptValueHandle {
    this.values.set(key, initial)
    return {
      set: (value) => {
        if (this.values.get(key) === value) return
        this.values.set(key, value)
        this.notify()
      },
      dispose: () => {
        this.values.delete(key)
        this.notify()
      },
    }
  }

  /**
   * Read a value.
   * @param key - The fragment name.
   * @returns The text, or undefined.
   */
  get(key: string): string | undefined {
    return this.values.get(key)
  }

  /**
   * Subscribe to changes.
   * @param listener - Called after any change.
   * @returns An unsubscribe function.
   */
  subscribe(listener: () => void): TvisionPromptUnsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Notify every listener. */
  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export default TvisionPromptService
