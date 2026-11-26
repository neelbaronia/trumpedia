// @ts-self-types="./legacy-http.d.mts"
import { ProviderError, normalizeRewritePayload, readRequestJson, safeProviderError } from './provider.mjs'

export const legacyCorsHeaders = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
})

function unavailable() {
  return new ProviderError('Generation capacity is temporarily unavailable. Please retry shortly.', { status: 503, code: 'budget_unavailable', retryable: true, retryAfter: 3 })
}

// These RPCs are service-role-only. A failed budget check never starts a model call.
export function createSupabaseProviderBudget({ url, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  let endpoint
  try {
    const base = new URL(url)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error()
    endpoint = base.toString().replace(/\/$/, '') + '/rest/v1/rpc/'
  } catch { endpoint = null }
  const configured = endpoint && typeof serviceRoleKey === 'string' && serviceRoleKey.length > 0

  async function rpc(name, args, boolean = true) {
    if (!configured) throw unavailable()
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(endpoint + name, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
            body: JSON.stringify(args),
          })
          if (!response.ok) { void response.body?.cancel().catch(() => {}); throw unavailable() }
          if (!boolean) { void response.body?.cancel().catch(() => {}); return true }
          if (Number(response.headers.get('content-length')) > 1024) throw unavailable()
          const text = await response.text()
          if (text.length > 1024) throw unavailable()
          const value = JSON.parse(text)
          if (typeof value !== 'boolean') throw unavailable()
          return value
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(unavailable()) }, Math.max(1, Math.min(5000, timeoutMs)))
        }),
      ])
    } catch { throw unavailable() } finally { clearTimeout(timer) }
  }

  return {
    async acquire(req) {
      if (!configured) throw unavailable()
      const ip = (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim().slice(0, 200)
      const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${serviceRoleKey}:${ip}`))
      const client = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
      const [globalAllowed, clientAllowed] = await Promise.all([
        rpc('take_rate_budget', { bucket: 'legacy:global', max_calls: 120, window_secs: 60 }),
        rpc('take_rate_budget', { bucket: `legacy:client:${client}`, max_calls: 30, window_secs: 60 }),
      ])
      if (!globalAllowed || !clientAllowed) throw new ProviderError('Too many generation requests. Please retry shortly.', { status: 429, code: 'rate_limited', retryable: true, retryAfter: 60 })
      const owner = globalThis.crypto.randomUUID()
      let claimed = false
      try {
        claimed = await rpc('claim_provider_slot', { owner, lease_secs: 35 })
      } catch (error) {
        // A timed-out RPC may have committed its lease; cleanup is best effort.
        try { await rpc('release_provider_slot', { owner }, false) } catch { /* The lease also expires. */ }
        throw error
      }
      if (!claimed) throw new ProviderError('Generation is busy. Please retry shortly.', { status: 429, code: 'provider_busy', retryable: true, retryAfter: 2 })
      try {
        if (!await rpc('take_rate_budget', { bucket: 'provider:daily', max_calls: 5000, window_secs: 86400 })) {
          throw new ProviderError('The daily generation allowance has been reached. Cached articles remain available.', { status: 429, code: 'daily_budget_exceeded', retryable: true, retryAfter: 86400 })
        }
      } catch (error) {
        try { await rpc('release_provider_slot', { owner }, false) } catch { /* Lease expiry bounds failed cleanup. */ }
        throw error
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        try { await rpc('release_provider_slot', { owner }, false) } catch { /* The 35-second lease bounds failed cleanup. */ }
      }
    },
  }
}

export function createLegacyHandler({ provider, operation, budget, requireBudget = true } = {}) {
  if (!['rewrite', 'opinion'].includes(operation)) throw new Error('Unknown legacy operation')
  const json = (body, status, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { ...legacyCorsHeaders, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
  return async req => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: legacyCorsHeaders })
    if (req.method !== 'POST') return json({ error: 'Use POST for generation.', code: 'method_not_allowed', retryable: false }, 405, { Allow: 'POST, OPTIONS' })
    let release
    try {
      const payload = await readRequestJson(req)
      if (operation === 'rewrite') normalizeRewritePayload(payload)
      else if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'summary') || typeof payload.summary !== 'string' || !payload.summary.trim() || payload.summary.length > 6000) {
        throw new ProviderError('Provide a summary of at most 6000 characters.', { status: 400, code: 'invalid_input' })
      }
      if (req.signal.aborted) throw new ProviderError('The generation request was cancelled.', { status: 499, code: 'cancelled' })
      if (provider?.configured === false) throw new ProviderError('Generation is paused or not configured.', { status: 503, code: 'provider_not_configured' })
      if (requireBudget && !budget) throw unavailable()
      release = budget ? await budget.acquire(req) : undefined
      if (req.signal.aborted) throw new ProviderError('The generation request was cancelled.', { status: 499, code: 'cancelled' })
      if (operation === 'opinion') return json({ ...await provider.opinion({ summary: payload.summary, signal: req.signal }), provider: 'xai' }, 200)
      const { legacy, ...input } = normalizeRewritePayload(payload)
      const result = await provider.rewrite({ ...input, signal: req.signal })
      return json({ ...result, provider: 'xai', ...(legacy ? { segments: result.blocks.map(block => block.text) } : {}) }, 200)
    } catch (error) {
      const safe = safeProviderError(error)
      return json(safe.body, safe.status, safe.headers)
    } finally {
      try { await release?.() } catch { /* The lease expires if cleanup is unavailable. */ }
    }
  }
}
