/**
 * Replay a pty capture through a terminal emulator and print the screen.
 *
 * The other half of `pty-drive.py`: that script produces bytes from a real
 * terminal, this one reads them back as a grid so a human (or a diff) can see
 * what was actually on screen.
 *
 * Frames are replayed whole rather than in chunks, and the last one is dropped:
 * the capture is cut off mid-frame when the child is killed, and half a
 * synchronized-output frame leaves the grid showing the previous state for the
 * rows that had not been rewritten yet — which reads as a rendering bug that is
 * not there.
 *
 * Usage:
 *   node --experimental-strip-types scripts/replay-capture.ts capture.bin [columns] [rows]
 */

import { readFileSync } from 'node:fs'
import { HeadlessTerminal } from '../tests/headless-terminal.ts'

/** The escape that ends a synchronized-output frame. */
const FRAME_END = '\u001B[?2026l'

/**
 * Read a capture back as a screen.
 * @param path - The capture file.
 * @param columns - Screen width.
 * @param rows - Screen height.
 * @returns The screen as text, plus the frame count.
 */
export async function replay(
  path: string,
  columns: number,
  rows: number,
): Promise<{ screen: string; frames: number }> {
  const raw = readFileSync(path).toString('utf8')
  const frames = raw.split(FRAME_END).map(part => part.split('\u001B[?2026h').pop() ?? '')
  const terminal = new HeadlessTerminal(columns, rows)
  for (let index = 0; index < frames.length - 1; index++) {
    await terminal.writeAndSettle(frames[index] ?? '')
  }
  const view = terminal.snapshot()
  terminal.dispose()
  return {
    screen: view.rawRows.map(row => row.replace(/\s+$/u, '')).join('\n').replace(/\n+$/u, ''),
    frames: frames.length - 1,
  }
}

/* Run when executed directly. */
if (process.argv[1] !== undefined && /replay-capture\.(ts|js)$/u.test(process.argv[1])) {
  const path = process.argv[2]
  if (path === undefined) {
    process.stderr.write('usage: replay-capture.ts <capture.bin> [columns] [rows]\n')
    process.exit(2)
  }
  const result = await replay(path, Number(process.argv[3] ?? 104), Number(process.argv[4] ?? 30))
  process.stdout.write(`${result.screen}\n\n[${result.frames} frames]\n`)
}
