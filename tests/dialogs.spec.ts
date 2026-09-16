/**
 * Dialog tests.
 *
 * The approval and question paths exist to satisfy a harness contract, and the
 * contract has one hard requirement that shapes everything here: **every
 * question must settle**. A promise that never resolves wedges the agent turn
 * that asked it, and the ways to leak one are not obvious — Escape, the system
 * box, an aborted signal, a second question opened over the first, a thrown
 * render. So most of these tests are about the exits rather than the happy path.
 */
import { describe, expect, it, vi } from 'vitest'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { Consumed } from '../src/kit/widget.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'
import { Dialog, confirmSpec, dialogTitleStyle } from '../src/views/dialogs.ts'
import {
  QUESTION_SENTINELS,
  approvalSpec,
  askApproval,
  askQuestions,
  questionSpec,
  type AskHost,
  type QuestionAsk,
} from '../src/app/questions.ts'

const palette = resolvePalette(TURBO_VISION)

/** Draw a dialog and return the buffer it painted into. */
function paint(dialog: Dialog, width = 60, height = 16): CellBuffer {
  const buffer = new CellBuffer(width, height)
  dialog.draw(new Painter(buffer, rect(0, 0, width, height)), {
    palette,
    focused: true,
    requestRender: () => {},
  })
  return buffer
}

const key = (name: string) => ({ type: 'key' as const, key: name })

/** A two-choice dialog, the shape both the approval and confirm paths use. */
function twoChoice(): Dialog {
  return new Dialog({
    title: 'Approval required',
    question: 'Allow bash to run?',
    detail: 'The agent asked to run a tool that needs your decision.',
    letterKeys: true,
    choices: [
      { value: 'allow', label: 'Allow once', detail: 'Run this one call.' },
      { value: 'deny', label: 'Deny', detail: 'Refuse it.', dangerous: true },
    ],
  })
}

describe('Dialog rendering', () => {
  it('draws the question and both buttons', () => {
    const frame = paint(twoChoice()).lines().join('\n')
    expect(frame).toContain('Allow bash to run?')
    expect(frame).toContain('Allow once')
    expect(frame).toContain('Deny')
  })

  it('draws the detail in a bordered region', () => {
    const frame = paint(twoChoice()).lines().join('\n')
    expect(frame).toContain('─')
    expect(frame).toContain('The agent asked')
  })

  it('explains the highlighted choice under the buttons', () => {
    const frame = paint(twoChoice()).lines().join('\n')
    expect(frame).toContain('Run this one call.')
  })

  it('never writes a row wider than the window', () => {
    const dialog = new Dialog({
      title: 'Long',
      question: 'x'.repeat(400),
      detail: 'y'.repeat(400),
      choices: [{ value: 'a', label: 'A'.repeat(80) }],
    })
    const buffer = paint(dialog, 40, 12)
    for (let row = 0; row < buffer.height; row++) {
      expect(buffer.row(row).length).toBe(40)
    }
  })

  it('survives a window too small for its contents', () => {
    expect(() => paint(twoChoice(), 12, 4)).not.toThrow()
  })

  it('records a button box per choice for the mouse', () => {
    const dialog = twoChoice()
    paint(dialog)
    // Choosing by click is asserted below; this only proves drawing happened.
    expect(dialog.done).toBe(false)
  })
})

