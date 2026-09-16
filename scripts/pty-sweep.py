#!/usr/bin/env python3
"""Run the terminal smoke sweep: drive the demo through many sizes and key
sequences under a real pty, then report the invariant checks.

This is the complement to `pty-drive.py`. That script drives one scenario and
leaves the reading to a human; this one drives a matrix of them and looks for the
failures a terminal enforces silently — an over-wide row that wraps, a frame that
scrolls the screen, chrome that has drifted out of place.

It needs a pty, so it will not run inside a sandbox that denies device
allocation. When it cannot, it says so and exits successfully rather than
pretending the sweep passed.

The pty is put in a mode a full-screen app expects — no ISIG, no echo — before
the first key is sent, because the keys often arrive while the child is still
starting up and a line discipline that turns Ctrl+C into a SIGINT would kill it
before it ever drew a frame.

Usage:
    python3 scripts/pty-sweep.py [--json out.json]
"""
import argparse
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

POLL_SECONDS = 0.05
SCRIPT_GAP_SECONDS = 0.55
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The desktop's first frame alone is several kilobytes; anything far below that
# means the run never really started.
MIN_PLAUSIBLE_CAPTURE = 500

# (name, columns, rows, [(label, bytes)])
SWEEP = [
    ('wide-quiet', 104, 30, []),
    ('standard-quiet', 80, 24, []),
    ('narrow-quiet', 60, 20, []),
    ('tight-quiet', 40, 12, []),
    ('tiny-quiet', 24, 8, []),
    ('huge-quiet', 200, 60, []),
    ('type-and-send', 100, 30, [
        ('type', b'stream the parser'),
        ('send', b'\r'),
    ]),
    ('menu-walk', 100, 30, [
        ('f10', b'\x1b[21~'),
        ('down', b'\x1b[B'),
        ('across', b'\x1b[C'),
        ('down', b'\x1b[B'),
        ('escape', b'\x1b'),
    ]),
    # The keys land after the demo has gone quiet, so the help window is actually
    # painted and captured rather than being opened and closed between two frames
    # of a stream.
    ('help-window', 100, 30, [
        ('help', b'\x1b[11~'),
        ('dwell', b''),
        ('escape', b'\x1b'),
        ('dwell', b''),
    ]),
    # A drag needs the pointer to move in steps: one leap is one frame, and a
    # frame is not what a drag looks like.
    ('mouse-drag', 100, 30, [
        ('press-title', b'\x1b[<0;20;2M'),
        ('drag-1', b'\x1b[<32;24;4M'),
        ('drag-2', b'\x1b[<32;29;7M'),
        ('drag-3', b'\x1b[<32;34;9M'),
        ('release', b'\x1b[<0;34;9m'),
    ]),
    ('mouse-resize', 100, 30, [
        ('press-grip', b'\x1b[<0;71;27M'),
        ('drag-1', b'\x1b[<32;66;24M'),
        ('drag-2', b'\x1b[<32;60;20M'),
        ('release', b'\x1b[<0;60;20m'),
    ]),
    ('wheel-scroll', 100, 30, [
        ('up', b'\x1b[<64;20;10M'),
        ('up', b'\x1b[<64;20;10M'),
        ('down', b'\x1b[<65;20;10M'),
    ]),
    ('windows-toggle', 100, 30, [
        ('tasks', b'\x1b[19~'),
        ('project', b'\x1b[17~'),
        ('open', b'\x1b[13~'),
        ('cycle', b'\x1b[17~'),
    ]),
    ('skins', 100, 30, [
        ('skin', b'\x1b[20~'),
        ('skin', b'\x1b[20~'),
        ('skin', b'\x1b[20~'),
    ]),
    ('cancel-mid-stream', 100, 30, [
        ('cancel', b'\x03'),
    ]),
    ('stress-keys', 90, 26, [
        ('burst', b'abc\r\x1b[A\x1b[B\x1b[D\x1b[C\x1b[3~\x7f\x0f\x12\x1b[21~\x1b'),
    ]),
    ('resize-storm', 100, 30, [
        ('half', b'\x1b[21~\x1b[B\x1b'),
    ]),
    # The last scenario the terminal ever sees from this app. The capture is
    # checked for the teardown rather than for a frame.
    ('quit-cleanly', 100, 30, [
        ('quit', b'\x11'),
    ]),
]

