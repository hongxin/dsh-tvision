#!/usr/bin/env python3
"""Synthesize a large session log for resume-perience measurement.

Writes a session.v4.jsonl.zstd under the sandbox home with a realistic mix of
events (turns, streamed assistant chunks, tool round trips, injected context),
so `dsh --profile tvision --resume=<id>` can be timed against a corpus the
size a heavy real session reaches. The events are synthetic; no real
transcript is ever copied.
"""
import argparse
import json
import os
import random
import sys
import zstandard

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--events', type=int, default=20000)
    parser.add_argument('--session', default='main-session-perf-test')
    parser.add_argument('--home', default=None)
    args = parser.parse_args()
    home = args.home or os.path.join(os.getcwd(), '.tools', 'dsh-home')
    directory = os.path.join(home, 'sessions', '--private-tmp--', args.session)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, 'session.v4.jsonl.zstd')

    random.seed(42)
    lines = []
    seq = 0
    def emit(event):
        nonlocal seq
        event['seq'] = seq
        seq += 1
        lines.append(json.dumps(event, ensure_ascii=False))

    t = 1_790_000_000_000
    emit({'type': 'session', 'version': 4, 'id': args.session,
          'createdAt': t, 'cwd': '/tmp', 'isSeeded': False, 'delegationDepth': 0})
    emit({'type': 'permission/preset', 'time': t, 'data': {'preset': 'workspace-write'}})
    emit({'type': 'sandbox/mode', 'time': t, 'data': {'mode': 'workspace-write'}})

    turn = 0
    while seq < args.events:
        turn += 1
        t += 5000
        emit({'type': 'turn/start', 'time': t, 'data': {'turn': turn}})
        emit({'type': 'step/start', 'time': t, 'data': {'turn': turn, 'step': 1}})
        emit({'type': 'user/message', 'time': t,
              'data': {'content': [{'type': 'text', 'text': f'question {turn} about the parser'}],
                        'source': {'kind': 'user'}, 'role': 'user'}})
        # A few injected context rows, the way the corpus showed.
        emit({'type': 'user/message', 'time': t,
              'data': {'content': [{'type': 'text', 'text': 'runtime context snapshot ' * 8}],
                        'source': {'kind': 'plugin', 'plugin': '@deepseek-ai/dsh-system-prompt', 'form': 'snapshot'},
                        'role': 'user'}})
        # Streamed assistant text in chunks, the shape the fold sees live.
        for chunk in range(6):
            t += 120
            emit({'type': 'assistant/message', 'time': t,
                  'data': {'turn': turn, 'step': 1, 'stream': [
                      {'type': 'chunk', 'time': t, 'chunk': {'type': 'text', 'text': f'answer {turn} chunk {chunk} with some words ' * 4}}]}})
        # A tool round trip.
        t += 200
        call_id = f'call_{turn}'
        emit({'type': 'tool/call', 'time': t, 'data': {'turn': turn, 'step': 1, 'callId': call_id,
              'name': 'bash', 'arguments': json.dumps({'command': f'npm test -- suite-{turn}'})}})
        t += 800
        emit({'type': 'tool/result', 'time': t, 'data': {'turn': turn, 'step': 1,
              'message': {'source': {'kind': 'tool', 'callId': call_id},
                          'content': [{'type': 'tool-result', 'toolCallId': call_id,
                                       'content': [{'type': 'text', 'text': f'PASS tests/suite-{turn}.spec.ts\n' * 6}]}]}}})
        t += 100
        emit({'type': 'assistant/message', 'time': t,
              'data': {'turn': turn, 'step': 1, 'message': {'role': 'assistant',
                        'source': {'kind': 'model', 'provider': 'deepseek-official', 'model': 'deepseek-flash'},
                        'content': [{'type': 'text', 'text': f'done {turn}; the suite passed and the parser holds ' * 3}]},
                        'usage': {'input': 1000 + turn, 'output': 40}}})
        emit({'type': 'step/end', 'time': t, 'data': {'turn': turn, 'step': 1}})
        emit({'type': 'turn/end', 'time': t, 'data': {'reason': {'kind': 'completed'}}})

    with open(path, 'wb') as handle:
        with zstandard.ZstdCompressor().stream_writer(handle) as writer:
            writer.write('\n'.join(lines).encode('utf8'))
            writer.write(b'\n')
    size = os.path.getsize(path)
    print(f'wrote {seq} events ({size} bytes compressed) to {path}')
    print(f'resume with: dsh --profile tvision --resume={args.session}')

if __name__ == '__main__':
    main()
