import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createArticleService, createMemoryStore, ArticleServiceError, ARTICLE_LIMITS, createSupabaseStore } from '../supabase/functions/_shared/article-jobs.mjs'
import { createProvider } from '../supabase/functions/_shared/provider.mjs'
import { prepareArticle } from '../supabase/functions/_shared/article-plan.mjs'
const viewpoint = { admire: 'practical skill', question: 'unnecessary fuss' }
const parseDocument = html => new JSDOM(html).window.document
const sentence = 'This is an important encyclopedia paragraph containing detailed information about the topic and its historical context.'
const source = count => Array.from({ length: count }, (_, i) => `${i % 12 === 0 && i ? `<h2>Section ${i}</h2>` : ''}<p>${i}: ${sentence} <a href="/wiki/History">historical source</a>.</p>`).join('')
const completion = result => new Response(JSON.stringify({ model: 'actual-test-model', usage: { prompt_tokens: 25, completion_tokens: 15, cost_in_usd_ticks: 100 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { headers: { 'Content-Type': 'application/json' } })
function fixture({ html = source(30), legacyArticles = [], providerHook, reviewHook, sourceHook, clock, store: suppliedStore, resolveIdentity = false, limits = {}, model, reviewModel } = {}) {
  let now = Date.parse('2026-11-25T12:00:00Z')
  const getNow = clock || (() => now)
  const calls = []; const reviews = []; const sourceCalls = []
  const provider = createProvider({ apiKey: 'mock-key', ...(model ? { model } : {}), ...(reviewModel ? { reviewModel } : {}), fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); const wire = JSON.parse(payload.messages.at(-1).content)
    const schema = payload.response_format.json_schema.schema
    const ctx = { now: getNow(), advance: duration => { now += duration }, atLeast: at => { now = Math.max(now, at) } }
    if (schema.properties.facts_preserved) {
      const review = wire.kind === 'opinion'
        ? { kind: wire.kind, summary: wire.source_summary, opinion: wire.candidate_opinion, viewpoint: wire.editorial_policy }
        : { kind: wire.kind, blocks: wire.source_paragraphs, rewritten: wire.candidate_paragraphs, viewpoint: wire.article_viewpoint }
      reviews.push(review)
      const result = await reviewHook?.(review, ctx)
      if (result instanceof Response) return result
      const verdict = result || { facts_preserved: true, point_of_view_consistent: true, substantive_rewrite: true, issues: [] }
      const preserved = verdict.facts_preserved !== false
      const checks = review.kind === 'opinion'
        ? [{ source_fact: preserved ? 'Subjective preference; no factual premise' : review.summary.slice(0, 240), candidate_support: review.opinion.slice(0, 240), preserved }]
        : review.blocks.map(block => ({ source_fact: block.text.slice(0, 240), candidate_support: review.rewritten.find(candidate => candidate.id === block.id).text.slice(0, 240), preserved }))
      return completion({ checks, ...verdict })
    }
    const input = wire.source_paragraphs
      ? { blocks: wire.source_paragraphs.map(({ id, source }) => ({ id, text: source })), viewpoint: wire.article_viewpoint, ...(wire.prior_review_issues ? { revisionNotes: wire.prior_review_issues } : {}), ...(wire.previous_draft ? { previousDraft: wire.previous_draft } : {}) }
      : wire
    calls.push(input)
    const result = await providerHook?.(input, ctx)
    if (result instanceof Response) return result
    const output = result || (input.blocks
      ? { blocks: input.blocks.map(block => ({ ...block, text: block.text.replaceAll(sentence, 'Here is a tremendous encyclopedia paragraph: I get a detailed account of this topic and its history, with useful information laid out for me.') })) }
      : { opinion: 'A tremendous topic. Believe me.', viewpoint: { ...viewpoint } })
    if (schema.properties.paragraphs && output.blocks) return completion({ paragraphs: output.blocks.map(({ id, text }) => ({ id, notes: ['The source gives a detailed account of this topic and its history.'], rewritten: text })) })
    return completion(output)
  } })
  const store = suppliedStore || createMemoryStore({ legacyArticles, clock: getNow, ...limits })
  const service = createArticleService({ store, provider, parseDocument, clock: getNow, resolveIdentity, fetchImpl: async url => { sourceCalls.push(String(url)); if (sourceHook) return sourceHook(url); return new Response(JSON.stringify(String(url).includes('action=query') ? { query: { pages: [{ pageid: 1, title: 'Canonical', ns: 0, lastrevid: 12 }] } } : { parse: { title: 'Test', pageid: 1, revid: 12, text: html, displaytitle: '<i>Test</i>' } })) } })
  return { service, store, calls, reviews, sourceCalls, provider, advance: duration => { now += duration }, now: getNow }
}
const wiki = title => `https://en.wikipedia.org/wiki/${title}`

test('one admission caches a standalone display opinion and rewrites each body block independently of its stance', async () => {
  const { service, calls, store, sourceCalls } = fixture()
  const starts = await Promise.all([service.start({ url: wiki('Test') }), service.start({ url: 'https://en.m.wikipedia.org/wiki/Test#History' })])
  assert.equal(starts[0].jobId, starts[1].jobId); assert.equal(store.snapshot().length, 1)
  await service.dispatch()
  const final = await service.status(starts[0]); assert.equal(final.status, 'complete')
  assert.equal(calls.length, 31); assert.ok(calls[0].summary); assert.equal(calls[0].blocks, undefined)
  assert.ok(calls.slice(1).every(call => call.blocks.length === 1 && !call.summary && call.opinion === undefined && JSON.stringify(call.viewpoint) === JSON.stringify(viewpoint)))
  assert.equal(final.article.opinion, 'A tremendous topic. Believe me.')
  assert.deepEqual(Object.keys(calls[1].blocks[0]).sort(), ['id', 'text'])
  assert.equal(final.article.html, undefined); assert.ok(final.article.sections.every(section => section.complete))
  assert.equal(final.article.metrics.actualModels['actual-test-model'], 62)
  assert.equal(final.article.metrics.costUsdTicks, 6200)
  assert.deepEqual(final.article.metrics.stages, { opinion: 1, 'opinion-review': 1, body: 30, review: 30 })
  for (const field of ['sourceFetchMs', 'planMs', 'queueWaitMs', 'firstBatchMs', 'firstSectionMs', 'elapsedMs']) assert.equal(typeof final.article.metrics[field], 'number', field)
  const hit = await service.start({ url: wiki('Test') }); await service.dispatch()
  assert.equal(hit.status, 'complete'); assert.equal(calls.length, 31); assert.equal(sourceCalls.length, 1)
})

test('unverified legacy complete rows never seed current outputs or opinions and remain untouched', async () => {
  for (const opinion of ['Already tremendous.', null]) {
    const row = { url: wiki('Legacy'), title: 'Weak legacy', html: `<p onclick="unsafe()">Unverified weak legacy text.</p><script>alert(1)</script>`, rewrite_mode: 'llm', opinion }
    const f = fixture({ html: source(1), legacyArticles: [row] })
    const job = await f.service.start({ url: row.url })
    assert.equal(job.status, 'queued'); assert.equal(job.article, undefined)
    assert.deepEqual(f.store.snapshot()[0].outputs, {})
    assert.equal(f.store.snapshot()[0].opinion, '')
    await f.service.dispatch()
    const ready = await f.service.status(job)
    assert.equal(ready.status, 'complete'); assert.equal(f.calls.length, 2); assert.equal(f.reviews.length, 2); assert.equal(f.sourceCalls.length, 1)
    assert.equal(ready.article.importedFromLegacy, false)
    assert.doesNotMatch(ready.article.sections.map(s => s.html).join(''), /Unverified weak legacy/)
    assert.deepEqual(await f.store.legacy(row.url), row)
  }
})

test('legacy partial and heuristic cache never become falsely complete generation', async () => {
  for (const mode of ['llm-partial', 'heuristic']) {
    const f = fixture({ html: source(1), legacyArticles: [{ url: wiki('Partial'), title: 'Partial', html: `<p>${sentence}</p>`, rewrite_mode: mode, opinion: 'Old stance.' }] })
    const job = await f.service.start({ url: wiki('Partial') }); assert.equal(job.status, 'queued'); await f.service.dispatch(); assert.equal(f.calls.length, 2); assert.equal(f.sourceCalls.length, 1)
    assert.equal((await f.service.status(job)).article.importedFromLegacy, false)
  }
})

test('the first body paragraph checkpoints and becomes readable while other singleton calls remain pending', async () => {
  let release; const gate = new Promise(resolve => { release = resolve }); let signalPending
  const pending = new Promise(resolve => { signalPending = resolve })
  const f = fixture({ html: `<p>Lead: ${sentence}</p><h2>History</h2>${source(8)}`, providerHook: async input => { if (input.blocks && !input.blocks[0].text.startsWith('Lead:')) { signalPending(); await gate } } })
  const job = await f.service.start({ url: wiki('Progressive') }); const work = f.service.dispatch(); await pending
  await new Promise(resolve => setImmediate(resolve))
  const mid = await f.service.status(job)
  assert.equal(mid.status, 'running'); assert.equal(mid.completed, 1); assert.ok(mid.article.sections[0].complete); assert.ok(mid.article.sections.some(s => !s.complete))
  assert.match(mid.article.sections[0].html, /tremendous encyclopedia paragraph/)
  assert.equal(f.calls[0].blocks, undefined); assert.ok(f.calls.slice(1).every(call => call.blocks.length === 1))
  release(); await work
  const complete = await f.service.status(job); assert.equal(complete.status, 'complete'); assert.deepEqual(complete.article.metrics.stages, { opinion: 1, 'opinion-review': 1, body: 9, review: 9 })
})

test('successful long article resumes immediately across bounded invocations instead of sleeping until deadline', async () => {
  const f = fixture({ html: source(29), providerHook: async (_input, ctx) => { await new Promise(resolve => setTimeout(resolve, 2)); ctx.atLeast(ctx.now + 25000) } })
  const job = await f.service.start({ url: wiki('Long') }); await f.service.dispatch()
  const first = f.store.snapshot()[0]; assert.equal(first.status, 'queued'); assert.ok(first.completed === undefined); assert.ok(Object.keys(first.outputs).length < first.plan.blocks.length)
  assert.ok(Date.parse(first.nextRunAt) <= f.now()); const calls = f.calls.length
  await f.service.dispatch(); assert.ok(f.calls.length > calls)
  for (let i = 0; i < 15 && (await f.service.status(job)).status !== 'complete'; i++) await f.service.dispatch()
  assert.equal((await f.service.status(job)).status, 'complete')
})

test('failed-only retry keeps successful checkpoints and resolves URL with no remembered job ID', async () => {
  let shouldFail = true
  const f = fixture({ html: source(30), providerHook: async input => { if (!input.summary && input.blocks.some(b => b.text.startsWith('24:')) && shouldFail) return new Response('{}', { status: 503 }) } })
  const job = await f.service.start({ url: wiki('Retry') })
  for (let i = 0; i < 3; i++) { await f.service.dispatch(); f.advance(10000) }
  const partial = await f.service.status(job)
  // Select actual failed batch independent of stable block ID implementation.
  if (partial.status === 'complete') {
    // Fixture identifiers are always tested below; this guard makes an unexpected plan change visible.
    assert.fail('Expected retry fixture to fail a body batch')
  }
  assert.equal(partial.status, 'partial'); assert.equal(partial.error, 'Some sections could not be generated. Completed sections are saved.'); const saved = f.store.snapshot()[0]; const successfulIds = Object.keys(saved.outputs)
  assert.ok(successfulIds.length > 0); assert.ok(partial.failedCount > 0)
  shouldFail = false
  await f.service.handle({ action: 'retry', url: wiki('Retry') }, { requestKey: 'retry-client' }); const before = f.calls.length; await f.service.dispatch()
  const final = await f.service.status(job); assert.equal(final.status, 'complete')
  const retried = f.calls.slice(before).flatMap(call => call.blocks || []).map(block => block.id)
  assert.ok(retried.every(id => !successfulIds.includes(id)))
  assert.ok(f.calls.slice(before).every(call => call.blocks?.length === 1 && call.opinion === undefined && call.summary === undefined))
  assert.equal(final.article.metrics.stages.opinion, 1, 'Manual body recovery reuses the separately cached display opinion')
})

test('Retry-After beyond 120 seconds is respected and never shortened; job deadline bounds long waits', async () => {
  const f = fixture({ providerHook: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '900' } }) })
  const job = await f.service.start({ url: wiki('RateLimited') }); await f.service.dispatch(); assert.equal(f.calls.length, 1)
  f.advance(121000); await f.service.dispatch(); assert.equal(f.calls.length, 1)
  f.advance(ARTICLE_LIMITS.jobMs); await f.service.dispatch(); assert.equal(f.calls.length, 1)
  assert.equal((await f.service.status(job)).status, 'failed')
})

