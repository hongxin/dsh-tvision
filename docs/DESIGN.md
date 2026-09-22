# tvision — design

A character-cell window manager for DeepSeek Harness agents: overlapping framed
windows on a textured desktop, a Borland menu bar, a function-key strip, mouse
dragging, and five skins. It runs in a terminal, it is an ordinary DSH profile
bundle rather than a fork, and it is drawn cell by cell into an off-screen grid
and diffed to the screen.

This document records *why* it is shaped the way it is — which parts are borrowed
from which tradition, what the interface is trying to be, and how the code is
arranged. For install instructions and the key list, see [README.md](README.md).

---

## 1. The synthesis

Four traditions were named in the brief, and they contribute different things. It
is worth being precise about which, because "retro TUI" is a mood while these are
mechanisms.

### Turbo C / Borland C++ / Turbo Vision — the window system

What is actually worth taking from Borland is not the blue. It is that a
character grid can carry a *window manager*:

| Mechanism | Why it matters here |
|---|---|
| Overlapping windows with drop shadows | Depth is legible without animation. A shadow tells you which window is in front before you read a word. |
| A menu bar above all windows | Every capability is discoverable in one place, in an order a person would look for it. Nothing is keyboard-only folklore. |
| A function-key strip | The ten most common actions are permanently visible *and* directly invocable. The legend is also the keymap. |
| Modal dialogs that lock the desktop | A question that requires an answer should stop the world, not float politely. |
| Mouse dragging and resizing | Needed for the window system to feel real rather than painted on. |
| A `[■]` system box, a `[↑]` zoom box, a brightened corner grip | The affordances are *drawn*, so nothing has to be learned from a manual. |
| A status line below the desktop | Persistent state — model, tokens, pressure — without stealing transcript rows. |

The active frame is double-line and the inactive ones are single-line. That one
decision does more for legibility than any colour choice: you can see where the
keyboard is going from across the room.

### Norton Commander / Midnight Commander — the layout grammar

mc contributes two ideas:

- **The two-panel desktop.** Work on the left, context on the right: the
  conversation in one window and the project, the task list, and the sessions in
  a narrower column beside it. Neither pane is modal; both are always there.
- **The fixed single-line command line.** A one-line input that never changes
  height. A composer that grows as you type pushes the transcript around and
  makes the whole desktop feel unstable; a fixed line keeps it still. Multi-line
  input is still available through pasting and `Alt+Enter`, so nothing is lost
  but the layout churn.

### moc — the navigation feel

moc is the reference for how a keyboard interface should *browse* rather than
merely accept input:

- **Function keys as the primary control surface**, with the strip as the legend.
- **A tree on the left, detail on the right** — the same two-panel grammar, and
  the reason the Project window exists at all.
- **A status line that explains what is selected**, which is why the menu carries
  a one-line hint per item and why the strip's items can describe themselves.

### DSH — the agent harness

The substrate supplies the parts a front end should never reimplement: the
agent loop, the durable session log, the tool registry, approvals, skills,
subagents, workflows, compaction, and sandboxing. tvision composes over
`@deepseek-ai/dsh-base` the way the web surface does, so the entire plugin
ecosystem is the same one — nothing is forked.

The interesting consequence is that an agent turns out to be an *excellent* fit
for a text-mode IDE. A coding agent's activity is already a stream of file
edits, shell commands, diffs, task lists, and subagent spawns. Borland built
this interface for a compiler and a debugger; an agent is both.

---

## 2. What the product is

**Everything is a window, and the agent is one of them.**

```
  File  View  Agent  Tools  Window  Help                        dsh tvision
╔═════════════════════════ Conversation ═════════════════════════╗┌───── Project ──────┐
║> You                                                            ║  o src/parser.ts   │
║  why is the first token so slow?                                ║  o src/stream.ts   │
║                                                                 ║  o README.md       │
║| Agent · 1.4s                                                   ║                    │
║  The parser buffers the whole document before it emits          ║                    │
║  anything, which is why the first token never arrives until     ║                    │
║  the whole file is read.                                        ║                    │
║                                                                 ║                    │
║~ bash  npm test -- parser                                       ║┌────── Tasks ───────┐
║  ok ▸                                                           ║  ✓ Find why it is  │
║                                                                 ║  ▸ Make the parser │
║─────────────────────────────────────────────────────────────────║  · Update the test │
║dsh> refactor it so it streams                                   ║                    │
╚═════════════════════════════════════════════════════════════════╝  ░░░░░░░░░░░░░░░░░░░
             │ F10 menu │ 3 win │ ████░░ 62% │ ↑12.4k ↓3.1k │ deepseek-flash
F1 Help      F2 New       F3 Open      F4 Tools     F5 Focus     F6 Next      F7 Project
```