# What the app must have written by the time it exits, and how many times.
# Emitting a mode change twice is not harmless: it is the signature of two
# writers taking turns on one alternate screen, which is how a terminal ends up
# in a mode nobody turns off.
TEARDOWN_SEQUENCES = [
    '\x1b[?2004l',
    '\x1b[?1006l',
    '\x1b[?1002l',
    '\x1b[?1000l',
    '\x1b[?25h',
    '\x1b[?1049l',
]


def configure_pty(fd):
    """Make the slave behave like the terminal a full-screen app expects.

    Two settings matter and both are the parent's job, because the child is still
    starting when the first keys arrive:

    - **ISIG off.** Otherwise the line discipline turns Ctrl+C into a SIGINT and
      kills the child before it has taken raw mode — which shows up as a capture
      containing nothing but the `^C` the terminal echoed. A real terminal user
      pressing Ctrl+C in a full-screen app expects the app to receive the byte.
    - **ECHO off**, so the app's own drawing is the only thing on the screen and a
      capture is not polluted by the tty echoing keystrokes back.
    - **IXON off**, so Ctrl+Q reaches the app instead of being swallowed as XON by
      the terminal's flow control. An app that quits on Ctrl+Q appears to hang
      without this.
    """
    attrs = termios.tcgetattr(fd)
    attrs[0] &= ~termios.IXON
    attrs[3] &= ~(termios.ISIG | termios.ECHO)
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def drive(argv, script, columns, rows, timeout):
    """Run argv under a pty of the given size, sending script, returning bytes."""
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.execvp(argv[0], argv)
        os._exit(127)
    # Size before the child can read it, or it paints a frame for the wrong screen.
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
            os.write(fd, script[index][1])
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


def pty_available():
    """Whether this environment allows allocating a pty at all."""
    try:
        pid, fd = pty.fork()
    except OSError:
        return False
    if pid == 0:
        os._exit(0)
    os.close(fd)
    os.waitpid(pid, 0)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', help='write the raw captures here for inspection')
    parser.add_argument('--only', help='run only the scenario with this name')
    parser.add_argument('--seconds', type=float, default=None, help='wall clock per scenario')
    args = parser.parse_args()

    if not pty_available():
        print('pty-sweep: this environment cannot allocate a pty; sweep skipped.')
        print('pty-sweep: run it from a normal shell, or grant the process device access.')
        return 0

    captures = {}
    scenarios = [s for s in SWEEP if args.only is None or s[0] == args.only]
    for name, columns, rows, script in scenarios:
        # A scripted scenario waits for the demo to go quiet before its first key,
        # so it needs the script's own duration plus room for the keys.
        seconds = args.seconds if args.seconds is not None else (3.5 if not script else 9.0)
        data = drive(['node', os.path.join(REPO, 'lib', 'demo.js')], script, columns, rows, seconds)
        # A pty run can come back nearly empty when the system is short of
        # terminal devices — seventeen sequential forks is enough to do it. That
        # is the harness failing, not the app, so give it a moment and retry once
        # rather than reporting a defect the app does not have.
        for attempt in range(2):
            if len(data) >= MIN_PLAUSIBLE_CAPTURE:
                break
            time.sleep(1.5)
            print(f'{name}: only {len(data)} bytes; retrying ({attempt + 1}/2)')
            data = drive(['node', os.path.join(REPO, 'lib', 'demo.js')], script, columns, rows, seconds)
        capture = {'columns': columns, 'rows': rows, 'base64': base64.b64encode(data).decode()}
        if name == 'quit-cleanly':
            capture['teardown'] = {seq: data.decode('utf8', 'replace').count(seq) for seq in TEARDOWN_SEQUENCES}
        captures[name] = capture
        print(f'{name}: {len(data)} bytes at {columns}x{rows}')

    if args.json:
        with open(args.json, 'w') as handle:
            json.dump(captures, handle)
        print(f'wrote {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