test('monotonic updatedAt prevents final snapshot from being lost with a fixed clock', async () => {
  let release; const gate = new Promise(resolve => { release = resolve }); let bodyStarted
  const pending = new Promise(resolve => { bodyStarted = resolve })
  const f = fixture({ clock: () => Date.parse('2026-11-25T12:00:00Z'), providerHook: async input => { if (!input.summary) { bodyStarted(); await gate } } })
  const job = await f.service.start({ url: wiki('FixedClock') }); const work = f.service.dispatch(); await pending
  const mid = await f.service.status(job); release(); await work
  const final = await f.service.status({ jobId: job.jobId, updatedAt: mid.updatedAt }); assert.notEqual(final.unchanged, true); assert.equal(final.status, 'complete'); assert.ok(final.article)
  const same = await f.service.status({ jobId: job.jobId, updatedAt: final.updatedAt }); assert.equal(same.unchanged, true); assert.equal(same.article, undefined)
})

test('storage lease fencing rejects stale checkpoints and globally admits only two workers', async () => {
  const f = fixture({ limits: { maxPerClientMinute: 10 } })
  const jobs = await Promise.all(['A', 'B', 'C'].map(title => f.service.start({ url: wiki(title) })))
  const first = await f.store.claim(crypto.randomUUID()); const second = await f.store.claim(crypto.randomUUID()); assert.ok(first && second); assert.equal(await f.store.claim(crypto.randomUUID()), null)
  f.advance(ARTICLE_LIMITS.leaseMs + 1); const replacement = await f.store.claim(crypto.randomUUID()); assert.equal(replacement.job.id, first.job.id)
  await assert.rejects(f.store.checkpoint(first.job.id, first.token, {}, { stale: 'bad' }), error => error.code === 'stale_lease')
  await f.store.checkpoint(replacement.job.id, replacement.token, {}, { a: 'one' }); await f.store.checkpoint(replacement.job.id, replacement.token, {}, { b: 'two' })
  assert.deepEqual((await f.store.read(jobs[0].jobId)).outputs, { a: 'one', b: 'two' })
})

