// @ts-self-types="./article-jobs.d.mts"
import { PIPELINE_VERSION, parseWikipediaUrl, prepareArticle, renderArticle, validateMarkers } from './article-plan.mjs'
import { DEFAULT_MODEL, PROVIDER_PROMPT_VERSION, parseRetryAfter } from './provider.mjs'
import { assessRewrite } from './rewrite-quality.mjs'

export const ARTICLE_LIMITS = Object.freeze({ workers: 2, batches: 4, sourceBytes: 4 * 1024 * 1024, blocks: 600, runMs: 100000, jobMs: 12 * 60 * 1000, leaseMs: 140000, attempts: 3 })
const completedMetrics = (job, now) => ({ ...(job.metrics || {}), elapsedMs: Math.max(0, now - Date.parse(job.createdAt)), completedAt: iso(now) })
const terminal = status => ['complete', 'partial', 'failed'].includes(status)
// Account/configuration rejection stops automatic attempts but can recover after the operator fixes access.
const manuallyRetryable = value => Boolean(value?.retryable) || ['provider_auth', 'provider_not_configured'].includes(value?.code)
const iso = value => new Date(value).toISOString()
const clone = value => structuredClone(value)
const touch = (job, now) => iso(Math.max(now, Date.parse(job.updatedAt || 0) + 1))

export class ArticleServiceError extends Error {
  constructor(message, status = 503, code = 'service_unavailable', retryable = true, retryAfter = null) {
    super(message); this.name = 'ArticleServiceError'; Object.assign(this, { status, code, retryable, retryAfter })
  }
}

export function safeJobError(error) {
  if (error instanceof ArticleServiceError) return { error: error.message, code: error.code, retryable: error.retryable, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }
  return { error: 'The article service is temporarily unavailable. Please try again.', code: 'service_unavailable', retryable: true }
}

function failure(error, attempts = 1, now = Date.now()) {
  const status = Number(error?.status) || 503
  const retryable = typeof error?.retryable === 'boolean' ? error.retryable : status === 429 || status >= 500
  const delay = Math.max(Math.min(120000, 1000 * 2 ** Math.max(0, attempts - 1)), Number(error?.retryAfterMs) || Number(error?.retryAfter) * 1000 || 0)
  const feedback = mergeFeedback(Array.isArray(error?.feedback) ? error.feedback : [])
  const previousDraft = typeof error?.previousDraft === 'string' ? error.previousDraft.slice(0, 12000) : ''
  return { status, code: typeof error?.code === 'string' && /^[a-z_]{1,50}$/.test(error.code) ? error.code : 'upstream_error', attempts, retryable, terminal: !retryable || attempts >= ARTICLE_LIMITS.attempts, nextTryAt: iso(now + delay), ...(feedback.length ? { feedback } : {}), ...(previousDraft ? { previousDraft } : {}) }
}

function metricsFor(job) {
  const total = job.plan?.blocks.length || 0
  const completed = Object.keys(job.outputs || {}).length
  const failedCount = Object.values(job.failures || {}).filter(value => value.terminal).length
  return { completed, total, failedCount, progress: job.status === 'complete' ? 100 : total ? Math.min(99, Math.floor(completed / total * 100)) : 0 }
}

function usageAdd(job, result, stage) {
  job.metrics ||= { calls: 0, providerMs: 0, inputTokens: 0, outputTokens: 0, stages: {} }
  const m = job.metrics; m.calls++; m.providerMs += Math.max(0, Number(result.duration) || 0)
  const u = result.usage || {}
  m.inputTokens += Number(u.prompt_tokens ?? u.input_tokens) || 0
  m.outputTokens += Number(u.completion_tokens ?? u.output_tokens) || 0
  const cost = Number(u.cost_in_usd_ticks)
  m.costUsdTicks = (m.costUsdTicks || 0) + (Number.isFinite(cost) && cost >= 0 ? cost : 0)
  m.stages[stage] = (m.stages[stage] || 0) + 1
  if (typeof result.model === 'string') { m.actualModels ||= {}; m.actualModels[result.model] = (m.actualModels[result.model] || 0) + 1 }
}

