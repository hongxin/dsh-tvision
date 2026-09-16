#!/usr/bin/env python3
"""Capture what tvision draws in *your* terminal, for a bug report.

You do not need to describe the bug. Run this, look at what you want to report,
press Ctrl+Q, and send the file:

    python3 scripts/tv-report.py
    # ... use tvision as you normally would ...
    # press Ctrl+Q, or just wait for the timeout
    # -> writes .tools/report-<timestamp>.txt and prints its path

The report holds the size of your terminal, the environment the app reads, and a
replay of everything it drew — the final screen as text, plus the raw byte stream
so a frame-by-frame replay is possible.

It needs a pty and therefore your own shell. If it cannot allocate one it says so
and exits without claiming success.
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

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLL_SECONDS = 0.05
DEFAULT_SECONDS = 600.0
COLUMNS = 100
ROWS = 30


def configure_pty(fd):
    """Put the pty in the mode a full-screen app expects.

    Without this the line discipline turns Ctrl+C into a SIGINT that kills the app
    before it takes raw mode, and swallows Ctrl+Q as XON — so the app looks like it
    hangs on quit and the capture holds nothing but the ``^C`` the tty echoed.
    """
    attrs = termios.tcgetattr(fd)
    attrs[0] &= ~termios.IXON
    attrs[3] &= ~(termios.ISIG | termios.ECHO)
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def effective_term():
    """The TERM the app will be given, which is not this process's own."""
    term = os.environ.get('TERM', '')
    return 'xterm-256color' if term in ('', 'dumb') else term


def drive(argv, columns, rows, seconds):
    """Run argv under a pty, forwarding this terminal's input to it, and capture."""
    pid, fd = pty.fork()
    if pid == 0:
        # A caller whose TERM is `dumb` or unset is not describing the terminal
        # tvision will draw into, so give the app a real one to reason about.
        if os.environ.get('TERM', '') in ('', 'dumb'):
            os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = os.environ.get('COLORTERM', 'truecolor')
        os.execvp(argv[0], argv)
        os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    configure_pty(fd)

    # Forward our own stdin so the session is interactive, and also watch the pty
    # for the app's output. A terminal is already in raw mode when the app takes
    # it, so this only has to copy bytes in both directions.
    stdin_fd = sys.stdin.fileno()
    stdin_attrs = None
    try:
        if os.isatty(stdin_fd):
            stdin_attrs = termios.tcgetattr(stdin_fd)
            raw = termios.tcgetattr(stdin_fd)
            raw[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG)
            raw[0] &= ~termios.IXON
            raw[6][termios.VMIN] = 0
            raw[6][termios.VTIME] = 0
            termios.tcsetattr(stdin_fd, termios.TCSANOW, raw)
    except (termios.error, ValueError, OSError):
        stdin_attrs = None

    out = bytearray()
    deadline = time.time() + seconds
    status = None
    try:
        while time.time() < deadline:
            watched = [fd]
            if stdin_attrs is not None:
                watched.append(stdin_fd)
            ready, _, _ = select.select(watched, [], [], POLL_SECONDS)
            for handle in ready:
                if handle == fd:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        raise SystemExit
                    if not chunk:
                        raise SystemExit
                    out += chunk
                else:
                    keys = os.read(stdin_fd, 4096)
                    if keys:
                        os.write(fd, keys)
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
                break
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if stdin_attrs is not None:
            termios.tcsetattr(stdin_fd, termios.TCSANOW, stdin_attrs)
        if status is None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        os.close(fd)
    return bytes(out)


def node_version():
    """The Node version the app will actually run under."""
    import subprocess
    try:
        return subprocess.run(['node', '--version'], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return '(node not found)'


def render_screen(raw, columns, rows):
    """Replay the capture's complete frames and return the resulting screen.

    Imported through Node because the harness is TypeScript; kept optional so a
    report is still written when the build artifacts are missing.
    """
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile(suffix='.bin', delete=False) as handle:
        handle.write(raw)
        path = handle.name
    script = os.path.join(REPO, 'scripts', 'replay-capture.ts')
    try:
        result = subprocess.run(
            ['node', '--experimental-strip-types', script, path, str(columns), str(rows)],
            cwd=REPO, capture_output=True, text=True, timeout=60,
        )
        return result.stdout if result.returncode == 0 else f'(replay failed: {result.stderr.strip()[:400]})'
    except (OSError, subprocess.SubprocessError) as error:
        return f'(replay unavailable: {error})'
    finally:
        os.unlink(path)


def main():
    seconds = DEFAULT_SECONDS
    if len(sys.argv) > 1:
        try:
            seconds = float(sys.argv[1])
        except ValueError:
            print(f'usage: {sys.argv[0]} [seconds]', file=sys.stderr)
            return 2

    try:
        pid, fd = pty.fork()
    except OSError as error:
        print(f'tv-report: this environment cannot allocate a pty ({error}).', file=sys.stderr)
        print('tv-report: run it from a normal shell instead.', file=sys.stderr)
        return 0
    os.close(fd)
    os.waitpid(pid, 0)

    raw = drive(['node', os.path.join(REPO, 'lib', 'demo.js')], COLUMNS, ROWS, seconds)

    out_dir = os.path.join(REPO, '.tools')
    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    path = os.path.join(out_dir, f'report-{stamp}.txt')
    with open(path, 'w') as handle:
        handle.write('tvision report\n')
        handle.write('=' * 60 + '\n\n')
        handle.write(f'pty size    {COLUMNS}x{ROWS}\n')
        handle.write(f'captured    {len(raw)} bytes\n')
        handle.write(f'TERM        {effective_term()} (app saw this)\n')
        handle.write(f'COLORTERM   {os.environ.get("COLORTERM", "")}\n')
        handle.write(f'TERM_PROGRAM {os.environ.get("TERM_PROGRAM", "")}\n')
        handle.write(f'node        {node_version()}\n')
        handle.write('\n-- final screen, replayed --\n\n')
        handle.write(render_screen(raw, COLUMNS, ROWS))
        handle.write('\n\n-- raw capture (base64) --\n')
        handle.write(base64.b64encode(raw).decode())
        handle.write('\n')
    print(f'tv-report: wrote {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
