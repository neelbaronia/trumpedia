import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createArticleService, createMemoryStore, ArticleServiceError, ARTICLE_LIMITS, createSupabaseStore } from '../supabase/functions/_shared/article-jobs.mjs'
import { createProvider } from '../supabase/functions/_shared/provider.mjs'
const parseDocument = html => new JSDOM(html).window.document
const sentence = 'This is an important encyclopedia paragraph containing detailed information about the topic and its historical context.'
const source = count => Array.from({ length: count }, (_, i) => `${i % 12 === 0 && i ? `<h2>Section ${i}</h2>` : ''}<p>${i}: ${sentence} <a href="/wiki/History">historical source</a>.</p>`).join('')
const completion = result => new Response(JSON.stringify({ model: 'actual-test-model', usage: { prompt_tokens: 25, completion_tokens: 15 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { headers: { 'Content-Type': 'application/json' } })
function fixture({ html = source(30), legacyArticles = [], providerHook, sourceHook, clock, store: suppliedStore, resolveIdentity = false, limits = {} } = {}) {
  let now = Date.parse('2026-11-25T12:00:00Z')
  const getNow = clock || (() => now)
  const calls = []; const sourceCalls = []
  const provider = createProvider({ apiKey: 'mock-key', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); const input = JSON.parse(payload.messages[1].content); calls.push(input)
    const result = await providerHook?.(input, { now: getNow(), advance: duration => { now += duration }, atLeast: at => { now = Math.max(now, at) } })
    if (result instanceof Response) return result
    return completion(result || (input.blocks ? { blocks: input.blocks.map(block => ({ ...block, text: block.text.replace('important', 'tremendous') })), ...(input.summary ? { opinion: 'A tremendous topic. Believe me.' } : {}) } : { opinion: 'A tremendous topic. Believe me.' }))
  } })
  const store = suppliedStore || createMemoryStore({ legacyArticles, clock: getNow, ...limits })
  const service = createArticleService({ store, provider, parseDocument, clock: getNow, resolveIdentity, fetchImpl: async url => { sourceCalls.push(String(url)); if (sourceHook) return sourceHook(url); return new Response(JSON.stringify(String(url).includes('action=query') ? { query: { pages: [{ pageid: 1, title: 'Canonical', ns: 0, lastrevid: 12 }] } } : { parse: { title: 'Test', pageid: 1, revid: 12, text: html, displaytitle: '<i>Test</i>' } })) } })
  return { service, store, calls, sourceCalls, advance: duration => { now += duration }, now: getNow }
}
const wiki = title => `https://en.wikipedia.org/wiki/${title}`

test('same canonical article is admitted once; real strict provider accepts engine block shape; combined lead+stance is first', async () => {
  const { service, calls, store, sourceCalls } = fixture()
  const starts = await Promise.all([service.start({ url: wiki('Test') }), service.start({ url: 'https://en.m.wikipedia.org/wiki/Test#History' })])
  assert.equal(starts[0].jobId, starts[1].jobId); assert.equal(store.snapshot().length, 1)
  await service.dispatch()
  const final = await service.status(starts[0]); assert.equal(final.status, 'complete')
  assert.equal(calls.length, 3); assert.ok(calls[0].summary); assert.equal(calls[0].opinion, undefined); assert.ok(calls[1].opinion)
  assert.deepEqual(Object.keys(calls[0].blocks[0]).sort(), ['id', 'text'])
  assert.equal(final.article.html, undefined); assert.ok(final.article.sections.every(section => section.complete))
  assert.equal(final.article.metrics.actualModels['actual-test-model'], 3)
  for (const field of ['sourceFetchMs', 'planMs', 'queueWaitMs', 'firstBatchMs', 'firstSectionMs', 'elapsedMs']) assert.equal(typeof final.article.metrics[field], 'number', field)
  const hit = await service.start({ url: wiki('Test') }); await service.dispatch()
  assert.equal(hit.status, 'complete'); assert.equal(calls.length, 3); assert.equal(sourceCalls.length, 1)
})

test('legacy complete HTML is sanitized, served free, and a missing opinion generates only that opinion', async () => {
  const row = { url: wiki('Legacy'), title: 'Legacy', html: `<p onclick="unsafe()">${sentence}</p><script>alert(1)</script>`, rewrite_mode: 'llm', source_api_url: wiki('Legacy'), opinion: 'Already tremendous.' }
  const existing = fixture({ legacyArticles: [row] }); const cached = await existing.service.start({ url: row.url }); await existing.service.dispatch()
  assert.equal(cached.status, 'complete'); assert.equal(existing.calls.length, 0); assert.equal(existing.sourceCalls.length, 0)
  assert.doesNotMatch(cached.article.sections.map(s => s.html).join(''), /script|onclick/)
  assert.equal(cached.article.model, 'legacy-unrecorded'); assert.equal(cached.article.importedFromLegacy, true)
  const missing = fixture({ legacyArticles: [{ ...row, opinion: null }] }); const job = await missing.service.start({ url: row.url }); await missing.service.dispatch()
  assert.equal((await missing.service.status(job)).status, 'complete'); assert.equal(missing.calls.length, 1); assert.equal(missing.calls[0].blocks, undefined); assert.equal(missing.sourceCalls.length, 0); assert.ok((await missing.service.recent()).articles.some(article => article.url === row.url))
})

test('legacy partial and heuristic cache never become falsely complete generation', async () => {
  for (const mode of ['llm-partial', 'heuristic']) {
    const f = fixture({ html: source(1), legacyArticles: [{ url: wiki('Partial'), title: 'Partial', html: `<p>${sentence}</p>`, rewrite_mode: mode, opinion: 'Old stance.' }] })
    const job = await f.service.start({ url: wiki('Partial') }); assert.equal(job.status, 'queued'); await f.service.dispatch(); assert.equal(f.calls.length, 1); assert.equal(f.sourceCalls.length, 1)
    assert.equal((await f.service.status(job)).article.importedFromLegacy, false)
  }
})

test('progressive checkpoints expose lead while later sections remain pending', async () => {
  let release; const gate = new Promise(resolve => { release = resolve }); let signalPending
  const pending = new Promise(resolve => { signalPending = resolve })
  const f = fixture({ html: source(30), providerHook: async input => { if (!input.summary) { signalPending(); await gate } } })
  const job = await f.service.start({ url: wiki('Progressive') }); const work = f.service.dispatch(); await pending
  const mid = await f.service.status(job)
  assert.equal(mid.status, 'running'); assert.equal(mid.completed, 12); assert.ok(mid.article.sections[0].complete); assert.ok(mid.article.sections.some(s => !s.complete))
  release(); await work; assert.equal((await f.service.status(job)).status, 'complete')
})

test('successful long article resumes immediately across bounded invocations instead of sleeping until deadline', async () => {
  const f = fixture({ html: source(145), providerHook: async (_input, ctx) => { await new Promise(resolve => setTimeout(resolve, 2)); ctx.atLeast(ctx.now + 25000) } })
  const job = await f.service.start({ url: wiki('Long') }); await f.service.dispatch()
  const first = f.store.snapshot()[0]; assert.equal(first.status, 'queued'); assert.ok(first.completed === undefined); assert.ok(Object.keys(first.outputs).length < first.plan.blocks.length)
  assert.ok(Date.parse(first.nextRunAt) <= f.now()); const calls = f.calls.length
  await f.service.dispatch(); assert.ok(f.calls.length > calls)
  for (let i = 0; i < 5 && (await f.service.status(job)).status !== 'complete'; i++) await f.service.dispatch()
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
  assert.equal((await f.service.start({ url: wiki('Old') })).status, 'complete')
  const recent = await f.service.recent(); assert.deepEqual(new Set(recent.articles.map(a => a.url)), new Set([wiki('One'), wiki('Old')]))
  const completeRetry = await f.service.retry({ jobId: job.jobId }); assert.equal(completeRetry.status, 'complete')
})

test('unchanged status reads metadata only from durable store', async () => {
  const reads = []
  const row = { id: crypto.randomUUID(),url:wiki('One'),version:'test',lang:'en',title:'One',status:'running',updated_at:'2026-11-25T00:00:00.000Z' }
  const store = createSupabaseStore({ url:'https://example.supabase.co',serviceKey:'mock-service',fetchImpl:async url => { reads.push(String(url)); return Response.json([row]) } })
  const f = fixture({ store }); const result = await f.service.status({jobId:row.id,updatedAt:row.updated_at})
  assert.equal(result.unchanged,true); assert.equal(reads.length,1); assert.doesNotMatch(reads[0],/select=\*/); assert.equal(result.article,undefined)
})

test('two article workers run at most four batches each and record failed paid attempts accurately', async () => {
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


test('legacy raw punctuation keys are reused under canonical encoded URLs without paid generation', async () => {
  const f=fixture({legacyArticles:[{url:wiki('Star_Trek:_Voyager'),title:'Star Trek: Voyager',html:source(1),rewrite_mode:'llm',opinion:'A tremendous series.'}]})
  const job=await f.service.start({url:wiki('Star_Trek%3A_Voyager')});await f.service.dispatch()
  assert.equal(job.status,'complete');assert.equal(job.article.canonicalUrl,wiki('Star_Trek%3A_Voyager'));assert.equal(f.calls.length,0);assert.equal(f.sourceCalls.length,0)
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
  const complete=await f.service.status(job);assert.equal(complete.status,'complete');assert.equal(complete.completed,1);assert.equal(f.calls.length,2);assert.equal(f.sourceCalls.length,1,'Saved source plan is reused')
})

test('manual recovery from provider rejection remains bounded to three retries per job per day', async () => {
  const f=fixture({html:source(1),providerHook:async()=>new Response('{}',{status:403})})
  const job=await f.service.start({url:wiki('BoundedRecovery')});await f.service.dispatch()
  for(let i=0;i<3;i++){await f.service.retry({jobId:job.jobId});await f.service.dispatch()}
  assert.equal(f.calls.length,4)
  await assert.rejects(f.service.retry({jobId:job.jobId}),error=>error.status===429&&error.code==='retry_limit')
  await f.service.dispatch();assert.equal(f.calls.length,4)
})