function validViewpoint(value) {
  return value && typeof value === 'object' && ['admire', 'question'].every(key => typeof value[key] === 'string' && value[key].length <= 180) && Boolean(value.admire.trim() || value.question.trim())
}
const reviewedStance = job => Boolean(job.opinion && validViewpoint(job.viewpoint) && job.opinionReviewed)
function mergeFeedback(...groups) {
  const seen = new Set(); const merged = []
  for (const value of groups.flat()) {
    if (typeof value !== 'string') continue
    const note = value.trim().slice(0, 240)
    const key = note.toLowerCase().replace(/\s+/g, ' ')
    if (!key || seen.has(key)) continue
    seen.add(key); merged.push(note)
    if (merged.length === 4) break
  }
  return merged
}
function checkReview(job, result, previousDraft, sourceText) {
  if (result?.passed === true) return
  job.metrics.qualityRejections = (job.metrics.qualityRejections || 0) + 1
  const error = new ArticleServiceError('The generated passage did not pass its factual and viewpoint review.', 502, 'quality_rejected', true)
  error.feedback = Array.isArray(result?.issues) ? result.issues : []
  if (typeof sourceText === 'string' && typeof previousDraft === 'string' && error.feedback.some(issue => typeof issue === 'string' && /copy|verbatim|rephras|rewrit/i.test(issue))) {
    const phrase = assessRewrite(sourceText, previousDraft).metrics.longestCopiedPhrase
    if (phrase) error.feedback = [`Rephrase copied passage: "${phrase}". Keep facts and qualifiers.`, ...error.feedback]
  }
  if (typeof previousDraft === 'string') error.previousDraft = previousDraft
  throw error
}
function provenance(job) {
  const parts = String(job.version || '').split(':')
  const unknown = job.importedFromLegacy || job.model === 'legacy-unrecorded' || parts.length < 3
  return { pipelineVersion: unknown ? 'legacy-unknown' : parts[0], promptVersion: unknown ? 'legacy-unknown' : parts[1], model: job.model || (unknown ? 'unknown' : parts[2]), ...(!unknown && parts.length >= 4 ? { reviewModel: parts.slice(3).join(':') } : {}) }
}

function checkedOutputs(batch, result) {
  if (!Array.isArray(result?.blocks) || result.blocks.length !== batch.length) throw new ArticleServiceError('The model returned an incomplete batch.', 502, 'invalid_output')
  const expected = new Map(batch.map(block => [block.id, block.text])); const outputs = {}
  for (const block of result.blocks) {
    if (!expected.has(block.id) || Object.hasOwn(outputs, block.id) || typeof block.text !== 'string' || !block.text.trim() || block.text.length > 20000 || !validateMarkers(expected.get(block.id), block.text)) throw new ArticleServiceError('The model returned an invalid batch.', 502, 'invalid_output')
    outputs[block.id] = block.text
  }
  return outputs
}

async function readJsonBounded(response, maxBytes) {
  if (!response.ok) { await response.body?.cancel(); throw new ArticleServiceError('Wikipedia could not provide this article.', response.status === 404 ? 404 : 503, 'wikipedia_error', response.status === 429 || response.status >= 500, parseRetryAfter(response.headers.get('retry-after'))) }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new ArticleServiceError('This article is too large to generate safely.', 413, 'article_too_large', false) }
  const reader = response.body?.getReader(); if (!reader) throw new ArticleServiceError('Wikipedia returned an empty article.', 502, 'wikipedia_error')
  const chunks = []; let size = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel(); throw new ArticleServiceError('This article is too large to generate safely.', 413, 'article_too_large', false) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new ArticleServiceError('Wikipedia returned an unreadable article.', 502, 'wikipedia_error') }
}

