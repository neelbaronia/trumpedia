import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

loadLocalEnvFiles()

const PORT = Number(process.env.REWRITE_PORT || 8787)
const XAI_API_KEY = process.env.XAI_API_KEY
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4-1-fast'
const XAI_API_BASE_URL = process.env.XAI_API_BASE_URL || 'https://api.x.ai/v1'

const SYSTEM_PROMPT = [
  'You are Donald Trump, current and greatest President of the United States. You rewrite wikipedia prose to make sure that it is antiwoke, MAGA, and Trumpy. You want it to sound like how you talk and tweet.',
  'Rules:',
  '- Return ONLY valid JSON: {"segments":["...", "..."]}.',
  '- The "segments" array in your response MUST have the EXACT SAME number of items as the input array. This is very important, believe me.',
  '- Do not combine segments. Do not split them. Do not add intro/outro text.',
  '- Preserve factual meaning and chronology.',
  '- Keep names, dates, places, and numbers accurate.',
  '- Keep output count exactly equal to input count and same order.',
  '- Keep roughly similar length per segment.',
  '- CRITICAL: Preserve all leading and trailing whitespace. If a segment starts or ends with a space, the rewrite MUST also start or end with a space. This is very important for sentence structure!',
  '- Opine on the topic and add your own thoughts and opinions. Try and compare everything to your own life and experiences.',
  '- You are very traditional and conservative on questions of race, gender, sexuality, and politics.',
  '- Reference your tweets and statements to add authenticity.',
].join('\n')

const OPINION_PROMPT = [
  'You are Donald Trump, current and greatest President of the United States.',
  'Read the provided summary of a Wikipedia article and provide a single, punchy, "Presidential Stance" on the topic.',
  'Your stance should be roughly 2 sentences. It must be antiwoke, MAGA, and sound like how you talk and tweet.',
  'Determine if the topic is "Tremendous" (good), "Sad/Disastrous" (bad), or "Corrupt" (very bad).',
  'Return ONLY valid JSON: {"opinion": "..."}.',
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

async function rewriteWithXai(segments, opinion = null) {
  if (!XAI_API_KEY) {
    throw new Error('XAI_API_KEY is not set.')
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ]

  if (opinion) {
    messages.push({
      role: 'system',
      content: `YOUR STANCE ON THIS TOPIC IS: ${opinion}. Every segment you rewrite must align with this opinion. If the opinion is negative, the segments should be critical. If the opinion is positive, the segments should be celebratory.`
    })
  }

  messages.push({
    role: 'user',
    content: JSON.stringify({ segments }),
  })

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
      messages,
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
  if (!Array.isArray(rewritten)) {
    throw new Error('Model returned invalid response format.')
  }

  // If the count is wrong, try to pad or trim to match input segments
  if (rewritten.length !== segments.length) {
    console.warn(`[rewrite] segment count mismatch: expected ${segments.length}, got ${rewritten.length}. Attempting to fix...`)
    const fixed = []
    for (let i = 0; i < segments.length; i++) {
      fixed.push(rewritten[i] || segments[i]) // Use original if AI missed it
    }
    return fixed
  }

  return rewritten.map((value) => String(value))
}

async function getOpinionFromXai(summary) {
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
        { role: 'system', content: OPINION_PROMPT },
        {
          role: 'user',
          content: `Summary: ${summary.slice(0, 2000)}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`xAI opinion request failed (${response.status}): ${text.slice(0, 300)}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  const parsed = JSON.parse(content)
  return parsed.opinion || "This topic is very interesting, believe me!"
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
    const startTime = Date.now()
    try {
      const body = await readJson(req)
      const segments = validateSegments(body.segments)
      const opinion = body.opinion || null
      // eslint-disable-next-line no-console
      console.log(`[rewrite] request segments=${segments.length} started with opinion=${opinion ? 'yes' : 'no'}`)
      const rewritten = await rewriteWithXai(segments, opinion)
      const duration = Date.now() - startTime
      // eslint-disable-next-line no-console
      console.log(`[rewrite] request segments=${segments.length} finished in ${duration}ms`)
      return sendJson(res, 200, {
        segments: rewritten,
        provider: 'xai',
        model: XAI_MODEL,
        duration,
      })
    } catch (error) {
      const duration = Date.now() - startTime
      // eslint-disable-next-line no-console
      console.error(`[rewrite] request failed after ${duration}ms`, error instanceof Error ? error.message : error)
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : 'Rewrite failed.',
        duration,
      })
    }
  }

  if (req.method === 'POST' && req.url === '/api/opinion') {
    const startTime = Date.now()
    try {
      const body = await readJson(req)
      const summary = body.summary || ''
      if (!summary) throw new Error('Summary is required for opinion.')

      // eslint-disable-next-line no-console
      console.log(`[opinion] request started`)
      const opinion = await getOpinionFromXai(summary)
      const duration = Date.now() - startTime
      // eslint-disable-next-line no-console
      console.log(`[opinion] request finished in ${duration}ms`)

      return sendJson(res, 200, {
        opinion,
        provider: 'xai',
        model: XAI_MODEL,
        duration,
      })
    } catch (error) {
      const duration = Date.now() - startTime
      // eslint-disable-next-line no-console
      console.error(`[opinion] request failed after ${duration}ms`, error instanceof Error ? error.message : error)
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : 'Opinion generation failed.',
        duration,
      })
    }
  }

  return sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`Rewrite server listening at http://127.0.0.1:${PORT}`)
})
