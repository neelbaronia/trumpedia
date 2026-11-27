import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { DOMParser } from 'npm:linkedom@0.18.12'
import { createProvider, readRequestJson, ProviderError } from '../_shared/provider.mjs'
import { createArticleService, createSupabaseStore, ArticleServiceError, safeJobError } from '../_shared/article-jobs.mjs'
import { signWorkRequest, verifyWorkRequest } from '../_shared/worker-auth.mjs'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const url = Deno.env.get('SUPABASE_URL') || ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const workerToken = Deno.env.get('ARTICLE_WORKER_TOKEN') || ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
const model = Deno.env.get('XAI_MODEL') || undefined
const provider = createProvider({ apiKey: Deno.env.get('ARTICLE_GENERATION_ENABLED') === 'false' ? '' : Deno.env.get('XAI_API_KEY'), model, reviewModel: Deno.env.get('XAI_REVIEW_MODEL') || undefined, baseUrl: Deno.env.get('XAI_API_BASE_URL') || undefined, reasoningEffort: Deno.env.get('XAI_REASONING_EFFORT') || undefined, onMetric: metric => console.log(JSON.stringify({ event: 'provider_attempt', ...metric })) })

// Capacity failures fail closed. Only the server credential can call these SQL functions.
async function rpc(name: string, body: object): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  if (!response.ok) { await response.body?.cancel(); throw new ArticleServiceError('Generation capacity is temporarily unavailable.', 503, 'budget_unavailable', true, 3) }
  const text = await response.text()
  if (text.length > 1024) throw new ArticleServiceError('Generation capacity is temporarily unavailable.', 503, 'budget_unavailable', true, 3)
  return text ? JSON.parse(text) : null
}
async function withSlot<T>(call: () => Promise<T>): Promise<T> {
  if (!provider.configured) throw new ProviderError('Generation is paused or not configured.', { status: 503, code: 'provider_not_configured' })
  const owner = crypto.randomUUID()
  try {
    if (await rpc('claim_provider_slot', { owner, lease_secs: 90 }) !== true) throw new ProviderError('Generation is busy. Please retry shortly.', { status: 429, code: 'provider_busy', retryable: true, retryAfter: 2 })
    if (await rpc('take_rate_budget', { bucket: 'provider:daily', max_calls: 5000, window_secs: 86400 }) !== true) throw new ProviderError('The daily generation budget has been reached. Cached articles remain available.', { status: 429, code: 'daily_budget', retryable: true, retryAfter: 86400 })
    return await call()
  } finally { try { await rpc('release_provider_slot', { owner }) } catch { /* A lost response or failed cleanup still expires in 90 seconds. */ } }
}
const service = createArticleService({
  store: createSupabaseStore({ url, serviceKey }),
  provider: { model: provider.model, reviewModel: provider.reviewModel, rewrite: input => withSlot(() => provider.rewrite(input)), opinion: input => withSlot(() => provider.opinion(input)), review: input => withSlot(() => provider.review(input)) },
  parseDocument: html => new DOMParser().parseFromString(html, 'text/html'),
})
const json = (body: object, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
declare const EdgeRuntime: { waitUntil: (work: Promise<unknown>) => void }

// Each invocation is bounded. Checkpoints outlive it; the SQL leases fence stale workers.
// A single global wake budget prevents parallel polling clients from multiplying continuations.
function scheduleWork(requestStarted = Date.now()) {
  EdgeRuntime.waitUntil((async () => {
    try {
      // Slow admission must not consume the worker's platform wall-time headroom.
      // The watchdog and subsequent status requests can claim this queued work.
      if (Date.now() - requestStarted > 15000) return
      const dispatchedAt = Date.now()
      await service.dispatch()
      // Long paragraphs checkpoint into another invocation instead of adding
      // continuation sleep/network calls to a nearly spent Edge invocation.
      if (Date.now() - dispatchedAt >= 75000) return
      const delay = await service.nextWakeDelay()
      if (delay === null) return
      await new Promise(resolve => setTimeout(resolve, delay))
      if (await rpc('take_rate_budget', { bucket: 'article:wake', max_calls: 1, window_secs: 2 }) !== true) return
      const scoped = workerToken && anonKey ? await signWorkRequest({ token: workerToken }) : {}
      const gatewayKey = workerToken && anonKey ? anonKey : serviceKey
      const response = await fetch(`${url}/functions/v1/article`, { method: 'POST', headers: { Authorization: `Bearer ${gatewayKey}`, apikey: gatewayKey, ...scoped, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'work' }), signal: AbortSignal.timeout(6000) })
      await response.body?.cancel()
    } catch { console.warn('Article continuation paused; a status request will recover saved work.') }
  })())
}

serve(async req => {
  const requestStarted = Date.now()
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST for articles.', retryable: false }, 405, { Allow: 'POST, OPTIONS' })
  try {
    const payload = await readRequestJson(req) as Record<string, unknown>
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ArticleServiceError('Invalid article request.', 400, 'invalid_request', false)
    if (payload.action === 'work') {
      const internal = Boolean(serviceKey) && req.headers.get('authorization') === `Bearer ${serviceKey}`
      const scoped = await verifyWorkRequest({ token: workerToken, timestamp: req.headers.get('x-trumpedia-worker-timestamp'), signature: req.headers.get('x-trumpedia-worker-signature') })
      if (!internal && !scoped) return json({ error: 'Unauthorized.', retryable: false }, 401)
      scheduleWork(requestStarted); return json({ accepted: true }, 202)
    }
    const ip = (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim().slice(0, 200)
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${serviceKey}:${ip}`))
    const requestKey = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
    if (await rpc('take_rate_budget', { bucket: `article:requests:${requestKey}`, max_calls: 120, window_secs: 60 }) !== true) throw new ArticleServiceError('Too many article requests. Please retry shortly.', 429, 'rate_limited', true, 60)
    if (payload.action === 'start' && await rpc('take_rate_budget', { bucket: `article:starts:${requestKey}`, max_calls: 20, window_secs: 60 }) !== true) throw new ArticleServiceError('Too many article requests. Please retry shortly.', 429, 'rate_limited', true, 60)
    const result = await service.handle(payload, { requestKey })
    scheduleWork(requestStarted) // Status polling also recovers jobs after an interrupted continuation.
    return json(result)
  } catch (error) {
    const safe = error instanceof ArticleServiceError ? error : error instanceof ProviderError ? new ArticleServiceError(error.message, error.status, error.code, error.retryable, error.retryAfter) : null
    return json(safeJobError(safe), safe?.status || 503, safe?.retryAfter ? { 'Retry-After': String(safe.retryAfter) } : {})
  }
})
