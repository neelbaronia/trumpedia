import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider, ProviderError, readRequestJson, safeProviderError } from '../supabase/functions/_shared/provider.mjs'
import { createLegacyHandler, legacyCorsHeaders } from '../supabase/functions/_shared/legacy-http.mjs'

function loadLocalEnvFiles() {
  for (const file of ['.env.local', '.env']) {
    const fullPath = resolve(process.cwd(), file)
    if (!existsSync(fullPath)) continue
    for (const rawLine of readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const index = line.indexOf('=')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      if (!key || process.env[key] !== undefined) continue
      let value = line.slice(index + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      process.env[key] = value
    }
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    ...legacyCorsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra,
  } })
}

async function sendResponse(res, response) {
  if (res.destroyed) return
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}

function requestBody(req) {
  let cleanup = () => {}
  return new ReadableStream({
    start(controller) {
      const data = chunk => { controller.enqueue(chunk); if (controller.desiredSize <= 0) req.pause() }
      const end = () => { cleanup(); controller.close() }
      const error = () => { cleanup(); controller.error(new Error('Request body disconnected.')) }
      cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error) }
      req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', error)
    },
    pull() { req.resume() },
    // Rejecting an oversized body must still let HTTP deliver its 413 response.
    cancel() { cleanup(); req.resume() },
  })
}

// Importing this module never reads credentials, opens a port, or calls a provider.
export function createRewriteServer({ provider, articleService, mapArticleError } = {}) {
  const rewrite = createLegacyHandler({ provider, operation: 'rewrite', requireBudget: false })
  const opinion = createLegacyHandler({ provider, operation: 'opinion', requireBudget: false })
  return createServer(async (req, res) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const disconnected = () => { if (!res.writableEnded) abort() }
    req.once('aborted', abort)
    res.once('close', disconnected)
    let response
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'OPTIONS') response = new Response(null, { status: 204, headers: legacyCorsHeaders })
      else if (req.method === 'GET' && url.pathname === '/health') response = json({ ok: true, provider: 'xai', model: provider.model, hasApiKey: provider.configured })
      else {
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        const request = new Request(url, {
          method: req.method, headers, signal: controller.signal,
          ...(!['GET', 'HEAD'].includes(req.method || 'GET') ? { body: requestBody(req), duplex: 'half' } : {}),
        })
        if (url.pathname === '/api/rewrite') response = await rewrite(request)
        else if (url.pathname === '/api/opinion') response = await opinion(request)
        else if (url.pathname === '/api/article' && req.method === 'POST' && articleService) {
          try {
            const payload = await readRequestJson(request)
            const requestKey = createHash('sha256').update(req.socket.remoteAddress || 'local').digest('hex')
            const result = await articleService.handle(payload, { requestKey })
            response = json(result)
            // Jobs outlive the browser request. Wake owns bounded worker dispatch.
            setImmediate(() => { Promise.resolve(articleService.wake()).catch(() => {}) })
          } catch (error) {
            const safe = mapArticleError && !(error instanceof ProviderError)
              ? { body: mapArticleError(error), status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503, headers: error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {} }
              : safeProviderError(error)
            response = json(safe.body, safe.status, safe.headers)
          }
        } else if (url.pathname === '/api/article' && articleService) response = json({ error: 'Use POST for articles.', retryable: false }, 405, { Allow: 'POST, OPTIONS' })
        else response = json({ error: 'Not found', retryable: false }, 404)
      }
      await sendResponse(res, response)
    } catch (error) {
      const safe = safeProviderError(error)
      if (!res.headersSent) await sendResponse(res, json(safe.body, safe.status, safe.headers))
      else res.destroy()
    } finally {
      req.off('aborted', abort)
      res.off('close', disconnected)
    }
  })
}

async function main() {
  loadLocalEnvFiles()
  const provider = createProvider({
    apiKey: process.env.ARTICLE_GENERATION_ENABLED === 'false' ? '' : process.env.XAI_API_KEY,
    model: process.env.XAI_MODEL || undefined,
    baseUrl: process.env.XAI_API_BASE_URL || undefined,
    reasoningEffort: process.env.XAI_REASONING_EFFORT || undefined,
    onMetric: metric => console.log(JSON.stringify({ event: 'provider_attempt', ...metric })),
  })
  const [{ JSDOM }, { createArticleService, createMemoryStore, safeJobError }] = await Promise.all([
    import('jsdom'), import('../supabase/functions/_shared/article-jobs.mjs'),
  ])
  const articleService = createArticleService({
    store: createMemoryStore(), provider, model: provider.model,
    parseDocument: html => new JSDOM(html).window.document,
  })
  const server = createRewriteServer({ provider, articleService, mapArticleError: safeJobError })
  server.once('close', () => articleService.close())
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  const port = Number(process.env.REWRITE_PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REWRITE_PORT must be a valid port.')
  server.listen(port, '127.0.0.1', () => console.log(`Rewrite server listening at http://127.0.0.1:${port}`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('The local generation server could not start. Check its configuration.'); process.exitCode = 1 })
}
