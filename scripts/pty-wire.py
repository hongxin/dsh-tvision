#!/usr/bin/env python3
"""Verify the whole stack against a scripted local LLM endpoint.

This is the layer between "the profile boots" (pty-profile.py) and "a real
model turn": dsh, cordis, the agent loop, and the DeepSeek adapter all run for
real, but the wire ends at scripts/mock-llm.mjs — so the turn is deterministic
and costs nothing. It is where a drifted adapter contract or a broken
waterfall shows up without spending a token.

    python3 scripts/pty-wire.py [--dsh-home DIR] [--seconds N]

Exits non-zero when any check fails; prints one line per check.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_common import run  # noqa: E402  (sibling script)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_PORT = 8931
SCRIPT_GAP = 1.2
TEARDOWN = ['\x1b[?2004l', '\x1b[?1006l', '\x1b[?1002l', '\x1b[?1000l', '\x1b[?25h', '\x1b[?1049l']

# The keys sent to the desktop, in order: a reasoner turn (reasoning + CJK
# prose), then a tool turn whose approval is answered with Enter (the default
# button) and whose echo output must land in the transcript. Empty payloads
# are dwells, letting a frame paint before the next key.
SCRIPT = [
    ('reasoner-prompt', b'wire-reasoner\r'),
    ('dwell', b''),
    ('dwell', b''),
    ('tool-prompt', b'wire-tool\r'),
    ('dwell', b''),
    # If the approval dialog is up, Enter takes its default (allow); if the
    # policy auto-approved, this submits an empty composer line, a no-op.
    ('approve-or-noop', b'\r'),
    ('dwell', b''),
    ('dwell', b''),
    ('quit', b'\x11'),
]


def wait_for_mock(proc, deadline_s=10.0):
    """Block until the mock prints its listening line, or fail loudly."""
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        line = proc.stdout.readline()
        if 'listening' in line:
            return True
        if line == '' and proc.poll() is not None:
            break
    return False


def replay(capture, columns, rows):
    """Read back the final screen the terminal had, via the replay harness."""
    with tempfile.NamedTemporaryFile(suffix='.bin', delete=False) as handle:
        handle.write(capture)
        path = handle.name
    try:
        result = subprocess.run(
            ['npx', 'tsx', os.path.join(REPO, 'scripts', 'replay-capture.ts'), path, str(columns), str(rows)],
            cwd=REPO, capture_output=True, text=True, timeout=120,
        )
        return result.stdout if result.returncode == 0 else f'(replay failed: {result.stderr.strip()[:300]})'
    finally:
        os.unlink(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dsh-home', default=None)
    parser.add_argument('--seconds', type=float, default=40.0)
    parser.add_argument('--show', action='store_true', help='print the replayed screen for diagnosis')
    args = parser.parse_args()

    mock = subprocess.Popen(
        ['node', os.path.join(REPO, 'scripts', 'mock-llm.mjs')],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    checks = []
    try:
        if not wait_for_mock(mock):
            print('pty-wire: the mock endpoint never came up')
            return 1

        env = dict(os.environ)
        # The profile must talk to the mock, not to the real API: no key, no
        # spend, full determinism. Env wins unless the user's settings pin a
        # route, in which case pass --dsh-home with a clean settings.yaml.
        env['DEEPSEEK_BASE_URL'] = f'http://127.0.0.1:{MOCK_PORT}'
        env['DEEPSEEK_API_KEY'] = 'test-mock-key'
        os.environ.update(DEEPSEEK_BASE_URL=env['DEEPSEEK_BASE_URL'], DEEPSEEK_API_KEY=env['DEEPSEEK_API_KEY'])

        argv = ['dsh', '--profile', 'tvision']
        if args.dsh_home is not None:
            argv += ['--dsh-home', args.dsh_home]
        capture = run(argv, SCRIPT, 100, 30, args.seconds, SCRIPT_GAP)
        screen = replay(capture, 100, 30)

        # The mock must actually have served both turns; a profile that found a
        # real endpoint elsewhere would "pass" every screen check while lying.
        mock_log = ''
        time.sleep(0.3)
        mock.terminate()
        try:
            mock_log = mock.stdout.read()
        except ValueError:
            pass
        checks.append(('the mock served the turns', mock_log.count('/chat/completions') >= 2))
        checks.append(('the reasoning rendered as dimmed rows', '· The user asked for the scripted' in screen))
        checks.append(('the cjk reply rendered with the seam', '本地 mock 端点的回复' in screen and 'wire-test' in screen))
        checks.append(('the tool card settled with its output', 'wire-tool-ok' in screen and '~ bash' in screen))
        text = capture.decode('utf8', 'replace')
        counts = {seq: text.count(seq) for seq in TEARDOWN}
        checks.append(('every terminal mode restored exactly once', all(count == 1 for count in counts.values())))
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    if args.show:
        print('--- replayed screen ---')
        print(screen)
        print('--- mock log ---')
        print(mock_log)
    failed = 0
    for name, ok in checks:
        print(f'  [{"ok" if ok else "MISSING"}] {name}')
        failed += 0 if ok else 1
    print('OK: the whole stack works against the scripted wire' if failed == 0
          else f'pty-wire: {failed} check(s) failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
