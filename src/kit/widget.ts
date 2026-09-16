/**
 * The widget contract and the input event model.
 *
 * Widgets are the middle layer: above {@link Painter} (they draw through it)
 * and below the window manager (which owns geometry, z-order and focus).
 * A widget knows its own size preferences and how to react to a click or a
 * key; it never knows where on screen it is, which is what lets the same
 * transcript widget live in a big window, a small window, or a dialog.
 * @module @dsh-tvision/dsh-tvision/kit/widget
 */

import type { Palette } from './skin.ts'
import type { Painter } from './painter.ts'

/**
 * A decoded key press.
 *
 * `key` is a normalised name (`'a'`, `'enter'`, `'f10'`, `'up'`, `'ctrl+o'`),
 * `text` is the printable payload when there is one (so a widget that wants
 * raw typing does not have to reverse-engineer the name), and `alt` marks an
 * Alt/Meta combination, which menus use for their accelerator letters.
 */
export interface KeyEvent {
  /** Discriminator, matching the input layer's `KeyInput` so no adapter is needed. */
  readonly type: 'key'
  /** Normalised key name, lowercase. */
  readonly key: string
  /** Printable text this key produces, if any. */
  readonly text?: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
}

/** Which mouse button produced an event. */
export type MouseButton = 'left' | 'middle' | 'right' | 'none'

/** What kind of pointer event this is. */
export type MouseKind = 'press' | 'drag' | 'release' | 'wheel' | 'move'

/**
 * A mouse event in screen coordinates.
 *
 * `kind` rather than a set of booleans, because every consumer branches on
 * exactly one question — is this a click I should act on, a motion I should
 * follow, or a tick I should scroll by — and a boolean soup makes the illegal
 * combinations representable.
 */
export interface MouseEvent {
  /** Screen column, 0-based. */
  readonly x: number
  /** Screen row, 0-based. */
  readonly y: number
  readonly kind: MouseKind
  /** Which button; `'none'` for a motion event with no button held. */
  readonly button: MouseButton
  /** Wheel direction: `-1` towards the start, `1` towards the end. */
  readonly delta?: number
  readonly shift?: boolean
  readonly alt?: boolean
  readonly ctrl?: boolean
}

/** How a widget wants to consume an event. */
export const Consumed = {
  /** The event was not for this widget; let someone else try. */
  No: 0,
  /** The event was handled. */
  Yes: 1,
} as const

/** The result of offering an event to a widget. */
export type Consumed = typeof Consumed[keyof typeof Consumed]

/** What a widget needs from its environment, passed to every draw. */
export interface WidgetContext {
  /** The active skin's resolved roles. */
  readonly palette: Palette
  /** Request another frame. Coalesced by the application loop. */
  requestRender(): void
  /**
   * Whether this widget's subtree currently holds focus. A widget uses it to
   * choose between `listNormal` and `listFocused`, and to show a caret.
   */
  readonly focused: boolean
  /**
   * The screen position of the widget's own top-left corner.
   *
   * Mouse events arrive in absolute screen coordinates, so a widget that needs
   * to know which row was clicked subtracts this. Passing the origin is better
   * than passing local coordinates, because a widget that also wants to compare
   * against another widget's rectangle still has the absolute space.
   */
  readonly origin?: { readonly x: number; readonly y: number }
}

/** A size hint, used by the layout code in `widgets/window.ts`. */
export interface SizeHint {
  readonly width: number
  readonly height: number
}

/**
 * The widget interface.
 *
 * Deliberately tiny: three optional event hooks and one draw method. Anything a
 * widget needs beyond that (scroll position, selection, an undo stack) is its
 * own business and lives in its own class; the framework never introspects it.
 */
export interface Widget {
  /**
   * Paint into `painter`. The painter's region is the widget's whole allotted
   * area; the widget must not assume it got the size it asked for.
   * @param painter - The clipped drawing surface.
   * @param context - Palette, focus, and the render request hook.
   */
  draw(painter: Painter, context: WidgetContext): void

  /**
   * Handle a key press.
   * @param event - The decoded key.
   * @param context - Palette, focus, and the render request hook.
   * @returns Whether the widget consumed the event.
   */
  onKey?(event: KeyEvent, context: WidgetContext): Consumed

  /**
   * Handle a mouse click, drag, release, or wheel tick inside the widget.
   *
   * Coordinates are screen-absolute; a widget that needs local coordinates
   * asks its container, which is why containers translate before forwarding.
   * @param event - The decoded mouse event, already hit-tested.
   * @param context - Palette, focus, and the render request hook.
   * @returns Whether the widget consumed the event.
   */
  onMouse?(event: MouseEvent, context: WidgetContext): Consumed

  /**
   * A hint for auto-sizing dialogs. Omitted means "fill whatever you are given".
   * @returns Preferred content size, excluding the frame the window adds.
   */
  measure?(): SizeHint
}

