/**
 * Golden-log replay: fold recorded event shapes, assert the rendered rows.
 *
 * The fixtures under tests/golden/ are hand-written from event shapes verified
 * against real session logs (see scripts/golden-extract.py for the local tool
 * that diffs a fresh log against them). This is the cheapest integration
 * oracle the project has: no terminal, no profile, no tokens, and it is where
 * three real fold bugs were first pinned — reasoning blocks dropped, object-
 * shaped sources rendered as the user, and tool results never finding their
 * call because the id lives inside the message, not at the top level.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionDocument } from '../src/session/model.ts'
import { foldEvent } from '../src/app/events.ts'
import { buildRows } from '../src/views/transcript.ts'
import { resolvePalette, TURBO_VISION } from '../src/kit/skin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Fold a fixture log and render its rows at a fixed, narrow-enough width. */
function replay(name: string): string[] {
  const document = new SessionDocument()
  const text = readFileSync(join(HERE, 'golden', `${name}.jsonl`), 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    void foldEvent(document, JSON.parse(line))
  }
  return buildRows(
    document.all, 60, resolvePalette(TURBO_VISION),
    { gutterWidth: 2, collapsed: true, showReasoning: true },
  ).map(row => row.text)
}

describe('golden replay: a reasoner turn', () => {
  const rows = replay('reasoner')

  it('shows the question once, injected context as context, and the reasoning', () => {
    expect(rows).toEqual([
      '> You',
      '  你好',
      '',
      '+ Context',
      '  Current DSH file policy: workspace-write. 当前工作区为',
      '  ~/ws。',
      '',
      '| Agent · step 2',
      '  · The user greeted me in Chinese; answer briefly in the',
      '  · same language.',
      '  你好！我是运行在 DSH Harness 里的助手，请问需要做什么？',
    ])
  })
})

describe('golden replay: a tool round trip', () => {
  const rows = replay('tools')

  it('settles the card, because the result cites its call from inside the message', () => {
    expect(rows).toEqual([
      '> You',
      '  看看当前目录',
      '',
      '~ bash  pwd',
      '  ok · 0.1s ▸',
    ])
  })
})
