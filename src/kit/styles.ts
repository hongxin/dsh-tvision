/**
 * Style-to-SGR translation and the attribute patch that keeps the emitted byte
 * stream small.
 *
 * A style is a record; a terminal wants a flat SGR parameter list. This module
 * owns that translation and the incremental logic around it: it can compute a
 * *patch* (the escapes needed to turn one style into another), which is what
 * lets the renderer emit two or three parameters for a colour change instead of
 * resetting and restating the whole style per cell.
 * @module @dsh-tvision/dsh-tvision/kit/styles
 */

import type { AnsiColor, Color, RgbColor, Style, StyleInput } from './cell.ts'

/** A 24-bit colour is at or above this value; ANSI indices are below it. */
const TRUECOLOR_FLOOR = 0x100

/**
 * Parameters that turn every attribute off and reset both colours to the
 * terminal default. Emitted whenever the target style is empty, and used as
 * the anchor for a full restate.
 */
export const SGR_RESET = '\u001B[0m'

/**
 * Split a 24-bit colour into its channels.
 * @param value - `0xRRGGBB`.
 * @returns The three channels, 0–255.
 */
function channels(value: RgbColor): [number, number, number] {
  return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
}

/**
 * The SGR parameters that set one colour slot.
 * @param color - The colour, or undefined for the terminal default.
 * @param layer - Whether this is the foreground or the background.
 * @returns Parameter list without the `ESC [` or `m`.
 */
function colorParams(color: Color, layer: 'fg' | 'bg'): string {
  if (color === undefined) return layer === 'fg' ? '39' : '49'
  if (color >= TRUECOLOR_FLOOR) {
    const [r, g, b] = channels(color)
    return `${layer === 'fg' ? 38 : 48};2;${r};${g};${b}`
  }
  const index = color as AnsiColor
  // 30-37/40-47 for the base eight, 90-97/100-107 for the bright eight, and
  // the 256-colour form beyond that.
  if (index < 8) return String((layer === 'fg' ? 30 : 40) + index)
  if (index < 16) return String((layer === 'fg' ? 90 : 100) + (index - 8))
  return `${layer === 'fg' ? 38 : 48};5;${index}`
}

/**
 * The attribute SGR parameters a style sets, plus the parameters that clear
 * the ones it does not. Emitting both directions is what makes a patch safe:
 * a cell that is no longer bold must actively turn bold off, because nothing
 * else will.
 * @param style - The style to describe.
 * @returns On and off parameter lists.
 */
function attrParams(style: Style): { on: string[]; active: boolean[] } {
  // Positionally parallel to ATTR_ENABLE_CODES: `on` holds the SGR parameters
  // that turn each attribute on, `active` says whether it is on at all. The
  // "off" direction is derived from `active` by position, because a flat
  // parameter list cannot express it (bold and dim share the code 22).
  const on: string[] = []
  const active: boolean[] = []
  for (let index = 0; index < ATTR_ENABLE_CODES.length; index++) {
    const enabled = (style as Record<string, boolean | undefined>)[ATTR_NAMES[index] ?? ''] === true
    active.push(enabled)
    if (enabled) on.push(ATTR_ENABLE_CODES[index] ?? '')
  }
  return { on, active }
}

/** Attribute names, positionally parallel to {@link ATTR_ENABLE_CODES}. */
const ATTR_NAMES = ['bold', 'dim', 'italic', 'underline', 'blink', 'inverse', 'strike'] as const

/** SGR parameters that turn each attribute on, positionally parallel to {@link ATTR_NAMES}. */
const ATTR_ENABLE_CODES = ['1', '2', '3', '4', '5', '7', '9'] as const

/**
 * SGR parameters that turn each attribute off, positionally parallel to
 * {@link ATTR_NAMES}. Bold and dim share 22, which is why they cannot be
 * looked up by parameter value.
 */
const ATTR_OFF_CODES = ['22', '22', '23', '24', '25', '27', '29'] as const

/**
 * The complete SGR sequence for a style, written from a clean slate.
 * @param style - The style to encode.
 * @returns An escape sequence ending in `m`, or `''` for a wholly empty style.
 */
export function styleToSgr(style: Style): string {
  if (isEmptyStyle(style)) return SGR_RESET
  const { on } = attrParams(style)
  const fg = colorParams(style.fg, 'fg')
  const bg = colorParams(style.bg, 'bg')
  // `0` first, so nothing has to be turned off explicitly: a full restate is
  // cheaper to reason about than to optimise, and it is emitted once per style
  // *change*, not once per cell.
  return `\u001B[0;${[...on, fg, bg].join(';')}m`
}

/**
 * Whether a style has no effect at all.
 * @param style - The style to test.
 * @returns True when nothing would be emitted for it.
 */
export function isEmptyStyle(style: Style): boolean {
  return style.fg === undefined
    && style.bg === undefined
    && style.bold === undefined
    && style.dim === undefined
    && style.italic === undefined
    && style.underline === undefined
    && style.blink === undefined
    && style.inverse === undefined
    && style.strike === undefined
}

/**
 * The escape sequence that turns `from` into `to` with the fewest parameters.
 *
 * Attributes are always restated in full (there are only seven and the
 * parameter list stays short), while a colour is emitted only when it actually
 * changed. Callers that pass the style currently active on the wire get a
 * correct patch; passing `undefined` yields a full restate.
 * @param from - The style the terminal is currently in.
 * @param to - The style the next cell needs.
 * @returns An escape sequence, or `''` when nothing has to change.
 */
export function stylePatch(from: Style | undefined, to: Style): string {
  if (from === undefined) return styleToSgr(to)
  const { on, active } = attrParams(to)
  const params: string[] = []
  if (from.fg !== to.fg) params.push(colorParams(to.fg, 'fg'))
  if (from.bg !== to.bg) params.push(colorParams(to.bg, 'bg'))
  // Order matters and is not cosmetic: SGR parameters take effect left to
  // right, and bold and dim share the reset code 22. Emitting `2;22` would set
  // dim and then immediately cancel it, so every "off" must precede every "on".
  const previous = attrParams(from)
  for (let index = 0; index < ATTR_NAMES.length; index++) {
    // The previous style had it on and the new one does not, so it has to be
    // turned off explicitly or the rest of the row inherits it.
    if (previous.active[index] === true && active[index] !== true) {
      params.push(ATTR_OFF_CODES[index] ?? '0')
    }
  }
  params.push(...on)
  // De-duplicate: two attributes can share a parameter (bold and dim are both
  // 22 when turning off), and repeating one is wasteful if harmless.
  const unique = [...new Set(params)]
  if (unique.length === 0) return ''
  return `\u001B[${unique.join(';')}m`
}

/**
 * Normalise a partial style input into a concrete style, filling absent
 * attribute slots with `false` so {@link styleEquals} can compare by value.
 * @param input - The partial style.
 * @returns A fully-specified style.
 */
export function normalizeStyle(input: StyleInput | undefined): Style {
  if (input === undefined) return {}
  const { fg, bg } = input
  return {
    fg,
    bg,
    bold: input.bold === true,
    dim: input.dim === true,
    italic: input.italic === true,
    underline: input.underline === true,
    blink: input.blink === true,
    inverse: input.inverse === true,
    strike: input.strike === true,
  }
}
