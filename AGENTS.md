# Working on tvision

A character-cell window manager for DSH agents. Read [docs/DESIGN.md](docs/DESIGN.md)
first; it records why the code is arranged the way it is.

## The rules that matter

1. **`src/kit/` imports nothing above it.** It is the character-cell substrate and
   knows nothing about agents, DSH, or this application. If a change in `kit/`
   needs to know what a "session" is, it is in the wrong layer.
2. **Widgets draw through a `Painter`, never into a buffer.** The painter clips,
   which is the only reason overlapping windows are safe.
3. **Never call `String.length` on display text.** Use `textWidth` from
   `kit/text.ts`. A width wrong by one shifts every later cell on the row.
4. **A row must never exceed its window's width.** The renderer repaints by row;
   an over-wide row corrupts the terminal's grid, not just the frame.
5. **Every promise the app hands the harness must settle.** See
   `app/questions.ts`: a dialog that never resolves wedges an agent turn.
6. **`cordis.patch.yml` may only insert rows `dsh-base` does not already mount.**
   The loader rejects a duplicate id and the whole profile fails to boot. Check
   with `dsh --profile tvision --dump-default-config`.

## Verifying

```sh
npm run typecheck
npm test
Tvision_SNAPSHOT=refresh npx vitest run tests/snapshot.spec.ts   # after a visual change
```

For anything that touches the renderer, the palette, or input routing, also check
a real terminal — the emulator cannot tell you a colour came out wrong:

```sh
python3 scripts/pty-sweep.py --json .tools/sweep.json   # 18 sizes and key sequences
npx vitest run tests/sweep.spec.ts                      # invariants over the captures
python3 scripts/pty-drive.py '{"argv":["node","lib/demo.js"],"columns":104,"rows":30,"timeout":8}' > /tmp/cap.bin
npm run verify:pty -- /tmp/cap.bin 104 30               # read one capture back
```

Three real bugs came from this and nothing else:

- The Borland cyan `0x00AAAA` is 43690, which a 256-boundary truecolour check read
  as palette entry 170, so every window frame rendered purple. The emulator
  replayed the escapes faithfully and showed exactly the purple the bytes
  described; a renderer test can only prove the grid matches the buffer.
- At 24x8 the desktop drew a menu bar reading `File View Agent Too`, a frame with
  no transcript in it, and a status line over the frame. Layouts have regimes, and
  a window manager in 20 columns is not a smaller window manager.
- Every terminal mode was restored **twice**, because the app and the terminal
  each wrote the teardown. Harmless to the terminal, but the signature of two
  writers on one alternate screen.

The pty harness itself has two traps, both of which cost an afternoon: put the pty
in a mode the app expects (no `ISIG`, no `IXON`, no `ECHO`) *before* the first key,
or Ctrl+C becomes a SIGINT that kills the app and Ctrl+Q is swallowed as XON; and
size the pty before the child can read its dimensions, or it paints a frame for the
wrong screen.

The compositor round-trip suite (`tests/compositor.spec.ts`) replays frames into
a real terminal emulator and compares the grid cell for cell. It is the only
suite that catches a bug which is invisible in the escape strings, so do not
weaken it to make a change pass.

Snapshots are ASCII on purpose: a reviewer should be able to read the whole
interface in a diff.

## Style

- Comments explain *why*, including the failure the code prevents. Anything
  already obvious from the code should not be commented.
- Every exported symbol has a JSDoc block with `@param`/`@returns`.
- No `any`, no non-null assertions, no constructor parameter properties (the
  project compiles with `erasableSyntaxOnly`).
