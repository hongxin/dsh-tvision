#!/usr/bin/env python3
"""Aggregate every tvision-cwd session log into a behavioural summary.

Reads all session.v4.jsonl.zstd under the dsh-tvision cwd key, decompresses
streaming, and tabulates what actually happened in 21 days of use: turn
outcomes, tool usage, error reasons, interruptions, dialog traffic. Prints one
JSON blob to stdout for downstream reading.
"""
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

import zstandard

SESSIONS = Path(os.environ.get('HOME', '')) / '.dsh' / 'sessions'
KEYS = [
    '--Users-hongxin-Workspace-dsh-playground-dsh-tvision--',
    '--Users-hongxin-.dsh-profiles-tvision--',
]

def iter_events(path):
    dctx = zstandard.ZstdDecompressor()
    with open(path, 'rb') as handle:
        with dctx.stream_reader(handle) as reader:
            text = reader.read().decode('utf8', 'replace')
    for line in text.split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue

def main():
    event_types = Counter()
    turn_reasons = Counter()
    tool_names = Counter()
    tool_errors = Counter()
    error_events = []
    interrupts = 0
    turns = 0
    sessions = 0
    approvals = Counter()
    questions = 0
    first_last = []
    per_session_turns = Counter()
    followups = 0
    user_msgs = 0
    attachments = 0
    model_usage = Counter()
    for key in KEYS:
        root = SESSIONS / key
        if not root.is_dir():
            continue
        for sid in sorted(root.iterdir()):
            log = sid / 'session.v4.jsonl.zstd'
            if not log.is_file():
                continue
            sessions += 1
            session_turns = 0
            started = None
            ended = None
            for event in iter_events(log):
                etype = event.get('type', '?')
                event_types[etype] += 1
                t = event.get('time')
                if t is not None:
                    started = started or t
                    ended = t
                data = event.get('data', {})
                if etype == 'turn/start':
                    turns += 1
                    session_turns += 1
                elif etype == 'turn/end':
                    reason = data.get('reason', {})
                    if isinstance(reason, dict):
                        turn_reasons[reason.get('kind', '?')] += 1
                elif etype == 'tool/call':
                    tool_names[data.get('name', '?')] += 1
                elif etype == 'llm/error':
                    message = str(data.get('error', data))[:160]
                    tool_errors[message] += 1
                elif etype == 'user/message':
                    user_msgs += 1
                    source = data.get('source')
                    if isinstance(source, dict) and source.get('kind') not in (None, 'user'):
                        followups += 1
                    if isinstance(data.get('content'), list):
                        for part in data['content']:
                            if isinstance(part, dict) and part.get('type') == 'file':
                                attachments += 1
                elif etype == 'approval/request':
                    approvals[data.get('tool', '?')] += 1
                elif etype == 'user-questions/request':
                    questions += 1
                elif etype in ('turn/interrupted', 'interrupt'):
                    interrupts += 1
                elif etype == 'assistant/message':
                    model = (data.get('message', {}) or {}).get('source', {}) or {}
                    label = '/'.join(str(model.get(k)) for k in ('provider', 'model') if model.get(k))
                    if label:
                        model_usage[label] += 1
                elif etype == 'session/error':
                    error_events.append(str(data)[:200])
            per_session_turns[sid.name] = session_turns
            if started and ended:
                first_last.append((sid.name, started, ended))

    total_seconds = sum((b - a) for _, a, b in first_last) / 1000
    active = [n for n in per_session_turns.values() if n > 0]
    print(json.dumps({
        'sessions': sessions,
        'sessions_with_turns': len(active),
        'turns_total': turns,
        'turns_median_per_active_session': sorted(active)[len(active)//2] if active else 0,
        'span_days': round(total_seconds / 86400, 1),
        'user_messages': user_msgs,
        'nonuser_followups': followups,
        'attachments': attachments,
        'turn_reasons': dict(turn_reasons),
        'interrupts': interrupts,
        'approvals': dict(approvals.most_common(12)),
        'questions': questions,
        'tools': dict(tool_names.most_common(20)),
        'models': dict(model_usage.most_common(8)),
        'llm_errors': {k[:120]: v for k, v in tool_errors.most_common(10)},
        'session_errors': error_events[:8],
        'top_event_types': dict(event_types.most_common(30)),
    }, indent=1, ensure_ascii=False))

if __name__ == '__main__':
    main()