test('admission limits preserve cached access and recent merges legacy rows without duplicate links', async () => {
  const f = fixture({ html: source(1), limits: { maxNewPerMinute: 1 }, legacyArticles: [{ url: wiki('Old'), title: 'Old', html: source(1), rewrite_mode: 'llm', opinion: 'Old stance.', created_at: '2026-01-01T00:00:00Z' }] })
  const job = await f.service.start({ url: wiki('One') }); await f.service.dispatch()
  await assert.rejects(f.service.start({ url: wiki('Two') }), error => error instanceof ArticleServiceError && error.status === 429)
  assert.equal((await f.service.start({ url: wiki('One') })).jobId, job.jobId)
  await assert.rejects(f.service.start({ url: wiki('Old') }), error => error.status === 429)
  const recent = await f.service.recent(); assert.deepEqual(new Set(recent.articles.map(a => a.url)), new Set([wiki('One')]))
  const completeRetry = await f.service.retry({ jobId: job.jobId }); assert.equal(completeRetry.status, 'complete')
})

test('unchanged status reads metadata only from durable store', async () => {
  const reads = []
  const row = { id: crypto.randomUUID(),url:wiki('One'),version:'test',lang:'en',title:'One',status:'running',updated_at:'2026-11-25T00:00:00.000Z' }
  const store = createSupabaseStore({ url:'https://example.supabase.co',serviceKey:'mock-service',fetchImpl:async url => { reads.push(String(url)); return Response.json([row]) } })
  const f = fixture({ store }); const result = await f.service.status({jobId:row.id,updatedAt:row.updated_at})
  assert.equal(result.unchanged,true); assert.equal(reads.length,1); assert.doesNotMatch(reads[0],/select=\*/); assert.equal(result.article,undefined)
})

test('two article workers run at most four singleton body calls each and record failed paid attempts accurately', async () => {
  let active = 0; let peak = 0
  const f = fixture({ html: source(85), limits: { maxPerClientMinute: 10 }, providerHook: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 4)); active-- } })
  await Promise.all(['ConcurrentA','ConcurrentB','ConcurrentC'].map(title => f.service.start({ url: wiki(title) })))
  await f.service.dispatch()
  assert.equal(peak, 8); assert.equal(f.store.snapshot().filter(job => job.status === 'complete').length, 2); assert.equal(f.store.snapshot().filter(job => job.status === 'queued').length, 1)
  const bad = fixture({ html: source(1), providerHook: async () => new Response('{}', {status:503}) })
  const job = await bad.service.start({url:wiki('FailureMetrics')}); await bad.service.dispatch()
  const state = bad.store.snapshot()[0]; assert.equal(state.metrics.calls, 1); assert.equal(state.metrics.failedCalls, 1); assert.equal(state.metrics.stages.failed, 1)
  assert.equal((await bad.service.status(job)).status, 'queued')
})

test('redirect identities deduplicate before paid work and preserve canonical revision metadata', async () => {
  const f = fixture({html:source(1),resolveIdentity:true})
  const [a,b] = await Promise.all([f.service.start({url:wiki('AliasA')}),f.service.start({url:wiki('AliasB')})]); assert.equal(a.jobId,b.jobId)
  await f.service.dispatch();const done=await f.service.status(a)
  assert.equal(done.article.canonicalUrl,wiki('Canonical'));assert.equal(done.article.sourceRevisionId,12);assert.equal(done.article.sourcePageId,1)
  assert.match(f.sourceCalls.at(-1),/oldid=12/)
  const count=f.sourceCalls.length;await f.service.start({url:wiki('AliasA')});assert.equal(f.sourceCalls.length,count)
})


test('legacy punctuation URLs remain historical while canonical URLs regenerate original source', async () => {
  const row={url:wiki('Star_Trek:_Voyager'),title:'Star Trek: Voyager',html:source(1),rewrite_mode:'llm',opinion:'A tremendous series.'}
  const f=fixture({html:source(1),legacyArticles:[row]})
  const job=await f.service.start({url:wiki('Star_Trek%3A_Voyager')});await f.service.dispatch()
  const ready=await f.service.status(job)
  assert.equal(ready.status,'complete');assert.equal(ready.article.canonicalUrl,wiki('Star_Trek%3A_Voyager'));assert.equal(f.calls.length,2);assert.equal(f.sourceCalls.length,1)
  assert.deepEqual(await f.store.legacy(row.url),row)
})


test('Wikipedia Retry-After gates source retries and cancels rejected response bodies', async () => {
  let cancelled=false
  const f=fixture({sourceHook:()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{status:429,headers:{'Retry-After':'300'}})})
  const job=await f.service.start({url:wiki('WikiRate')});await f.service.dispatch();assert.equal(cancelled,true);assert.equal(f.sourceCalls.length,1)
  f.advance(121000);await f.service.dispatch();assert.equal(f.sourceCalls.length,1);assert.equal(f.calls.length,0)
  f.advance(180000);await f.service.dispatch();assert.equal(f.sourceCalls.length,2);assert.equal((await f.service.status(job)).status,'queued')
})