export function createArticleService({ store, provider, parseDocument, fetchImpl = fetch, model = provider?.model || DEFAULT_MODEL, reviewModel = provider?.reviewModel || model, clock = () => Date.now(), runBudgetMs = ARTICLE_LIMITS.runMs, resolveIdentity = true } = {}) {
  if (!store || !provider || !parseDocument || typeof provider.review !== 'function') throw new TypeError('Article service requires storage, HTML parser, and a provider with semantic review.')
  const version = `${PIPELINE_VERSION}:${PROVIDER_PROMPT_VERSION}:${model}:${reviewModel}`
  let localDispatch = null; let timer = null; let stopped = false

  async function wikipediaIdentity(parsed) {
    const url = new URL(`https://${parsed.lang}.wikipedia.org/w/api.php`)
    for (const [key, value] of Object.entries({ action: 'query', format: 'json', formatversion: '2', titles: parsed.title, redirects: '1', prop: 'info', origin: '*' })) url.searchParams.set(key, value)
    const payload = await readJsonBounded(await fetchImpl(url, { headers: { 'User-Agent': 'Trumpedia/2.0 (https://trumpedia.org)' }, signal: AbortSignal.timeout(15000) }), 256 * 1024)
    const page = payload.query?.pages?.[0]
    if (!page || page.missing || page.invalid || page.ns !== 0) throw new ArticleServiceError('Choose an existing encyclopedia article.', 404, 'article_not_found', false)
    const canonical = parseWikipediaUrl(`https://${parsed.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_')).replace(/%2F/gi, '/')}`)
    return { ...canonical, sourcePageId: page.pageid, sourceRevisionId: page.lastrevid || null }
  }

  function publicResult(job, includeArticle = true) {
    const counts = job.plan ? metricsFor(job) : { progress: job.progress || 0, completed: job.completed || 0, total: job.total || 0, failedCount: job.failedCount || 0 }
    const result = { jobId: job.id, version: job.version || 'unknown', outdated: job.version !== version || Boolean(job.importedFromLegacy), status: job.status, updatedAt: job.updatedAt, ...counts, retryable: job.version === version && !job.importedFromLegacy && ['partial', 'failed'].includes(job.status) && job.retryable !== false }
    if (job.error) result.error = job.error
    if (includeArticle && job.plan && (counts.completed || counts.total === 0)) {
      const failedIds = Object.entries(job.failures || {}).filter(([, value]) => value.terminal).map(([id]) => id)
      const rendered = renderArticle(job.plan, job.outputs, { finished: terminal(job.status), failedIds })
      result.article = { title: job.title, canonicalUrl: job.url, sourceApiUrl: job.sourceApiUrl || job.url, rewriteMode: rendered.rewriteMode, opinion: job.opinion || '', sections: rendered.sections, status: job.status, jobId: job.id, failedCount: rendered.failedCount, metrics: job.metrics || {}, ...provenance(job), sourcePageId: job.sourcePageId || null, sourceRevisionId: job.sourceRevisionId || null, importedFromLegacy: Boolean(job.importedFromLegacy) }
    }
    return result
  }

  async function start({ url }, context = {}) {
    const admissionBegan = clock()
    const reused = job => { const result = publicResult(job); result.cacheHit = true; if (result.article) result.article.metrics = { ...result.article.metrics, cacheHit: true, cacheLookupMs: Math.max(0, clock() - admissionBegan) }; return result }
    let parsed
    try { parsed = parseWikipediaUrl(url) } catch (error) { throw new ArticleServiceError(error.message, 400, 'invalid_url', false) }
    let existing = await store.find(parsed.canonicalUrl, version)
    if (existing) return reused(existing)
    const alias = await store.alias?.(parsed.canonicalUrl)
    if (alias) { existing = await store.find(alias, version); if (existing) return reused(existing) }
    const aliasUrl = parsed.canonicalUrl
    if (resolveIdentity) parsed = await wikipediaIdentity(parsed)
    const now = clock()
    const job = await store.admit({ id: crypto.randomUUID(), url: parsed.canonicalUrl, lang: parsed.lang, title: parsed.title, version, status: 'queued', createdAt: iso(now), updatedAt: iso(now), nextRunAt: iso(now), deadlineAt: iso(now + ARTICLE_LIMITS.jobMs), model, sourcePageId: parsed.sourcePageId || null, sourceRevisionId: parsed.sourceRevisionId || null, sourceApiUrl: '', importedFromLegacy: false, plan: null, outputs: {}, opinion: '', viewpoint: null, opinionReviewed: false, failures: {}, revisionContext: {}, opinionRevisionContext: {}, pendingDrafts: {}, pendingOpinion: null, opinionFailure: null, sourceFailure: null, metrics: { calls: 0, providerMs: 0, inputTokens: 0, outputTokens: 0, stages: {}, costUsdTicks: 0, cachePath: 'fresh', admissionMs: Math.max(0, clock() - admissionBegan) }, retryable: true }, { aliasUrl, requestKey: context.requestKey || 'unknown', paid: true })
    return publicResult(job)
  }

  async function status({ jobId, updatedAt }) {
    if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new ArticleServiceError('Invalid article job.', 400, 'invalid_job', false)
    const head = await store.read(jobId, true)
    if (!head) throw new ArticleServiceError('Article job not found.', 404, 'job_not_found', false)
    if (updatedAt && updatedAt === head.updatedAt) return { ...publicResult(head, false), unchanged: true }
    return publicResult(await store.read(jobId))
  }

  async function retry({ jobId, url }, context = {}) {
    if (!jobId && url) {
      let parsed
      try { parsed = parseWikipediaUrl(url) } catch (error) { throw new ArticleServiceError(error.message, 400, 'invalid_url', false) }
      const alias = await store.alias?.(parsed.canonicalUrl)
      const existing = await store.find(alias || parsed.canonicalUrl, version)
      if (!existing) return start({ url }, context)
      jobId = existing.id
    }
    if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new ArticleServiceError('Invalid article job.', 400, 'invalid_job', false)
    const existing = await store.read(jobId, true)
    if (existing && (existing.version !== version || existing.importedFromLegacy)) throw new ArticleServiceError(`This saved rewrite uses an older version. Open ${existing.url} to request the latest rewrite.`, 409, 'job_version_outdated', false)
    const job = await store.retry(jobId)
    if (!job) throw new ArticleServiceError('Article job not found.', 404, 'job_not_found', false)
    return publicResult(job)
  }

  async function recent() { return { articles: await store.recent(version, 20) } }
  async function handle(payload, context = {}) {
    if (!payload || typeof payload !== 'object') throw new ArticleServiceError('Invalid request.', 400, 'invalid_request', false)
    switch (payload.action) { case 'start': return start(payload, context); case 'status': return status(payload); case 'retry': return retry(payload, context); case 'recent': return recent(); default: throw new ArticleServiceError('Unknown article action.', 400, 'invalid_action', false) }
  }

  async function runClaim(claim) {
    const job = claim.job; const token = claim.token; const began = clock(); const controller = new AbortController()
    if (job.version !== version || job.importedFromLegacy) {
      await store.finish(job.id, token, { status: Object.keys(job.outputs || {}).length ? 'partial' : 'failed', error: `This saved rewrite uses an older version. Open ${job.url} to request the latest rewrite.`, retryable: false })
      return
    }
    job.metrics ||= { calls: 0, providerMs: 0, inputTokens: 0, outputTokens: 0, stages: {} }
    job.metrics.queueWaitMs ??= Math.max(0, began - Date.parse(job.createdAt))
    const abortTimer = setTimeout(() => controller.abort(), runBudgetMs)
    let writes = Promise.resolve()
    const save = (patch = {}, outputPatch = {}, pendingPatch = {}) => {
      writes = writes.then(async () => {
        Object.assign(job, patch); Object.assign(job.outputs, outputPatch)
        job.pendingDrafts ||= {}
        for (const [id, draft] of Object.entries(pendingPatch)) {
          if (draft === null) delete job.pendingDrafts[id]
          else job.pendingDrafts[id] = draft
        }
        if (Object.keys(outputPatch).length) { job.metrics.firstBatchMs ??= Math.max(0, clock() - Date.parse(job.createdAt)); if (job.plan.sections.some(section => section.blockIds.length && section.blockIds.every(id => Object.hasOwn(job.outputs, id)))) job.metrics.firstSectionMs ??= Math.max(0, clock() - Date.parse(job.createdAt)) }
        const metadata = { ...patch, metrics: clone(job.metrics), failures: clone(job.failures), revisionContext: clone(job.revisionContext || {}), opinionRevisionContext: clone(job.opinionRevisionContext || {}), pendingDrafts: clone(job.pendingDrafts), pendingOpinion: job.pendingOpinion || null, opinionFailure: job.opinionFailure, sourceFailure: job.sourceFailure }
        const saved = await store.checkpoint(job.id, token, metadata, outputPatch)
        job.updatedAt = saved.updatedAt
      })
      return writes
    }
    const canCall = () => clock() - began <= runBudgetMs - 90000 && clock() < Date.parse(job.deadlineAt) && !controller.signal.aborted
    const failedAttempt = error => { if (typeof error?.duration === 'number') { usageAdd(job, error, 'failed'); job.metrics.failedCalls = (job.metrics.failedCalls || 0) + 1 } }
    const failBatch = async (batch, error, clearPending = false) => {
      failedAttempt(error)
      if (controller.signal.aborted && error.code !== 'quality_rejected') { await save(); return }
      for (const block of batch) {
        const previous = job.revisionContext?.[block.id] || job.failures[block.id] || {}
        const saved = failure(error, (job.failures[block.id]?.attempts || 0) + 1, clock())
        const feedback = mergeFeedback(saved.feedback || [], previous.feedback || [])
        if (feedback.length) saved.feedback = feedback
        if (!saved.previousDraft && previous.previousDraft) saved.previousDraft = previous.previousDraft
        job.failures[block.id] = saved
        if (saved.feedback || saved.previousDraft) {
          job.revisionContext ||= {}
          job.revisionContext[block.id] = { ...(saved.feedback ? { feedback: saved.feedback } : {}), ...(saved.previousDraft ? { previousDraft: saved.previousDraft } : {}) }
        }
      }
      await save({}, {}, clearPending ? Object.fromEntries(batch.map(block => [block.id, null])) : {})
    }
    try {
      if (Date.parse(job.deadlineAt) <= clock()) {
        await store.finish(job.id, token, { status: Object.keys(job.outputs).length ? 'partial' : 'failed', error: 'The generation deadline was reached. Completed sections are saved; retry to finish.', retryable: true })
        return
      }
      if (!job.plan) {
        if (!canCall()) return
        try {
          const sourceBegan = clock()
          const api = new URL(`https://${job.lang}.wikipedia.org/w/api.php`)
          for (const [key, value] of Object.entries({ action: 'parse', format: 'json', formatversion: '2', prop: 'text|displaytitle|revid', redirects: '1', origin: '*' })) api.searchParams.set(key, value)
          api.searchParams.set(job.sourceRevisionId ? 'oldid' : 'page', job.sourceRevisionId ? String(job.sourceRevisionId) : parseWikipediaUrl(job.url).title)
          const payload = await readJsonBounded(await fetchImpl(api, { headers: { 'User-Agent': 'Trumpedia/2.0 (https://trumpedia.org)' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }), ARTICLE_LIMITS.sourceBytes)
          const raw = typeof payload.parse?.text === 'string' ? payload.parse.text : payload.parse?.text?.['*']
          if (!raw) throw new ArticleServiceError('Wikipedia could not provide this article.', 404, 'article_not_found', false)
          job.metrics.sourceFetchMs = Math.max(0, clock() - sourceBegan)
          const planBegan = clock()
          const plan = prepareArticle(raw, job.lang, parseDocument)
          job.metrics.planMs = Math.max(0, clock() - planBegan)
          if (plan.blocks.length > ARTICLE_LIMITS.blocks) throw new ArticleServiceError('This article exceeds the generation limit.', 413, 'article_too_large', false)
          const titleDoc = parseDocument(`<html><body><div>${payload.parse.displaytitle || payload.parse.title || job.title}</div></body></html>`)
          await save({ plan, title: titleDoc.body?.textContent?.trim() || job.title, sourceApiUrl: api.toString(), sourcePageId: payload.parse.pageid || job.sourcePageId, sourceRevisionId: payload.parse.revid || job.sourceRevisionId, sourceFailure: null })
        } catch (error) {
          if (controller.signal.aborted) { await save(); return }
          job.sourceFailure = failure(error, (job.sourceFailure?.attempts || 0) + 1, clock()); await save()
          if (job.sourceFailure.terminal) { await store.finish(job.id, token, { status: 'failed', error: 'The source article could not be loaded. Please try again later.', retryable: job.sourceFailure.retryable }); return }
          return
        }
      }
      if (!job.plan.blocks.length) {
        job.opinion ||= 'This article has no prose available for a parody rewrite.'
        await save({ opinion: job.opinion }); await store.finish(job.id, token, { status: 'complete', error: null }); return
      }
      while (canCall()) {
        if (Date.parse(job.deadlineAt) <= clock()) break
        const pending = job.plan.blocks.filter(block => !Object.hasOwn(job.outputs, block.id) && !job.failures[block.id]?.terminal && (!job.failures[block.id]?.nextTryAt || Date.parse(job.failures[block.id].nextTryAt) <= clock()))
        if (!reviewedStance(job) && !job.opinionFailure?.terminal) {
          if (job.opinionFailure?.nextTryAt && Date.parse(job.opinionFailure.nextTryAt) > clock()) break
          try {
            const summary = `${job.title}\n${job.plan.summary || ''}`.slice(0, 6000)
            if (!job.pendingOpinion) {
              const revisionNotes = job.opinionFailure?.feedback || job.opinionRevisionContext?.feedback || []
              const previousDraft = (job.opinionFailure?.previousDraft || job.opinionRevisionContext?.previousDraft)?.slice(0, 600)
              const result = await provider.opinion({ summary, ...(revisionNotes.length ? { revisionNotes } : {}), ...(previousDraft ? { previousDraft } : {}), signal: controller.signal })
              usageAdd(job, result, 'opinion')
              if (typeof result.opinion !== 'string' || !result.opinion.trim() || !validViewpoint(result.viewpoint)) throw new ArticleServiceError('The model omitted its stance or viewpoint.', 502, 'invalid_output')
              await save({ pendingOpinion: { opinion: result.opinion.slice(0, 600), viewpoint: clone(result.viewpoint) } })
              if (!canCall()) break
            }
            const candidate = job.pendingOpinion
            const review = await provider.review({ kind: 'opinion', summary, opinion: candidate.opinion, viewpoint: candidate.viewpoint, signal: controller.signal })
            usageAdd(job, review, 'opinion-review'); checkReview(job, review, candidate.opinion)
            await save({ opinion: candidate.opinion, viewpoint: clone(candidate.viewpoint), opinionReviewed: true, pendingOpinion: null, opinionFailure: null, opinionRevisionContext: {} })
          } catch (error) {
            failedAttempt(error)
            if (controller.signal.aborted && error.code !== 'quality_rejected') { await save(); return }
            const previous = job.opinionRevisionContext || job.opinionFailure || {}
            const saved = failure(error, (job.opinionFailure?.attempts || 0) + 1, clock())
            const feedback = mergeFeedback(saved.feedback || [], previous.feedback || [])
            if (feedback.length) saved.feedback = feedback
            if (!saved.previousDraft && previous.previousDraft) saved.previousDraft = previous.previousDraft
            if (saved.previousDraft) saved.previousDraft = saved.previousDraft.slice(0, 600)
            job.opinionFailure = saved
            if (saved.feedback || saved.previousDraft) job.opinionRevisionContext = { ...(saved.feedback ? { feedback: saved.feedback } : {}), ...(saved.previousDraft ? { previousDraft: saved.previousDraft } : {}) }
            await save(error.code === 'quality_rejected' ? { pendingOpinion: null } : {}); break
          }
          continue
        }
        if (!pending.length || !reviewedStance(job)) break
        const batches = pending.slice(0, ARTICLE_LIMITS.batches).map(block => [block])
        await Promise.all(batches.map(async batch => {
          try {
            const blocks = batch.map(({ id, text }) => ({ id, text }))
            const id = batch[0].id
            if (!job.pendingDrafts?.[id]) {
              const revisionNotes = batch.flatMap(block => job.failures[block.id]?.feedback || job.revisionContext?.[block.id]?.feedback || []).slice(0, 4)
              const previousDraft = job.failures[id]?.previousDraft || job.revisionContext?.[id]?.previousDraft
              const result = await provider.rewrite({ blocks, viewpoint: job.viewpoint, ...(revisionNotes.length ? { revisionNotes } : {}), ...(previousDraft ? { previousDraft } : {}), signal: controller.signal })
              usageAdd(job, result, 'body')
              const drafts = checkedOutputs(batch, result)
              await save({}, {}, drafts)
              if (!canCall()) return
            }
            const rewritten = batch.map(block => ({ id: block.id, text: job.pendingDrafts[block.id] }))
            const review = await provider.review({ kind: 'rewrite', blocks, rewritten, opinion: job.opinion, viewpoint: job.viewpoint, summary: job.plan.summary, signal: controller.signal })
            usageAdd(job, review, 'review'); checkReview(job, review, rewritten[0]?.text, blocks[0]?.text)
            for (const block of batch) { delete job.failures[block.id]; if (job.revisionContext) delete job.revisionContext[block.id] }
            await save({}, Object.fromEntries(rewritten.map(block => [block.id, block.text])), Object.fromEntries(batch.map(block => [block.id, null])))
          } catch (error) { await failBatch(batch, error, error.code === 'quality_rejected') }
        }))
      }
      await writes
      const missing = job.plan.blocks.filter(block => !Object.hasOwn(job.outputs, block.id))
      const retryableMissing = missing.some(block => !job.failures[block.id]?.terminal)
      const opinionPending = !reviewedStance(job) && !job.opinionFailure?.terminal
      if (!missing.length && reviewedStance(job)) await store.finish(job.id, token, { status: 'complete', error: null, retryable: false })
      else if ((!retryableMissing && !opinionPending) || (!reviewedStance(job) && job.opinionFailure?.terminal)) await store.finish(job.id, token, { status: Object.keys(job.outputs).length ? 'partial' : 'failed', error: Object.keys(job.outputs).length ? 'Some sections could not be generated. Completed sections are saved.' : 'Generation is temporarily unavailable. No rewritten passages were saved. Please try again later.', retryable: [...Object.values(job.failures), job.opinionFailure].some(manuallyRetryable) })
    } catch (error) {
      if (error?.code === 'stale_lease') return
      if (!controller.signal.aborted) await store.checkpoint(job.id, token, { error: 'Generation paused after a temporary service error.', retryable: true }, {}).catch(() => {})
    } finally {
      clearTimeout(abortTimer)
      const pendingTimes = [...Object.values(job.failures), job.opinionFailure, job.sourceFailure].filter(value => value && !value.terminal).map(value => Date.parse(value.nextTryAt))
      // Wake at the job deadline rather than retry earlier than an upstream Retry-After.
      const eligibleBody = job.plan?.blocks.some(block => !Object.hasOwn(job.outputs, block.id) && !job.failures[block.id]?.terminal && (!job.failures[block.id]?.nextTryAt || Date.parse(job.failures[block.id].nextTryAt) <= clock()))
      const eligibleOpinion = job.plan && !reviewedStance(job) && !job.opinionFailure?.terminal && (!job.opinionFailure?.nextTryAt || Date.parse(job.opinionFailure.nextTryAt) <= clock())
      const eligibleSource = !job.plan && !job.sourceFailure?.terminal && (!job.sourceFailure?.nextTryAt || Date.parse(job.sourceFailure.nextTryAt) <= clock())
      const stanceReady = reviewedStance(job) || (!job.opinionFailure?.terminal && (!job.opinionFailure?.nextTryAt || Date.parse(job.opinionFailure.nextTryAt) <= clock()))
      if (eligibleSource || eligibleOpinion || eligibleBody && stanceReady) pendingTimes.push(clock())
      pendingTimes.push(Date.parse(job.deadlineAt))
      await store.release(job.id, token, iso(Math.max(clock(), pendingTimes.length ? Math.min(...pendingTimes) : clock()))).catch(() => {})
    }
  }

  async function dispatch() {
    if (localDispatch) return localDispatch
    localDispatch = Promise.all(Array.from({ length: ARTICLE_LIMITS.workers }, async () => { const claim = await store.claim(crypto.randomUUID()); if (claim) await runClaim(claim) })).finally(() => { localDispatch = null })
    return localDispatch
  }
  async function nextWakeDelay() { const at = await store.nextWake(); return at == null ? null : Math.min(15000, Math.max(100, Date.parse(at) - clock())) }
  function wake() {
    if (stopped || timer || localDispatch) return
    timer = setTimeout(async () => {
      timer = null
      try { await dispatch(); const delay = await nextWakeDelay(); if (delay != null && !stopped) { timer = setTimeout(() => { timer = null; wake() }, delay); timer.unref?.() } } catch { if (!stopped) { timer = setTimeout(() => { timer = null; wake() }, 2000); timer.unref?.() } }
    }, 0)
    timer.unref?.()
  }
  function close() { stopped = true; if (timer) clearTimeout(timer); timer = null }
  return { handle, start, status, retry, recent, dispatch, nextWakeDelay, wake, close, version, publicResult }
}

export function createMemoryStore({ legacyArticles = [], clock = () => Date.now(), maxQueued = 20, maxNewPerMinute = 6, maxNewPerDay = 100, maxPerClientMinute = 3 } = {}) {
  const jobs = new Map(); const aliases = new Map(); const legacy = new Map(legacyArticles.map(row => [row.url, clone(row)])); const slots = new Map()
  const byKey = (url, version) => [...jobs.values()].find(job => job.url === url && job.version === version)
  const guarded = (id, token) => { const job = jobs.get(id); if (!job || job.leaseToken !== token || Date.parse(job.leaseExpiresAt) <= clock()) throw new ArticleServiceError('Worker lease expired.', 409, 'stale_lease', false); return job }
  const meta = job => { const value = clone(job); delete value.plan; delete value.outputs; return { ...value, ...metricsFor(job) } }
  return {
    async find(url, version) { const job = byKey(url, version); return job ? clone(job) : null },
    async alias(url) { return aliases.get(url) || null },
    async legacy(url) { return clone(legacy.get(url) || null) },
    async read(id, head = false) { const job = jobs.get(id); return job ? head ? meta(job) : clone(job) : null },
    async admit(job, { aliasUrl, requestKey, paid }) {
      const existing = byKey(job.url, job.version); if (existing) { aliases.set(aliasUrl, job.url); return clone(existing) }
      const now = clock(); const paidJobs = [...jobs.values()].filter(value => value.paid)
      if (paid && ([...jobs.values()].filter(value => !terminal(value.status)).length >= maxQueued || paidJobs.filter(value => Date.parse(value.createdAt) > now - 60000).length >= maxNewPerMinute || paidJobs.filter(value => Date.parse(value.createdAt) > now - 86400000).length >= maxNewPerDay || paidJobs.filter(value => value.requestKey === requestKey && Date.parse(value.createdAt) > now - 60000).length >= maxPerClientMinute)) throw new ArticleServiceError('The generation queue is full. Cached articles remain available; try again later.', 429, 'queue_limit', true, 60)
      const saved = { ...clone(job), paid, requestKey, manualRetries: 0, retryWindowAt: iso(now) }; jobs.set(job.id, saved); aliases.set(aliasUrl, job.url); return clone(saved)
    },
    async claim(owner) {
      const now = clock()
      for (const [id, slot] of slots) if (slot.expires <= now) slots.delete(id)
      if (slots.size >= ARTICLE_LIMITS.workers) return null
      const job = [...jobs.values()].filter(value => value.status === 'queued' && Date.parse(value.nextRunAt) <= now || value.status === 'running' && Date.parse(value.leaseExpiresAt) <= now).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!job) return null
      job.status = 'running'; job.leaseToken = owner; job.leaseExpiresAt = iso(now + ARTICLE_LIMITS.leaseMs); job.updatedAt = touch(job, now); slots.set(owner, { expires: now + ARTICLE_LIMITS.leaseMs }); return { job: clone(job), token: owner }
    },
    async checkpoint(id, token, patch, outputs) { const job = guarded(id, token); const oldOutputs = job.outputs; Object.assign(job, clone(patch)); job.outputs = { ...oldOutputs, ...clone(outputs) }; job.updatedAt = touch(job, clock()); job.leaseExpiresAt = iso(clock() + ARTICLE_LIMITS.leaseMs); slots.set(token, { expires: clock() + ARTICLE_LIMITS.leaseMs }); return { updatedAt: job.updatedAt } },
    async finish(id, token, patch, article) { const job = guarded(id, token); Object.assign(job, clone(patch)); job.metrics = completedMetrics(job, clock()); job.article = clone(article); job.updatedAt = touch(job, clock()); slots.delete(token); job.leaseToken = null },
    async release(id, token, nextRunAt) { const job = jobs.get(id); if (job?.leaseToken !== token) return; slots.delete(token); job.leaseToken = null; if (job.status === 'running') { job.status = 'queued'; job.nextRunAt = nextRunAt; job.updatedAt = iso(clock()) } },
    async retry(id) { const job = jobs.get(id); if (!job || !['partial','failed'].includes(job.status) || job.retryable === false) return job ? clone(job) : null; if ([...jobs.values()].filter(value => !terminal(value.status)).length >= maxQueued) throw new ArticleServiceError('The generation queue is full. Try again later.', 429, 'queue_limit', true, 60); if (clock() - Date.parse(job.retryWindowAt) > 86400000) job.manualRetries = 0; if (job.manualRetries >= 3) throw new ArticleServiceError('This article has reached its retry limit. Try again tomorrow.', 429, 'retry_limit', true, 3600); job.manualRetries++; if (job.manualRetries === 1) job.retryWindowAt = iso(clock()); job.failures = {}; job.opinionFailure = null; job.sourceFailure = null; job.error = null; job.status = 'queued'; job.retryable = true; job.nextRunAt = iso(clock()); job.deadlineAt = iso(clock() + ARTICLE_LIMITS.jobMs); job.updatedAt = touch(job, clock()); return clone(job) },
    async recent(version, limit) { return [...jobs.values()].filter(job => job.status === 'complete' && job.version === version && !job.importedFromLegacy).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(job => ({ url: job.url, title: job.title, jobId: job.id })) },
    async nextWake() { const times = [...jobs.values()].filter(job => !terminal(job.status)).map(job => job.status === 'running' ? job.leaseExpiresAt : job.nextRunAt); return times.length ? times.sort()[0] : null },
    snapshot() { return [...jobs.values()].map(clone) },
  }
}

