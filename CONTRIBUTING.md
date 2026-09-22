# Contributing

Thanks for looking at the code. This repo has opinions about *how* changes are
verified, and they are the short version of everything else here.

## Setup

```sh
npm install
npm run build          # builds lib/ — the demo and the linked profile run this
npm test               # L0: units, whole-desktop tests, snapshots, golden replay
```

Node `^22.19 || >=24`. Python 3 is needed only for the pty harness scripts.

## The verification ladder

Every change climbs as far as it needs to and no further — see
[CLAUDE.md](CLAUDE.md) for the full table. In short:

| Level | Command | When you need it |
|---|---|---|
| L0 | `npm test` | Always. |
| L1 | `npm run sweep:pty && npm test` | Anything touching the renderer, palette, or input routing. |
| L2 | `npm run verify:profile` | Anything touching `package.json` or `cordis.patch.yml`. |
| L3 | `npm run verify:wire` | Anything between HTTP and the event subscription. |

A change that only rewrites comments needs L0. A change that moves a box-drawing
glyph needs L1, because what a real terminal does with the bytes is not visible
to the emulator suite.

## Conventions

- **Read [AGENTS.md](AGENTS.md) before editing.** It holds the layering rules
  (kit never imports upward), the width discipline (`textWidth`, never
  `String.length`), and the invariants that look removable and are not.
- **Snapshots are refreshed deliberately**, never to make a test pass:
  `Tvision_SNAPSHOT=refresh npx vitest run tests/snapshot.spec.ts`, then read
  the diff — an unexpected line in a snapshot diff is a bug, not noise.
- **Real transcripts never enter the repo.** The golden fixtures under
  `tests/golden/` are hand-written event shapes with synthetic content; use
  `scripts/golden-extract.py` to diff a fresh local session log against them
  and transcribe shape changes by hand.
- **Commit messages say why.** The code already says what.

## Reporting bugs

Open an issue with your terminal, OS, Node version, and what you saw. For
rendering bugs, a screenshot of the broken region plus what you expected is
worth a thousand words of description.