test('a zero-output provider failure clearly says no rewritten passages were saved without guessing billing cause', async () => {
  const f=fixture({html:source(1),providerHook:async()=>new Response('{}',{status:403})})
  const job=await f.service.start({url:wiki('UnavailableProvider')});await f.service.dispatch()
  const failed=await f.service.status(job)
  assert.equal(failed.status,'failed');assert.equal(failed.completed,0);assert.equal(failed.article,undefined)
  assert.equal(failed.error,'Generation is temporarily unavailable. No rewritten passages were saved. Please try again later.')
  assert.doesNotMatch(failed.error,/credit|billing|spending|Completed sections/);assert.equal(f.calls.length,1)
})


test('provider account rejection stops automatic attempts but can resume manually after access is restored', async () => {
  let restored=false
  const f=fixture({html:source(1),providerHook:async()=>restored?undefined:new Response('{}',{status:403})})
  const job=await f.service.start({url:wiki('RestoredAccess')});await f.service.dispatch()
  const failed=await f.service.status(job);assert.equal(failed.status,'failed');assert.equal(failed.retryable,true);assert.equal(f.calls.length,1)
  f.advance(10000);await f.service.dispatch();assert.equal(f.calls.length,1,'No automatic retry of rejected credentials')
  restored=true;await f.service.retry({jobId:job.jobId});await f.service.dispatch()
  const complete=await f.service.status(job);assert.equal(complete.status,'complete');assert.equal(complete.completed,1);assert.equal(f.calls.length,3);assert.equal(f.sourceCalls.length,1,'Saved source plan is reused')
  assert.deepEqual(complete.article.metrics.stages,{failed:1,opinion:1,'opinion-review':1,body:1,review:1})
})

test('manual recovery from provider rejection remains bounded to three retries per job per day', async () => {
  const f=fixture({html:source(1),providerHook:async()=>new Response('{}',{status:403})})
  const job=await f.service.start({url:wiki('BoundedRecovery')});await f.service.dispatch()
  for(let i=0;i<3;i++){await f.service.retry({jobId:job.jobId});await f.service.dispatch()}
  assert.equal(f.calls.length,4)
  await assert.rejects(f.service.retry({jobId:job.jobId}),error=>error.status===429&&error.code==='retry_limit')
  await f.service.dispatch();assert.equal(f.calls.length,4)
})

test('semantic review is mandatory and rejected opinions never become cached viewpoint state', async () => {
  const feedback = 'PrivateFeedbackMarker: Preserve the source qualifier. '.repeat(8)
  const f = fixture({ html: source(1), reviewHook: async input => input.kind === 'opinion' ? { facts_preserved: false, point_of_view_consistent: true, substantive_rewrite: true, issues: [feedback.slice(0, 240)] } : undefined })
  assert.throws(() => createArticleService({ store: f.store, provider: { ...f.provider, review: undefined }, parseDocument }), /semantic review/)
  const job = await f.service.start({ url: wiki('RejectedOpinion') })
  for (let index = 0; index < 3; index++) { await f.service.dispatch(); f.advance(10000) }
  const saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'failed'); assert.equal(saved.opinion, ''); assert.equal(saved.viewpoint, null); assert.equal(saved.opinionReviewed, false)
  assert.equal(saved.pendingOpinion, null)
  assert.deepEqual(saved.outputs, {}); assert.equal(f.calls.filter(call => call.blocks).length, 0)
  assert.equal(saved.opinionFailure.code, 'quality_rejected'); assert.equal(saved.opinionFailure.attempts, 3)
  assert.equal(saved.metrics.calls, 6); assert.equal(saved.metrics.costUsdTicks, 600)
  assert.equal(saved.metrics.qualityRejections, 3)
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /PrivateFeedbackMarker/)
})

test('body review gates every checkpoint; retries preserve approved blocks and cached article policy', async () => {
  let shouldReject = true
  const issue = 'Preserve the original uncertainty about this historical account.'
  const f = fixture({ html: source(2), reviewHook: async input => input.kind === 'rewrite' && input.blocks[0].text.startsWith('1:') && shouldReject ? { facts_preserved: false, point_of_view_consistent: true, substantive_rewrite: true, issues: [issue] } : undefined })
  const job = await f.service.start({ url: wiki('RejectedBody') })
  for (let index = 0; index < 3; index++) { await f.service.dispatch(); f.advance(10000) }
  const partial = f.store.snapshot()[0]
  assert.equal(partial.status, 'partial'); assert.equal(Object.keys(partial.outputs).length, 1)
  assert.deepEqual(partial.pendingDrafts, {})
  const approved = { ...partial.outputs }
  const failed = Object.values(partial.failures)[0]
  assert.equal(failed.code, 'quality_rejected'); assert.deepEqual(failed.feedback, [issue])
  assert.ok(failed.previousDraft.includes('tremendous encyclopedia paragraph'))
  assert.equal(JSON.stringify(await f.service.status(job)).includes('previousDraft'), false)
  assert.equal(JSON.stringify(await f.service.status(job)).includes('revisionContext'), false)
  assert.equal(partial.metrics.calls, 10); assert.equal(partial.metrics.costUsdTicks, 1000)
  assert.equal(f.calls.filter(call => call.summary).length, 1)
  assert.equal(f.reviews.filter(call => call.kind === 'opinion').length, 1)
  assert.ok(f.calls.filter(call => call.blocks).every(call => JSON.stringify(call.viewpoint) === JSON.stringify(viewpoint)))
  assert.ok(f.reviews.filter(call => call.kind === 'rewrite').every(call => JSON.stringify(call.viewpoint) === JSON.stringify(viewpoint)))
  assert.deepEqual(f.calls.at(-1).revisionNotes, [issue])
  assert.equal(f.calls.at(-1).previousDraft, failed.previousDraft)
  shouldReject = false
  await f.service.retry({ jobId: job.jobId }); await f.service.dispatch()
  const ready = f.store.snapshot()[0]
  assert.equal(ready.status, 'complete'); assert.equal(ready.opinion, partial.opinion); assert.deepEqual(ready.viewpoint, partial.viewpoint)
  for (const [id, text] of Object.entries(approved)) assert.equal(ready.outputs[id], text)
  assert.equal(ready.metrics.calls, 12); assert.equal(ready.metrics.costUsdTicks, 1200)
  assert.equal(f.calls.at(-1).previousDraft, failed.previousDraft, 'Manual retry preserves private correction context')
  assert.deepEqual(ready.revisionContext, {})
})

test('a thrown paid review records its metadata once without saving unchecked generated text', async () => {
  const f = fixture({ html: source(1), reviewHook: async input => input.kind === 'rewrite' ? new Response('{}', { status: 503 }) : undefined })
  await f.service.start({ url: wiki('ReviewUnavailable') }); await f.service.dispatch()
  const saved = f.store.snapshot()[0]
  assert.deepEqual(saved.outputs, {})
  assert.equal(saved.metrics.calls, 4); assert.equal(saved.metrics.failedCalls, 1)
  assert.deepEqual(saved.metrics.stages, { opinion: 1, 'opinion-review': 1, body: 1, failed: 1 })
  assert.equal(saved.metrics.costUsdTicks, 300, 'Only billed usage actually returned by the three successful upstream responses is added')
})

