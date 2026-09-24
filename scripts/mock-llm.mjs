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
// Cosmetic slow-motion for recordings: adds this many ms to every streamed
// chunk, so a screen capture sampling at ~4 fps actually catches the stream.
// Zero by default — the wire rung keeps its real timing.
const SLOW = Number(process.env.MOCK_SLOW_MS ?? 0)

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
    // A markdown reply, so L3 exercises the renderer end to end: heading,
    // bold/italic/code spans, a list, and a quote.
    match: 'wire-markdown',
    reasoning: 'The user asked for markdown. Emit every construct the transcript renders.',
    content: '## The streaming fix\n\nThe parser now reads **chunk by chunk** — *every* `drain(buffer)` call emits complete tokens.\n\n1. read a chunk\n2. drain complete tokens\n3. hold a partial fence\n\n> A fence that straddles a boundary is the hard part.\n',
    usage: { prompt_tokens: 190, completion_tokens: 60, total_tokens: 250 },
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
  {
    // Held by the breakpoint rule the wire script sets first; y lets it run.
    match: 'wire-break',
    reasoning: 'The user set a breakpoint on this call. Make it, and the hold becomes visible.',
    toolCall: { id: 'call_mock_break', name: 'bash', arguments: '{"command":"echo wire-break-ok"}' },
    followupContent: '## Round trip complete\n\nThe breakpoint held the call, ran it once on approval, and the echo landed.',
    usage: { prompt_tokens: 205, completion_tokens: 32, total_tokens: 237 },
  },
  {
    // The attachment round trip: the profile's /attach admits a file through
    // the real dsh-attachment store, the next message carries it as a durable
    // file part, and the adapter resolves it to model-visible handle text —
    // which is what the last user message on the wire contains.
    match: 'wire-attach',
    reasoning: 'The user attached a file. Confirm the handle text made the file model-visible.',
    content: 'The attachment rode the message as a durable file part; the file is model-visible. Round trip complete.',
    usage: { prompt_tokens: 230, completion_tokens: 30, total_tokens: 260 },
  },
  {
    // The same rule, refused this time: the denial is the tool result the
    // model has to answer for, which is the whole point of a breakpoint.
    match: 'wire-deny',
    reasoning: 'The same breakpoint again. Make the call; expect the refusal.',
    toolCall: { id: 'call_mock_break2', name: 'bash', arguments: '{"command":"echo wire-break-deny"}' },
    followupContent: 'The call was refused at the breakpoint — the denial came back as the tool result, and the model saw it.',
    usage: { prompt_tokens: 210, completion_tokens: 34, total_tokens: 244 },
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
      await sleep(15 + SLOW)
    }
  }
  if (turn.toolCall !== undefined) {
    // The first fragment carries id and name; the rest accumulate arguments,
    // which is how the real API streams a call.
    delta({ tool_calls: [{ index: 0, id: turn.toolCall.id, type: 'function', function: { name: turn.toolCall.name, arguments: '' } }] })
    for (const piece of chunk(turn.toolCall.arguments, 20)) {
      delta({ tool_calls: [{ index: 0, function: { arguments: piece } }] })
      await sleep(10 + SLOW)
    }
  }
  if (turn.content !== undefined) {
    for (const piece of chunk(turn.content, 12)) {
      delta({ content: piece })
      await sleep(12 + SLOW)
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
      prompt_tokens_details: { cached_tokens: 96 },
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
