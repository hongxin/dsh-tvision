/**
 * The input decoder: raw terminal bytes in, structured events out.
 *
 * A terminal multiplexes five unrelated grammars onto one byte stream —
 * printable UTF-8, C0 control bytes, CSI/SS3 key sequences, bracketed paste,
 * and three incompatible mouse encodings. This module separates them and
 * guarantees the property the rest of the system relies on: **one `push` call
 * yields whole events, never half of one**. A CSI sequence split across two
 * `read()` calls is buffered, not mis-decoded.
 *
 * Why not reuse an existing decoder: the widgets here need mouse drags, mouse
 * releases, wheel ticks, paste blocks and focus changes as *first-class typed
 * events*, and the key name has to be stable enough to appear in a menu
 * accelerator, an F-key hint strip, and a keybinding table at once. That is a
 * different contract from a chat TUI's "is this string Ctrl+O", so the decoder
 * is owned here and covered by its own tests.
 * @module @dsh-tvision/dsh-tvision/kit/input
 */

/** A press event for a named key. */
export interface KeyInput {
  type: 'key'
  /** Normalised key name: `'a'`, `'enter'`, `'f10'`, `'up'`, `'ctrl+o'`. */
  key: string
  /** Printable text, when the event produces any. */
  text?: string
}

/** A block of text delivered by the terminal's paste protocol. */
export interface PasteInput {
  type: 'paste'
  text: string
}

/** A mouse button, drag, release, or wheel event. */
export interface MouseInput {
  type: 'mouse'
  kind: 'press' | 'drag' | 'release' | 'wheel'
  /** Which button; `'none'` for a motion event with no button held. */
  button: 'left' | 'middle' | 'right' | 'none'
  /** Screen column, 0-based (converted from the protocol's 1-based form). */
  x: number
  /** Screen row, 0-based. */
  y: number
  /** Wheel direction; `-1` up, `1` down. Present only for wheel events. */
  delta?: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

/** The terminal window gained or lost focus. */
export interface FocusInput {
  type: 'focus'
  focused: boolean
}

/** The window changed size. */
export interface ResizeInput {
  type: 'resize'
  columns: number
  rows: number
}

/** Anything the decoder can produce. */
export type InputEvent = KeyInput | PasteInput | MouseInput | FocusInput | ResizeInput

/** Bracketed-paste open marker. */
const PASTE_START = '\u001B[200~'
/** Bracketed-paste close marker. */
const PASTE_END = '\u001B[201~'
/** Mouse reporting uses 1-based coordinates; the grid is 0-based. */
const MOUSE_ORIGIN = 1
/** Byte offset of the X10 mouse protocol's three payload bytes. */
const X10_PAYLOAD = 32

/** CSI/SS3 final bytes mapped to this system's key names. */
const FINAL_BYTES: Readonly<Record<string, string>> = Object.freeze({
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  E: 'begin',
  F: 'end',
  H: 'home',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  Z: 'shift+tab',
})

/** `CSI <n> ~` codes mapped to this system's key names. */
const TILDE_CODES: Readonly<Record<number, string>> = Object.freeze({
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
})

/** Printable names for the ASCII control bytes. */
const CONTROL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '\u0000': 'ctrl+space',
  '\u0008': 'backspace',
  '\u0009': 'tab',
  '\u000A': 'enter',
  '\u000D': 'enter',
  '\u001B': 'escape',
  '\u001F': 'ctrl+_',
})

/**
 * Decode one complete escape sequence into an event, if it is one we know.
 * @param sequence - The sequence, starting with ESC.
 * @returns The event, or undefined when the sequence is unrecognised.
 */