async function seedHistorical(store, url, now, { status = 'complete', importedFromLegacy = false } = {}) {
  const plan = prepareArticle(source(2), 'en', parseDocument)
  const outputs = Object.fromEntries(plan.blocks.slice(0, status === 'complete' ? 2 : 1).map(block => [block.id, block.text]))
  const at = new Date(now).toISOString()
  return store.admit({ id: crypto.randomUUID(), url, lang: 'en', title: 'Historical title', version: 'paragraphs-v0:prompt-v0:historical-model', status, createdAt: at, updatedAt: at, nextRunAt: at, deadlineAt: new Date(now + ARTICLE_LIMITS.jobMs).toISOString(), model: importedFromLegacy ? 'legacy-unrecorded' : 'historical-model', plan, outputs, opinion: 'An unverified historical opinion.', importedFromLegacy, failures: {}, opinionFailure: null, sourceFailure: null, metrics: { calls: 0, providerMs: 0, inputTokens: 0, outputTokens: 0, stages: {} }, retryable: true }, { aliasUrl: url, requestKey: 'historical-fixture', paid: false })
}

test('new quality versions regenerate source while historical completed rows keep stored provenance and bytes', async () => {
  const f = fixture({ html: source(1) })
  const historical = await seedHistorical(f.store, wiki('VersionedQuality'), f.now())
  const before = await f.store.read(historical.id)
  const started = await f.service.start({ url: historical.url })
  assert.notEqual(started.jobId, historical.id); assert.equal(started.status, 'queued')
  await f.service.dispatch()
  const ready = await f.service.status(started)
  assert.equal(ready.status, 'complete'); assert.equal(f.sourceCalls.length, 1); assert.equal(f.calls.length, 2); assert.equal(f.reviews.length, 2)
  assert.deepEqual(await f.store.read(historical.id), before)
  const old = await f.service.status({ jobId: historical.id })
  assert.equal(old.outdated, true); assert.equal(old.article.pipelineVersion, 'paragraphs-v0'); assert.equal(old.article.promptVersion, 'prompt-v0')
  assert.equal(old.article.model, 'historical-model')
  assert.equal(old.article.reviewModel, undefined, 'Three-part historical versions do not inherit the current reviewer')
  await assert.rejects(f.service.retry({ jobId: historical.id }), error => error.status === 409 && error.code === 'job_version_outdated' && error.message.includes(historical.url))
  assert.deepEqual(await f.store.read(historical.id), before)
  const hit = await f.service.start({ url: historical.url }); assert.equal(hit.jobId, started.jobId)
  assert.equal(f.calls.length, 2); assert.equal(f.reviews.length, 2)
  const recent = await f.service.recent(); assert.deepEqual(recent.articles.map(row => row.jobId), [started.jobId])
})

test('new workers fence obsolete pending jobs before paid work and never mix old saved blocks with new quality', async () => {
  const f = fixture()
  const historical = await seedHistorical(f.store, wiki('SupersededPending'), f.now(), { status: 'queued' })
  await f.service.dispatch()
  const saved = await f.store.read(historical.id)
  assert.equal(saved.status, 'partial'); assert.equal(saved.retryable, false)
  assert.deepEqual(saved.outputs, historical.outputs); assert.equal(saved.opinion, historical.opinion)
  assert.equal(f.calls.length, 0); assert.equal(f.reviews.length, 0); assert.equal(f.sourceCalls.length, 0)
  assert.match(saved.error, /older version/)
  const legacy = await seedHistorical(f.store, wiki('HistoricalUnknown'), f.now(), { importedFromLegacy: true })
  const old = await f.service.status({ jobId: legacy.id })
  assert.equal(old.article.pipelineVersion, 'legacy-unknown'); assert.equal(old.article.promptVersion, 'legacy-unknown')
})

test('current recent queries never promote unverified legacy cache rows', async () => {
  const reads = []
  const store = createSupabaseStore({ url: 'https://offline.test', serviceKey: 'test-only-key', fetchImpl: async url => { reads.push(String(url)); return Response.json([{ id: 'current', url: wiki('Current'), title: 'Current' }]) } })
  const rows = await store.recent('verified-quality', 20)
  assert.equal(reads.length, 1); assert.match(reads[0], /article_jobs\?/); assert.match(reads[0], /version=eq.verified-quality/)
  assert.equal(reads.some(url => url.includes('/articles?')), false)
  assert.deepEqual(rows, [{ jobId: 'current', url: wiki('Current'), title: 'Current' }])
})

test('internal worker slice expiry requeues a paid review without terminal failure or attempt penalty', async t => {
  const epoch = Date.parse('2026-11-25T12:00:00Z')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch })
  const metadata = { model: 'offline-timing-model', duration: 1, usage: { cost_in_usd_ticks: 100 } }
  let firstBodyReview = true; let reviewing
  const reviewStarted = new Promise(resolve => { reviewing = resolve })
  const provider = {
    model: metadata.model,
    opinion: async () => ({ ...metadata, opinion: 'I appreciate practical skill.', viewpoint }),
    rewrite: async ({ blocks }) => ({ ...metadata, blocks: blocks.map(block => ({ ...block, text: block.text.replaceAll(sentence, 'I get a clear historical account here, and that is useful information to have.') })) }),
    review: async input => {
      if (input.kind === 'rewrite' && firstBodyReview) {
        firstBodyReview = false; reviewing()
        return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Worker slice stopped.'), metadata, { code: 'cancelled', status: 499, retryable: false })), { once: true }))
      }
      return { ...metadata, passed: true, issues: [] }
    },
  }
  const store = createMemoryStore({ clock: Date.now })
  const service = createArticleService({ store, provider, parseDocument, clock: Date.now, resolveIdentity: false, fetchImpl: async () => Response.json({ parse: { title: 'Slice expiry', text: source(1) } }) })
  const job = await service.start({ url: wiki('SliceExpiry') })
  const work = service.dispatch(); await reviewStarted
  t.mock.timers.tick(ARTICLE_LIMITS.runMs)
  await work
  const paused = await store.read(job.jobId)
  assert.equal(paused.status, 'queued'); assert.deepEqual(paused.outputs, {}); assert.deepEqual(paused.failures, {})
  assert.equal(Object.keys(paused.pendingDrafts).length, 1)
  assert.equal(paused.opinionFailure, null); assert.equal(paused.opinionReviewed, true); assert.equal(paused.metrics.calls, 4)
  assert.ok(Date.parse(paused.nextRunAt) <= Date.now())
  await service.dispatch()
  const ready = await store.read(job.jobId)
  assert.equal(ready.status, 'complete'); assert.equal(ready.metrics.calls, 5); assert.equal(ready.metrics.costUsdTicks, 500)
  assert.equal(ready.metrics.stages.body, 1, 'A paid draft is not generated again after its review was interrupted')
  assert.deepEqual(ready.pendingDrafts, {})
  assert.equal(Object.keys(ready.outputs).length, 1)
})

