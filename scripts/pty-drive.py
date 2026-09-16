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
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

SCRIPT_GAP_SECONDS = 0.6
POLL_SECONDS = 0.05


def run(argv, script, columns, rows, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.execvp(argv[0], argv)
        os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    configure_pty(fd)
    out = bytearray()
    deadline = time.time() + timeout
    index = 0
    next_at = time.time()
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], POLL_SECONDS)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        if index < len(script) and time.time() >= next_at:
            _, payload = script[index]
            os.write(fd, base64.b64decode(payload))
            index += 1
            next_at = time.time() + SCRIPT_GAP_SECONDS
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return bytes(out)


def main():
    spec = json.loads(sys.argv[1])
    data = run(
        spec['argv'],
        spec.get('script', []),
        spec.get('columns', 104),
        spec.get('rows', 30),
        spec.get('timeout', 8),
    )
    sys.stdout.write(base64.b64encode(data).decode())


if __name__ == '__main__':
    main()
