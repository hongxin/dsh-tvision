"""The pty plumbing every capture script shares.

Three scripts drive tvision under a real pty — `pty-drive.py` (one scripted
scenario), `pty-sweep.py` (a matrix of them), and `tv-report.py` (an interactive
session for a bug report). The fork/size/mode/capture dance is the part with
traps that cost an afternoon to rediscover, so it lives here once:

- the pty is sized *before* the child can read its dimensions, because a child
  that captures 80x24 and then receives a resize paints a frame for the wrong
  screen;
- the line discipline is put in the mode a full-screen app expects — no ISIG,
  no ECHO, no IXON — *before* the first key is sent, because keys often arrive
  while the child is still starting up;
- stopping the child escalates, and never blocks: `dsh` ignores SIGTERM while it
  is still booting, so the obvious "SIGTERM then `waitpid`" is a script that hangs
  instead of failing.

Import from a sibling script with the repository's own layout in mind: these
are run as `python3 scripts/<name>.py`, which puts this directory on `sys.path`.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time

POLL_SECONDS = 0.05


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


def terminate(pid, grace=2.0):
    """Stop a pty child, escalating when it will not stop.

    `dsh` ignores SIGTERM while it is still booting — plugins, native modules,
    storage roots — so SIGTERM followed by a blocking `waitpid` hangs instead of
    failing. Ask politely, then insist. The process group goes first, because the
    child may have descendants still holding the pty open.
    """
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
        deadline = time.time() + grace
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if done:
                return
            time.sleep(POLL_SECONDS)
    # Last resort: reap without blocking, so the caller still gets its bytes.
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def run(argv, script, columns, rows, timeout, script_gap_seconds):
    """Run argv under a pty of the given size, sending script, returning bytes.

    The script is a list of `(label, bytes)` pairs written in order, one every
    `script_gap_seconds`; labels exist so a scenario reads as a story rather
    than a list of byte strings.
    """
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
            next_at = time.time() + script_gap_seconds
    terminate(pid)
    return bytes(out)