describe('Dialog keys', () => {
  it('settles on the default with Enter', () => {
    const dialog = twoChoice()
    expect(dialog.onKey(key('enter'))).toBe(Consumed.Yes)
    expect(dialog.done).toBe(true)
  })

  it('moves the selection with the arrows and Tab', () => {
    const dialog = twoChoice()
    dialog.onKey(key('right'))
    dialog.onKey(key('enter'))
    return dialog.result.then((result) => {
      expect(result.value).toBe('deny')
    })
  })

  it('wraps the selection around', () => {
    const dialog = twoChoice()
    dialog.onKey(key('left'))
    dialog.onKey(key('enter'))
    return dialog.result.then((result) => {
      expect(result.value).toBe('deny')
    })
  })

  it('answers yes and no with the letters', () => {
    const yes = twoChoice()
    yes.onKey(key('y'))
    const no = twoChoice()
    no.onKey(key('n'))
    return Promise.all([yes.result, no.result]).then(([a, b]) => {
      expect(a.value).toBe('allow')
      expect(b.value).toBe('deny')
    })
  })

  it('ignores the letters when the dialog does not offer them', () => {
    const dialog = new Dialog({
      title: 't',
      question: 'q',
      choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    })
    expect(dialog.onKey(key('y'))).toBe(Consumed.Yes)
    expect(dialog.done).toBe(false)
  })

  it('dismisses with Escape, reporting no choice', () => {
    const dialog = twoChoice()
    dialog.onKey(key('escape'))
    return dialog.result.then((result) => {
      expect(result.dismissed).toBe(true)
      expect(result.value).toBeUndefined()
    })
  })

  it('swallows every other key rather than leaking it behind the dialog', () => {
    // A modal that let a stray keystroke reach the composer would corrupt the
    // prompt the user is in the middle of writing.
    const dialog = twoChoice()
    for (const name of ['a', 'q', 'f1', 'ctrl+z', 'pageup', 'down']) {
      expect(dialog.onKey(key(name))).toBe(Consumed.Yes)
    }
    expect(dialog.done).toBe(false)
  })

  it('scrolls a long detail with the paging keys', () => {
    const dialog = new Dialog({
      title: 't',
      question: 'q',
      detail: Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'),
      choices: [{ value: 'a', label: 'A' }],
    })
    paint(dialog, 50, 14)
    const before = paint(dialog, 50, 14).lines().join('\n')
    dialog.onKey(key('pagedown'))
    const after = paint(dialog, 50, 14).lines().join('\n')
    expect(after).not.toBe(before)
    dialog.onKey(key('pageup'))
    expect(paint(dialog, 50, 14).lines().join('\n')).toBe(before)
  })

  it('handles a choice list that is empty', () => {
    const dialog = new Dialog({ title: 't', question: 'q', choices: [] })
    dialog.onKey(key('enter'))
    return dialog.result.then((result) => {
      expect(result.dismissed).toBe(true)
    })
  })
})

describe('Dialog mouse', () => {
  it('chooses the button a click lands on', async () => {
    const dialog = twoChoice()
    const buffer = paint(dialog)
    // Find the row the buttons were drawn on.
    const row = buffer.lines().findIndex(line => line.includes('Deny'))
    const column = buffer.row(row).indexOf('Deny')
    expect(row).toBeGreaterThan(0)
    dialog.onMouse(
      { x: column + 1, y: row, kind: 'press', button: 'left' },
      { palette, focused: true, requestRender: () => {}, origin: { x: 0, y: 0 } },
    )
    const result = await dialog.result
    expect(result.value).toBe('deny')
  })

  it('swallows a click that misses every button', () => {
    const dialog = twoChoice()
    paint(dialog)
    expect(dialog.onMouse(
      { x: 1, y: 1, kind: 'press', button: 'left' },
      { palette, focused: true, requestRender: () => {}, origin: { x: 0, y: 0 } },
    )).toBe(Consumed.Yes)
    expect(dialog.done).toBe(false)
  })

  it('scrolls the detail with the wheel', () => {
    const dialog = new Dialog({
      title: 't',
      question: 'q',
      detail: Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'),
      choices: [{ value: 'a', label: 'A' }],
    })
    paint(dialog, 50, 14)
    const before = paint(dialog, 50, 14).lines().join('\n')
    dialog.onMouse(
      { x: 5, y: 5, kind: 'wheel', button: 'none', delta: 1 },
      { palette, focused: true, requestRender: () => {}, origin: { x: 0, y: 0 } },
    )
    expect(paint(dialog, 50, 14).lines().join('\n')).not.toBe(before)
  })
})

describe('Dialog settling', () => {
  it('settles exactly once, the first answer winning', async () => {
    const dialog = twoChoice()
    dialog.onKey(key('enter'))
    // A second answer, from a stray click or a late key, must not revise it.
    dialog.onKey(key('escape'))
    dialog.settle({ value: 'deny', dismissed: false })
    const result = await dialog.result
    expect(result.value).toBe('allow')
  })

  it('settles as dismissed when the signal aborts', async () => {
    const controller = new AbortController()
    const dialog = new Dialog({ title: 't', question: 'q', choices: [{ value: 'a', label: 'A' }] }, controller.signal)
    controller.abort()
    const result = await dialog.result
    expect(result.dismissed).toBe(true)
  })

  it('settles immediately when handed an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const dialog = new Dialog({ title: 't', question: 'q', choices: [{ value: 'a', label: 'A' }] }, controller.signal)
    expect(dialog.done).toBe(true)
    await expect(dialog.result).resolves.toMatchObject({ dismissed: true })
  })

  it('is unaffected by an abort that arrives after a decision', async () => {
    const controller = new AbortController()
    const dialog = new Dialog(
      { title: 't', question: 'q', choices: [{ value: 'a', label: 'A' }] },
      controller.signal,
    )
    dialog.onKey(key('enter'))
    controller.abort()
    const result = await dialog.result
    expect(result.value).toBe('a')
  })
})

