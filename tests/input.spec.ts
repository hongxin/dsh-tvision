/**
 * Input decoder tests.
 *
 * The decoder's hard promise is that a sequence split across two reads is never
 * mis-decoded, because a real terminal delivers escapes in whatever chunks the
 * kernel felt like. Every "split" test below feeds a sequence one byte at a
 * time and asserts the same events come out as when it arrives whole.
 */
import { describe, expect, it } from 'vitest'
import { InputDecoder, type InputEvent } from '../src/kit/input.ts'

/** Feed a payload one byte at a time. */
function pushBytewise(payload: string): InputEvent[] {
  const decoder = new InputDecoder()
  const events: InputEvent[] = []
  for (const byte of payload) events.push(...decoder.push(byte))
  return events
}

/** Feed a payload whole. */
function pushWhole(payload: string): InputEvent[] {
  return new InputDecoder().push(payload)
}

describe('printable input', () => {
  it('decodes ASCII characters with their text', () => {
    expect(pushWhole('ab')).toEqual([
      { type: 'key', key: 'a', text: 'a' },
      { type: 'key', key: 'b', text: 'b' },
    ])
  })

  it('decodes a multi-byte character as one key', () => {
    const events = pushWhole('中')
    expect(events).toEqual([{ type: 'key', key: '中', text: '中' }])
  })

  it('lowercases the key name but preserves the text', () => {
    expect(pushWhole('A')).toEqual([{ type: 'key', key: 'a', text: 'A' }])
  })

  it('produces identical events when delivered byte by byte', () => {
    expect(pushBytewise('a中b')).toEqual(pushWhole('a中b'))
  })
})

describe('control keys', () => {
  it('names the C0 controls', () => {
    expect(pushWhole('\r')).toEqual([{ type: 'key', key: 'enter' }])
    expect(pushWhole('\n')).toEqual([{ type: 'key', key: 'enter' }])
    expect(pushWhole('\t')).toEqual([{ type: 'key', key: 'tab' }])
    expect(pushWhole('\u007F')).toEqual([{ type: 'key', key: 'backspace' }])
    expect(pushWhole('\u0008')).toEqual([{ type: 'key', key: 'backspace' }])
    expect(pushWhole('\u0000')).toEqual([{ type: 'key', key: 'ctrl+space' }])
  })

  it('derives ctrl+letter from the remaining control bytes', () => {
    expect(pushWhole('\u0003')).toEqual([{ type: 'key', key: 'ctrl+c' }])
    expect(pushWhole('\u000F')).toEqual([{ type: 'key', key: 'ctrl+o' }])
    expect(pushWhole('\u001A')).toEqual([{ type: 'key', key: 'ctrl+z' }])
  })

  it('releases a lone escape as the Escape key on flush', () => {
    const decoder = new InputDecoder()
    expect(decoder.push('\u001B')).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.flush()).toEqual([{ type: 'key', key: 'escape' }])
    expect(decoder.pending).toBe(false)
  })
})