test('changing only the reviewer creates a separate cache version with truthful stored model provenance', async () => {
  const a = fixture({ html: source(1), model: 'stable-writer', reviewModel: 'reviewer-a' })
  const first = await a.service.start({ url: wiki('ReviewerVersion') }); await a.service.dispatch()
  const before = await a.store.read(first.jobId)
  const b = fixture({ html: source(1), model: 'stable-writer', reviewModel: 'reviewer-b', store: a.store })
  const second = await b.service.start({ url: wiki('ReviewerVersion') })
  assert.notEqual(first.jobId, second.jobId)
  assert.match(a.service.version, /:stable-writer:reviewer-a$/)
  assert.match(b.service.version, /:stable-writer:reviewer-b$/)
  await b.service.dispatch()
  assert.deepEqual(await a.store.read(first.jobId), before)
  const old = await b.service.status({ jobId: first.jobId })
  const current = await b.service.status(second)
  assert.equal(old.outdated, true); assert.equal(old.article.model, 'stable-writer'); assert.equal(old.article.reviewModel, 'reviewer-a')
  assert.equal(current.outdated, false); assert.equal(current.article.reviewModel, 'reviewer-b')
  assert.equal(b.calls.length, 2); assert.equal(b.reviews.length, 2)
  const hit = await b.service.start({ url: wiki('ReviewerVersion') }); assert.equal(hit.jobId, second.jobId)
})

test('private failed drafts and correction feedback are bounded and survive manual retry without publication', async () => {
  const f = fixture({ html: source(1) })
  let rejectDraft = true; let lastInput
  const provider = { ...f.provider, rewrite: async input => {
    lastInput = input
    if (rejectDraft) throw Object.assign(new Error('Draft rejected.'), { status: 502, code: 'quality_rejected', retryable: true, duration: 1, model: 'offline-test', usage: { cost_in_usd_ticks: 5 }, feedback: Array.from({ length: 8 }, (_, index) => `${index}: ${'PrivateFeedbackMarker'.repeat(30)}`), previousDraft: 'PrivateDraftMarker' + 'd'.repeat(20_000) })
    return { blocks: input.blocks.map(block => ({ ...block, text: block.text.replaceAll(sentence, 'I appreciate a clear account of this topic and its history, with useful details laid out.') })), duration: 1, model: 'offline-test', usage: { cost_in_usd_ticks: 5 } }
  } }
  const service = createArticleService({ store: f.store, provider, parseDocument, clock: f.now, resolveIdentity: false, fetchImpl: async () => Response.json({ parse: { title: 'Private retry', text: source(1) } }) })
  const job = await service.start({ url: wiki('PrivateDraftRecovery') })
  for (let attempt = 0; attempt < 3; attempt++) { await service.dispatch(); f.advance(10000) }
  const failed = await f.store.read(job.jobId)
  const failure = Object.values(failed.failures)[0]
  assert.equal(failed.status, 'failed'); assert.equal(failure.previousDraft.length, 12000)
  assert.equal(failure.feedback.length, 4); assert.ok(failure.feedback.every(note => note.length === 240))
  const publicStatus = JSON.stringify(await service.status(job))
  assert.doesNotMatch(publicStatus, /PrivateDraftMarker|PrivateFeedbackMarker|previousDraft|revisionContext/)
  rejectDraft = false
  await service.retry({ jobId: job.jobId }); await service.dispatch()
  assert.equal(lastInput.previousDraft, failure.previousDraft)
  assert.deepEqual(lastInput.revisionNotes, failure.feedback)
  const ready = await f.store.read(job.jobId)
  assert.equal(ready.status, 'complete'); assert.deepEqual(ready.revisionContext, {})
  assert.equal(ready.metrics.costUsdTicks, 320)
})

test('slow generation and review persist separate private phases without duplicate calls or lost concurrent draft patches', async () => {
  const slow = async (_input, ctx) => { await new Promise(resolve => setTimeout(resolve, 2)); ctx.atLeast(ctx.now + 45000) }
  const f = fixture({ html: source(4), providerHook: slow, reviewHook: slow })
  const job = await f.service.start({ url: wiki('DurablePhases') })
  await f.service.dispatch()
  let saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'queued'); assert.equal(f.calls.length, 1); assert.equal(f.reviews.length, 0)
  assert.ok(saved.pendingOpinion); assert.equal(saved.opinionReviewed, false); assert.equal(saved.opinion, '')
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /pendingOpinion|pendingDrafts|A tremendous topic/)
  await f.service.dispatch()
  saved = f.store.snapshot()[0]
  assert.equal(saved.opinionReviewed, true); assert.equal(saved.pendingOpinion, null)
  assert.equal(f.calls.length, 1); assert.equal(f.reviews.length, 1)
  await f.service.dispatch()
  saved = f.store.snapshot()[0]
  assert.equal(Object.keys(saved.pendingDrafts).length, 4, 'Four serialized checkpoint patches merge at execution instead of overwriting siblings')
  assert.deepEqual(saved.outputs, {}); assert.equal(f.calls.length, 5); assert.equal(f.reviews.length, 1)
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /pendingDrafts|Here is a tremendous/)
  await f.service.dispatch()
  saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'complete'); assert.equal(Object.keys(saved.outputs).length, 4)
  assert.deepEqual(saved.pendingDrafts, {}); assert.equal(f.calls.length, 5); assert.equal(f.reviews.length, 5)
  assert.equal(saved.metrics.calls, 10); assert.equal(saved.metrics.costUsdTicks, 1000)
})

test('a bounded seventy-five-second paragraph draft checkpoints before a separate review slice', async () => {
  const waitForVirtual = ms => async (_input, ctx) => { await new Promise(resolve => setTimeout(resolve, 2)); ctx.atLeast(ctx.now + ms) }
  const f = fixture({ html: source(4), providerHook: async (input, ctx) => {
    if (input.blocks) await waitForVirtual(75000)(input, ctx)
  }, reviewHook: waitForVirtual(45000) })
  const job = await f.service.start({ url: wiki('LongParagraphDeadline') })
  assert.equal(ARTICLE_LIMITS.runMs, 100000); assert.equal(ARTICLE_LIMITS.leaseMs, 140000)
  assert.equal(ARTICLE_LIMITS.jobMs, 12 * 60 * 1000); assert.equal(ARTICLE_LIMITS.workers, 2); assert.equal(ARTICLE_LIMITS.batches, 4)
  await f.service.dispatch()
  assert.equal(f.store.snapshot()[0].opinionReviewed, true)
  await f.service.dispatch()
  const pending = f.store.snapshot()[0]
  assert.equal(pending.status, 'queued'); assert.equal(Object.keys(pending.pendingDrafts).length, 4)
  assert.deepEqual(pending.outputs, {}); assert.deepEqual(pending.failures, {})
  assert.equal(f.calls.length, 5); assert.equal(f.reviews.length, 1)
  await f.service.dispatch()
  const ready = await f.service.status(job)
  assert.equal(ready.status, 'complete'); assert.equal(ready.completed, 4)
  assert.equal(f.calls.length, 5, 'The next slice reviews saved long drafts without another generation call')
  assert.equal(f.reviews.length, 5); assert.equal(ready.article.metrics.calls, 10)
  assert.equal(ready.article.metrics.costUsdTicks, 1000)
})