### The windows

| Window | Key | What it is |
|---|---|---|
| **Conversation** | — | The transcript, with the composer on its last line. Always open. |
| **Project** | `F7` | Files in the workspace, ranked; choosing one references it. |
| **Tasks** | `F8` | The agent's own todo list, live. |
| **Sessions** | `F3` | Resumable sessions, newest first; Enter hands the process over. |
| **Jobs** | — | Background jobs the agent started. |
| **Help** | `F1` | The key list, plus the mouse reference. |
| **About** | — | Identity, session, cwd, skin. |

### The transcript's grammar

A dense transcript is unreadable unless its shape is visible before its words
are, so every entry has a one-character gutter:

| Gutter | Meaning |
|---|---|
| `>` | Your turn |
| `\|` | The agent's turn, with a step number and a duration |
| `·` | The agent's reasoning, dimmed and hideable with `Ctrl+R` |
| `~` | A tool call, with its state, duration, and arguments |
| `+` | Injected context, not typed by you |
| `!` | An error |
| `-` | A notice |

A tool card is one line collapsed — `~ bash  npm test -- parser` — and a framed
body expanded: `┌ args ┐`, `┌ diff ┐`, `┌ output ┐`. The diff is the reason the
expanded form exists: a file edit is the one tool result that is genuinely
unreadable as prose, so it is the one that gets colour-coded add/remove lines.

### Navigation, three ways

Every action is reachable three ways, and all three are first-class:

1. **Function keys** — `F1`–`F10`, always visible in the strip.
2. **Menus** — `F10` then arrows, or `Alt`+the underlined letter. While a menu is
   open, `←`/`→` browse the whole bar without closing the list.
3. **Mouse** — click a title to raise, drag it to move, drag the brightened
   bottom-right corner to resize, click `[■]` to close, click `[↑]` or
   double-click the title to zoom, and
   wheel-scroll whatever the pointer is over.

### The skins

Five, and they are not palette swaps: each is a complete set of ~55 semantic
roles, so a skin that renders one widget legibly renders them all.

| id | Name | Intent |
|---|---|---|
| `tvision` | Turbo Vision | The Borland blue: cyan frames on a dark blue desktop. |
| `phosphor` | Phosphor | P1 green CRT — one hue, brightness carries the hierarchy. |
| `amber` | Amber | P3 amber — warmer, easier for long sessions. |
| `slate` | Slate | Modern dark. The window manager without the costume. |
| `ansi` | ANSI | The WordPerfect dark green, in your terminal's own sixteen colours. |

---

## 3. Architecture

The rule that shapes everything: **the compositor is ours, and nothing above it
knows about terminals.**

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ app/          the desktop: windows, menus, keys, host interface     │
  │   app.ts  composer.ts  questions.ts  events.ts                      │
  │   project.ts  sessions.ts                                           │
  ├─────────────────────────────────────────────────────────────────────┤
  │ views/        agent-shaped widgets                                  │
  │   transcript.ts   dialogs.ts                                        │
  ├─────────────────────────────────────────────────────────────────────┤
  │ session/      the retained document                                 │
  │   model.ts                                                          │
  ├─────────────────────────────────────────────────────────────────────┤
  │ widgets/      reusable chrome                                       │
  │   frame.ts  menubar.ts  statusbar.ts                                │
  ├─────────────────────────────────────────────────────────────────────┤
  │ kit/          the character-cell substrate                          │
  │   cell.ts  text.ts  styles.ts  screen.ts  painter.ts  widget.ts     │
  │   wm.ts    input.ts  skin.ts                                        │
  └─────────────────────────────────────────────────────────────────────┘