describe('CSI and SS3 navigation keys', () => {
  it('decodes the arrow keys by final byte', () => {
    expect(pushWhole('\u001B[A')).toEqual([{ type: 'key', key: 'up' }])
    expect(pushWhole('\u001B[B')).toEqual([{ type: 'key', key: 'down' }])
    expect(pushWhole('\u001B[C')).toEqual([{ type: 'key', key: 'right' }])
    expect(pushWhole('\u001B[D')).toEqual([{ type: 'key', key: 'left' }])
  })

  it('decodes the same keys in SS3 form', () => {
    expect(pushWhole('\u001BOA')).toEqual([{ type: 'key', key: 'up' }])
    expect(pushWhole('\u001BOD')).toEqual([{ type: 'key', key: 'left' }])
    expect(pushWhole('\u001BOP')).toEqual([{ type: 'key', key: 'f1' }])
  })

  it('decodes Home, End, and Shift+Tab', () => {
    expect(pushWhole('\u001B[H')).toEqual([{ type: 'key', key: 'home' }])
    expect(pushWhole('\u001B[F')).toEqual([{ type: 'key', key: 'end' }])
    expect(pushWhole('\u001B[Z')).toEqual([{ type: 'key', key: 'shift+tab' }])
  })

  it('decodes the tilde-form keys', () => {
    expect(pushWhole('\u001B[2~')).toEqual([{ type: 'key', key: 'insert' }])
    expect(pushWhole('\u001B[3~')).toEqual([{ type: 'key', key: 'delete' }])
    expect(pushWhole('\u001B[5~')).toEqual([{ type: 'key', key: 'pageup' }])
    expect(pushWhole('\u001B[6~')).toEqual([{ type: 'key', key: 'pagedown' }])
  })

  it('decodes the function keys the hint bar advertises', () => {
    const expected: [string, string][] = [
      ['\u001B[11~', 'f1'], ['\u001B[12~', 'f2'], ['\u001B[13~', 'f3'], ['\u001B[14~', 'f4'],
      ['\u001B[15~', 'f5'], ['\u001B[17~', 'f6'], ['\u001B[18~', 'f7'], ['\u001B[19~', 'f8'],
      ['\u001B[20~', 'f9'], ['\u001B[21~', 'f10'], ['\u001B[23~', 'f11'], ['\u001B[24~', 'f12'],
    ]
    for (const [sequence, key] of expected) {
      expect(pushWhole(sequence), sequence).toEqual([{ type: 'key', key }])
    }
  })

  it('applies the modifier bitmask in a canonical order', () => {
    // xterm encodes modifiers as bitmask + 1: 2 = shift, 3 = alt, 5 = ctrl.
    expect(pushWhole('\u001B[1;5A')).toEqual([{ type: 'key', key: 'ctrl+up' }])
    expect(pushWhole('\u001B[1;3D')).toEqual([{ type: 'key', key: 'alt+left' }])
    expect(pushWhole('\u001B[1;2C')).toEqual([{ type: 'key', key: 'shift+right' }])
    expect(pushWhole('\u001B[1;7A')).toEqual([{ type: 'key', key: 'ctrl+alt+up' }])
  })

  it('decodes a modified tilde key', () => {
    expect(pushWhole('\u001B[3;5~')).toEqual([{ type: 'key', key: 'ctrl+delete' }])
  })

  it('ignores a CSI sequence it does not know rather than guessing', () => {
    expect(pushWhole('\u001B[999;999z')).toEqual([])
  })
})

describe('alt combinations', () => {
  it('decodes ESC followed by a character as alt+char', () => {
    expect(pushWhole('\u001Bf')).toEqual([{ type: 'key', key: 'alt+f', text: 'f' }])
    expect(pushWhole('\u001Bx')).toEqual([{ type: 'key', key: 'alt+x', text: 'x' }])
  })

  it('treats a doubled escape as a bare Escape', () => {
    expect(pushWhole('\u001B\u001B')).toEqual([{ type: 'key', key: 'escape' }])
  })
})

describe('kitty keyboard protocol', () => {
  it('decodes a plain code point form', () => {
    expect(pushWhole('\u001B[97u')).toEqual([{ type: 'key', key: 'a', text: 'a' }])
  })

  it('decodes a modified code point form', () => {
    expect(pushWhole('\u001B[111;5u')).toEqual([{ type: 'key', key: 'ctrl+o' }])
  })

  it('decodes the navigation form', () => {
    expect(pushWhole('\u001B[1;5A')).toEqual([{ type: 'key', key: 'ctrl+up' }])
  })

  it('drops key-release events', () => {
    expect(pushWhole('\u001B[97;1:3u')).toEqual([])
  })
})

describe('modify-other-keys form', () => {
  it('decodes CSI 27 ; mod ; code ~', () => {
    expect(pushWhole('\u001B[27;5;111~')).toEqual([{ type: 'key', key: 'ctrl+o' }])
    expect(pushWhole('\u001B[27;2;13~')).toEqual([{ type: 'key', key: 'shift+enter' }])
  })
})