test('temporary body review failure keeps its paid draft and retries review without regenerating prose', async () => {
  let unavailable = true
  const f = fixture({ html: source(1), reviewHook: async input => {
    if (input.kind === 'rewrite' && unavailable) { unavailable = false; return new Response('{}', { status: 503 }) }
  } })
  const job = await f.service.start({ url: wiki('ReviewResume') }); await f.service.dispatch()
  let saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'queued'); assert.equal(Object.keys(saved.pendingDrafts).length, 1)
  assert.deepEqual(saved.outputs, {}); assert.equal(f.calls.length, 2); assert.equal(f.reviews.length, 2)
  f.advance(10000); await f.service.dispatch()
  saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'complete'); assert.equal(f.calls.length, 2); assert.equal(f.reviews.length, 3)
  assert.equal(saved.metrics.calls, 5); assert.equal(saved.metrics.costUsdTicks, 400)
  assert.deepEqual(saved.pendingDrafts, {})
  assert.equal((await f.service.status(job)).completed, 1)
})

test('temporary opinion review failure keeps the candidate private and does not purchase another stance', async () => {
  let unavailable = true
  const f = fixture({ html: source(1), reviewHook: async input => {
    if (input.kind === 'opinion' && unavailable) { unavailable = false; return new Response('{}', { status: 503 }) }
  } })
  const job = await f.service.start({ url: wiki('OpinionReviewResume') }); await f.service.dispatch()
  let saved = f.store.snapshot()[0]
  assert.ok(saved.pendingOpinion); assert.equal(saved.opinion, ''); assert.equal(saved.opinionReviewed, false)
  assert.equal(f.calls.length, 1); assert.equal(f.reviews.length, 1)
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /pendingOpinion|A tremendous topic/)
  f.advance(10000); await f.service.dispatch()
  saved = f.store.snapshot()[0]
  assert.equal(saved.status, 'complete'); assert.equal(f.calls.filter(call => call.summary).length, 1)
  assert.equal(f.reviews.length, 3); assert.equal(saved.metrics.calls, 5); assert.equal(saved.pendingOpinion, null)
})

test('internal opinion-review cancellation preserves its private candidate for the next worker slice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-25T12:00:00Z') })
  const metadata = { model: 'offline-opinion-model', duration: 1, usage: { cost_in_usd_ticks: 100 } }
  let opinions = 0; let firstReview = true; let reviewing
  const started = new Promise(resolve => { reviewing = resolve })
  const provider = {
    model: metadata.model,
    opinion: async () => { opinions++; return { ...metadata, opinion: 'Private pending stance.', viewpoint } },
    rewrite: async ({ blocks }) => ({ ...metadata, blocks: blocks.map(block => ({ ...block, text: block.text.replaceAll(sentence, 'I get a clear historical account here, with the source information preserved.') })) }),
    review: async input => {
      if (input.kind === 'opinion' && firstReview) {
        firstReview = false; reviewing()
        return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Slice expired.'), metadata, { code: 'cancelled', status: 499, retryable: false })), { once: true }))
      }
      return { ...metadata, passed: true, issues: [] }
    },
  }
  const store = createMemoryStore({ clock: Date.now })
  const service = createArticleService({ store, provider, parseDocument, clock: Date.now, resolveIdentity: false, fetchImpl: async () => Response.json({ parse: { title: 'Opinion slice', text: source(1) } }) })
  const job = await service.start({ url: wiki('OpinionSlice') })
  const work = service.dispatch(); await started; t.mock.timers.tick(ARTICLE_LIMITS.runMs); await work
  let saved = await store.read(job.jobId)
  assert.equal(saved.status, 'queued'); assert.ok(saved.pendingOpinion); assert.equal(saved.opinion, '')
  assert.equal(saved.opinionFailure, null); assert.equal(opinions, 1)
  assert.doesNotMatch(JSON.stringify(await service.status(job)), /Private pending stance|pendingOpinion/)
  await service.dispatch(); saved = await store.read(job.jobId)
  assert.equal(saved.status, 'complete'); assert.equal(opinions, 1); assert.equal(saved.pendingOpinion, null)
  assert.equal(saved.metrics.calls, 5); assert.equal(saved.metrics.costUsdTicks, 500)
})