function decodeJob(row, head = false) {
  if (!row) return null
  return { ...(head ? {} : row.state || {}), id: row.id, url: row.url, version: row.version, lang: row.lang, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, nextRunAt: row.next_run_at, deadlineAt: row.deadline_at, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at, progress: row.progress, completed: row.completed, total: row.total, failedCount: row.failed_count, retryable: row.retryable, error: row.error }
}

export function createSupabaseStore({ url, serviceKey, fetchImpl = fetch } = {}) {
  if (!url || !serviceKey) throw new TypeError('Server storage credentials are required.')
  const base = url.replace(/\/$/, '') + '/rest/v1'; const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }
  async function call(path, body) {
    const response = await fetchImpl(base + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      let code = ''; try { code = (await response.json()).code || '' } catch {}
      if (code === 'P0003') throw new ArticleServiceError('The generation queue is full. Please try again later.', 429, 'queue_limit', true, 60)
      if (code === 'P0004') throw new ArticleServiceError('This article has reached its retry limit. Try again later.', 429, 'retry_limit', true, 3600)
      if (code === 'P0002') throw new ArticleServiceError('Worker lease expired.', 409, 'stale_lease', false)
      throw new ArticleServiceError('Article storage is temporarily unavailable.', 503, 'storage_unavailable')
    }
    if (response.status === 204) return null
    const text = await response.text(); return text ? JSON.parse(text) : null
  }
  const rpc = (name, body) => call('/rpc/' + name, body)
  const query = value => encodeURIComponent(value)
  const metadata = 'id,url,version,lang,title,status,created_at,updated_at,next_run_at,deadline_at,lease_token,lease_expires_at,progress,completed,total,failed_count,retryable,error'
  return {
    async find(url, version) { const rows = await call(`/article_jobs?url=eq.${query(url)}&version=eq.${query(version)}&select=*&limit=1`); return decodeJob(rows?.[0]) },
    async alias(url) { const rows = await call(`/article_aliases?alias_url=eq.${query(url)}&select=url&limit=1`); return rows?.[0]?.url || null },
    async legacy(url) { const rows = await call(`/articles?url=eq.${query(url)}&select=url,title,html,opinion,rewrite_mode,source_api_url&limit=1`); return rows?.[0] || null },
    async read(id, head = false) { const rows = await call(`/article_jobs?id=eq.${query(id)}&select=${head ? metadata : '*'}&limit=1`); return decodeJob(rows?.[0], head) },
    async admit(job, options) { return decodeJob(await rpc('admit_article_job', { initial_job: job, alias_url: options.aliasUrl, request_key: options.requestKey, paid: options.paid })) },
    async claim(owner) { const row = await rpc('claim_article_job', { owner }); return row ? { job: decodeJob(row), token: owner } : null },
    async checkpoint(id, token, patch, outputs) { const result = await rpc('checkpoint_article_job', { job_id: id, owner: token, patch, output_patch: outputs }); return { updatedAt: result.updated_at } },
    async finish(id, token, patch, article) { return rpc('finish_article_job', { job_id: id, owner: token, patch, article: article || null }) },
    async release(id, token, nextRunAt) { return rpc('release_article_job', { job_id: id, owner: token, next_run: nextRunAt }) },
    async retry(id) { return decodeJob(await rpc('retry_article_job', { job_id: id })) },
    async recent(version, limit) { const rows = await call(`/article_jobs?status=eq.complete&version=eq.${query(version)}&select=id,url,title&order=updated_at.desc&limit=${limit}`); return rows.map(row => ({ url: row.url, title: row.title, jobId: row.id })) },
    async nextWake() { return rpc('next_article_wake', {}) },
  }
}
