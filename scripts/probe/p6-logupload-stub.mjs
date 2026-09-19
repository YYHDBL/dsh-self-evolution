#!/usr/bin/env node
// P6 stub: local stand-in for the DeepSeek API. Records every request body to a
// JSONL file and always answers 401, so a turn fails cheaply while the exact
// request bytes are captured. No real endpoint is contacted.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.env.STUB_PORT ?? 4571)
const out = process.env.STUB_OUT ?? '/tmp/p6-stub-requests.jsonl'
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    appendFileSync(out, JSON.stringify({ path: req.url, headers: req.headers, body }) + '\n')
    const respond = () => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'p6 stub: intentional 401', code: 'stub_auth' } }))
    }
    const delay = Number(process.env.STUB_DELAY_MS ?? 0)
    if (delay > 0) setTimeout(respond, delay)
    else respond()
  })
})
server.listen(port, '127.0.0.1', () => {
  console.log(`p6 stub listening on 127.0.0.1:${port}, recording to ${out}`)
})
