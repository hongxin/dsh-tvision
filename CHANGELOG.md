# Changelog

## 0.7.0 — 2026-11-02

Three strands asked for together — adapt to the *installed* dsh, bring the
text output closer to the web profile, and support the superagent ecosystem —
plus two fixes that only a real shell could surface.

### Adapted to dsh 0.2.1-rc.5 — and to every 0.2.x at once

- **The pins move to `0.2.1-rc.5`** with zero code change; the API surface the
  desktop touches did not move between rc.2 and rc.5. Verified on the full
  ladder: L0 (795 tests), L2 (mount), L3 (all 23 wire checks).
- **One build passes the plugin gate on every 0.2.x runtime.** A stale shell
  on this machine resolves dsh 0.2.1-rc.2 while a fresh one resolves rc.5, and
  the rc.5 pins made the older runtime's gate refuse the plugin outright. The
  gate reads `engines.dsh` first and, when that field exists, decides alone —
  so `engines.dsh: ">=0.2.1-rc.2 <0.3.0"` passes both runtimes without the
  exact-version exemption this profile once needed.
- **`engines.node` relaxes to `>=22.18`.** The `^22.19` floor was inherited
  from the upstream TUI lineage, not required by us; the demo and the full
  suite run on 22.18.

### Markdown parity with the web transcript

The web renders assistant prose as full GFM; a construct-by-construct survey
against tvision's renderer found the real gaps. Fixed — each pinned by a test
named for what the web does with the same source:

- **Setext headings.** `Sub` + `---` rendered as prose followed by a stray
  horizontal rule; it is an h2 now, as GFM and the web read it.
- **Images** render as a named `[img: alt]` placeholder instead of the
  source's literal bang and destination — the terminal's honest stand-in for a
  picture.
- **Link titles** are dropped; **labels parse their own markdown**
  (`[**bold**](url)` bolds) while the shown URL is never re-parsed as
  emphasis.
- **Reference links** (full and shortcut) resolve against definitions
  collected document-wide; unresolved ones stay literal and self-heal — the
  same streaming deviation the web's incremental renderer documents.
- **Autolinks** drop their angle brackets; **hard breaks** (two spaces or a
  backslash above the break) break.
- Deliberate deviations, both recorded in DESIGN.md §5½: footnotes and raw
  HTML stay literal.
- CJK strong before punctuation already worked — our scanner is deliberately
  looser than CommonMark, which is the same problem the web ships a micromark
  extension for.

### dsh-superagent support

[`dsh-session-superagent`](https://npm.im/dsh-session-superagent) is a
tools-only plugin that wakes a live session with a user-role followup, so no
new seam was needed — but the round trip is now pinned:
`tests/golden/superagent.jsonl` records the documented wake shape (the
【主理鱼】 marker, `watch_start` registration, the idle gap, the wake turn,
`watch_ack` settling the item) and the replay asserts each stage renders.
README (EN+zh) explains how to run one against tvision.

### Fixed — found by running verify:all in a real shell

- **The goodbye printed twice on quit.** `requestExit` calls the mount
  disposer directly, and disposing the root fiber then runs the same disposer
  again; the host's dispose had no guard, so the resume hint was written on
  each pass.
- **verify:wire was silent for five minutes** and looked stuck; it now prints
  `boot 1 of 2` / `boot 2 of 2` up front with the expected silence, and the
  byte counts before the checks.
- **The verification ladder stopped minting sessions in the real `~/.dsh`.**
  Every boot creates a session in the home it uses; the rungs now default to a
  repo-local sandbox home, built on demand with the profile linked to the
  checkout — the same shape `dsh plugin add` of a local path produces.
  `--real-home` boots the real home deliberately.
- **pty-wire passed `--dsh-home` as a launcher flag**, which `dsh` hands to
  the app, whose commander rejected it and exited before drawing — the rung
  reported every check missing when nothing was wrong with the app.

## 0.6.0 — 2026-10-17

Adapted to DeepSeek Harness **0.2.1**. The API surface the desktop touches
survived intact — the jobs seam, the four-argument `execute`, every
waterfall, and the session-event map (which only gained the log-only
`job/registered`/`job/settled` pair) — so this adaptation is mostly the peer
gate plus two pieces of ecosystem cleanup.

### The dsh 0.2.1 adaptation

- **The peer gate.** Every `@deepseek-ai/*` pin moves to `0.2.1-rc.2`, so the
  plugin loads on its own compatibility again (the 0.2.0 pins were denied by
  the runtime's exact-version check).
- **The persona, actually applied.** dsh 0.2.0 renamed the system-prompt row's
  `persona` key to `personaPrefix`; the old key composed into the config tree
  but was silently dropped by the schema, so the desktop's custom persona has
  been absent from every prompt since the 0.2.0 adaptation. The patch now uses
  `personaPrefix` — `{{model}}` still resolves (the agent loop provides it),
  and an unknown variable would fail the turn loudly, which the wire rung
  covers.
- **The invariants companion is gone.** dsh 0.2.1 removed the cross-package
  invariants mechanism entirely (the `dsh-invariants` package and every
  sibling's `invariant.*`): the dependency, the `src/invariant.ts` placeholder,
  and its bundle entry are removed.

## 0.5.0 — 2026-10-06

Adapted to DeepSeek Harness **0.2.0**. The break surface was small and is
now verified: the session-event map, the Messages wire, and the four-argument
`execute` are byte-identical between 0.1.7 and 0.2.0, so the fold, the golden
fixtures, and the mock endpoint are untouched.

### The dsh 0.2.0 adaptation

- **The peer gate.** dsh 0.2.0 checks every `@deepseek-ai/dsh-*` peer of a
  plugin against the running dsh and refuses to load it on mismatch (with
  `dsh plugin allow-version` as the explicit escape hatch). Every pin —
  dependencies, devDependencies, peerDependencies — moves to `0.2.0-rc.2`,
  so the plugin loads on its own compatibility again.
- **The jobs seam.** dsh-jobs 0.2.0 rewrote the registry: `list`/`kill` now
  take the owner's **id** (typed `SessionId` in the API; producers register
  with the owning agent's id) instead of the Agent object, the
  `onJobsChanged` visible-set listener is gone in favour of a per-commit
  `events.subscribe`, and `JobSnapshot` became `JobView` (a structural
  superset of what the roster reads, so rows still pass through unmapped).
  The Jobs window re-lists on the lifecycle commits it renders —
  `registered`, `stopping`, `settled`, `removed` — and skips `output` and
  `progress`, which fire far more often than the roster changes.
- The wire rung's job scenario now also kills the background job from the
  Jobs window, covering the new `kill` caller end to end — and writing it
  exposed two latent bugs: the scenario's menu walk never opened the View
  menu (`right` moves along the bar without opening; a `down` was missing,
  and the old check passed vacuously on the transcript card's text plus the
  Project tree's `▸`), and the scripted job slept five seconds, settling
  long before the roster ever showed it. The job now sleeps past the whole
  script and the checks assert the running row and the killed row by their
  roster detail text.

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
