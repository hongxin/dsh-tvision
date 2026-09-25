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
# Mode resets must appear exactly once; cursor-show is counted apart because
# the composer caret makes it an operational escape too.
TEARDOWN = ['\x1b[?2004l', '\x1b[?1006l', '\x1b[?1002l', '\x1b[?1000l', '\x1b[?1049l']
CURSOR_SHOW = '\x1b[?25h'

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
    # Attachment turn: /attach admits package.json through the real store,
    # the next message carries it as a durable file part, and the adapter
    # resolves it to model-visible handle text in the wire request. It runs
    # early so the markdown turn — whose constructs are judged on the final
    # screen — stays close to the end.
    ('attach', b'/attach package.json\r'),
    ('dwell', b''),
    ('attach-prompt', b'wire-attach\r'),
    ('dwell', b''),
    ('dwell', b''),
    # The breakpoint turn: a local rule, a matching call, run once. y answers
    # the breakpoint dialog; the approval that may follow takes Enter as
    # before. Then the same rule refuses the second call outright — the
    # denial is the tool result the model has to answer for.
    ('break-set', b'/breakpoint bash(*wire-break*)\r'),
    ('dwell', b''),
    ('break-prompt', b'wire-break\r'),
    ('dwell', b''),
    ('break-allow', b'y'),
    ('dwell', b''),
    ('approve-or-noop', b'\r'),
    ('dwell', b''),
    ('dwell', b''),
    ('break-prompt-2', b'wire-deny\r'),
    ('dwell', b''),
    ('break-deny', b'n'),
    ('dwell', b''),
    ('dwell', b''),
    # Markdown turn first: its constructs must land on the real screen.
    ('md-prompt', b'wire-markdown\r'),
    ('dwell', b''),
    ('dwell', b''),
    ('dwell', b''),
    ('dwell', b''),
    # Background-job turn, then open View ▸ Jobs through the menu bar: F10,
    # right to View, and the &Jobs accelerator.
    ('job-prompt', b'wire-job\r'),
    ('dwell', b''),
    ('dwell', b''),
    ('approve-or-noop', b'\r'),
    ('dwell', b''),
    ('dwell', b''),
    # Open View ▸ Jobs through the menu bar: F10, right to View, and the
    # &Jobs accelerator.
    ('menu', b'\x1b[21~'),
    ('dwell', b''),
    ('to-view', b'\x1b[C'),
    ('dwell', b''),
    ('pick-jobs', b'j'),
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
    parser.add_argument('--seconds', type=float, default=75.0)
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
        # Resume: the goodbye line names the session; a second boot with
        # --resume must show the persisted history on screen. The session
        # seeds its log at construction and constructor seeds never ride the
        # session/event firehose, so this pins the mount-time backfill —
        # without it the model carries the whole context into an empty
        # transcript.
        goodbye = re.search(r'--resume=([a-z0-9-]+)', capture.decode('utf8', 'replace'))
        if goodbye is not None:
            capture2 = run(
                ['dsh', '--profile', 'tvision', f'--resume={goodbye.group(1)}'],
                [('settle', b'')], 100, 30, 20.0, 1.0,
            )
            screen2 = replay(capture2, 100, 30)
            checks.append(('a resumed session shows its history on screen',
                           'The sleep is running' in screen2 or 'Round trip complete' in screen2))
            checks.append(('a resumed session shows the usage meter',
                           '⇄' in capture2.decode('utf8', 'replace')))
        else:
            checks.append(('a resumed session shows its history on screen', False))

        text = capture.decode('utf8', 'replace')
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
        # Transient content is asserted on the byte stream, not the final
        # screen: the Jobs window covers the transcript, and a covering window
        # is not evidence the prose never rendered.
        checks.append(('the reasoning rendered as dimmed rows', '· The user asked for the scripted' in text))
        checks.append(('the cjk reply rendered with the seam', '本地 mock 端点的回复' in text and 'wire-test' in text))
        # The tool card has scrolled off the final screen in a four-turn run;
        # its settled bytes are in the stream. Markdown's final state is judged
        # on the screen — the stream legitimately holds a half-streamed '**'
        # frame before the closing partner arrives (the streaming rule).
        checks.append(('the tool card settled with its output', 'wire-tool-ok' in text and '~ bash' in text))
        # Breakpoints: the dialog held the first matching call and y ran it;
        # n refused the second. The refused call's card has scrolled off the
        # final screen by now and a collapsed card does not repaint the
        # denial reason, so the refusal is judged where it matters — the mock
        # saw a follow-up request for the deny turn, which only happens once
        # the denial has come back to the model as the tool result.
        checks.append(('the breakpoint held the call and let it run',
                       'Breakpoint' in text and 'wire-break-ok' in text))
        deny_followups = sum(1 for line in mock_log.splitlines()
                             if 'wire-deny' in line and 'followup=true' in line)
        checks.append(('the refusal reached the model as the tool result',
                       'wire-break-deny' in text and deny_followups >= 1))
        # Style runs split the byte stream (SGR between the quote bar and its
        # text), so markdown's judgement runs on the replayed screen, where the
        # content is contiguous. The markdown turn sits third of four, close
        # enough to the end that scroll position cannot hide it.
        checks.append(('markdown rendered as structure, not markers', 'chunk by chunk' in screen and '│ A fence' in screen and '**' not in screen))
        checks.append(('the jobs window holds the background job', 'sleep 5' in screen and '▸' in screen))
        # The token-meter projection reached the status bar. Asserted on the
        # byte stream, like the other transient content: a long status notice
        # (the breakpoint banner) legitimately evicts the token cell from the
        # final screen, and the cache column exists only in the projection's
        # usage split — its presence proves adapter usage -> durable log ->
        # projection -> snapshot -> screen.
        checks.append(('the token-meter projection drove the status bar', '⇄' in text and '↑' in text))
        # The attachment round trip: /attach admitted package.json into the
        # durable store, the next message carried it as a file part, and the
        # adapter handed the model the handle text `[File "package.json"
        # (…bytes…)]` — the file name on the wire request is the proof that
        # the file itself, not a path mention, rode along.
        attach_line = next((line for line in mock_log.splitlines() if 'wire-attach' in line), '')
        checks.append(('the attached file reached the model as handle text',
                       'package.json' in attach_line and 'model-visible' in text))
        counts = {seq: text.count(seq) for seq in TEARDOWN}
        checks.append(('every terminal mode restored exactly once', all(count == 1 for count in counts.values())))
        checks.append(('the cursor was left visible', text.count(CURSOR_SHOW) >= 1))
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
