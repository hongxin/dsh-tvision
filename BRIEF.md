# Review request — tvision

A character-cell window manager for DeepSeek Harness agents: overlapping framed
windows, a Borland menu bar, function keys, mouse dragging, five skins, layered on
an original cell-grid compositor.

You are the third reader. The author has been too close to it for too long and
would rather hear where it is wrong than where it is clever. Two things are being
asked for, and the second one has a warning attached.

1. **Review.** Where is this over-built, under-tested, or quietly wrong?
2. **Simplify.** Remove what is not earning its place — see the guardrails below,
   because this project has already lost a day to a "simplification" that broke a
   renderer invariant.

## Read this first

- [`docs/DESIGN.md`](docs/DESIGN.md) — why the code is arranged as it is, and an
  honest list of what is unfinished.
- [`AGENTS.md`](AGENTS.md) — six invariants that must survive any change.
- `npm run review:brief` — a generated map: every module, its size, its exports,
  any export nothing references, and the test files. **Regenerate it rather than
  trusting numbers in prose.**
- `python3 scripts/pty-profile.py` — boots a real `dsh --profile tvision` under a
  pty and checks that the desktop mounted and drew. Seven checks, exits non-zero
  when one fails. It passes; it is the only evidence that the plugin works end to
  end, and it is worth re-running after any change to `index.ts`.

## What it is, in one paragraph

The compositor is original, because the line-based renderer this was meant to build
on cannot do overlapping windows (no absolute addressing, no cell diff, no cell
read-back, no mouse). The DSH integration is the reuse: the Cordis plugin shape,
the session-event fold, and the waterfall seams for approvals and questions follow
the open-source DSH terminal front end. `kit/` is a general text-mode windowing
library that knows nothing about agents; everything above it is the application.

## Where the risk actually is

`npm run coverage` produces this. The numbers are not the point; the shape is.

| Area | Statements | What that means |
|---|---|---|
| `src/kit`, `src/views`, `src/widgets`, `src/session` | 90–100% | Well covered by unit tests plus a compositor suite that replays frames into a real terminal emulator. |
| `src/app/app.ts` | 87% | The whole desktop is driven through its public surface by tests. |
| **`src/app/events.ts`** | **56%** | **The adapter from DSH session events to the document. Tested only against the author's idea of the event shapes — never against a recorded real one.** |
| **`src/index.ts`, `src/startup.ts`, `src/prompt.ts`** | **0%** | **The entire DSH integration. No *test* executes it. `scripts/pty-profile.py` does mount it against a real agent, so it is not untried — but the mount path is all that has run, and nothing has exercised the event fold, an approval, or a question against real payloads.** |
| `src/demo.ts` | 11% | The standalone demo; exercised only through the pty sweep. |

**The single highest-value thing a reviewer can do is read `src/app/events.ts` and
`src/index.ts` against the real DSH API and say where they are wrong.** Everything
else in this project has been verified against a real terminal; those two have only
been verified to *load and draw*, and they are what make it a DSH product rather
than a terminal toy. Specifically:

- `events.ts` reads event payloads through a structural subset rather than the real
  union, deliberately, so it does not have to be edited when an unrelated event
  gains a field. That is also how it can be confidently wrong. Is the shape right
  for `user/message`, `assistant/chunk`, `tool/result`, `todo/write`,
  `session/title`, and the compaction pair?
- `index.ts` registers `approval/request` and `user-questions/request` as waterfall
  listeners. The harness fails *closed*: with no answerer, every gated tool call is
  denied and the model is told there is no approval channel. If the claim/delegate
  logic is wrong, that failure is silent.
- `commands.execute` is called with four arguments. The runtime reads
  `signal.aborted` before dispatching, so the wrong arity throws.

## Three things the author already knows are wrong

Do not spend review effort finding these; they are recorded in
`docs/DESIGN.md` §6.

- The Jobs window is a shell.
- Sessions list but do not search.
- The Project index is rebuilt on an event, never watched, so a turn sees a
  slightly stale list.

## Guardrails for the simplification pass

The suite is the contract. **585 tests, and they must stay green.**

```sh
npm run typecheck
npm test                                         # must stay at 585 passing
python3 scripts/pty-sweep.py --json .tools/sweep.json   # needs a pty; 18 scenarios
npx vitest run tests/sweep.spec.ts               # invariants over those captures
```

Do **not** weaken or delete a test to make a change pass. If a test looks wrong,
say so in the review and leave it; several of them encode a bug that cost real
time to find, and the comment usually says which.

These are load-bearing and look removable:

- **`Painter` clipping.** Every widget draws through a painter that drops
  out-of-bounds writes. That is the *only* reason overlapping windows cannot
  corrupt each other. A "simpler" direct-to-buffer widget layer reintroduces the
  bug class by construction.
- **`kill()`-style small methods with a single caller.** `kit/styles.ts` patches
  SGR rather than restating it, and the ordering of "attribute off" before
  "attribute on" is not cosmetic: `2;22` sets dim and immediately cancels it.
  Likewise, the colour-space boundary is 16 and not 256, because the Borland cyan
  `0x00AAAA` is 43690 and a 256 boundary read it as palette entry 170 — every
  window frame rendered purple.
- **The transcript's row cache key.** It includes width, document revision,
  options, and the expanded set. Dropping any component makes a resize or a
  toggle render stale rows.
- **`screen.ts`'s diff.** It exists so an idle frame costs zero bytes. Replacing it
  with a full repaint makes the app unusable over SSH and would not fail a test
  unless you also removed `compositor.spec.ts`'s byte assertions.
- **The 40×10 size floor and the chrome-yielding order.** Below the floor the
  manager paints a notice instead of a desktop, because a window manager in 20
  columns is a screen of fragments. The order the chrome yields in is deliberate:
  the status line goes before the key strip, because the strip is the legend for
  every function key.

## What a good review would say

The author's own ranking of what is probably wrong, offered so you can disagree
with it rather than repeat it:

1. **`app.ts` is 1,680 lines** and holds the window registry, the menu, the keymap,
   the composer wiring, the modal plumbing, and the list windows. It is the one
   module with no obvious seam. Is there a split that is not cosmetic?
2. **`events.ts` has one large `switch`** and eight small readers. Is the
   structural-subset approach right, or should it take the real union and let the
   compiler enforce the shapes?
3. **`widgets/statusbar.ts` and `widgets/menubar.ts` are 300 and 570 lines** for two
   bands of chrome. Both carry state machines that might be simpler as data.
4. **Three `Map`s in `TvisionApp`** (`lists`, `listRows`, `sessionCwd`) look like
   they could be one structure.
5. **The `!!js` config expressions in `cordis.patch.yml`** must name every context
   property they read in `inject`, or the profile fails to boot. That is written
   down, but it is a sharp edge a reviewer might see a better shape for.

## Reporting back

A diff plus a note per change saying whether it is a *fix*, a *simplification*, or
a *taste* call. If a change alters behaviour, say which test would have caught a
regression and confirm it did not. If something looks wrong but is out of scope,
write it down instead of changing it.