test('alternating copy and qualifier failures retain cumulative unique repair rules across timeout and manual retry', async () => {
  let now = Date.parse('2026-11-25T12:00:00Z')
  const sourceText = 'The building was constructed of old stone and usually served the community during summer months. It opened in 1840 near Oxford.'
  const candidates = [
    'During summer months the community usually used this old-stone building. It opened in 1840 near Oxford. I appreciate practical local work.',
    'At Oxford, 1840 marked the opening of this stone building. The place served the community during summer months, and I appreciate useful work.',
    'In 1840, a building made from old stone opened near Oxford. It generally served local people in the summer months; practical community work is something I appreciate.',
  ]
  const metadata = { model: 'offline-repair-model', duration: 1, usage: { cost_in_usd_ticks: 100 } }
  const copyIssue = 'Rephrase the copied source passage instead of repeating it verbatim.'
  const factIssue = 'Preserve the qualifier usually on the seasonal community use; it must not become unconditional.'
  const inputs = []; let bodyReviews = 0
  const provider = {
    model: metadata.model,
    opinion: async () => ({ ...metadata, opinion: 'I appreciate practical community work.', viewpoint }),
    rewrite: async input => {
      inputs.push(input)
      if (inputs.length === 3) throw Object.assign(new Error('Temporary timeout without correction feedback.'), metadata, { code: 'provider_timeout', status: 504, retryable: true })
      const text = candidates[inputs.length === 1 ? 0 : inputs.length === 2 ? 1 : 2]
      return { ...metadata, blocks: [{ id: input.blocks[0].id, text }] }
    },
    review: async input => {
      if (input.kind === 'opinion') return { ...metadata, passed: true, issues: [] }
      bodyReviews++
      return { ...metadata, passed: bodyReviews > 2, issues: bodyReviews === 1 ? [copyIssue, copyIssue] : bodyReviews === 2 ? [factIssue] : [] }
    },
  }
  const store = createMemoryStore({ clock: () => now })
  const service = createArticleService({ store, provider, parseDocument, clock: () => now, resolveIdentity: false, fetchImpl: async () => Response.json({ parse: { title: 'Cumulative repair', text: `<p>${sourceText}</p>` } }) })
  const job = await service.start({ url: wiki('CumulativeRepair') })
  for (let attempt = 0; attempt < 3; attempt++) { await service.dispatch(); now += 10000 }
  const failed = await store.read(job.jobId)
  const context = Object.values(failed.revisionContext)[0]
  const failure = Object.values(failed.failures)[0]
  assert.equal(failed.status, 'failed'); assert.equal(inputs.length, 3)
  assert.ok(inputs[1].revisionNotes.some(note => note.includes('it opened in 1840 near oxford')))
  assert.ok(inputs[2].revisionNotes.includes(factIssue))
  assert.ok(inputs[2].revisionNotes.some(note => /Rephrase copied passage/.test(note)))
  assert.equal(new Set(inputs[2].revisionNotes).size, inputs[2].revisionNotes.length)
  assert.equal(inputs[2].revisionNotes.filter(note => /Rephrase copied passage/.test(note)).length, 1, 'A factual-only verdict must not create an unrelated copied-phrase hint')
  assert.ok(failure.feedback.includes(factIssue)); assert.ok(failure.feedback.some(note => /copied passage/.test(note)))
  assert.deepEqual(failure.feedback, context.feedback, 'A no-feedback timeout retains the cumulative rules in both retry paths')
  assert.equal(context.previousDraft, candidates[1]); assert.equal(failure.previousDraft, candidates[1])
  assert.ok(context.feedback.length <= 4); assert.ok(context.feedback.every(note => note.length <= 240))
  assert.doesNotMatch(JSON.stringify(await service.status(job)), /previousDraft|revisionContext|Preserve the qualifier/)
  await service.retry({ jobId: job.jobId }); await service.dispatch()
  assert.equal(inputs.length, 4); assert.equal(inputs[3].previousDraft, candidates[1])
  assert.ok(inputs[3].revisionNotes.includes(factIssue)); assert.ok(inputs[3].revisionNotes.some(note => /copied passage/.test(note)))
  const ready = await store.read(job.jobId)
  assert.equal(ready.status, 'complete'); assert.deepEqual(ready.revisionContext, {}); assert.deepEqual(ready.pendingDrafts, {})
})

test('a rejected opinion receives the precise prior draft and corrections before another paid generation', async () => {
  const bad = 'Experts said this bell should have stopped years ago, but I know better.'
  const good = 'I appreciate careful craftsmanship, with very little patience for unnecessary fuss.'
  const issue = 'Remove the unsupported claim that experts said the bell should have stopped.'
  let attempts = 0
  const f = fixture({ html: source(1), providerHook: async input => {
    if (input.summary) { attempts++; return { opinion: attempts === 1 ? bad : good, viewpoint } }
  }, reviewHook: async input => input.kind === 'opinion' && input.opinion === bad ? { facts_preserved: false, point_of_view_consistent: true, substantive_rewrite: true, issues: [issue] } : undefined })
  const job = await f.service.start({ url: wiki('OpinionCorrection') }); await f.service.dispatch()
  const rejected = f.store.snapshot()[0]
  assert.equal(rejected.status, 'queued'); assert.equal(rejected.opinion, ''); assert.equal(rejected.pendingOpinion, null)
  assert.equal(rejected.opinionRevisionContext.previousDraft, bad)
  assert.deepEqual(rejected.opinionRevisionContext.feedback, [issue])
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /Experts said|opinionRevisionContext|previousDraft/)
  f.advance(10000); await f.service.dispatch()
  const opinions = f.calls.filter(input => input.summary)
  assert.equal(opinions.length, 2)
  assert.equal(opinions[1].previous_draft, bad)
  assert.deepEqual(opinions[1].prior_review_issues, [issue])
  const ready = f.store.snapshot()[0]
  assert.equal(ready.status, 'complete'); assert.equal(ready.opinion, good); assert.equal(ready.opinionReviewed, true)
  assert.deepEqual(ready.opinionRevisionContext, {}); assert.equal(ready.opinionFailure, null)
  assert.equal(ready.metrics.calls, 6); assert.equal(ready.metrics.costUsdTicks, 600)
  assert.equal(f.sourceCalls.length, 1)
})

test('manual opinion retry retains bounded cumulative private feedback and the latest rejected stance', async () => {
  const issues = ['Do not invent expert predictions.', 'Keep the source uncertainty intact.', 'Do not assert personal involvement.']
  let generations = 0; let reviews = 0; let accept = false
  const drafts = []
  const f = fixture({ html: source(1), providerHook: async input => {
    if (input.summary) {
      generations++
      const opinion = accept ? 'I value practical craftsmanship and prefer less ceremony.' : `Private rejected opinion ${generations}: I make an unsupported claim.`
      drafts.push(opinion)
      return { opinion, viewpoint }
    }
  }, reviewHook: async input => {
    if (input.kind === 'opinion' && !accept) return { facts_preserved: false, point_of_view_consistent: true, substantive_rewrite: true, issues: [issues[reviews++]] }
  } })
  const job = await f.service.start({ url: wiki('OpinionManualCorrection') })
  for (let index = 0; index < 3; index++) { await f.service.dispatch(); f.advance(10000) }
  const failed = f.store.snapshot()[0]
  assert.equal(failed.status, 'failed'); assert.equal(failed.opinion, ''); assert.equal(failed.opinionReviewed, false)
  assert.equal(failed.opinionRevisionContext.previousDraft, drafts[2])
  assert.deepEqual(failed.opinionFailure.feedback, [issues[2], issues[1], issues[0]])
  assert.deepEqual(failed.opinionRevisionContext.feedback, failed.opinionFailure.feedback)
  assert.ok(failed.opinionRevisionContext.previousDraft.length <= 600)
  assert.doesNotMatch(JSON.stringify(await f.service.status(job)), /Private rejected|opinionRevisionContext|expert predictions/)
  accept = true
  await f.service.retry({ jobId: job.jobId }); await f.service.dispatch()
  const opinions = f.calls.filter(input => input.summary)
  assert.equal(opinions.length, 4); assert.equal(opinions[3].previous_draft, drafts[2])
  assert.deepEqual(opinions[3].prior_review_issues, failed.opinionRevisionContext.feedback)
  const ready = f.store.snapshot()[0]
  assert.equal(ready.status, 'complete'); assert.deepEqual(ready.opinionRevisionContext, {}); assert.equal(ready.opinionFailure, null)
  assert.equal(ready.metrics.calls, 10)
})