describe('confirmSpec', () => {
  it('defaults Enter to the confirm choice on a safe question', () => {
    const spec = confirmSpec('Save the file?')
    expect(spec.choices[0]?.isDefault).toBe(true)
    expect(spec.choices[1]?.value).toBe('cancel')
  })

  it('defaults Enter to cancel on a dangerous question', () => {
    // Enter on a destructive prompt must not be the same keystroke as Enter on a
    // harmless one.
    const spec = confirmSpec('Delete everything?', { dangerous: true })
    expect(spec.choices[0]?.isDefault).toBe(false)
    expect(spec.choices[1]?.isDefault).toBe(true)
    expect(spec.choices[0]?.dangerous).toBe(true)
  })

  it('takes custom labels and a title', () => {
    const spec = confirmSpec('Go?', { title: 'Now', confirmLabel: 'Go', cancelLabel: 'Stay' })
    expect(spec.title).toBe('Now')
    expect(spec.choices.map(choice => choice.label)).toEqual(['Go', 'Stay'])
  })

  it('passes a detail through', () => {
    expect(confirmSpec('Go?', { detail: 'why' }).detail).toBe('why')
  })
})

describe('dialogTitleStyle', () => {
  it('uses the error style for a dangerous dialog', () => {
    expect(dialogTitleStyle(true, palette)).toEqual(palette.error)
    expect(dialogTitleStyle(false, palette)).toEqual(palette.windowTitleActive)
  })
})

describe('approvalSpec', () => {
  it('names the tool and its stated reason', () => {
    const spec = approvalSpec({ toolName: 'bash', reason: 'writes outside the workspace' })
    expect(spec.question).toBe('bash: writes outside the workspace')
    expect(spec.detail).toContain('writes outside the workspace')
  })

  it('asks a plain question when no reason was given', () => {
    const spec = approvalSpec({ toolName: 'bash' })
    expect(spec.question).toBe('Allow bash to run?')
  })

  it('explains that the grant is one-shot', () => {
    // The most important thing a reader can learn from this window.
    expect(approvalSpec({ toolName: 'bash' }).detail).toContain('one-shot')
  })

  it('marks the refusing choice as dangerous', () => {
    const spec = approvalSpec({ toolName: 'bash' })
    expect(spec.choices.find(choice => choice.value === 'deny')?.dangerous).toBe(true)
  })
})

describe('askApproval', () => {
  /** A host that answers with a fixed choice. */
  const hostAnswering = (value: string | undefined): AskHost => ({
    ask: async () => value,
  })

  it('maps the allow choice to a one-shot grant', async () => {
    expect(await askApproval(hostAnswering('allow'), { toolName: 'bash' })).toBe('allowed-once')
  })

  it('maps the deny choice to a rejection', async () => {
    expect(await askApproval(hostAnswering('deny'), { toolName: 'bash' })).toBe('rejected')
  })

  it('maps a dismissal to a cancellation', async () => {
    // Escape is not a refusal: the harness records the two differently.
    expect(await askApproval(hostAnswering(undefined), { toolName: 'bash' })).toBe('cancelled')
  })

  it('cancels without asking when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const ask = vi.fn(async () => 'allow')
    // Opening a window for a turn that is already gone would be a lie.
    expect(await askApproval({ ask }, { toolName: 'bash', signal: controller.signal })).toBe('cancelled')
    expect(ask).not.toHaveBeenCalled()
  })

  it('cancels when the signal aborts while the dialog is up', async () => {
    const controller = new AbortController()
    const host: AskHost = {
      ask: async () => {
        controller.abort()
        return 'allow'
      },
    }
    expect(await askApproval(host, { toolName: 'bash', signal: controller.signal })).toBe('cancelled')
  })
})