```

### `kit/` — the substrate

Nothing in `kit/` imports anything above it, and none of it knows what an agent
is. It would work as a general text-mode windowing library.

- **`cell.ts`** — the colour model, a style record, and `CellBuffer`, a grid of
  cells. A double-width glyph occupies two cells: the lead carries the character
  and is flagged, the trailer carries an empty string. Joining a row's characters
  therefore reproduces the original text exactly, which is what makes the whole
  thing testable as strings.
- **`text.ts`** — the single authority on how wide a string is. `Intl.Segmenter`
  splits grapheme clusters, `get-east-asian-width` decides columns, and a wide
  glyph is never split at a boundary. Ambiguous-width characters are held at one
  column, matching xterm and iTerm2 in a non-CJK locale.
- **`styles.ts`** — style-to-SGR translation and, more importantly, style
  *patching*: the two or three parameters needed to turn one style into another.
  Two subtleties live here and both bit during development: SGR parameters apply
  left to right, so every "attribute off" must precede every "attribute on" (or
  `2;22` sets dim and immediately cancels it); and bold and dim share the reset
  code 22, so the off-direction cannot be looked up by parameter value.
- **`screen.ts`** — the renderer. Whole-frame diff against the previous frame,
  emitted inside a synchronized-output bracket. Per changed row, one cursor move
  to the first changed column and then the row to its last changed column;
  because the write is left-to-right and overwrites in place, insertions and
  deletions need no special case. Truecolour is downgraded to the 256-colour
  palette when the terminal cannot take it.
- **`painter.ts`** — a clipped view onto a buffer. Widgets draw through one, so a
  widget that overflows its frame *cannot* corrupt a neighbour: the painter drops
  the write. This is the property that makes overlapping windows safe by
  construction rather than by convention.
- **`widget.ts`** — the widget contract: `draw`, and optional `onKey`/`onMouse`.
  Deliberately four members. Everything else a widget knows is its own business.
- **`wm.ts`** — the window manager. An ordered list of windows, the last on top;
  hit-testing in reverse order; drag, resize, zoom, tile, cascade; modal lock;
  and the frame composite.
- **`input.ts`** — the byte decoder. A terminal multiplexes five grammars onto
  one stream, and the promise here is that one `push` yields whole events, never
  half of one — a CSI sequence split across two reads is buffered, not
  mis-decoded.
- **`skin.ts`** — the skins, as tables of ~55 semantic roles.

### `session/model.ts` — the retained document

This is the part the upstream TUI does not have, and the reason its render layer
could not be reused.

Upstream, the transcript **is** the widget tree: rows are appended and spliced
into a container by index as events arrive. That works for an append-only log,
but it makes the transcript un-repaintable — a window that scrolls, resizes, or
is uncovered needs to re-render from *state*, not from a mutation history.

So the fold here produces `Entry` records, in order, and the view turns entries
into rows whenever it needs to. Entries are append-only within a turn and
replaced wholesale by compaction, which is exactly the semantics the session log
itself has. `revision` is a counter the view compares against to decide whether
its cached rows are stale.

### `views/transcript.ts` — entries into rows

Rows are cached against `(width, revision, options)`. A streaming response
changes the document on every token so the cache is rebuilt then; a repaint
caused by a cursor blink, a clock tick, or a window being uncovered costs one
comparison.

`stickToBottom` is the behaviour every chat interface needs and many get wrong:
new output follows the end until the reader scrolls away, and then it *stops*.
The transcript takes only the keys it can act on — at the top, `Up` is passed
through so the composer's history can use it.

### `app/app.ts` — the application

Owns the frame loop, the input decoder, the keymap, and the window registry.
Everything it needs from the agent goes through `AppHost`, a small interface:

```ts
interface AppHost {
  send(text: string): void
  runCommand?(line: string): Promise<{ text?: string; kind: 'success' | 'error' } | undefined>
  cancel?(): void
  commands?(): readonly { name: string; description: string }[]
  files?(prefix: string): readonly string[]
  modelLabel?(): string | undefined
  contextWindow?(): number
  quit(): void
}
```

That is what lets the whole desktop be driven in a test by a fake host, and what
confines the DSH-specific code to one file.

### `src/index.ts` — the harness bridge

Three seams, each of which fails *silently* if done wrong, so each is called out
in the code:

- **Conversation** is one `session/event` subscription folded into the document.
- **Approvals and questions** are Cordis *waterfall* events, not services you
  register with. A front end claims one by returning an answer and delegates by
  calling `next()`. With no answerer the harness fails closed to `unavailable`
  and every gated tool call is denied with a message about a missing approval
  channel — which is the state the upstream TUI ships in, and which this fixes.
- **Commands** are `execute(agent, line, attachments, signal)` — four arguments.
  The runtime reads `signal.aborted` before dispatching, so passing the signal in
  the attachments slot throws.

---

## 4. Testing

505 tests, and the split is deliberate rather than incidental.

| Suite | What it pins |
|---|---|
| `text.spec.ts` | Column measurement: wide glyphs, grapheme clusters, boundary cuts. |
| `cell.spec.ts` | The grid, style encoding, and the renderer's diffing. |
| `compositor.spec.ts` | **Round-trip against a real terminal emulator** — paint a buffer, replay the bytes into xterm.js, compare the grid cell for cell. |
| `wm.spec.ts` | Z-order, drag, resize, zoom, tile, cascade, modal lock, hit testing. |
| `input.spec.ts` | Every sequence, and every sequence delivered one byte at a time. |
| `chrome.spec.ts` | The menu state machine and the function-key strip. |
| `transcript.spec.ts` | The document fold and the row builder. |
| `project.spec.ts` | The file index: exclusions, the entry budget, ranking, a symlink loop. |
| `sessions.spec.ts` | The session list fold: label fallbacks, resumability, stable ordering. |
| `terminal.spec.ts` | Raw mode, the alternate screen, and restoring both on every exit path. |
| `app.spec.ts` | The whole desktop: feed bytes in, assert on the frame. |
| `app-windows.spec.ts` | The windows the host fills in, including every failure path. |
| `integration.spec.ts` | Streaming, resize mid-stream, and a burst of mixed input. |
| `dialogs.spec.ts` | Approval and question dialogs — mostly their *exits*, since a promise that never settles wedges an agent turn. |
| `small-terminal.spec.ts` | The size floor, the order the chrome yields rows in, and that no row is ever the wrong width. |
| `sweep.spec.ts` | Invariants over a real-terminal sweep: no write past the edge, no scroll, chrome in place. |
| `snapshot.spec.ts` | Checked-in frames of the whole interface, as ASCII. |

There is also a suite the test runner cannot contain. `scripts/pty-drive.py`
drives the demo under a real pty with real keystrokes and a real mouse report, and
`scripts/replay-capture.ts` reads the resulting screen back. That is what verifies
the parts an emulator cannot: that a real terminal agrees about the palette, that
a drag moves the window by the pointer's delta, and that the alternate screen and
the mouse modes are restored on the way out.

The round-trip suite is the one that justifies owning a compositor. Asserting on
escape strings only proves the escapes are what we expected to write; replaying
them into an emulator and reading the cells back proves the property that
actually matters. It caught two bugs nothing else would have: wide glyphs whose
trailer cell was never marked (invisible on screen, but every row's text then
carried a stray space), and the SGR ordering bug above.

The snapshot frames are plain ASCII, so a reader can see the entire interface in
a diff. That is a real advantage of a character-cell UI over an image snapshot,
and it is why they are checked in rather than generated on demand.

---

## 5. Decisions worth recording

**Why not reuse the upstream TUI's renderer.** It was evaluated, in detail. Its
`TUI` is a bottom-anchored, append-oriented *document* renderer with a line-splice
overlay facility: no absolute row addressing, no cell-level diff, no way to read
a cell back, no mouse support, no alternate screen. A window manager needs a
fixed-size absolutely-addressed grid with a cell-level diff. Different
architectures — and the compositor is the *easy* part to write, while input
decoding and text measurement are the expensive parts.

So the compositor is ours and the *integration* is the reuse: the Cordis plugin
shape, the session-event fold's responsibilities, the waterfall seams, and the
approach to the test harness all follow the upstream implementation, and the
harness's hazards (the two arity/API drifts documented above) were found by
reading it.

**Why one line for the composer.** Every chat interface grows its input box, and
every one of them shoves the conversation upward as you type. A fixed line keeps
the desktop still, and a terminal is the one place where that is a real cost.

**Why the function-key strip is generated from the keymap.** A hand-written strip
drifts out of step with the keys that work, and an application whose hints lie
feels broken in a way that is hard to diagnose. The strip is built from the same
list the keys are dispatched from.

**Why the shadow is drawn after the frame.** A drop shadow's band starts one
column outside its window's right border, so drawing it first let the border's own
bottom-right corner erase the band's first cell. It renders as a *black* shadow,
which on a dark desktop reads as a cut-out rather than a glow — the same trick
the era used.

**Why the dialogs are windows.** An approval prompt that is a window gets a title
bar, a frame, a shadow, and modal lock from the same code as everything else, so
Tab, the arrows, a letter, and the mouse all work through one path. It also makes
the prompt feel like part of the application rather than something painted over
it.

**Why the terminal modes have one owner.** Both the app and the terminal object
wrote the `enter`/`leave` sequences, and both had a `stop()`, so every mode was
enabled and disabled twice. No terminal cares about that — the second sequence is
idempotent — but it is the signature of two writers taking turns on one alternate
screen, which is exactly how a terminal ends up in a mode nobody turns off. The app
owns them now, because the app's renderer is also what decides whether the hardware
cursor should be visible; the terminal owns only raw mode and the byte stream.

**Why there is a terminal size floor.** The first version had none, and at 24×8
it drew a menu bar reading `File View Agent Too`, a window frame with no
transcript in it, and a status line overlapping the frame. The arithmetic was not
wrong so much as unguarded: the desktop height was clamped at one row, the
composer asked for a share of the screen no matter how small it got, and every
widget's minimum-size assumption was violated at once. A window manager in 20
columns is not a smaller window manager; it is a screen of overlapping fragments.

So the layout now has three regimes rather than one. Below the floor the manager
paints a notice and nothing else. Between the floor and an ordinary terminal the
chrome yields in a fixed order — the status line first, because it is a meter,
then the composer's popup row — while the menu bar and the key strip always stay,
because those are controls and a legend. Above that, the intended layout.

The strictness is in the tests: `small-terminal.spec.ts` asserts that every row is
*exactly* the screen width at sizes from 12×6 to 80×4. A row one cell short leaves
stale characters behind it, and one cell long wraps and shifts the whole screen —
which is the same failure the sweep's `write-past-right-edge` check looks for in a
real terminal.

**Why the sweep exists, and what it caught.** The unit suites drive the app through
a fake terminal that never complains, and the compositor suite replays frames into
an emulator that renders whatever it is told. Neither can tell you that the thing
on a real screen is wrong. A pty can, so `scripts/pty-sweep.py` runs eighteen size
and key-sequence scenarios and `tests/sweep.spec.ts` checks the invariants a
terminal enforces silently: nothing written past the right edge, nothing written
below the screen, no scrollback, and the chrome still in place.

Two of the three real bugs above were found by it and by nothing else. It also cost
an afternoon to a harness bug worth recording: a pty left in its default line
discipline turns Ctrl+C into a SIGINT that kills the child before it takes raw
mode, and swallows Ctrl+Q as XON — so the app looked like it hung on quit, and the
`cancel` scenario captured nothing but the `^C` the terminal echoed back.

**Why a colour had two meanings.** `Color` was `number | undefined`, where a
number below `0x100` was a palette index and one at or above it a 24-bit value.
Every skin but `ansi` names its colours as hex, and the Borland cyan is
`0x00AAAA` — 43690, comfortably below `0x100`… except `0x100` is 256, and 43690 is
not. The check was `>= 0x100`, so 43690 was read as palette entry 170 and every
window frame rendered purple. The fix is a boundary at 16 rather than 256,
because the skins only ever use indices `0`–`15`: those are the sixteen a
terminal's own theme remaps, which is the entire point of the `ansi` skin, and
everything above is an explicit 24-bit colour.

The lesson is about the test, not the constant. The emulator suite passed
throughout: it replayed the escapes faithfully and read back exactly the purple
the bytes described. A renderer test can only prove self-consistency — that the
grid matches the buffer — and it cannot tell you the buffer picked the wrong
colour. What found this was running the thing in a real terminal and *looking at
it*, which is also what confirmed the mouse drag, the dropdown, and the
alternating-screen teardown. Hence `scripts/pty-drive.py`: a real pty, real
keystrokes, a real mouse report, and the screen read back by replay so the result
can be diffed rather than squinted at.

**Why the loader rejected the first patch.** The initial `cordis.patch.yml`
re-inserted `storage`, `session-reference`, and `tool-ask-user` — all of which
`dsh-base` already mounts — and the loader rejects a duplicate id outright, so the
whole profile failed to boot. The patch now inserts only rows base does not
provide, and says so, because the next person to add a row will make the same
assumption.

---

## 6. What is not finished

Honest scope, so the gaps are not mistaken for decisions.

Honest scope, so the gaps are not mistaken for decisions. The three that
opened this list — the Jobs shell, Sessions without search, skin that forgot
itself on exit — shipped; what remains:

- **No login flow.** The desktop mounts and draws without a key; a real turn
  needs `DEEPSEEK_API_KEY` or a configured endpoint.
- **The Project index is refreshed, never watched.** It refreshes on mount and
  after a tool that could have written a file, coalesced by a 1.5 s timer (and
  a symlink loop no longer poisons it). A long-running turn therefore sees a
  slightly stale list, and an edit made by another program is not noticed at
  all.
- **No plugin-facing overlay API.** The upstream TUI exposes one; this does not
  yet, so a third-party plugin cannot open a window.

The live turn, for the record, is no longer in the "not verified" column: the
profile has since been driven end to end against the real API from a real
terminal, and the whole stack — boot, streaming, tools, approvals, teardown —
is exercised without spend by the mock-wire rung of the verification ladder
(`npm run verify:wire`, see CLAUDE.md).
