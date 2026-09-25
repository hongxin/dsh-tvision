# Changelog

## 0.2.0 — 2026-09-25

The transcript stops being a printout and starts being a terminal worth
reading, and the desktop claims two of the harness's decision seams.

### Markdown that carries meaning

- **GFM tables render aligned** — columns measured to their widest cell,
  alignment read off the delimiter row, a dim `│` between columns — and
  stack as `header: value` cards when the measure cannot hold them
  (`1aa1703`).
- **Inline code wears the palette's code colour** instead of an inverse
  bar (`d685968`); the `marked` dependency is gone — the renderer is
  hand-written and streaming-safe (`b0fb0ba`).
- **Headings render as a colour ladder** on a new `heading` palette
  role: `##` underlines as a section, `###` stands plain, deeper levels
  dim — the literal `###` never reaches the screen (`b2c541a`).
- **Bare BMP emoji cost one column, not two** — the Unicode-9
  reclassification meets real terminals, and a `☔` column no longer
  shears its table (`8751af5`).

### Breakpoints

- `/breakpoint bash(rm *)`, Ctrl+B, a Breakpoints window, and a
  hold/run/deny dialog: the desktop claims `tools/pre-execute` so a
  matching tool call stops before it runs (`7e74529`, `5523d74`,
  `9e67748`).

### The harness contract, honoured further

- **The status bar reads the token-meter projection** — the same replay
  compaction reads — gaining the cache column (⇄) and the
  provider-reported context pressure (`02cff8e`).
- **`/attach` carries files to the model as durable attachments** —
  content-addressed, byte-exact, riding exactly one message; the model
  receives the file, not a path it has to be trusted to open
  (`b233bed`).
- **A resumed session boots with its history on screen** — constructor
  seeds never ride the session/event firehose, so mount folds them
  through the same path live events take (`75369d4`).
- **`/quit` leaves through the same door Ctrl+Q uses** (`131fe2f`).

### Under the hood

- The recording pipeline (the README gif and the five skin stills) no
  longer tears frames, splits CJK glyphs across chunk boundaries, or
  loses 1px borders to pre-scaling (`d870d14`, `0eeb8e5`).
- A four-angle review (reuse, simplification, efficiency, altitude)
  consolidated the local-command registry into one table, narrowed the
  projection snapshot to the two units it consumes, and switched
  `/attach` to the store's byte-level commit (`131fe2f`).

## 0.1.0 — 2026-09-16

First public release: the character-cell window manager itself — an
original cell-grid compositor with overlapping framed windows, a Borland
menu bar, function keys, mouse dragging, five skins, and a transcript
that folds the harness's session events as they stream.