describe('SGR mouse', () => {
  it('decodes a left press with 0-based coordinates', () => {
    expect(pushWhole('\u001B[<0;10;5M')).toEqual([
      { type: 'mouse', kind: 'press', button: 'left', x: 9, y: 4, shift: false, alt: false, ctrl: false },
    ])
  })

  it('decodes a release', () => {
    expect(pushWhole('\u001B[<0;10;5m')).toEqual([
      { type: 'mouse', kind: 'release', button: 'left', x: 9, y: 4, shift: false, alt: false, ctrl: false },
    ])
  })

  it('decodes middle and right buttons', () => {
    expect(pushWhole('\u001B[<1;1;1M')[0]).toMatchObject({ button: 'middle' })
    expect(pushWhole('\u001B[<2;1;1M')[0]).toMatchObject({ button: 'right' })
  })

  it('decodes a drag as motion with a button', () => {
    expect(pushWhole('\u001B[<32;3;4M')).toEqual([
      { type: 'mouse', kind: 'drag', button: 'left', x: 2, y: 3, shift: false, alt: false, ctrl: false },
    ])
  })

  it('decodes wheel ticks with a direction', () => {
    expect(pushWhole('\u001B[<64;1;1M')[0]).toMatchObject({ kind: 'wheel', delta: -1 })
    expect(pushWhole('\u001B[<65;1;1M')[0]).toMatchObject({ kind: 'wheel', delta: 1 })
  })

  it('decodes the modifier bits', () => {
    expect(pushWhole('\u001B[<4;1;1M')[0]).toMatchObject({ shift: true, alt: false, ctrl: false })
    expect(pushWhole('\u001B[<8;1;1M')[0]).toMatchObject({ shift: false, alt: true, ctrl: false })
    expect(pushWhole('\u001B[<16;1;1M')[0]).toMatchObject({ shift: false, alt: false, ctrl: true })
    expect(pushWhole('\u001B[<28;1;1M')[0]).toMatchObject({ shift: true, alt: true, ctrl: true })
  })

  it('survives being delivered one byte at a time', () => {
    const payload = '\u001B[<0;12;7M'
    expect(pushBytewise(payload)).toEqual(pushWhole(payload))
  })
})

describe('X10 mouse', () => {
  it('decodes a press with offset coordinates', () => {
    // ESC [ M, then button+32, x+32, y+32.
    const sequence = `\u001B[M${String.fromCharCode(32 + 0)}${String.fromCharCode(32 + 5)}${String.fromCharCode(32 + 3)}`
    expect(pushWhole(sequence)).toEqual([
      { type: 'mouse', kind: 'press', button: 'left', x: 4, y: 2, shift: false, alt: false, ctrl: false },
    ])
  })

  it('survives being delivered one byte at a time', () => {
    const sequence = `\u001B[M${String.fromCharCode(32 + 2)}${String.fromCharCode(32 + 9)}${String.fromCharCode(32 + 9)}`
    expect(pushBytewise(sequence)).toEqual(pushWhole(sequence))
  })
})

describe('urxvt mouse', () => {
  it('decodes the CSI b;x;yM form', () => {
    expect(pushWhole('\u001B[0;4;6M')).toEqual([
      { type: 'mouse', kind: 'press', button: 'left', x: 3, y: 5, shift: false, alt: false, ctrl: false },
    ])
  })
})

describe('bracketed paste', () => {
  it('delivers the payload as one paste event', () => {
    expect(pushWhole('\u001B[200~hello world\u001B[201~')).toEqual([
      { type: 'paste', text: 'hello world' },
    ])
  })

  it('keeps newlines and escapes inside the payload verbatim', () => {
    const payload = 'a\nb\tc\u001B[31mred'
    expect(pushWhole(`\u001B[200~${payload}\u001B[201~`)).toEqual([{ type: 'paste', text: payload }])
  })

  it('does not emit keys while a paste is open', () => {
    const decoder = new InputDecoder()
    expect(decoder.push('\u001B[200~ab')).toEqual([])
    expect(decoder.push('cd\u001B[201~')).toEqual([{ type: 'paste', text: 'abcd' }])
  })

  it('resumes normal decoding after the closing marker', () => {
    expect(pushWhole('\u001B[200~x\u001B[201~y')).toEqual([
      { type: 'paste', text: 'x' },
      { type: 'key', key: 'y', text: 'y' },
    ])
  })

  it('survives a marker split across chunks', () => {
    const decoder = new InputDecoder()
    expect(decoder.push('\u001B[20')).toEqual([])
    expect(decoder.push('0~data\u001B[20')).toEqual([])
    expect(decoder.push('1~')).toEqual([{ type: 'paste', text: 'data' }])
  })
})

describe('focus reporting', () => {
  it('decodes focus in and out', () => {
    expect(pushWhole('\u001B[I')).toEqual([{ type: 'focus', focused: true }])
    expect(pushWhole('\u001B[O')).toEqual([{ type: 'focus', focused: false }])
  })
})

describe('reset', () => {
  it('discards a partial sequence', () => {
    const decoder = new InputDecoder()
    decoder.push('\u001B[')
    expect(decoder.pending).toBe(true)
    decoder.reset()
    expect(decoder.pending).toBe(false)
    expect(decoder.push('a')).toEqual([{ type: 'key', key: 'a', text: 'a' }])
  })
})
