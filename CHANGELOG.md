# Changelog

## 0.4.0 — 2026-09-29

Adapted to DeepSeek Harness **0.1.7**, which changed the wire under the
desktop twice over — and the desktop now tells you when it is out of date.

### The dsh 0.1.7 adaptation

- The DeepSeek adapter moved from OpenAI-style `/chat/completions` to the
  **DeepSeek Messages API** (`/v1/messages`, Anthropic-style SSE with
  `content_block` events). The mock endpoint — the wire rung's scripted
  model — speaks the new protocol frame for frame, verified against the
  adapter's own translator. Turn matching now scans user messages
  end-first: the Messages protocol rides tool results, mode notices, and
  injections in user messages, so "the last user message" stopped being
  one thing.
- The `bash` tool gained a required `description` argument (the scripted
  calls carry one), `agent/created` became a waterfall, and the session
  log format bumped to v4 — none of which moved a golden fixture, so the
  fold's shapes are unchanged.
- Every `@deepseek-ai/*` pin moves to `0.1.7-rc.2`, and the new
  transitive peer lands in the closure.

### Update awareness

- The desktop checks GitHub once a day at boot — a status cell
  (`↑0.4.0`) and a one-per-version notice appear when a newer release is
  out. `/update` confirms, hands the terminal to the update command (a
  git checkout is pulled and rebuilt in place; a registry install goes
  through `dsh plugin up`), and restarts into the same session. A failed
  update restarts the current version — a dirty exit never leaves a dead
  screen.

### The workspace as a tree

- The Project window shows the index as a **folded tree**: directories
  first with ▸/▾ markers, files after them, two spaces of indent per
  depth, collated case-insensitively. Enter opens a directory or
  references a file into the composer; a mid-session refresh keeps the
  user's own folds, and a fresh index opens exactly the root level.

### Small

- The About window names its author.

## 0.3.0 — 2026-09-27

The interactive seams close: every way the harness asks a human
something — or a human asks the harness — now has a first-class
character-cell surface.

### Subagents, visible

- **A delegated child is a window, not a buried tool card.** The parent
  session's `subagent/catalog` events fold into a registry; the child's
  own session rides the same event firehose into its own document; live
  start/end events flip running markers. The Subagents window lists the
  catalog, and Enter opens the child's transcript — the parent's
  conversation and the child's in overlapping framed windows at once,
  which is the thing a line renderer cannot do. A child that ran before
  this boot loads lazily through the same primitive resume reads.
- **Escape dismisses a raised panel** — the Borland reflex, asked-for by
  name (`dismissable`), never the desktop itself, and never past a
  composer holding a draft.

### Plan mode, end to end

- **The review dialog renders the plan as the markdown it is** —
  heading ladder, lists, quote bars — instead of a flattened `# heading`
  on screen.
- **Questions take free-text answers**: every question offers `Other…`,
  and the typed text rides the contract's `custom` field back — which is
  what "keep planning, and here is why" was missing.
- **Plan mode is visible and memorable**: the prompt reads `dsh plan>`
  across turns, and the Plan window keeps the latest presented plan
  readable long after the dialog that judged it closed.

### Skills and cross-session references

- **The workspace's skill catalog is browsable and callable**: a Skills
  window (user-only entries marked), `/`-completion over the catalog,
  and a `/name` line that loads the body and injects the canonical
  skill-invocation message — the official semantics, which no
  in-process host was providing.
- **`@`-mentions reference other sessions**: the bundle patch composes
  `dsh-session-reference`, the `@`-completion offers candidates labelled
  by their titles, and the inserted canonical mention makes the harness
  attach a bounded read-only snapshot. The transcript folds it in as
  `Recall`-labelled context, never in the user's voice.

### Under the hood

- The wire rung tells the whole story now — twelve scripted turns
  through the real harness, 22 checks, including delegation, plan
  review with typed feedback, the Skills window, and a resume boot that
  must show its history on screen.
- The startup grammar, the mutation reader, and the diff metadata
  branches gain unit pins; BRIEF's risk table says what is true today.

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
