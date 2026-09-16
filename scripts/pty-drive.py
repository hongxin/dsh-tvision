#!/usr/bin/env python3
"""Drive a command under a real pty and capture what it draws.

Why this exists: the compositor's test suite replays frames into a terminal
*emulator*, which proves the escape sequences produce the grid we think they do,
but not that a real terminal agrees. A pty is the only way to check the second
half — and the interactive paths (a keystroke, a mouse drag) cannot be reached
any other way at all.

The pty is sized *before* the child can read its dimensions, because a child that
captures 80x24 and then receives a resize paints a frame for the wrong screen.

Usage:
    python3 scripts/pty-drive.py spec.json > capture.bin

where the spec is:
    {
      "argv": ["node", "lib/demo.js"],
      "columns": 104, "rows": 30, "timeout": 8,
      "script": [["label", "<base64 of the bytes to send>"], ...]
    }

Each script entry is written to the pty 0.6 s after the previous one. Capture the
output, then replay it with `scripts/replay-capture.ts` to read the screen back.

The fork/size/mode/capture loop lives in `pty_common.py`, shared with the other
capture scripts, so a trap fixed here is fixed everywhere at once.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_common import run

SCRIPT_GAP_SECONDS = 0.6


def main():
    spec = json.loads(sys.argv[1])
    # The spec carries base64 so a JSON file can hold arbitrary bytes; the shared
    # driver wants the bytes themselves.
    script = [[label, base64.b64decode(payload)] for label, payload in spec.get('script', [])]
    data = run(
        spec['argv'],
        script,
        spec.get('columns', 104),
        spec.get('rows', 30),
        spec.get('timeout', 8),
        SCRIPT_GAP_SECONDS,
    )
    sys.stdout.write(base64.b64encode(data).decode())


if __name__ == '__main__':
    main()
