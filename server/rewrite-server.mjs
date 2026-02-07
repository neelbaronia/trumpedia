import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

loadLocalEnvFiles()

const PORT = Number(process.env.REWRITE_PORT || 8787)
const XAI_API_KEY = process.env.XAI_API_KEY
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4-1-fast'
const XAI_API_BASE_URL = process.env.XAI_API_BASE_URL || 'https://api.x.ai/v1'

const SYSTEM_PROMPT = [
  'You rewrite encyclopedia prose into a satirical, bombastic political narrator voice.',
  'Rules:',
  '- Return ONLY valid JSON: {"segments":["...", "..."]}.',
  '- Preserve factual meaning and chronology.',
  '- Keep names, dates, places, and numbers accurate.',
  '- Keep output count exactly equal to input count and same order.',
  '- Keep roughly similar length per segment.',
  '- Do not add markdown or commentary.',
].join('\n')

function loadLocalEnvFiles() {
  const files = ['.env.local', '.env']
  for (const file of files) {
    const fullPath = resolve(process.cwd(), file)
    if (!existsSync(fullPath)) {
      continue
    }

    const content = readFileSync(fullPath, 'utf8')
    applyEnvContent(content)
  }
}

function applyEnvContent(content) {
  const lines = content.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const index = line.indexOf('=')
    if (index <= 0) {
      continue
    }

    const key = line.slice(0, index).trim()
    if (!key || process.env[key] !== undefined) {
      continue
    }

    let value = line.slice(index + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  })
  res.end(JSON.stringify(payload))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}

  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON body.')
  }
}

function validateSegments(input) {
  if (!Array.isArray(input)) {
    throw new Error('`segments` must be an array.')
  }
  if (input.length === 0) {
    throw new Error('`segments` must not be empty.')
  }
  if (input.length > 60) {
    throw new Error('`segments` exceeds max batch size of 60.')
  }

  return input.map((value) => String(value))
}

async function rewriteWithXai(segments) {
  if (!XAI_API_KEY) {
    throw new Error('XAI_API_KEY is not set.')
  }

  const response = await fetch(`${XAI_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      temperature: 1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ segments }),
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`xAI request failed (${response.status}): ${text.slice(0, 300)}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('xAI response did not include JSON content.')
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Model returned non-JSON output.')
  }

  const rewritten = parsed?.segments
  if (!Array.isArray(rewritten) || rewritten.length !== segments.length) {
    throw new Error('Model returned invalid segment count.')
  }

  return rewritten.map((value) => String(value))
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: 'xai',
      model: XAI_MODEL,
      hasApiKey: Boolean(XAI_API_KEY),
      baseUrl: XAI_API_BASE_URL,
    })
  }

  if (req.method === 'POST' && req.url === '/api/rewrite') {
    try {
      const body = await readJson(req)
      const segments = validateSegments(body.segments)
      const rewritten = await rewriteWithXai(segments)
      return sendJson(res, 200, {
        segments: rewritten,
        provider: 'xai',
        model: XAI_MODEL,
      })
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : 'Rewrite failed.',
      })
    }
  }

  return sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`Rewrite server listening at http://127.0.0.1:${PORT}`)
})