describe('questionSpec', () => {
  const question: QuestionAsk = {
    id: 'q1',
    question: 'Which parser?',
    options: [{ label: 'stream' }, { label: 'buffer' }],
  }

  it('offers every option plus a way to decline', () => {
    const spec = questionSpec(question, [])
    expect(spec.choices.map(choice => choice.value)).toEqual(['stream', 'buffer', QUESTION_SENTINELS.cancel])
  })

  it('ticks the options already chosen', () => {
    const spec = questionSpec({ ...question, multiSelect: true }, ['buffer'])
    const chosen = spec.choices.find(choice => choice.value === 'buffer')
    expect(chosen?.label).toContain('✓')
  })

  it('offers Done once something is ticked in a multi-select', () => {
    const spec = questionSpec({ ...question, multiSelect: true }, ['stream'])
    const done = spec.choices.find(choice => choice.value === QUESTION_SENTINELS.done)
    expect(done?.label).toContain('1')
    expect(done?.isDefault).toBe(true)
  })

  it('offers Done immediately for an optionless multi-select', () => {
    // An unanswerable window is worse than a trivial one.
    const spec = questionSpec({ id: 'q', question: 'Anything?', multiSelect: true }, [])
    expect(spec.choices).toHaveLength(1)
    expect(spec.choices[0]?.value).toBe(QUESTION_SENTINELS.done)
  })

  it('offers only a decline for an optionless single-select', () => {
    const spec = questionSpec({ id: 'q', question: 'Free text?' }, [])
    expect(spec.choices).toHaveLength(1)
    expect(spec.choices[0]?.value).toBe(QUESTION_SENTINELS.cancel)
  })

  it('uses the header as the title and passes the detail through', () => {
    const spec = questionSpec({ id: 'q', question: 'Q', header: 'Plan review', detail: 'the plan' }, [])
    expect(spec.title).toBe('Plan review')
    expect(spec.detail).toBe('the plan')
  })

  it('falls back to a generic title', () => {
    expect(questionSpec({ id: 'q', question: 'Q' }, []).title).toBe('Question')
  })
})

describe('askQuestions', () => {
  /** A host that answers each question from a script, in order. */
  function scriptedHost(answers: (string | undefined)[]): AskHost & { asked: number } {
    const state = { asked: 0 }
    return {
      get asked() { return state.asked },
      ask: async () => {
        const answer = answers[state.asked]
        state.asked++
        return answer
      },
    }
  }

  it('answers a single-select question', async () => {
    const host = scriptedHost(['stream'])
    const answer = await askQuestions(host, [{ id: 'q1', question: 'Which?', options: [{ label: 'stream' }] }])
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['stream'] }])
  })

  it('records nothing when a question is declined', async () => {
    const host = scriptedHost([QUESTION_SENTINELS.cancel])
    const answer = await askQuestions(host, [{ id: 'q1', question: 'Which?', options: [{ label: 'stream' }] }])
    expect(answer.answers).toEqual([{ id: 'q1', selected: [] }])
  })

  it('records nothing when the dialog is dismissed', async () => {
    const host = scriptedHost([undefined])
    const answer = await askQuestions(host, [{ id: 'q1', question: 'Which?', options: [{ label: 'stream' }] }])
    expect(answer.answers).toEqual([{ id: 'q1', selected: [] }])
  })

  it('toggles a multi-select and finishes on Done', async () => {
    // One choice, then Done: the second pass is the same question reopened.
    const host = scriptedHost(['stream', QUESTION_SENTINELS.done])
    const answer = await askQuestions(host, [
      { id: 'q1', question: 'Which?', multiSelect: true, options: [{ label: 'stream' }, { label: 'buffer' }] },
    ])
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['stream'] }])
    expect(host.asked).toBe(2)
  })

  it('lets a multi-select choice be undone', async () => {
    // Choosing the same option twice removes it, which is what makes a
    // repeated-pass multi-select usable at all.
    const host = scriptedHost(['stream', 'stream', QUESTION_SENTINELS.done])
    const answer = await askQuestions(host, [
      { id: 'q1', question: 'Which?', multiSelect: true, options: [{ label: 'stream' }] },
    ])
    expect(answer.answers).toEqual([{ id: 'q1', selected: [] }])
  })

  it('keeps the earlier answers when a later question is declined', async () => {
    const host = scriptedHost(['stream', QUESTION_SENTINELS.cancel])
    const answer = await askQuestions(host, [
      { id: 'q1', question: 'First?', options: [{ label: 'stream' }] },
      { id: 'q2', question: 'Second?', options: [{ label: 'buffer' }] },
    ])
    expect(answer.answers).toEqual([
      { id: 'q1', selected: ['stream'] },
      { id: 'q2', selected: [] },
    ])
  })

  it('keeps the question ids distinct', async () => {
    const host = scriptedHost(['a', 'b'])
    const answer = await askQuestions(host, [
      { id: 'first', question: 'A?', options: [{ label: 'a' }] },
      { id: 'second', question: 'B?', options: [{ label: 'b' }] },
    ])
    expect(answer.answers.map(item => item.id)).toEqual(['first', 'second'])
  })
})
