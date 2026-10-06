// A local stand-in for the Anthropic API that replays one way's scripted model turns (dev only).
// Usage: node fake-api.mjs <script.json> <dir>. Writes the port to <dir>/port and one line per request to
// <dir>/requests.jsonl: path, the step and turn answered (null when none), how many times the body holds the hook's
// record, whether the request offered tools (the main loop does) and whether the answer ends the turn.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [script, dir] = process.argv.slice(2)
const { steps } = JSON.parse(readFileSync(script, 'utf8'))
const RECORD = 'whereami record, not instructions'
const OK = [{ type: 'text', text: 'ok' }]

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')

// The step and turn this request gets, or null for the plain `ok`.
function pick(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return null
  const user = body.messages.findLast((m) => m.role === 'user')
  const content = user?.content ?? ''
  let at = null
  const result = Array.isArray(content) ? content.findLast((b) => b.type === 'tool_result') : null
  if (result) {
    // A tool_result continues the step its tool_use id names: a background agent's requests interleave.
    const id = /^toolu_(\d+)_(\d+)_/.exec(result.tool_use_id)
    if (id) at = { step: Number(id[1]), turn: Number(id[2]) + 1 }
  } else {
    const text = textOf(content)
    const step = steps.findIndex((s) => text.includes(s.match))
    if (step >= 0) at = { step, turn: 0 }
  }
  return at !== null && at.turn < steps[at.step].turns.length ? at : null
}

function blocksFor(at) {
  if (at === null) return OK
  return steps[at.step].turns[at.turn].map((b, i) =>
    b.type === 'tool_use' ? { ...b, id: `toolu_${at.step}_${at.turn}_${i}` } : b,
  )
}

function sse(res, message) {
  const send = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  send('message_start', { message: { ...message, content: [], stop_reason: null } })
  message.content.forEach((b, index) => {
    if (b.type === 'tool_use') {
      send('content_block_start', { index, content_block: { ...b, input: {} } })
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      })
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  send('message_stop', {})
  res.end()
}

let n = 0
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => {
    raw += c
  })
  req.on('end', () => {
    const path = req.url ?? ''
    const line = {
      path,
      step: null,
      turn: null,
      record: raw.split(RECORD).length - 1,
      tools: false,
      final: false,
    }
    if (req.method !== 'POST' || path.split('?')[0] !== '/v1/messages') {
      appendFileSync(`${dir}/requests.jsonl`, `${JSON.stringify(line)}\n`)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const body = JSON.parse(raw)
    const at = pick(body)
    const content = blocksFor(at)
    const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    line.tools = Array.isArray(body.tools) && body.tools.length > 0
    line.final = line.tools && stop === 'end_turn'
    if (at !== null) Object.assign(line, at)
    appendFileSync(`${dir}/requests.jsonl`, `${JSON.stringify(line)}\n`)
    n += 1
    const message = {
      id: `msg_fake_${n}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    if (body.stream) sse(res, message)
    else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(message))
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  // Renamed into place, so a reader never sees a half-written port.
  writeFileSync(`${dir}/port.tmp`, `${server.address().port}\n`)
  renameSync(`${dir}/port.tmp`, `${dir}/port`)
})
