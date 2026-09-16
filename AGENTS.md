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
