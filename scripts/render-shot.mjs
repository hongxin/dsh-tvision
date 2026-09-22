/**
 * Render a captured terminal byte stream as a styled HTML character grid.
 *
 * Standalone tool for producing screenshot fodder: it replays the capture
 * through @xterm/headless (the same emulator the test suite trusts), walks
 * the final screen cell by cell, and emits one <span> per style run. Point
 * a browser at the output and screenshot the `#term` element for a PNG —
 * that is how the four under docs/screenshots/ are made.
 *
 * The full recipe, per skin:
 *
 *   python3 - <<'PY'                     # capture in a real pty, truecolor
 *   import sys; sys.path.insert(0, 'scripts')
 *   from pty_common import run
 *   data = run(['node', 'lib/demo.js', '--skin', 'tvision'], [], 100, 30, 24, 0.4)
 *   open('/tmp/tvision.bin', 'wb').write(data)
 *   PY
 *   node scripts/render-shot.mjs /tmp/tvision.bin 100 30 /tmp/tvision.html
 *
 * Usage: node render-shot.mjs <capture.bin> <columns> <rows> <out.html>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import xterm from '@xterm/headless'

const [capturePath, cols, rows, outPath] = process.argv.slice(2)
if (capturePath === undefined || outPath === undefined) {
  console.error('usage: node render-html.mjs <capture.bin> <columns> <rows> <out.html>')
  process.exit(1)
}

const term = new xterm.Terminal({ cols: Number(cols), rows: Number(rows), allowProposedApi: true })
await new Promise(resolve => term.write(readFileSync(capturePath).toString('utf8'), resolve))

const DEFAULT_FG = '#cfcfcf'
const DEFAULT_BG = '#121212'

const color = (cell, isFg) => {
  if (isFg ? cell.isFgDefault() : cell.isBgDefault()) return isFg ? DEFAULT_FG : DEFAULT_BG
  const value = isFg ? cell.getFgColor() : cell.getBgColor()
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, '0')}`
  // The 16 ANSI colours are the terminal theme's to define; the ones here
  // match the macOS default the captures were taken against.
  const palette16 = [
    '#000000', '#b23434', '#3d9e3d', '#dedb70', '#4360c8', '#b043b0', '#43a9b0', '#bdbdbd',
    '#555555', '#ff6c6c', '#70ff70', '#ffff6c', '#6c9cff', '#ff6cff', '#6cffff', '#ffffff',
  ]
  if (value < 16) return palette16[value]
  // 256-colour cube and greyscale ramp.
  if (value < 232) {
    const i = value - 16
    const step = [0, 95, 135, 175, 215, 255]
    return `#${[Math.floor(i / 36), Math.floor((i % 36) / 6), i % 6].map(n => step[n].toString(16).padStart(2, '0')).join('')}`
  }
  const grey = (value - 232) * 10 + 8
  return `#${grey.toString(16).padStart(2, '0').repeat(3)}`
}

const htmlEsc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const lines = []
for (let y = 0; y < term.rows; y++) {
  const line = term.buffer.active.getLine(y)
  const runs = []
  let text = ''
  let style = null
  const flush = () => {
    if (text !== '' && style !== null) runs.push({ text, style })
    text = ''
  }
  for (let x = 0; x < term.cols; x++) {
    const cell = line?.getCell(x)
    const chars = cell === undefined || cell.getChars() === '' ? ' ' : cell.getChars()
    let fg = color(cell, true)
    let bg = color(cell, false)
    if (cell?.isInverse() !== 0 && cell !== undefined) [fg, bg] = [bg, fg]
    const next = {
      fg, bg,
      bold: cell !== undefined && cell.isBold() !== 0,
      italic: cell !== undefined && cell.isItalic() !== 0,
      underline: cell !== undefined && cell.isUnderline() !== 0,
      strike: cell !== undefined && cell.isStrikethrough() !== 0,
      dim: cell !== undefined && cell.isDim() !== 0,
    }
    if (style !== null && JSON.stringify(style) === JSON.stringify(next)) {
      text += chars
      continue
    }
    flush()
    style = next
    text = chars
  }
  flush()
  const spans = runs.map(run => {
    const css = `color:${run.style.fg};background:${run.style.bg}`
      + (run.style.bold ? ';font-weight:bold' : '')
      + (run.style.italic ? ';font-style:italic' : '')
      + (run.style.underline ? ';text-decoration:underline' : '')
      + (run.style.strike ? ';text-decoration:line-through' : '')
      + (run.style.dim ? ';opacity:.55' : '')
    return `<span style="${css}">${htmlEsc(run.text)}</span>`
  }).join('')
  lines.push(spans)
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; background:#0a0a0c; }
  .frame { display:inline-block; padding:18px 22px; background:#0a0a0c;
           border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,.55); }
  .titlebar { display:flex; gap:8px; padding:0 4px 12px 2px; }
  .dot { width:12px; height:12px; border-radius:50%; }
  pre { margin:0; font:15px/1.32 Menlo,'SF Mono','Cascadia Mono',monospace;
        letter-spacing:0; white-space:pre; }
</style></head><body><div class="frame" id="term">
  <div class="titlebar"><div class="dot" style="background:#ff5f57"></div>
  <div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div></div>
<pre id="screen">${lines.join('\n')}</pre>
</div></body></html>`
writeFileSync(outPath, html)
console.log(`wrote ${outPath}: ${term.rows} rows`)
