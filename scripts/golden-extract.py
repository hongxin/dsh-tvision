#!/usr/bin/env python3
"""Carve a real session log into small, redacted replay fixtures.

A recorded log is the cheapest oracle this project has: it captures the exact
event shapes the harness emits, already paid for. Folding a fixture back
through the view turns "the integration drifted" into a one-line test failure,
with no terminal, no profile, and no tokens.

The carve is deliberately lossy in content and exact in shape: long texts are
truncated (the wrapping of a thousand-word skill catalog proves nothing), home
paths are replaced, and only the conversation-bearing event types are kept.
Nothing here runs the model — run a real turn, then point this at the log it
produced.

Usage:
    python3 scripts/golden-extract.py <session.v3.jsonl[.zstd]> <scenario>

Scenarios: reasoner (one reasoning+text turn with injected context),
tools (one tool call and its result).

The committed fixtures under tests/golden/ are hand-written from the verified
event shapes, with synthetic content — real transcripts stay out of the
repository. This script is the companion: after a dsh upgrade, run it against
a fresh log and diff the output against a fixture to see exactly which event
shapes drifted. Its output is for reading, not for committing.
"""
import argparse
import json
import sys
import zstandard

# The event types the fold reads; everything else (titles, requests, splices)
# is plumbing whose shape the view does not depend on.
KEPT_TYPES = {
    'turn/start', 'turn/end', 'step/start', 'step/end',
    'user/message', 'assistant/message', 'assistant/chunk',
    'tool/call', 'tool/result', 'todo/write', 'compaction/start', 'compaction/end',
}

HOME = '/Users/hongxin'


def read_lines(path):
    opener = open
    if path.endswith('.zstd'):
        opener = lambda p: zstandard.ZstdDecompressor().stream_reader(open(p, 'rb'))  # noqa: E731
    handle = opener(path)
    text = handle.read() if hasattr(handle, 'read') else b''
    if isinstance(text, bytes):
        text = text.decode('utf8')
    for line in text.splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def truncate(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + '…'


def redact(value, text_limit):
    """Truncate long strings and scrub the home directory out of paths."""
    if isinstance(value, str):
        value = value.replace(HOME, '~')
        return truncate(value, text_limit)
    if isinstance(value, list):
        return [redact(item, text_limit) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, text_limit) for key, item in value.items()}
    return value


def carve_reasoner(events):
    """The '你好' turn: user, injected context, reasoning+text settle."""
    out = []
    seen_settle = 0
    for event in events:
        if event.get('type') not in KEPT_TYPES:
            continue
        out.append(redact(event, text_limit=160))
        if event.get('type') == 'turn/end':
            seen_settle += 1
            if seen_settle >= 1:
                break
    return out


def carve_tools(events):
    """One tool round trip: the calls and results of the first step, closed."""
    out = []
    captured_calls = 0
    for event in events:
        kind = event.get('type')
        if kind not in KEPT_TYPES:
            continue
        if kind in ('user/message', 'assistant/message', 'tool/call', 'tool/result'):
            out.append(redact(event, text_limit=200))
        if kind == 'tool/call':
            captured_calls += 1
        if kind == 'tool/result' and captured_calls >= 1:
            # Close the fixture on the first result's step end.
            out.append({'type': 'step/end', 'seq': 10_000, 'time': event['time'] + 50,
                        'data': {'turn': event['data'].get('turn', 1), 'step': event['data'].get('step', 1)}})
            out.append({'type': 'turn/end', 'seq': 10_001, 'time': event['time'] + 60,
                        'data': {'reason': {'kind': 'completed'}}})
            break
    return out


SCENARIOS = {'reasoner': carve_reasoner, 'tools': carve_tools}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('log')
    parser.add_argument('scenario', choices=sorted(SCENARIOS))
    args = parser.parse_args()
    events = read_lines(args.log)
    for event in SCENARIOS[args.scenario](events):
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