function decodeEscape(sequence: string): InputEvent | undefined {
  // Focus reporting: CSI I / CSI O.
  if (sequence === '\u001B[I') return { type: 'focus', focused: true }
  if (sequence === '\u001B[O') return { type: 'focus', focused: false }

  // SGR mouse: CSI < b ; x ; y M (press/motion) or m (release).
  const sgr = /^\u001B\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(sequence)
  if (sgr !== null) {
    const code = Number(sgr[1])
    const x = Number(sgr[2]) - MOUSE_ORIGIN
    const y = Number(sgr[3]) - MOUSE_ORIGIN
    const released = sgr[4] === 'm'
    const shift = (code & 4) !== 0
    const alt = (code & 8) !== 0
    const ctrl = (code & 16) !== 0
    const motion = (code & 32) !== 0
    const wheel = (code & 64) !== 0
    if (wheel) {
      // Wheel codes are 64 (up) and 65 (down); 66/67 are horizontal, which we
      // report as no vertical movement rather than inventing a second axis.
      const up = (code & 1) === 0
      return { type: 'mouse', kind: 'wheel', button: 'none', x, y, delta: up ? -1 : 1, shift, alt, ctrl }
    }
    const button: MouseInput['button'] = released && (code & 3) === 3
      ? 'none'
      : (code & 3) === 0 ? 'left' : (code & 3) === 1 ? 'middle' : 'right'
    return {
      type: 'mouse',
      kind: released ? 'release' : motion ? 'drag' : 'press',
      button,
      x,
      y,
      shift,
      alt,
      ctrl,
    }
  }

  // urxvt mouse: CSI b ; x ; y M.
  const urxvt = /^\u001B\[(\d+);(\d+);(\d+)M$/u.exec(sequence)
  if (urxvt !== null) {
    const code = Number(urxvt[1])
    return {
      type: 'mouse',
      kind: 'press',
      button: code === 3 ? 'none' : code === 0 ? 'left' : code === 1 ? 'middle' : 'right',
      x: Number(urxvt[2]) - MOUSE_ORIGIN,
      y: Number(urxvt[3]) - MOUSE_ORIGIN,
      shift: false,
      alt: false,
      ctrl: false,
    }
  }

  // X10 mouse: CSI M followed by three offset bytes.
  if (sequence.startsWith('\u001B[M') && sequence.length >= 6) {
    const code = sequence.charCodeAt(3) - X10_PAYLOAD
    const x = sequence.charCodeAt(4) - X10_PAYLOAD - MOUSE_ORIGIN
    const y = sequence.charCodeAt(5) - X10_PAYLOAD - MOUSE_ORIGIN
    const wheel = (code & 64) !== 0
    if (wheel) {
      return {
        type: 'mouse', kind: 'wheel', button: 'none', x, y,
        delta: (code & 1) === 0 ? -1 : 1, shift: false, alt: false, ctrl: false,
      }
    }
    const buttonCode = code & 3
    return {
      type: 'mouse',
      kind: buttonCode === 3 ? 'release' : 'press',
      button: buttonCode === 3 ? 'none' : buttonCode === 0 ? 'left' : buttonCode === 1 ? 'middle' : 'right',
      x,
      y,
      shift: (code & 4) !== 0,
      alt: (code & 8) !== 0,
      ctrl: (code & 16) !== 0,
    }
  }

  // Modify-other-keys form: CSI 27 ; mod ; code ~.
  const modify = /^\u001B\[27;(\d+);(\d+)~$/u.exec(sequence)
  if (modify !== null) {
    const modifier = Number(modify[1]) - 1
    const codePoint = Number(modify[2])
    return keyFromCodePoint(codePoint, modifier)
  }

  // Kitty keyboard protocol: CSI code ; mod [: event] u and CSI 1 ; mod [ABCDHF].
  const kitty = /^\u001B\[(\d+)(?:;(\d+))?(?::(\d+))?u$/u.exec(sequence)
  if (kitty !== null) {
    const codePoint = Number(kitty[1])
    const modifier = kitty[2] === undefined ? 0 : Number(kitty[2]) - 1
    const eventType = kitty[3] === undefined ? 1 : Number(kitty[3])
    // 3 is key release; the TUI has no use for it beyond ignoring it, which the
    // caller does by dropping a `key` event whose name is empty.
    if (eventType === 3) return { type: 'key', key: '' }
    return keyFromCodePoint(codePoint, modifier)
  }
  const kittyNav = /^\u001B\[1;(\d+)(?::(\d+))?([ABCDHF])$/u.exec(sequence)
  if (kittyNav !== null) {
    const modifier = Number(kittyNav[1]) - 1
    const eventType = kittyNav[2] === undefined ? 1 : Number(kittyNav[2])
    if (eventType === 3) return { type: 'key', key: '' }
    return keyFromFinal(kittyNav[3] ?? '', modifier)
  }

  // CSI with parameters and a final byte.
  const csi = /^\u001B\[([\d;]*)([\u0040-\u007E])$/u.exec(sequence)
  if (csi !== null) {
    const params = csi[1] ?? ''
    const final = csi[2] ?? ''
    const numbers = params === '' ? [] : params.split(';').map(Number)
    const first = numbers[0]
    if (final === '~' && first !== undefined) {
      const name = TILDE_CODES[first]
      if (name === undefined) return undefined
      const modifier = numbers[1] === undefined ? 0 : numbers[1] - 1
      return keyFromFinal(nameToFinal(name), modifier, name)
    }
    if (final === 'u' && first !== undefined) return keyFromCodePoint(first, numbers[1] === undefined ? 0 : numbers[1] - 1)
    return keyFromFinal(final, numbers[1] === undefined ? 0 : numbers[1] - 1)
  }

  // SS3: ESC O followed by a final byte.
  if (sequence.length >= 3 && sequence[1] === 'O') {
    return keyFromFinal(sequence[2] ?? '', 0)
  }

  // Alt + printable: ESC followed by one character.
  if (sequence.length === 2) {
    const char = sequence[1] ?? ''
    if (char === '\u001B') return { type: 'key', key: 'escape' }
    return { type: 'key', key: `alt+${char.toLowerCase()}`, text: char }
  }
  return undefined
}

/**
 * Map a navigation key name back to its CSI final byte, so a modified
 * navigation key can be built from the same table as an unmodified one.
 * @param name - The key name.
 * @returns The final byte, or an empty string when the name has none.
 */
function nameToFinal(name: string): string {
  for (const [final, mapped] of Object.entries(FINAL_BYTES)) {
    if (mapped === name) return final
  }
  return ''
}

/**
 * Build an event for a key identified by a CSI final byte.
 * @param final - The final byte.
 * @param modifier - The modifier bitmask minus one (xterm semantics).
 * @param override - A key name to use instead of the byte's default.
 * @returns The event, or undefined when the byte is not a navigation key.
 */
function keyFromFinal(final: string, modifier: number, override?: string): InputEvent | undefined {
  const base = override ?? FINAL_BYTES[final]
  if (base === undefined) return undefined
  return { type: 'key', key: applyModifier(base, modifier) }
}

/**
 * Prepend the modifier prefixes a bitmask implies, in the canonical
 * `ctrl+alt+shift+` order so a key name is stable to compare against.
 * @param base - The unmodified key name.
 * @param modifier - The modifier bitmask minus one: 1 shift, 2 alt, 4 ctrl.
 * @returns The decorated key name.
 */
function applyModifier(base: string, modifier: number): string {
  // Built by prefixing in reverse so the result reads ctrl+alt+shift+base, which
  // is the order the keybinding table and the help window document.
  let prefix = ''
  if ((modifier & 1) !== 0) prefix = `shift+${prefix}`
  if ((modifier & 2) !== 0) prefix = `alt+${prefix}`
  if ((modifier & 4) !== 0) prefix = `ctrl+${prefix}`
  return `${prefix}${base}`
}

/**
 * Build an event for a key identified by a Unicode code point.
 * @param codePoint - The code point the terminal reported.
 * @param modifier - The modifier bitmask minus one.
 * @returns The event.
 */
function keyFromCodePoint(codePoint: number, modifier: number): InputEvent {
  if (codePoint === 0x20) {
    return modifier === 0
      ? { type: 'key', key: 'space', text: ' ' }
      : { type: 'key', key: applyModifier('space', modifier) }
  }
  const char = String.fromCodePoint(codePoint)
  if (codePoint === 0x0D || codePoint === 0x0A) return { type: 'key', key: applyModifier('enter', modifier) }
  if (codePoint === 0x09) return { type: 'key', key: applyModifier('tab', modifier) }
  if (codePoint === 0x7F) return { type: 'key', key: applyModifier('backspace', modifier) }
  if (codePoint === 0x1B) return { type: 'key', key: applyModifier('escape', modifier) }
  const named = CONTROL_NAMES[char]
  if (named !== undefined) return { type: 'key', key: applyModifier(named, modifier) }
  if (codePoint < 0x20) {
    // Remaining C0 bytes are Ctrl+<letter>. The offset is 0x60, not 0x61:
    // byte 1 is Ctrl+A and byte 26 is Ctrl+Z. The `ctrl+` prefix comes from the
    // modifier bitmask so that an already-modified byte cannot double it.
    const letter = String.fromCharCode(0x60 + codePoint)
    return { type: 'key', key: applyModifier(letter, modifier | 4) }
  }
  if (modifier === 0) return { type: 'key', key: char.toLowerCase(), text: char }
  return { type: 'key', key: applyModifier(char.toLowerCase(), modifier), text: modifier === 1 ? char : undefined }
}

/**
 * Decode plain text into a run of key events.
 *
 * This path is for bytes that are *not* part of an escape sequence, so an
 * embedded ESC is dropped rather than reinterpreted — the caller has already
 * peeled off every complete escape sequence.
 * @param text - The text.
 * @returns One event per code point or control byte.
 */
function decodePlain(text: string): InputEvent[] {
  const events: InputEvent[] = []
  for (const char of text) {
    if (char === '\u001B') continue
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7F) {
      events.push(keyFromCodePoint(codePoint, 0))
      continue
    }
    events.push({ type: 'key', key: char.toLowerCase(), text: char })
  }
  return events
}

/**
 * The length of the partial paste marker at the end of `text`, or 0.
 *
 * A marker split across reads must be held rather than decoded. The scan is
 * bounded by the marker length because only the last few bytes can be a prefix.
 * @param text - The pending run.
 * @returns How many trailing bytes to hold back.
 */
function partialPasteMarkerAtEnd(text: string): number {
  const longest = Math.max(PASTE_START.length, PASTE_END.length)
  const limit = Math.min(text.length, longest - 1)
  for (let length = limit; length >= 2; length--) {
    const tail = text.slice(text.length - length)
    if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)) return length
  }
  return 0
}

/**
 * Whether the whole buffer is a prefix of a paste marker and nothing else.
 * @param text - The pending buffer.
 * @returns True when more bytes are needed before anything can be decoded.
 */
function isPastePrefix(text: string): boolean {
  if (text.length >= PASTE_START.length) return false
  return PASTE_START.startsWith(text)
}

/**
 * The stateful byte-to-event decoder.
 *
 * Feed it whatever `stdin` produced; it holds partial sequences until they are
 * complete. Call {@link flush} when input has been quiet for a moment to
 * release a lone ESC as an Escape key rather than an Alt prefix.
 */
export class InputDecoder {
  private buffer = ''
  private pasting = false
  private pasteBuffer = ''

  /**
   * Feed raw bytes.
   * @param chunk - The bytes or text received from the terminal.
   * @returns Every whole event the chunk completed, in order.
   */
  push(chunk: string): InputEvent[] {
    this.buffer += chunk
    return this.drain()
  }

  /**
   * Release anything held back. A lone ESC becomes an Escape key press.
   * @returns Any remaining events.
   */
  flush(): InputEvent[] {
    const out: InputEvent[] = []
    if (this.buffer === '\u001B') {
      out.push({ type: 'key', key: 'escape' })
      this.buffer = ''
    } else if (this.buffer !== '' && !this.buffer.startsWith('\u001B')) {
      out.push(...decodePlain(this.buffer))
      this.buffer = ''
    }
    return out
  }

  /** Whether the decoder is holding a partial sequence. */
  get pending(): boolean {
    return this.buffer !== ''
  }

  /** Discard any partial sequence (used on teardown and after a resize). */
  reset(): void {
    this.buffer = ''
    this.pasting = false
    this.pasteBuffer = ''
  }

  /**
   * Consume as much of the buffer as forms complete events.
   * @returns The events, in order.
   */
  private drain(): InputEvent[] {
    const out: InputEvent[] = []
    for (;;) {
      // 1. Inside a paste, everything up to the closing marker is payload.
      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END)
        if (end < 0) {
          // Hold back any trailing bytes that could begin the closing marker,
          // so a marker split across reads is not swallowed as paste content.
          const partial = partialPasteMarkerAtEnd(this.buffer)
          this.pasteBuffer += partial > 0 ? this.buffer.slice(0, this.buffer.length - partial) : this.buffer
          this.buffer = partial > 0 ? this.buffer.slice(this.buffer.length - partial) : ''
          return out
        }
        this.pasteBuffer += this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + PASTE_END.length)
        out.push({ type: 'paste', text: this.pasteBuffer })
        this.pasteBuffer = ''
        this.pasting = false
        continue
      }

      if (this.buffer === '') return out

      // 2. The opening marker, whole or partial. It is matched as a string
      //    rather than through the CSI scanner because it must be consumed, and
      //    because the generic scanner cannot see a six-byte marker that has
      //    only partly arrived.
      if (this.buffer.startsWith(PASTE_START)) {
        this.pasting = true
        this.buffer = this.buffer.slice(PASTE_START.length)
        continue
      }
      // A stray closing marker is dropped rather than decoded as key presses.
      if (this.buffer.startsWith(PASTE_END)) {
        this.buffer = this.buffer.slice(PASTE_END.length)
        continue
      }
      if (isPastePrefix(this.buffer)) return out

      // 3. Ordinary bytes. Emit the run up to the next escape, but hold any
      //    trailing bytes that could still turn out to be a marker.
      if (!this.buffer.startsWith('\u001B')) {
        const nextEscape = this.buffer.indexOf('\u001B')
        const run = nextEscape < 0 ? this.buffer : this.buffer.slice(0, nextEscape)
        const hold = partialPasteMarkerAtEnd(run)
        const complete = hold > 0 ? run.slice(0, run.length - hold) : run
        const held = hold > 0 ? run.slice(run.length - hold) : ''
        if (complete !== '') out.push(...decodePlain(complete))
        if (held !== '') {
          // Keep the held bytes and stop: they precede an escape sequence that
          // has not fully arrived either.
          this.buffer = held + (nextEscape < 0 ? '' : this.buffer.slice(nextEscape))
          return out
        }
        this.buffer = nextEscape < 0 ? '' : this.buffer.slice(nextEscape)
        continue
      }

      // 4. An escape sequence. The generic scanner owns everything that is not
      //    a paste marker.
      const length = this.sequenceLength()
      if (length < 0) return out
      const sequence = this.buffer.slice(0, length)
      this.buffer = this.buffer.slice(length)
      const event = decodeEscape(sequence)
      if (event !== undefined && !(event.type === 'key' && event.key === '')) out.push(event)
    }
  }

  /**
   * The byte length of the escape sequence at the head of the buffer, or `-1`
   * when it has not fully arrived.
   * @returns The length, or `-1`.
   */
  private sequenceLength(): number {
    const buffer = this.buffer
    if (buffer.length < 2) return -1
    const second = buffer[1]
    if (second === '[') {
      // CSI: parameters are 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E.
      for (let index = 2; index < buffer.length; index++) {
        const code = buffer.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7E) {
          // X10 mouse is special: its payload bytes are printable and would
          // otherwise terminate the sequence at the 'M'.
          if (buffer.startsWith('\u001B[M')) return buffer.length >= 6 ? 6 : -1
          return index + 1
        }
      }
      return -1
    }
    if (second === 'O') return buffer.length >= 3 ? 3 : -1
    if (second === ']' || second === 'P' || second === '_' || second === '^') {
      for (let index = 2; index < buffer.length; index++) {
        const char = buffer[index]
        if (char === '\u0007') return index + 1
        if (char === '\u001B' && buffer[index + 1] === '\\') return index + 2
      }
      return -1
    }
    // Alt + one character.
    return 2
  }
}
