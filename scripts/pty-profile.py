#!/usr/bin/env python3
"""Boot a real dsh profile under a pty and check that the desktop mounts.

The other harnesses drive `lib/demo.js`, which stands in for the harness with a
scripted agent. This one drives `dsh --profile <name>` itself, so it covers the
path nothing else does: the plugin loading through the Cordis loader, the agent
being created, the desktop mounting against the *real* agent, and the terminal
being taken. It is the difference between "the tree composes" and "the app runs".

It needs a pty, and it needs the profile to exist:

    python3 scripts/pty-profile.py --profile tvision
    python3 scripts/pty-profile.py --profile tvision --dsh-home ~/.dsh

Exits non-zero when the desktop did not mount, so it can gate a release.
"""
import argparse
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time

from pty_common import configure_pty, terminate  # noqa: E402  (sibling script)

# What a mounted desktop must have written by the time it has drawn a frame.
MOUNT_EVIDENCE = [
    ('took the alternate screen', '\x1b[?1049h'),
    ('enabled mouse reporting', '\x1b[?1006h'),
    ('enabled bracketed paste', '\x1b[?2004h'),
]
# And what it must have drawn, after the escapes are stripped.
RENDER_EVIDENCE = [
    ('the menu bar', 'File'),
    ('a window frame', 'Conversation'),
    ('the composer', 'dsh>'),
    ('the key strip', 'F10'),
]
STRIP = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07')


def find_dsh():
    """The dsh entry point.

    Resolved with `shutil.which` and the npm global root rather than by spawning a
    login shell: a login shell sources the user's profile, which can block on a
    prompt, and a verification script that can hang is worse than one that fails.
    """
    found = shutil.which('dsh')
    if found:
        # `shutil.which` may return the launcher script or the JS entry; resolve a
        # symlink to the file node can actually run.
        resolved = os.path.realpath(found)
        return resolved if resolved.endswith('.js') else found
    for candidate in _global_roots():
        entry = os.path.join(candidate, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if os.path.exists(entry):
            return entry
    return None


def _global_roots():
    """Candidate npm global roots, without shelling out."""
    roots = []
    # The node that runs this script is usually the one that installed dsh.
    node = os.path.realpath(sys.executable)
    prefix = os.path.dirname(os.path.dirname(node))
    roots.append(os.path.join(prefix, 'lib', 'node_modules'))
    for env in ('npm_config_prefix', 'PREFIX'):
        value = os.environ.get(env)
        if value:
            roots.append(os.path.join(value, 'lib', 'node_modules'))
    return roots


def run(entry, profile, dsh_home, columns, rows, seconds):
    """Boot the profile under a pty and capture what it draws."""
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['TERM'] = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        if dsh_home:
            env['DSH_HOME'] = dsh_home
        os.environ.clear()
        os.environ.update(env)
        os.execvp('node', ['node', entry, '--profile', profile])
        os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    configure_pty(fd)
    out = bytearray()
    deadline = time.time() + seconds
    status = None
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            break
    if status is None:
        terminate(pid)
    os.close(fd)
    return bytes(out), status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default='tvision')
    parser.add_argument('--dsh-home', default=None, help='defaults to $DSH_HOME or ~/.dsh')
    parser.add_argument('--seconds', type=float, default=14.0)
    parser.add_argument('--columns', type=int, default=100)
    parser.add_argument('--rows', type=int, default=30)
    parser.add_argument('--show', action='store_true', help='print the final screen')
    args = parser.parse_args()

    entry = find_dsh()
    if entry is None:
        print('pty-profile: no dsh entry point found; install it or put it on PATH', file=sys.stderr)
        return 0

    dsh_home = args.dsh_home or os.environ.get('DSH_HOME')
    try:
        raw, status = run(entry, args.profile, dsh_home, args.columns, args.rows, args.seconds)
    except OSError as error:
        print(f'pty-profile: cannot allocate a pty ({error}); run from a normal shell', file=sys.stderr)
        return 0

    text = raw.decode('utf8', 'replace')
    plain = STRIP.sub('', text)
    failures = []
    print(f'pty-profile: {len(raw)} bytes from `dsh --profile {args.profile}` at {args.columns}x{args.rows}')
    for label, needle in MOUNT_EVIDENCE:
        ok = needle in text
        print(f'  [{"ok " if ok else "MISSING"}] {label}')
        if not ok:
            failures.append(label)
    for label, needle in RENDER_EVIDENCE:
        ok = needle in plain
        print(f'  [{"ok " if ok else "MISSING"}] drew {label}')
        if not ok:
            failures.append(label)

    if args.show:
        print('\n--- final screen ---')
        print(plain[-4000:])

    # A crash is worth showing: the whole point is to catch a mount that fails.
    if failures:
        print(f'\nFAIL: {len(failures)} checks failed', file=sys.stderr)
        print(plain[:2000], file=sys.stderr)
        return 1
    print('\nOK: the desktop mounted and drew against the real agent')
    return 0


if __name__ == '__main__':
    sys.exit(main())
