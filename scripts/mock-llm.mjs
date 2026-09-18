#!/usr/bin/env node
/**
 * A scripted DeepSeek-compatible LLM endpoint, for testing the real profile.
 *
 * The last untestable seam used to be the wire: everything below the HTTP
 * request is the harness's own code, and exercising it against the real API
 * costs tokens and determinism. This server speaks the exact protocol
 * dsh-llm-deepseek speaks (verified against its adapter source):
 *
 * - POST {baseURL}/chat/completions with `stream: true` and
 *   `stream_options: {include_usage: true}`;
 * - SSE `data: {json}` events whose deltas carry `reasoning_content`,
 *   `content`, and accumulating `tool_calls[]` (indexed, arguments
 *   fragmented exactly like the real API);
 * - usage in a trailing chunk, and the stream closed by `data: [DONE]`.
 *
 * The reply is chosen from the last user message, so a pty script drives the
 * scenario by typing. Scripted turns live in TURNS below; add one, type its
 * keyword, assert on what the desktop drew.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8931)

/** One scripted reply, streamed chunk by chunk with realistic delays. */
const TURNS = [
  {
    // match: the user's message contains this substring
    match: 'wire-reasoner',
    reasoning: 'The user asked for the scripted reasoner turn. Answer in Chinese, mention the seam, and stop.',
    content: '这是来自本地 mock 端点的回复：整条真实链路（dsh → cordis → agent-loop → llm 适配器 → tvision）都被穿过了，没有花一分钱 token。中英混排像 wire-test 一样自然。',
    usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 },
  },
  {
    // A background bash job: returns immediately with a jobId, leaving the
    // Jobs window holding a live row the harness's registry drives.
    match: 'wire-job',
    reasoning: 'The user asked for the background job turn. Start a sleep in the background.',
    toolCall: { id: 'call_mock_sleep', name: 'bash', arguments: '{"command":"sleep 5","run_in_background":true}' },
    followupContent: 'The sleep is running in the background; the Jobs window holds it.',
    usage: { prompt_tokens: 210, completion_tokens: 28, total_tokens: 238 },
  },
  {
    match: 'wire-tool',
    reasoning: 'The user asked for the tool turn. Call bash with a harmless echo.',
    toolCall: { id: 'call_mock_echo', name: 'bash', arguments: '{"command":"echo wire-tool-ok"}' },
    // The second request, after the tool result is fed back, gets this.
    followupContent: 'The command printed wire-tool-ok. Tool round trip complete.',
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Which scripted turns have already emitted their tool call. */
const emittedTool = new Set()

/**
 * Slice text into fixed-size code-point chunks, losslessly.
 *
 * A `/g` regex like /.{1,12}(\\s|$)/gu silently SKIPS spans that contain no
 * whitespace within reach — the gap between matches never enters the result —
 * which corrupted the CJK reply mid-stream. Streaming must never drop what it
 * was asked to send.
 */
function chunk(text, size) {
  const units = Array.from(text)
  const out = []
  for (let index = 0; index < units.length; index += size) {
    out.push(units.slice(index, index + size).join(''))
  }
  return out
}

/** Stream one scripted turn as OpenAI-style SSE. */
async function streamTurn(turn, res, model) {
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  const delta = (d) => send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: d, finish_reason: null }] })

  if (turn.reasoning !== undefined) {
    for (const piece of chunk(turn.reasoning, 24)) {
      delta({ reasoning_content: piece })
      await sleep(15)
    }
  }
  if (turn.toolCall !== undefined) {
    // The first fragment carries id and name; the rest accumulate arguments,
    // which is how the real API streams a call.
    delta({ tool_calls: [{ index: 0, id: turn.toolCall.id, type: 'function', function: { name: turn.toolCall.name, arguments: '' } }] })
    for (const piece of chunk(turn.toolCall.arguments, 20)) {
      delta({ tool_calls: [{ index: 0, function: { arguments: piece } }] })
      await sleep(10)
    }
  }
  if (turn.content !== undefined) {
    for (const piece of chunk(turn.content, 12)) {
      delta({ content: piece })
      await sleep(12)
    }
  }
  delta({ content: '' })
  send({
    id: 'chatcmpl-mock', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: turn.usage.prompt_tokens,
      completion_tokens: turn.usage.completion_tokens,
      total_tokens: turn.usage.total,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  })
  res.write('data: [DONE]\n\n')
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url.startsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  const body = await new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => resolve(text))
  })
  const request = JSON.parse(body)
  const messages = request.messages ?? []
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
  const turn = TURNS.find((candidate) => lastText.includes(candidate.match)) ?? TURNS[0]
  // A tool turn's *second* request answers with prose. Detecting that from the
  // message shape (any role:'tool' anywhere) misfires when a LATER turn runs
  // after an earlier one already used a tool — the harness feeds the whole
  // conversation back every time — so the server remembers which turn's call
  // it already emitted instead.
  const followup = turn.followupContent !== undefined && emittedTool.has(turn.match)
  const chosen = followup
    ? { ...turn, reasoning: undefined, toolCall: undefined, content: turn.followupContent }
    : turn
  if (turn.toolCall !== undefined && !followup) emittedTool.add(turn.match)
  console.log(`[mock-llm] ${req.url} model=${request.model} tools=${(request.tools ?? []).length} ` +
    `roles=${messages.map((message) => message.role).join(',')} ` +
    `turn="${turn.match}" followup=${followup} last="${lastText.slice(0, 40).replace(/\n/g, ' ')}"`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  await streamTurn(chosen, res, request.model)
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`)
})
